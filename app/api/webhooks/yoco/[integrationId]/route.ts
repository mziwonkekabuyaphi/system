// app/api/webhooks/yoco/[integrationId]/route.ts
/**
 * Yoco webhook receiver — one URL per shop connection: /api/webhooks/yoco/<integrationId>.
 * This is the ONLY place a payment turns into money in a Passport.
 *
 * What has to be true before a wallet is credited (each step fails closed):
 *   1. The integration exists and is active, and we hold ITS webhook secret.
 *   2. The signature verifies against the RAW body with that shop's secret, within 3 minutes.
 *   3. This webhook-id has not been processed before (Yoco retries; a replay does nothing).
 *   4. The event is payment.succeeded and its checkout id matches a checkout WE created for THIS integration
 *      (Yoco sends events for every payment on the shop's account, including ones that are not ours).
 *   5. The amount paid equals the amount we asked for, to the cent, and the currency matches.
 *      (A payment the expiry job cancelled but that was paid late is still honoured: see wallet_revive_topup.)
 *   6. The credit goes through wallet_complete_topup, which is itself idempotent and service_role only.
 *      Ticket orders go through event_fulfil_card_order_whatsapp (idempotent, service_role only).
 *      If the tickets can no longer be issued (tier sold out meanwhile, price changed), the card payment is
 *      refunded in full through Yoco instead of being kept. If that refund can't be made automatically
 *      (e.g. a test-mode payment, or Yoco is unreachable) the payment is marked refund_needed and the owner
 *      sees a warning in Settings > Payments.
 *
 * payment.failed is deliberately NOT acted on: a customer can retry on the same checkout and then succeed.
 * Failing the top-up on the first failure would make that later success un-creditable. It is only logged.
 *
 * Responses: 2xx = "received, stop retrying". Non-2xx (400 bad signature, 500 our error) = Yoco retries.
 * Yoco expects an answer within 15 seconds, so nothing slow runs here.
 */

