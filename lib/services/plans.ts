// lib/services/plans.ts
/**
 * Plans & Billing — the tenant-facing subscription layer.
 * ---------------------------------------------------------------
 * Deliberately payments-agnostic: nothing here calls Yoco or any other
 * gateway. `plans.price_cents` is display-only for now. What this DOES
 * do is give the rest of the app a single place to ask:
 *   - "what plan is this tenant on, and what does it include?"
 *   - "has this tenant hit a HARD block on visits?" (Free only — see below)
 *   - "is this module even available on their plan?"
 *   - "what would this tenant's bill look like right now?"
 *
 * A "visit" = one BILLABLE customer interaction: a queue entry that
 * reached 'done', or a booking marked 'completed' that was never
 * promoted into the queue (promoted ones are counted via their queue
 * entry instead — see the migration for why that avoids double-billing).
 *
 * USAGE SOURCE OF TRUTH: the `billable_visits` ledger table, populated by
 * DB triggers (trg_record_queue_billable_visit / trg_record_booking_
 * billable_visit), NOT a live COUNT over `bookings`/`queue_entries`. That
 * used to double-count any tenant with unify_with_queue=true (a booking
 * promoted into a queue entry was counted on both tables). The ledger is
 * idempotent by construction (unique(source, source_id)), so it's now the
 * only place usage is ever computed from.
 *
 * BLOCKING VS. BILLING: only Free (price_per_visit_cents === null) has a
 * hard visit cap — there's no rate to bill overage at, so
 * assertWithinVisitLimit() throws once the 100 lifetime visits are used.
 * Growth and Business both have a price_per_visit_cents, so they NEVER
 * block; usage past visit_limit (Growth) or all usage (Business, whose
 * visit_limit is null) simply becomes billable overage instead. See
 * lib/services/billing-calculator.ts for the actual math.
 *
 * ENFORCEMENT POINTS (see call sites):
 *   - lib/services/booking.ts's createBooking() — checked before insert.
 *   - lib/services/queue.ts's joinQueue() — checked before insert.
 *   Both throw PLAN_VISIT_LIMIT_REACHED on a hard cap; callers (kiosk's
 *   actions.ts, WhatsApp's handlers) already have a catch block pattern
 *   for named errors (see BOOKING_SLOT_NO_LONGER_AVAILABLE) — add a
 *   matching case there for a friendly message.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { calculateBilling, type BillingCalculation } from "./billing-calculator"

export interface Plan {
  key: string
  name: string
  priceCents: number
  currency: string
  visitLimit: number | null // null = unlimited
  /** How visitLimit is counted. 'monthly': resets every calendar month.
   *  'lifetime': a one-time allowance that never resets -- once a tenant
   *  uses it up, they're at their cap for good until they upgrade.
   *  Meaningless when visitLimit is null. */
  visitLimitPeriod: "monthly" | "lifetime"
  staffLimit: number | null // null = unlimited
  pricePerVisitCents: number | null // null = not metered (flat fee or free)
}

export interface PlanUsage {
  plan: Plan
  /** Visits counted toward visitLimit, in whatever window visitLimitPeriod
   *  implies (this calendar month, or all-time for a lifetime plan). This
   *  is the number that atLimit/visitsRemaining are computed from. */
  visitsUsed: number
  /** Visits in the current calendar month specifically -- always this-month
   *  regardless of visitLimitPeriod, since this is what a metered plan's
   *  billing calc is computed from. For a monthly-period capped plan this
   *  is the same number as visitsUsed. */
  visitsThisMonth: number
  visitsRemaining: number | null // null = unlimited (Growth/Business never run out, they bill overage instead)
  /** True only for Free once its 100 lifetime visits are used up -- see
   *  the "BLOCKING VS. BILLING" note above. Always false for Growth/Business. */
  atLimit: boolean
  /** The full base-fee + overage breakdown for the current month, from
   *  the shared calculator. Present for every plan, including Free (where
   *  it's always a R0 total) so the UI has one consistent shape to render. */
  currentBilling: BillingCalculation
}

export interface VisitBreakdown {
  /** Completed queue visits (walk-ins and unified bookings alike --
   *  anything that reached the queue and hit 'done'). */
  queueVisits: number
  /** Completed bookings that were never promoted into the queue. */
  bookingVisits: number
  total: number
}

