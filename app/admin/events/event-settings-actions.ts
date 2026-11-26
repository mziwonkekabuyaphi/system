// app/admin/events/event-settings-actions.ts
"use server"

/**
 * Event settings: sales rules + the WhatsApp ticket image look.
 * Same guard layers as ./actions.ts: requireTenantPermission("events.manage") proves the caller for
 * THEIR shop (tenantId comes from the membership), isModuleEnabled("events") shuts everything when
 * the module is off, and every query is filtered by tenant_id (service-role client bypasses RLS).
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { renderEventTicketPreview, renderTablePassPreview } from "@/lib/whatsapp/ticket-image"
import {
  HEX,
  salesRulesFromRow,
  salesRulesToRow,
  ticketSettingsFromRow,
  ticketSettingsToRow,
  validateSalesRules,
  validateTicketSettings,
  validateVvipPassSettings,
  vvipPassSettingsFromRow,
  vvipPassSettingsToRow,
  vvipTableSettingsFromRow,
  vvipTableSettingsToRow,
  type EventSalesRules,
  type EventTicketSettings,
  type VvipPassSettings,
  type VvipTableSettings,
} from "@/lib/services/event-settings"

type Result<T = object> = ({ success: true } & T) | { success: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

export interface EventSettingsConfig {
  rules: EventSalesRules
  /** VVIP tables on WhatsApp: do customers pick their own table? */
  tables: VvipTableSettings
  /** The QR code + branded pass a table buyer is sent. */
  pass: VvipPassSettings
  ticket: EventTicketSettings
  /** Brand colours the ticket falls back to, for the colour pickers. */
  brandHeader: string
  brandAccent: string
}

const DEFAULT_HEADER = "#1f2937"
const DEFAULT_ACCENT = "#f59e0b"
const GENERIC = "Something went wrong. Please try again."

async function scope(): Promise<{ ok: true; supabase: ServerClient; tenantId: string } | { ok: false; error: string }> {
  const check = await requireTenantPermission("events.manage")
  if (!check.ok) return { ok: false, error: check.error }
  const tenantId = check.member.tenantId
  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Supabase isn't configured." }
  if (!(await isModuleEnabled(tenantId, "events"))) return { ok: false, error: "Events isn't switched on for your business." }
  return { ok: true, supabase, tenantId }
}

export async function getEventSettings(): Promise<Result<{ config: EventSettingsConfig }>> {
  try {
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }
    const { supabase, tenantId } = s

    const [rulesRes, ticketRes, bookingRes, brandingRes, passRes] = await Promise.all([
      supabase.from("tenant_event_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_event_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_booking_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_branding").select("primary_color, secondary_color").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenant_vvip_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
    ])
    if (rulesRes.error || ticketRes.error) return { success: false, error: GENERIC }

    // Nothing saved yet: start from the look customers already get (the booking ticket's), so the
    // preview matches what is sent today. Its on/off switch is never copied.
    const ticketRow = ticketRes.data ?? bookingRes.data ?? null
    const ticketSaved = ticketRes.data as { enabled?: boolean; send_qr?: boolean } | null
    const enabled = ticketSaved?.enabled ?? true
    const sendQr = ticketSaved?.send_qr ?? true

    const brandHeader = HEX.test(brandingRes.data?.primary_color ?? "") ? brandingRes.data!.primary_color! : DEFAULT_HEADER
    const brandAccent = HEX.test(brandingRes.data?.secondary_color ?? "") ? brandingRes.data!.secondary_color! : DEFAULT_ACCENT

    return {
      success: true,
      config: {
        rules: salesRulesFromRow(rulesRes.data),
        tables: vvipTableSettingsFromRow(rulesRes.data),
        // A database without the table pass migration yet reads as the defaults (both on).
        pass: vvipPassSettingsFromRow(passRes.error ? null : passRes.data),
        ticket: ticketSettingsFromRow(ticketRow, enabled, sendQr),
        brandHeader,
        brandAccent,
      },
    }
  } catch (err) {
    console.error("[event-settings] load failed", err)
    return { success: false, error: GENERIC }
  }
}

/**
 * VVIP tables: should customers pick their own table on WhatsApp? Saved on the same row as the sales rules; the
 * upsert only names its own columns, so it never touches the rules (and saving the rules never touches this).
 */
