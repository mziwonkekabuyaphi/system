// lib/payments/paystack-reconcile.ts
/**
 * A second, safe trigger for a Paystack payment: the page the customer lands on after paying.
 *
 * Why it exists: Paystack's webhook address is set BY THE OWNER in their dashboard. If they forget it (or paste the
 * test address but pay live), a customer could pay and never be credited. Paystack's own guidance is to verify on the
 * callback anyway, so this does exactly that and nothing more.
 *
 * Why it is safe: the URL is never trusted. The reference only says WHICH payment to look at, and only references in
 * OUR format, that match a payment row we created, are looked at. Paystack's verify API (called with the shop's own
 * key) says whether it was paid, for how much and in which mode, and the SAME settle.ts as the webhook then applies
 * every check (amount, currency, tenant, idempotent database functions). The webhook and this page can both fire and
 * the customer is still credited exactly once.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getIntegrationConnection } from "./credentials"
import { getProvider } from "./providers"
import { isPaystackReference, paystackVerifyTransaction, verificationAgrees } from "./providers/paystack"
import { settleSucceeded } from "./settle"

/** confirmed = paid and applied; pending = not decided yet / can't tell; failed = Paystack says it did not go through; problem = paid but the order couldn't be completed; unknown = not ours. */
export type ReconcileResult = "confirmed" | "pending" | "failed" | "problem" | "unknown"

const OK_OUTCOMES = new Set(["credited", "tickets_issued", "already_done", "shisha_paid", "shisha_already_paid"])

export async function reconcilePaystackReference(reference: string): Promise<ReconcileResult> {
  if (!isPaystackReference(reference)) return "unknown"
  try {
    const db = getSupabaseServerClient()
    if (!db) return "pending"

    const { data: payment } = await db
      .from("tenant_payments")
      .select("tenant_id, integration_id, status")
      .eq("provider", "paystack")
      .eq("provider_checkout_id", reference)
      .maybeSingle()
    if (!payment) return "unknown"
    if (payment.status === "succeeded") return "confirmed"
    if (payment.status === "refund_needed" || payment.status === "refunded") return "problem"
    // 'cancelled' is included: the expiry job may have closed it just before a late payment (settle.ts revives such a top-up).
    if (payment.status !== "pending" && payment.status !== "cancelled") return "unknown"

    const connection = await getIntegrationConnection(db, payment.integration_id as string)
    const provider = getProvider("paystack")
    if (!provider || !connection || connection.provider !== "paystack" || connection.status !== "active" || connection.tenantId !== payment.tenant_id) {
      return "pending"
    }
    const secretKey = connection.secrets.secretKey
    if (!secretKey) return "pending"

    const verified = await paystackVerifyTransaction(secretKey, reference)
    if (verified.status === "failed" || verified.status === "abandoned" || verified.status === "reversed") return "failed"
    if (verified.status !== "success") return "pending"
    if (!verificationAgrees(verified, { reference, amountMinor: verified.amountMinor, currency: verified.currency, mode: connection.mode })) return "pending"

    const outcome = await settleSucceeded({
      db,
      provider,
      connection,
      deliveryId: `return:${reference}`,
      event: {
        deliveryId: `return:${reference}`,
        eventType: "return_reconcile",
        type: "succeeded",
        checkoutRef: reference,
        providerPaymentId: verified.id,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
      },
    })
    if (OK_OUTCOMES.has(outcome)) return "confirmed"
    // Paid, but the order couldn't be completed (e.g. tickets sold out): settle.ts has refunded or flagged it.
    if (outcome.startsWith("refund")) return "problem"
    return "pending"
  } catch (error) {
    console.error("[paystack-reconcile] failed", { error: error instanceof Error ? error.message : String(error) })
    return "pending"
  }
}
