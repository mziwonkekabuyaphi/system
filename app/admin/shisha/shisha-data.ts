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

  const [settings, usage, shopRes, currencyRes, stationsRes, flavoursRes, devicesRes, liveRes, todayRes, refillsTodayRes, requestsRes] =
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
        "id, customer_id, customer_phone, device_id, product_id, location_id, start_time, last_refill_time, remaining_time_seconds, total_amount, refill_count, paused, status, payment_method, refill_total, paid_amount, balance_payment_method",
      )
      .eq("tenant_id", tenantId)
      .in("status", SHISHA_LIVE_STATUSES)
      .order("start_time", { ascending: true }),
    supabase
      .from("shisha_sessions")
      .select("total_amount, refill_total")
      .eq("tenant_id", tenantId)
      .gte("created_at", dayStart)
      .lt("created_at", dayEnd)
      .limit(5000),
    // Refill money is dated by WHEN the refill happened, not when the session started.
    supabase
      .from("shisha_refill_charges")
      .select("amount")
      .eq("tenant_id", tenantId)
      .gte("occurred_at", dayStart)
      .lt("occurred_at", dayEnd)
      .limit(5000),
    // Pending requests only, oldest first.
    supabase
      .from("shisha_requests")
      .select(
        "id, request_type, customer_id, customer_phone, location_name, flavour_name, device_code, amount, session_id, request_data, created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(200),
  ])

  if (currencyRes.error) throw new Error(`Failed to load currency: ${currencyRes.error.message}`)
  if (stationsRes.error) throw new Error(`Failed to load stations: ${stationsRes.error.message}`)
  if (flavoursRes.error) throw new Error(`Failed to load flavours: ${flavoursRes.error.message}`)
  if (devicesRes.error) throw new Error(`Failed to load devices: ${devicesRes.error.message}`)
  if (liveRes.error) throw new Error(`Failed to load sessions: ${liveRes.error.message}`)
  if (todayRes.error) throw new Error(`Failed to load today's sessions: ${todayRes.error.message}`)
  if (refillsTodayRes.error) throw new Error(`Failed to load today's refills: ${refillsTodayRes.error.message}`)
  if (requestsRes.error) throw new Error(`Failed to load requests: ${requestsRes.error.message}`)

  const stationRows = (stationsRes.data ?? []) as any[]
  const flavourRows = (flavoursRes.data ?? []) as any[]
  const deviceRows = (devicesRes.data ?? []) as any[]
  const liveRows = (liveRes.data ?? []) as any[]
  const requestRows = (requestsRes.data ?? []) as any[]

  // Archived rows stay in these lookups: a live session can still point at an
  // archived device / flavour / station and must keep showing its name.
  const stationName = new Map<string, string>(stationRows.map((r) => [r.id, r.name]))
  const flavourName = new Map<string, string>(flavourRows.map((r) => [r.id, r.name]))
  const deviceCode = new Map<string, string>(deviceRows.map((r) => [r.id, r.device_code]))

  // Customer names for linked (non walk-in) sessions and requests only.
  const customerIds = [
    ...new Set([...liveRows, ...requestRows].map((r) => r.customer_id).filter((id): id is string => Boolean(id))),
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
    refillCount: r.refill_count,
    // The paused column and status are written together now; treating either as paused
    // also keeps any row paused before that fix correct.
    paused: Boolean(r.paused) || r.status === "paused",
    paymentMethod: r.payment_method ?? null,
    refillTotal: Number(r.refill_total ?? 0),
    paidAmount: Number(r.paid_amount ?? 0),
    balancePaymentMethod: r.balance_payment_method ?? null,
  }))

  // Current prices, resolved by name within this tenant (the request only stores names).
  const priceByName = new Map(flavours.map((f) => [f.name, f]))
  const flavourById = new Map(flavours.map((f) => [f.id, f]))
  const sessionById = new Map(sessions.map((s) => [s.id, s]))

  const requests: ShishaRequest[] = requestRows.map((r) => {
    const type = r.request_type as ShishaRequestType
    let currentPrice: number | null = null
    if (type === "order_session") {
      currentPrice = priceByName.get(r.flavour_name)?.price ?? null
    } else if (type === "maintenance") {
      // Prefer the live session's own flavour (the name on the request may have been renamed).
      const live = r.session_id ? sessionById.get(r.session_id) : undefined
      const flavour = (live?.productId && flavourById.get(live.productId)) || priceByName.get(r.flavour_name)
      currentPrice = flavour ? flavour.refillPrice : null
    }
    return {
      id: r.id,
      requestType: type,
      customerId: r.customer_id ?? null,
      customerName: r.customer_id ? (customerName.get(r.customer_id) ?? null) : null,
      customerPhone: r.customer_phone ?? null,
      locationName: r.location_name ?? null,
      flavourName: r.flavour_name ?? null,
      deviceCode: r.device_code ?? null,
      quotedAmount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      currentPrice,
      sessionId: r.session_id ?? null,
      issueLabel: typeof r.request_data?.issueLabel === "string" ? r.request_data.issueLabel : null,
      createdAt: r.created_at,
    }
  })

  const todayRows = (todayRes.data ?? []) as any[]
  const refillsTodayRows = (refillsTodayRes.data ?? []) as any[]

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
      // Session price for sessions started today, plus refill money taken today (even on an
      // older session). total_amount alone would put today's refills on the session's start day.
      revenue:
        todayRows.reduce((sum, r) => sum + Number(r.total_amount ?? 0) - Number(r.refill_total ?? 0), 0) +
        refillsTodayRows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0),
    },
    usage,
  }
}
