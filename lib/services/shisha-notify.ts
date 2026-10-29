// lib/services/shisha-notify.ts
//
// Best-effort WhatsApp reply sender for shisha request outcomes. NEVER throws —
// a failed send must not undo an accepted/rejected request. The caller turns a
// failure into a staff-facing warning.
//
// NOTE: this does not yet deliver messages. It logs and returns ok:false so the
// rest of the flow (accept/reject) is unaffected. Wire `deliver` to your real
// outbound helper (e.g. lib/services/outbound.ts) when it's ready.

import type { SupabaseClient } from "@supabase/supabase-js"

export type ShishaNotifyResult =
  | { ok: true }
  | { ok: false; reason: "no_phone" | "no_client" | "send_failed" }

/**
 * Send `text` to `phone` for `tenantId`. Never throws.
 * `logKey` is a stable tag for grouping logs by message kind.
 */
export async function sendShishaCustomerMessage(
  db: SupabaseClient,
  tenantId: string,
  phone: string | null | undefined,
  text: string,
  logKey: string,
): Promise<ShishaNotifyResult> {
  if (!phone || !phone.trim()) return { ok: false, reason: "no_phone" }
  if (!db) return { ok: false, reason: "no_client" }

  try {
    // TODO: replace with the real outbound sender. Keeping this stubbed means
    // accepted/rejected requests still succeed; the caller only shows a
    // staff-facing warning that the WhatsApp message wasn't delivered.
    //
    // Example (uncomment once the helper exists):
    //   const { sendWhatsAppText } = await import("@/lib/services/outbound")
    //   const r = await sendWhatsAppText({ tenantId, to: phone, body: text, tag: logKey })
    //   return r.ok ? { ok: true } : { ok: false, reason: "send_failed" }
    console.warn("[shisha-notify] WhatsApp delivery not wired", { tenantId, logKey, to: phone })
    void text
    return { ok: false, reason: "send_failed" }
  } catch (err) {
    console.error("[shisha-notify] send failed", {
      tenantId,
      logKey,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: "send_failed" }
  }
}
