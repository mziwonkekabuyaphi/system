// lib/payments/peach-return.ts
/**
 * What the Peach result page may say, from OUR OWN records only (read-only). Nothing here asks Peach anything and
 * nothing here credits anything: money moves only in the signed notification (webhook-handler.ts / settle.ts).
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isPeachReference } from "./providers/peach"

/** success = our records show it paid; pending = not paid (yet); problem = paid but the order couldn't be completed; failed = it did not go through; unknown = not ours. */
export type PeachReturnStatus = "success" | "pending" | "problem" | "failed" | "unknown"

export async function peachReturnStatus(reference: string): Promise<PeachReturnStatus> {
  if (!isPeachReference(reference)) return "unknown"
  try {
    const db = getSupabaseServerClient()
    if (!db) return "pending"
    const { data: payment } = await db
      .from("tenant_payments")
      .select("status")
      .eq("provider", "peach")
      .eq("provider_checkout_id", reference)
      .maybeSingle()
    if (!payment) return "unknown"
    switch (payment.status) {
      case "succeeded":
        return "success"
      case "refund_needed":
      case "refunded":
        return "problem"
      case "failed":
        return "failed"
      default:
        // creating / pending / cancelled: the notification may still be on its way (or the expiry job closed it just before a late payment).
        return "pending"
    }
  } catch (error) {
    console.error("[peach-return] failed", { error: error instanceof Error ? error.message : String(error) })
    return "pending"
  }
}
