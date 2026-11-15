// lib/services/event-settings.ts
/**
 * Event settings (per tenant): ticket sales rules and the look of the WhatsApp ticket image.
 * Tables: tenant_event_settings, tenant_event_ticket_settings (see migration 20261115140000).
 *
 * Pure types / defaults / validation plus two small loaders that take a Supabase client, so the
 * admin UI, the server actions, the WhatsApp flow and the image renderer all share one definition.
 * The SALES RULES are enforced in the database (_event_enforce_sales_rules); the loaders here only
 * let the bot explain a limit before the customer hits it.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export type EventTicketHeaderStyle = "gradient" | "solid" | "light"

export interface EventSalesRules {
  /** 1-10. */
  maxPerPurchase: number
  /** null = no limit per customer per event. */
  maxPerCustomer: number | null
  /** 0 = sell until the event ends. */
  stopSalesMinutesBefore: number
}

export interface EventTicketSettings {
  /** Off = no ticket image on WhatsApp (the text confirmation and plain QR still go out). */
  enabled: boolean
  headerStyle: EventTicketHeaderStyle
  /** null = the tenant's brand primary colour */
  headerColor: string | null
  /** null = the tenant's brand secondary colour */
  accentColor: string | null
  /** null = "Ticket Confirmed" */
  eyebrow: string | null
  /** null = "Show this QR code at the gate" */
  footerText: string | null
  showLogo: boolean
  showPrice: boolean
  showReference: boolean
  showPhone: boolean
  showAddress: boolean
}

export const MAX_EYEBROW = 40
export const MAX_FOOTER = 120
export const HEX = /^#[0-9a-fA-F]{6}$/

export const DEFAULT_SALES_RULES: EventSalesRules = {
  maxPerPurchase: 10,
  maxPerCustomer: null,
  stopSalesMinutesBefore: 0,
}

export const DEFAULT_TICKET_SETTINGS: EventTicketSettings = {
  enabled: true,
  headerStyle: "gradient",
  headerColor: null,
  accentColor: null,
  eyebrow: null,
  footerText: null,
  showLogo: true,
  showPrice: true,
  showReference: true,
  showPhone: false,
  showAddress: true,
}

type Row = Record<string, unknown>

const int = (v: unknown): number | null => {
  const n = Number(v)
  return v != null && Number.isInteger(n) ? n : null
}

export function salesRulesFromRow(row: Row | null | undefined): EventSalesRules {
  if (!row) return DEFAULT_SALES_RULES
  return {
    maxPerPurchase: int(row.max_per_purchase) ?? DEFAULT_SALES_RULES.maxPerPurchase,
    maxPerCustomer: int(row.max_per_customer),
    stopSalesMinutesBefore: int(row.stop_sales_minutes_before) ?? 0,
  }
}

export function salesRulesToRow(r: EventSalesRules) {
  return {
    max_per_purchase: r.maxPerPurchase,
    max_per_customer: r.maxPerCustomer,
    stop_sales_minutes_before: r.stopSalesMinutesBefore,
  }
}

export function validateSalesRules(r: EventSalesRules): string | null {
  if (!Number.isInteger(r.maxPerPurchase) || r.maxPerPurchase < 1 || r.maxPerPurchase > 10) {
    return "Tickets per purchase must be a whole number from 1 to 10."
  }
  if (r.maxPerCustomer != null && (!Number.isInteger(r.maxPerCustomer) || r.maxPerCustomer < 1 || r.maxPerCustomer > 100)) {
    return "Tickets per customer must be a whole number from 1 to 100, or left empty for no limit."
  }
  if (r.maxPerCustomer != null && r.maxPerCustomer < r.maxPerPurchase) {
    return "Tickets per customer can't be lower than tickets per purchase."
  }
  if (!Number.isInteger(r.stopSalesMinutesBefore) || r.stopSalesMinutesBefore < 0 || r.stopSalesMinutesBefore > 10080) {
    return "Stop selling must be between 0 minutes and 7 days (10080 minutes)."
  }
  return null
}

/** `row` is the event row, or the booking ticket row used as the starting point. */
export function ticketSettingsFromRow(row: Row | null | undefined, enabled = true): EventTicketSettings {
  if (!row) return { ...DEFAULT_TICKET_SETTINGS, enabled }
  const style = row.header_style
  const flag = (key: string, fallback: boolean) => (typeof row[key] === "boolean" ? (row[key] as boolean) : fallback)
  const text = (key: string) => (typeof row[key] === "string" && (row[key] as string).trim() ? (row[key] as string) : null)
  return {
    enabled,
    headerStyle: style === "solid" || style === "light" ? style : "gradient",
    headerColor: text("header_color"),
    accentColor: text("accent_color"),
    eyebrow: text("eyebrow"),
    footerText: text("footer_text"),
    showLogo: flag("show_logo", DEFAULT_TICKET_SETTINGS.showLogo),
    showPrice: flag("show_price", DEFAULT_TICKET_SETTINGS.showPrice),
    showReference: flag("show_reference", DEFAULT_TICKET_SETTINGS.showReference),
    showPhone: flag("show_phone", DEFAULT_TICKET_SETTINGS.showPhone),
    showAddress: flag("show_address", DEFAULT_TICKET_SETTINGS.showAddress),
  }
}

export function ticketSettingsToRow(s: EventTicketSettings) {
  return {
    enabled: s.enabled,
    header_style: s.headerStyle,
    header_color: s.headerColor,
    accent_color: s.accentColor,
    eyebrow: s.eyebrow?.trim() || null,
    footer_text: s.footerText?.trim() || null,
    show_logo: s.showLogo,
    show_price: s.showPrice,
    show_reference: s.showReference,
    show_phone: s.showPhone,
    show_address: s.showAddress,
  }
}

export function validateTicketSettings(s: EventTicketSettings): string | null {
  if (!["gradient", "solid", "light"].includes(s.headerStyle)) return "Choose a valid header style."
  if (s.headerColor && !HEX.test(s.headerColor)) return "Header colour must be a hex colour like #1F2937."
  if (s.accentColor && !HEX.test(s.accentColor)) return "Accent colour must be a hex colour like #F59E0B."
  if ((s.eyebrow ?? "").trim().length > MAX_EYEBROW) return `Ticket label must be ${MAX_EYEBROW} characters or fewer.`
  if ((s.footerText ?? "").trim().length > MAX_FOOTER) return `Footer text must be ${MAX_FOOTER} characters or fewer.`
  return null
}

// ----------------------------------------------------------------------------
// Loaders (service-role client, always filtered by tenant). Never throw: a read problem falls back
// to the defaults, which are the behaviour before this feature existed.
// ----------------------------------------------------------------------------

export async function loadEventSalesRules(supabase: SupabaseClient, tenantId: string): Promise<EventSalesRules> {
  try {
    const { data } = await supabase.from("tenant_event_settings").select("*").eq("tenant_id", tenantId).maybeSingle()
    return salesRulesFromRow(data as Row | null)
  } catch {
    return DEFAULT_SALES_RULES
  }
}

/** Whether the shop sends a ticket image at all. Default true (also when no row exists). */
export async function loadEventTicketImageEnabled(supabase: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from("tenant_event_ticket_settings").select("enabled").eq("tenant_id", tenantId).maybeSingle()
    return (data as { enabled?: boolean } | null)?.enabled ?? true
  } catch {
    return true
  }
}