export const PLAN_VISIT_LIMIT_REACHED = "PLAN_VISIT_LIMIT_REACHED"

function rowToPlan(row: {
  key: string
  name: string
  price_cents: number
  currency: string
  visit_limit: number | null
  visit_limit_period: "monthly" | "lifetime"
  staff_limit: number | null
  price_per_visit_cents: number | null
}): Plan {
  return {
    key: row.key,
    name: row.name,
    priceCents: row.price_cents,
    currency: row.currency,
    visitLimit: row.visit_limit,
    visitLimitPeriod: row.visit_limit_period,
    staffLimit: row.staff_limit,
    pricePerVisitCents: row.price_per_visit_cents,
  }
}

/** All active plans, cheapest first — for a pricing/upgrade screen. */
export async function listPlans(supabase: SupabaseClient): Promise<Plan[]> {
  const { data, error } = await supabase
    .from("plans")
    .select("key, name, price_cents, currency, visit_limit, visit_limit_period, staff_limit, price_per_visit_cents")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })

  if (error) throw new Error(`Failed to load plans: ${error.message}`)
  return (data ?? []).map(rowToPlan)
}

/** The plan a specific tenant is currently on. */
export async function getTenantPlan(supabase: SupabaseClient, tenantId: string): Promise<Plan> {
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("plan")
    .eq("id", tenantId)
    .single()

  if (tenantError) throw new Error(`Failed to resolve tenant's plan: ${tenantError.message}`)

  const { data: plan, error: planError } = await supabase
    .from("plans")
    .select("key, name, price_cents, currency, visit_limit, visit_limit_period, staff_limit, price_per_visit_cents")
    .eq("key", tenant.plan)
    .single()

  if (planError) throw new Error(`Failed to load plan "${tenant.plan}": ${planError.message}`)
  return rowToPlan(plan)
}

/** Module keys included in a given plan, e.g. ["booking", "queue", "kiosk"]. */
export async function getPlanModuleKeys(supabase: SupabaseClient, planKey: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("plan_modules")
    .select("modules(key)")
    .eq("plan_key", planKey)

  if (error) throw new Error(`Failed to load plan modules for "${planKey}": ${error.message}`)
  return (data ?? []).map((row: any) => row.modules?.key).filter((key: string | undefined): key is string => Boolean(key))
}

/** Whether a specific module is allowed on a plan — the check to run
 *  before letting an admin flip a module on in tenant_modules. */
export async function isModuleAllowedForPlan(
  supabase: SupabaseClient,
  planKey: string,
  moduleKey: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("plan_modules")
    .select("plan_key, modules!inner(key)")
    .eq("plan_key", planKey)
    .eq("modules.key", moduleKey)
    .maybeSingle()

  if (error) throw new Error(`Failed to check module entitlement: ${error.message}`)
  return Boolean(data)
}

/** "2026-09" for the current UTC calendar month -- matches how the
 *  billable_visits.billing_period column is populated by the DB triggers,
 *  so counting against it is always an exact string match, not a range
 *  scan with its own timezone-rounding edge cases. */
function currentBillingPeriodUtc(): string {
  const now = new Date()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `${now.getUTCFullYear()}-${month}`
}

/** Count of billable_visits ledger rows for a tenant. Omitting
 *  billingPeriod counts all-time -- used for a lifetime-period plan
 *  (Free), where there's no month to reset against. This is the ONLY
 *  place visit usage is counted from: the ledger is idempotent
 *  (unique(source, source_id) in the DB), so unlike counting raw
 *  bookings+queue_entries directly, a booking that got promoted into the
 *  queue is never counted twice. */
async function countBillableVisits(supabase: SupabaseClient, tenantId: string, billingPeriod?: string): Promise<number> {
  let query = supabase
    .from("billable_visits")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)

  if (billingPeriod) query = query.eq("billing_period", billingPeriod)

  const { count, error } = await query
  if (error) throw new Error(`Failed to count billable visits: ${error.message}`)
  return count ?? 0
}

/** Breakdown of this tenant's current-period visits by source, for the
 *  billing dashboard's "Visit Usage" transparency section. Free (lifetime
 *  period) breaks down all-time instead of the current month, matching
 *  how its visitsUsed is computed below. */
