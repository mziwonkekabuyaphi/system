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
 * LOOK: same style as the booking ticket — the shop's own branding, icon rows, no borders.
 *
 * Where each branding setting comes from (first one that has a value wins):
 *   shop name   tenant_branding.display_name -> tenant_settings.brand_name -> tenants.name
 *   logo        tenant_branding.logo_url (PNG / JPEG / GIF / SVG; WebP is skipped, satori can't draw it)
 *   colours     tenant_branding.primary_color (header) / secondary_color (icons) -> neutral defaults
 *   powered-by  hidden when tenant_branding.remove_powered_by is true (see POWERED_BY_TEXT)
 *
 * Best-effort by design: tickets are already issued, so nothing here may ever throw into the order flow.
 * A branding / logo problem never blocks the ticket: it just falls back to the defaults.
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
const HEIGHT = 1280

/** Neutral palette for tenants who haven't set brand colours yet (same as the booking ticket). */
const DEFAULT_HEADER = "#1f2937"
const DEFAULT_ACCENT = "#f59e0b"
const PAGE_BG = "#f3f4f6"

/** Small footer line. Leave "" to never show one; tenants with remove_powered_by also never show it. */
const POWERED_BY_TEXT = ""

/** Caption under each ticket image on WhatsApp (the ticket number is already on the image). */
const TICKET_CAPTION = "See you there! 🎉"

const h = React.createElement

// ----------------------------------------------------------------------------
// Branding
// ----------------------------------------------------------------------------

interface TicketBranding {
  shopName: string
  logoDataUri: string | null
  headerColor: string
  accentColor: string
  showPoweredBy: boolean
}

/** "#abc" / "abc" / "#aabbcc" -> "#aabbcc"; anything else -> fallback. */
function cleanHex(value: string | null | undefined, fallback: string): string {
  const v = (value ?? "").trim().replace(/^#/, "")
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${v.split("").map((c) => c + c).join("").toLowerCase()}`
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`
  return fallback
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Darkens a colour (amount 0..1) for the second stop of the header gradient. */
function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c * (1 - amount)))
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Dark text on a light header, white text on a dark one. */
function isLight(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.65
}

// Logo: fetched once, cached per URL (the URL carries a ?v= cache-buster when the tenant uploads a new one).
const LOGO_CACHE_TTL_MS = 10 * 60 * 1000
const LOGO_MAX_BYTES = 2 * 1024 * 1024
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/svg+xml"])
const logoCache = new Map<string, { uri: string | null; expiresAt: number }>()

async function loadLogoDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url) return null
  const cached = logoCache.get(url)
  if (cached && Date.now() < cached.expiresAt) return cached.uri

  let uri: string | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()

    if (!response.ok) {
      console.warn("[ticket-image] Logo fetch failed", { status: response.status })
    } else if (!LOGO_TYPES.has(type)) {
      console.warn("[ticket-image] Logo type not supported by the renderer; drawing without it", { type })
    } else {
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > LOGO_MAX_BYTES) {
        console.warn("[ticket-image] Logo too large; drawing without it", { bytes: bytes.length })
      } else {
        uri = `data:${type};base64,${bytes.toString("base64")}`
      }
    }
  } catch (error) {
    console.warn("[ticket-image] Logo fetch error; drawing without it", error)
  }

  logoCache.set(url, { uri, expiresAt: Date.now() + LOGO_CACHE_TTL_MS })
  return uri
}

