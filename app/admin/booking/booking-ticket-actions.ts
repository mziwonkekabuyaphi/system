// app/admin/booking/booking-ticket-actions.ts
"use server"

/**
 * Booking ticket settings — tenant_booking_ticket_settings
 * --------------------------------------------------------
 * Same conventions as ../settings-actions.ts: owner-only (service-role client
 * bypasses RLS, so the role check + .eq("tenant_id") are the guard), and plan
 * access comes ONLY from the `booking_ticket` module in plan_modules (today:
 * Business). Never hardcode a plan key here.
 *
 * Access is also enforced where the ticket is actually generated
 * (booking-ticket-image.ts), so a tenant that downgrades stops sending tickets
 * even if their saved row still says enabled = true.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { tenantHasModule, assertProductEnabled, isProductNotEnabledError, MODULE_KEYS } from "@/lib/services/plans"
import { renderBookingTicketForTenant, type TicketSettingsRow } from "@/lib/whatsapp/booking-ticket-image"

export type TicketHeaderStyle = "gradient" | "solid" | "light"

export interface AdminBookingTicketSettings {
  enabled: boolean
  headerStyle: TicketHeaderStyle
  /** null = use the tenant's brand primary colour */
  headerColor: string | null
  /** null = use the tenant's brand secondary colour */
  accentColor: string | null
  /** null = use the branding "booking ticket label" or "Booking Confirmed" */
  eyebrow: string | null
  footerText: string | null
  showLogo: boolean
  showPrice: boolean
  showDuration: boolean
  showReference: boolean
  showPhone: boolean
  showAddress: boolean
  showQr: boolean
}

export interface BookingTicketConfig {
  /** Whether the tenant's plan includes the booking_ticket module. */
  allowed: boolean
  settings: AdminBookingTicketSettings
  /** Brand colours the ticket falls back to, for showing sensible defaults in the pickers. */
  brandHeader: string
  brandAccent: string
}

type Result<T = object> = ({ success: true } & T) | { success: false; error: string }

const MAX_EYEBROW = 40
const MAX_FOOTER = 120
const HEX = /^#[0-9a-fA-F]{6}$/
const DEFAULT_HEADER = "#1f2937"
const DEFAULT_ACCENT = "#f59e0b"

const DEFAULTS: AdminBookingTicketSettings = {
  enabled: true,
  headerStyle: "gradient",
  headerColor: null,
  accentColor: null,
  eyebrow: null,
  footerText: null,
  showLogo: true,
  showPrice: true,
  showDuration: true,
  showReference: true,
  showPhone: false,
  showAddress: true,
  showQr: true,
}

async function tenantContext() {
  const { tenantId, roleKey } = await requireTenantMember()
  if (roleKey !== "tenant_owner") throw new Error("Not authorized")
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId }
}

function fromRow(row: Record<string, unknown> | null): AdminBookingTicketSettings {
  if (!row) return DEFAULTS
  const style = row.header_style
  return {
    enabled: (row.enabled as boolean | null) ?? DEFAULTS.enabled,
    headerStyle: style === "solid" || style === "light" ? style : "gradient",
    headerColor: (row.header_color as string | null) ?? null,
    accentColor: (row.accent_color as string | null) ?? null,
    eyebrow: (row.eyebrow as string | null) ?? null,
    footerText: (row.footer_text as string | null) ?? null,
    showLogo: (row.show_logo as boolean | null) ?? DEFAULTS.showLogo,
    showPrice: (row.show_price as boolean | null) ?? DEFAULTS.showPrice,
    showDuration: (row.show_duration as boolean | null) ?? DEFAULTS.showDuration,
    showReference: (row.show_reference as boolean | null) ?? DEFAULTS.showReference,
    showPhone: (row.show_phone as boolean | null) ?? DEFAULTS.showPhone,
    showAddress: (row.show_address as boolean | null) ?? DEFAULTS.showAddress,
    showQr: (row.show_qr as boolean | null) ?? DEFAULTS.showQr,
  }
}

function toRow(s: AdminBookingTicketSettings): TicketSettingsRow {
  return {
    enabled: s.enabled,
    header_style: s.headerStyle,
    header_color: s.headerColor,
    accent_color: s.accentColor,
    eyebrow: s.eyebrow?.trim() || null,
    footer_text: s.footerText?.trim() || null,
    show_logo: s.showLogo,
    show_price: s.showPrice,
    show_duration: s.showDuration,
    show_reference: s.showReference,
    show_phone: s.showPhone,
    show_address: s.showAddress,
    show_qr: s.showQr,
  }
}

