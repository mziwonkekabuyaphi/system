// lib/whatsapp/qr-generator.ts
/**
 * Event ticket QR codes (multi-tenant).
 * ----------------------------------------------------------------------------
 * Turns a ticket's `qr_token` into a PNG and uploads it to the public `ticket-qrcodes` Storage
 * bucket, returning a URL WhatsApp can fetch (the Cloud API needs a public URL or a media id; it
 * can't take raw bytes inline).
 *
 * What the QR holds: the ticket's `event_tickets.qr_token` (a random UUID). The gate screen
 * (event_check_in_ticket_gate) accepts it, a hardware scanner types it, and the ticket number
 * still works as a fallback.
 *
 * Privacy: the bucket is public, but each file is named `<tenantId>/<ticketId>.png` with an
 * unguessable ticket UUID, and nothing lists the bucket. Anyone holding the link can see that QR,
 * exactly like anyone holding the WhatsApp message can. Tickets are single-use at the gate.
 *
 * Best-effort by design: a ticket is already issued before this runs, so a QR failure must never
 * fail an order. Every public helper here returns [] / null instead of throwing.
 */

import QRCode from "qrcode"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getSupabaseServerClient } from "@/lib/supabase/admin"

const QR_BUCKET = "ticket-qrcodes"
/** WhatsApp is not a place to dump 50 images; the ticket numbers are in the text anyway. */
const MAX_QR_PER_ORDER = 10

/** Renders the QR for `qrToken` and uploads it. Returns its public URL. Throws on failure. */
export async function generateTicketQrCode(tenantId: string, ticketId: string, qrToken: string): Promise<string> {
  const png = await QRCode.toBuffer(qrToken, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 512 })

  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase client unavailable, cannot upload QR code")

  // Same path on a retry overwrites the same file instead of piling up.
  const path = `${tenantId}/${ticketId}.png`
  const { error } = await supabase.storage.from(QR_BUCKET).upload(path, png, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "31536000",
  })
  if (error) throw error

  return supabase.storage.from(QR_BUCKET).getPublicUrl(path).data.publicUrl
}

export interface OrderQr {
  url: string
  caption: string
}

/**
 * QR images for every ticket of an order, ready for WhatsApp (`ActionResult.media` or
 * sendWhatsAppImageMessage). Never throws: a ticket whose QR fails is simply left out (its number
 * is in the confirmation text).
 */
export async function getOrderTicketQrs(supabase: SupabaseClient, tenantId: string, orderId: string): Promise<OrderQr[]> {
  try {
    const { data, error } = await supabase
      .from("event_tickets")
      .select("id, ticket_number, qr_token")
      .eq("tenant_id", tenantId)
      .eq("order_id", orderId)
      .order("created_at", { ascending: true })
      .limit(MAX_QR_PER_ORDER)
    if (error || !data) return []

    const rows = data as Array<{ id: string; ticket_number: string; qr_token: string | null }>
    const results = await Promise.all(
      rows.map(async (t): Promise<OrderQr | null> => {
        if (!t.qr_token) return null
        try {
          const url = await generateTicketQrCode(tenantId, t.id, t.qr_token)
          return { url, caption: `Ticket #${t.ticket_number}` }
        } catch (err) {
          console.error("[qr-generator] QR failed for a ticket", { tenantId, ticketId: t.id, error: err instanceof Error ? err.message : String(err) })
          return null
        }
      }),
    )
    return results.filter((r): r is OrderQr => r !== null)
  } catch (err) {
    console.error("[qr-generator] could not build QR codes", { tenantId, orderId, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
