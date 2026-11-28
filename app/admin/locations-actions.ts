// app/admin/locations-actions.ts
"use server"

/**
 * Settings > Locations: lets a shop owner add and manage their own branches
 * (tenant_locations) without anyone touching the database.
 *
 * Same posture as settings-actions.ts: the service-role client bypasses RLS, so
 * every query below is filtered by tenant_id and a caller-supplied location id
 * is never trusted on its own (requireLocation re-checks it belongs to THIS
 * tenant). Gated on the settings.manage permission, which is exactly what the
 * tenant_locations RLS write policy requires.
 *
 * PLAN GATE: creating or restoring a branch needs the 'locations' plan module
 * (tenantHasModule). The same rule is enforced by a database trigger on
 * tenant_locations (enforce_locations_entitlement), so a forged request cannot
 * bypass it either. Viewing existing branches is always allowed, so a shop that
 * downgrades keeps seeing (and can archive) what it already has.
 *
 * Every action returns the refreshed list, so the panel never shows stale data.
 *
 * RULES KEPT HERE (the database enforces the first two as well):
 *   - exactly one default location; it cannot be archived (make another default first)
 *   - a branch is archived, never deleted, so booking and queue history stays intact
 *   - a branch with people still waiting or future bookings cannot be archived
 *   - the slug is fixed at creation: it is printed on kiosk/TV links and QR codes
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { tenantHasModule, MODULE_KEYS } from "@/lib/services/plans"
import { isValidTimeZone } from "@/lib/services/shared/locations"
import type { AdminBusinessHours, AdminLocation, AdminLocationStaff } from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

export interface LocationsData {
  /** The plan includes multiple locations (can add / restore). */
  allowed: boolean
  locations: AdminLocation[]
  /** Staff to pick from (active first). */
  staff: AdminLocationStaff[]
  /** The shop's own opening hours: where a branch's hours start from when it first gets its own. */
  shopHours: AdminBusinessHours
}

export type LocationsResult = { success: true; data: LocationsData } | { success: false; error: string }

const MAX_LOCATIONS = 25
const MAX_NAME = 80
const MAX_ADDRESS = 200
const MAX_PHONE = 40
const UPGRADE_MESSAGE = "Multiple locations are included in the Business plan. Upgrade to add another branch."

async function locationsContext(): Promise<{ supabase: ServerClient; tenantId: string }> {
  const check = await requireTenantPermission("settings.manage")
  if (!check.ok) throw new Error(check.error)
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId: check.member.tenantId }
}

