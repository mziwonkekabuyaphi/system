// lib/whatsapp/ticket-image.ts
/**
 * Ticket IMAGES (multi-tenant).
 * ----------------------------------------------------------------------------
 * After a purchase the customer already gets the confirmation text and the plain QR codes straight
 * away. This file adds the branded ticket image on top:
 *
 *   1. The confirmation text (see event-tickets.ts) already says "<Shop> is generating your ticket
 *      image, it will arrive in about 30 seconds".
 *   2. scheduleOrderTicketImages() runs AFTER the webhook has answered (Next.js `after`), draws one
 *      image per ticket, uploads it to the public `ticket-images` Storage bucket and sends it on
 *      WhatsApp.
 *   3. If anything fails, the customer gets a short text saying the QR code above still works.
 *
 * LOOK: drawn by event-ticket-render.ts, which uses the same engine, fonts, canvas size and QR size
 * as the booking ticket (booking-ticket-render.ts).
 *
 * BRANDING: resolved exactly like the booking ticket (booking-ticket-image.ts), first value wins:
 *   shop name   tenant_branding.display_name -> tenant_settings.brand_name -> tenants.name
 *   logo        tenant_branding.logo_url
 *   look        tenant_event_ticket_settings (Events > Event settings > Ticket). A shop that has not
 *               saved event settings yet keeps the look it had before: the booking ticket row is used
 *               as the fallback for every field below except `enabled`.
 *   colours     header_color / accent_color -> tenant_branding.primary_color / secondary_color -> defaults
 *   label       eyebrow (else "Ticket Confirmed")
 *   footer      footer_text (else "Show this QR code at the gate")
 *   toggles     header_style, show_logo, show_price, show_reference, show_phone, show_address
 *   on/off      tenant_event_ticket_settings.enabled (default on). Off = no image is drawn or sent.
 *   QR message  tenant_event_ticket_settings.send_qr (default on). Off = the separate plain QR codes are
 *               not sent (event-tickets.ts / settle.ts) and the image alone is the ticket. The image
 *               always has the QR drawn on it. If the image then fails, the plain QR codes are sent as a fallback.
 *   dates/money tenant_settings.timezone / currency
 *   powered-by  hidden when tenant_branding.remove_powered_by is true
 * NOT applied to events: the `booking_ticket` plan module (event tickets are not plan-gated).
 * The QR drawn ON the image is always there (it is the entry pass); send_qr only controls the separate QR message.
 *
 * Best-effort by design: tickets are already issued, so nothing here may ever throw into the order flow.
 * A branding / logo problem never blocks the ticket: it just falls back to the defaults.
 *
 * SETUP: create a PUBLIC Storage bucket called `ticket-images` (same settings as `ticket-qrcodes`).
 */

import { after } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { sendWhatsAppImageMessage, sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"
import { cleanHex, type HeaderStyle, type ResolvedTicketStyle } from "@/lib/whatsapp/booking-ticket-render"
import { renderEventTicketPng, type RenderableEventTicket } from "@/lib/whatsapp/event-ticket-render"
import { renderTablePassPng, type RenderableTablePass } from "@/lib/whatsapp/table-ticket-render"
import { loadEventTicketDelivery, loadTableNames, loadVvipPassSettings, tableNamesOf, ticketSettingsToRow, vvipPassSettingsToRow, type EventTicketSettings, type VvipPassSettings } from "@/lib/services/event-settings"
import { sendOrderTicketQrs, sendTableBookingQr } from "@/lib/whatsapp/qr-generator"

const IMAGE_BUCKET = "ticket-images"
const MAX_IMAGES_PER_ORDER = 10
const DEFAULT_TZ = "Africa/Johannesburg"
const DEFAULT_CURRENCY = "ZAR"

/** Neutral palette for tenants who haven't set brand colours yet (same as the booking ticket). */
const DEFAULT_HEADER = "#1f2937"
const DEFAULT_ACCENT = "#f59e0b"

/** Caption under each ticket image on WhatsApp (the ticket number is already on the image). */
const TICKET_CAPTION = "See you there! 🎉"

const DEFAULT_EYEBROW = "Ticket Confirmed"

// ----------------------------------------------------------------------------
// Shop name for the "X is generating your ticket" text
// ----------------------------------------------------------------------------

/**
 * The shop's display name, e.g. for "Tenant Name is generating your ticket". Never throws.
 * Prefers the brand display name so the text matches the image.
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
// Formatting (same output as the booking ticket)
// ----------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { ZAR: "R", USD: "$", EUR: "€", GBP: "£", NAD: "N$", BWP: "P" }

function formatMoney(amount: number, currency: string): string {
  if (amount <= 0) return "Free"
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `
  const value = Number.isInteger(amount) ? amount.toLocaleString("en-ZA") : amount.toFixed(2)
  return `${symbol}${value}`
}

/** "+27731234567" / "27731234567" / "731234567" -> "0731234567". Others pass through. */
function displayPhone(phone: string): string {
  let digits = (phone ?? "").trim().replace(/[\s\-()]/g, "")
  if (digits.startsWith("+")) digits = digits.slice(1)
  if (digits.startsWith("27") && digits.length === 11) return `0${digits.slice(2)}`
  if (digits.length === 9 && !digits.startsWith("0")) return `0${digits}`
  return digits
}

function formatDate(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(iso))
  } catch {
    return ""
  }
}

