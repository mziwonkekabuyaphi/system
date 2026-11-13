// lib/payments/event-checkout.ts
/**
 * Paying for event tickets on WhatsApp: quote, pay from the Passport, or pay by card on the SHOP'S OWN card provider
 * (Yoco, Ozow, ... whichever the shop connected; see providers/).
 *
 * Passport: one database call (event_purchase_ticket_whatsapp). The debit and the tickets are one transaction there.
 * Card:     we only START a checkout here. Tickets are issued by the signed webhook after the payment is verified
 *           (event_fulfil_card_order_whatsapp), never from this file, never from the redirect page.
 *
 * Everything the customer is shown (price, availability) comes from event_quote_whatsapp, the database's own answer.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { isModuleEnabled } from "@/lib/tenant/modules"
import { readPassportSummary } from "@/lib/services/passport"
import { cardFailureMessage, getCardOption, startCardPayment } from "./card"

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
  const [walletOn, option] = await Promise.all([isModuleEnabled(tenantId, "wallet"), getCardOption(supabase, tenantId)])

  let passport: PaymentOptions["passport"] = { ok: false, balance: 0, currency: "ZAR", reason: "module_off" }
  if (walletOn) {
    const summary = await readPassportSummary(supabase, tenantId, customerId)
    if (summary.status === "none") passport = { ok: false, balance: 0, currency: summary.currency, reason: "no_wallet" }
    else if (summary.status !== "active") passport = { ok: false, balance: summary.balance, currency: summary.currency, reason: "unusable" }
    else if (summary.balance < total) passport = { ok: false, balance: summary.balance, currency: summary.currency, reason: "low_balance" }
    else passport = { ok: true, balance: summary.balance, currency: summary.currency, reason: "ok" }
  }

  return { passport, card: Boolean(option) && total >= (option?.minAmount ?? Infinity), cardMode: option?.mode ?? null }
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
// Pay by card: start a checkout with the shop's own provider (tickets are issued later, by the webhook)
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

  const option = await getCardOption(supabase, tenantId)
  if (!option) return { ok: false, message: "Card payment isn't set up for this shop yet." }
  if (quote.total < option.minAmount) return { ok: false, message: `Card payments start at R${option.minAmount}.` }

  // The attempt is recorded BEFORE the provider is asked, with everything needed to issue the tickets later.
  const attempt = await startCardPayment({
    supabase,
    tenantId,
    option,
    purpose: "event_order",
    amount: quote.total,
    description: `${quote.eventName} tickets`,
    recordMetadata: {
      customer_id: customerId,
      ticket_type_id: quote.ticketTypeId,
      event_id: quote.eventId,
      quantity: quote.quantity,
    },
    idempotencyPrefix: "event",
  })
  if (!attempt.ok) {
    return { ok: false, message: attempt.stage === "record" ? GENERIC : cardFailureMessage(attempt.error, GENERIC) }
  }
  return { ok: true, url: attempt.url, mode: attempt.mode }
}
