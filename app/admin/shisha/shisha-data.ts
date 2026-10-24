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
  SHISHA_LIVE_STATUSES,
  type ShishaDevice,
  type ShishaDeviceStatus,
  type ShishaFlavour,
  type ShishaSession,
  type ShishaSettings,
  type ShishaSnapshot,
  type ShishaStation,
} from "./shisha-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

/** One row per tenant; falls back to the column defaults if it doesn't exist yet. */
export async function loadShishaSettings(supabase: ServerClient, tenantId: string): Promise<ShishaSettings> {
  const { data, error } = await supabase
    .from("shisha_settings")
    .select("coal_duration_minutes, refill_threshold_minutes")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load shisha settings: ${error.message}`)

  return {
    coalDurationMinutes: data?.coal_duration_minutes ?? DEFAULT_COAL_DURATION_MINUTES,
    refillThresholdMinutes: data?.refill_threshold_minutes ?? DEFAULT_REFILL_THRESHOLD_MINUTES,
  }
}

export async function loadShishaSnapshot(supabase: ServerClient, tenantId: string): Promise<ShishaSnapshot> {
  // The "today" window is the shop's own calendar day, not UTC (same rule as
  // the bookings window in page.tsx).
  const { timezone } = await loadDisplayContext(supabase, tenantId)
  const todayKey = dateKeyInTz(new Date(), timezone)
  const dayStart = startOfDayUtc(todayKey, timezone).toISOString()
  const dayEnd = startOfDayUtc(addDaysKey(todayKey, 1), timezone).toISOString()

  const [settings, currencyRes, stationsRes, flavoursRes, devicesRes, liveRes, todayRes] = await Promise.all([
    loadShishaSettings(supabase, tenantId),
    supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
    supabase
      .from("shisha_locations")
      .select("id, name, is_active, archived_at")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
    supabase
      .from("shisha_products")
      .select("id, name, price, is_available, archived_at")
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
        "id, customer_id, customer_phone, device_id, product_id, location_id, start_time, last_refill_time, remaining_time_seconds, total_amount, refill_count, paused",
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
  ])

  if (currencyRes.error) throw new Error(`Failed to load currency: ${currencyRes.error.message}`)
  if (stationsRes.error) throw new Error(`Failed to load stations: ${stationsRes.error.message}`)
  if (flavoursRes.error) throw new Error(`Failed to load flavours: ${flavoursRes.error.message}`)
  if (devicesRes.error) throw new Error(`Failed to load devices: ${devicesRes.error.message}`)
  if (liveRes.error) throw new Error(`Failed to load sessions: ${liveRes.error.message}`)
  if (todayRes.error) throw new Error(`Failed to load today's sessions: ${todayRes.error.message}`)

  const stationRows = (stationsRes.data ?? []) as any[]
  const flavourRows = (flavoursRes.data ?? []) as any[]
  const deviceRows = (devicesRes.data ?? []) as any[]
  const liveRows = (liveRes.data ?? []) as any[]

  // Archived rows stay in these lookups: a live session can still point at an
  // archived device / flavour / station and must keep showing its name.
  const stationName = new Map<string, string>(stationRows.map((r) => [r.id, r.name]))
  const flavourName = new Map<string, string>(flavourRows.map((r) => [r.id, r.name]))
  const deviceCode = new Map<string, string>(deviceRows.map((r) => [r.id, r.device_code]))

  // Customer names for linked (non walk-in) sessions only.
  const customerIds = [...new Set(liveRows.map((r) => r.customer_id).filter((id): id is string => Boolean(id)))]
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
    .map((r) => ({ id: r.id, name: r.name, price: Number(r.price), isAvailable: r.is_available }))

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
    paused: r.paused,
  }))

  const todayRows = (todayRes.data ?? []) as any[]

  return {
    settings,
    currency: (currencyRes.data as any)?.currency || "ZAR",
    stations,
    flavours,
    devices,
    sessions,
    today: {
      sessions: todayRows.length,
      revenue: todayRows.reduce((sum, r) => sum + Number(r.total_amount ?? 0), 0),
    },
  }
}
