// lib/ai/shop-context.ts
/**
 * Loads the facts the assistant may use to answer a customer's shop question,
 * for ONE tenant, and shapes them into a clean object.
 * ---------------------------------------------------------------------------
 * Same idea as the old Rands `context-builder.ts` (the model never touches the
 * database; something upstream loads the data and hands it over), with two
 * differences: it is tenant-scoped, and the loading lives next to the shaping
 * because QLess has no other caller that needs a different mix of sections.
 *
 * Rules (carried over from the old builder):
 *   - Facts only. No judgements ("busy", "cheap"), no invented defaults.
 *   - Missing data is OMITTED, never sent as null / [] — so the model can tell
 *     "we have no address on file" from "the address is empty".
 *   - Every section loads independently (allSettled): one failed query drops
 *     that section, not the whole answer.
 *   - Strictly read-only. Nothing here writes.
 *
 * Opening hours: business_hours.day_of_week is read as 0 = Sunday … 6 = Saturday
 * (JavaScript's Date#getDay convention). If your admin screen stores Monday as
 * 0, change DAY_NAMES below — it is the only place that assumption lives.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

export type ShopContext = {
  shop?: { name?: string; address?: string; phone?: string; email?: string }
  currency?: string
  timezone?: string
  /** Shop-local "now", so "are you open now / today" is answerable. */
  now?: { date: string; weekday: string; time: string }
  openingHours?: Array<{ day: string; hours: string }>
  services?: Array<{ name: string; price: number; durationMinutes: number }>
  walkInQueue?: {
    peopleWaiting: number
    whatsappJoinAllowed?: boolean
    maxQueueSize?: number
  }
  bookingRules?: { maxAdvanceDays?: number; minNoticeMinutes?: number }
}

function hhmm(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 5) : ""
}

function localNow(timezone: string): ShopContext["now"] {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date())
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      weekday: get("weekday"),
      time: `${get("hour")}:${get("minute")}`,
    }
  } catch {
    return undefined
  }
}

/** Removes undefined / empty sections so the model only sees real data. */
function prune<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) continue
    out[key] = value
  }
  return out as T
}

export async function loadShopContext(tenantId: string): Promise<ShopContext> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return {}

  const [settingsR, tenantR, brandingR, servicesR, hoursR, queueR, queueSettingsR, bookingR, tzR] =
    await Promise.allSettled([
      supabase.from("tenant_settings").select("currency, contact_email, contact_phone, address, brand_name").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      supabase.from("tenant_branding").select("display_name").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("services").select("name, price, duration_minutes").eq("tenant_id", tenantId).eq("active", true).order("name"),
      supabase.from("business_hours").select("day_of_week, is_closed, open_time, close_time").eq("tenant_id", tenantId).order("day_of_week"),
      supabase.from("queue_entries").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).in("status", ["waiting", "called"]),
      supabase.from("queue_settings").select("allow_walkin_whatsapp, max_queue_size").eq("tenant_id", tenantId).maybeSingle(),
      supabase.from("booking_settings").select("max_advance_days, min_notice_minutes").eq("tenant_id", tenantId).maybeSingle(),
      getTenantTimezone(supabase, tenantId),
    ])

  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null)

  const settings = ok(settingsR)?.data ?? null
  const tenantName = ok(tenantR)?.data?.name ?? null
  const displayName = ok(brandingR)?.data?.display_name?.trim() || settings?.brand_name?.trim() || tenantName || undefined

  const serviceRows = ok(servicesR)?.data ?? []
  const hourRows = ok(hoursR)?.data ?? []
  const queueRes = ok(queueR)
  const queueSettings = ok(queueSettingsR)?.data ?? null
  const bookingSettings = ok(bookingR)?.data ?? null
  const timezone = ok(tzR) ?? undefined

  return prune<ShopContext>({
    shop: prune({
      name: displayName,
      address: settings?.address?.trim() || undefined,
      phone: settings?.contact_phone?.trim() || undefined,
      email: settings?.contact_email?.trim() || undefined,
    }),
    currency: settings?.currency || undefined,
    timezone,
    now: timezone ? localNow(timezone) : undefined,
    openingHours: hourRows.map((row) => ({
      day: DAY_NAMES[Number(row.day_of_week)] ?? String(row.day_of_week),
      hours: row.is_closed ? "Closed" : `${hhmm(row.open_time)}–${hhmm(row.close_time)}`,
    })),
    services: serviceRows.map((s) => ({
      name: String(s.name),
      price: Number(s.price),
      durationMinutes: Number(s.duration_minutes),
    })),
    walkInQueue:
      queueRes && !queueRes.error && typeof queueRes.count === "number"
        ? prune({
            peopleWaiting: queueRes.count,
            whatsappJoinAllowed: queueSettings?.allow_walkin_whatsapp ?? undefined,
            maxQueueSize: queueSettings?.max_queue_size ?? undefined,
          })
        : undefined,
    bookingRules: prune({
      maxAdvanceDays: bookingSettings?.max_advance_days ?? undefined,
      minNoticeMinutes: bookingSettings?.min_notice_minutes ?? undefined,
    }),
  })
}