import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { verifyYocoWebhook, yocoRefundCheckout } from "@/lib/payments/yoco"
import { getTenantYocoCredentials } from "@/lib/payments/credentials"
import { sendWhatsAppImageMessage, sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"
import { formatPassportMoney } from "@/lib/services/passport"
import { getOrderTicketQrs } from "@/lib/whatsapp/qr-generator"
import { buildOrderConfirmation } from "@/lib/services/event-tickets"
import { scheduleOrderTicketImages } from "@/lib/whatsapp/ticket-image"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// The ticket images are drawn and sent AFTER Yoco has been answered; this is how long that may take.
export const maxDuration = 60

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Db = NonNullable<ReturnType<typeof getSupabaseServerClient>>

interface YocoEvent {
  id?: string
  type?: string
  payload?: {
    id?: string
    amount?: number
    currency?: string
    metadata?: { checkoutId?: string }
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ integrationId: string }> | { integrationId: string } },
) {
  const { integrationId } = await ctx.params
  if (!UUID_RE.test(integrationId)) return NextResponse.json({ error: "not_found" }, { status: 404 })

  const rawBody = await req.text()
  const db = getSupabaseServerClient()
  if (!db) return NextResponse.json({ error: "server_unavailable" }, { status: 500 })

  // 1. Whose webhook is this, and what is their secret?
  const { data: cred, error: credError } = await db.rpc("get_payment_integration_credentials", { p_integration_id: integrationId }).maybeSingle()
  if (credError) {
    console.error("[yoco-webhook] credential lookup failed", { integrationId, error: credError.message })
    return NextResponse.json({ error: "server_error" }, { status: 500 })
  }
  const integration = cred as { tenant_id?: string; webhook_secret?: string } | null
  if (!integration?.tenant_id || !integration.webhook_secret) return NextResponse.json({ error: "not_found" }, { status: 404 })

  // 2. Signature, over the raw body.
  const webhookId = req.headers.get("webhook-id")
  const ok = verifyYocoWebhook({
    rawBody,
    id: webhookId,
    timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"),
    secret: integration.webhook_secret,
  })
  if (!ok || !webhookId) return NextResponse.json({ error: "invalid_signature" }, { status: 400 })

  let event: YocoEvent
  try {
    event = JSON.parse(rawBody) as YocoEvent
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  // 3. Replay / retry protection.
  const { error: dupError } = await db
    .from("payment_webhook_events")
    .insert({ provider: "yoco", webhook_id: webhookId, integration_id: integrationId, event_type: event.type ?? null })
  if (dupError) {
    if ((dupError as { code?: string }).code === "23505") return NextResponse.json({ received: true, duplicate: true })
    console.error("[yoco-webhook] could not record event", { integrationId, error: dupError.message })
    return NextResponse.json({ error: "server_error" }, { status: 500 })
  }
  await db.from("tenant_payment_integrations").update({ last_event_at: new Date().toISOString() }).eq("id", integrationId)

  const tenantId = integration.tenant_id
  let outcome = "ignored"
  try {
    if (event.type === "payment.succeeded") {
      outcome = await handleSucceeded(db, tenantId, integrationId, event, webhookId)
    } else if (event.type === "payment.failed") {
      outcome = "failed_attempt_logged" // see header: never fail the top-up here
    }
  } catch (error) {
    // Let Yoco retry. The webhook-id row is removed so the retry isn't mistaken for a duplicate.
    await db.from("payment_webhook_events").delete().eq("provider", "yoco").eq("webhook_id", webhookId)
    await recordProblem(db, integrationId, "Could not apply a payment. It will be retried.")
    console.error("[yoco-webhook] handling failed", { integrationId, error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "server_error" }, { status: 500 })
  }

  await db.from("payment_webhook_events").update({ outcome }).eq("provider", "yoco").eq("webhook_id", webhookId)
  return NextResponse.json({ received: true })
}

async function recordProblem(db: Db, integrationId: string, message: string) {
  await db
    .from("tenant_payment_integrations")
    .update({ last_error: message, last_error_at: new Date().toISOString() })
    .eq("id", integrationId)
}

async function handleSucceeded(db: Db, tenantId: string, integrationId: string, event: YocoEvent, webhookId: string): Promise<string> {
  // 4. Only checkouts we created for THIS integration.
  const checkoutId = event.payload?.metadata?.checkoutId
  if (!checkoutId || typeof checkoutId !== "string") return "ignored_no_checkout_id"

  const { data: payment, error } = await db
    .from("tenant_payments")
    .select("id, tenant_id, purpose, purpose_id, amount, currency, status, provider_checkout_id, metadata")
    .eq("integration_id", integrationId)
    .eq("provider", "yoco")
    .eq("provider_checkout_id", checkoutId)
    .maybeSingle()
  if (error) throw new Error(`payment lookup failed: ${error.message}`)
  if (!payment) return "ignored_unknown_checkout"
  if (payment.tenant_id !== tenantId) return "ignored_tenant_mismatch"
  if (payment.status === "succeeded" || payment.status === "refunded" || payment.status === "refund_needed") return "already_done"

  // 5. Exactly what we asked for.
  const expectedCents = Math.round(Number(payment.amount) * 100)
  const paidCents = event.payload?.amount
  const currency = event.payload?.currency
  if (paidCents !== expectedCents || (currency !== undefined && currency !== payment.currency)) {
    // Fail closed: do not credit. Visible to the shop owner in Settings > Payments.
    await recordProblem(db, integrationId, "A payment didn't match the amount we asked for, so it was not credited. Contact support.")
    console.error("[yoco-webhook] amount mismatch, NOT credited", { integrationId, paymentId: payment.id, expectedCents, paidCents, currency })
    return "amount_mismatch_not_credited"
  }

  // 6. Credit.
  if (payment.purpose === "wallet_topup") {
    // A top-up the expiry job already closed, paid late: put it back to pending so it can be credited.
    // (No-op unless the top-up is 'expired'; wallet_complete_topup is idempotent after that.)
    if (payment.status === "cancelled") {
      const { error: reviveError } = await db.rpc("wallet_revive_topup", { p_topup_id: payment.purpose_id })
      if (reviveError) throw new Error(`wallet_revive_topup failed: ${reviveError.message}`)
    }
    const { error: creditError } = await db.rpc("wallet_complete_topup", {
      p_topup_id: payment.purpose_id,
      p_provider: "yoco",
      p_provider_reference: event.payload?.id ?? checkoutId,
      p_payload: { webhook_id: webhookId, checkout_id: checkoutId, amount_cents: paidCents },
    })
    if (creditError) throw new Error(`wallet_complete_topup failed: ${creditError.message}`)
    await markSucceeded(db, payment.id as string, event.payload?.id)
    await notifyTopup(db, tenantId, payment.purpose_id as string)
    return "credited"
  }

  if (payment.purpose === "event_order") {
    const { data: order, error: fulfilError } = await db.rpc("event_fulfil_card_order_whatsapp", {
      p_payment_id: payment.id,
      p_provider_reference: event.payload?.id ?? checkoutId,
    })
    if (fulfilError) {
      // A rule of the shop's tickets (sold out, price changed, event closed): refund. Anything else is on us: retry.
      if (BUSINESS_FAILURE.test(fulfilError.message ?? "")) {
        return await refundAfterFailedFulfilment(db, tenantId, integrationId, payment, fulfilError.message ?? "")
      }
      throw new Error(`event_fulfil_card_order_whatsapp failed: ${fulfilError.message}`)
    }
    await markSucceeded(db, payment.id as string, event.payload?.id)
    await notifyOrder(db, tenantId, (order as { id: string }).id)
    return "tickets_issued"
  }

  return "ignored_unknown_purpose"
}

/** Messages the ticket function raises for rules the customer can't beat (not outages). */
const BUSINESS_FAILURE = /Only \d+ left|price_changed|not on sale|has ended|Invalid ticket|Event not found|Customer not found/i

async function markSucceeded(db: Db, paymentId: string, providerPaymentId: string | undefined) {
  await db
    .from("tenant_payments")
    .update({
      status: "succeeded",
      provider_payment_id: providerPaymentId ?? null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)
}

/**
 * The customer has paid but the tickets can't be issued. Refund the card payment in full.
 * Never silently keep the money: if the automatic refund fails, the payment is flagged refund_needed and the
 * owner is told in Settings > Payments.
 */
async function refundAfterFailedFulfilment(
  db: Db,
  tenantId: string,
  integrationId: string,
  payment: { id: unknown; provider_checkout_id: unknown; metadata: unknown },
  reason: string,
): Promise<string> {
  const paymentId = payment.id as string
  const checkoutId = payment.provider_checkout_id as string
  let refunded = false

  try {
    const creds = await getTenantYocoCredentials(db, tenantId)
    if (creds && creds.mode === "live") {
      await yocoRefundCheckout({ secretKey: creds.secretKey, checkoutId, idempotencyKey: `refund-${paymentId}` })
      refunded = true
    }
  } catch (error) {
    console.error("[yoco-webhook] automatic refund failed", {
      tenantId,
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
    await recordProblem(db, integrationId, "A ticket payment came in but the tickets could not be issued, and it could not be refunded automatically. Please refund it in your Yoco portal.")
  }

  await notifyOrderFailed(db, tenantId, payment.metadata as Record<string, unknown>, refunded)
  return refunded ? "refunded_tickets_unavailable" : "refund_needed_tickets_unavailable"
}

/** Best effort: the money is already safely in the Passport whether or not this message goes. */
async function notifyTopup(db: Db, tenantId: string, topupId: string) {
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
    console.error("[yoco-webhook] confirmation message failed (money is already credited)", {
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
async function notifyOrder(db: Db, tenantId: string, orderId: string) {
  try {
    const { data: order } = await db.from("event_orders").select("customer_id, customer_phone").eq("id", orderId).maybeSingle()
    const phone = (order?.customer_phone as string | null) ?? (await phoneForCustomer(db, tenantId, order?.customer_id as string | undefined))
    if (!phone) return
    const text = await buildOrderConfirmation(db, tenantId, orderId, "✅ *Payment received. Your tickets are confirmed!*")
    await sendWhatsAppTextMessage(tenantId, phone, text)
    // One QR per ticket. Each send is separate so one failure can't stop the rest.
    for (const qr of await getOrderTicketQrs(db, tenantId, orderId)) {
      await sendWhatsAppImageMessage(tenantId, phone, qr.url, qr.caption).catch((error) =>
        console.error("[yoco-webhook] QR image failed", { tenantId, error: error instanceof Error ? error.message : String(error) }),
      )
    }
    // Branded ticket image: drawn and sent after this webhook has answered Yoco (the text above says it is coming).
    scheduleOrderTicketImages(tenantId, orderId, phone)
  } catch (error) {
    console.error("[yoco-webhook] ticket message failed (tickets are already issued)", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function notifyOrderFailed(db: Db, tenantId: string, metadata: Record<string, unknown> | null, refunded: boolean) {
  try {
    const phone = await phoneForCustomer(db, tenantId, (metadata?.customer_id as string | undefined) ?? undefined)
    if (!phone) return
    await sendWhatsAppTextMessage(
      tenantId,
      phone,
      refunded
        ? "Sorry, the tickets sold out while you were paying. Your card payment has been refunded in full. It can take a few days to show on your statement."
        : "Sorry, the tickets sold out while you were paying. You will be refunded in full. The shop has been told and will sort it out with you.",
    )
  } catch (error) {
    console.error("[yoco-webhook] refund message failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
  }
}
