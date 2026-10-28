// app/admin/shisha/actions.ts
"use server"

/**
 * Server Actions for the Shisha tab.
 * -----------------------------------
 * Same two layers as app/admin/actions.ts, plus a third for module access:
 *   1. requireTenantPermission() proves the signed-in user holds the key
 *      (shisha.view / shisha.operate / shisha.manage) for THEIR tenant. The
 *      tenantId is taken from the membership, never from the client.
 *   2. isTenantModuleEnabled() proves the shisha module is switched on for the
 *      tenant (tenant_modules, opt-in). Shisha has its own usage billing and is
 *      NOT part of any zozoQ plan, so the plan check is skipped (requirePlan:
 *      false). A switch-off shuts the actions off even if the UI is stale.
 *   3. Every query below is scoped with .eq("tenant_id", tenantId): these run
 *      on the service-role client, so RLS is not protecting them.
 *
 * Deliberately NOT here (yet):
 *   - revalidatePath("/admin"): ShishaManager loads and polls its own data via
 *     refreshShisha(), so mutations don't need to re-run the whole admin page.
 *   - staff_activity_logs entries: that table's category CHECK and the
 *     AdminActivityCategory type don't have 'shisha' yet.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { MODULE_KEYS, isTenantModuleEnabled } from "@/lib/services/plans"
import { loadShishaSettings, loadShishaSnapshot } from "./shisha-data"
import {
  PAYMENT_METHODS,
  SHISHA_LIVE_STATUSES,
  liveRemainingSeconds,
  type ShishaActionResult,
  type ShishaSnapshot,
} from "./shisha-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scoped = { ok: true; supabase: ServerClient; tenantId: string } | { ok: false; error: string }

const UNIQUE_VIOLATION = "23505"

async function scoped(permission: PermissionKey): Promise<Scoped> {
  const check = await requireTenantPermission(permission)
  if (!check.ok) return { ok: false, error: check.error }

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Supabase isn't configured." }

  const tenantId = check.member.tenantId
  // Tenant has shisha switched on (tenant_modules row with enabled = true;
  // opt-in, so no row = off). Not plan-gated: billed separately per session
  // and refill. Fails closed on any error.
  if (
    !(await isTenantModuleEnabled(supabase, tenantId, MODULE_KEYS.shisha, { defaultOn: false, requirePlan: false }))
  ) {
    return { ok: false, error: "Shisha isn't switched on for your business." }
  }

  return { ok: true, supabase, tenantId }
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

// ---- input cleaning ---------------------------------------------------------

function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null
  const v = raw.trim().replace(/\s+/g, " ")
  return v.length > 0 && v.length <= max ? v : null
}

function cleanPrice(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100_000) return null
  return Math.round(raw * 100) / 100
}

function cleanInt(raw: unknown, min: number, max: number): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null
}

/** A station id from the client must belong to this tenant. */
async function stationBelongsToTenant(supabase: ServerClient, tenantId: string, id: string): Promise<boolean> {
  const { data } = await supabase
    .from("shisha_locations")
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("archived_at", null)
    .maybeSingle()
  return Boolean(data)
}

