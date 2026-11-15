// lib/payments/order-checkout.ts
/**
 * Paying for a WhatsApp food/drink order by card, on the SHOP'S OWN card provider (Yoco, Ozow, ... whichever the
 * shop connected; see providers/). Same pipeline as event tickets and shisha.
 *
 * The orders already exist, as 'pending' (place_order made them and applies stock only on payment). We only START
 * the checkout here: record the attempt, ask the provider, hand back the link. Marking the orders paid is done by
 * the signed webhook (settle.ts -> confirm_card_payment), never from this file and never from the redirect page.
 *
 * tenant_payments.purpose_id is the orders' payment_attempt_id: UNIQUE (purpose, purpose_id) means one attempt can
 * never get two payment rows, and the webhook finds the orders from it.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { cardFailureMessage, getCardOption, startCardPayment, type CardOption } from "./card"

const GENERIC = "I couldn't create the payment link. Please try again in a moment."

export type OrderCardOptionResult = { ok: true; option: CardOption } | { ok: false; message: string }

/** Checked BEFORE the orders are created, so a shop without a card provider never ends up with pending orders. */
export async function getOrderCardOption(supabase: SupabaseClient, tenantId: string): Promise<OrderCardOptionResult> {
  const option = await getCardOption(supabase, tenantId)
  if (!option) return { ok: false, message: "Card payment isn't set up for this shop yet." }
  return { ok: true, option }
}

export type OrderCheckoutResult = { ok: true; url: string; mode: "test" | "live" } | { ok: false; message: string }

export async function startOrderCardCheckout(args: {
  supabase: SupabaseClient
  tenantId: string
  option: CardOption
  /** orders.payment_attempt_id */
  paymentAttemptId: string
  customerId: string
  /** What place_order returned: the sum of the orders it created. This is exactly what the webhook will check. */
  amount: number
  orderIds: string[]
  orderNumbers: string[]
  brandName: string
}): Promise<OrderCheckoutResult> {
  const amount = Math.round(args.amount * 100) / 100

  const attempt = await startCardPayment({
    supabase: args.supabase,
    tenantId: args.tenantId,
    option: args.option,
    purpose: "order_payment",
    purposeId: args.paymentAttemptId,
    amount,
    description: `${args.brandName} order ${args.orderNumbers.join(", ")}`.slice(0, 120),
    recordMetadata: {
      customer_id: args.customerId,
      payment_attempt_id: args.paymentAttemptId,
      order_ids: args.orderIds,
    },
    idempotencyPrefix: "order",
  })
  if (!attempt.ok) {
    return { ok: false, message: attempt.stage === "record" ? GENERIC : cardFailureMessage(attempt.error, GENERIC) }
  }
  return { ok: true, url: attempt.url, mode: attempt.mode }
}
