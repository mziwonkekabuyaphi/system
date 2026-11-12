// lib/payments/passport-topup.ts
/**
 * Start a Passport top-up paid on the SHOP'S OWN Yoco account.
 *
 * Order matters, because it decides what can go wrong with someone's money:
 *   1. wallet_create_topup_whatsapp  -> a PENDING top-up row (all the shop's rules checked in the database)
 *   2. tenant_payments row ('creating') BEFORE asking Yoco, so there is always a record of the attempt
 *   3. create the Yoco checkout (idempotency key = the top-up id, so a retry can't create two)
 *   4. save the checkout id on the payment row, mark it 'pending'
 *   5. only now hand the link to the customer
 * If step 3 or 4 fails, the top-up is failed and the customer never receives a link, so nobody can pay
 * for something we can't match. The credit itself happens ONLY in the signed webhook.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { getAppBaseUrl, getTenantYocoCredentials } from "./credentials"
import { YOCO_MIN_AMOUNT, YocoError, yocoCreateCheckout } from "./yoco"

export interface TopupAvailability {
  available: boolean
  min: number
  max: number
  currency: string
  mode: "test" | "live" | null
}

/** Online top-up is available only when the shop allows it AND has an active Yoco connection. */
export async function getTopupAvailability(supabase: SupabaseClient, tenantId: string): Promise<TopupAvailability> {
  const none: TopupAvailability = { available: false, min: 0, max: 0, currency: "ZAR", mode: null }

  const [{ data: settings, error }, creds] = await Promise.all([
    supabase.from("wallet_settings").select("allow_customer_topup, min_topup, max_topup, currency").eq("tenant_id", tenantId).maybeSingle(),
    getTenantYocoCredentials(supabase, tenantId),
  ])
  if (error) throw new Error(`Failed to read wallet settings: ${error.message}`)
  // No settings row yet = the database defaults apply when the first wallet is made; treat as not open.
  if (!settings || !settings.allow_customer_topup || !creds) return none

  return {
    available: true,
    min: Math.max(Number(settings.min_topup) || 0, YOCO_MIN_AMOUNT),
    max: Number(settings.max_topup) || 0,
    currency: (settings.currency as string) || "ZAR",
    mode: creds.mode,
  }
}

export type StartTopupResult =
  | { ok: true; url: string; mode: "test" | "live" }
  | { ok: false; reason: "not_connected" | "rejected" | "unavailable"; message: string }

export async function startPassportTopup(args: {
  supabase: SupabaseClient
  tenantId: string
  customerId: string
  amount: number
}): Promise<StartTopupResult> {
  const { supabase, tenantId, customerId } = args
  const amount = Math.round(args.amount * 100) / 100

  const creds = await getTenantYocoCredentials(supabase, tenantId)
  if (!creds) return { ok: false, reason: "not_connected", message: "Card top-up isn't set up for this shop yet." }

  // 1. Pending top-up. The database re-checks module, customer, limits, wallet status and balance cap.
  const { data: topup, error: topupError } = await supabase.rpc("wallet_create_topup_whatsapp", {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
    p_amount: amount,
    p_provider: "yoco",
  })
  if (topupError || !topup) {
    // These messages are written for customers (limits, blocked wallet); anything else falls back to generic.
    const text = topupError?.message ?? ""
    const friendly = /between|limit|blocked|closed|not enabled|Wallet is/i.test(text)
    return { ok: false, reason: "rejected", message: friendly ? text : "I couldn't start that top-up. Please try again." }
  }
  const topupRow = topup as { id: string; amount: number | string }

  // 2. Record the attempt before involving Yoco.
  const { data: payment, error: payError } = await supabase
    .from("tenant_payments")
    .insert({
      tenant_id: tenantId,
      integration_id: creds.integrationId,
      provider: "yoco",
      purpose: "wallet_topup",
      purpose_id: topupRow.id,
      amount,
      currency: "ZAR",
      status: "creating",
    })
    .select("id")
    .single()
  if (payError || !payment) {
    await supabase.rpc("wallet_fail_topup", { p_topup_id: topupRow.id, p_status: "failed" })
    return { ok: false, reason: "unavailable", message: "I couldn't start that top-up. Please try again." }
  }

  // 3 + 4. Checkout on the shop's own Yoco account.
  try {
    const base = getAppBaseUrl()
    const checkout = await yocoCreateCheckout({
      secretKey: creds.secretKey,
      amount,
      successUrl: `${base}/pay/result?status=success`,
      cancelUrl: `${base}/pay/result?status=cancelled`,
      failureUrl: `${base}/pay/result?status=failed`,
      metadata: { paymentId: payment.id as string, topupId: topupRow.id },
      idempotencyKey: `topup-${topupRow.id}`,
    })

    const { error: saveError } = await supabase
      .from("tenant_payments")
      .update({
        status: "pending",
        provider_checkout_id: checkout.id,
        checkout_url: checkout.redirectUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id)
    if (saveError) throw new Error(`Failed to save checkout: ${saveError.message}`)

    await supabase.from("wallet_topups").update({ provider_reference: checkout.id, checkout_url: checkout.redirectUrl }).eq("id", topupRow.id)
    return { ok: true, url: checkout.redirectUrl, mode: checkout.processingMode ?? creds.mode }
  } catch (error) {
    // The customer never got a link, so nobody can pay for this attempt. Close it off.
    await supabase.from("tenant_payments").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", payment.id)
    await supabase.rpc("wallet_fail_topup", { p_topup_id: topupRow.id, p_status: "failed" })
    console.error("[payments] checkout creation failed", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    const message =
      error instanceof YocoError && error.status === 401
        ? "Card payments aren't working for this shop right now. Please ask a team member."
        : "I couldn't start that top-up. Please try again in a moment."
    return { ok: false, reason: "unavailable", message }
  }
}
