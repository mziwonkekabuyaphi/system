// lib/payments/event-checkout.ts
/**
 * Paying for event tickets on WhatsApp: quote, pay from the Passport, or pay by card on the SHOP'S OWN Yoco account.
 *
 * Passport: one database call (event_purchase_ticket_whatsapp). The debit and the tickets are one transaction there.
 * Card:     we only START a checkout here. Tickets are issued by the signed webhook after the payment is verified
 *           (event_fulfil_card_order_whatsapp), never from this file, never from the redirect page.
 *
 * Everything the customer is shown (price, availability) comes from event_quote_whatsapp, the database's own answer.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { isModuleEnabled } from "@/lib/tenant/modules"
import { readPassportSummary } from "@/lib/services/passport"
import { getAppBaseUrl, getTenantYocoCredentials } from "./credentials"
import { YOCO_MIN_AMOUNT, YocoError, yocoCreateCheckout } from "./yoco"

/** Database messages that are written for customers; anything else becomes a generic apology. */
const FRIENDLY_DB_MESSAGE = /Only \d+ left|not on sale|has ended|between 1 and|Passport|balance|Invalid ticket|Customer not found|not enabled/i
const GENERIC = "I couldn't complete that. Please try again in a moment."

function friendly(message: string | undefined): string {
  return message && FRIENDLY_DB_MESSAGE.test(message) ? message : GENERIC
}

// ----------------------------------------------------------------------------
// Quote
// ----------------------------------------------------------------------------

export interface EventQuote {
  eventId: string
  eventName: string
  eventStart: string
  ticketTypeId: string
  ticketTypeName: string
  unitPrice: number
  total: number
  available: number
  quantity: number
}

export type QuoteResult = { ok: true; quote: EventQuote } | { ok: false; message: string }

export async function quoteEventPurchase(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  ticketTypeId: string,
  quantity: number,
): Promise<QuoteResult> {
  const { data, error } = await supabase
    .rpc("event_quote_whatsapp", {
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_ticket_type_id: ticketTypeId,
      p_quantity: quantity,
    })
    .maybeSingle()
  if (error || !data) return { ok: false, message: friendly(error?.message) }
  const r = data as Record<string, unknown>
  return {
    ok: true,
    quote: {
      eventId: r.event_id as string,
      eventName: r.event_name as string,
      eventStart: r.event_start as string,
      ticketTypeId: r.ticket_type_id as string,
      ticketTypeName: r.ticket_type_name as string,
      unitPrice: Number(r.unit_price) || 0,
      total: Number(r.total) || 0,
      available: Number(r.available) || 0,
      quantity: Number(r.quantity) || quantity,
    },
  }
}

// ----------------------------------------------------------------------------
// Which ways can this customer pay for this total?
// ----------------------------------------------------------------------------

export interface PaymentOptions {
  passport: { ok: boolean; balance: number; currency: string; reason: "ok" | "module_off" | "no_wallet" | "unusable" | "low_balance" }
  card: boolean
  cardMode: "test" | "live" | null
}

export async function getEventPaymentOptions(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  total: number,
): Promise<PaymentOptions> {
  const [walletOn, creds] = await Promise.all([isModuleEnabled(tenantId, "wallet"), getTenantYocoCredentials(supabase, tenantId)])

  let passport: PaymentOptions["passport"] = { ok: false, balance: 0, currency: "ZAR", reason: "module_off" }
  if (walletOn) {
    const summary = await readPassportSummary(supabase, tenantId, customerId)
    if (summary.status === "none") passport = { ok: false, balance: 0, currency: summary.currency, reason: "no_wallet" }
    else if (summary.status !== "active") passport = { ok: false, balance: summary.balance, currency: summary.currency, reason: "unusable" }
    else if (summary.balance < total) passport = { ok: false, balance: summary.balance, currency: summary.currency, reason: "low_balance" }
    else passport = { ok: true, balance: summary.balance, currency: summary.currency, reason: "ok" }
  }

  return { passport, card: Boolean(creds) && total >= YOCO_MIN_AMOUNT, cardMode: creds?.mode ?? null }
}

