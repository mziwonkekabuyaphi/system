// lib/services/shisha-shared.ts
/**
 * Shared pieces for the multi-tenant Shisha WhatsApp flow.
 *
 * WHY A THIRD FILE: in the single-business version, shisha.ts and
 * shisha-booking.ts imported each other (a deliberate, documented circular
 * import). Everything both files need now lives HERE, so the dependency is
 * one-way:   shisha.ts -> shisha-booking.ts -> shisha-shared.ts
 *
 * TENANT SAFETY: getSupabaseServerClient() is the service-role client, which
 * BYPASSES RLS. Every query below therefore filters by tenant_id explicitly,
 * and every insert sets it. A forgotten filter is a cross-tenant data leak
 * (the same phone number can be a customer at two different shops), so new
 * queries added to the shisha flow must follow the same rule.
 *
 * Tables (public schema, all carry tenant_id): shisha_locations,
 * shisha_products, shisha_devices, shisha_sessions, shisha_requests,
 * shisha_settings, tenant_customers.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizePhoneNumber } from "@/lib/utils/phone"
import * as messages from "@/lib/services/messages/shisha"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

// Local logger so this module has no dependency on a utils/logger path.
export const logger = {
  info: (msg: string, meta?: unknown) => console.log(msg, meta ?? ""),
  error: (msg: string, meta?: unknown) => console.error(msg, meta ?? ""),
}

// ============================================================================
// STATE NAMES (all start with "shisha_" — action-router relies on that prefix)
// ============================================================================

export const SHISHA_STATE_MENU = "shisha_menu"
export const SHISHA_STATE_AWAITING_LOCATION = "shisha_awaiting_location"
export const SHISHA_STATE_AWAITING_FLAVOUR = "shisha_awaiting_flavour"
export const SHISHA_STATE_AWAITING_SESSION_CONFIRMATION = "shisha_awaiting_session_confirmation"
export const SHISHA_STATE_AWAITING_ISSUE_SELECTION = "shisha_awaiting_issue_selection"
export const SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION = "shisha_awaiting_issue_description"

export type ShishaStateName =
  | typeof SHISHA_STATE_MENU
  | typeof SHISHA_STATE_AWAITING_LOCATION
  | typeof SHISHA_STATE_AWAITING_FLAVOUR
  | typeof SHISHA_STATE_AWAITING_SESSION_CONFIRMATION
  | typeof SHISHA_STATE_AWAITING_ISSUE_SELECTION
  | typeof SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION

export const SHISHA_STATE_NAMES: ReadonlySet<string> = new Set([
  SHISHA_STATE_MENU,
  SHISHA_STATE_AWAITING_LOCATION,
  SHISHA_STATE_AWAITING_FLAVOUR,
  SHISHA_STATE_AWAITING_SESSION_CONFIRMATION,
  SHISHA_STATE_AWAITING_ISSUE_SELECTION,
  SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION,
])

// ============================================================================
// TYPES
// ============================================================================

export interface NamedRow {
  name: string
}

export interface ActiveShishaSession {
  id: string
  deviceCode: string | null
  locationName: string | null
  flavourName: string | null
  /** The flavour's current session price (shisha_products.price). */
  flavourPrice: number | null
  /** The flavour's current refill price (shisha_products.refill_price): what a refill
   *  request quotes. Optional because older saved conversation states don't have it. */
  flavourRefillPrice?: number | null
  amount: number
  status: string
  remainingTimeSeconds: number
  refillCount: number
}

export interface ShishaStateData {
  [key: string]: unknown
  pendingLocations?: NamedRow[]
  pendingFlavours?: NamedRow[]
  /** string = chosen station; null = this tenant doesn't use stations; undefined = missing (corrupt state). */
  selectedLocation?: string | null
  selectedFlavour?: string
  /** Snapshot of the active session taken when a service request was chosen from the menu. */
  activeSession?: ActiveShishaSession
}

export function readStateData(state: ConversationState): ShishaStateData {
  return (state.data ?? {}) as ShishaStateData
}

export function actionResult(
  reply: string,
  nextState: { state: ShishaStateName; data?: ShishaStateData } | null = null,
  buttons: string[] = [],
): ActionResult {
  return { reply, buttons, nextState }
}

// ============================================================================
// CUSTOMER IDENTITY — tenant_customers (replaces profiles/wallets)
// ============================================================================

export interface ShishaCustomerRef {
  /** tenant_customers.id, or null if no row was found (we still work by phone). */
  customerId: string | null
  /** Normalised with the same rule tenant-customer.ts uses. */
  phone: string
}

