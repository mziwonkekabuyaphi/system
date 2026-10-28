"use server"

// app/display/[slug]/shisha/actions.ts
/**
 * Public, read-only loader for the Shisha TV screen (/display/[slug]/shisha).
 *
 * SECURITY: same posture as app/display/[slug]/actions.ts. The tenant is
 * resolved from (slug, status = 'active') on every call, never from anything
 * the client sends, and every query carries .eq("tenant_id", tenantId) because
 * this runs on the service-role client (RLS does not protect it).
 *
 * PRIVACY BY OMISSION: a field the owner switched off (flavour, station,
 * customer name) is never put in the payload, so it can't be read from the
 * network tab of a public screen. Customer names are first names only.
 *
 * TIMERS: the screen ticks locally each second from the stored anchor
 * (lastRefillTime + remainingSeconds). `serverNow` lets it correct for a TV
 * whose clock is wrong.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { MODULE_KEYS, isTenantModuleEnabled, tenantHasModule } from "@/lib/services/plans"
import {
  SHISHA_DISPLAY_SELECT,
  rowToShishaDisplaySettings,
  type ShishaDisplaySettings,
} from "@/app/admin/shisha/shisha-display-types"
import {
  DEFAULT_COAL_DURATION_MINUTES,
  DEFAULT_REFILL_THRESHOLD_MINUTES,
  SHISHA_LIVE_STATUSES,
} from "@/app/admin/shisha/shisha-types"

export interface ShishaDisplayBranding {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
}

export type ShishaDisplayDeviceState = "live" | "available" | "maintenance"

export interface ShishaDisplaySession {
  /** null when "Show flavour" is off. */
  flavour: string | null
  /** First name. null unless "Show customer first name" is on and the session is linked to a customer. */
  firstName: string | null
  /** Seconds left AT lastRefillTime (frozen value while paused). */
  remainingSeconds: number
  lastRefillTime: string
  paused: boolean
}

export interface ShishaDisplayDevice {
  id: string
  code: string
  name: string | null
  /** null when "Show station" is off. */
  station: string | null
  state: ShishaDisplayDeviceState
  session: ShishaDisplaySession | null
}

export interface ShishaDisplayData {
  /** Server clock (ms) when this payload was built. */
  serverNow: number
  branding: ShishaDisplayBranding
  settings: ShishaDisplaySettings
  timing: { coalDurationMinutes: number; refillThresholdMinutes: number }
  currency: string
  devices: ShishaDisplayDevice[]
  /** Available flavours with prices. Empty unless "Flavour menu in the ticker" is on. */
  menu: Array<{ id: string; name: string; price: number }>
}

export type ShishaDisplayFailure = "not_found" | "shisha_off" | "screen_off" | "error"
export type ShishaDisplayResult = { ok: true; data: ShishaDisplayData } | { ok: false; reason: ShishaDisplayFailure }

type DeviceRow = { id: string; device_code: string; device_name: string | null; location_id: string | null; status: string }
type SessionRow = {
  device_id: string | null
  product_id: string | null
  customer_id: string | null
  last_refill_time: string
  remaining_time_seconds: number
  paused: boolean
}
type NamedRow = { id: string; name: string }
type ProductRow = NamedRow & { price: number | string; is_available: boolean; archived_at: string | null }

const firstNameOf = (full: string | null | undefined): string | null => (full ?? "").trim().split(/\s+/)[0] || null