async function deviceHasLiveSession(supabase: ServerClient, tenantId: string, deviceId: string): Promise<boolean> {
  const { count } = await supabase
    .from("shisha_sessions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("device_id", deviceId)
    .in("status", SHISHA_LIVE_STATUSES)
  return (count ?? 0) > 0
}

// ============================================================================
// Read
// ============================================================================

/** Full snapshot for the Shisha tab: first load and the periodic refresh.
 *  Read-only; deliberately no revalidatePath (same reasoning as refreshQueue). */
export async function refreshShisha(): Promise<
  { ok: true; snapshot: ShishaSnapshot } | { ok: false; error: string }
> {
  const s = await scoped("shisha.view")
  if (!s.ok) return s
  try {
    // The fee ledger is only shown to shisha.manage (service-role client, so
    // this check is the guard, not RLS).
    const canSeeUsage = (await requireTenantPermission("shisha.manage")).ok
    return { ok: true, snapshot: await loadShishaSnapshot(s.supabase, s.tenantId, { includeUsage: canSeeUsage }) }
  } catch (err) {
    console.error("[shisha] refreshShisha failed", { tenantId: s.tenantId, error: err })
    return fail("Couldn't load shisha data.")
  }
}

// ============================================================================
// Sessions (shisha.operate)
//
// Timer model: remaining_time_seconds is the time left AT last_refill_time,
// which is the timer anchor (set on start, refill and resume). While running,
// live remaining = remaining_time_seconds - (now - last_refill_time). Pausing
// freezes that value into remaining_time_seconds; resuming re-anchors to now.
// Every state change is a conditional UPDATE ... .select("id") so two staff
// acting on the same session can't both win.
// ============================================================================

const STALE = "That session changed — refreshing."

export async function startSession(input: {
  deviceId: string
  productId: string
  customerPhone?: string
  /** Taken at the counter when the customer pays up front. Optional: the
   *  Sessions panel still records it when the session ends instead. */
  paymentMethod?: string | null
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const paymentMethod = PAYMENT_METHODS.find((m) => m.value === input.paymentMethod)?.value ?? null
  if (input.paymentMethod && !paymentMethod) return fail("Pick a valid payment method.")

  const [deviceRes, productRes] = await Promise.all([
    s.supabase
      .from("shisha_devices")
      .select("id, status, location_id")
      .eq("id", input.deviceId)
      .eq("tenant_id", s.tenantId)
      .is("archived_at", null)
      .maybeSingle(),
    s.supabase
      .from("shisha_products")
      .select("id, price, is_available")
      .eq("id", input.productId)
      .eq("tenant_id", s.tenantId)
      .is("archived_at", null)
      .maybeSingle(),
  ])
  if (deviceRes.error) return fail(deviceRes.error.message)
  if (productRes.error) return fail(productRes.error.message)

  const device = deviceRes.data as { id: string; status: string; location_id: string | null } | null
  const product = productRes.data as { id: string; price: number | string; is_available: boolean } | null
  if (!device) return fail("Device not found.")
  if (device.status === "maintenance") return fail("That device is under maintenance.")
  if (!product || !product.is_available) return fail("That flavour isn't available.")

  let settings
  try {
    settings = await loadShishaSettings(s.supabase, s.tenantId)
  } catch {
    return fail("Couldn't load shisha settings.")
  }

  // Link to an existing customer by (tenant_id, phone) — never phone alone,
  // numbers repeat across tenants. No match = walk-in (customer_id null).
  const phone = (input.customerPhone ?? "").replace(/\s+/g, "")
  let customerId: string | null = null
  if (phone) {
    const { data } = await s.supabase
      .from("tenant_customers")
      .select("id")
      .eq("tenant_id", s.tenantId)
      .eq("phone", phone)
      .maybeSingle()
    customerId = (data as { id: string } | null)?.id ?? null
  }

  const { error: insertError } = await s.supabase.from("shisha_sessions").insert([
    {
      tenant_id: s.tenantId,
      customer_id: customerId,
      customer_phone: phone || null,
      device_id: device.id,
      product_id: product.id,
      location_id: device.location_id,
      remaining_time_seconds: settings.coalDurationMinutes * 60,
      total_amount: Number(product.price),
      status: "active",
      payment_method: paymentMethod,
    },
  ])
  if (insertError) {
    // The partial unique index: one live session per device.
    if (insertError.code === UNIQUE_VIOLATION) return fail("That device already has a live session.")
    return fail(insertError.message)
  }

  // shisha_devices.status is kept in sync by a database trigger.

  return { ok: true }
}

async function loadLiveSession(supabase: ServerClient, tenantId: string, id: string) {
  const { data, error } = await supabase
    .from("shisha_sessions")
    .select("id, device_id, remaining_time_seconds, last_refill_time, paused, refill_count")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .maybeSingle()
  return {
    error: error?.message ?? null,
    row: data as {
      id: string
      device_id: string | null
      remaining_time_seconds: number
      last_refill_time: string
      paused: boolean
      refill_count: number
    } | null,
  }
}

export async function pauseSession(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const { row, error } = await loadLiveSession(s.supabase, s.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")
  if (row.paused) return fail("That session is already paused.")

  const remaining = liveRemainingSeconds(
    { paused: false, remainingSeconds: row.remaining_time_seconds, lastRefillTime: row.last_refill_time },
    Date.now(),
  )

  const { data, error: updateError } = await s.supabase
    .from("shisha_sessions")
    .update({ status: "paused", remaining_time_seconds: remaining })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .eq("paused", false)
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (updateError) return fail(updateError.message)
  if (!data || data.length === 0) return fail(STALE)
  return { ok: true }
}

export async function resumeSession(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const { data, error } = await s.supabase
    .from("shisha_sessions")
    .update({ status: "active", last_refill_time: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .eq("paused", true)
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail(STALE)
  return { ok: true }
}

/** Resets the timer to a full coal duration. The price is NOT changed: refills
 *  are free until you decide otherwise (total_amount stays as started). */
export async function refillSession(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const { row, error } = await loadLiveSession(s.supabase, s.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")
  if (row.paused) return fail("Resume the session before refilling it.")

  let settings
  try {
    settings = await loadShishaSettings(s.supabase, s.tenantId)
  } catch {
    return fail("Couldn't load shisha settings.")
  }

  const { data, error: updateError } = await s.supabase
    .from("shisha_sessions")
    .update({
      remaining_time_seconds: settings.coalDurationMinutes * 60,
      last_refill_time: new Date().toISOString(),
      refill_count: row.refill_count + 1,
      status: "active",
    })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .eq("paused", false)
    .eq("refill_count", row.refill_count)
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (updateError) return fail(updateError.message)
  if (!data || data.length === 0) return fail(STALE)
  return { ok: true }
}

export async function endSession(id: string, paymentMethod: string | null): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const method = PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.value ?? null
  if (paymentMethod && !method) return fail("Pick a valid payment method.")

  const { row, error } = await loadLiveSession(s.supabase, s.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")

  // Only write payment_method when one was chosen: "Not recorded" must not
  // wipe a payment already taken at the counter when the session started.
  const update: Record<string, unknown> = { status: "completed", ended_at: new Date().toISOString() }
  if (method) update.payment_method = method

  const { data, error: updateError } = await s.supabase
    .from("shisha_sessions")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (updateError) return fail(updateError.message)
  if (!data || data.length === 0) return fail(STALE)

  return { ok: true }
}

// ============================================================================
// Flavours (shisha.manage)
// ============================================================================

export async function addFlavour(input: { name: string; price: number }): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Flavour name is required (80 characters max).")
  const price = cleanPrice(input.price)
  if (price === null) return fail("Price must be 0 or more.")

  const { error } = await s.supabase.from("shisha_products").insert([{ tenant_id: s.tenantId, name, price }])
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `"${name}" already exists.` : error.message)
  return { ok: true }
}

export async function updateFlavour(id: string, input: { name: string; price: number }): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Flavour name is required (80 characters max).")
  const price = cleanPrice(input.price)
  if (price === null) return fail("Price must be 0 or more.")

  const { data, error } = await s.supabase
    .from("shisha_products")
    .update({ name, price })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `"${name}" already exists.` : error.message)
  if (!data || data.length === 0) return fail("Flavour not found.")
  return { ok: true }
}

export async function setFlavourAvailable(id: string, available: boolean): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const { data, error } = await s.supabase
    .from("shisha_products")
    .update({ is_available: available })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail("Flavour not found.")
  return { ok: true }
}

/** Soft delete: sessions keep pointing at it, so history and analytics survive. */
export async function archiveFlavour(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const { data, error } = await s.supabase
    .from("shisha_products")
    .update({ archived_at: new Date().toISOString(), is_available: false })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail("Flavour not found.")
  return { ok: true }
}

// ============================================================================
// Devices (shisha.manage)
// ============================================================================

interface DeviceInput {
  deviceCode: string
  deviceName: string
  locationId: string | null
}

export async function addDevice(input: DeviceInput): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const code = cleanText(input.deviceCode, 30)?.toUpperCase()
  if (!code) return fail("Device code is required (30 characters max).")
  const name = input.deviceName.trim() === "" ? null : cleanText(input.deviceName, 80)
  if (input.deviceName.trim() !== "" && !name) return fail("Device name is too long (80 characters max).")
  if (input.locationId && !(await stationBelongsToTenant(s.supabase, s.tenantId, input.locationId))) {
    return fail("Station not found.")
  }

  const { error } = await s.supabase.from("shisha_devices").insert([
    { tenant_id: s.tenantId, device_code: code, device_name: name, location_id: input.locationId },
  ])
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `Device "${code}" already exists.` : error.message)
  return { ok: true }
}

