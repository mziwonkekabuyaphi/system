// lib/whatsapp/booking-ticket-image.ts
/**
 * Configurable Booking Ticket — tenant-aware generator
 * ----------------------------------------------------
 * After a customer books, this builds their ticket image in THEIR SHOP'S
 * branding and uploads it to the public `booking-tickets` Storage bucket,
 * returning a URL ready for sendWhatsAppImageMessage(tenantId, to, url, caption).
 *
 * Where each setting comes from (first one that has a value wins):
 *   shop name   tenant_branding.display_name -> tenant_settings.brand_name -> tenants.name
 *   logo        tenant_branding.logo_url
 *   colours     tenant_booking_ticket_settings.header_color / accent_color
 *               -> tenant_branding.primary_color / secondary_color -> neutral defaults
 *   eyebrow     tenant_booking_ticket_settings.eyebrow
 *               -> tenant_branding.ticket_booking_eyebrow -> "Booking Confirmed"
 *   footer      tenant_booking_ticket_settings.footer_text (no fallback: opt-in)
 *   dates/money tenant_settings.timezone / currency
 *   powered-by  hidden when tenant_branding.remove_powered_by is true
 *   on/off + every show_* toggle + header_style: tenant_booking_ticket_settings
 *
 * A tenant with NO tenant_booking_ticket_settings row gets the defaults below
 * (ticket enabled, gradient header in their brand colours), so every existing
 * tenant works without any backfill.
 *
 * FAILURE POLICY: the ticket is a nice-to-have on top of the text confirmation.
 * tryGenerateBookingTicketUrl() NEVER throws — it logs and returns null, so a
 * font/logo/Storage problem can't stop a customer from getting their booking
 * confirmation.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import {
  cleanHex,
  renderBookingTicketPng,
  type HeaderStyle,
  type RenderableTicket,
  type ResolvedTicketStyle,
} from "@/lib/whatsapp/booking-ticket-render"

const TICKET_BUCKET = "booking-tickets"

/** Neutral palette for tenants who haven't set brand colours yet. */
const DEFAULT_HEADER = "#1f2937"
const DEFAULT_ACCENT = "#f59e0b"

export interface BookingTicketInput {
  bookingId: string
  bookingReference: string
  customerName: string | null | undefined
  /** Raw or normalised; shown as a local number when it looks South African. */
  customerPhone: string
  /** Primary first, e.g. ["Hair Cut", "Beard Trim"]. */
  serviceNames: string[]
  /** Sum of the services' prices (in the tenant's currency). */
  totalPrice: number
  /** ISO timestamps, as returned by createBooking(). */
  startTime: string
  endTime: string
}

/** Row shape of tenant_booking_ticket_settings (all columns optional here). */
export interface TicketSettingsRow {
  enabled?: boolean | null
  header_style?: string | null
  header_color?: string | null
  accent_color?: string | null
  eyebrow?: string | null
  footer_text?: string | null
  show_logo?: boolean | null
  show_price?: boolean | null
  show_duration?: boolean | null
  show_reference?: boolean | null
  show_phone?: boolean | null
  show_address?: boolean | null
  show_qr?: boolean | null
}

// ----------------------------------------------------------------------------
// Small formatting helpers
// ----------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { ZAR: "R", USD: "$", EUR: "€", GBP: "£", NAD: "N$", BWP: "P" }

function formatMoney(amount: number, currency: string): string {
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
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso))
}

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  )
}

function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

function asHeaderStyle(value: string | null | undefined): HeaderStyle {
  return value === "solid" || value === "light" ? value : "gradient"
}

// ----------------------------------------------------------------------------
// Logo: fetched once, cached per URL (the URL carries a ?v= cache-buster that
// changes when the tenant uploads a new logo, so a new logo is picked up).
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
      console.warn("[booking-ticket] Logo fetch failed", { status: response.status })
    } else if (!LOGO_TYPES.has(type)) {
      // satori can't draw WebP (the branding bucket also allows it), so skip it.
      console.warn("[booking-ticket] Logo type not supported by the ticket renderer; rendering without it", { type })
    } else {
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > LOGO_MAX_BYTES) {
        console.warn("[booking-ticket] Logo too large for the ticket; rendering without it", { bytes: bytes.length })
      } else {
        uri = `data:${type};base64,${bytes.toString("base64")}`
      }
    }
  } catch (error) {
    console.warn("[booking-ticket] Logo fetch error; rendering without it", error)
  }

  logoCache.set(url, { uri, expiresAt: Date.now() + LOGO_CACHE_TTL_MS })
  return uri
}

// ----------------------------------------------------------------------------
// Resolve a tenant's style + format the booking
// ----------------------------------------------------------------------------

interface ResolvedTenantTicket {
  enabled: boolean
  style: ResolvedTicketStyle
  timeZone: string
  currency: string
  address: string | null
}

