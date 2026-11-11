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
 * Modules: `products` says which of Booking / Queue / Shisha / Shifts / Payroll are
 * effectively on for the shop (own switch AND parents, via getEffectiveModules: the same
 * resolver the admin pages use). The dashboard only shows tabs and figures for modules that
 * are on. Shisha numbers are only queried when Shisha is on AND the caller has shisha.view;
 * Payroll numbers only when Payroll is on AND the caller has payroll.view. VVIP numbers only
 * when VVIP is on (which needs Events, which needs Passport) AND the caller has vvip.view.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getEffectiveModules } from "@/lib/tenant/effective-modules"
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
  type VvipStats,
} from "./model"

const PRESETS: Preset[] = ["7d", "30d", "90d", "custom"]

const VVIP_MAX_ROWS = 5000
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

/** VVIP activity for one window: bookings CREATED in the window, plus tab spend posted in it. */
async function loadVvipStats(supabase: SupabaseClient, tenantId: string, range: Range, tz: string): Promise<VvipStats> {
  const startIso = startOfDayUtc(range.start, tz).toISOString()
  const endIso = startOfDayUtc(range.end, tz).toISOString()
  const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0
  const round2 = (v: number) => Math.round(v * 100) / 100

  const [bk, live, spend, pk] = await Promise.all([
    supabase.from("vvip_bookings")
      .select("created_at, status, price_paid, refunded_amount, tab_credit_issued, payment_method, package_id")
      .eq("tenant_id", tenantId).gte("created_at", startIso).lt("created_at", endIso).limit(VVIP_MAX_ROWS),
    supabase.from("vvip_bookings").select("tab_balance")
      .eq("tenant_id", tenantId).in("status", ["confirmed", "checked_in", "seated"]).limit(VVIP_MAX_ROWS),
    supabase.from("vvip_tab_ledger").select("amount")
      .eq("tenant_id", tenantId).eq("direction", "debit").eq("entry_type", "spend")
      .gte("created_at", startIso).lt("created_at", endIso).limit(VVIP_MAX_ROWS),
    supabase.from("vvip_packages").select("id, name").eq("tenant_id", tenantId),
  ])
  for (const r of [bk, live, spend, pk]) if (r.error) throw new Error(r.error.message)

  const pkgName = new Map((pk.data ?? []).map((p: { id: string; name: string }) => [p.id, p.name]))
  const days = new Map<string, { bookings: number; revenue: number }>()
  for (let i = 0, n = dayCount(range); i < n; i++) days.set(addDaysKey(range.start, i), { bookings: 0, revenue: 0 })
  const byPkg = new Map<string, { bookings: number; revenue: number }>()
  const byPay = new Map<string, { count: number; amount: number }>()
  const byStatus = new Map<string, number>()

  let active = 0, completed = 0, cancelled = 0, noShow = 0, revenue = 0, refunded = 0, tabIssued = 0
  for (const r of (bk.data ?? []) as { created_at: string; status: string; price_paid: unknown; refunded_amount: unknown; tab_credit_issued: unknown; payment_method: string | null; package_id: string | null }[]) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    refunded += num(r.refunded_amount as number)
    if (r.status === "cancelled") { cancelled += 1; continue }
    if (r.status === "no_show") { noShow += 1; continue }
    active += 1
    if (r.status === "completed") completed += 1
    const paid = num(r.price_paid as number)
    revenue += paid
    tabIssued += num(r.tab_credit_issued as number)
    const d = days.get(dateKeyInTz(r.created_at, tz))
    if (d) { d.bookings += 1; d.revenue += paid }
    const name = (r.package_id && pkgName.get(r.package_id)) || "Removed package"
    const pp = byPkg.get(name) ?? { bookings: 0, revenue: 0 }
    pp.bookings += 1; pp.revenue += paid; byPkg.set(name, pp)
    const m = r.payment_method || "not recorded"
    const pm = byPay.get(m) ?? { count: 0, amount: 0 }
    pm.count += 1; pm.amount += paid; byPay.set(m, pm)
  }

  return {
    bookings: (bk.data ?? []).length,
    active_bookings: active,
    completed,
    cancelled,
    no_show: noShow,
    revenue: round2(revenue),
    refunded: round2(refunded),
    tab_issued: round2(tabIssued),
    tab_spent: round2((spend.data ?? []).reduce((a: number, r: { amount: unknown }) => a + num(r.amount as number), 0)),
    tab_outstanding: round2((live.data ?? []).reduce((a: number, r: { tab_balance: unknown }) => a + num(r.tab_balance as number), 0)),
    by_day: [...days.entries()].map(([date, v]) => ({ date, bookings: v.bookings, revenue: round2(v.revenue) })),
    by_package: [...byPkg.entries()].map(([name, v]) => ({ name, bookings: v.bookings, revenue: round2(v.revenue) })).sort((a, b) => b.bookings - a.bookings),
    by_payment: [...byPay.entries()].map(([method, v]) => ({ method, count: v.count, amount: round2(v.amount) })).sort((a, b) => b.count - a.count),
    by_status: [...byStatus.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
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
    const [{ timezone }, settings, billingCheck, payrollCheck, shishaCheck, vvipCheck, mods] = await Promise.all([
      loadDisplayContext(supabase, tenantId),
      supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
      requireTenantPermission("billing.view"),
      requireTenantPermission("payroll.view"),
      requireTenantPermission("shisha.view"),
      requireTenantPermission("vvip.view"),
      getEffectiveModules(tenantId),
    ])
    // Which modules this shop runs (effective state, so a module whose parent is off counts as off).
    const products = {
      booking: mods.on("booking"),
      queue: mods.on("queue"),
      shisha: mods.on("shisha"),
      // Shift hours are recorded by the Shifts add-on and by Staff clock-in.
      shifts: mods.on("shifts") || mods.on("staff_clock_in"),
      payroll: mods.on("payroll"),
      vvip: mods.on("vvip"),
    }
    const wantShisha = products.shisha && shishaCheck.ok
    const wantVvip = products.vvip && vvipCheck.ok

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

    const vvipFor = () => loadVvipStats(supabase, tenantId, range, timezone).catch((err) => {
      console.error("[analytics] vvip stats failed", { tenantId, error: err instanceof Error ? err.message : err })
      return null
    })

    const [cur, prev, billing, payroll, shisha, shishaPrev, vvip] = await Promise.all([
      supabase.rpc("analytics_dashboard", args(range)),
      prevRange ? supabase.rpc("analytics_dashboard", args(prevRange)) : Promise.resolve(null),
      billingCheck.ok ? supabase.rpc("analytics_billing", args(range)) : Promise.resolve(null),
      payrollCheck.ok && products.payroll ? supabase.rpc("analytics_payroll", args(range)) : Promise.resolve(null),
      wantShisha ? shishaFor(range) : Promise.resolve(null),
      wantShisha && prevRange ? shishaFor(prevRange) : Promise.resolve(null),
      wantVvip ? vvipFor() : Promise.resolve(null),
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
    if (wantVvip && !vvip) warnings.push("VVIP data couldn't be loaded.")

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
      vvip,
      billing: billing && !billing.error ? (billing.data as Billing) : null,
      payroll: payroll && !payroll.error ? (payroll.data as Payroll) : null,
      warnings,
    }
  } catch (err) {
    console.error("[analytics] getAnalytics failed", { tenantId, err })
    return { ok: false, error: "Couldn't load analytics. Try again." }
  }
}