function validate(s: AdminBookingTicketSettings): string | null {
  if (!["gradient", "solid", "light"].includes(s.headerStyle)) return "Choose a valid header style."
  if (s.headerColor && !HEX.test(s.headerColor)) return "Header colour must be a hex colour like #1F2937."
  if (s.accentColor && !HEX.test(s.accentColor)) return "Accent colour must be a hex colour like #F59E0B."
  if ((s.eyebrow ?? "").trim().length > MAX_EYEBROW) return `Ticket label must be ${MAX_EYEBROW} characters or fewer.`
  if ((s.footerText ?? "").trim().length > MAX_FOOTER) return `Footer text must be ${MAX_FOOTER} characters or fewer.`
  return null
}

/** Friendly text when Booking is switched off for the shop (stale tab / forged call). */
function ticketError(err: unknown): string {
  return isProductNotEnabledError(err) ? "Booking isn't switched on for your shop." : (err as Error).message
}

async function hasTicketModule(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
): Promise<boolean> {
  try {
    return await tenantHasModule(supabase, tenantId, MODULE_KEYS.bookingTicket)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
export async function getBookingTicketConfig(): Promise<Result<{ config: BookingTicketConfig }>> {
  try {
    const { supabase, tenantId } = await tenantContext()
    await assertProductEnabled(supabase, tenantId, "booking")

    const [allowed, ticketRes, brandingRes] = await Promise.all([
      hasTicketModule(supabase, tenantId),
      supabase.from("tenant_booking_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_branding").select("primary_color, secondary_color").eq("tenant_id", tenantId).maybeSingle(),
    ])

    if (ticketRes.error) return { success: false, error: ticketRes.error.message }

    const brandHeader = HEX.test(brandingRes.data?.primary_color ?? "") ? brandingRes.data!.primary_color! : DEFAULT_HEADER
    const brandAccent = HEX.test(brandingRes.data?.secondary_color ?? "") ? brandingRes.data!.secondary_color! : DEFAULT_ACCENT

    return {
      success: true,
      config: { allowed, settings: fromRow(ticketRes.data), brandHeader, brandAccent },
    }
  } catch (err) {
    return { success: false, error: ticketError(err) }
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
export async function updateBookingTicketSettings(input: AdminBookingTicketSettings): Promise<Result> {
  try {
    const invalid = validate(input)
    if (invalid) return { success: false, error: invalid }

    const { supabase, tenantId } = await tenantContext()
    await assertProductEnabled(supabase, tenantId, "booking")

    if (!(await hasTicketModule(supabase, tenantId))) {
      return { success: false, error: "Booking tickets aren't included in your current plan. Upgrade to Business to use them." }
    }

    const { error } = await supabase
      .from("tenant_booking_ticket_settings")
      .upsert({ tenant_id: tenantId, ...toRow(input), updated_at: new Date().toISOString() }, { onConflict: "tenant_id" })

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: ticketError(err) }
  }
}

// ---------------------------------------------------------------------------
// Live preview — renders the ticket with UNSAVED form values and a sample booking.
// ---------------------------------------------------------------------------
export async function previewBookingTicket(input: AdminBookingTicketSettings): Promise<Result<{ dataUri: string }>> {
  try {
    const invalid = validate(input)
    if (invalid) return { success: false, error: invalid }

    const { supabase, tenantId } = await tenantContext()
    await assertProductEnabled(supabase, tenantId, "booking")
    if (!(await hasTicketModule(supabase, tenantId))) {
      return { success: false, error: "Booking tickets aren't included in your current plan." }
    }

    const start = new Date()
    start.setDate(start.getDate() + 1)
    start.setHours(10, 0, 0, 0)
    const end = new Date(start.getTime() + 45 * 60_000)

    const png = await renderBookingTicketForTenant(
      tenantId,
      {
        bookingId: "preview",
        bookingReference: "H456R",
        customerName: "Thandi Mokoena",
        customerPhone: "0731234567",
        serviceNames: ["Hair Cut", "Beard Trim"],
        totalPrice: 250,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      },
      toRow(input), // overrides => always renders, even if "enabled" is off
    )
    if (!png) return { success: false, error: "Could not render preview." }

    return { success: true, dataUri: `data:image/png;base64,${png.toString("base64")}` }
  } catch (err) {
    return { success: false, error: ticketError(err) }
  }
}
