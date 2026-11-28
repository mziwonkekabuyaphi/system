// lib/services/shared/locations.ts
/**
 * Tenant locations (branches) — the ONE place the rest of the code asks
 * "which location?" questions.
 *
 * MULTI-LOCATION, PHASE 2 (plumbing). Phase 1 added tenant_locations,
 * staff_locations, service_locations and a nullable location_id on bookings,
 * queue_entries and booking_waitlist. Every tenant has exactly one default
 * location, and a BEFORE INSERT trigger (fill_default_location) puts any row
 * that arrives without a location into the default one.
 *
 * THE RULES THIS CODEBASE FOLLOWS (so a single-location shop sees no change):
 *   - A function that takes an OPTIONAL `locationId` treats "omitted" as
 *     "the whole tenant" for READS (exactly what it did before locations
 *     existed) and lets the database trigger pick the default for WRITES.
 *   - Only when a `locationId` is passed does anything get narrowed to that
 *     location.
 *   - Every query here is scoped by tenant_id first: the service-role client
 *     bypasses RLS, so a location id from a caller is never trusted on its own.
 *
 * Pure helpers (orderLocations, pickLocation, filterByLocationRows,
 * isValidTimeZone) take plain data so they can be unit tested without a
 * database; see locations.test.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** Thrown when a caller passes a location that does not exist for this tenant,
 *  is switched off, or has been archived. */
export const LOCATION_NOT_AVAILABLE = "LOCATION_NOT_AVAILABLE"

export interface TenantLocation {
  id: string
  tenantId: string
  name: string
  /** Unique per tenant; used in kiosk/display URLs (?loc=<slug>). */
  slug: string
  address: string | null
  phone: string | null
  /** IANA timezone override. null = use tenant_settings.timezone. */
  timezone: string | null
  isDefault: boolean
  isActive: boolean
  archivedAt: string | null
  sortOrder: number
}

interface LocationRow {
  id: string
  tenant_id: string
  name: string
  slug: string
  address: string | null
  phone: string | null
  timezone: string | null
  is_default: boolean
  is_active: boolean
  archived_at: string | null
  sort_order: number | null
}

const LOCATION_COLUMNS = "id, tenant_id, name, slug, address, phone, timezone, is_default, is_active, archived_at, sort_order"

function mapRow(row: LocationRow): TenantLocation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    phone: row.phone,
    timezone: row.timezone?.trim() || null,
    isDefault: row.is_default,
    isActive: row.is_active,
    archivedAt: row.archived_at,
    sortOrder: row.sort_order ?? 0,
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

/** A location customers and staff can use right now. */
export function isUsable(location: TenantLocation): boolean {
  return location.isActive && location.archivedAt === null
}

/** Default location first, then by sort_order, then by name. Does not mutate. */
export function orderLocations(list: TenantLocation[]): TenantLocation[] {
  return [...list].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.name.localeCompare(b.name)
  })
}

/**
 * Picks a usable location from a tenant's list.
 *   - no `idOrSlug`  -> the default location (or, if somehow none is usable, the first usable one)
 *   - an id or slug  -> that location, only if it is usable; otherwise null
 * Slugs compare case-insensitively. Never returns an inactive or archived location.
 */
export function pickLocation(list: TenantLocation[], idOrSlug?: string | null): TenantLocation | null {
  const usable = orderLocations(list.filter(isUsable))
  const wanted = idOrSlug?.trim()
  if (!wanted) return usable.find((l) => l.isDefault) ?? usable[0] ?? null
  const lower = wanted.toLowerCase()
  return usable.find((l) => l.id === wanted || l.slug.toLowerCase() === lower) ?? null
}

/** What a customer-facing screen (kiosk, TV display) should show for a requested location. */
export type ScreenLocation =
  | { kind: "all" } // single-location shop with no location asked for: no narrowing, exactly as before
  | { kind: "location"; location: TenantLocation }
  | { kind: "unknown" } // a location was asked for but is not a usable location of this tenant

/**
 * Decides which location a kiosk or TV screen is for.
 *   - `?loc=` given            -> that location, or "unknown" if it is not usable (the screen should refuse, not guess)
 *   - none, one location       -> "all": nothing is narrowed, identical to before locations existed
 *   - none, several locations  -> the default location (a screen must never mix two branches' customers)
 */
export function chooseScreenLocation(list: TenantLocation[], requested?: string | null): ScreenLocation {
  const wanted = requested?.trim()
  if (wanted) {
    const picked = pickLocation(list, wanted)
    return picked ? { kind: "location", location: picked } : { kind: "unknown" }
  }
  if (list.filter(isUsable).length > 1) {
    const fallback = pickLocation(list)
    return fallback ? { kind: "location", location: fallback } : { kind: "unknown" }
  }
  return { kind: "all" }
}

