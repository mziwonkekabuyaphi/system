// lib/whatsapp/ticket-image.ts
/**
 * Ticket IMAGES (multi-tenant).
 * ----------------------------------------------------------------------------
 * After a purchase the customer already gets the confirmation text and the plain QR codes straight
 * away. This file adds the nicer, branded ticket image on top:
 *
 *   1. The confirmation text (see event-tickets.ts) already says "<Shop> is generating your ticket
 *      image, it will arrive in about 30 seconds".
 *   2. scheduleOrderTicketImages() runs AFTER the webhook has answered (Next.js `after`), draws one
 *      image per ticket, uploads it to the public `ticket-images` Storage bucket and sends it on
 *      WhatsApp.
 *   3. If anything fails, the customer gets a short text saying the QR code above still works.
 *
 * Best-effort by design: tickets are already issued, so nothing here may ever throw into the order flow.
 *
 * SETUP: create a PUBLIC Storage bucket called `ticket-images` (same settings as `ticket-qrcodes`).
 */

import React from "react"
import { after } from "next/server"
import { ImageResponse } from "next/og"
import QRCode from "qrcode"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { sendWhatsAppImageMessage, sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"

const IMAGE_BUCKET = "ticket-images"
const MAX_IMAGES_PER_ORDER = 10
const DEFAULT_TZ = "Africa/Johannesburg"
const WIDTH = 800
const HEIGHT = 1150

const h = React.createElement

/** The shop's display name, e.g. for "Tenant Name is generating your ticket". Never throws. */
export async function getTenantDisplayName(supabase: SupabaseClient, tenantId: string): Promise<string> {
  try {
    const { data } = await supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle()
    return (data as { name?: string } | null)?.name?.trim() || "We"
  } catch {
    return "We"
  }
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-ZA", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(new Date(iso))
  } catch {
    return ""
  }
}

interface TicketImageData {
  shopName: string
  eventName: string
  when: string
  location: string | null
  tierName: string
  ticketNumber: string
  qrDataUrl: string
}

/** Draws one ticket as a PNG. */
async function drawTicketPng(d: TicketImageData): Promise<Buffer> {
  const label = (text: string) =>
    h("div", { style: { display: "flex", fontSize: 24, color: "#9ca3af", letterSpacing: 2, textTransform: "uppercase" } }, text)

  const tree = h(
    "div",
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#111827",
        padding: 40,
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          backgroundColor: "#ffffff",
          borderRadius: 32,
          overflow: "hidden",
        },
      },
      // Header band with the shop name
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", backgroundColor: "#4f46e5", padding: "36px 44px" } },
        h("div", { style: { display: "flex", fontSize: 26, color: "#c7d2fe", letterSpacing: 3, textTransform: "uppercase" } }, d.shopName),
        h("div", { style: { display: "flex", fontSize: 54, fontWeight: 700, color: "#ffffff", marginTop: 12, lineHeight: 1.15 } }, d.eventName),
      ),
      // Details
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", padding: "36px 44px 0 44px" } },
        label("When"),
        h("div", { style: { display: "flex", fontSize: 32, color: "#111827", marginTop: 6 } }, d.when),
        ...(d.location
          ? [
              h("div", { style: { display: "flex", marginTop: 24 } }, label("Where")),
              h("div", { style: { display: "flex", fontSize: 32, color: "#111827", marginTop: 6 } }, d.location),
            ]
          : []),
        h("div", { style: { display: "flex", marginTop: 24 } }, label("Ticket")),
        h("div", { style: { display: "flex", fontSize: 32, color: "#111827", marginTop: 6 } }, d.tierName),
      ),
      // QR
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", marginTop: 36 } },
        h("img", { src: d.qrDataUrl, width: 380, height: 380 }),
        h("div", { style: { display: "flex", fontSize: 40, fontWeight: 700, color: "#111827", marginTop: 20 } }, `#${d.ticketNumber}`),
        h("div", { style: { display: "flex", fontSize: 24, color: "#6b7280", marginTop: 8 } }, "Show this at the gate"),
      ),
    ),
  )

  const response = new ImageResponse(tree, { width: WIDTH, height: HEIGHT })
  return Buffer.from(await response.arrayBuffer())
}