async function resolveTenantTicket(
  tenantId: string,
  overrides?: TicketSettingsRow,
): Promise<ResolvedTenantTicket> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase client unavailable — cannot build booking ticket")

  const [tenantRes, brandingRes, settingsRes, ticketRes] = await Promise.all([
    supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    supabase
      .from("tenant_branding")
      .select("display_name, logo_url, primary_color, secondary_color, remove_powered_by, ticket_booking_eyebrow")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase.from("tenant_settings").select("timezone, currency, address, brand_name").eq("tenant_id", tenantId).maybeSingle(),
    supabase.from("tenant_booking_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
  ])

  const branding = brandingRes.data
  const settings = settingsRes.data
  // `overrides` (live preview) win over the saved row.
  const cfg: TicketSettingsRow = { ...(ticketRes.data ?? {}), ...(overrides ?? {}) }

  const headerColor = cleanHex(cfg.header_color, cleanHex(branding?.primary_color, DEFAULT_HEADER))
  const accentColor = cleanHex(cfg.accent_color, cleanHex(branding?.secondary_color, DEFAULT_ACCENT))
  const showLogo = cfg.show_logo ?? true

  const style: ResolvedTicketStyle = {
    shopName:
      branding?.display_name?.trim() || settings?.brand_name?.trim() || tenantRes.data?.name?.trim() || "Your booking",
    eyebrow: cfg.eyebrow?.trim() || branding?.ticket_booking_eyebrow?.trim() || "Booking Confirmed",
    footerText: cfg.footer_text?.trim() || null,
    headerStyle: asHeaderStyle(cfg.header_style),
    headerColor,
    accentColor,
    logoDataUri: showLogo ? await loadLogoDataUri(branding?.logo_url) : null,
    showLogo,
    showPrice: cfg.show_price ?? true,
    showDuration: cfg.show_duration ?? true,
    showReference: cfg.show_reference ?? true,
    showPhone: cfg.show_phone ?? false,
    showAddress: cfg.show_address ?? true,
    showQr: cfg.show_qr ?? true,
    showPoweredBy: !(branding?.remove_powered_by ?? false),
  }

  return {
    enabled: cfg.enabled ?? true,
    style,
    timeZone: settings?.timezone || "Africa/Johannesburg",
    currency: settings?.currency || "ZAR",
    address: settings?.address?.trim() || null,
  }
}

function toRenderable(resolved: ResolvedTenantTicket, booking: BookingTicketInput): RenderableTicket {
  const { timeZone, currency } = resolved
  return {
    serviceName: booking.serviceNames.join(" + "),
    priceLabel: resolved.style.showPrice ? formatMoney(booking.totalPrice, currency) : null,
    dateLabel: formatDate(booking.startTime, timeZone),
    timeLabel: `${formatTime(booking.startTime, timeZone)} - ${formatTime(booking.endTime, timeZone)}`,
    durationLabel: formatDuration(booking.startTime, booking.endTime),
    address: resolved.address,
    phone: displayPhone(booking.customerPhone) || null,
    customerName: booking.customerName?.trim() || null,
    reference: booking.bookingReference,
    // The QR carries the booking reference — what staff type/scan to find the booking.
    qrValue: booking.bookingReference,
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Renders a tenant's ticket to PNG bytes WITHOUT uploading — for a live preview
 * in the settings page (pass unsaved form values as `overrides`) or for tests.
 * Returns null when the tenant has tickets switched off (unless previewing).
 */
export async function renderBookingTicketForTenant(
  tenantId: string,
  booking: BookingTicketInput,
  overrides?: TicketSettingsRow,
): Promise<Buffer | null> {
  const resolved = await resolveTenantTicket(tenantId, overrides)
  if (!resolved.enabled && !overrides) return null
  return renderBookingTicketPng(resolved.style, toRenderable(resolved, booking))
}

/**
 * Renders + uploads the ticket and returns its public URL, or null when the
 * tenant has tickets switched off. Throws on real failures; most callers want
 * tryGenerateBookingTicketUrl() below instead.
 */
export async function generateBookingTicketImage(tenantId: string, booking: BookingTicketInput): Promise<string | null> {
  const png = await renderBookingTicketForTenant(tenantId, booking)
  if (!png) return null

  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase client unavailable — cannot upload booking ticket")

  // Tenant folder first (matches the branding bucket's layout); one file per booking,
  // so a re-render after a reschedule overwrites instead of piling up.
  const storagePath = `${tenantId}/${booking.bookingId}.png`

  const { error } = await supabase.storage.from(TICKET_BUCKET).upload(storagePath, png, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "300",
  })
  if (error) throw error

  const { data } = supabase.storage.from(TICKET_BUCKET).getPublicUrl(storagePath)
  // ?v= so a re-issued ticket (reschedule) is never served from a stale CDN copy.
  return `${data.publicUrl}?v=${Date.now()}`
}

/** Same as generateBookingTicketImage(), but never throws: logs and returns null. */
export async function tryGenerateBookingTicketUrl(tenantId: string, booking: BookingTicketInput): Promise<string | null> {
  try {
    return await generateBookingTicketImage(tenantId, booking)
  } catch (error) {
    console.error("[booking-ticket] Could not generate ticket; sending text confirmation only", {
      tenantId,
      bookingId: booking.bookingId,
      error,
    })
    return null
  }
}
