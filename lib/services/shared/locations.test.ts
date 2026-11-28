import { test } from "node:test"
import assert from "node:assert/strict"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  LOCATION_NOT_AVAILABLE,
  assertLocationUsable,
  chooseScreenLocation,
  countActiveLocations,
  filterByLocationRows,
  getLocationTimezone,
  getStaffIdsForLocation,
  getTenantLocations,
  isValidTimeZone,
  orderLocations,
  pickLocation,
  resolveLocation,
  type TenantLocation,
} from "./locations"
import { getBusinessHoursForDate, getTenantTimezone, hoursFromLocationRows } from "./tenant-scheduling"

// ---------------------------------------------------------------------------
// A tiny in-memory stand-in for the Supabase query builder. It supports only
// what these helpers use (select / eq / is / maybeSingle / count head) and it
// APPLIES the filters, so a test that forgets a tenant filter would see another
// tenant's rows and fail. That is the point: the service-role client bypasses
// RLS, so every query must scope by tenant itself.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>

function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      const nulls: string[] = []
      let head = false
      const matching = () =>
        (tables[table] ?? []).filter(
          (row) => eqs.every(([c, v]) => row[c] === v) && nulls.every((c) => row[c] === null || row[c] === undefined),
        )
      const builder = {
        select(_cols?: string, opts?: { head?: boolean }) {
          head = !!opts?.head
          return builder
        },
        eq(column: string, value: unknown) {
          eqs.push([column, value])
          return builder
        },
        is(column: string, _value: null) {
          nulls.push(column)
          return builder
        },
        async maybeSingle() {
          const rows = matching()
          return { data: rows[0] ?? null, error: null }
        },
        then(resolve: (value: unknown) => unknown) {
          const rows = matching()
          return resolve(head ? { data: null, count: rows.length, error: null } : { data: rows, error: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

const T1 = "tenant-1"
const T2 = "tenant-2"

function loc(partial: Partial<TenantLocation> & { id: string }): TenantLocation {
  return {
    tenantId: T1,
    name: partial.id,
    slug: partial.id,
    address: null,
    phone: null,
    timezone: null,
    isDefault: false,
    isActive: true,
    archivedAt: null,
    sortOrder: 0,
    ...partial,
  }
}

function dbRow(partial: Row & { id: string; tenant_id: string }): Row {
  return {
    name: partial.id,
    slug: partial.id,
    address: null,
    phone: null,
    timezone: null,
    is_default: false,
    is_active: true,
    archived_at: null,
    sort_order: 0,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("orderLocations puts the default first, then sort order, then name, without mutating", () => {
  const input = [
    loc({ id: "c", name: "Zeta", sortOrder: 1 }),
    loc({ id: "a", name: "Alpha", sortOrder: 1 }),
    loc({ id: "main", name: "Main", isDefault: true, sortOrder: 9 }),
    loc({ id: "b", name: "Beta", sortOrder: 0 }),
  ]
  const snapshot = input.map((l) => l.id)
  assert.deepEqual(orderLocations(input).map((l) => l.id), ["main", "b", "a", "c"])
  assert.deepEqual(input.map((l) => l.id), snapshot)
})

test("pickLocation with nothing asked for returns the default location", () => {
  const list = [loc({ id: "x" }), loc({ id: "main", isDefault: true })]
  assert.equal(pickLocation(list)?.id, "main")
  assert.equal(pickLocation(list, "")?.id, "main")
  assert.equal(pickLocation(list, "   ")?.id, "main")
  assert.equal(pickLocation(list, null)?.id, "main")
})

test("pickLocation finds by id or slug (case-insensitive) and only returns usable locations", () => {
  const list = [
    loc({ id: "id-main", slug: "main", isDefault: true }),
    loc({ id: "id-sandton", slug: "sandton" }),
    loc({ id: "id-off", slug: "closed-branch", isActive: false }),
    loc({ id: "id-old", slug: "old-branch", archivedAt: "2026-01-01T00:00:00Z" }),
  ]
  assert.equal(pickLocation(list, "id-sandton")?.slug, "sandton")
  assert.equal(pickLocation(list, "SANDTON")?.id, "id-sandton")
  assert.equal(pickLocation(list, "closed-branch"), null)
  assert.equal(pickLocation(list, "id-old"), null)
  assert.equal(pickLocation(list, "does-not-exist"), null)
})

test("pickLocation falls back to the first usable location if the default is unusable", () => {
  const list = [loc({ id: "main", isDefault: true, isActive: false }), loc({ id: "other", sortOrder: 2 })]
  assert.equal(pickLocation(list)?.id, "other")
  assert.equal(pickLocation([loc({ id: "main", isDefault: true, isActive: false })]), null)
})

test("isValidTimeZone accepts IANA zones and rejects everything else", () => {
  assert.equal(isValidTimeZone("Africa/Johannesburg"), true)
  assert.equal(isValidTimeZone("Europe/London"), true)
  assert.equal(isValidTimeZone("Not/AZone"), false)
  assert.equal(isValidTimeZone(""), false)
  assert.equal(isValidTimeZone("   "), false)
  assert.equal(isValidTimeZone(null), false)
  assert.equal(isValidTimeZone(undefined), false)
})

test("filterByLocationRows: a service with no rows is offered everywhere (existing services keep working)", () => {
  const services = [{ id: "cut" }, { id: "color" }, { id: "spa" }]
  assert.deepEqual(filterByLocationRows(services, [], "loc-a"), services)
})

test("filterByLocationRows: a restricted service is offered only where it is listed", () => {
  const services = [{ id: "cut" }, { id: "color" }, { id: "spa" }]
  const rows = [
    { service_id: "color", location_id: "loc-a" },
    { service_id: "spa", location_id: "loc-b" },
    { service_id: "spa", location_id: "loc-a" },
  ]
  assert.deepEqual(filterByLocationRows(services, rows, "loc-a").map((s) => s.id), ["cut", "color", "spa"])
  assert.deepEqual(filterByLocationRows(services, rows, "loc-b").map((s) => s.id), ["cut", "spa"])
  assert.deepEqual(filterByLocationRows(services, rows, "loc-c").map((s) => s.id), ["cut"])
})

// ---------------------------------------------------------------------------
// Database helpers: tenant scoping is the property that matters
// ---------------------------------------------------------------------------

const db = () =>
  fakeClient({
    tenant_locations: [
      dbRow({ id: "t1-main", tenant_id: T1, slug: "main", is_default: true }),
      dbRow({ id: "t1-sandton", tenant_id: T1, slug: "sandton", timezone: "Africa/Johannesburg", sort_order: 1 }),
      dbRow({ id: "t1-off", tenant_id: T1, slug: "off", is_active: false }),
      dbRow({ id: "t1-old", tenant_id: T1, slug: "old", archived_at: "2026-01-01T00:00:00Z" }),
      dbRow({ id: "t1-badtz", tenant_id: T1, slug: "badtz", timezone: "Mars/Olympus" }),
      dbRow({ id: "t2-main", tenant_id: T2, slug: "main", is_default: true, timezone: "Europe/London" }),
    ],
    staff_locations: [
      { staff_id: "s1", location_id: "t1-main", tenant_id: T1 },
      { staff_id: "s2", location_id: "t1-main", tenant_id: T1 },
      { staff_id: "s2", location_id: "t1-sandton", tenant_id: T1 },
      { staff_id: "s9", location_id: "t1-main", tenant_id: T2 }, // same location id value, other tenant
    ],
    tenant_settings: [
      { tenant_id: T1, timezone: "Africa/Johannesburg" },
      { tenant_id: T2, timezone: "Europe/London" },
    ],
  })

test("getTenantLocations returns only this tenant's usable locations, default first", async () => {
  const list = await getTenantLocations(db(), T1)
  assert.deepEqual(list.map((l) => l.id), ["t1-main", "t1-badtz", "t1-sandton"])
  assert.ok(list.every((l) => l.tenantId === T1))
})

test("getTenantLocations can include switched-off and archived locations when asked", async () => {
  const list = await getTenantLocations(db(), T1, { includeInactive: true })
  assert.deepEqual(new Set(list.map((l) => l.id)), new Set(["t1-main", "t1-sandton", "t1-off", "t1-old", "t1-badtz"]))
})

test("resolveLocation defaults, resolves a slug, and never crosses tenants", async () => {
  assert.equal((await resolveLocation(db(), T1))?.id, "t1-main")
  assert.equal((await resolveLocation(db(), T1, "sandton"))?.id, "t1-sandton")
  assert.equal(await resolveLocation(db(), T1, "t2-main"), null)
  assert.equal((await resolveLocation(db(), T2))?.id, "t2-main")
})

test("countActiveLocations ignores switched-off and archived locations", async () => {
  assert.equal(await countActiveLocations(db(), T1), 3)
  assert.equal(await countActiveLocations(db(), T2), 1)
})

test("assertLocationUsable passes for the tenant's own live location", async () => {
  await assertLocationUsable(db(), T1, "t1-sandton")
})

test("assertLocationUsable rejects another tenant's, switched-off, archived and unknown locations", async () => {
  for (const id of ["t2-main", "t1-off", "t1-old", "nope"]) {
    await assert.rejects(() => assertLocationUsable(db(), T1, id), { message: LOCATION_NOT_AVAILABLE }, id)
  }
})

test("getStaffIdsForLocation returns only this tenant's staff at that location", async () => {
  assert.deepEqual((await getStaffIdsForLocation(db(), T1, "t1-main")).sort(), ["s1", "s2"])
  assert.deepEqual(await getStaffIdsForLocation(db(), T1, "t1-sandton"), ["s2"])
  assert.deepEqual(await getStaffIdsForLocation(db(), T2, "t1-main"), ["s9"])
  assert.deepEqual(await getStaffIdsForLocation(db(), T1, "t2-main"), [])
})

test("getLocationTimezone returns a valid override and treats null or invalid as 'not set'", async () => {
  assert.equal(await getLocationTimezone(db(), T1, "t1-sandton"), "Africa/Johannesburg")
  assert.equal(await getLocationTimezone(db(), T1, "t1-main"), null)
  assert.equal(await getLocationTimezone(db(), T1, "t1-badtz"), null)
  assert.equal(await getLocationTimezone(db(), T1, "t2-main"), null) // another tenant's location
})

// ---------------------------------------------------------------------------
// getTenantTimezone: omitting the location must behave exactly as before
// ---------------------------------------------------------------------------

test("getTenantTimezone without a location is the tenant's timezone (unchanged behaviour)", async () => {
  assert.equal(await getTenantTimezone(db(), T1), "Africa/Johannesburg")
  assert.equal(await getTenantTimezone(db(), T2), "Europe/London")
  assert.equal(await getTenantTimezone(db(), T1, null), "Africa/Johannesburg")
  assert.equal(await getTenantTimezone(db(), T1, undefined), "Africa/Johannesburg")
})

test("getTenantTimezone: a location without its own timezone uses the tenant's", async () => {
  assert.equal(await getTenantTimezone(db(), T1, "t1-main"), "Africa/Johannesburg")
  assert.equal(await getTenantTimezone(db(), T1, "t1-badtz"), "Africa/Johannesburg") // invalid override ignored
})

test("getTenantTimezone: a location's own timezone wins, but only for this tenant's locations", async () => {
  const client = fakeClient({
    tenant_locations: [dbRow({ id: "t1-london", tenant_id: T1, timezone: "Europe/London" })],
    tenant_settings: [{ tenant_id: T1, timezone: "Africa/Johannesburg" }],
  })
  assert.equal(await getTenantTimezone(client, T1, "t1-london"), "Europe/London")
  // Tenant 2 asking with tenant 1's location id must NOT pick up tenant 1's London override:
  // it has no settings row of its own, so it gets the platform default (Africa/Johannesburg).
  assert.equal(await getTenantTimezone(client, T2, "t1-london"), "Africa/Johannesburg")
})

// ---------------------------------------------------------------------------
// Which location is a kiosk / TV screen for?
// ---------------------------------------------------------------------------

test("chooseScreenLocation: a single-location shop with no ?loc= is unchanged (no narrowing)", () => {
  assert.deepEqual(chooseScreenLocation([loc({ id: "main", isDefault: true })]), { kind: "all" })
  assert.deepEqual(chooseScreenLocation([loc({ id: "main", isDefault: true }), loc({ id: "old", isActive: false })]), { kind: "all" })
})

test("chooseScreenLocation: a multi-location shop with no ?loc= gets its default, never a mix of branches", () => {
  const list = [loc({ id: "b", slug: "b" }), loc({ id: "main", slug: "main", isDefault: true })]
  const result = chooseScreenLocation(list)
  assert.equal(result.kind, "location")
  assert.equal(result.kind === "location" && result.location.id, "main")
})

test("chooseScreenLocation: ?loc= picks that branch by slug or id, and refuses anything unusable", () => {
  const list = [
    loc({ id: "main", slug: "main", isDefault: true }),
    loc({ id: "sandton", slug: "sandton" }),
    loc({ id: "off", slug: "off", isActive: false }),
  ]
  const picked = chooseScreenLocation(list, "Sandton")
  assert.equal(picked.kind === "location" && picked.location.id, "sandton")
  assert.deepEqual(chooseScreenLocation(list, "off"), { kind: "unknown" })
  assert.deepEqual(chooseScreenLocation(list, "nope"), { kind: "unknown" })
  // even on a single-location shop a bad ?loc= is refused, not ignored
  assert.deepEqual(chooseScreenLocation([loc({ id: "main", isDefault: true })], "nope"), { kind: "unknown" })
})

// ---------------------------------------------------------------------------
// Per-location opening hours (must match the database function effective_hours)
// ---------------------------------------------------------------------------

test("hoursFromLocationRows: no rows means inherit the tenant's hours", () => {
  assert.equal(hoursFromLocationRows([], 1), null)
})

test("hoursFromLocationRows: a location with rows is governed by them alone; a missing day is closed", () => {
  const rows = [{ day_of_week: 1, is_closed: false, open_time: "10:00:00", close_time: "12:00:00" }]
  assert.deepEqual(hoursFromLocationRows(rows, 1), { isClosed: false, openTime: "10:00:00", closeTime: "12:00:00" })
  assert.deepEqual(hoursFromLocationRows(rows, 6), { isClosed: true, openTime: null, closeTime: null })
})

test("getBusinessHoursForDate: tenant hours without a location, and for a location with no hours of its own", async () => {
  const client = fakeClient({
    business_hours: [{ tenant_id: T1, day_of_week: 1, is_closed: false, open_time: "09:00:00", close_time: "17:00:00" }],
    location_business_hours: [],
  })
  const tenantHours = { isClosed: false, openTime: "09:00:00", closeTime: "17:00:00" }
  assert.deepEqual(await getBusinessHoursForDate(client, T1, "2026-11-30"), tenantHours) // a Monday
  assert.deepEqual(await getBusinessHoursForDate(client, T1, "2026-11-30", "loc-a"), tenantHours)
})

test("getBusinessHoursForDate: a location's own hours win, a day it lacks is closed, and other tenants' rows never leak", async () => {
  const client = fakeClient({
    business_hours: [{ tenant_id: T1, day_of_week: 6, is_closed: false, open_time: "09:00:00", close_time: "17:00:00" }],
    location_business_hours: [
      { tenant_id: T1, location_id: "loc-a", day_of_week: 1, is_closed: false, open_time: "10:00:00", close_time: "12:00:00" },
      { tenant_id: T2, location_id: "loc-a", day_of_week: 6, is_closed: false, open_time: "00:00:00", close_time: "23:00:00" },
    ],
  })
  assert.deepEqual(await getBusinessHoursForDate(client, T1, "2026-11-30", "loc-a"), { isClosed: false, openTime: "10:00:00", closeTime: "12:00:00" })
  // Saturday: tenant is open, but this location has its own hours and no Saturday row -> closed
  assert.deepEqual(await getBusinessHoursForDate(client, T1, "2026-11-28", "loc-a"), { isClosed: true, openTime: null, closeTime: null })
  // without a location, the tenant's Saturday hours apply, untouched by the location rows
  assert.deepEqual(await getBusinessHoursForDate(client, T1, "2026-11-28"), { isClosed: false, openTime: "09:00:00", closeTime: "17:00:00" })
})