// ----------------------------------------------------------------------------
// Pay from the Passport
// ----------------------------------------------------------------------------

export type PurchaseResult = { ok: true; orderId: string } | { ok: false; message: string }

export async function buyWithPassport(args: {
  supabase: SupabaseClient
  tenantId: string
  customerId: string
  ticketTypeId: string
  quantity: number
  /** Generated once per confirmation screen: a double tap returns the same order instead of charging twice. */
  idempotencyKey: string
}): Promise<PurchaseResult> {
  const { data, error } = await args.supabase.rpc("event_purchase_ticket_whatsapp", {
    p_tenant_id: args.tenantId,
    p_customer_id: args.customerId,
    p_ticket_type_id: args.ticketTypeId,
    p_quantity: args.quantity,
    p_idempotency_key: args.idempotencyKey,
  })
  if (error || !data) {
    console.error("[event-checkout] passport purchase failed", { tenantId: args.tenantId, error: error?.message })
    return { ok: false, message: friendly(error?.message) }
  }
  return { ok: true, orderId: (data as { id: string }).id }
}

// ----------------------------------------------------------------------------
// Pay by card: start a Yoco checkout (tickets are issued later, by the webhook)
// ----------------------------------------------------------------------------

export type StartCardResult =
  | { ok: true; url: string; mode: "test" | "live" }
  | { ok: false; message: string }

export async function startEventCardCheckout(args: {
  supabase: SupabaseClient
  tenantId: string
  customerId: string
  quote: EventQuote
}): Promise<StartCardResult> {
  const { supabase, tenantId, customerId, quote } = args

  const creds = await getTenantYocoCredentials(supabase, tenantId)
  if (!creds) return { ok: false, message: "Card payment isn't set up for this shop yet." }
  if (quote.total < YOCO_MIN_AMOUNT) return { ok: false, message: `Card payments start at R${YOCO_MIN_AMOUNT}.` }

  // The attempt is recorded BEFORE Yoco is asked, with everything needed to issue the tickets later.
  const paymentId = randomUUID()
  const { error: insertError } = await supabase.from("tenant_payments").insert({
    id: paymentId,
    tenant_id: tenantId,
    integration_id: creds.integrationId,
    provider: "yoco",
    purpose: "event_order",
    purpose_id: paymentId,
    amount: quote.total,
    currency: "ZAR",
    status: "creating",
    metadata: {
      customer_id: customerId,
      ticket_type_id: quote.ticketTypeId,
      event_id: quote.eventId,
      quantity: quote.quantity,
    },
  })
  if (insertError) {
    console.error("[event-checkout] could not record payment attempt", { tenantId, error: insertError.message })
    return { ok: false, message: GENERIC }
  }

  try {
    const base = getAppBaseUrl()
    const checkout = await yocoCreateCheckout({
      secretKey: creds.secretKey,
      amount: quote.total,
      successUrl: `${base}/pay/result?status=success`,
      cancelUrl: `${base}/pay/result?status=cancelled`,
      failureUrl: `${base}/pay/result?status=failed`,
      metadata: { paymentId },
      idempotencyKey: `event-${paymentId}`,
    })
    const { error: saveError } = await supabase
      .from("tenant_payments")
      .update({ status: "pending", provider_checkout_id: checkout.id, checkout_url: checkout.redirectUrl, updated_at: new Date().toISOString() })
      .eq("id", paymentId)
    if (saveError) throw new Error(`Failed to save checkout: ${saveError.message}`)
    return { ok: true, url: checkout.redirectUrl, mode: checkout.processingMode ?? creds.mode }
  } catch (error) {
    // The customer never gets a link, so nobody can pay for this attempt.
    await supabase.from("tenant_payments").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", paymentId)
    console.error("[event-checkout] card checkout failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
    return {
      ok: false,
      message:
        error instanceof YocoError && error.status === 401
          ? "Card payments aren't working for this shop right now. Please ask a team member."
          : GENERIC,
    }
  }
}