/** True for a string Intl accepts as an IANA time zone, e.g. "Africa/Johannesburg". */
export function isValidTimeZone(value: string | null | undefined): value is string {
  if (!value || !value.trim()) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() })
    return true
  } catch {
    return false
  }
}

/**
 * "Offered at every location unless restricted" — the service_locations rule.
 * A service with NO rows is offered everywhere (so every existing service keeps
 * working). A service with rows is offered only at the locations listed.
 */
export function filterByLocationRows<T extends { id: string }>(
  items: T[],
  rows: Array<{ service_id: string; location_id: string }>,
  locationId: string,
): T[] {
  const restricted = new Set(rows.map((r) => r.service_id))
  const allowedHere = new Set(rows.filter((r) => r.location_id === locationId).map((r) => r.service_id))
  return items.filter((item) => !restricted.has(item.id) || allowedHere.has(item.id))
}

// ============================================================================
// Database reads (all scoped by tenant_id)
// ============================================================================

/** All of a tenant's locations, default first. Inactive/archived ones only when asked for. */
export async function getTenantLocations(
  supabase: SupabaseClient,
  tenantId: string,
  options: { includeInactive?: boolean } = {},
): Promise<TenantLocation[]> {
  const { data, error } = await supabase.from("tenant_locations").select(LOCATION_COLUMNS).eq("tenant_id", tenantId)
  if (error) throw new Error(`Failed to load locations: ${error.message}`)
  const all = ((data ?? []) as LocationRow[]).map(mapRow)
  return orderLocations(options.includeInactive ? all : all.filter(isUsable))
}

/** The tenant's default location. null only if Phase 1 has not run for this tenant. */
export async function getDefaultLocation(supabase: SupabaseClient, tenantId: string): Promise<TenantLocation | null> {
  const { data, error } = await supabase
    .from("tenant_locations")
    .select(LOCATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("is_default", true)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the default location: ${error.message}`)
  return data ? mapRow(data as LocationRow) : null
}

/** Resolves a location id or slug (or, with none given, the default) to a usable location, or null. */
export async function resolveLocation(
  supabase: SupabaseClient,
  tenantId: string,
  idOrSlug?: string | null,
): Promise<TenantLocation | null> {
  return pickLocation(await getTenantLocations(supabase, tenantId), idOrSlug)
}

/** DB wrapper for chooseScreenLocation: one query for the tenant's locations. */
export async function resolveScreenLocation(
  supabase: SupabaseClient,
  tenantId: string,
  requested?: string | null,
): Promise<ScreenLocation> {
  return chooseScreenLocation(await getTenantLocations(supabase, tenantId, { includeInactive: true }), requested)
}

/** How many usable locations the tenant has. 1 means a single-location shop. */
export async function countActiveLocations(supabase: SupabaseClient, tenantId: string): Promise<number> {
  const { count, error } = await supabase
    .from("tenant_locations")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("archived_at", null)
  if (error) throw new Error(`Failed to count locations: ${error.message}`)
  return count ?? 0
}

/**
 * Throws LOCATION_NOT_AVAILABLE unless `locationId` is a usable location of THIS
 * tenant. Call it before writing a row that carries a caller-supplied location.
 */
export async function assertLocationUsable(supabase: SupabaseClient, tenantId: string, locationId: string): Promise<void> {
  const { data, error } = await supabase
    .from("tenant_locations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", locationId)
    .eq("is_active", true)
    .is("archived_at", null)
    .maybeSingle()
  if (error) throw new Error(`Failed to check the location: ${error.message}`)
  if (!data) throw new Error(LOCATION_NOT_AVAILABLE)
}

/** The location's own time zone, or null to use the tenant's. An invalid stored value counts as "not set". */
export async function getLocationTimezone(
  supabase: SupabaseClient,
  tenantId: string,
  locationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("tenant_locations")
    .select("timezone")
    .eq("tenant_id", tenantId)
    .eq("id", locationId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the location timezone: ${error.message}`)
  const value = (data as { timezone: string | null } | null)?.timezone
  return isValidTimeZone(value) ? value.trim() : null
}

/** Ids of the staff members assigned to a location (staff_locations). Active or not; callers filter further. */
export async function getStaffIdsForLocation(supabase: SupabaseClient, tenantId: string, locationId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("staff_locations")
    .select("staff_id")
    .eq("tenant_id", tenantId)
    .eq("location_id", locationId)
  if (error) throw new Error(`Failed to load the location's staff: ${error.message}`)
  return ((data ?? []) as Array<{ staff_id: string }>).map((r) => r.staff_id)
}

/** service_locations rows for the tenant (small table: one row per service-location restriction). */
export async function getServiceLocationRows(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<Array<{ service_id: string; location_id: string }>> {
  const { data, error } = await supabase.from("service_locations").select("service_id, location_id").eq("tenant_id", tenantId)
  if (error) throw new Error(`Failed to load service locations: ${error.message}`)
  return (data ?? []) as Array<{ service_id: string; location_id: string }>
}
