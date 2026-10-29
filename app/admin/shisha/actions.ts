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
import { sendShishaCustomerMessage } from "@/lib/services/shisha-notify"
import { loadShishaSettings, loadShishaSnapshot } from "./shisha-data"
import {
  PAYMENT_METHODS,
  SHISHA_LIVE_STATUSES,
  liveRemainingSeconds,
  type ShishaActionResult,
  type ShishaRequestType,
  type ShishaSnapshot,
} from "./shisha-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
/** userId = the signed-in staff member's profile id (recorded as handled_by on requests). */
type Scoped = { ok: true; supabase: ServerClient; tenantId: string; userId: string } | { ok: false; error: string }

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

  return { ok: true, supabase, tenantId, userId: check.member.userId }
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
//
// The start / refill / end bodies live in the *Core helpers below. The counter's
// exported actions and acceptShishaRequest() both call them, so a request is
// validated and recorded exactly like the same thing done at the counter.
// Fees (shisha_billing_events) and device status are written by database
// triggers on shisha_sessions: nothing here touches them.
// ============================================================================

const STALE = "That session changed — refreshing."
const REQUEST_STALE = "That request was already handled — refreshing."
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = Extract<Scoped, { ok: true }>
type Fail = { ok: false; error: string }

function validPaymentMethod(raw: string | null | undefined): { ok: true; value: string | null } | Fail {
  if (!raw) return { ok: true, value: null }
  const value = PAYMENT_METHODS.find((m) => m.value === raw)?.value ?? null
  return value ? { ok: true, value } : fail("Pick a valid payment method.")
}

// ---- start --------------------------------------------------------------------

type StartOutcome =
  | {
      ok: true
      sessionId: string
      deviceCode: string
      flavourName: string
      stationName: string | null
      /** The flavour's price at the moment the session was created (what was charged). */
      price: number
      /** true when this request had already created its session (a retry): nothing was inserted. */
      reused: boolean
    }
  | Fail