/** Shop name, colours and logo for a tenant. Never throws: falls back to neutral defaults. */
async function resolveBranding(supabase: SupabaseClient, tenantId: string): Promise<TicketBranding> {
  let brandingRow: Record<string, string | boolean | null> | null = null
  let settingsRow: { brand_name?: string | null } | null = null
  let tenantRow: { name?: string | null } | null = null

  try {
    const [tenantRes, brandingRes, settingsRes] = await Promise.all([
      supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      supabase
        .from("tenant_branding")
        .select("display_name, logo_url, primary_color, secondary_color, remove_powered_by")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      supabase.from("tenant_settings").select("brand_name").eq("tenant_id", tenantId).maybeSingle(),
    ])
    tenantRow = tenantRes.data as typeof tenantRow
    brandingRow = brandingRes.data as typeof brandingRow
    settingsRow = settingsRes.data as typeof settingsRow
  } catch (error) {
    console.warn("[ticket-image] Could not load branding; using defaults", { tenantId, error })
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

  return {
    shopName: str(brandingRow?.display_name) || str(settingsRow?.brand_name) || str(tenantRow?.name) || "Your event",
    logoDataUri: await loadLogoDataUri(str(brandingRow?.logo_url) || null),
    headerColor: cleanHex(str(brandingRow?.primary_color), DEFAULT_HEADER),
    accentColor: cleanHex(str(brandingRow?.secondary_color), DEFAULT_ACCENT),
    showPoweredBy: !(brandingRow?.remove_powered_by ?? false),
  }
}

/**
 * The shop's display name, e.g. for "Tenant Name is generating your ticket". Never throws.
 * Now prefers the brand display name so the text matches the image.
 */
export async function getTenantDisplayName(supabase: SupabaseClient, tenantId: string): Promise<string> {
  try {
    const [tenantRes, brandingRes, settingsRes] = await Promise.all([
      supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      supabase.from("tenant_branding").select("display_name").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_settings").select("brand_name").eq("tenant_id", tenantId).maybeSingle(),
    ])
    const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "")
    return (
      clean((brandingRes.data as { display_name?: string } | null)?.display_name) ||
      clean((settingsRes.data as { brand_name?: string } | null)?.brand_name) ||
      clean((tenantRes.data as { name?: string } | null)?.name) ||
      "We"
    )
  } catch {
    return "We"
  }
}

// ----------------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------------

function formatDate(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-ZA", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }).format(new Date(iso))
  } catch {
    return ""
  }
}

function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-ZA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(
      new Date(iso),
    )
  } catch {
    return ""
  }
}

// ----------------------------------------------------------------------------
// Icons (lucide-style strokes, drawn as SVG data URIs in the accent colour)
// ----------------------------------------------------------------------------

type IconName = "calendar" | "pin" | "ticket" | "scan"

const ICON_PATHS: Record<IconName, string> = {
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  ticket:
    '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
}

function iconDataUri(name: IconName, color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

// ----------------------------------------------------------------------------
// Drawing
// ----------------------------------------------------------------------------

interface TicketImageData {
  brand: TicketBranding
  eventName: string
  dateLabel: string
  timeLabel: string
  location: string | null
  tierName: string
  ticketNumber: string
  qrDataUrl: string
}

/** Draws one ticket as a PNG. */
async function drawTicketPng(d: TicketImageData): Promise<Buffer> {
  const { brand } = d
  const headerEnd = darken(brand.headerColor, 0.28)
  const onHeader = isLight(brand.headerColor) ? "#111827" : "#ffffff"
  const onHeaderMuted = isLight(brand.headerColor) ? "rgba(17,24,39,0.7)" : "rgba(255,255,255,0.8)"

  // One detail row: tinted round icon + small label + value (+ optional second line).
  const row = (icon: IconName, label: string, value: string, sub?: string | null) =>
    h(
      "div",
      { style: { display: "flex", alignItems: "center", marginTop: 26 } },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 76,
            height: 76,
            borderRadius: 38,
            backgroundColor: rgba(brand.accentColor, 0.16),
            marginRight: 26,
          },
        },
        h("img", { src: iconDataUri(icon, brand.accentColor), width: 38, height: 38 }),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1 } },
        h("div", { style: { display: "flex", fontSize: 22, color: "#9ca3af", letterSpacing: 2, textTransform: "uppercase" } }, label),
        h("div", { style: { display: "flex", fontSize: 32, fontWeight: 700, color: "#111827", marginTop: 4, lineHeight: 1.2 } }, value),
        sub ? h("div", { style: { display: "flex", fontSize: 26, color: "#6b7280", marginTop: 2 } }, sub) : null,
      ),
    )

  // Dashed tear-off line with half-circle notches on both sides (no borders anywhere).
  const dashes = Array.from({ length: 20 }, () =>
    h("div", { style: { display: "flex", width: 18, height: 4, borderRadius: 2, backgroundColor: "#e5e7eb" } }),
  )
  const tearLine = h(
    "div",
    { style: { display: "flex", position: "relative", alignItems: "center", height: 44, marginTop: 28 } },
    h("div", { style: { position: "absolute", left: -22, top: 0, width: 44, height: 44, borderRadius: 22, backgroundColor: PAGE_BG } }),
    h("div", { style: { position: "absolute", right: -22, top: 0, width: 44, height: 44, borderRadius: 22, backgroundColor: PAGE_BG } }),
    h("div", { style: { display: "flex", flexGrow: 1, justifyContent: "space-between", margin: "0 48px" } }, ...dashes),
  )

  const headerTop = h(
    "div",
    { style: { display: "flex", alignItems: "center" } },
    brand.logoDataUri
      ? h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 72,
              height: 72,
              borderRadius: 18,
              backgroundColor: "#ffffff",
              marginRight: 20,
              overflow: "hidden",
            },
          },
          h("img", { src: brand.logoDataUri, width: 60, height: 60, style: { objectFit: "contain" } }),
        )
      : null,
    h(
      "div",
      { style: { display: "flex", fontSize: 30, fontWeight: 700, color: onHeader, letterSpacing: 1, flexShrink: 1 } },
      brand.shopName,
    ),
  )

  const tree = h(
    "div",
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: PAGE_BG,
        padding: 32,
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
          borderRadius: 36,
          overflow: "hidden",
          boxShadow: "0 8px 24px rgba(17,24,39,0.10)",
        },
      },
      // Header: tenant colours, logo, shop name, event name
      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            backgroundImage: `linear-gradient(135deg, ${brand.headerColor}, ${headerEnd})`,
            padding: "40px 48px 44px 48px",
          },
        },
        headerTop,
        h(
          "div",
          { style: { display: "flex", fontSize: 22, color: onHeaderMuted, letterSpacing: 4, textTransform: "uppercase", marginTop: 34 } },
          "Ticket Confirmed",
        ),
        h(
          "div",
          { style: { display: "flex", fontSize: 52, fontWeight: 700, color: onHeader, marginTop: 10, lineHeight: 1.15 } },
          d.eventName,
        ),
      ),
      // Accent stripe (tenant secondary colour) separating the header from the details
      h("div", { style: { display: "flex", height: 10, backgroundColor: brand.accentColor } }),
      // Details with icons
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", padding: "10px 48px 0 48px" } },
        row("calendar", "When", d.dateLabel, d.timeLabel || null),
        d.location ? row("pin", "Where", d.location) : null,
        row("ticket", "Ticket", d.tierName),
      ),
      tearLine,
      // QR
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexGrow: 1 } },
        h("img", { src: d.qrDataUrl, width: 340, height: 340 }),
        h("div", { style: { display: "flex", fontSize: 40, fontWeight: 700, color: "#111827", marginTop: 18 } }, `#${d.ticketNumber}`),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", marginTop: 10 } },
          h("img", { src: iconDataUri("scan", "#9ca3af"), width: 26, height: 26, style: { marginRight: 10 } }),
          h("div", { style: { display: "flex", fontSize: 24, color: "#6b7280" } }, "Show this at the gate"),
        ),
        brand.showPoweredBy && POWERED_BY_TEXT
          ? h("div", { style: { display: "flex", fontSize: 20, color: "#9ca3af", marginTop: 22 } }, POWERED_BY_TEXT)
          : null,
      ),
    ),
  )

  const response = new ImageResponse(tree, { width: WIDTH, height: HEIGHT })
  return Buffer.from(await response.arrayBuffer())
}