function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
      new Date(iso),
    )
  } catch {
    return ""
  }
}

function asHeaderStyle(value: string | null | undefined): HeaderStyle {
  return value === "solid" || value === "light" ? value : "gradient"
}

// ----------------------------------------------------------------------------
// Logo: fetched once, cached per URL (the URL carries a ?v= cache-buster when the tenant uploads a new one).
// ----------------------------------------------------------------------------

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
      // satori can't draw WebP, so skip it.
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

// ----------------------------------------------------------------------------
// Tenant style (same rules as booking-ticket-image.ts)
// ----------------------------------------------------------------------------

interface TenantTicketLook {
  /** Whether the shop sends ticket images at all. */
  enabled: boolean
  style: ResolvedTicketStyle
  timeZone: string
  currency: string
}

interface TicketSettingsRow {
  eyebrow?: string | null
  header_style?: string | null
  header_color?: string | null
  accent_color?: string | null
  footer_text?: string | null
  show_logo?: boolean | null
  show_price?: boolean | null
  show_reference?: boolean | null
  show_phone?: boolean | null
  show_address?: boolean | null
}

/** Never throws: any problem falls back to the neutral defaults. */
async function resolveTenantLook(
  supabase: SupabaseClient,
  tenantId: string,
  /** Unsaved form values from the admin preview. Replaces the stored look. */
  overrides?: EventTicketSettings,
  /** The table pass has its OWN look: when given, this row is used and the event / booking rows are ignored. */
  ownRow?: TicketSettingsRow,
): Promise<TenantTicketLook> {
  let tenantRow = null as { name?: string | null } | null
  let branding = null as Record<string, string | boolean | null> | null
  let settings = null as { timezone?: string | null; currency?: string | null; brand_name?: string | null } | null
  let cfg: TicketSettingsRow = {}
  let enabled = true

  try {
    const [tenantRes, brandingRes, settingsRes, eventRes, bookingRes] = await Promise.all([
      supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      supabase
        .from("tenant_branding")
        .select("display_name, logo_url, primary_color, secondary_color, remove_powered_by")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      supabase.from("tenant_settings").select("timezone, currency, brand_name").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_event_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_booking_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
    ])
    tenantRow = tenantRes.data as typeof tenantRow
    branding = brandingRes.data as typeof branding
    settings = settingsRes.data as typeof settings
    const eventRow = eventRes.data as (TicketSettingsRow & { enabled?: boolean }) | null
    // Event row wins; with none saved yet, borrow the booking ticket's look (never its on/off switch).
    cfg = (eventRow ?? (bookingRes.data as TicketSettingsRow | null) ?? {}) as TicketSettingsRow
    enabled = eventRow?.enabled ?? true
  } catch (error) {
    console.warn("[ticket-image] Could not load branding; using defaults", { tenantId, error })
  }

  if (overrides) {
    cfg = ticketSettingsToRow(overrides)
    enabled = overrides.enabled
  }
  if (ownRow) cfg = ownRow

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const showLogo = cfg.show_logo ?? true

  const style: ResolvedTicketStyle = {
    shopName: str(branding?.display_name) || str(settings?.brand_name) || str(tenantRow?.name) || "Your event",
    eyebrow: str(cfg.eyebrow) || DEFAULT_EYEBROW,
    footerText: str(cfg.footer_text) || null,
    headerStyle: asHeaderStyle(cfg.header_style),
    headerColor: cleanHex(cfg.header_color, cleanHex(str(branding?.primary_color), DEFAULT_HEADER)),
    accentColor: cleanHex(cfg.accent_color, cleanHex(str(branding?.secondary_color), DEFAULT_ACCENT)),
    logoDataUri: showLogo ? await loadLogoDataUri(str(branding?.logo_url) || null) : null,
    showLogo,
    showPrice: cfg.show_price ?? true,
    showDuration: false,
    showReference: cfg.show_reference ?? true,
    showPhone: cfg.show_phone ?? false,
    showAddress: cfg.show_address ?? true,
    showQr: true,
    showPoweredBy: !(branding?.remove_powered_by ?? false),
  }

  return {
    enabled,
    style,
    timeZone: str(settings?.timezone) || DEFAULT_TZ,
    currency: str(settings?.currency) || DEFAULT_CURRENCY,
  }
}