async function planAllows(supabase: ServerClient, tenantId: string): Promise<boolean> {
  try {
    return await tenantHasModule(supabase, tenantId, MODULE_KEYS.locations)
  } catch {
    return false // fail closed
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadAll(supabase: ServerClient, tenantId: string): Promise<LocationsData> {
  const [allowed, locationsRes, linksRes, hoursRes, staffRes, shopHoursRes] = await Promise.all([
    planAllows(supabase, tenantId),
    supabase
      .from("tenant_locations")
      .select("id, name, slug, address, phone, timezone, is_default, is_active, archived_at, sort_order")
      .eq("tenant_id", tenantId),
    supabase.from("staff_locations").select("staff_id, location_id").eq("tenant_id", tenantId),
    supabase
      .from("location_business_hours")
      .select("location_id, day_of_week, is_closed, open_time, close_time")
      .eq("tenant_id", tenantId),
    supabase.from("staff").select("id, name, active").eq("tenant_id", tenantId).order("name", { ascending: true }),
    supabase
      .from("business_hours")
      .select("day_of_week, is_closed, open_time, close_time")
      .eq("tenant_id", tenantId)
      .order("day_of_week", { ascending: true }),
  ])

  if (locationsRes.error) throw new Error(`Failed to load locations: ${locationsRes.error.message}`)
  if (linksRes.error) throw new Error(`Failed to load branch staff: ${linksRes.error.message}`)
  if (hoursRes.error) throw new Error(`Failed to load branch hours: ${hoursRes.error.message}`)
  if (staffRes.error) throw new Error(`Failed to load staff: ${staffRes.error.message}`)
  if (shopHoursRes.error) throw new Error(`Failed to load opening hours: ${shopHoursRes.error.message}`)

  const staffByLocation = new Map<string, string[]>()
  for (const l of (linksRes.data ?? []) as Array<{ staff_id: string; location_id: string }>) {
    staffByLocation.set(l.location_id, [...(staffByLocation.get(l.location_id) ?? []), l.staff_id])
  }

  type HourRow = { location_id: string; day_of_week: number; is_closed: boolean; open_time: string | null; close_time: string | null }
  const hoursByLocation = new Map<string, AdminBusinessHours>()
  for (const h of (hoursRes.data ?? []) as HourRow[]) {
    const list = hoursByLocation.get(h.location_id) ?? []
    list.push({
      dayOfWeek: h.day_of_week,
      isClosed: h.is_closed,
      openTime: h.open_time ? h.open_time.slice(0, 5) : null,
      closeTime: h.close_time ? h.close_time.slice(0, 5) : null,
    })
    hoursByLocation.set(h.location_id, list.sort((a, b) => a.dayOfWeek - b.dayOfWeek))
  }

  type LocRow = {
    id: string
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
  const locations: AdminLocation[] = ((locationsRes.data ?? []) as LocRow[])
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1
      const aGone = !a.is_active || a.archived_at !== null
      const bGone = !b.is_active || b.archived_at !== null
      if (aGone !== bGone) return aGone ? 1 : -1
      if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) return (a.sort_order ?? 0) - (b.sort_order ?? 0)
      return a.name.localeCompare(b.name)
    })
    .map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      address: r.address,
      phone: r.phone,
      timezone: r.timezone?.trim() || null,
      isDefault: r.is_default,
      archived: !r.is_active || r.archived_at !== null,
      staffIds: staffByLocation.get(r.id) ?? [],
      hours: hoursByLocation.get(r.id) ?? null,
    }))

  const staff: AdminLocationStaff[] = ((staffRes.data ?? []) as Array<{ id: string; name: string; active: boolean }>)
    .map((s) => ({ id: s.id, name: s.name, active: s.active }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))

  const shopHours: AdminBusinessHours = ((shopHoursRes.data ?? []) as Array<{ day_of_week: number; is_closed: boolean; open_time: string | null; close_time: string | null }>).map((h) => ({
    dayOfWeek: h.day_of_week,
    isClosed: h.is_closed,
    openTime: h.open_time ? h.open_time.slice(0, 5) : null,
    closeTime: h.close_time ? h.close_time.slice(0, 5) : null,
  }))

  return { allowed, locations, staff, shopHours }
}

async function ok(supabase: ServerClient, tenantId: string): Promise<LocationsResult> {
  revalidatePath("/admin")
  return { success: true, data: await loadAll(supabase, tenantId) }
}

function fail(err: unknown): LocationsResult {
  return { success: false, error: err instanceof Error ? err.message : "Something went wrong." }
}

export async function getLocationsData(): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    return { success: true, data: await loadAll(supabase, tenantId) }
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface LocationFields {
  name: string
  address: string | null
  phone: string | null
  timezone: string | null
}

function cleanFields(input: LocationFields): LocationFields {
  const name = (input.name ?? "").trim()
  if (name.length < 1) throw new Error("Give the location a name.")
  if (name.length > MAX_NAME) throw new Error(`The name can be at most ${MAX_NAME} characters.`)
  const address = (input.address ?? "").trim() || null
  if (address && address.length > MAX_ADDRESS) throw new Error(`The address can be at most ${MAX_ADDRESS} characters.`)
  const phone = (input.phone ?? "").trim() || null
  if (phone && phone.length > MAX_PHONE) throw new Error(`The phone number can be at most ${MAX_PHONE} characters.`)
  const timezone = (input.timezone ?? "").trim() || null
  if (timezone && !isValidTimeZone(timezone)) {
    throw new Error(`"${timezone}" isn't a valid timezone. Use a name like Africa/Johannesburg, or leave it empty to use the shop's timezone.`)
  }
  return { name, address, phone, timezone }
}

/** "Sandton City" -> "sandton-city". Matches tenant_locations.slug's CHECK (lowercase words joined by single dashes). */
function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  return base || "branch"
}