export async function getTenantVisitBreakdown(supabase: SupabaseClient, tenantId: string): Promise<VisitBreakdown> {
  const plan = await getTenantPlan(supabase, tenantId)
  const billingPeriod = plan.visitLimit !== null && plan.visitLimitPeriod === "lifetime" ? undefined : currentBillingPeriodUtc()

  let query = supabase.from("billable_visits").select("source").eq("tenant_id", tenantId)
  if (billingPeriod) query = query.eq("billing_period", billingPeriod)

  const { data, error } = await query
  if (error) throw new Error(`Failed to load visit breakdown: ${error.message}`)

  const rows = data ?? []
  const queueVisits = rows.filter((r) => r.source === "queue_entry").length
  const bookingVisits = rows.filter((r) => r.source === "booking").length
  return { queueVisits, bookingVisits, total: queueVisits + bookingVisits }
}

/** This tenant's usage against their current plan, plus what it would
 *  currently bill to.
 *
 *  A 'monthly' plan resets every calendar month -- visitsUsed is this
 *  month's ledger count. Free's 'lifetime' period never resets --
 *  visitsUsed is the tenant's all-time ledger count, so once they've used
 *  their 100 they stay blocked for good, not just until next month.
 *
 *  visitsThisMonth is always this-month regardless of period, since
 *  currentBilling (Growth/Business overage) is always a this-month figure
 *  -- a lifetime plan's currentBilling is a flat R0, so this distinction
 *  only actually matters once a tenant is on a paid plan.
 *
 *  atLimit is a HARD BLOCK, and only Free can ever hit it: Growth and
 *  Business both have a price_per_visit_cents, so usage past visitLimit
 *  becomes billable overage (see calculateBilling) instead of being
 *  blocked. Free has no rate to bill at, so there's nothing else it CAN
 *  do once the 100 lifetime visits are gone. */
export async function getTenantPlanUsage(supabase: SupabaseClient, tenantId: string): Promise<PlanUsage> {
  const plan = await getTenantPlan(supabase, tenantId)
  const billingPeriod = currentBillingPeriodUtc()

  const visitsThisMonth = await countBillableVisits(supabase, tenantId, billingPeriod)

  let visitsUsed: number
  if (plan.visitLimitPeriod === "lifetime") {
    visitsUsed = await countBillableVisits(supabase, tenantId) // all-time, no billing_period filter
  } else {
    visitsUsed = visitsThisMonth
  }

  const visitsRemaining = plan.visitLimit === null ? null : Math.max(plan.visitLimit - visitsUsed, 0)
  const atLimit = plan.pricePerVisitCents === null && plan.visitLimit !== null && visitsUsed >= plan.visitLimit
  const currentBilling = calculateBilling(plan, visitsThisMonth)

  return { plan, visitsUsed, visitsThisMonth, visitsRemaining, atLimit, currentBilling }
}

/**
 * Call this before creating a booking or queue entry. Throws
 * PLAN_VISIT_LIMIT_REACHED if the tenant's plan cap is hit — callers
 * should catch that named error the same way BOOKING_SLOT_NO_LONGER_
 * AVAILABLE is already handled, and turn it into a customer-facing
 * message (e.g. "This shop has reached its booking limit for this
 * month — please contact them directly.").
 */
export async function assertWithinVisitLimit(supabase: SupabaseClient, tenantId: string): Promise<void> {
  const usage = await getTenantPlanUsage(supabase, tenantId)
  if (usage.atLimit) {
    throw new Error(PLAN_VISIT_LIMIT_REACHED)
  }
}

// ============================================================================
// Monthly invoicing for metered plans (Growth/Business)
// ----------------------------------------------------------------------------
// Called by the cron route (app/api/cron/generate-invoices/route.ts) once a
// month, for the PREVIOUS completed calendar month. Idempotent: re-running
// it for a period that's already been invoiced is a no-op per tenant
// (enforced by tenant_invoices' unique(tenant_id, period_start, period_end)
// constraint), so a retried/duplicated cron trigger can never double-bill.
//
// NO CHARGE IS ACTUALLY COLLECTED HERE. This only creates the invoice row
// (status: 'issued'). Until Yoco is connected, collecting payment and
// marking it 'paid' is a manual step. When Yoco's recurring/charge API is
// wired in, the natural extension is: after inserting each invoice, kick
// off a charge against the tenant's saved payment method, and let the
// webhook flip status to 'paid' -- this function's output doesn't change.
// ============================================================================