async function buildAndUpload(
  supabase: SupabaseClient,
  tenantId: string,
  ticket: { id: string; ticket_number: string; qr_token: string | null; event_id: string; ticket_type_id: string },
  shopName: string,
  timeZone: string,
): Promise<string> {
  if (!ticket.qr_token) throw new Error("ticket has no qr_token")

  const [eventRes, typeRes, qrDataUrl] = await Promise.all([
    supabase.from("events").select("name, start_time, location").eq("tenant_id", tenantId).eq("id", ticket.event_id).maybeSingle(),
    supabase.from("event_ticket_types").select("name").eq("tenant_id", tenantId).eq("id", ticket.ticket_type_id).maybeSingle(),
    QRCode.toDataURL(ticket.qr_token, { errorCorrectionLevel: "M", margin: 1, width: 380 }),
  ])
  const event = eventRes.data as { name: string; start_time: string; location: string | null } | null
  if (!event) throw new Error("event not found")

  const png = await drawTicketPng({
    shopName,
    eventName: event.name,
    when: formatWhen(event.start_time, timeZone),
    location: event.location,
    tierName: (typeRes.data as { name: string } | null)?.name ?? "Ticket",
    ticketNumber: ticket.ticket_number,
    qrDataUrl,
  })

  // Same path on a retry overwrites the same file.
  const path = `${tenantId}/${ticket.id}.png`
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, png, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "31536000",
  })
  if (error) throw error

  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
}

/**
 * Draws and sends the ticket image for every ticket of an order, AFTER the current request has
 * finished. Never throws. Safe to call from the WhatsApp bot and from the Yoco webhook.
 */
export function scheduleOrderTicketImages(tenantId: string, orderId: string, phone: string): void {
  try {
    after(async () => {
      try {
        const supabase = getSupabaseServerClient()
        if (!supabase) throw new Error("Supabase client unavailable")

        const { data, error } = await supabase
          .from("event_tickets")
          .select("id, ticket_number, qr_token, event_id, ticket_type_id")
          .eq("tenant_id", tenantId)
          .eq("order_id", orderId)
          .order("created_at", { ascending: true })
          .limit(MAX_IMAGES_PER_ORDER)
        if (error || !data || data.length === 0) throw error ?? new Error("no tickets found for order")

        const [shopName, timeZone] = await Promise.all([
          getTenantDisplayName(supabase, tenantId),
          getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ),
        ])

        let sent = 0
        // One at a time: keeps memory low and one bad ticket can't stop the rest.
        for (const ticket of data as Array<{ id: string; ticket_number: string; qr_token: string | null; event_id: string; ticket_type_id: string }>) {
          try {
            const url = await buildAndUpload(supabase, tenantId, ticket, shopName, timeZone)
            await sendWhatsAppImageMessage(tenantId, phone, url, `Ticket #${ticket.ticket_number}`)
            sent++
          } catch (err) {
            console.error("[ticket-image] failed for a ticket", { tenantId, ticketId: ticket.id, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (sent === 0) throw new Error("no ticket images could be created")
      } catch (err) {
        console.error("[ticket-image] could not send ticket images", { tenantId, orderId, error: err instanceof Error ? err.message : String(err) })
        await sendWhatsAppTextMessage(
          tenantId,
          phone,
          "Sorry, we couldn't create your ticket image. Your QR code and ticket numbers above still work at the gate.",
        ).catch(() => {})
      }
    })
  } catch (err) {
    console.error("[ticket-image] could not schedule ticket images", { tenantId, orderId, error: err instanceof Error ? err.message : String(err) })
  }
}