async function startSessionCore(
  s: Ctx,
  input: { deviceId: string; productId: string; locationId?: string | null; paymentMethod?: string | null },
  who: { customerId: string | null; phone: string | null },
  sourceRequestId: string | null,
): Promise<StartOutcome> {
  const payment = validPaymentMethod(input.paymentMethod)
  if (!payment.ok) return payment
  const paymentMethod = payment.value

  const [deviceRes, productRes] = await Promise.all([
    s.supabase
      .from("shisha_devices")
      .select("id, device_code, status, location_id")
      .eq("id", input.deviceId)
      .eq("tenant_id", s.tenantId)
      .is("archived_at", null)
      .maybeSingle(),
    s.supabase
      .from("shisha_products")
      .select("id, name, price, is_available")
      .eq("id", input.productId)
      .eq("tenant_id", s.tenantId)
      .is("archived_at", null)
      .maybeSingle(),
  ])
  if (deviceRes.error) return fail(deviceRes.error.message)
  if (productRes.error) return fail(productRes.error.message)

  const device = deviceRes.data as { id: string; device_code: string; status: string; location_id: string | null } | null
  const product = productRes.data as { id: string; name: string; price: number | string; is_available: boolean } | null
  if (!device) return fail("Device not found.")
  if (device.status === "maintenance") return fail("That device is under maintenance.")
  if (!product || !product.is_available) return fail("That flavour isn't available.")

  let settings
  try {
    settings = await loadShishaSettings(s.supabase, s.tenantId)
  } catch {
    return fail("Couldn't load shisha settings.")
  }

  // Station: explicit choice, else the device's usual station, else none.
  // Only active, non-archived stations of THIS tenant count, and that is the
  // same list the start screens offer, so UI and server always agree.
  const { data: stationRows, error: stationError } = await s.supabase
    .from("shisha_locations")
    .select("id, name")
    .eq("tenant_id", s.tenantId)
    .eq("is_active", true)
    .is("archived_at", null)
  if (stationError) return fail(stationError.message)
  const stationNames = new Map(((stationRows ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]))

  let locationId: string | null = null
  if (input.locationId) {
    if (!stationNames.has(input.locationId)) return fail("That station isn't available.")
    locationId = input.locationId
  } else if (device.location_id && stationNames.has(device.location_id)) {
    locationId = device.location_id
  }

  // Required only when the shop can actually offer a station; otherwise
  // nobody could start a session.
  if (settings.requireStation && stationNames.size > 0 && !locationId) {
    return fail("Pick a station for this session.")
  }

  const price = Number(product.price)
  const { data: inserted, error: insertError } = await s.supabase
    .from("shisha_sessions")
    .insert([
      {
        tenant_id: s.tenantId,
        customer_id: who.customerId,
        customer_phone: who.phone,
        device_id: device.id,
        product_id: product.id,
        location_id: locationId,
        remaining_time_seconds: settings.coalDurationMinutes * 60,
        total_amount: price,
        status: "active",
        payment_method: paymentMethod,
        // Paid up front = the session price is settled. Refills add to the balance later.
        paid_amount: paymentMethod ? price : 0,
        source_request_id: sourceRequestId,
      },
    ])
    .select("id")

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      // A retry of the same accepted request: the session already exists. Don't make a second one.
      if (sourceRequestId && insertError.message.includes("source_request")) {
        const { data: existing } = await s.supabase
          .from("shisha_sessions")
          .select("id")
          .eq("tenant_id", s.tenantId)
          .eq("source_request_id", sourceRequestId)
          .maybeSingle()
        if (existing) {
          return {
            ok: true,
            sessionId: (existing as { id: string }).id,
            deviceCode: device.device_code,
            flavourName: product.name,
            stationName: locationId ? (stationNames.get(locationId) ?? null) : null,
            price,
            reused: true,
          }
        }
      }
      // The partial unique index: one live session per device.
      return fail("That device already has a live session.")
    }
    return fail(insertError.message)
  }

  const sessionId = ((inserted ?? []) as Array<{ id: string }>)[0]?.id
  if (!sessionId) return fail("The session couldn't be created.")

  // shisha_devices.status is kept in sync by a database trigger.
  return {
    ok: true,
    sessionId,
    deviceCode: device.device_code,
    flavourName: product.name,
    stationName: locationId ? (stationNames.get(locationId) ?? null) : null,
    price,
    reused: false,
  }
}

