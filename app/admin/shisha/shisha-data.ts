// app/admin/shisha/shisha-data.ts
//
// Read side of the shisha tab. Plain server module (no "use server"): it is
// only imported by ./actions.ts. Like the rest of /admin it runs on the
// service-role client, so RLS does not protect these reads. EVERY query below
// carries .eq("tenant_id", tenantId) and that filter is the actual guard.

import type { getSupabaseServerClient } from "@/lib/supabase/admin"
import { loadDisplayContext } from "../admin-data"
import { addDaysKey, dateKeyInTz, startOfDayUtc } from "../tz"
import {
  DEFAULT_COAL_DURATION_MINUTES,
  DEFAULT_REFILL_THRESHOLD_MINUTES,
  DEFAULT_REQUIRE_STATION,
  SHISHA_BILLING_TIMEZONE,
  SHISHA_LIVE_STATUSES,
  type ShishaDevice,
  type ShishaDeviceStatus,
  type ShishaFlavour,
  type ShishaRequest,
  type ShishaRequestType,
  type ShishaSession,
  type ShishaSettings,
  type ShishaSnapshot,
  type ShishaStation,
  type ShishaUsageSummary,
} from "./shisha-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

/** Cap on pending requests sent to the browser. */
const REQUEST_LIMIT = 200

interface RequestRow {
  id: string
  request_type: ShishaRequestType
  session_id: string | null
  customer_id: string | null
  customer_phone: string | null
  location_name: string | null
  flavour_name: string | null
  device_code: string | null
  amount: number | string | null
  request_data: { issueLabel?: string | null } | null
  created_at: string
}