export interface GeneratedInvoice {
  tenantId: string
  visitCount: number
  amountCents: number
  baseFeeCents: number
  overageVisits: number
}

/** Previous completed calendar month, as [start, end) in UTC. */
function previousMonthRangeUtc(): { start: Date; end: Date; periodStart: string; periodEnd: string } {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  // period_end stored as the last day of the month (inclusive), not the
  // exclusive boundary used for the query itself.
  const periodEndInclusive = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  return {
    start,
    end,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: periodEndInclusive.toISOString().slice(0, 10),
  }
}

/**
 * Generates (or skips, if already generated) one invoice per tenant on a
 * metered plan for last month's usage. Returns what it created — callers
 * (the cron route) should log this for visibility.
 */
export async function generateMonthlyInvoices(supabase: SupabaseClient): Promise<GeneratedInvoice[]> {
  const { periodStart, periodEnd } = previousMonthRangeUtc()
  const billingPeriod = periodStart.slice(0, 7) // "2026-09-01" -> "2026-09", matches billable_visits.billing_period

  // "Metered" here just means "has a per-visit rate at all" -- Free
  // (price_per_visit_cents null) never gets an invoice row; Growth and
  // Business both do, even in a month with 0 overage, because they still
  // owe their flat base_fee_cents.
  const { data: meteredTenants, error: tenantsError } = await supabase
    .from("tenants")
    .select("id, plan, plans!inner(key, price_cents, currency, visit_limit, visit_limit_period, staff_limit, price_per_visit_cents)")
    .not("plans.price_per_visit_cents", "is", null)

  if (tenantsError) throw new Error(`Failed to load metered tenants: ${tenantsError.message}`)

  const generated: GeneratedInvoice[] = []

  for (const tenant of meteredTenants ?? []) {
    const planRow = (tenant as any).plans as {
      key: string
      price_cents: number
      currency: string
      visit_limit: number | null
      visit_limit_period: "monthly" | "lifetime"
      staff_limit: number | null
      price_per_visit_cents: number
    }
    const tenantId = (tenant as any).id as string

    // Skip if this tenant already has an invoice for this exact period —
    // the unique constraint would reject the insert anyway, but checking
    // first avoids a noisy error on every routine re-run of the cron job.
    const { data: existing } = await supabase
      .from("tenant_invoices")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .maybeSingle()

    if (existing) continue

    // Ledger-backed, not a raw COUNT over bookings+queue_entries -- see
    // the header comment above countBillableVisits for why that matters.
    const visitCount = await countBillableVisits(supabase, tenantId, billingPeriod)

    const plan: Plan = rowToPlan({
      key: planRow.key,
      name: planRow.key, // invoicing only needs the numbers, not the display name
      price_cents: planRow.price_cents,
      currency: planRow.currency,
      visit_limit: planRow.visit_limit,
      visit_limit_period: planRow.visit_limit_period,
      staff_limit: planRow.staff_limit,
      price_per_visit_cents: planRow.price_per_visit_cents,
    })
    const calc = calculateBilling(plan, visitCount)

    if (calc.totalCents === 0) continue // nothing owed at all (shouldn't happen once a plan has a base fee, but stay safe)

    const { error: insertError } = await supabase.from("tenant_invoices").insert([
      {
        tenant_id: tenantId,
        plan_key: planRow.key,
        period_start: periodStart,
        period_end: periodEnd,
        visit_count: visitCount,
        rate_cents: calc.perVisitRateCents ?? 0,
        amount_cents: calc.totalCents,
        base_fee_cents: calc.baseFeeCents,
        included_visits: calc.includedVisits,
        overage_visits: calc.overageVisits,
      },
    ])

    if (insertError) {
      console.error("[plans] Failed to create invoice", { tenantId, periodStart, error: insertError })
      continue
    }

    generated.push({
      tenantId,
      visitCount,
      amountCents: calc.totalCents,
      baseFeeCents: calc.baseFeeCents,
      overageVisits: calc.overageVisits,
    })
  }

  return generated
}
