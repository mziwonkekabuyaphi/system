// lib/services/staff-billing.ts
//
// Staff Management as its own sellable product, billed per active staff member per month.
//
// WHO PAYS
//   * A shop that runs Booking, Queue or Shisha gets Staff Management INCLUDED in that
//     package: no Staff invoice, ever.
//   * A shop whose only product is Staff (tenant_modules 'staff' on, Booking/Queue/Shisha off)
//     is invoiced: headcount x the Staff rate, plus add-on lines for Payroll and Shifts when
//     they are switched on and the shop's plan does not already include them.
//
// HEADCOUNT
//   Active staff on the LAST DAY of the billed month, taken from the nightly snapshot
//   (staff_headcount_snapshots). If no snapshot exists for that day the live count is used and
//   the invoice says so in detail.count_source, so it can be checked.
//
// RATES
//   staff_billing_rates: one platform default per module, optional per-shop override.
//
// This file never imports plans.ts at runtime (plans.ts imports it), only its types.

import type { SupabaseClient } from "@supabase/supabase-js"

import type { GeneratedInvoice } from "./plans"

export type StaffBillingKey = "staff" | "payroll" | "shifts"

export const STAFF_BILLING_LABEL: Record<StaffBillingKey, string> = {
  staff: "Staff Management",
  payroll: "Payroll",
  shifts: "Shifts",
}

export interface StaffInvoiceLine {
  key: StaffBillingKey
  label: string
  /** Cents per active staff member per month. */
  rateCents: number
  amountCents: number
}

// ---------------------------------------------------------------------------------------
// Pure calculation (unit-tested)
// ---------------------------------------------------------------------------------------

/**
 * headcount x rate for the Staff line, plus one line per add-on that is switched on and not
 * already included by the shop's plan. Returns null when the Staff rate is missing (we never
 * invoice at a guessed price). An add-on without a rate is left off the invoice, not guessed.
 */
export function computeStaffInvoice(input: {
  headcount: number
  /** Rates in cents per staff member. A missing key means "no rate configured". */
  ratesCents: Partial<Record<StaffBillingKey, number>>
  /** true = switched on AND not included by the shop's plan, so it is charged. */
  chargeAddon: { payroll: boolean; shifts: boolean }
}): { lines: StaffInvoiceLine[]; totalCents: number } | null {
  const headcount = Math.max(0, Math.floor(input.headcount))
  const staffRate = input.ratesCents.staff
  if (staffRate == null || !Number.isFinite(staffRate)) return null

  const keys: StaffBillingKey[] = ["staff"]
  if (input.chargeAddon.payroll) keys.push("payroll")
  if (input.chargeAddon.shifts) keys.push("shifts")

  const lines: StaffInvoiceLine[] = []
  for (const key of keys) {
    const rate = input.ratesCents[key]
    if (rate == null || !Number.isFinite(rate)) continue
    lines.push({ key, label: STAFF_BILLING_LABEL[key], rateCents: rate, amountCents: rate * headcount })
  }
  return { lines, totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0) }
}

// ---------------------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------------------

const toCents = (rands: unknown): number => Math.round(Number(rands) * 100) || 0

interface RateRow {
  tenant_id: string | null
  module_key: StaffBillingKey
  fee_per_staff: number | string
  currency: string
}

/** The shop's own active rate wins over the platform default (tenant_id null). */
export function pickRates(rows: RateRow[], tenantId: string): { ratesCents: Partial<Record<StaffBillingKey, number>>; currency: string } {
  const ratesCents: Partial<Record<StaffBillingKey, number>> = {}
  let currency = "ZAR"
  for (const key of ["staff", "payroll", "shifts"] as const) {
    const own = rows.find((r) => r.module_key === key && r.tenant_id === tenantId)
    const def = rows.find((r) => r.module_key === key && r.tenant_id === null)
    const row = own ?? def
    if (row) {
      ratesCents[key] = toCents(row.fee_per_staff)
      if (key === "staff") currency = row.currency
    }
  }
  return { ratesCents, currency }
}

interface ShopSwitches {
  staff: boolean
  booking: boolean
  queue: boolean
  shisha: boolean
  payroll: boolean
  shifts: boolean
}

