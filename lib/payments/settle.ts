// lib/payments/settle.ts
/**
 * Turns a VERIFIED, NORMALISED payment notice into the shop's money or tickets. Provider-neutral: a provider
 * adapter only has to produce a NormalisedWebhook (providers/types.ts); everything here is the same for
 * Yoco, Ozow or any later provider. It is only ever called by webhook-handler.ts, after the signature,
 * the replay check and the integration lookup.
 *
 * What has to be true before anything is credited (each step fails closed):
 *   - the checkout reference matches a payment WE created for THIS integration
 *   - the amount paid equals the amount we asked for, to the cent, and the currency matches
 *   - the credit goes through wallet_complete_topup / event_fulfil_card_order_whatsapp, which are
 *     idempotent and service_role only
 * A payment that the expiry job already cancelled but that was paid late is still honoured (wallet_revive_topup).
 * If the tickets can no longer be issued (tier sold out meanwhile, price changed), the payment is refunded in
 * full through the provider when it can be (provider.canRefund), otherwise it is flagged `refund_needed` and the
 * owner sees a warning in Settings > Payments. Money is never silently kept.
 */

import type { getSupabaseServerClient } from "@/lib/supabase/admin"
import { sendWhatsAppImageMessage, sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"
import { formatPassportMoney } from "@/lib/services/passport"
import { getOrderTicketQrs } from "@/lib/whatsapp/qr-generator"
import { buildOrderConfirmation } from "@/lib/services/event-tickets"
import { scheduleOrderTicketImages } from "@/lib/whatsapp/ticket-image"

import type { StoredConnection } from "./credentials"
import type { CardProvider, NormalisedWebhook } from "./providers"

type Db = NonNullable<ReturnType<typeof getSupabaseServerClient>>

/** Messages the ticket function raises for rules the customer can't beat (not outages). */
const BUSINESS_FAILURE = /Only \d+ left|price_changed|not on sale|has ended|Invalid ticket|Event not found|Customer not found/i

export async function recordProblem(db: Db, integrationId: string, message: string): Promise<void> {
  await db
    .from("tenant_payment_integrations")
    .update({ last_error: message, last_error_at: new Date().toISOString() })
    .eq("id", integrationId)
}

/** Returns a short outcome string for the audit log. Throws on OUR failures so the provider retries. */
export async function settleSucceeded(args: {
  db: Db
  provider: CardProvider
  connection: StoredConnection
  event: NormalisedWebhook
  deliveryId: string
}): Promise<string> {
  const { db, provider, connection, event, deliveryId } = args
  const { tenantId, integrationId } = connection

  // Only checkouts we created for THIS integration.
  const checkoutRef = event.checkoutRef
  if (!checkoutRef) return "ignored_no_checkout_id"

  const { data: payment, error } = await db
    .from("tenant_payments")
    .select("id, tenant_id, purpose, purpose_id, amount, currency, status, provider_checkout_id, metadata")
    .eq("integration_id", integrationId)
    .eq("provider", provider.id)
    .eq("provider_checkout_id", checkoutRef)
    .maybeSingle()
  if (error) throw new Error(`payment lookup failed: ${error.message}`)
  if (!payment) return "ignored_unknown_checkout"
  if (payment.tenant_id !== tenantId) return "ignored_tenant_mismatch"
  if (payment.status === "succeeded" || payment.status === "refunded" || payment.status === "refund_needed") return "already_done"

  // Exactly what we asked for.
  const expectedMinor = Math.round(Number(payment.amount) * 100)
  if (event.amountMinor !== expectedMinor || (event.currency !== null && event.currency !== payment.currency)) {
    // Fail closed: do not credit. Visible to the shop owner in Settings > Payments.
    await recordProblem(db, integrationId, "A payment didn't match the amount we asked for, so it was not credited. Contact support.")
    console.error(`[${provider.id}-webhook] amount mismatch, NOT credited`, {
      integrationId,
      paymentId: payment.id,
      expectedMinor,
      paidMinor: event.amountMinor,
      currency: event.currency,
    })
    return "amount_mismatch_not_credited"
  }

  const providerRef = event.providerPaymentId ?? checkoutRef

  if (payment.purpose === "wallet_topup") {
    // A top-up the expiry job already closed, paid late: put it back to pending so it can be credited.
    // (No-op unless the top-up is 'expired'; wallet_complete_topup is idempotent after that.)
    if (payment.status === "cancelled") {
      const { error: reviveError } = await db.rpc("wallet_revive_topup", { p_topup_id: payment.purpose_id })
      if (reviveError) throw new Error(`wallet_revive_topup failed: ${reviveError.message}`)
    }
    const { error: creditError } = await db.rpc("wallet_complete_topup", {
      p_topup_id: payment.purpose_id,
      p_provider: provider.id,
      p_provider_reference: providerRef,
      p_payload: { webhook_id: deliveryId, checkout_id: checkoutRef, amount_cents: event.amountMinor },
    })
    if (creditError) throw new Error(`wallet_complete_topup failed: ${creditError.message}`)
    await markSucceeded(db, payment.id as string, event.providerPaymentId)
    await notifyTopup(db, provider, tenantId, payment.purpose_id as string)
    return "credited"
  }

  if (payment.purpose === "event_order") {
    const { data: order, error: fulfilError } = await db.rpc("event_fulfil_card_order_whatsapp", {
      p_payment_id: payment.id,
      p_provider_reference: providerRef,
    })
    if (fulfilError) {
      // A rule of the shop's tickets (sold out, price changed, event closed): refund. Anything else is on us: retry.
      if (BUSINESS_FAILURE.test(fulfilError.message ?? "")) {
        return await refundAfterFailedFulfilment(db, provider, connection, payment, fulfilError.message ?? "")
      }
      throw new Error(`event_fulfil_card_order_whatsapp failed: ${fulfilError.message}`)
    }
    await markSucceeded(db, payment.id as string, event.providerPaymentId)
    await notifyOrder(db, provider, tenantId, (order as { id: string }).id)
    return "tickets_issued"
  }

  return "ignored_unknown_purpose"
}

async function markSucceeded(db: Db, paymentId: string, providerPaymentId: string | null) {
  await db
    .from("tenant_payments")
    .update({
      status: "succeeded",
      provider_payment_id: providerPaymentId,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)
}

/**
 * The customer has paid but the tickets can't be issued. Refund in full through the provider when it can.
 * Never silently keep the money: if no automatic refund is possible, the payment is flagged refund_needed and
 * the owner is told in Settings > Payments.
 */
async function refundAfterFailedFulfilment(
  db: Db,
  provider: CardProvider,
  connection: StoredConnection,
  payment: { id: unknown; provider_checkout_id: unknown; metadata: unknown },
  reason: string,
): Promise<string> {
  const paymentId = payment.id as string
  const checkoutId = payment.provider_checkout_id as string
  let refunded = false

  try {
    if (provider.refund && provider.canRefund(connection)) {
      await provider.refund({ connection, checkoutId, idempotencyKey: `refund-${paymentId}` })
      refunded = true
    }
  } catch (error) {
    console.error(`[${provider.id}-webhook] automatic refund failed`, {
      tenantId: connection.tenantId,
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  await db
    .from("tenant_payments")
    .update({
      status: refunded ? "refunded" : "refund_needed",
      metadata: { ...((payment.metadata as Record<string, unknown>) ?? {}), failure: reason.slice(0, 200) },
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)

  if (!refunded) {
    await recordProblem(
      db,
      connection.integrationId,
      `A ticket payment came in but the tickets could not be issued, and it could not be refunded automatically. Please refund it in your ${provider.label} portal.`,
    )
  }

  await notifyOrderFailed(db, provider, connection.tenantId, payment.metadata as Record<string, unknown>, refunded)
  return refunded ? "refunded_tickets_unavailable" : "refund_needed_tickets_unavailable"
}

/** Best effort: the money is already safely in the Passport whether or not this message goes. */
async function notifyTopup(db: Db, provider: CardProvider, tenantId: string, topupId: string) {
  try {
    const { data: topup } = await db.from("wallet_topups").select("wallet_id, amount").eq("id", topupId).maybeSingle()
    if (!topup) return
    const { data: wallet } = await db.from("wallets").select("customer_id, balance, currency").eq("id", topup.wallet_id).maybeSingle()
    if (!wallet) return
    const { data: customer } = await db.from("tenant_customers").select("phone").eq("id", wallet.customer_id).eq("tenant_id", tenantId).maybeSingle()
    if (!customer?.phone) return
    const currency = (wallet.currency as string) || "ZAR"
    await sendWhatsAppTextMessage(
      tenantId,
      customer.phone as string,
      `✅ *Top-up received*\n\n${formatPassportMoney(Number(topup.amount), currency)} has been added to your Passport.\nNew balance: ${formatPassportMoney(Number(wallet.balance), currency)}`,
    )
  } catch (error) {
    console.error(`[${provider.id}-webhook] confirmation message failed (money is already credited)`, {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function phoneForCustomer(db: Db, tenantId: string, customerId: string | undefined): Promise<string | null> {
  if (!customerId) return null
  const { data } = await db.from("tenant_customers").select("phone").eq("id", customerId).eq("tenant_id", tenantId).maybeSingle()
  return (data?.phone as string | undefined) ?? null
}

/** Best effort: the tickets already exist whether or not this message goes. They are also under "My Tickets". */
async function notifyOrder(db: Db, provider: CardProvider, tenantId: string, orderId: string) {
  try {
    const { data: order } = await db.from("event_orders").select("customer_id, customer_phone").eq("id", orderId).maybeSingle()
    const phone = (order?.customer_phone as string | null) ?? (await phoneForCustomer(db, tenantId, order?.customer_id as string | undefined))
    if (!phone) return
    const text = await buildOrderConfirmation(db, tenantId, orderId, "✅ *Payment received. Your tickets are confirmed!*")
    await sendWhatsAppTextMessage(tenantId, phone, text)
    // One QR per ticket. Each send is separate so one failure can't stop the rest.
    for (const qr of await getOrderTicketQrs(db, tenantId, orderId)) {
      await sendWhatsAppImageMessage(tenantId, phone, qr.url, qr.caption).catch((error) =>
        console.error(`[${provider.id}-webhook] QR image failed`, { tenantId, error: error instanceof Error ? error.message : String(error) }),
      )
    }
    // Branded ticket image: drawn and sent after this webhook has answered the provider (the text above says it is coming).
    scheduleOrderTicketImages(tenantId, orderId, phone)
  } catch (error) {
    console.error(`[${provider.id}-webhook] ticket message failed (tickets are already issued)`, {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function notifyOrderFailed(db: Db, provider: CardProvider, tenantId: string, metadata: Record<string, unknown> | null, refunded: boolean) {
  try {
    const phone = await phoneForCustomer(db, tenantId, (metadata?.customer_id as string | undefined) ?? undefined)
    if (!phone) return
    await sendWhatsAppTextMessage(
      tenantId,
      phone,
      refunded
        ? "Sorry, the tickets sold out while you were paying. Your payment has been refunded in full. It can take a few days to show on your statement."
        : "Sorry, the tickets sold out while you were paying. You will be refunded in full. The shop has been told and will sort it out with you.",
    )
  } catch (error) {
    console.error(`[${provider.id}-webhook] refund message failed`, { tenantId, error: error instanceof Error ? error.message : String(error) })
  }
}
