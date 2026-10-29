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
import * as messages from "@/lib/services/messages/shisha"
import { notifyShishaCustomer } from "@/lib/services/shisha-notify"
import { loadShishaSettings, loadShishaSnapshot } from "./shisha-data"
import {
  PAYMENT_METHODS,
  SHISHA_LIVE_STATUSES,
  liveRemainingSeconds,
  type ShishaActionResult,
  type ShishaSnapshot,
} from "./shisha-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scoped =
  | { ok: true; supabase: ServerClient; tenantId: string; actorId: string | null }
  | { ok: false; error: string }
/** What the shared helpers need from a successful scoped() call. */
type Ctx = { supabase: ServerClient; tenantId: string; actorId: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The signed-in staff member's user id, for "handled by". Reads the first uuid-shaped
 *  id the membership exposes; null if it has none (the request is still handled, just
 *  without a name on it). */
function memberUserId(member: unknown): string | null {
  const m = (member ?? {}) as Record<string, unknown>
  for (const key of ["userId", "profileId", "user_id", "profile_id"]) {
    const v = m[key]
    if (typeof v === "string" && UUID_RE.test(v)) return v
  }
  return null
}

const round2 = (n: number): number => Math.round(n * 100) / 100

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

  return { ok: true, supabase, tenantId, actorId: memberUserId(check.member) }
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

interface StartInput {
  deviceId: string
  productId: string
  customerPhone?: string
  /** Where the customer is sitting (a station). Chosen by staff per session;
   *  when omitted the device's usual station, if it has one, is used. If the
   *  shop requires stations and neither exists, the start is refused. */
  locationId?: string | null
  /** Taken at the counter when the customer pays up front. Optional: the
   *  Sessions panel still records it when the session ends instead. */
  paymentMethod?: string | null
}

type StartCore =
  | { ok: true; sessionId: string | null; totalAmount: number; deviceCode: string; stationName: string | null }
  | { ok: false; error: string }

/**
 * Creates a session. Used by the counter's Start AND by accepting an order_session
 * request, so both go through exactly the same rules. `customerIdOverride`: the request
 * path already knows the customer, so it links them directly (undefined = look up by phone).
 * total_amount is the flavour's CURRENT price.
 */
async function startSessionCore(
  ctx: Ctx,
  input: StartInput & { customerIdOverride?: string | null },
): Promise<StartCore> {
  const paymentMethod = PAYMENT_METHODS.find((m) => m.value === input.paymentMethod)?.value ?? null
  if (input.paymentMethod && !paymentMethod) return fail("Pick a valid payment method.")

  const [deviceRes, productRes] = await Promise.all([
    ctx.supabase
      .from("shisha_devices")
      .select("id, device_code, status, location_id")
      .eq("id", input.deviceId)
      .eq("tenant_id", ctx.tenantId)
      .is("archived_at", null)
      .maybeSingle(),
    ctx.supabase
      .from("shisha_products")
      .select("id, price, is_available")
      .eq("id", input.productId)
      .eq("tenant_id", ctx.tenantId)
      .is("archived_at", null)
      .maybeSingle(),
  ])
  if (deviceRes.error) return fail(deviceRes.error.message)
  if (productRes.error) return fail(productRes.error.message)

  const device = deviceRes.data as { id: string; device_code: string; status: string; location_id: string | null } | null
  const product = productRes.data as { id: string; price: number | string; is_available: boolean } | null
  if (!device) return fail("Device not found.")
  if (device.status === "maintenance") return fail("That device is under maintenance.")
  if (!product || !product.is_available) return fail("That flavour isn't available.")

  let settings
  try {
    settings = await loadShishaSettings(ctx.supabase, ctx.tenantId)
  } catch {
    return fail("Couldn't load shisha settings.")
  }

  // Station: explicit choice, else the device's usual station, else none.
  // Only active, non-archived stations of THIS tenant count, and that is the
  // same list the start screens offer, so UI and server always agree.
  const { data: stationRows, error: stationError } = await ctx.supabase
    .from("shisha_locations")
    .select("id, name")
    .eq("tenant_id", ctx.tenantId)
    .eq("is_active", true)
    .is("archived_at", null)
  if (stationError) return fail(stationError.message)
  const activeStations = new Map(((stationRows ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]))

  let locationId: string | null = null
  if (input.locationId) {
    if (!activeStations.has(input.locationId)) return fail("That station isn't available.")
    locationId = input.locationId
  } else if (device.location_id && activeStations.has(device.location_id)) {
    locationId = device.location_id
  }

  // Required only when the shop can actually offer a station; otherwise
  // nobody could start a session.
  if (settings.requireStation && activeStations.size > 0 && !locationId) {
    return fail("Pick a station for this session.")
  }

  // Link to an existing customer by (tenant_id, phone) — never phone alone,
  // numbers repeat across tenants. No match = walk-in (customer_id null).
  const phone = (input.customerPhone ?? "").replace(/\s+/g, "")
  let customerId: string | null = null
  if (input.customerIdOverride !== undefined) {
    customerId = input.customerIdOverride
  } else if (phone) {
    const { data } = await ctx.supabase
      .from("tenant_customers")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("phone", phone)
      .maybeSingle()
    customerId = (data as { id: string } | null)?.id ?? null
  }

  const { data: inserted, error: insertError } = await ctx.supabase
    .from("shisha_sessions")
    .insert([
      {
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        customer_phone: phone || null,
        device_id: device.id,
        product_id: product.id,
        location_id: locationId,
        remaining_time_seconds: settings.coalDurationMinutes * 60,
        total_amount: Number(product.price),
        status: "active",
        payment_method: paymentMethod,
      },
    ])
    .select("id")
  if (insertError) {
    // The partial unique index: one live session per device.
    if (insertError.code === UNIQUE_VIOLATION) return fail("That device already has a live session.")
    return fail(insertError.message)
  }

  // shisha_devices.status is kept in sync by a database trigger, and the session fee
  // event is written by the shisha_sessions_bill_start trigger. Nothing to do here.

  return {
    ok: true,
    sessionId: (inserted as Array<{ id: string }> | null)?.[0]?.id ?? null,
    totalAmount: Number(product.price),
    deviceCode: device.device_code,
    stationName: locationId ? (activeStations.get(locationId) ?? null) : null,
  }
}

export async function startSession(input: StartInput): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s
  const result = await startSessionCore(s, input)
  return result.ok ? { ok: true } : result
}