export async function startSession(input: {
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
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

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

  const result = await startSessionCore(s, input, { customerId, phone: phone || null }, null)
  return result.ok ? { ok: true } : result
}

// ---- live session loading -----------------------------------------------------

interface LiveSession {
  id: string
  device_id: string | null
  product_id: string | null
  customer_id: string | null
  customer_phone: string | null
  remaining_time_seconds: number
  last_refill_time: string
  /** The paused column OR status = 'paused' (rows paused before the pause fix only had the status). */
  paused: boolean
  refill_count: number
  total_amount: number
  paid_amount: number
  payment_method: string | null
}

const LIVE_COLUMNS =
  "id, device_id, product_id, customer_id, customer_phone, remaining_time_seconds, last_refill_time, paused, status, refill_count, total_amount, paid_amount, payment_method"

function toLiveSession(r: Record<string, unknown>): LiveSession {
  return {
    id: r.id as string,
    device_id: (r.device_id as string | null) ?? null,
    product_id: (r.product_id as string | null) ?? null,
    customer_id: (r.customer_id as string | null) ?? null,
    customer_phone: (r.customer_phone as string | null) ?? null,
    remaining_time_seconds: Number(r.remaining_time_seconds),
    last_refill_time: r.last_refill_time as string,
    paused: Boolean(r.paused) || r.status === "paused",
    refill_count: Number(r.refill_count),
    total_amount: Number(r.total_amount),
    paid_amount: Number(r.paid_amount ?? 0),
    payment_method: (r.payment_method as string | null) ?? null,
  }
}

async function loadLiveSession(supabase: ServerClient, tenantId: string, id: string) {
  const { data, error } = await supabase
    .from("shisha_sessions")
    .select(LIVE_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .maybeSingle()
  return {
    error: error?.message ?? null,
    row: data ? toLiveSession(data as Record<string, unknown>) : null,
  }
}

// ---- pause / resume -----------------------------------------------------------
// status AND the paused column are written together. Before this fix only status
// was written, so pause left paused = false and resume (which needs paused = true)
// always came back as "changed". Guards use status, so rows paused the old way
// can still be resumed.

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
    .update({ status: "paused", paused: true, remaining_time_seconds: remaining })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .in("status", ["active", "refill"])
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
    .update({ status: "active", paused: false, last_refill_time: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", s.tenantId)
    .eq("status", "paused")
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail(STALE)
  return { ok: true }
}

// ---- refill -------------------------------------------------------------------

type RefillOutcome =
  | {
      ok: true
      /** What was added to the bill (0 = free). */
      charge: number
      /** The flavour was archived or deleted, so the refill was free. */
      flavourGone: boolean
      refillCount: number
      /** true when this request had already been refilled (a retry): nothing was charged again. */
      reused: boolean
    }
  | Fail

/** Resets the timer to a full coal duration and adds the flavour's CURRENT refill price
 *  to the bill, atomically (shisha_apply_refill: timer + refill_count + charge + the dated
 *  charge row in one transaction). The refill_count guard is the same optimistic check as
 *  before, so two staff refilling at once can't both win. If the flavour was archived or
 *  deleted the refill is free and the caller is told. */
async function refillSessionCore(s: Ctx, row: LiveSession, requestId: string | null): Promise<RefillOutcome> {
  if (row.paused) return fail("Resume the session before refilling it.")

  let settings
  try {
    settings = await loadShishaSettings(s.supabase, s.tenantId)
  } catch {
    return fail("Couldn't load shisha settings.")
  }

  let price = 0
  let flavourGone = true
  if (row.product_id) {
    const { data, error } = await s.supabase
      .from("shisha_products")
      .select("refill_price, archived_at")
      .eq("id", row.product_id)
      .eq("tenant_id", s.tenantId)
      .maybeSingle()
    if (error) return fail(error.message)
    const product = data as { refill_price: number | string | null; archived_at: string | null } | null
    if (product && product.archived_at === null) {
      price = Number(product.refill_price ?? 0)
      flavourGone = false
    }
  }

  const { data: applied, error: rpcError } = await s.supabase.rpc("shisha_apply_refill", {
    p_tenant_id: s.tenantId,
    p_session_id: row.id,
    p_expected_refills: row.refill_count,
    p_price: price,
    p_duration_seconds: settings.coalDurationMinutes * 60,
    p_request_id: requestId,
  })

  if (rpcError) {
    if (rpcError.code === UNIQUE_VIOLATION && requestId) {
      // This request's refill was already recorded (a retry). The function rolled back, so nothing doubled.
      const { data: prior } = await s.supabase
        .from("shisha_refill_charges")
        .select("amount, sequence_no")
        .eq("tenant_id", s.tenantId)
        .eq("request_id", requestId)
        .maybeSingle()
      if (prior) {
        const p = prior as { amount: number | string; sequence_no: number }
        return { ok: true, charge: Number(p.amount), flavourGone: false, refillCount: p.sequence_no, reused: true }
      }
    }
    return fail(rpcError.message)
  }
  if (applied === null || applied === undefined) return fail(STALE)

  return { ok: true, charge: price, flavourGone, refillCount: Number(applied), reused: false }
}

/** Resets the timer and charges the flavour's refill price (0 = free). */
export async function refillSession(id: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const { row, error } = await loadLiveSession(s.supabase, s.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")

  const result = await refillSessionCore(s, row, null)
  if (!result.ok) return result
  return result.flavourGone
    ? { ok: true, warning: "That flavour has been removed, so this refill was free." }
    : { ok: true }
}

// ---- end ----------------------------------------------------------------------

type EndOutcome = { ok: true; totalAmount: number; balanceAfter: number } | Fail

/** Ends a live session. Payment rules:
 *   - a method is recorded only when one is chosen ("Not recorded" never wipes anything);
 *   - no method on the session yet -> it becomes the payment method and the whole total is settled;
 *   - already prepaid with refills added since -> the method is recorded for the BALANCE
 *     (balance_payment_method) and the total is settled;
 *   - already prepaid in full -> a chosen method is ignored (it can't overwrite the real one). */
async function endSessionCore(s: Ctx, row: LiveSession, paymentMethod: string | null): Promise<EndOutcome> {
  const total = row.total_amount
  const balance = Math.max(Math.round((total - row.paid_amount) * 100) / 100, 0)

  const update: Record<string, unknown> = { status: "completed", ended_at: new Date().toISOString() }
  let balanceAfter = balance
  if (paymentMethod) {
    if (!row.payment_method) {
      update.payment_method = paymentMethod
      update.paid_amount = total
      balanceAfter = 0
    } else if (balance > 0) {
      update.balance_payment_method = paymentMethod
      update.paid_amount = total
      balanceAfter = 0
    }
  }

  const { data, error } = await s.supabase
    .from("shisha_sessions")
    .update(update)
    .eq("id", row.id)
    .eq("tenant_id", s.tenantId)
    .eq("refill_count", row.refill_count) // a refill landing between load and end would change the balance
    .in("status", SHISHA_LIVE_STATUSES)
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail(STALE)
  return { ok: true, totalAmount: total, balanceAfter }
}

export async function endSession(id: string, paymentMethod: string | null): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const payment = validPaymentMethod(paymentMethod)
  if (!payment.ok) return payment

  const { row, error } = await loadLiveSession(s.supabase, s.tenantId, id)
  if (error) return fail(error)
  if (!row) return fail("That session has already ended.")

  const result = await endSessionCore(s, row, payment.value)
  return result.ok ? { ok: true } : result
}

// ============================================================================
// Customer requests (shisha.operate)
//
// A request sits in shisha_requests as 'pending' and blocks that customer from
// sending another. Accept / reject move it out of 'pending' EXACTLY once:
//
//   1. CLAIM  - conditional UPDATE pending -> approved/rejected (.select("id");
//               zero rows = someone else got there first). One winner.
//   2. APPLY  - the shared start/refill/end helper runs. The fee triggers fire
//               inside that statement, so one claim = one effect = one fee.
//   3. ON FAILURE the claim is released (back to pending) so staff can retry or
//               reject. Retrying is safe even if the failed attempt actually
//               landed: sessions carry source_request_id and refill charges carry
//               request_id, both unique.
//   4. NOTIFY - best effort WhatsApp message. A failed send NEVER undoes 1-2; it
//               comes back as `warning`.
// ============================================================================

interface RequestRow {
  id: string
  request_type: ShishaRequestType
  session_id: string | null
  customer_id: string | null
  customer_phone: string | null
  location_name: string | null
  flavour_name: string | null
  device_code: string | null
  amount: number | null
  status: string
}

const REQUEST_COLUMNS =
  "id, request_type, session_id, customer_id, customer_phone, location_name, flavour_name, device_code, amount, status"

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "")

/** The request's session must belong to the person who asked: same customer id, or same phone. */
function sessionBelongsToRequester(session: LiveSession, req: RequestRow): boolean {
  if (session.customer_id && req.customer_id && session.customer_id === req.customer_id) return true
  const a = digits(session.customer_phone)
  const b = digits(req.customer_phone)
  return a !== "" && a === b
}

async function resolveRequestSession(s: Ctx, req: RequestRow): Promise<{ ok: true; row: LiveSession } | Fail> {
  if (req.session_id) {
    const { row, error } = await loadLiveSession(s.supabase, s.tenantId, req.session_id)
    if (error) return fail(error)
    if (!row) return fail("That session has already ended. Reject this request, or ask the customer to send a new one.")
    if (!sessionBelongsToRequester(row, req)) return fail("That session belongs to a different customer. Reject this request.")
    return { ok: true, row }
  }

  // No session stored on the request: use the customer's ONLY live session, never a guess.
  const phone = (req.customer_phone ?? "").replace(/[^0-9+]/g, "")
  const parts: string[] = []
  if (phone) parts.push(`customer_phone.eq.${phone}`)
  if (req.customer_id && UUID_RE.test(req.customer_id)) parts.push(`customer_id.eq.${req.customer_id}`)
  if (parts.length === 0) return fail("This request has no customer details. Reject it.")

  const { data, error } = await s.supabase
    .from("shisha_sessions")
    .select("id")
    .eq("tenant_id", s.tenantId)
    .in("status", SHISHA_LIVE_STATUSES)
    .or(parts.join(","))
  if (error) return fail(error.message)
  const matches = (data ?? []) as Array<{ id: string }>
  if (matches.length === 0) return fail("That customer has no live session. Reject this request.")
  if (matches.length > 1) return fail("More than one live session matches this customer. Handle it from the Sessions tab, then reject this request.")

  const { row, error: loadError } = await loadLiveSession(s.supabase, s.tenantId, matches[0].id)
  if (loadError) return fail(loadError)
  if (!row) return fail("That session has already ended. Reject this request.")
  return { ok: true, row }
}

/** Puts a claimed request back to 'pending' after the effect failed. Only if it is still
 *  OUR claim and nothing was recorded against it. Best effort: a failure here is logged. */
async function releaseClaim(s: Ctx, requestId: string): Promise<void> {
  const { error } = await s.supabase
    .from("shisha_requests")
    .update({ status: "pending", handled_by: null, responded_at: null })
    .eq("id", requestId)
    .eq("tenant_id", s.tenantId)
    .eq("status", "approved")
    .eq("handled_by", s.userId)
    .is("resolved_session_id", null)
  if (error) console.error("[shisha] couldn't release request claim", { tenantId: s.tenantId, requestId, error: error.message })
}

/** Best-effort WhatsApp message. Returns a staff-facing warning when it couldn't be sent. */
async function tellCustomer(s: Ctx, req: RequestRow, text: string, logKey: string): Promise<string | undefined> {
  const sent = await sendShishaCustomerMessage(s.supabase, s.tenantId, req.customer_phone, text, logKey)
  return sent.ok ? undefined : `Done, but the WhatsApp message to the customer couldn't be sent (${sent.reason}).`
}

export async function acceptShishaRequest(input: {
  requestId: string
  /** order_session: which device the customer gets. */
  deviceId?: string
  /** order_session: station chosen by staff; omitted = match the request's station name, then the device's usual one. */
  locationId?: string | null
  /** order_session: a replacement flavour when the requested one is gone. Omitted = the requested flavour. */
  productId?: string
  /** order_session / end_session: how the customer paid, if staff are taking payment now. */
  paymentMethod?: string | null
}): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  const payment = validPaymentMethod(input.paymentMethod)
  if (!payment.ok) return payment

  const { data: reqData, error: reqError } = await s.supabase
    .from("shisha_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", input.requestId)
    .eq("tenant_id", s.tenantId)
    .maybeSingle()
  if (reqError) return fail(reqError.message)
  const req = reqData as RequestRow | null
  if (!req || req.status !== "pending") return fail(REQUEST_STALE)

  if (req.request_type === "order_session" && !input.deviceId) return fail("Pick a device for this session.")

  // 1. CLAIM
  const { data: claimed, error: claimError } = await s.supabase
    .from("shisha_requests")
    .update({ status: "approved", handled_by: s.userId, responded_at: new Date().toISOString() })
    .eq("id", req.id)
    .eq("tenant_id", s.tenantId)
    .eq("status", "pending")
    .select("id")
  if (claimError) return fail(claimError.message)
  if (!claimed || claimed.length === 0) return fail(REQUEST_STALE)

  // 2. APPLY
  let customerText: string
  let logKey: string
  let resolvedSessionId: string | null = null
  let warning: string | undefined

  try {
    if (req.request_type === "order_session") {
      // Flavour: the one staff picked, else the one the customer asked for (by name, in this tenant).
      let productId = input.productId ?? null
      if (!productId) {
        const { data } = await s.supabase
          .from("shisha_products")
          .select("id")
          .eq("tenant_id", s.tenantId)
          .eq("name", req.flavour_name ?? "")
          .eq("is_available", true)
          .is("archived_at", null)
          .maybeSingle()
        productId = (data as { id: string } | null)?.id ?? null
      }
      if (!productId) {
        await releaseClaim(s, req.id)
        return fail(`"${req.flavour_name ?? "That flavour"}" isn't available any more. Pick a replacement flavour, or reject the request.`)
      }

      // Station: staff's pick, else the station name the customer chose, else the device's usual one (core).
      let locationId = input.locationId ?? null
      if (!locationId && req.location_name) {
        const { data } = await s.supabase
          .from("shisha_locations")
          .select("id")
          .eq("tenant_id", s.tenantId)
          .eq("name", req.location_name)
          .eq("is_active", true)
          .is("archived_at", null)
          .maybeSingle()
        locationId = (data as { id: string } | null)?.id ?? null
      }

      const started = await startSessionCore(
        s,
        { deviceId: input.deviceId as string, productId, locationId, paymentMethod: payment.value },
        // Customer identity comes from the REQUEST, never from the browser.
        { customerId: req.customer_id, phone: req.customer_phone },
        req.id,
      )
      if (!started.ok) {
        await releaseClaim(s, req.id)
        return started
      }
      resolvedSessionId = started.sessionId
      customerText = messages.sessionAccepted({
        station: started.stationName,
        flavour: started.flavourName,
        price: started.price,
        quotedPrice: req.amount === null ? null : Number(req.amount),
      })
      logKey = "shisha_session_accepted"
    } else if (req.request_type === "maintenance") {
      const target = await resolveRequestSession(s, req)
      if (!target.ok) {
        await releaseClaim(s, req.id)
        return target
      }
      if (target.row.paused) {
        await releaseClaim(s, req.id)
        return fail("That session is paused. Resume it first, then accept the refill.")
      }
      const refilled = await refillSessionCore(s, target.row, req.id)
      if (!refilled.ok) {
        await releaseClaim(s, req.id)
        return refilled
      }
      resolvedSessionId = target.row.id
      customerText = messages.refillAccepted(refilled.charge)
      logKey = "shisha_refill_accepted"
      if (refilled.flavourGone) warning = "That flavour has been removed, so this refill was free."
    } else if (req.request_type === "end_session") {
      const target = await resolveRequestSession(s, req)
      if (!target.ok) {
        await releaseClaim(s, req.id)
        return target
      }
      const ended = await endSessionCore(s, target.row, payment.value)
      if (!ended.ok) {
        await releaseClaim(s, req.id)
        return ended
      }
      resolvedSessionId = target.row.id
      customerText = messages.sessionClosedByStaff(ended.totalAmount, ended.balanceAfter)
      logKey = "shisha_session_closed"
    } else {
      // issue_report: acknowledge only. No session changes.
      const { data } = await s.supabase
        .from("shisha_requests")
        .select("request_data")
        .eq("id", req.id)
        .eq("tenant_id", s.tenantId)
        .maybeSingle()
      const label = (data as { request_data: { issueLabel?: unknown } | null } | null)?.request_data?.issueLabel
      customerText = messages.issueAcknowledged(typeof label === "string" ? label : null)
      logKey = "shisha_issue_acknowledged"
    }
  } catch (err) {
    console.error("[shisha] acceptShishaRequest failed", { tenantId: s.tenantId, requestId: req.id, error: err })
    await releaseClaim(s, req.id)
    return fail("Something went wrong. The request is back in the list, so you can try again.")
  }

  // 3. RECORD what it produced. Non-critical: the request is already approved.
  if (resolvedSessionId) {
    const { error } = await s.supabase
      .from("shisha_requests")
      .update({ resolved_session_id: resolvedSessionId })
      .eq("id", req.id)
      .eq("tenant_id", s.tenantId)
    if (error) console.error("[shisha] couldn't record resolved_session_id", { tenantId: s.tenantId, requestId: req.id, error: error.message })
  }

  // 4. NOTIFY
  const sendWarning = await tellCustomer(s, req, customerText, logKey)
  const finalWarning = [warning, sendWarning].filter(Boolean).join(" ") || undefined
  return finalWarning ? { ok: true, warning: finalWarning } : { ok: true }
}

export async function rejectShishaRequest(requestId: string, reason?: string): Promise<ShishaActionResult> {
  const s = await scoped("shisha.operate")
  if (!s.ok) return s

  let cleanReason: string | null = null
  if (typeof reason === "string" && reason.trim() !== "") {
    cleanReason = cleanText(reason, 200)
    if (!cleanReason) return fail("The reason must be 200 characters or fewer.")
  }

  const { data: reqData, error: reqError } = await s.supabase
    .from("shisha_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", requestId)
    .eq("tenant_id", s.tenantId)
    .maybeSingle()
  if (reqError) return fail(reqError.message)
  const req = reqData as RequestRow | null
  if (!req || req.status !== "pending") return fail(REQUEST_STALE)

  const { data, error } = await s.supabase
    .from("shisha_requests")
    .update({ status: "rejected", handled_by: s.userId, responded_at: new Date().toISOString(), rejection_reason: cleanReason })
    .eq("id", req.id)
    .eq("tenant_id", s.tenantId)
    .eq("status", "pending")
    .select("id")
  if (error) return fail(error.message)
  if (!data || data.length === 0) return fail(REQUEST_STALE)

  const warning = await tellCustomer(s, req, messages.requestRejected(cleanReason), "shisha_request_rejected")
  return warning ? { ok: true, warning } : { ok: true }
}

// ============================================================================
// Flavours (shisha.manage)
// ============================================================================

export async function addFlavour(input: { name: string; price: number; refillPrice: number }): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Flavour name is required (80 characters max).")
  const price = cleanPrice(input.price)
  if (price === null) return fail("Price must be 0 or more.")
  const refillPrice = cleanPrice(input.refillPrice)
  if (refillPrice === null) return fail("Refill price must be 0 or more (0 = free refill).")

  const { error } = await s.supabase
    .from("shisha_products")
    .insert([{ tenant_id: s.tenantId, name, price, refill_price: refillPrice }])
  if (error) return fail(error.code === UNIQUE_VIOLATION ? `"${name}" already exists.` : error.message)
  return { ok: true }
}

export async function updateFlavour(
  id: string,
  input: { name: string; price: number; refillPrice: number },
): Promise<ShishaActionResult> {
  const s = await scoped("shisha.manage")
  if (!s.ok) return s
  const name = cleanText(input.name, 80)
  if (!name) return fail("Flavour name is required (80 characters max).")
  const price = cleanPrice(input.price)
  if (price === null) return fail("Price must be 0 or more.")
  const refillPrice = cleanPrice(input.refillPrice)
  if (refillPrice === null) return fail("Refill price must be 0 or more (0 = free refill).")

  const { data, error } = await s.supabase
    .from("shisha_products")
    .update({ name, price, refill_price: refillPrice })
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
