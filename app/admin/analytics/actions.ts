// app/admin/analytics/actions.ts
"use server"

/**
 * Tenant analytics Server Action.
 *
 * Security model (same as app/admin/actions.ts):
 *  - The tenant ID comes ONLY from requireTenantPermission()'s verified
 *    membership. The client sends a preset/dates/compare flag, nothing else.
 *  - The RPCs (analytics_dashboard / _billing / _payroll) are EXECUTE-granted
 *    to service_role only and take p_tenant_id explicitly, because the
 *    service-role client bypasses RLS. They are not callable by anon or
 *    authenticated roles.
 *  - Each section has its own permission, checked BEFORE its RPC runs:
 *      dashboard -> analytics.view   (required for anything)
 *      billing   -> billing.view
 *      payroll   -> payroll.view
 *    A caller without billing/payroll permission gets `null` for that section;
 *    the data is never queried, not merely hidden.
 *
 * Modules (same idea as Billing): `products` says which of Booking / Queue /
 * Shisha are switched on for the shop (tenant_modules, via getEnabledProducts).
 * The dashboard only shows tabs and figures for modules that are on. Shisha
 * numbers are only queried when Shisha is on AND the caller has shisha.view.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getEnabledProducts } from "@/lib/services/plans"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { loadDisplayContext } from "../admin-data"
import { addDaysKey, dateKeyInTz, startOfDayUtc } from "../tz"
import {
  dayCount,
  previousRange,
  resolveRange,
  type AnalyticsResult,
  type Billing,
  type Ops,
  type Payroll,
  type Preset,
  type Range,
  type ShishaStats,
} from "./model"

const PRESETS: Preset[] = ["7d", "30d", "90d", "custom"]

const SHISHA_PAGE_SIZE = 1000
const SHISHA_MAX_ROWS = 20000 // safety cap: 20 pages

type SupabaseClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

/** Hour (0-23) and weekday (0 = Sunday) of an instant, as seen on the shop's wall clock. */
function localHourAndDow(iso: string, tz: string): { hour: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(iso))
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0)
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun"
  return { hour, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) }
}

/** Shisha activity for one window, from shisha_sessions (sessions STARTED in the window). */
async function loadShishaStats(supabase: SupabaseClient, tenantId: string, range: Range, tz: string): Promise<ShishaStats> {
  const startIso = startOfDayUtc(range.start, tz).toISOString()
  const endIso = startOfDayUtc(range.end, tz).toISOString()

  interface Row {
    created_at: string
    status: string
    total_amount: number | string | null
    refill_total: number | string | null
    refill_count: number | null
    payment_method: string | null
    product_id: string | null
  }
  const rows: Row[] = []
  for (let from = 0; from < SHISHA_MAX_ROWS; from += SHISHA_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("shisha_sessions")
      .select("created_at, status, total_amount, refill_total, refill_count, payment_method, product_id")
      .eq("tenant_id", tenantId)
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: true })
      .range(from, from + SHISHA_PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as Row[]
    rows.push(...page)
    if (page.length < SHISHA_PAGE_SIZE) break
  }

  const { data: products } = await supabase.from("shisha_products").select("id, name").eq("tenant_id", tenantId)
  const productName = new Map((products ?? []).map((p: { id: string; name: string }) => [p.id, p.name]))

  const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0
  const round2 = (v: number) => Math.round(v * 100) / 100

  const days = new Map<string, { sessions: number; refills: number }>()
  for (let i = 0, n = dayCount(range); i < n; i++) days.set(addDaysKey(range.start, i), { sessions: 0, refills: 0 })
  const hours = new Map<number, number>()
  const weekdays = new Map<number, number>()
  const payments = new Map<string, { count: number; amount: number }>()
  const byProduct = new Map<string, { sessions: number; amount: number }>()

  let completed = 0, open = 0, refills = 0, revenue = 0, refillRevenue = 0
  for (const r of rows) {
    const day = days.get(dateKeyInTz(r.created_at, tz))
    const refillCount = num(r.refill_count)
    refills += refillCount
    if (day) { day.sessions += 1; day.refills += refillCount }
    const { hour, dow } = localHourAndDow(r.created_at, tz)
    hours.set(hour, (hours.get(hour) ?? 0) + 1)
    weekdays.set(dow, (weekdays.get(dow) ?? 0) + 1)

    if (r.status === "completed") {
      completed += 1
      revenue += num(r.total_amount)
      refillRevenue += num(r.refill_total)
      const method = r.payment_method || "not recorded"
      const pm = payments.get(method) ?? { count: 0, amount: 0 }
      pm.count += 1; pm.amount += num(r.total_amount)
      payments.set(method, pm)
      const name = (r.product_id && productName.get(r.product_id)) || "Unknown flavour"
      const pr = byProduct.get(name) ?? { sessions: 0, amount: 0 }
      pr.sessions += 1; pr.amount += num(r.total_amount)
      byProduct.set(name, pr)
    } else {
      open += 1
    }
  }

  return {
    sessions_started: rows.length,
    sessions_completed: completed,
    sessions_open: open,
    refills,
    revenue: round2(revenue),
    refill_revenue: round2(refillRevenue),
    avg_session_value: completed === 0 ? null : round2(revenue / completed),
    by_day: [...days.entries()].map(([date, v]) => ({ date, ...v })),
    by_hour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
    by_weekday: [...weekdays.entries()].sort((a, b) => a[0] - b[0]).map(([dow, count]) => ({ dow, count })),
    by_payment: [...payments.entries()].map(([method, v]) => ({ method, count: v.count, amount: round2(v.amount) })).sort((a, b) => b.count - a.count),
    by_product: [...byProduct.entries()].map(([name, v]) => ({ name, sessions: v.sessions, amount: round2(v.amount) })).sort((a, b) => b.sessions - a.sessions),
  }
}