type TicketRow = { id: string; ticket_number: string; qr_token: string | null; event_id: string; ticket_type_id: string }

async function buildAndUpload(
  supabase: SupabaseClient,
  tenantId: string,
  ticket: TicketRow,
  brand: TicketBranding,
  timeZone: string,
): Promise<string> {
  if (!ticket.qr_token) throw new Error("ticket has no qr_token")

  const [eventRes, typeRes, qrDataUrl] = await Promise.all([
    supabase.from("events").select("name, start_time, location").eq("tenant_id", tenantId).eq("id", ticket.event_id).maybeSingle(),
    supabase.from("event_ticket_types").select("name").eq("tenant_id", tenantId).eq("id", ticket.ticket_type_id).maybeSingle(),
    QRCode.toDataURL(ticket.qr_token, { errorCorrectionLevel: "M", margin: 1, width: 340 }),
  ])
  const event = eventRes.data as { name: string; start_time: string; location: string | null } | null
  if (!event) throw new Error("event not found")

  const png = await drawTicketPng({
    brand,
    eventName: event.name,
    dateLabel: formatDate(event.start_time, timeZone),
    timeLabel: formatTime(event.start_time, timeZone),
    location: event.location?.trim() || null,
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

        // Branding + logo are resolved once per order, not once per ticket.
        const [brand, timeZone] = await Promise.all([
          resolveBranding(supabase, tenantId),
          getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ),
        ])

        let sent = 0
        // One at a time: keeps memory low and one bad ticket can't stop the rest.
        for (const ticket of data as TicketRow[]) {
          try {
            const url = await buildAndUpload(supabase, tenantId, ticket, brand, timeZone)
            await sendWhatsAppImageMessage(tenantId, phone, url, TICKET_CAPTION)
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