interface LiveSessionRow {
  id: string
  device_id: string | null
  product_id: string | null
  remaining_time_seconds: number
  last_refill_time: string
  paused: boolean
  refill_count: number
  total_amount: number | string
  refill_total: number | string
}

async function loadLiveSession(supabase: ServerClient, tenantId: string, id: string) {
  const { data, error } = await supabase
    .from("shisha_sessions")
    .select("id, device_id, product_id, remaining_time_seconds, last_refill_time, paused, refill_count, total_amount, refill_total")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .maybeSingle()
  return {
    error: error?.message ?? null,
    row: data as LiveSessionRow | null,
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

type RefillCore =
  | { ok: true; charged: number; priceMissing: boolean }
  | { ok: false; error: string }

/**
 * Resets the timer to a full coal duration AND charges the flavour's CURRENT refill
 * price (shisha_products.refill_price; 0 = free) onto the session: total_amount and
 * refill_total both go up by it, in the same conditional UPDATE that bumps refill_count.
 * That UPDATE is guarded by .eq("refill_count", ...), so two staff refilling at once
 * can't both win (one charge, one refill, one fee: the fee event itself is written by
 * the shisha_sessions_bill_refill trigger from the refill_count increase).
 * If the session's flavour was archived or removed, the refill is free and priceMissing is set.
 * Used by the counter's Refill button AND by accepting a refill request.
 */
async function refillSessionCore(ctx: Ctx, id: string): Promise<RefillCore> {
  const { row, error } = await loadLiveSession(ctx.supabase, ctx.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")
  if (row.paused) return fail("Resume the session before refilling it.")

  let settings
  try {
    settings = await loadShishaSettings(ctx.supabase, ctx.tenantId)
  } catch {
    return fail("Couldn't load shisha settings.")
  }

  let charge = 0
  let priceMissing = true
  if (row.product_id) {
    const { data: productData, error: productError } = await ctx.supabase
      .from("shisha_products")
      .select("refill_price, archived_at")
      .eq("id", row.product_id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle()
    if (productError) return fail(productError.message)
    const product = productData as { refill_price: number | string | null; archived_at: string | null } | null
    if (product && product.archived_at === null) {
      charge = round2(Number(product.refill_price ?? 0))
      priceMissing = false
    }
  }

  const { data, error: updateError } = await ctx.supabase
    .from("shisha_sessions")
    .update({
      remaining_time_seconds: settings.coalDurationMinutes * 60,
      last_refill_time: new Date().toISOString(),
      refill_count: row.refill_count + 1,
      total_amount: round2(Number(row.total_amount) + charge),
      refill_total: round2(Number(row.refill_total) + charge),
      status: "active",
    })
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .eq("paused", false)
    .eq("refill_count", row.refill_count)
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (updateError) return fail(updateError.message)
  if (!data || data.length === 0) return fail(STALE)
  return { ok: true, charged: charge, priceMissing }
}

const REFILL_PRICE_MISSING_WARNING =
  "That flavour was removed from the menu, so this refill was not charged. Add the amount at the counter if needed."

export async function refillSession(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s
  const result = await refillSessionCore(s, id)
  if (!result.ok) return result
  return {
    ok: true,
    charged: result.charged,
    ...(result.priceMissing ? { warning: REFILL_PRICE_MISSING_WARNING } : {}),
  }
}

type EndCore = { ok: true; totalAmount: number } | { ok: false; error: string }

/** Closes a live session (the device is freed by the shisha_sessions_sync_device trigger).
 *  Used by the counter's End AND by accepting an end_session request. */
async function endSessionCore(ctx: Ctx, id: string, paymentMethod: string | null): Promise<EndCore> {
  const method = PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.value ?? null
  if (paymentMethod && !method) return fail("Pick a valid payment method.")

  const { row, error } = await loadLiveSession(ctx.supabase, ctx.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")

  // Only write payment_method when one was chosen: "Not recorded" must not
  // wipe a payment already taken at the counter when the session started.
  const update: Record<string, unknown> = { status: "completed", ended_at: new Date().toISOString() }
  if (method) update.payment_method = method

  const { data, error: updateError } = await ctx.supabase
    .from("shisha_sessions")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (updateError) return fail(updateError.message)
  if (!data || data.length === 0) return fail(STALE)

  return { ok: true, totalAmount: Number(row.total_amount) }
}

export async function endSession(id: string, paymentMethod: string | null): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s
  const result = await endSessionCore(s, id, paymentMethod)
  return result.ok ? { ok: true } : result
}

// ============================================================================
// Flavours (shisha.manage)
// ============================================================================

export async function addFlavour(input: {
  name: string
  price: number
  /** What each refill costs. Omitted = 0 (free refills). */
  refillPrice?: number
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Flavour name is required (80 characters max).")
  const price = cleanPrice(input.price)
  if (price === null) return fail("Price must be 0 or more.")
  const refillPrice = cleanPrice(input.refillPrice ?? 0)
  if (refillPrice === null) return fail("Refill price must be 0 or more.")

  const { error } = await s.supabase
    .from("shisha_products")
    .insert([{ tenant_id: s.tenantId, name, price, refill_price: refillPrice }])
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `"${name}" already exists.` : error.message)
  return { ok: true }
}

export async function updateFlavour(
  id: string,
  input: { name: string; price: number; /** Omitted = leave the stored refill price alone. */ refillPrice?: number },
): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Flavour name is required (80 characters max).")
  const price = cleanPrice(input.price)
  if (price === null) return fail("Price must be 0 or more.")
  const changes: { name: string; price: number; refill_price?: number } = { name, price }
  if (input.refillPrice !== undefined) {
    const refillPrice = cleanPrice(input.refillPrice)
    if (refillPrice === null) return fail("Refill price must be 0 or more.")
    changes.refill_price = refillPrice
  }

  const { data, error } = await s.supabase
    .from("shisha_products")
    .update(changes)
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
  /** Optional so older callers keep working; when omitted the stored value is left alone. */
  requireStation?: boolean
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const duration = cleanInt(input.coalDurationMinutes, 5, 480)
  if (duration === null) return fail("Session length must be a whole number between 5 and 480 minutes.")
  const threshold = cleanInt(input.refillThresholdMinutes, 1, 120)
  if (threshold === null) return fail("Refill warning must be a whole number between 1 and 120 minutes.")
  if (threshold >= duration) return fail("The refill warning must be shorter than the session length.")

  if (input.requireStation !== undefined && typeof input.requireStation !== "boolean") {
    return fail("Station requirement must be on or off.")
  }

  // Upsert writes only the columns present, so an omitted require_station keeps
  // its stored value (or the column default for a brand-new row).
  const row: Record<string, unknown> = {
    tenant_id: s.tenantId,
    coal_duration_minutes: duration,
    refill_threshold_minutes: threshold,
  }
  if (input.requireStation !== undefined) row.require_station = input.requireStation

  const { error } = await s.supabase.from("shisha_settings").upsert([row], { onConflict: "tenant_id" })
  if (error) return fail(error.message)
  return { ok: true }
}

// ============================================================================
// Requests from WhatsApp (shisha.operate)
//
// A customer's request sits in shisha_requests as 'pending'. Staff accept or reject it
// here. Race safety: a request leaves 'pending' exactly once, through a conditional
// UPDATE (... .eq("status", "pending").select("id")): if two staff click at once, one
// UPDATE returns a row and the other returns nothing ("already handled"). The work
// itself (create session / refill / end) reuses the SAME helpers the counter uses, so it
// has the same guards: one live session per device (partial unique index), refill_count
// compare-and-set, status-guarded end.
//
// Order of operations on accept:
//   1. read + validate what we can WITHOUT changing anything (flavour, target session...)
//   2. claim the request (pending -> approved)
//   3. do the work through the shared helper
//   4. if the work fails, put the request back to 'pending' so staff can retry or reject
//      (it never stays "approved" with nothing done)
//   5. message the customer; a failed send only produces a warning, never an undo.
// Fee events are written by the database triggers off steps 3's INSERT / refill_count
// change, so exactly one fee per accepted request and none for reject / issue / end.
// ============================================================================

const REQUEST_STALE = "That request was already handled. Refreshing."

interface RequestRow {
  id: string
  request_type: "order_session" | "maintenance" | "end_session" | "issue_report"
  status: string
  session_id: string | null
  customer_id: string | null
  customer_phone: string | null
  location_name: string | null
  flavour_name: string | null
  device_code: string | null
  amount: number | string | null
}

async function loadPendingRequest(ctx: Ctx, id: string): Promise<{ row: RequestRow } | { error: string }> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return { error: "Request not found." }
  const { data, error } = await ctx.supabase
    .from("shisha_requests")
    .select("id, request_type, status, session_id, customer_id, customer_phone, location_name, flavour_name, device_code, amount")
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle()
  if (error) return { error: error.message }
  const row = data as RequestRow | null
  if (!row) return { error: "Request not found." }
  if (row.status !== "pending") return { error: REQUEST_STALE }
  return { row }
}

/** pending -> approved, once. Returns an error message, or null when this call won. */
async function claimRequest(ctx: Ctx, id: string): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from("shisha_requests")
    .update({ status: "approved", responded_at: new Date().toISOString(), handled_by: ctx.actorId })
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .eq("status", "pending")
    .select("id")
  if (error) return error.message
  if (!data || data.length === 0) return REQUEST_STALE
  return null
}

/** Undo a claim whose work failed, so the request is pending again (and the customer isn't stuck). */
async function releaseRequest(ctx: Ctx, id: string): Promise<void> {
  const { error } = await ctx.supabase
    .from("shisha_requests")
    .update({ status: "pending", responded_at: null, handled_by: null })
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .eq("status", "approved")
  if (error) console.error("[shisha] couldn't release a request after a failed accept", { id, error: error.message })
}

const joinWarnings = (...parts: Array<string | null | undefined>): string | undefined => {
  const text = parts.filter((p): p is string => Boolean(p)).join(" ")
  return text || undefined
}

/**
 * The live session a maintenance / end_session request is about: the one it points at,
 * else (it ended, or the request had none) the SAME customer's single live session.
 * Never another customer's: the fallback matches only this request's customer id / phone.
 */
async function findTargetSession(
  ctx: Ctx,
  req: RequestRow,
): Promise<{ error: string | null; row: LiveSessionRow | null }> {
  if (req.session_id) {
    const direct = await loadLiveSession(ctx.supabase, ctx.tenantId, req.session_id)
    if (direct.error) return { error: direct.error, row: null }
    if (direct.row) return direct
  }

  const phone = (req.customer_phone ?? "").replace(/[^0-9+]/g, "")
  const filters: string[] = []
  if (phone) filters.push(`customer_phone.eq.${phone}`)
  if (req.customer_id && UUID_RE.test(req.customer_id)) filters.push(`customer_id.eq.${req.customer_id}`)
  if (filters.length === 0) return { error: null, row: null }

  const { data, error } = await ctx.supabase
    .from("shisha_sessions")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .or(filters.join(","))
    .limit(2)
  if (error) return { error: error.message, row: null }
  const ids = (data ?? []) as Array<{ id: string }>
  // Zero = nothing live. Two or more = we can't tell which one they mean, so don't guess.
  if (ids.length !== 1) return { error: null, row: null }
  return loadLiveSession(ctx.supabase, ctx.tenantId, ids[0].id)
}

/** Records the session a request ended up acting on. Best-effort: the work is already done. */
async function linkRequestToSession(ctx: Ctx, requestId: string, sessionId: string | null): Promise<void> {
  if (!sessionId) return
  const { error } = await ctx.supabase
    .from("shisha_requests")
    .update({ session_id: sessionId })
    .eq("id", requestId)
    .eq("tenant_id", ctx.tenantId)
  if (error) console.error("[shisha] couldn't link a request to its session", { requestId, error: error.message })
}

export async function acceptShishaRequest(input: {
  requestId: string
  /** order_session: the device staff picked. */
  deviceId?: string | null
  /** order_session: the station staff picked ("" / null = the request's own, then the device's usual). */
  locationId?: string | null
  /** order_session / end_session: how the customer paid, if known. */
  paymentMethod?: string | null
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const loaded = await loadPendingRequest(s, input.requestId)
  if ("error" in loaded) return fail(loaded.error)
  const req = loaded.row

  switch (req.request_type) {
    case "order_session":
      return acceptOrderSession(s, req, input)
    case "maintenance":
      return acceptRefillRequest(s, req)
    case "end_session":
      return acceptEndRequest(s, req, input.paymentMethod ?? null)
    case "issue_report":
      return acceptIssueReport(s, req)
    default:
      return fail("Unknown request type.")
  }
}

async function acceptOrderSession(
  ctx: Ctx,
  req: RequestRow,
  input: { deviceId?: string | null; locationId?: string | null; paymentMethod?: string | null },
): Promise<ShishaActionResult> {
  if (!input.deviceId) return fail("Pick a device for this session.")
  const paymentMethod = PAYMENT_METHODS.find((m) => m.value === input.paymentMethod)?.value ?? null
  if (input.paymentMethod && !paymentMethod) return fail("Pick a valid payment method.")
  if (!req.flavour_name) return fail("This request has no flavour. Reject it, or start the session at the counter.")

  // The flavour as it is NOW (the customer is charged today's price, not the quoted one).
  const { data: productData, error: productError } = await ctx.supabase
    .from("shisha_products")
    .select("id, name, is_available")
    .eq("tenant_id", ctx.tenantId)
    .eq("name", req.flavour_name)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle()
  if (productError) return fail(productError.message)
  const product = productData as { id: string; name: string; is_available: boolean } | null
  if (!product) {
    return fail(`"${req.flavour_name}" is no longer on the menu. Reject this request, or start a session at the counter.`)
  }
  if (!product.is_available) return fail(`"${product.name}" is out of stock. Mark it in stock, or reject this request.`)

  // Station: what staff picked, else the one the customer asked for (by name, if it's still active).
  let locationId = input.locationId || null
  if (!locationId && req.location_name) {
    const { data: stationData, error: stationError } = await ctx.supabase
      .from("shisha_locations")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("name", req.location_name)
      .eq("is_active", true)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle()
    if (stationError) return fail(stationError.message)
    locationId = (stationData as { id: string } | null)?.id ?? null
  }

  const claimError = await claimRequest(ctx, req.id)
  if (claimError) return fail(claimError)

  const started = await startSessionCore(ctx, {
    deviceId: input.deviceId,
    productId: product.id,
    customerPhone: req.customer_phone ?? "",
    customerIdOverride: req.customer_id,
    locationId,
    paymentMethod,
  })
  if (!started.ok) {
    await releaseRequest(ctx, req.id)
    return started
  }

  await linkRequestToSession(ctx, req.id, started.sessionId)
  const warning = await notifyShishaCustomer(
    ctx.tenantId,
    req.customer_phone,
    messages.requestAcceptedSession({
      station: started.stationName,
      flavour: product.name,
      deviceCode: started.deviceCode,
      price: started.totalAmount,
    }),
  )
  return { ok: true, message: `Session started on ${started.deviceCode}.`, ...(warning ? { warning } : {}) }
}

async function acceptRefillRequest(ctx: Ctx, req: RequestRow): Promise<ShishaActionResult> {
  const target = await findTargetSession(ctx, req)
  if (target.error) return fail(target.error)
  if (!target.row) return fail("This customer has no live session any more. Reject the request.")
  if (target.row.paused) return fail("That session is paused. Resume it first, then accept the refill.")

  const claimError = await claimRequest(ctx, req.id)
  if (claimError) return fail(claimError)

  const refilled = await refillSessionCore(ctx, target.row.id)
  if (!refilled.ok) {
    await releaseRequest(ctx, req.id)
    return refilled
  }

  await linkRequestToSession(ctx, req.id, target.row.id)
  const notifyWarning = await notifyShishaCustomer(
    ctx.tenantId,
    req.customer_phone,
    messages.requestAcceptedRefill(refilled.charged),
  )
  const warning = joinWarnings(refilled.priceMissing ? REFILL_PRICE_MISSING_WARNING : null, notifyWarning)
  return {
    ok: true,
    charged: refilled.charged,
    message:
      refilled.charged > 0
        ? `Refill added · ${messages.formatRands(refilled.charged)} charged.`
        : "Refill added (no charge).",
    ...(warning ? { warning } : {}),
  }
}

async function acceptEndRequest(ctx: Ctx, req: RequestRow, paymentMethod: string | null): Promise<ShishaActionResult> {
  const target = await findTargetSession(ctx, req)
  if (target.error) return fail(target.error)
  if (!target.row) return fail("That session has already ended. Reject the request to clear it.")

  const claimError = await claimRequest(ctx, req.id)
  if (claimError) return fail(claimError)

  const ended = await endSessionCore(ctx, target.row.id, paymentMethod)
  if (!ended.ok) {
    await releaseRequest(ctx, req.id)
    return ended
  }

  await linkRequestToSession(ctx, req.id, target.row.id)
  const warning = await notifyShishaCustomer(ctx.tenantId, req.customer_phone, messages.requestAcceptedEnd(ended.totalAmount))
  return { ok: true, message: "Session ended.", ...(warning ? { warning } : {}) }
}

async function acceptIssueReport(ctx: Ctx, req: RequestRow): Promise<ShishaActionResult> {
  const claimError = await claimRequest(ctx, req.id)
  if (claimError) return fail(claimError)
  const warning = await notifyShishaCustomer(ctx.tenantId, req.customer_phone, messages.REQUEST_ACCEPTED_ISSUE)
  return { ok: true, message: "Issue marked as handled.", ...(warning ? { warning } : {}) }
}

export async function rejectShishaRequest(requestId: string, reason?: string | null): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const trimmed = typeof reason === "string" ? reason.trim() : ""
  const cleanedReason = trimmed ? cleanText(trimmed, 200) : null
  if (trimmed && !cleanedReason) return fail("The reason is too long (200 characters max).")

  const loaded = await loadPendingRequest(s, requestId)
  if ("error" in loaded) return fail(loaded.error)
  const req = loaded.row

  const { data, error } = await s.supabase
    .from("shisha_requests")
    .update({
      status: "rejected",
      responded_at: new Date().toISOString(),
      handled_by: s.actorId,
      rejection_reason: cleanedReason,
    })
    .eq("id", req.id)
    .eq("tenant_id", s.tenantId)
    .eq("status", "pending")
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail(REQUEST_STALE)

  const warning = await notifyShishaCustomer(s.tenantId, req.customer_phone, messages.requestRejected(cleanedReason))
  return { ok: true, message: "Request rejected.", ...(warning ? { warning } : {}) }
}