export async function getAnalytics(input: {
  preset: Preset
  from?: string
  to?: string
  compare: boolean
}): Promise<AnalyticsResult> {
  if (!PRESETS.includes(input.preset)) return { ok: false, error: "Invalid reporting period." }

  const base = await requireTenantPermission("analytics.view")
  if (!base.ok) return { ok: false, error: base.error }
  const tenantId = base.member.tenantId

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Supabase isn't configured." }

  try {
    const [{ timezone }, settings, billingCheck, payrollCheck, shishaCheck, enabled] = await Promise.all([
      loadDisplayContext(supabase, tenantId),
      supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
      requireTenantPermission("billing.view"),
      requireTenantPermission("payroll.view"),
      requireTenantPermission("shisha.view"),
      getEnabledProducts(supabase, tenantId),
    ])
    // Which modules this shop runs: the same source Billing uses (tenant_modules).
    const products = { booking: enabled.booking, queue: enabled.queue, shisha: enabled.shisha }
    const wantShisha = products.shisha && shishaCheck.ok

    const resolved = resolveRange(input.preset, timezone, { from: input.from, to: input.to })
    if ("error" in resolved) return { ok: false, error: resolved.error }
    const range: Range = resolved
    const prevRange = input.compare ? previousRange(range) : null

    const args = (r: Range) => ({ p_tenant_id: tenantId, p_start: r.start, p_end: r.end, p_tz: timezone })

    // A failed Shisha query must not blank the dashboard: it becomes null plus a warning.
    const shishaFor = (r: Range) => loadShishaStats(supabase, tenantId, r, timezone).catch((err) => {
      console.error("[analytics] shisha stats failed", { tenantId, error: err instanceof Error ? err.message : err })
      return null
    })

    const [cur, prev, billing, payroll, shisha, shishaPrev] = await Promise.all([
      supabase.rpc("analytics_dashboard", args(range)),
      prevRange ? supabase.rpc("analytics_dashboard", args(prevRange)) : Promise.resolve(null),
      billingCheck.ok ? supabase.rpc("analytics_billing", args(range)) : Promise.resolve(null),
      payrollCheck.ok ? supabase.rpc("analytics_payroll", args(range)) : Promise.resolve(null),
      wantShisha ? shishaFor(range) : Promise.resolve(null),
      wantShisha && prevRange ? shishaFor(prevRange) : Promise.resolve(null),
    ])

    if (cur.error) {
      console.error("[analytics] dashboard rpc failed", { tenantId, error: cur.error.message })
      return { ok: false, error: "Couldn't load analytics. Try again." }
    }
    // A failed comparison shouldn't blank the dashboard; drop it and say so.
    const warnings: string[] = []
    if (prev?.error) {
      console.error("[analytics] comparison rpc failed", { tenantId, error: prev.error.message })
      warnings.push("Comparison data couldn't be loaded.")
    }
    if (billing?.error) {
      console.error("[analytics] billing rpc failed", { tenantId, error: billing.error.message })
      warnings.push("Billing data couldn't be loaded.")
    }
    if (payroll?.error) {
      console.error("[analytics] payroll rpc failed", { tenantId, error: payroll.error.message })
      warnings.push("Payroll data couldn't be loaded.")
    }
    if (wantShisha && !shisha) warnings.push("Shisha data couldn't be loaded.")

    return {
      ok: true,
      timezone,
      currency: settings.data?.currency ?? "ZAR",
      range,
      prevRange: prev && !prev.error ? prevRange : null,
      products,
      current: cur.data as Ops,
      previous: prev && !prev.error ? (prev.data as Ops) : null,
      shisha,
      shishaPrevious: shisha && shishaPrev ? shishaPrev : null,
      billing: billing && !billing.error ? (billing.data as Billing) : null,
      payroll: payroll && !payroll.error ? (payroll.data as Payroll) : null,
      warnings,
    }
  } catch (err) {
    console.error("[analytics] getAnalytics failed", { tenantId, err })
    return { ok: false, error: "Couldn't load analytics. Try again." }
  }
}