export async function updateDevice(id: string, input: DeviceInput): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const code = cleanText(input.deviceCode, 30)?.toUpperCase()
  if (!code) return fail("Device code is required (30 characters max).")
  const name = input.deviceName.trim() === "" ? null : cleanText(input.deviceName, 80)
  if (input.deviceName.trim() !== "" && !name) return fail("Device name is too long (80 characters max).")
  if (input.locationId && !(await stationBelongsToTenant(s.supabase, s.tenantId, input.locationId))) {
    return fail("Station not found.")
  }

  const { data, error } = await s.supabase
    .from("shisha_devices")
    .update({ device_code: code, device_name: name, location_id: input.locationId })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `Device "${code}" already exists.` : error.message)
  if (!data || data.length === 0) return fail("Device not found.")
  return { ok: true }
}

export async function setDeviceMaintenance(id: string, inMaintenance: boolean): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  if (inMaintenance && (await deviceHasLiveSession(s.supabase, s.tenantId, id))) {
    return fail("End the live session on this device first.")
  }
  const { data, error } = await s.supabase
    .from("shisha_devices")
    .update({ status: inMaintenance ? "maintenance" : "available" })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail("Device not found.")
  return { ok: true }
}

export async function archiveDevice(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  if (await deviceHasLiveSession(s.supabase, s.tenantId, id)) return fail("End the live session on this device first.")
  const { data, error } = await s.supabase
    .from("shisha_devices")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail("Device not found.")
  return { ok: true }
}