function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name)
  if (!taken.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

async function requireLocation(supabase: ServerClient, tenantId: string, locationId: string) {
  const { data, error } = await supabase
    .from("tenant_locations")
    .select("id, is_default, is_active, archived_at")
    .eq("tenant_id", tenantId)
    .eq("id", locationId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error("That location doesn't exist.")
  return data as { id: string; is_default: boolean; is_active: boolean; archived_at: string | null }
}

/** Replace a branch's staff with `wanted`, but only among ACTIVE staff: an inactive person who was linked stays linked. */
async function applyStaff(supabase: ServerClient, tenantId: string, locationId: string, wanted: string[]): Promise<void> {
  const { data: staffRows, error: staffError } = await supabase.from("staff").select("id, active").eq("tenant_id", tenantId)
  if (staffError) throw new Error(staffError.message)
  const activeIds = new Set(((staffRows ?? []) as Array<{ id: string; active: boolean }>).filter((s) => s.active).map((s) => s.id))

  const { data: existingRows, error: existingError } = await supabase
    .from("staff_locations")
    .select("staff_id")
    .eq("tenant_id", tenantId)
    .eq("location_id", locationId)
  if (existingError) throw new Error(existingError.message)
  const existing = new Set(((existingRows ?? []) as Array<{ staff_id: string }>).map((r) => r.staff_id))

  const target = new Set(wanted.filter((id) => activeIds.has(id)))
  const toAdd = [...target].filter((id) => !existing.has(id))
  const toRemove = [...existing].filter((id) => activeIds.has(id) && !target.has(id))

  if (toRemove.length > 0) {
    const { error } = await supabase
      .from("staff_locations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("location_id", locationId)
      .in("staff_id", toRemove)
    if (error) throw new Error(error.message)
  }
  if (toAdd.length > 0) {
    const { error } = await supabase
      .from("staff_locations")
      .insert(toAdd.map((staff_id) => ({ staff_id, location_id: locationId, tenant_id: tenantId })))
    if (error) throw new Error(error.message)
  }
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export async function createLocation(input: LocationFields & { staffIds: string[] }): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    if (!(await planAllows(supabase, tenantId))) return { success: false, error: UPGRADE_MESSAGE }
    const fields = cleanFields(input)

    const { data: existing, error: existingError } = await supabase
      .from("tenant_locations")
      .select("slug, sort_order, is_active, archived_at")
      .eq("tenant_id", tenantId)
    if (existingError) throw new Error(existingError.message)
    const rows = (existing ?? []) as Array<{ slug: string; sort_order: number | null; is_active: boolean; archived_at: string | null }>

    if (rows.filter((r) => r.is_active && r.archived_at === null).length >= MAX_LOCATIONS) {
      return { success: false, error: `You can have up to ${MAX_LOCATIONS} active locations.` }
    }

    const slug = uniqueSlug(fields.name, new Set(rows.map((r) => r.slug)))
    const sortOrder = rows.reduce((max, r) => Math.max(max, r.sort_order ?? 0), 0) + 1

    const { data: created, error } = await supabase
      .from("tenant_locations")
      .insert({
        tenant_id: tenantId,
        name: fields.name,
        slug,
        address: fields.address,
        phone: fields.phone,
        timezone: fields.timezone,
        is_default: false,
        is_active: true,
        sort_order: sortOrder,
      })
      .select("id")
      .single()
    if (error) throw new Error(error.message)

    if (input.staffIds?.length) await applyStaff(supabase, tenantId, created.id as string, input.staffIds)

    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}

export async function updateLocation(locationId: string, input: LocationFields): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    await requireLocation(supabase, tenantId, locationId)
    const fields = cleanFields(input)

    const { error } = await supabase
      .from("tenant_locations")
      .update({ name: fields.name, address: fields.address, phone: fields.phone, timezone: fields.timezone })
      .eq("tenant_id", tenantId)
      .eq("id", locationId)
    if (error) throw new Error(error.message)

    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}

export async function setLocationStaff(locationId: string, staffIds: string[]): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    await requireLocation(supabase, tenantId, locationId)
    await applyStaff(supabase, tenantId, locationId, staffIds ?? [])
    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Default / archive / restore
// ---------------------------------------------------------------------------

export async function setDefaultLocation(locationId: string): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    const loc = await requireLocation(supabase, tenantId, locationId)
    if (!loc.is_active || loc.archived_at !== null) return { success: false, error: "Restore this location before making it the default." }
    if (loc.is_default) return await ok(supabase, tenantId)

    const { error } = await supabase.rpc("set_default_location", { p_tenant_id: tenantId, p_location_id: locationId })
    if (error) throw new Error(error.message)
    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}

export async function archiveLocation(locationId: string): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    const loc = await requireLocation(supabase, tenantId, locationId)
    if (loc.is_default) return { success: false, error: "This is your default location. Make another location the default first, then archive this one." }
    if (!loc.is_active || loc.archived_at !== null) return await ok(supabase, tenantId)

    const [waiting, upcoming] = await Promise.all([
      supabase
        .from("queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId)
        .in("status", ["waiting", "called"]),
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId)
        .in("status", ["confirmed", "awaiting_payment", "pending_approval"])
        .gte("end_time", new Date().toISOString()),
    ])
    if (waiting.error) throw new Error(waiting.error.message)
    if (upcoming.error) throw new Error(upcoming.error.message)

    const parts: string[] = []
    if ((waiting.count ?? 0) > 0) parts.push(`${waiting.count} ${waiting.count === 1 ? "person is" : "people are"} still in its queue`)
    if ((upcoming.count ?? 0) > 0) parts.push(`it has ${upcoming.count} upcoming ${upcoming.count === 1 ? "booking" : "bookings"}`)
    if (parts.length > 0) {
      return { success: false, error: `Can't archive yet: ${parts.join(" and ")}. Finish or cancel those first.` }
    }

    const { error } = await supabase
      .from("tenant_locations")
      .update({ is_active: false, archived_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", locationId)
    if (error) throw new Error(error.message)
    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}

export async function restoreLocation(locationId: string): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    if (!(await planAllows(supabase, tenantId))) return { success: false, error: UPGRADE_MESSAGE }
    await requireLocation(supabase, tenantId, locationId)

    const { count, error: countError } = await supabase
      .from("tenant_locations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .is("archived_at", null)
    if (countError) throw new Error(countError.message)
    if ((count ?? 0) >= MAX_LOCATIONS) return { success: false, error: `You can have up to ${MAX_LOCATIONS} active locations.` }

    const { error } = await supabase
      .from("tenant_locations")
      .update({ is_active: true, archived_at: null })
      .eq("tenant_id", tenantId)
      .eq("id", locationId)
    if (error) throw new Error(error.message)
    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Opening hours for ONE branch (location_business_hours)
//
// Sparse by design (see the Phase 3 migration): a branch with NO rows follows the
// shop's opening hours; a branch with rows is governed by them alone, so all seven
// days are saved together. `days = null` deletes the rows = "use the shop's hours".
// ---------------------------------------------------------------------------

export async function saveLocationHours(locationId: string, days: AdminBusinessHours | null): Promise<LocationsResult> {
  try {
    const { supabase, tenantId } = await locationsContext()
    await requireLocation(supabase, tenantId, locationId)

    if (days === null) {
      const { error } = await supabase.from("location_business_hours").delete().eq("tenant_id", tenantId).eq("location_id", locationId)
      if (error) throw new Error(error.message)
      return await ok(supabase, tenantId)
    }

    const seen = new Set<number>()
    for (const d of days) {
      if (!Number.isInteger(d.dayOfWeek) || d.dayOfWeek < 0 || d.dayOfWeek > 6 || seen.has(d.dayOfWeek)) {
        return { success: false, error: "Opening hours need exactly one entry for each day of the week." }
      }
      seen.add(d.dayOfWeek)
      if (!d.isClosed) {
        if (!d.openTime || !d.closeTime) return { success: false, error: "Enter both an open and close time for every open day." }
        if (d.openTime >= d.closeTime) return { success: false, error: "Open time must be before close time." }
      }
    }
    if (seen.size !== 7) return { success: false, error: "Opening hours need exactly one entry for each day of the week." }

    const { error } = await supabase.from("location_business_hours").upsert(
      days.map((d) => ({
        tenant_id: tenantId,
        location_id: locationId,
        day_of_week: d.dayOfWeek,
        is_closed: d.isClosed,
        open_time: d.isClosed ? null : d.openTime,
        close_time: d.isClosed ? null : d.closeTime,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "location_id,day_of_week" },
    )
    if (error) throw new Error(error.message)
    return await ok(supabase, tenantId)
  } catch (err) {
    return fail(err)
  }
}
