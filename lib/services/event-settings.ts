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
  /**
   * Off = the separate plain QR code message is not sent (the ticket image still carries its own QR).
   * At least one of `enabled` / `sendQr` must be on, see validateTicketSettings().
   */
  sendQr: boolean
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

/** VVIP tables on WhatsApp (stored on tenant_event_settings, next to the sales rules). */
export interface VvipTableSettings {
  /** false = the customer is given the next free table (the default). true = they see the free tables and pick one. */
  customersPickTable: boolean
  /** The tenant's own word for one table, e.g. "Booth". null = "Table". */
  tableName: string | null
  /** ...and for several, e.g. "Booths". null = "Tables". */
  tablesName: string | null
}

export const DEFAULT_VVIP_TABLE_SETTINGS: VvipTableSettings = { customersPickTable: false, tableName: null, tablesName: null }

export const MAX_TABLE_NAME = 20

/** The words customers see. Always filled in. */
export interface TableNames {
  singular: string
  plural: string
}
export const DEFAULT_TABLE_NAMES: TableNames = { singular: "Table", plural: "Tables" }

export function tableNamesOf(s: Pick<VvipTableSettings, "tableName" | "tablesName"> | null | undefined): TableNames {
  const one = s?.tableName?.trim() || ""
  const many = s?.tablesName?.trim() || ""
  return {
    singular: one || (many ? many.replace(/s$/i, "") || DEFAULT_TABLE_NAMES.singular : DEFAULT_TABLE_NAMES.singular),
    plural: many || (one ? `${one}s` : DEFAULT_TABLE_NAMES.plural),
  }
}

/**
 * What a customer is sent after booking a VVIP table (tenant_vvip_ticket_settings). The look (colours, logo,
 * header style, what to show) follows Event settings > Ticket; only these switches and two texts live here.
 */
export interface VvipPassSettings {
  /** The branded table pass image. */
  enabled: boolean
  /** The plain QR code message. At least one of `enabled` / `sendQr` must be on. */
  sendQr: boolean
  /** null = "<Table> Confirmed" */
  eyebrow: string | null
  /** null = "Show this QR code at the venue" */
  footerText: string | null
  headerStyle: EventTicketHeaderStyle
  /** null = the tenant's brand primary colour */
  headerColor: string | null
  /** null = the tenant's brand secondary colour */
  accentColor: string | null
  showLogo: boolean
  showPrice: boolean
  /** The bar tab that comes with the table. */
  showTab: boolean
  showReference: boolean
  showPhone: boolean
  showAddress: boolean
}