export async function updateVvipTableSettings(input: VvipTableSettings): Promise<Result> {
  try {
    if (typeof input?.customersPickTable !== "boolean") return { success: false, error: "Invalid setting." }
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }

    const { error } = await s.supabase
      .from("tenant_event_settings")
      .upsert({ tenant_id: s.tenantId, ...vvipTableSettingsToRow(input), updated_at: new Date().toISOString() }, { onConflict: "tenant_id" })
    if (error) {
      console.error("[event-settings] save table settings failed", error.message)
      return { success: false, error: GENERIC }
    }
    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    console.error("[event-settings] save table settings failed", err)
    return { success: false, error: GENERIC }
  }
}

export async function updateEventSalesRules(input: EventSalesRules): Promise<Result> {
  try {
    const invalid = validateSalesRules(input)
    if (invalid) return { success: false, error: invalid }
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }

    const { error } = await s.supabase
      .from("tenant_event_settings")
      .upsert({ tenant_id: s.tenantId, ...salesRulesToRow(input), updated_at: new Date().toISOString() }, { onConflict: "tenant_id" })
    if (error) {
      console.error("[event-settings] save rules failed", error.message)
      return { success: false, error: GENERIC }
    }
    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    console.error("[event-settings] save rules failed", err)
    return { success: false, error: GENERIC }
  }
}

export async function updateEventTicketSettings(input: EventTicketSettings): Promise<Result> {
  try {
    const invalid = validateTicketSettings(input)
    if (invalid) return { success: false, error: invalid }
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }

    const { error } = await s.supabase
      .from("tenant_event_ticket_settings")
      .upsert({ tenant_id: s.tenantId, ...ticketSettingsToRow(input), updated_at: new Date().toISOString() }, { onConflict: "tenant_id" })
    if (error) {
      console.error("[event-settings] save ticket failed", error.message)
      return { success: false, error: GENERIC }
    }
    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    console.error("[event-settings] save ticket failed", err)
    return { success: false, error: GENERIC }
  }
}

/** Renders a sample ticket from the UNSAVED form values (always draws, even with "enabled" off). */
export async function previewEventTicket(input: EventTicketSettings): Promise<Result<{ dataUri: string }>> {
  try {
    const invalid = validateTicketSettings(input)
    if (invalid) return { success: false, error: invalid }
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }

    const png = await renderEventTicketPreview(s.tenantId, input)
    if (!png) return { success: false, error: "Could not render preview." }
    return { success: true, dataUri: `data:image/png;base64,${png.toString("base64")}` }
  } catch (err) {
    console.error("[event-settings] preview failed", err)
    return { success: false, error: GENERIC }
  }
}

/** Table pass: image / QR switches and the two texts. The look follows the Ticket card above. */
export async function updateVvipPassSettings(input: VvipPassSettings): Promise<Result> {
  try {
    const invalid = validateVvipPassSettings(input)
    if (invalid) return { success: false, error: invalid }
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }

    const { error } = await s.supabase
      .from("tenant_vvip_ticket_settings")
      .upsert({ tenant_id: s.tenantId, ...vvipPassSettingsToRow(input), updated_at: new Date().toISOString() }, { onConflict: "tenant_id" })
    if (error) {
      console.error("[event-settings] save table pass failed", error.message)
      return { success: false, error: GENERIC }
    }
    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    console.error("[event-settings] save table pass failed", err)
    return { success: false, error: GENERIC }
  }
}

/** Renders a sample table pass from the UNSAVED form values. */
export async function previewTablePass(input: VvipPassSettings): Promise<Result<{ dataUri: string }>> {
  try {
    const invalid = input.enabled || input.sendQr ? validateVvipPassSettings({ ...input, enabled: true }) : null
    if (invalid) return { success: false, error: invalid }
    const s = await scope()
    if (!s.ok) return { success: false, error: s.error }
    const png = await renderTablePassPreview(s.tenantId, input)
    if (!png) return { success: false, error: "Could not render preview." }
    return { success: true, dataUri: `data:image/png;base64,${png.toString("base64")}` }
  } catch (err) {
    console.error("[event-settings] table pass preview failed", err)
    return { success: false, error: GENERIC }
  }
}