async function loadSwitches(supabase: SupabaseClient, tenantIds?: string[]): Promise<Map<string, ShopSwitches>> {
  let query = supabase
    .from("tenant_modules")
    .select("tenant_id, modules!inner(key)")
    .eq("enabled", true)
    .in("modules.key", ["staff", "booking", "queue", "shisha", "payroll", "shifts"])
  if (tenantIds) query = query.in("tenant_id", tenantIds)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load module switches: ${error.message}`)

  const map = new Map<string, ShopSwitches>()
  for (const row of (data ?? []) as any[]) {
    const s = map.get(row.tenant_id) ?? { staff: false, booking: false, queue: false, shisha: false, payroll: false, shifts: false }
    const key = row.modules?.key as keyof ShopSwitches | undefined
    if (key && key in s) s[key] = true
    map.set(row.tenant_id, s)
  }
  return map
}

/** Which of payroll/shifts each plan already includes (plan_modules). */
async function loadPlanIncludes(supabase: SupabaseClient): Promise<Map<string, Set<string>>> {
  const { data, error } = await supabase.from("plan_modules").select("plan_key, modules!inner(key)").in("modules.key", ["payroll", "shifts"])
  if (error) throw new Error(`Failed to load plan modules: ${error.message}`)
  const map = new Map<string, Set<string>>()
  for (const row of (data ?? []) as any[]) {
    const set = map.get(row.plan_key) ?? new Set<string>()
    set.add(row.modules?.key)
    map.set(row.plan_key, set)
  }
  return map
}

/** Staff is the shop's only paid product: switched on, and none of Booking / Queue / Shisha. */
export function isStaffOnly(s: ShopSwitches | undefined): boolean {
  return !!s && s.staff && !s.booking && !s.queue && !s.shisha
}

// ---------------------------------------------------------------------------------------
// Monthly job: Staff invoices for last month
// ---------------------------------------------------------------------------------------

/** Previous completed calendar month as inclusive YYYY-MM-DD dates (same boundaries as the other products). */
function previousMonthDates(): { periodStart: string; periodEnd: string } {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: lastDay.toISOString().slice(0, 10) }
}

export async function generateStaffInvoices(supabase: SupabaseClient): Promise<GeneratedInvoice[]> {
  const { periodStart, periodEnd } = previousMonthDates()

  const { data: tenants, error: tenantsError } = await supabase.from("tenants").select("id, plan").eq("status", "active")
  if (tenantsError) throw new Error(`Failed to load tenants: ${tenantsError.message}`)

  const [switches, planIncludes, ratesRes] = await Promise.all([
    loadSwitches(supabase),
    loadPlanIncludes(supabase),
    supabase.from("staff_billing_rates").select("tenant_id, module_key, fee_per_staff, currency").eq("is_active", true),
  ])
  if (ratesRes.error) throw new Error(`Failed to load staff rates: ${ratesRes.error.message}`)
  const rateRows = (ratesRes.data ?? []) as RateRow[]

  const generated: GeneratedInvoice[] = []

  for (const tenant of (tenants ?? []) as Array<{ id: string; plan: string }>) {
    const sw = switches.get(tenant.id)
    if (!isStaffOnly(sw)) continue // Staff is included in Booking / Queue / Shisha packages

    // Already invoiced for this month, under Staff or under another package: never bill twice.
    const { data: existing, error: existingError } = await supabase
      .from("tenant_invoices")
      .select("id, product")
      .eq("tenant_id", tenant.id)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
    if (existingError) {
      console.error("[staff-billing] couldn't check existing invoices", { tenantId: tenant.id, error: existingError.message })
      continue
    }
    if ((existing ?? []).length > 0) continue

    // Headcount on the last day of the month (nightly snapshot), else the live count.
    const { data: snap } = await supabase
      .from("staff_headcount_snapshots")
      .select("active_staff")
      .eq("tenant_id", tenant.id)
      .eq("snapshot_date", periodEnd)
      .maybeSingle()
    let headcount: number
    let countSource: "snapshot" | "live"
    if (snap) {
      headcount = Number(snap.active_staff)
      countSource = "snapshot"
    } else {
      const { count, error: countError } = await supabase
        .from("staff")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id)
        .eq("active", true)
      if (countError) {
        console.error("[staff-billing] couldn't count staff", { tenantId: tenant.id, error: countError.message })
        continue
      }
      headcount = count ?? 0
      countSource = "live"
      console.warn("[staff-billing] no headcount snapshot for period end, used the live count", { tenantId: tenant.id, periodEnd })
    }
    if (headcount === 0) continue

    const included = planIncludes.get(tenant.plan) ?? new Set<string>()
    const { ratesCents, currency } = pickRates(rateRows, tenant.id)
    const calc = computeStaffInvoice({
      headcount,
      ratesCents,
      chargeAddon: { payroll: !!sw?.payroll && !included.has("payroll"), shifts: !!sw?.shifts && !included.has("shifts") },
    })
    if (!calc) {
      console.error("[staff-billing] no Staff rate configured, not invoicing", { tenantId: tenant.id })
      continue
    }
    if (calc.totalCents <= 0) continue

    const staffLine = calc.lines.find((l) => l.key === "staff")
    const { error: insertError } = await supabase.from("tenant_invoices").insert({
      tenant_id: tenant.id,
      product: "staff",
      plan_key: "staff",
      period_start: periodStart,
      period_end: periodEnd,
      visit_count: 0,
      rate_cents: staffLine?.rateCents ?? 0,
      amount_cents: calc.totalCents,
      currency,
      base_fee_cents: staffLine?.amountCents ?? 0,
      included_visits: null,
      overage_visits: 0,
      staff_count: headcount,
      included_staff: 0,
      extra_staff: 0,
      extra_staff_fee_cents: 0,
      detail: { headcount, count_date: periodEnd, count_source: countSource, lines: calc.lines },
    })
    if (insertError) {
      console.error("[staff-billing] Failed to create staff invoice", { tenantId: tenant.id, periodStart, error: insertError })
      continue
    }

    generated.push({
      tenantId: tenant.id,
      product: "staff",
      visitCount: 0,
      amountCents: calc.totalCents,
      baseFeeCents: staffLine?.amountCents ?? 0,
      extraStaffFeeCents: 0,
      overageVisits: 0,
    })
  }

  return generated
}

// ---------------------------------------------------------------------------------------
// What a Staff-only shop sees on its Billing page
// ---------------------------------------------------------------------------------------

export interface StaffBillingInfo {
  currency: string
  /** Staff members counted today. The invoice counts the LAST DAY of the month. */
  activeStaffNow: number
  lines: Array<{ key: StaffBillingKey; label: string; rateCents: number; amountCents: number }>
  /** What this month would cost at today's headcount. */
  estimateCents: number
}

/** null unless Staff is this shop's only product (everyone else has Staff included). */
export async function loadStaffBilling(supabase: SupabaseClient, tenantId: string): Promise<StaffBillingInfo | null> {
  const [switches, tenantRes, planIncludes, ratesRes, countRes] = await Promise.all([
    loadSwitches(supabase, [tenantId]),
    supabase.from("tenants").select("plan").eq("id", tenantId).single(),
    loadPlanIncludes(supabase),
    supabase.from("staff_billing_rates").select("tenant_id, module_key, fee_per_staff, currency").eq("is_active", true).or(`tenant_id.eq.${tenantId},tenant_id.is.null`),
    supabase.from("staff").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
  ])
  const sw = switches.get(tenantId)
  if (!isStaffOnly(sw)) return null
  if (ratesRes.error) throw new Error(`Failed to load staff rates: ${ratesRes.error.message}`)

  const included = planIncludes.get((tenantRes.data as any)?.plan ?? "") ?? new Set<string>()
  const { ratesCents, currency } = pickRates((ratesRes.data ?? []) as RateRow[], tenantId)
  const headcount = countRes.count ?? 0
  const calc = computeStaffInvoice({
    headcount,
    ratesCents,
    chargeAddon: { payroll: !!sw?.payroll && !included.has("payroll"), shifts: !!sw?.shifts && !included.has("shifts") },
  })
  if (!calc) return null
  return { currency, activeStaffNow: headcount, lines: calc.lines, estimateCents: calc.totalCents }
}
