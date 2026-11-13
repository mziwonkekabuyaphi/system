// lib/payments/shisha-checkout.ts
/**
 * Paying for a shisha session on WhatsApp, by card on the SHOP'S OWN card provider (Yoco, or whichever
 * the shop connected; see providers/).
 *
 * Staff approve an order_session request -> we start a checkout here and the customer gets the link.
 * We only START the checkout. Marking the request "paid" is done by the signed webhook (settle.ts) after
 * the payment is verified, never from this file and never from the redirect page.
 *
 * Why this does not use startCardPayment (card.ts): that helper always inserts a NEW payment row, but a
 * shisha request has exactly ONE (tenant_payments has UNIQUE (purpose, purpose_id) and purpose_id is the
 * request id). So this file follows the same order of steps (record first, then the provider, then save
 * the link) but reuses the request's row:
 *   - a live link already exists        -> the SAME link is returned, no second checkout (double tap, resend)
 *   - an earlier attempt crashed/failed/expired -> the same row is reset and a fresh checkout is made
 *   - the request was already paid      -> refused
 *
 * Also here: cancelling an unpaid link, and refunding a paid one (when staff reject a paid request).
 * Tenant safety: the service-role client bypasses RLS, so every query filters by tenant_id.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { cardFailureMessage, getCardOption } from "./card"
import { getAppBaseUrl, getIntegrationConnection, webhookUrlFor } from "./credentials"
import { getProvider } from "./providers"

const GENERIC = "I couldn't create the payment link. Please try again in a moment."
/** A row stuck in 'creating' for longer than this is treated as a crashed attempt and may be retried. */
const STALE_CREATING_MS = 2 * 60_000

export type ShishaCheckoutResult =
  | { ok: true; url: string; mode: "test" | "live"; paymentId: string; reused: boolean }
  | { ok: false; message: string }

interface PaymentRow {
  id: string
  status: string
  amount: number | string
  checkout_url: string | null
  integration_id: string
  updated_at: string
  metadata: Record<string, unknown> | null
}