// ----------------------------------------------------------------------------
// Order data + sending
// ----------------------------------------------------------------------------

type TicketRow = { id: string; ticket_number: string; qr_token: string | null; entries_allowed: number | null }

interface OrderTicketContext {
  eventName: string
  startTime: string
  endTime: string | null
  location: string | null
  tierName: string
  price: number
  quantity: number
  customerName: string | null
}

async function loadOrderContext(supabase: SupabaseClient, tenantId: string, orderId: string, fallbackCount: number): Promise<OrderTicketContext> {
  const { data: order, error } = await supabase
    .from("event_orders")
    .select("event_id, ticket_type_id, quantity, customer_id")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .maybeSingle()
  if (error || !order) throw error ?? new Error("order not found")

  const [eventRes, typeRes, customerRes] = await Promise.all([
    supabase.from("events").select("name, start_time, end_time, location").eq("tenant_id", tenantId).eq("id", order.event_id).maybeSingle(),
    supabase.from("event_ticket_types").select("name, price").eq("tenant_id", tenantId).eq("id", order.ticket_type_id).maybeSingle(),
    // Best-effort: the name is a nice-to-have, so a missing column or row just hides that line.
    order.customer_id
      ? supabase.from("tenant_customers").select("full_name").eq("tenant_id", tenantId).eq("id", order.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const event = eventRes.data as { name: string; start_time: string; end_time: string | null; location: string | null } | null
  if (!event) throw new Error("event not found")
  const type = typeRes.data as { name?: string; price?: number | string } | null

  return {
    eventName: event.name,
    startTime: event.start_time,
    endTime: event.end_time,
    location: event.location?.trim() || null,
    tierName: type?.name?.trim() || "Ticket",
    price: Number(type?.price) || 0,
    quantity: Number(order.quantity) || fallbackCount,
    customerName: ((customerRes.data as { full_name?: string | null } | null)?.full_name ?? "").trim() || null,
  }
}

function toRenderable(
  look: TenantTicketLook,
  ctx: OrderTicketContext,
  ticket: TicketRow,
  index: number,
  phone: string,
): RenderableEventTicket {
  const { timeZone, currency } = look
  const start = formatTime(ctx.startTime, timeZone)
  const end = ctx.endTime ? formatTime(ctx.endTime, timeZone) : ""
  const entries = Number(ticket.entries_allowed) || 1

  return {
    eventName: ctx.eventName,
    priceLabel: formatMoney(ctx.price, currency),
    dateLabel: formatDate(ctx.startTime, timeZone),
    timeLabel: start && end && end !== start ? `${start} - ${end}` : start,
    location: ctx.location,
    tierName: ctx.tierName,
    entriesLabel: entries > 1 ? `Admits ${entries}` : null,
    customerName: ctx.customerName,
    phone: displayPhone(phone) || null,
    ticketLabel: `#${ticket.ticket_number}${ctx.quantity > 1 ? ` · ${index + 1} of ${ctx.quantity}` : ""}`,
    // Same value as the plain QR code sent earlier, so the gate screen accepts either.
    qrValue: ticket.qr_token as string,
  }
}

async function renderAndUpload(supabase: SupabaseClient, tenantId: string, ticketId: string, style: ResolvedTicketStyle, renderable: RenderableEventTicket): Promise<string> {
  const png = await renderEventTicketPng(style, renderable)

  // Same path on a retry overwrites the same file.
  const path = `${tenantId}/${ticketId}.png`
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, png, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "300",
  })
  if (error) throw error

  // ?v= so a re-issued image is never served from a stale CDN copy.
  return `${supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl}?v=${Date.now()}`
}

/**
 * Draws and sends the ticket image for every ticket of an order, AFTER the current request has
 * finished. Never throws. Safe to call from the WhatsApp bot and from the Yoco webhook.
 */
export function scheduleOrderTicketImages(tenantId: string, orderId: string, phone: string): void {
  try {
    after(async () => {
      // True once the customer has (or never needs) the plain QR codes. Set to false only when the shop
      // switched the QR message off, so a failed image can fall back to sending them.
      let qrCovered = true
      let supabaseForFallback: SupabaseClient | null = null
      try {
        const supabase = getSupabaseServerClient()
        if (!supabase) throw new Error("Supabase client unavailable")
        supabaseForFallback = supabase
        qrCovered = (await loadEventTicketDelivery(supabase, tenantId)).qr

        const { data, error } = await supabase
          .from("event_tickets")
          .select("id, ticket_number, qr_token, entries_allowed")
          .eq("tenant_id", tenantId)
          .eq("order_id", orderId)
          .order("created_at", { ascending: true })
          .limit(MAX_IMAGES_PER_ORDER)
        if (error || !data || data.length === 0) throw error ?? new Error("no tickets found for order")
        const tickets = data as TicketRow[]

        // Branding, logo and event details are loaded once per order, not once per ticket.
        const [look, ctx] = await Promise.all([
          resolveTenantLook(supabase, tenantId),
          loadOrderContext(supabase, tenantId, orderId, tickets.length),
        ])

        // The shop switched ticket images off: the text confirmation and plain QR codes are enough.
        if (!look.enabled) return

        let sent = 0
        // One at a time: keeps memory low and one bad ticket can't stop the rest.
        for (const [index, ticket] of tickets.entries()) {
          try {
            if (!ticket.qr_token) throw new Error("ticket has no qr_token")
            const url = await renderAndUpload(supabase, tenantId, ticket.id, look.style, toRenderable(look, ctx, ticket, index, phone))
            await sendWhatsAppImageMessage(tenantId, phone, url, TICKET_CAPTION)
            sent++
          } catch (err) {
            console.error("[ticket-image] failed for a ticket", { tenantId, ticketId: ticket.id, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (sent === 0) throw new Error("no ticket images could be created")
      } catch (err) {
        console.error("[ticket-image] could not send ticket images", { tenantId, orderId, error: err instanceof Error ? err.message : String(err) })
        if (qrCovered) {
          await sendWhatsAppTextMessage(
            tenantId,
            phone,
            "Sorry, we couldn't create your ticket image. Your QR code and ticket numbers above still work at the gate.",
          ).catch(() => {})
        } else {
          // Image-only shop and the image failed: send the plain QR codes so the customer still has something to scan.
          await sendWhatsAppTextMessage(
            tenantId,
            phone,
            "Sorry, we couldn't create your ticket image. Here are your QR codes instead. Show one at the gate.",
          ).catch(() => {})
          const client = supabaseForFallback ?? getSupabaseServerClient()
          if (client) await sendOrderTicketQrs(client, tenantId, orderId, phone).catch(() => 0)
        }
      }
    })
  } catch (err) {
    console.error("[ticket-image] could not schedule ticket images", { tenantId, orderId, error: err instanceof Error ? err.message : String(err) })
  }
}

// ----------------------------------------------------------------------------
// Admin preview
// ----------------------------------------------------------------------------

/**
 * Renders a SAMPLE ticket with the given (possibly unsaved) settings plus the shop's real name, logo
 * and brand colours. Used by the Event settings preview. Returns null if drawing fails.
 */
export async function renderEventTicketPreview(tenantId: string, overrides: EventTicketSettings): Promise<Buffer | null> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return null
    const look = await resolveTenantLook(supabase, tenantId, overrides)

    const start = new Date()
    start.setDate(start.getDate() + 14)
    start.setHours(19, 0, 0, 0)
    const end = new Date(start.getTime() + 4 * 60 * 60_000)

    const ctx: OrderTicketContext = {
      eventName: "Summer Sessions Live",
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      location: "12 Main Road, Cape Town",
      tierName: "General Admission",
      price: 150,
      quantity: 1,
      customerName: "Mziwonke KaBuyaphi",
    }
    const ticket: TicketRow = { id: "preview", ticket_number: "E0042", qr_token: "preview-ticket-sample", entries_allowed: 1 }
    return await renderEventTicketPng(look.style, toRenderable(look, ctx, ticket, 0, "0731234567"))
  } catch (error) {
    console.error("[ticket-image] preview failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

// ----------------------------------------------------------------------------
// Table pass (its own settings: Event settings > Table pass; its own layout: table-ticket-render.ts)
// ----------------------------------------------------------------------------

interface TablePassData {
  packageName: string
  tableLabel: string | null
  seats: number | null
  eventName: string
  startTime: string
  endTime: string | null
  location: string | null
  reference: string
  pricePaid: number
  tabCredit: number
  customerName: string | null
  qrToken: string
}

/** The pass's own look as the row shape resolveTenantLook understands (so it never borrows the event ticket's look). */
const passLookRow = (pass: VvipPassSettings): TicketSettingsRow => {
  const r = vvipPassSettingsToRow(pass)
  return {
    header_style: r.header_style,
    header_color: r.header_color,
    accent_color: r.accent_color,
    show_logo: r.show_logo,
    show_price: r.show_price,
    show_reference: r.show_reference,
    show_phone: r.show_phone,
    show_address: r.show_address,
  }
}

function tablePassRenderable(
  look: TenantTicketLook,
  d: TablePassData,
  pass: VvipPassSettings,
  phone: string,
  word: string,
): { style: ResolvedTicketStyle; renderable: RenderableTablePass } {
  const { timeZone, currency } = look
  const start = formatTime(d.startTime, timeZone)
  const end = d.endTime ? formatTime(d.endTime, timeZone) : ""
  return {
    style: {
      ...look.style,
      eyebrow: pass.eyebrow?.trim() || `${word} Confirmed`,
      footerText: pass.footerText?.trim() || null,
    },
    renderable: {
      tableWord: word,
      tableLabel: d.tableLabel,
      packageName: d.packageName,
      eventName: d.eventName,
      dateLabel: formatDate(d.startTime, timeZone),
      timeLabel: start && end && end !== start ? `${start} - ${end}` : start,
      location: d.location,
      seatsLabel: d.seats && d.seats > 0 ? `${d.seats} seat${d.seats === 1 ? "" : "s"}` : null,
      customerName: d.customerName,
      phone: displayPhone(phone) || null,
      reference: d.reference,
      paidLabel: formatMoney(d.pricePaid, currency),
      tabLabel: pass.showTab && d.tabCredit > 0 ? formatMoney(d.tabCredit, currency) : null,
      qrValue: d.qrToken,
    },
  }
}

async function loadTablePassData(supabase: SupabaseClient, tenantId: string, bookingId: string): Promise<TablePassData> {
  const { data: b, error } = await supabase
    .from("vvip_bookings")
    .select("reference, package_id, table_id, customer_id, price_paid, tab_credit_issued, qr_token")
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .maybeSingle()
  if (error || !b) throw error ?? new Error("table booking not found")
  const row = b as {
    reference: string
    package_id: string
    table_id: string | null
    customer_id: string | null
    price_paid: number | string
    tab_credit_issued: number | string
    qr_token: string | null
  }
  if (!row.qr_token) throw new Error("booking has no qr_token")

  const [pkgRes, tableRes, custRes] = await Promise.all([
    supabase.from("vvip_packages").select("name, seats_per_table, event_id").eq("tenant_id", tenantId).eq("id", row.package_id).maybeSingle(),
    row.table_id ? supabase.from("vvip_tables").select("label").eq("tenant_id", tenantId).eq("id", row.table_id).maybeSingle() : Promise.resolve({ data: null }),
    row.customer_id ? supabase.from("tenant_customers").select("full_name").eq("tenant_id", tenantId).eq("id", row.customer_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const pkg = pkgRes.data as { name: string; seats_per_table: number | null; event_id: string } | null
  if (!pkg) throw new Error("package not found")
  const { data: ev } = await supabase.from("events").select("name, start_time, end_time, location").eq("tenant_id", tenantId).eq("id", pkg.event_id).maybeSingle()
  const event = ev as { name: string; start_time: string; end_time: string | null; location: string | null } | null
  if (!event) throw new Error("event not found")

  return {
    packageName: pkg.name,
    tableLabel: (tableRes.data as { label?: string } | null)?.label?.trim() || null,
    seats: pkg.seats_per_table ? Number(pkg.seats_per_table) : null,
    eventName: event.name,
    startTime: event.start_time,
    endTime: event.end_time,
    location: event.location?.trim() || null,
    reference: row.reference,
    pricePaid: Number(row.price_paid) || 0,
    tabCredit: Number(row.tab_credit_issued) || 0,
    customerName: ((custRes.data as { full_name?: string | null } | null)?.full_name ?? "").trim() || null,
    qrToken: row.qr_token,
  }
}

async function uploadTablePass(supabase: SupabaseClient, tenantId: string, bookingId: string, png: Buffer): Promise<string> {
  const path = `${tenantId}/table-${bookingId}.png`
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, png, { contentType: "image/png", upsert: true, cacheControl: "300" })
  if (error) throw error
  return `${supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl}?v=${Date.now()}`
}

/**
 * Draws and sends the branded table pass AFTER the current request has finished (the plain QR is sent separately,
 * see vvip-tables.ts / settle.ts). Does nothing when the shop switched the image off. If the image fails and the
 * shop doesn't send the plain QR, the QR is sent instead. Never throws.
 */
export function scheduleTablePassImage(tenantId: string, bookingId: string, phone: string): void {
  try {
    after(async () => {
      let qrCovered = true
      const supabase = getSupabaseServerClient()
      try {
        if (!supabase) throw new Error("Supabase client unavailable")
        const pass = await loadVvipPassSettings(supabase, tenantId)
        qrCovered = pass.sendQr || !pass.enabled
        if (!pass.enabled) return
        const [look, data, names] = await Promise.all([
          resolveTenantLook(supabase, tenantId, undefined, passLookRow(pass)),
          loadTablePassData(supabase, tenantId, bookingId),
          loadTableNames(supabase, tenantId),
        ])
        const { style, renderable } = tablePassRenderable(look, data, pass, phone, names.singular)
        const url = await uploadTablePass(supabase, tenantId, bookingId, await renderTablePassPng(style, renderable))
        await sendWhatsAppImageMessage(tenantId, phone, url, "See you there! 🍾")
      } catch (err) {
        console.error("[ticket-image] table pass failed", { tenantId, bookingId, error: err instanceof Error ? err.message : String(err) })
        if (qrCovered) {
          await sendWhatsAppTextMessage(tenantId, phone, "Sorry, we couldn't create your pass image. Your QR code and reference above still work at the venue.").catch(() => {})
        } else if (supabase) {
          await sendWhatsAppTextMessage(tenantId, phone, "Sorry, we couldn't create your pass image. Here is your QR code instead. Show it at the venue.").catch(() => {})
          await sendTableBookingQr(supabase, tenantId, bookingId, phone).catch(() => false)
        }
      }
    })
  } catch (err) {
    console.error("[ticket-image] could not schedule table pass", { tenantId, bookingId, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Sample pass for the Event settings preview: the UNSAVED pass settings and names, the shop's real name and logo. */
export async function renderTablePassPreview(tenantId: string, pass: VvipPassSettings, names?: { tableName: string | null; tablesName: string | null }): Promise<Buffer | null> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return null
    const word = names ? tableNamesOf(names).singular : (await loadTableNames(supabase, tenantId)).singular
    const look = await resolveTenantLook(supabase, tenantId, undefined, passLookRow(pass))
    const start = new Date()
    start.setDate(start.getDate() + 14)
    start.setHours(19, 0, 0, 0)
    const data: TablePassData = {
      packageName: "Paradise Xperience",
      tableLabel: "A3",
      seats: 6,
      eventName: "Summer Sessions Live",
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 4 * 60 * 60_000).toISOString(),
      location: "12 Main Road, Cape Town",
      reference: "VIP-4K7Q2M",
      pricePaid: 2500,
      tabCredit: 500,
      customerName: "Mziwonke KaBuyaphi",
      qrToken: "preview-table-sample",
    }
    const { style, renderable } = tablePassRenderable(look, data, pass, "0731234567", word)
    return await renderTablePassPng(style, renderable)
  } catch (error) {
    console.error("[ticket-image] table pass preview failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