export async function resolveCustomerRef(
  db: SupabaseClient,
  tenantId: string,
  rawPhone: string,
): Promise<ShishaCustomerRef> {
  const phone = normalizePhoneNumber(rawPhone)
  const { data, error } = await db
    .from("tenant_customers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .maybeSingle<{ id: string }>()

  if (error) {
    logger.error("[shisha] failed to resolve tenant customer", { tenantId, error: error.message })
  }
  return { customerId: data?.id ?? null, phone }
}

/**
 * PostgREST .or() filter matching this customer by id OR phone. Staff-created
 * sessions may carry only one of the two, so matching on either is safer than
 * matching on phone alone. Values are sanitised before interpolation.
 */
export function customerOrFilter(who: ShishaCustomerRef): string {
  const phone = who.phone.replace(/[^0-9+]/g, "")
  const parts = [`customer_phone.eq.${phone}`]
  if (who.customerId && /^[0-9a-f-]{36}$/i.test(who.customerId)) {
    parts.push(`customer_id.eq.${who.customerId}`)
  }
  return parts.join(",")
}

// ============================================================================
// SETTINGS + CATALOGUE (per tenant)
// ============================================================================

/**
 * shisha_settings.require_station. NOTE: this is read as "the customer must
 * pick a station (location) when starting a session". If your admin UI means
 * something different by it, adjust here — it's the only place it's read.
 * No settings row => true (the original behaviour).
 */
export async function getRequireStation(db: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data, error } = await db
    .from("shisha_settings")
    .select("require_station")
    .eq("tenant_id", tenantId)
    .maybeSingle<{ require_station: boolean }>()
  if (error) {
    logger.error("[shisha] failed to read shisha_settings", { tenantId, error: error.message })
    return true
  }
  return data?.require_station ?? true
}

export async function getActiveLocations(db: SupabaseClient, tenantId: string): Promise<NamedRow[]> {
  const { data, error } = await db
    .from("shisha_locations")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("archived_at", null)
    .order("name")
  if (error) {
    logger.error("[shisha] failed to fetch locations", { tenantId, error: error.message })
    return []
  }
  return data ?? []
}

export async function getAvailableFlavours(db: SupabaseClient, tenantId: string): Promise<NamedRow[]> {
  const { data, error } = await db
    .from("shisha_products")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("is_available", true)
    .is("archived_at", null)
    .order("name")
  if (error) {
    logger.error("[shisha] failed to fetch flavours", { tenantId, error: error.message })
    return []
  }
  return data ?? []
}

/** The flavour's live price, or null if it can't be read (callers must handle null — no silent default). */
export async function getFlavourPrice(db: SupabaseClient, tenantId: string, flavourName: string): Promise<number | null> {
  const { data, error } = await db
    .from("shisha_products")
    .select("price")
    .eq("tenant_id", tenantId)
    .eq("name", flavourName)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle<{ price: number }>()
  if (error || !data) {
    logger.error("[shisha] failed to fetch flavour price", { tenantId, flavourName, error: error?.message })
    return null
  }
  return Number(data.price)
}

// ============================================================================
// REQUESTS (shisha_requests)
// ============================================================================

export interface CreateShishaRequestParams {
  type: "order_session" | "maintenance" | "end_session" | "issue_report"
  tenantId: string
  who: ShishaCustomerRef
  sessionId?: string | null
  locationName?: string | null
  flavourName?: string | null
  deviceCode?: string | null
  amount?: number | null
  issueKey?: string | null
  issueLabel?: string | null
}

/**
 * One-request-at-a-time gate: true if this customer already has ANY pending
 * shisha_requests row in THIS tenant. Fails OPEN on a DB error (staff triage
 * is the backstop), same tradeoff as the single-business version.
 */
export async function hasPendingRequest(db: SupabaseClient, tenantId: string, who: ShishaCustomerRef): Promise<boolean> {
  const { data, error } = await db
    .from("shisha_requests")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .or(customerOrFilter(who))
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (error) {
    logger.error("[shisha] hasPendingRequest check failed", { tenantId, error: error.message })
    return false
  }
  return data !== null
}

export async function blockIfPendingRequest(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
): Promise<ActionResult | null> {
  if (await hasPendingRequest(db, tenantId, who)) {
    return actionResult(messages.PENDING_REQUEST_EXISTS, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
  return null
}

export async function createShishaRequest(db: SupabaseClient, params: CreateShishaRequestParams): Promise<void> {
  const { error } = await db.from("shisha_requests").insert({
    tenant_id: params.tenantId,
    request_type: params.type,
    session_id: params.sessionId ?? null,
    customer_id: params.who.customerId,
    customer_phone: params.who.phone,
    location_name: params.locationName ?? null,
    flavour_name: params.flavourName ?? null,
    device_code: params.deviceCode ?? null,
    amount: params.amount ?? null,
    request_data: {
      source: "whatsapp",
      issueKey: params.issueKey ?? null,
      issueLabel: params.issueLabel ?? null,
    },
    status: "pending",
  })

  if (error) {
    throw new Error(`Failed to create shisha request: ${error.message}`)
  }
}

/** Extracts a bare 1-2 digit number from free text, e.g. "2" or "number 2". */
export function extractListSelection(rawMessage: string): number | null {
  const trimmed = rawMessage.trim()
  const bareMatch = trimmed.match(/^\d{1,2}$/)
  if (bareMatch) return parseInt(bareMatch[0], 10)
  const wordedMatch = trimmed.match(/\b(\d{1,2})\b/)
  if (wordedMatch) return parseInt(wordedMatch[1], 10)
  return null
}