/** One row per tenant; falls back to the column defaults if it doesn't exist yet. */
export async function loadShishaSettings(supabase: ServerClient, tenantId: string): Promise<ShishaSettings> {
  const { data, error } = await supabase
    .from("shisha_settings")
    .select("coal_duration_minutes, refill_threshold_minutes, require_station")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load shisha settings: ${error.message}`)

  return {
    coalDurationMinutes: data?.coal_duration_minutes ?? DEFAULT_COAL_DURATION_MINUTES,
    refillThresholdMinutes: data?.refill_threshold_minutes ?? DEFAULT_REFILL_THRESHOLD_MINUTES,
    requireStation: data?.require_station ?? DEFAULT_REQUIRE_STATION,
  }
}

/** This month's platform fees from the billing ledger. Counted in the platform
 *  billing timezone so it matches shisha_usage_monthly (what gets invoiced).
 *  Never throws: a ledger problem must not take the whole tab down. */
async function loadShishaUsage(supabase: ServerClient, tenantId: string): Promise<ShishaUsageSummary | null> {
  try {
    const todayKey = dateKeyInTz(new Date(), SHISHA_BILLING_TIMEZONE)
    const month = todayKey.slice(0, 7)
    const monthStartKey = `${month}-01`
    // +32 days from the 1st always lands inside the next month.
    const nextMonthStartKey = `${addDaysKey(monthStartKey, 32).slice(0, 7)}-01`

    const { data, error } = await supabase
      .from("shisha_billing_events")
      .select("event_type, fee_amount, currency")
      .eq("tenant_id", tenantId)
      .gte("occurred_at", startOfDayUtc(monthStartKey, SHISHA_BILLING_TIMEZONE).toISOString())
      .lt("occurred_at", startOfDayUtc(nextMonthStartKey, SHISHA_BILLING_TIMEZONE).toISOString())
      .limit(10000)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as any[]
    return {
      month,
      sessions: rows.filter((r) => r.event_type === "session").length,
      refills: rows.filter((r) => r.event_type === "refill").length,
      amount: rows.reduce((sum, r) => sum + Number(r.fee_amount ?? 0), 0),
      currency: rows[0]?.currency || "ZAR",
    }
  } catch (err) {
    console.error("[shisha] loadShishaUsage failed", { tenantId, error: err })
    return null
  }
}

export async function loadShishaSnapshot(
  supabase: ServerClient,
  tenantId: string,
  options: { includeUsage?: boolean } = {},
): Promise<ShishaSnapshot> {
  // The "today" window is the shop's own calendar day, not UTC (same rule as
  // the bookings window in page.tsx).
  const { timezone } = await loadDisplayContext(supabase, tenantId)
  const todayKey = dateKeyInTz(new Date(), timezone)
  const dayStart = startOfDayUtc(todayKey, timezone).toISOString()
  const dayEnd = startOfDayUtc(addDaysKey(todayKey, 1), timezone).toISOString()

  const [settings, usage, shopRes, currencyRes, stationsRes, flavoursRes, devicesRes, liveRes, todayRes, requestsRes] =
    await Promise.all([
    loadShishaSettings(supabase, tenantId),
    // Fee ledger: only for callers allowed to see it (shisha.manage).
    options.includeUsage ? loadShishaUsage(supabase, tenantId) : Promise.resolve(null),
    // Receipt header only; a failure here must not break the tab.
    supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
    supabase
      .from("shisha_locations")
      .select("id, name, is_active, archived_at")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
    supabase
      .from("shisha_products")
      .select("id, name, price, refill_price, is_available, archived_at")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
    supabase
      .from("shisha_devices")
      .select("id, device_code, device_name, location_id, status, archived_at")
      .eq("tenant_id", tenantId)
      .order("device_code", { ascending: true }),
    supabase
      .from("shisha_sessions")
      .select(
        "id, customer_id, customer_phone, device_id, product_id, location_id, start_time, last_refill_time, remaining_time_seconds, total_amount, refill_total, refill_count, paused, payment_method",
      )
      .eq("tenant_id", tenantId)
      .in("status", SHISHA_LIVE_STATUSES)
      .order("start_time", { ascending: true }),
    supabase
      .from("shisha_sessions")
      .select("total_amount")
      .eq("tenant_id", tenantId)
      .gte("created_at", dayStart)
      .lt("created_at", dayEnd)
      .limit(5000),
    // Requests waiting for staff, oldest first (the one waiting longest on top).
    supabase
      .from("shisha_requests")
      .select(
        "id, request_type, session_id, customer_id, customer_phone, location_name, flavour_name, device_code, amount, request_data, created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(REQUEST_LIMIT),
  ])

  if (currencyRes.error) throw new Error(`Failed to load currency: ${currencyRes.error.message}`)
  if (stationsRes.error) throw new Error(`Failed to load stations: ${stationsRes.error.message}`)
  if (flavoursRes.error) throw new Error(`Failed to load flavours: ${flavoursRes.error.message}`)
  if (devicesRes.error) throw new Error(`Failed to load devices: ${devicesRes.error.message}`)
  if (liveRes.error) throw new Error(`Failed to load sessions: ${liveRes.error.message}`)
  if (todayRes.error) throw new Error(`Failed to load today's sessions: ${todayRes.error.message}`)
  if (requestsRes.error) throw new Error(`Failed to load requests: ${requestsRes.error.message}`)

  const stationRows = (stationsRes.data ?? []) as any[]
  const flavourRows = (flavoursRes.data ?? []) as any[]
  const deviceRows = (devicesRes.data ?? []) as any[]
  const liveRows = (liveRes.data ?? []) as any[]
  const requestRows = (requestsRes.data ?? []) as unknown as RequestRow[]

  // Archived rows stay in these lookups: a live session can still point at an
  // archived device / flavour / station and must keep showing its name.
  const stationName = new Map<string, string>(stationRows.map((r) => [r.id, r.name]))
  const flavourName = new Map<string, string>(flavourRows.map((r) => [r.id, r.name]))
  const deviceCode = new Map<string, string>(deviceRows.map((r) => [r.id, r.device_code]))

  // Customer names for linked (non walk-in) sessions and requests only.
  const customerIds = [
    ...new Set(
      [...liveRows.map((r) => r.customer_id), ...requestRows.map((r) => r.customer_id)].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  ]
  const customerName = new Map<string, string | null>()
  if (customerIds.length > 0) {
    const { data, error } = await supabase
      .from("tenant_customers")
      .select("id, full_name")
      .eq("tenant_id", tenantId)
      .in("id", customerIds)
    if (error) throw new Error(`Failed to load customers: ${error.message}`)
    for (const c of (data ?? []) as any[]) customerName.set(c.id, c.full_name ?? null)
  }

  const stations: ShishaStation[] = stationRows
    .filter((r) => r.archived_at === null)
    .map((r) => ({ id: r.id, name: r.name, isActive: r.is_active }))

  const flavours: ShishaFlavour[] = flavourRows
    .filter((r) => r.archived_at === null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      price: Number(r.price),
      refillPrice: Number(r.refill_price ?? 0),
      isAvailable: r.is_available,
    }))

  // What one more refill costs, by flavour id. Archived flavours charge nothing
  // (same rule as refillSession in actions.ts).
  const refillPriceById = new Map<string, number>(
    flavourRows.filter((r) => r.archived_at === null).map((r) => [r.id, Number(r.refill_price ?? 0)]),
  )

  const devices: ShishaDevice[] = deviceRows
    .filter((r) => r.archived_at === null)
    .map((r) => ({
      id: r.id,
      deviceCode: r.device_code,
      deviceName: r.device_name ?? null,
      locationId: r.location_id ?? null,
      status: r.status as ShishaDeviceStatus,
    }))

  const sessions: ShishaSession[] = liveRows.map((r) => ({
    id: r.id,
    customerId: r.customer_id ?? null,
    customerName: r.customer_id ? (customerName.get(r.customer_id) ?? null) : null,
    customerPhone: r.customer_phone ?? null,
    deviceId: r.device_id ?? null,
    deviceCode: (r.device_id && deviceCode.get(r.device_id)) || "No device",
    productId: r.product_id ?? null,
    flavourName: (r.product_id && flavourName.get(r.product_id)) || "No flavour",
    locationId: r.location_id ?? null,
    stationName: (r.location_id && stationName.get(r.location_id)) || null,
    startTime: r.start_time,
    lastRefillTime: r.last_refill_time,
    remainingSeconds: r.remaining_time_seconds,
    totalAmount: Number(r.total_amount),
    refillTotal: Number(r.refill_total ?? 0),
    refillPrice: (r.product_id && refillPriceById.get(r.product_id)) || 0,
    refillCount: r.refill_count,
    paused: r.paused,
    paymentMethod: r.payment_method ?? null,
  }))

  // Pending requests, with what accepting would charge right now.
  const activeFlavourByName = new Map<string, ShishaFlavour>(flavours.map((f) => [f.name, f]))
  const liveSessionById = new Map<string, ShishaSession>(sessions.map((s) => [s.id, s]))
  const requests: ShishaRequest[] = requestRows.map((r) => {
    const live = r.session_id ? (liveSessionById.get(r.session_id) ?? null) : null
    const flavour = r.flavour_name ? (activeFlavourByName.get(r.flavour_name) ?? null) : null
    let currentAmount: number | null = null
    if (r.request_type === "order_session") currentAmount = flavour ? flavour.price : null
    else if (r.request_type === "maintenance") currentAmount = live ? live.refillPrice : null
    else if (r.request_type === "end_session") currentAmount = live ? live.totalAmount : null

    return {
      id: r.id,
      requestType: r.request_type,
      customerId: r.customer_id,
      customerName: r.customer_id ? (customerName.get(r.customer_id) ?? null) : null,
      customerPhone: r.customer_phone,
      stationName: r.location_name,
      flavourName: r.flavour_name,
      deviceCode: r.device_code,
      quotedAmount: r.amount === null ? null : Number(r.amount),
      currentAmount,
      sessionId: r.session_id,
      sessionLive: live !== null,
      sessionPaused: live?.paused ?? false,
      sessionPaymentMethod: live?.paymentMethod ?? null,
      flavourIssue:
        r.request_type !== "order_session"
          ? null
          : !flavour
            ? "missing"
            : !flavour.isAvailable
              ? "out_of_stock"
              : null,
      issueLabel: r.request_type === "issue_report" ? (r.request_data?.issueLabel ?? null) : null,
      createdAt: r.created_at,
    }
  })

  const todayRows = (todayRes.data ?? []) as any[]

  return {
    shopName: ((shopRes.data as any)?.name as string | undefined) ?? "",
    settings,
    currency: (currencyRes.data as any)?.currency || "ZAR",
    stations,
    flavours,
    devices,
    sessions,
    requests,
    today: {
      sessions: todayRows.length,
      revenue: todayRows.reduce((sum, r) => sum + Number(r.total_amount ?? 0), 0),
    },
    usage,
  }
}
