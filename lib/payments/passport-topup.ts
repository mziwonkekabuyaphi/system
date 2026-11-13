// lib/payments/passport-topup.ts
/**
 * Start a Passport top-up paid on the SHOP'S OWN card provider (Yoco, Ozow, ... whichever is connected).
 *
 * Order matters, because it decides what can go wrong with someone's money:
 *   1. wallet_create_topup_whatsapp  -> a PENDING top-up row (all the shop's rules checked in the database)
 *   2. startCardPayment (card.ts)    -> tenant_payments row BEFORE asking the provider, then the checkout
 *                                       (idempotency key = the top-up id), then the checkout id saved
 *   3. only now is the link handed to the customer
 * If the checkout fails, the top-up is failed and the customer never receives a link, so nobody can pay
 * for something we can't match. The credit itself happens ONLY in the signed webhook.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { cardFailureMessage, getCardOption, startCardPayment } from "./card"

export interface TopupAvailability {
  available: boolean
  min: number
  max: number
  currency: string
  mode: "test" | "live" | null
}

/** Online top-up is available only when the shop allows it AND has an active card provider that can charge in the Passport's currency. */
export async function getTopupAvailability(supabase: SupabaseClient, tenantId: string): Promise<TopupAvailability> {
  const none: TopupAvailability = { available: false, min: 0, max: 0, currency: "ZAR", mode: null }

  const { data: settings, error } = await supabase
    .from("wallet_settings")
    .select("allow_customer_topup, min_topup, max_topup, currency")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read wallet settings: ${error.message}`)
  // No settings row yet = the database defaults apply when the first wallet is made; treat as not open.
  if (!settings || !settings.allow_customer_topup) return none

  const currency = (settings.currency as string) || "ZAR"
  const option = await getCardOption(supabase, tenantId, currency)
  if (!option) return none

  return {
    available: true,
    min: Math.max(Number(settings.min_topup) || 0, option.minAmount),
    max: Number(settings.max_topup) || 0,
    currency,
    mode: option.mode,
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

  const { data: settings } = await supabase.from("wallet_settings").select("currency").eq("tenant_id", tenantId).maybeSingle()
  const option = await getCardOption(supabase, tenantId, (settings?.currency as string | undefined) || "ZAR")
  if (!option) return { ok: false, reason: "not_connected", message: "Card top-up isn't set up for this shop yet." }
  if (amount < option.minAmount) return { ok: false, reason: "rejected", message: `Card payments start at R${option.minAmount}.` }

  // 1. Pending top-up. The database re-checks module, customer, limits, wallet status and balance cap.
  const { data: topup, error: topupError } = await supabase.rpc("wallet_create_topup_whatsapp", {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
    p_amount: amount,
    p_provider: option.provider.id,
  })
  if (topupError || !topup) {
    // These messages are written for customers (limits, blocked wallet); anything else falls back to generic.
    const text = topupError?.message ?? ""
    const friendly = /between|limit|blocked|closed|not enabled|Wallet is/i.test(text)
    return { ok: false, reason: "rejected", message: friendly ? text : "I couldn't start that top-up. Please try again." }
  }
  const topupRow = topup as { id: string; amount: number | string }

  // 2. Record the attempt, then the provider's checkout.
  const attempt = await startCardPayment({
    supabase,
    tenantId,
    option,
    purpose: "wallet_topup",
    purposeId: topupRow.id,
    amount,
    description: "Passport top-up",
    providerMetadata: { topupId: topupRow.id },
    idempotencyPrefix: "topup",
  })
  if (!attempt.ok) {
    // The customer never got a link, so nobody can pay for this attempt. Close the top-up off.
    await supabase.rpc("wallet_fail_topup", { p_topup_id: topupRow.id, p_status: "failed" })
    if (attempt.stage === "record") {
      return { ok: false, reason: "unavailable", message: "I couldn't start that top-up. Please try again." }
    }
    return {
      ok: false,
      reason: "unavailable",
      message: cardFailureMessage(attempt.error, "I couldn't start that top-up. Please try again in a moment."),
    }
  }

  await supabase.from("wallet_topups").update({ provider_reference: attempt.checkoutId, checkout_url: attempt.url }).eq("id", topupRow.id)
  return { ok: true, url: attempt.url, mode: attempt.mode }
}