// ============================================================================
// Stations (shisha.manage)
// ============================================================================

export async function addStation(input: { name: string }): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Station name is required (80 characters max).")
  const { error } = await s.supabase.from("shisha_locations").insert([{ tenant_id: s.tenantId, name }])
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `"${name}" already exists.` : error.message)
  return { ok: true }
}

export async function updateStation(id: string, input: { name: string }): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Station name is required (80 characters max).")
  const { data, error } = await s.supabase
    .from("shisha_locations")
    .update({ name })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `"${name}" already exists.` : error.message)
  if (!data || data.length === 0) return fail("Station not found.")
  return { ok: true }
}

export async function setStationActive(id: string, active: boolean): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const { data, error } = await s.supabase
    .from("shisha_locations")
    .update({ is_active: active })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail("Station not found.")
  return { ok: true }
}

/** Soft delete. Devices at the station are detached (location cleared) so
 *  nothing active points at an archived station; past sessions keep it. */
export async function archiveStation(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s

  const { error: detachError } = await s.supabase
    .from("shisha_devices")
    .update({ location_id: null })
    .eq("tenant_id", s.tenantId)
    .eq("location_id", id)
  if (detachError) return fail(detachError.message)

  const { data, error } = await s.supabase
    .from("shisha_locations")
    .update({ archived_at: new Date().toISOString(), is_active: false })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .is("archived_at", null)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail("Station not found.")
  return { ok: true }
}

// ============================================================================
// Settings (shisha.manage)
// ============================================================================

export async function updateShishaSettings(input: {
  coalDurationMinutes: number
  refillThresholdMinutes: number
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const duration = cleanInt(input.coalDurationMinutes, 5, 480)
  if (duration === null) return fail("Session length must be a whole number between 5 and 480 minutes.")
  const threshold = cleanInt(input.refillThresholdMinutes, 1, 120)
  if (threshold === null) return fail("Refill warning must be a whole number between 1 and 120 minutes.")
  if (threshold >= duration) return fail("The refill warning must be shorter than the session length.")

  const { error } = await s.supabase.from("shisha_settings").upsert(
    [{ tenant_id: s.tenantId, coal_duration_minutes: duration, refill_threshold_minutes: threshold }],
    { onConflict: "tenant_id" },
  )
  if (error) return fail(error.message)
  return { ok: true }
}
