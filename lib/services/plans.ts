// lib/services/plans.ts
/**
 * Plans & Billing — the tenant-facing subscription layer.
 * ---------------------------------------------------------------
 * Deliberately payments-agnostic: nothing here calls Yoco or any other
 * gateway. `plans.price_cents` is display-only for now. What this DOES
 * do is give the rest of the app a single place to ask:
 *   - "what plan is this tenant on, and what does it include?"
 *   - "has this tenant hit their monthly visit cap?"
 *   - "is this module even available on their plan?"
 *
 * A "visit" = one booking or one queue join. That's the unit that
 * actually costs the platform something (WhatsApp sends, infra), and the
 * natural thing to cap on a free tier. Usage is computed on the fly by
 * counting `bookings` + `queue_entries` created this calendar month —
 * no separate counter table to keep in sync, since tenant volumes here
 * are nowhere near the scale where that COUNT becomes expensive.
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

export interface Plan {
  key: string
  name: string
  priceCents: number
  currency: string
  visitLimit: number | null // null = unlimited
  staffLimit: number | null // null = unlimited
  pricePerVisitCents: number | null // null = not metered (flat fee or free)
}

export interface PlanUsage {
  plan: Plan
  visitsThisMonth: number
  visitsRemaining: number | null // null = unlimited
  atLimit: boolean
  /** Only meaningful for a metered plan -- the running total this month
   *  would cost at month-end if usage stopped right now. Not a final
   *  bill; tenant_invoices is generated after the period actually ends. */
  estimatedAmountCentsThisMonth: number | null
}

export const PLAN_VISIT_LIMIT_REACHED = "PLAN_VISIT_LIMIT_REACHED"

function startOfCurrentMonthUtc(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function rowToPlan(row: {
  key: string
  name: string
  price_cents: number
  currency: string
  visit_limit: number | null
  staff_limit: number | null
  price_per_visit_cents: number | null
}): Plan {
  return {
    key: row.key,
    name: row.name,
    priceCents: row.price_cents,
    currency: row.currency,
    visitLimit: row.visit_limit,
    staffLimit: row.staff_limit,
    pricePerVisitCents: row.price_per_visit_cents,
  }
}

/** All active plans, cheapest first — for a pricing/upgrade screen. */
export async function listPlans(supabase: SupabaseClient): Promise<Plan[]> {
  const { data, error } = await supabase
    .from("plans")
    .select("key, name, price_cents, currency, visit_limit, staff_limit, price_per_visit_cents")
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
    .select("key, name, price_cents, currency, visit_limit, staff_limit, price_per_visit_cents")
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

/** This tenant's usage against their current plan's visit cap. */
export async function getTenantPlanUsage(supabase: SupabaseClient, tenantId: string): Promise<PlanUsage> {
  const plan = await getTenantPlan(supabase, tenantId)
  const monthStart = startOfCurrentMonthUtc()

  const [bookingsResult, queueResult] = await Promise.all([
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", monthStart),
    supabase
      .from("queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", monthStart),
  ])

  if (bookingsResult.error) throw new Error(`Failed to count bookings: ${bookingsResult.error.message}`)
  if (queueResult.error) throw new Error(`Failed to count queue entries: ${queueResult.error.message}`)

  const visitsThisMonth = (bookingsResult.count ?? 0) + (queueResult.count ?? 0)
  const visitsRemaining = plan.visitLimit === null ? null : Math.max(plan.visitLimit - visitsThisMonth, 0)
  const atLimit = plan.visitLimit !== null && visitsThisMonth >= plan.visitLimit
  const estimatedAmountCentsThisMonth =
    plan.pricePerVisitCents === null ? null : visitsThisMonth * plan.pricePerVisitCents

  return { plan, visitsThisMonth, visitsRemaining, atLimit, estimatedAmountCentsThisMonth }
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
  const { start, end, periodStart, periodEnd } = previousMonthRangeUtc()

  const { data: meteredTenants, error: tenantsError } = await supabase
    .from("tenants")
    .select("id, plan, plans!inner(key, price_per_visit_cents)")
    .not("plans.price_per_visit_cents", "is", null)

  if (tenantsError) throw new Error(`Failed to load metered tenants: ${tenantsError.message}`)

  const generated: GeneratedInvoice[] = []

  for (const tenant of meteredTenants ?? []) {
    const planRow = (tenant as any).plans as { key: string; price_per_visit_cents: number }
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

    const [bookingsResult, queueResult] = await Promise.all([
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString()),
      supabase
        .from("queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString()),
    ])

    const visitCount = (bookingsResult.count ?? 0) + (queueResult.count ?? 0)
    if (visitCount === 0) continue // no usage, nothing to bill

    const amountCents = visitCount * planRow.price_per_visit_cents

    const { error: insertError } = await supabase.from("tenant_invoices").insert([
      {
        tenant_id: tenantId,
        plan_key: planRow.key,
        period_start: periodStart,
        period_end: periodEnd,
        visit_count: visitCount,
        rate_cents: planRow.price_per_visit_cents,
        amount_cents: amountCents,
      },
    ])

    if (insertError) {
      console.error("[plans] Failed to create invoice", { tenantId, periodStart, error: insertError })
      continue
    }

    generated.push({ tenantId, visitCount, amountCents })
  }

  return generated
}
