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
import * as shishaMessages from "@/lib/services/messages/shisha"
import { confirmOrderPaymentByAttempt } from "@/lib/services/orders/orders.flow-checkout"
import { bookingPaidConfirmedMessage, bookingPaymentRefundedMessage } from "@/lib/services/messages/booking"
import { formatMoneyFor } from "@/lib/services/orders/orders.tenant"

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

  if (payment.purpose === "shisha_request") {
    return await settleShishaRequest(db, provider, connection, payment, event.providerPaymentId)
  }

  if (payment.purpose === "order_payment") {
    return await settleOrderPayment(db, provider, connection, payment, event.providerPaymentId)
  }

  if (payment.purpose === "booking_payment") {
    return await settleBookingPayment(db, provider, connection, payment, event.providerPaymentId)
  }

  return "ignored_unknown_purpose"
}

/**
 * A verified payment for a shisha session request (amount and checkout already matched by the caller).
 * awaiting_payment -> paid, once (conditional UPDATE). The session is NOT started here: staff pick the hookah.
 * If the request is no longer waiting for this payment (closed meanwhile), the money is refunded, never kept.
 * Throws on OUR failures so the provider retries; every step is safe to repeat.
 */
async function settleShishaRequest(
  db: Db,
  provider: CardProvider,
  connection: StoredConnection,
  payment: { id: unknown; tenant_id: unknown; purpose_id: unknown; amount: unknown; provider_checkout_id: unknown; metadata: unknown },
  providerPaymentId: string | null,
): Promise<string> {
  const tenantId = connection.tenantId
  const paymentId = payment.id as string
  const requestId = payment.purpose_id as string

  const { data: req, error: readError } = await db
    .from("shisha_requests")
    .select("id, status, customer_phone, flavour_name, request_data")
    .eq("id", requestId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (readError) throw new Error(`shisha request lookup failed: ${readError.message}`)

  if (!req) {
    return await refundAfterFailedFulfilment(db, provider, connection, payment, "request not found", "shisha")
  }

  if (req.status === "paid") {
    // Marked paid by THIS payment (a retry after a crash between the two writes): just finish the bookkeeping.
    const paidBy = ((req.request_data as Record<string, unknown> | null) ?? {}).payment_id
    if (paidBy === paymentId) {
      await markSucceeded(db, paymentId, providerPaymentId)
      return "shisha_already_paid"
    }
    // Staff recorded it as paid in person (cash/EFT/counter card) and the customer ALSO paid the link: refund this one.
    return await refundAfterFailedFulfilment(db, provider, connection, payment, "request already paid another way", "shisha")
  }

  if (req.status !== "awaiting_payment") {
    return await refundAfterFailedFulfilment(db, provider, connection, payment, `request was ${req.status}`, "shisha")
  }

  const requestData = (req.request_data as Record<string, unknown> | null) ?? {}
  const { data: updated, error: updateError } = await db
    .from("shisha_requests")
    .update({
      status: "paid",
      request_data: { ...requestData, payment_id: paymentId, paid_at: new Date().toISOString() },
    })
    .eq("id", requestId)
    .eq("tenant_id", tenantId)
    .eq("status", "awaiting_payment")
    .select("id")
  if (updateError) throw new Error(`shisha request update failed: ${updateError.message}`)
  // Changed under us: let the provider retry, the next pass sees the new status.
  if (!updated || updated.length === 0) throw new Error("shisha request changed while marking paid")

  await markSucceeded(db, paymentId, providerPaymentId)

  // Best effort: the request is already marked paid whether or not this message goes.
  try {
    if (req.customer_phone) {
      await sendWhatsAppTextMessage(
        tenantId,
        req.customer_phone as string,
        shishaMessages.paymentReceivedSession({ flavour: (req.flavour_name as string | null) ?? null, price: Number(payment.amount) }),
      )
    }
  } catch (error) {
    console.error(`[${provider.id}-webhook] shisha payment message failed (request is already paid)`, {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return "shisha_paid"
}

/**
 * A verified payment for WhatsApp food/drink orders (amount and checkout already matched by the caller).
 * purpose_id is the orders' payment attempt id. confirm_card_payment moves the still-pending orders to
 * placed/scheduled (and applies stock) exactly once. If the orders can no longer be paid (cancelled meanwhile,
 * the link expired and the pending orders were cancelled), the money is refunded, never kept.
 * Throws on OUR failures so the provider retries; every step is safe to repeat.
 */
async function settleOrderPayment(
  db: Db,
  provider: CardProvider,
  connection: StoredConnection,
  payment: { id: unknown; provider_checkout_id: unknown; metadata: unknown; purpose_id?: unknown },
  providerPaymentId: string | null,
): Promise<string> {
  const paymentId = payment.id as string
  const attemptId = payment.purpose_id as string

  const outcome = await confirmOrderPaymentByAttempt(db, attemptId)
  if (outcome === "not_payable") {
    return await refundAfterFailedFulfilment(db, provider, connection, payment, "orders no longer payable", "order")
  }
  await markSucceeded(db, paymentId, providerPaymentId)
  return outcome === "confirmed" ? "order_paid" : "order_already_paid"
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
  payment: { id: unknown; provider_checkout_id: unknown; metadata: unknown; purpose_id?: unknown },
  reason: string,
  kind: "tickets" | "shisha" | "order" | "booking" = "tickets",
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
      kind === "shisha"
        ? `A shisha payment came in but the request could no longer be served, and it could not be refunded automatically. Please refund it in your ${provider.label} portal.`
        : kind === "order"
        ? `An order payment came in but the order had already been cancelled, and it could not be refunded automatically. Please refund it in your ${provider.label} portal.`
        : kind === "booking"
        ? `A booking payment came in after the held time had run out, and it could not be refunded automatically. Please refund it in your ${provider.label} portal.`
        : `A ticket payment came in but the tickets could not be issued, and it could not be refunded automatically. Please refund it in your ${provider.label} portal.`,
    )
  }

  if (kind === "shisha") {
    await notifyShishaRefund(db, provider, connection.tenantId, payment.purpose_id as string | undefined, refunded)
    return refunded ? "refunded_shisha_request_closed" : "refund_needed_shisha_request_closed"
  }
  if (kind === "booking") {
    await notifyBookingRefund(db, provider, connection.tenantId, payment.metadata as Record<string, unknown>, refunded)
    return refunded ? "refunded_booking_not_held" : "refund_needed_booking_not_held"
  }
  if (kind === "order") {
    await notifyOrderPaymentRefund(db, provider, connection.tenantId, payment.metadata as Record<string, unknown>, refunded)
    return refunded ? "refunded_order_cancelled" : "refund_needed_order_cancelled"
  }
  await notifyOrderFailed(db, provider, connection.tenantId, payment.metadata as Record<string, unknown>, refunded)
  return refunded ? "refunded_tickets_unavailable" : "refund_needed_tickets_unavailable"
}

/** Best effort: tells the customer why their shisha payment is being refunded. */
async function notifyShishaRefund(db: Db, provider: CardProvider, tenantId: string, requestId: string | undefined, refunded: boolean) {
  try {
    if (!requestId) return
    const { data } = await db.from("shisha_requests").select("customer_phone").eq("id", requestId).eq("tenant_id", tenantId).maybeSingle()
    const phone = data?.customer_phone as string | null | undefined
    if (!phone) return
    await sendWhatsAppTextMessage(tenantId, phone, shishaMessages.paymentRefundedSession(refunded))
  } catch (error) {
    console.error(`[${provider.id}-webhook] shisha refund message failed`, { tenantId, error: error instanceof Error ? error.message : String(error) })
  }
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

/** Best effort: tells the customer why their card payment for an order is being refunded. */
async function notifyOrderPaymentRefund(db: Db, provider: CardProvider, tenantId: string, metadata: Record<string, unknown> | null, refunded: boolean) {
  try {
    const phone = await phoneForCustomer(db, tenantId, (metadata?.customer_id as string | undefined) ?? undefined)
    if (!phone) return
    await sendWhatsAppTextMessage(
      tenantId,
      phone,
      refunded
        ? "Your payment arrived after your order was cancelled, so it has been refunded in full. It can take a few days to show on your statement."
        : "Your payment arrived after your order was cancelled. You will be refunded in full. The shop has been told and will sort it out with you.",
    )
  } catch (error) {
    console.error(`[${provider.id}-webhook] order refund message failed`, { tenantId, error: error instanceof Error ? error.message : String(error) })
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

/**
 * A verified payment for a held booking (amount and checkout already matched by the caller). purpose_id is the
 * booking id. awaiting_payment -> confirmed, once (conditional UPDATE). If the held time has already been
 * released (the hold ran out and the booking was cancelled), the money is refunded in full, never kept.
 * Throws on OUR failures so the provider retries; every step is safe to repeat.
 */
async function settleBookingPayment(
  db: Db,
  provider: CardProvider,
  connection: StoredConnection,
  payment: { id: unknown; provider_checkout_id: unknown; metadata: unknown; purpose_id?: unknown },
  providerPaymentId: string | null,
): Promise<string> {
  const tenantId = connection.tenantId
  const paymentId = payment.id as string
  const bookingId = payment.purpose_id as string

  const { data: booking, error: readError } = await db
    .from("bookings")
    .select("id, status")
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (readError) throw new Error(`booking lookup failed: ${readError.message}`)
  if (!booking) return await refundAfterFailedFulfilment(db, provider, connection, payment, "booking not found", "booking")

  if (booking.status === "awaiting_payment") {
    const { data: updated, error: updateError } = await db
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId)
      .eq("tenant_id", tenantId)
      .eq("status", "awaiting_payment")
      .select("id")
    if (updateError) throw new Error(`booking confirm failed: ${updateError.message}`)
    // Changed under us (probably the hold just expired): let the provider retry, the next pass sees the new status.
    if (!updated || updated.length === 0) throw new Error("booking changed while confirming payment")
  } else if (booking.status === "confirmed" || booking.status === "completed") {
    // A retry after a crash between the two writes: only this payment confirms a held booking.
    await markSucceeded(db, paymentId, providerPaymentId)
    return "booking_already_confirmed"
  } else {
    return await refundAfterFailedFulfilment(db, provider, connection, payment, `booking was ${booking.status}`, "booking")
  }

  await markSucceeded(db, paymentId, providerPaymentId)
  await notifyBookingPaid(db, provider, tenantId, bookingId, payment.metadata as Record<string, unknown> | null)
  return "booking_paid"
}

/** Whether the customer may be messaged after paying at the kiosk (same rule as the kiosk's own confirmation text). */
async function mayMessageKioskCustomer(db: Db, tenantId: string): Promise<boolean> {
  try {
    const { data } = await db.from("tenant_branding").select("kiosk_show_whatsapp_optin").eq("tenant_id", tenantId).maybeSingle()
    return data?.kiosk_show_whatsapp_optin !== false
  } catch {
    return true
  }
}

/** Best effort: the booking is already confirmed whether or not these messages go. */
async function notifyBookingPaid(db: Db, provider: CardProvider, tenantId: string, bookingId: string, metadata: Record<string, unknown> | null) {
  try {
    if (metadata?.channel === "kiosk" && !(await mayMessageKioskCustomer(db, tenantId))) return

    const { data: b, error: bookingError } = await db
      .from("bookings")
      .select(
        `id, customer_id, start_time, end_time, booking_reference, ticket_number,
         services!bookings_service_id_fkey ( name, price ),
         booking_services ( position, services ( name, price ) )`,
      )
      .eq("id", bookingId)
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (bookingError) {
      console.error(`[${provider.id}-webhook] booking confirmation: booking lookup failed`, { tenantId, bookingId, error: bookingError.message })
      return
    }
    if (!b) return

    // tenant_customers stores the name in full_name (there is no "name" column).
    const { data: cust, error: custError } = await db
      .from("tenant_customers")
      .select("full_name, phone")
      .eq("id", b.customer_id as string)
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (custError) {
      console.error(`[${provider.id}-webhook] booking confirmation: customer lookup failed`, { tenantId, bookingId, error: custError.message })
      return
    }
    const phone = (cust?.phone as string | null) ?? null
    if (!phone) {
      console.warn(`[${provider.id}-webhook] booking confirmation: no phone for customer, nothing sent`, { tenantId, bookingId })
      return
    }
    const customerName = (cust?.full_name as string | null) ?? null

    // Services in the order the customer picked them (falls back to the primary service).
    type Svc = { name: string; price: number }
    const linked = ((b.booking_services as unknown as Array<{ position: number; services: Svc | Svc[] | null }> | null) ?? [])
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((r) => (Array.isArray(r.services) ? r.services[0] : r.services))
      .filter((s): s is Svc => !!s)
    const primary = Array.isArray(b.services) ? (b.services[0] as Svc | undefined) : (b.services as unknown as Svc | null)
    const services = linked.length > 0 ? linked : primary ? [primary] : []
    const serviceNames = services.map((s) => s.name)
    const totalPrice = services.reduce((sum, s) => sum + Number(s.price), 0)

    const { getTenantTimezone } = await import("@/lib/services/shared/tenant-scheduling")
    const timeZone = await getTenantTimezone(db, tenantId)
    const start = new Date(b.start_time as string)
    const slotLabel =
      new Intl.DateTimeFormat("en-ZA", { weekday: "short", day: "numeric", month: "short", timeZone }).format(start) +
      " at " +
      new Intl.DateTimeFormat("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(start)

    const { formatBookingTicketNumber } = await import("@/lib/services/ticket-format")
    const { data: prefixRow } = await db.from("booking_settings").select("booking_number_prefix").eq("tenant_id", tenantId).maybeSingle()
    const ticketLabel =
      b.ticket_number == null ? null : formatBookingTicketNumber(b.ticket_number as number, (prefixRow?.booking_number_prefix as string | undefined)?.trim() || "B")

    const { data: pay } = await db.from("tenant_payments").select("amount, currency").eq("purpose", "booking_payment").eq("purpose_id", bookingId).maybeSingle()
    const amountLabel = formatMoneyFor((pay?.currency as string | undefined) ?? "ZAR", Number(pay?.amount ?? totalPrice))

    await sendWhatsAppTextMessage(
      tenantId,
      phone,
      bookingPaidConfirmedMessage({
        customerName: customerName,
        serviceName: serviceNames.join(" + ") || "Appointment",
        slotLabel,
        bookingReference: b.booking_reference as string,
        ticketLabel,
        amountLabel,
      }),
    )

    // The branded ticket image, like a normal WhatsApp booking. Never throws; null just means no image.
    const { tryGenerateBookingTicketUrl } = await import("@/lib/whatsapp/booking-ticket-image")
    const ticketUrl = await tryGenerateBookingTicketUrl(tenantId, {
      bookingId,
      bookingReference: b.booking_reference as string,
      customerName: customerName,
      customerPhone: phone,
      serviceNames,
      totalPrice,
      startTime: b.start_time as string,
      endTime: b.end_time as string,
    })
    if (ticketUrl) await sendWhatsAppImageMessage(tenantId, phone, ticketUrl)
  } catch (error) {
    console.error(`[${provider.id}-webhook] booking confirmation message failed (booking is already confirmed)`, {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Best effort: tells the customer why their booking payment is being refunded. */
async function notifyBookingRefund(db: Db, provider: CardProvider, tenantId: string, metadata: Record<string, unknown> | null, refunded: boolean) {
  try {
    if (metadata?.channel === "kiosk" && !(await mayMessageKioskCustomer(db, tenantId))) return
    const phone = await phoneForCustomer(db, tenantId, (metadata?.customer_id as string | undefined) ?? undefined)
    if (!phone) return
    await sendWhatsAppTextMessage(tenantId, phone, bookingPaymentRefundedMessage(refunded))
  } catch (error) {
    console.error(`[${provider.id}-webhook] booking refund message failed`, { tenantId, error: error instanceof Error ? error.message : String(error) })
  }
}