export async function fetchShishaDisplayData(slug: string): Promise<ShishaDisplayResult> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return { ok: false, reason: "error" }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle()
    if (tenantError) throw new Error(tenantError.message)
    if (!tenant) return { ok: false, reason: "not_found" }
    const tenantId = tenant.id as string

    // Shisha is opt-in and not plan-gated: no tenant_modules row = off.
    if (!(await isTenantModuleEnabled(supabase, tenantId, MODULE_KEYS.shisha, { defaultOn: false, requirePlan: false }))) {
      return { ok: false, reason: "shisha_off" }
    }

    const [settingsRes, brandingRes, timingRes, currencyRes, devicesRes, stationsRes, productsRes, sessionsRes, brandingEntitled] =
      await Promise.all([
        supabase.from("shisha_display_settings").select(SHISHA_DISPLAY_SELECT).eq("tenant_id", tenantId).maybeSingle(),
        supabase
          .from("tenant_branding")
          .select("display_name, logo_url, primary_color, secondary_color")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
        supabase
          .from("shisha_settings")
          .select("coal_duration_minutes, refill_threshold_minutes")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
        supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
        supabase
          .from("shisha_devices")
          .select("id, device_code, device_name, location_id, status")
          .eq("tenant_id", tenantId)
          .is("archived_at", null)
          .order("device_code", { ascending: true }),
        supabase.from("shisha_locations").select("id, name").eq("tenant_id", tenantId),
        supabase.from("shisha_products").select("id, name, price, is_available, archived_at").eq("tenant_id", tenantId),
        supabase
          .from("shisha_sessions")
          .select("device_id, product_id, customer_id, last_refill_time, remaining_time_seconds, paused")
          .eq("tenant_id", tenantId)
          .in("status", SHISHA_LIVE_STATUSES),
        // Logo and brand colour only while the plan includes 'branding' (same rule as the queue display).
        tenantHasModule(supabase, tenantId, MODULE_KEYS.branding).catch(() => false),
      ])

    for (const res of [settingsRes, brandingRes, timingRes, currencyRes, devicesRes, stationsRes, productsRes, sessionsRes]) {
      if (res.error) throw new Error(res.error.message)
    }

    const rawSettings = rowToShishaDisplaySettings(settingsRes.data as unknown as Record<string, unknown> | null)
    if (!rawSettings.isEnabled) return { ok: false, reason: "screen_off" }

    // "custom" background needs branding, otherwise fall back to dark (stored colour is kept).
    const settings: ShishaDisplaySettings =
      brandingEntitled || rawSettings.theme !== "custom"
        ? rawSettings
        : { ...rawSettings, theme: "dark", backgroundColor: null }

    const deviceRows = (devicesRes.data ?? []) as unknown as DeviceRow[]
    const sessionRows = (sessionsRes.data ?? []) as unknown as SessionRow[]
    // Archived flavours stay in the lookup: a live session can still point at one.
    const productRows = (productsRes.data ?? []) as unknown as ProductRow[]
    const stationName = new Map(((stationsRes.data ?? []) as unknown as NamedRow[]).map((r) => [r.id, r.name]))
    const flavourName = new Map(productRows.map((r) => [r.id, r.name]))

    // Customer first names: only fetched when the owner turned them on.
    const customerFirstName = new Map<string, string | null>()
    if (settings.showCustomerName) {
      const ids = [...new Set(sessionRows.map((r) => r.customer_id).filter((id): id is string => Boolean(id)))]
      if (ids.length > 0) {
        const { data, error } = await supabase
          .from("tenant_customers")
          .select("id, full_name")
          .eq("tenant_id", tenantId)
          .in("id", ids)
        if (error) throw new Error(error.message)
        for (const c of (data ?? []) as unknown as Array<{ id: string; full_name: string | null }>) {
          customerFirstName.set(c.id, firstNameOf(c.full_name))
        }
      }
    }

    const sessionByDevice = new Map<string, SessionRow>()
    for (const r of sessionRows) if (r.device_id) sessionByDevice.set(r.device_id, r) // one live session per device (unique index)

    const devices: ShishaDisplayDevice[] = deviceRows.map((d) => {
      const s = sessionByDevice.get(d.id) ?? null
      return {
        id: d.id,
        code: d.device_code,
        name: d.device_name ?? null,
        station: settings.showStation && d.location_id ? (stationName.get(d.location_id) ?? null) : null,
        state: s ? "live" : d.status === "maintenance" ? "maintenance" : "available",
        session: s
          ? {
              flavour: settings.showFlavour && s.product_id ? (flavourName.get(s.product_id) ?? null) : null,
              firstName: s.customer_id ? (customerFirstName.get(s.customer_id) ?? null) : null,
              remainingSeconds: s.remaining_time_seconds,
              lastRefillTime: s.last_refill_time,
              paused: s.paused,
            }
          : null,
      }
    })

    const menu = settings.showMenu
      ? productRows
          .filter((p) => p.archived_at === null && p.is_available)
          .map((p) => ({ id: p.id, name: p.name, price: Number(p.price) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : []

    const timing = timingRes.data as { coal_duration_minutes: number; refill_threshold_minutes: number } | null
    const branding = brandingRes.data as {
      display_name: string | null
      logo_url: string | null
      primary_color: string | null
      secondary_color: string | null
    } | null

    return {
      ok: true,
      data: {
        serverNow: Date.now(),
        branding: {
          displayName: branding?.display_name ?? null,
          logoUrl: brandingEntitled ? (branding?.logo_url ?? null) : null,
          primaryColor: brandingEntitled ? (branding?.primary_color ?? null) : null,
          secondaryColor: brandingEntitled ? (branding?.secondary_color ?? null) : null,
        },
        settings,
        timing: {
          coalDurationMinutes: timing?.coal_duration_minutes ?? DEFAULT_COAL_DURATION_MINUTES,
          refillThresholdMinutes: timing?.refill_threshold_minutes ?? DEFAULT_REFILL_THRESHOLD_MINUTES,
        },
        currency: (currencyRes.data as { currency?: string } | null)?.currency || "ZAR",
        devices,
        menu,
      },
    }
  } catch (error) {
    console.error("[shisha-display] fetchShishaDisplayData failed", { slug, error })
    return { ok: false, reason: "error" }
  }
}