/** Throws on a database error looking up the shop's connection (callers catch). */
export async function startShishaCardCheckout(args: {
  supabase: SupabaseClient
  tenantId: string
  requestId: string
  customerId: string | null
  /** The price at the moment of approval (what the customer will be charged). */
  amount: number
  flavourName: string | null
}): Promise<ShishaCheckoutResult> {
  const { supabase, tenantId, requestId, customerId, flavourName } = args
  const amount = Math.round(args.amount * 100) / 100

  const option = await getCardOption(supabase, tenantId)
  if (!option) return { ok: false, message: "Card payment isn't set up for this shop yet." }
  if (!(amount >= option.minAmount)) return { ok: false, message: `Card payments start at R${option.minAmount}.` }

  // ---- Is there already a payment row for this request? -------------------------------------------
  const { data: existingData, error: readError } = await supabase
    .from("tenant_payments")
    .select("id, status, amount, checkout_url, integration_id, updated_at, metadata")
    .eq("tenant_id", tenantId)
    .eq("purpose", "shisha_request")
    .eq("purpose_id", requestId)
    .maybeSingle()
  if (readError) {
    console.error("[shisha-checkout] could not read payment", { tenantId, error: readError.message })
    return { ok: false, message: GENERIC }
  }
  const existing = existingData as PaymentRow | null

  let paymentId: string
  let attempt = 1

  if (existing) {
    if (existing.status === "succeeded" || existing.status === "refund_needed" || existing.status === "refunded") {
      return { ok: false, message: "This request has already been paid." }
    }
    // A live link at the same price on the same provider account: hand back the same link.
    if (
      existing.status === "pending" &&
      existing.checkout_url &&
      existing.integration_id === option.connection.integrationId &&
      Math.abs(Number(existing.amount) - amount) < 0.005
    ) {
      return { ok: true, url: existing.checkout_url, mode: option.mode, paymentId: existing.id, reused: true }
    }
    if (existing.status === "creating" && Date.now() - Date.parse(existing.updated_at) < STALE_CREATING_MS) {
      return { ok: false, message: "The payment link is being prepared. Please try again in a moment." }
    }

    // Failed / cancelled / stale / price or provider changed: reset the SAME row and retry.
    attempt = (Number(existing.metadata?.attempt) || 1) + 1
    paymentId = existing.id
    const { data: reset, error: resetError } = await supabase
      .from("tenant_payments")
      .update({
        integration_id: option.connection.integrationId,
        provider: option.provider.id,
        amount,
        currency: option.currency,
        status: "creating",
        provider_checkout_id: null,
        checkout_url: null,
        completed_at: null,
        updated_at: new Date().toISOString(),
        metadata: { ...(existing.metadata ?? {}), attempt },
      })
      .eq("id", existing.id)
      .eq("tenant_id", tenantId)
      .eq("status", existing.status) // compare-and-set: a concurrent call can't also reset it
      .select("id")
    if (resetError || !reset || reset.length === 0) {
      if (resetError) console.error("[shisha-checkout] could not reset payment", { tenantId, error: resetError.message })
      return { ok: false, message: GENERIC }
    }
  } else {
    // Recorded BEFORE the provider is asked, with what the webhook will need later.
    paymentId = randomUUID()
    const { error: insertError } = await supabase.from("tenant_payments").insert({
      id: paymentId,
      tenant_id: tenantId,
      integration_id: option.connection.integrationId,
      provider: option.provider.id,
      purpose: "shisha_request",
      purpose_id: requestId,
      amount,
      currency: option.currency,
      status: "creating",
      metadata: { customer_id: customerId, request_id: requestId, flavour_name: flavourName, attempt },
    })
    if (insertError) {
      // Lost a race with a parallel call: it owns the row, so don't make a second link.
      console.error("[shisha-checkout] could not record payment attempt", { tenantId, error: insertError.message })
      return { ok: false, message: GENERIC }
    }
  }

  // ---- Ask the provider ----------------------------------------------------------------------------
  try {
    const base = getAppBaseUrl()
    const checkout = await option.provider.createCheckout({
      connection: option.connection,
      amount,
      currency: option.currency,
      paymentId,
      description: flavourName ? `Shisha: ${flavourName}` : "Shisha session",
      successUrl: `${base}/pay/result?status=success`,
      cancelUrl: `${base}/pay/result?status=cancelled`,
      failureUrl: `${base}/pay/result?status=failed`,
      notifyUrl: webhookUrlFor(option.provider.id, option.connection.integrationId),
      idempotencyKey: `shisha-${paymentId}-${attempt}`,
    })
    const { error: saveError } = await supabase
      .from("tenant_payments")
      .update({
        status: "pending",
        provider_checkout_id: checkout.checkoutId,
        checkout_url: checkout.redirectUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentId)
      .eq("tenant_id", tenantId)
    if (saveError) throw new Error(`Failed to save checkout: ${saveError.message}`)
    return { ok: true, url: checkout.redirectUrl, mode: checkout.mode ?? option.mode, paymentId, reused: false }
  } catch (error) {
    // The customer never gets a link, so nobody can pay for this attempt.
    await supabase
      .from("tenant_payments")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", paymentId)
      .eq("tenant_id", tenantId)
    console.error("[shisha-checkout] card checkout failed", {
      tenantId,
      provider: option.provider.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, message: cardFailureMessage(error, GENERIC) }
  }
}

/**
 * The request is being closed without payment (staff cancelled it, or it was paid in person): stop the link
 * from being used. A customer who pays it anyway is refunded by the webhook (settle.ts sees a closed request).
 * Only touches an UNPAID row. Best effort: returns false on a database error.
 */
export async function cancelShishaPayment(supabase: SupabaseClient, tenantId: string, requestId: string): Promise<boolean> {
  const { error } = await supabase
    .from("tenant_payments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("purpose", "shisha_request")
    .eq("purpose_id", requestId)
    .in("status", ["creating", "pending"])
  if (error) {
    console.error("[shisha-checkout] could not cancel payment", { tenantId, requestId, error: error.message })
    return false
  }
  return true
}

/** none = nothing was paid online for this request; refunded = money returned through the provider;
 *  test = a test-mode payment (no real money moved, so nothing to return); manual = could not be refunded
 *  automatically: flagged refund_needed and the owner sees it in Settings > Payments. */
export type ShishaRefundOutcome = "none" | "refunded" | "test" | "manual"

/** Full refund of a request's SUCCEEDED online payment. Never silently keeps money. Throws only on a database read error. */
export async function refundShishaPayment(args: {
  supabase: SupabaseClient
  tenantId: string
  requestId: string
}): Promise<ShishaRefundOutcome> {
  const { supabase, tenantId, requestId } = args

  const { data, error } = await supabase
    .from("tenant_payments")
    .select("id, integration_id, provider, status, provider_checkout_id, metadata")
    .eq("tenant_id", tenantId)
    .eq("purpose", "shisha_request")
    .eq("purpose_id", requestId)
    .maybeSingle()
  if (error) throw new Error(`payment lookup failed: ${error.message}`)
  const pay = data as {
    id: string
    integration_id: string
    provider: string
    status: string
    provider_checkout_id: string | null
    metadata: Record<string, unknown> | null
  } | null
  if (!pay || pay.status !== "succeeded") return "none"

  let connection = null
  try {
    connection = await getIntegrationConnection(supabase, pay.integration_id)
  } catch (err) {
    console.error("[shisha-checkout] refund: connection lookup failed", { tenantId, error: err instanceof Error ? err.message : String(err) })
  }
  const provider = getProvider(pay.provider)
  const testMode = connection?.mode === "test"

  let refunded = false
  try {
    if (connection && connection.tenantId === tenantId && provider?.refund && provider.canRefund(connection) && pay.provider_checkout_id) {
      await provider.refund({ connection, checkoutId: pay.provider_checkout_id, idempotencyKey: `refund-${pay.id}` })
      refunded = true
    }
  } catch (err) {
    console.error("[shisha-checkout] automatic refund failed", {
      tenantId,
      paymentId: pay.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const done = refunded || testMode
  await supabase
    .from("tenant_payments")
    .update({
      status: done ? "refunded" : "refund_needed",
      metadata: { ...(pay.metadata ?? {}), refund_reason: "shisha_request_rejected", ...(testMode ? { test_mode: true } : {}) },
      updated_at: new Date().toISOString(),
    })
    .eq("id", pay.id)
    .eq("tenant_id", tenantId)

  if (!done) {
    await supabase
      .from("tenant_payment_integrations")
      .update({
        last_error: `A shisha payment was rejected after payment and could not be refunded automatically. Please refund it in your ${provider?.label ?? "payment provider"} portal.`,
        last_error_at: new Date().toISOString(),
      })
      .eq("id", pay.integration_id)
      .eq("tenant_id", tenantId)
  }
  return refunded ? "refunded" : testMode ? "test" : "manual"
}