export const DEFAULT_VVIP_PASS_SETTINGS: VvipPassSettings = {
  enabled: true,
  sendQr: true,
  eyebrow: null,
  footerText: null,
  headerStyle: "gradient",
  headerColor: null,
  accentColor: null,
  showLogo: true,
  showPrice: true,
  showTab: true,
  showReference: true,
  showPhone: false,
  showAddress: true,
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
  sendQr: true,
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

export function vvipTableSettingsFromRow(row: Row | null | undefined): VvipTableSettings {
  const name = (k: string) => (typeof row?.[k] === "string" && (row[k] as string).trim() ? (row[k] as string).trim() : null)
  return { customersPickTable: row?.customers_pick_table === true, tableName: name("table_name"), tablesName: name("tables_name") }
}

export function vvipTableSettingsToRow(s: VvipTableSettings) {
  return {
    customers_pick_table: s.customersPickTable === true,
    table_name: s.tableName?.trim() || null,
    tables_name: s.tablesName?.trim() || null,
  }
}

export function validateVvipTableSettings(s: VvipTableSettings): string | null {
  if (typeof s.customersPickTable !== "boolean") return "Invalid setting."
  if ((s.tableName ?? "").trim().length > MAX_TABLE_NAME || (s.tablesName ?? "").trim().length > MAX_TABLE_NAME) {
    return `Names must be ${MAX_TABLE_NAME} characters or fewer.`
  }
  return null
}

export function vvipPassSettingsFromRow(row: Row | null | undefined): VvipPassSettings {
  if (!row) return DEFAULT_VVIP_PASS_SETTINGS
  const d = DEFAULT_VVIP_PASS_SETTINGS
  const text = (k: string) => (typeof row[k] === "string" && (row[k] as string).trim() ? (row[k] as string).trim() : null)
  const flag = (k: string, fallback: boolean) => (typeof row[k] === "boolean" ? (row[k] as boolean) : fallback)
  const style = row.header_style
  return {
    enabled: flag("enabled", d.enabled),
    sendQr: flag("send_qr", d.sendQr),
    eyebrow: text("eyebrow"),
    footerText: text("footer_text"),
    headerStyle: style === "solid" || style === "light" ? style : "gradient",
    headerColor: text("header_color"),
    accentColor: text("accent_color"),
    showLogo: flag("show_logo", d.showLogo),
    showPrice: flag("show_price", d.showPrice),
    showTab: flag("show_tab", d.showTab),
    showReference: flag("show_reference", d.showReference),
    showPhone: flag("show_phone", d.showPhone),
    showAddress: flag("show_address", d.showAddress),
  }
}

export function vvipPassSettingsToRow(s: VvipPassSettings) {
  return {
    enabled: s.enabled,
    send_qr: s.sendQr,
    eyebrow: s.eyebrow?.trim() || null,
    footer_text: s.footerText?.trim() || null,
    header_style: s.headerStyle,
    header_color: s.headerColor,
    accent_color: s.accentColor,
    show_logo: s.showLogo,
    show_price: s.showPrice,
    show_tab: s.showTab,
    show_reference: s.showReference,
    show_phone: s.showPhone,
    show_address: s.showAddress,
  }
}

export function validateVvipPassSettings(s: VvipPassSettings): string | null {
  if (!s.enabled && !s.sendQr) return "Keep at least one on: the pass image or the QR code. Otherwise customers would get nothing to show at the venue."
  if (!["gradient", "solid", "light"].includes(s.headerStyle)) return "Choose a valid header style."
  if (s.headerColor && !HEX.test(s.headerColor)) return "Header colour must be a hex colour like #1F2937."
  if (s.accentColor && !HEX.test(s.accentColor)) return "Accent colour must be a hex colour like #F59E0B."
  if ((s.eyebrow ?? "").trim().length > MAX_EYEBROW) return `Pass label must be ${MAX_EYEBROW} characters or fewer.`
  if ((s.footerText ?? "").trim().length > MAX_FOOTER) return `Footer text must be ${MAX_FOOTER} characters or fewer.`
  return null
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
export function ticketSettingsFromRow(row: Row | null | undefined, enabled = true, sendQr = true): EventTicketSettings {
  if (!row) return { ...DEFAULT_TICKET_SETTINGS, enabled, sendQr }
  const style = row.header_style
  const flag = (key: string, fallback: boolean) => (typeof row[key] === "boolean" ? (row[key] as boolean) : fallback)
  const text = (key: string) => (typeof row[key] === "string" && (row[key] as string).trim() ? (row[key] as string) : null)
  return {
    enabled,
    sendQr,
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
    send_qr: s.sendQr,
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
  if (!s.enabled && !s.sendQr) return "Keep at least one on: the ticket image or the QR code. Otherwise customers would get no ticket to scan."
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

/** How a customer gets their VVIP table. Off (and on any read problem) = the next free table. */
export async function loadVvipTableSettings(supabase: SupabaseClient, tenantId: string): Promise<VvipTableSettings> {
  try {
    // select("*") so a database without the customers_pick_table column yet still works (it reads as off).
    const { data } = await supabase.from("tenant_event_settings").select("*").eq("tenant_id", tenantId).maybeSingle()
    return vvipTableSettingsFromRow(data as Row | null)
  } catch {
    return DEFAULT_VVIP_TABLE_SETTINGS
  }
}

/** The tenant's words for a table. Never throws; defaults to Table / Tables. */
export async function loadTableNames(supabase: SupabaseClient, tenantId: string): Promise<TableNames> {
  return tableNamesOf(await loadVvipTableSettings(supabase, tenantId))
}

/** What a table buyer is sent. Defaults to both (also when no row exists, the table is missing or the read fails). */
export async function loadVvipPassSettings(supabase: SupabaseClient, tenantId: string): Promise<VvipPassSettings> {
  try {
    const { data, error } = await supabase.from("tenant_vvip_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle()
    if (error) return DEFAULT_VVIP_PASS_SETTINGS
    const v = vvipPassSettingsFromRow(data as Row | null)
    return { ...v, sendQr: v.sendQr || !v.enabled }
  } catch {
    return DEFAULT_VVIP_PASS_SETTINGS
  }
}

export interface EventTicketDelivery {
  /** Send the branded ticket image. */
  image: boolean
  /** Send the plain QR code message(s). Always true when the image is off, so a customer always gets something to scan. */
  qr: boolean
}

/** What a customer is sent after buying. Defaults to both (also when no row exists or the read fails). */
export async function loadEventTicketDelivery(supabase: SupabaseClient, tenantId: string): Promise<EventTicketDelivery> {
  try {
    // select("*") so a database that hasn't had the send_qr migration yet still works (it reads as on).
    const { data } = await supabase.from("tenant_event_ticket_settings").select("*").eq("tenant_id", tenantId).maybeSingle()
    const row = data as { enabled?: boolean; send_qr?: boolean } | null
    const image = row?.enabled ?? true
    const qr = row?.send_qr ?? true
    return { image, qr: qr || !image }
  } catch {
    return { image: true, qr: true }
  }
}

/** Whether the shop sends a ticket image at all. Default true (also when no row exists). */
export async function loadEventTicketImageEnabled(supabase: SupabaseClient, tenantId: string): Promise<boolean> {
  return (await loadEventTicketDelivery(supabase, tenantId)).image
}
