// lib/payments/card.ts
/**
 * Provider-neutral card payments: "can this shop take a card payment, and in what currency?", and the one
 * shared way to START a checkout. The flows that call it (Passport top-up, event tickets) differ only in
 * what they record before and after.
 *
 * The order inside startCardPayment matters, because it decides what can go wrong with someone's money:
 *   1. a tenant_payments row ('creating') BEFORE the provider is asked, so there is always a record of the attempt
 *   2. the provider creates the checkout (idempotency key from the caller, so a retry can't create two)
 *   3. the checkout id is saved and the row becomes 'pending'
 *   4. only now is the link returned, so nobody can pay for something we can't match
 * If 2 or 3 fails the row is marked 'failed' and the caller gets no link.
 * The money is only ever applied by the signed webhook (webhook-handler.ts), never from here.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getAppBaseUrl, getTenantCardConnection, getTenantCurrency, webhookUrlFor, type StoredConnection } from "./credentials"
import { getProvider, ProviderError, type CardProvider, type PaymentMode } from "./providers"

export interface CardOption {
  connection: StoredConnection
  provider: CardProvider
  currency: string
  mode: PaymentMode
  /** Smallest amount (major units) this provider accepts. */
  minAmount: number
}

/**
 * null when the shop has no active provider, or the provider can't charge in the currency.
 * `currency` is the currency of the thing being paid for (a Passport's currency for a top-up); it defaults
 * to the shop's own currency (tenant_settings.currency), which is what ticket prices are in.
 */
export async function getCardOption(supabase: SupabaseClient, tenantId: string, currency?: string): Promise<CardOption | null> {
  const [connection, shopCurrency] = await Promise.all([
    getTenantCardConnection(supabase, tenantId),
    currency ? Promise.resolve(currency) : getTenantCurrency(supabase, tenantId),
  ])
  currency = shopCurrency.trim().toUpperCase()
  if (!connection) return null
  const provider = getProvider(connection.provider)
  if (!provider || !provider.currencies.includes(currency)) return null
  return { connection, provider, currency, mode: connection.mode, minAmount: provider.minAmount }
}

/** The customer-facing line when the provider's credentials stop working. */
export function cardFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
    return "Card payments aren't working for this shop right now. Please ask a team member."
  }
  return fallback
}

export type StartCardPaymentResult =
  | { ok: true; paymentId: string; checkoutId: string; url: string; mode: PaymentMode }
  | { ok: false; stage: "record" | "checkout"; error: unknown; paymentId: string }

export async function startCardPayment(args: {
  supabase: SupabaseClient
  tenantId: string
  option: CardOption
  purpose: "wallet_topup" | "event_order"
  /** The thing being paid for (the top-up id). Omit for event orders: the payment is its own purpose id. */
  purposeId?: string
  amount: number
  description: string
  /** Stored on tenant_payments.metadata: what is needed to fulfil the payment later. */
  recordMetadata?: Record<string, unknown>
  /** Sent to the provider as metadata (strings only). */
  providerMetadata?: Record<string, string>
  /** "topup" or "event". The provider idempotency key is `<prefix>-<purposeId or paymentId>`, so a retry of the
   *  same top-up (or the same payment attempt) can never create a second checkout. */
  idempotencyPrefix: "topup" | "event"
}): Promise<StartCardPaymentResult> {
  const { supabase, tenantId, option } = args
  const paymentId = randomUUID()

  // 1. Record the attempt first.
  const { error: insertError } = await supabase.from("tenant_payments").insert({
    id: paymentId,
    tenant_id: tenantId,
    integration_id: option.connection.integrationId,
    provider: option.provider.id,
    purpose: args.purpose,
    purpose_id: args.purposeId ?? paymentId,
    amount: args.amount,
    currency: option.currency,
    status: "creating",
    ...(args.recordMetadata ? { metadata: args.recordMetadata } : {}),
  })
  if (insertError) {
    console.error("[payments] could not record payment attempt", { tenantId, error: insertError.message })
    return { ok: false, stage: "record", error: insertError, paymentId }
  }

  // 2 + 3. Checkout on the shop's own provider account.
  try {
    const base = getAppBaseUrl()
    const checkout = await option.provider.createCheckout({
      connection: option.connection,
      amount: args.amount,
      currency: option.currency,
      paymentId,
      description: args.description,
      successUrl: `${base}/pay/result?status=success`,
      cancelUrl: `${base}/pay/result?status=cancelled`,
      failureUrl: `${base}/pay/result?status=failed`,
      notifyUrl: webhookUrlFor(option.provider.id, option.connection.integrationId),
      idempotencyKey: `${args.idempotencyPrefix}-${args.purposeId ?? paymentId}`,
      metadata: args.providerMetadata,
    })
    const { error: saveError } = await supabase
      .from("tenant_payments")
      .update({ status: "pending", provider_checkout_id: checkout.checkoutId, checkout_url: checkout.redirectUrl, updated_at: new Date().toISOString() })
      .eq("id", paymentId)
    if (saveError) throw new Error(`Failed to save checkout: ${saveError.message}`)
    return { ok: true, paymentId, checkoutId: checkout.checkoutId, url: checkout.redirectUrl, mode: checkout.mode ?? option.mode }
  } catch (error) {
    // The customer never gets a link, so nobody can pay for this attempt.
    await supabase.from("tenant_payments").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", paymentId)
    console.error("[payments] checkout creation failed", {
      tenantId,
      provider: option.provider.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, stage: "checkout", error, paymentId }
  }
}
