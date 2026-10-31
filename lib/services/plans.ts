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
 * block on visits; usage past the included allowance (visits_per_staff x
 * billed staff) simply becomes billable overage instead. Staff is different:
 * every plan has a hard staff_limit, enforced by staffLimitError() below. See
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
  /** Active staff covered by the base price. Staff beyond this cost extraStaffPriceCents each. */
  includedStaff: number
  /** Monthly cents per active staff member above includedStaff. null = extra staff not offered. */
  extraStaffPriceCents: number | null
  /** Visits included per billed staff member per month. null = flat plan (Free): visitLimit applies as is. */
  visitsPerStaff: number | null
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
  /** Active staff right now (staff.active = true). What the staff limit and extra-staff fee are computed from. */
  staffCount: number
  /** This SHOP's cap on active staff (tenants.staff_limit, not the plan's). null = unlimited. */
  staffLimit: number | null
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
  included_staff: number
  extra_staff_price_cents: number | null
  visits_per_staff: number | null
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
    includedStaff: row.included_staff,
    extraStaffPriceCents: row.extra_staff_price_cents,
    visitsPerStaff: row.visits_per_staff,
  }
}

const PLAN_COLUMNS =
  "key, name, price_cents, currency, visit_limit, visit_limit_period, staff_limit, price_per_visit_cents, included_staff, extra_staff_price_cents, visits_per_staff"

/** All active plans, cheapest first — for a pricing/upgrade screen. */
export async function listPlans(supabase: SupabaseClient): Promise<Plan[]> {
  const { data, error } = await supabase
    .from("plans")
    .select(PLAN_COLUMNS)
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
    .select(PLAN_COLUMNS)
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

/** Keys of the rows in `modules`. Use these instead of string literals so a
 *  typo is a compile error rather than a silently-locked feature. */
export const MODULE_KEYS = {
  booking: "booking",
  queue: "queue",
  whatsapp: "whatsapp",
  liveDashboard: "live_dashboard",
  staffClockIn: "staff_clock_in",
  kiosk: "kiosk",
  display: "display",
  businessHours: "business_hours",
  payroll: "payroll",
  branding: "branding",
  prioritySupport: "priority_support",
  removePoweredBy: "remove_powered_by",
  bookingTicket: "booking_ticket",
  shisha: "shisha",
  shifts: "shifts",
} as const

export type ModuleKey = (typeof MODULE_KEYS)[keyof typeof MODULE_KEYS]

/** The three products a shop can run. Each is an independent on/off switch in
 *  tenant_modules, set by the platform admin. The plan is NOT consulted: a plan
 *  only decides billing tier and add-on features, never which products exist. */
export const PRODUCT_KEYS = ["booking", "queue", "shisha"] as const
export type ProductKey = (typeof PRODUCT_KEYS)[number]

/** Stand-alone switchable modules that are not products: add-ons any shop can
 *  have regardless of which products it runs (a nightclub can have Shifts
 *  without Booking). Same rule as products: tenant_modules only. */
export const ADDON_KEYS = ["shifts", "payroll"] as const
export type AddonKey = (typeof ADDON_KEYS)[number]

/** Is this product / add-on switched on for the shop? The ONE check to use for
 *  Booking, Queue, Shisha, Shifts and Payroll. No tenant_modules row means OFF
 *  (opt-in). Suspended shops are off. Fails closed on any error. */
export async function isProductEnabled(
  supabase: SupabaseClient,
  tenantId: string,
  key: ProductKey | AddonKey,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("tenant_modules")
      .select("enabled, modules!inner(key), tenants!inner(status)")
      .eq("tenant_id", tenantId)
      .eq("modules.key", key)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return false
    return data.enabled === true && (data as any).tenants?.status === "active"
  } catch (err) {
    console.error("[plans] isProductEnabled failed, treating as off", { tenantId, key, error: err })
    return false
  }
}

/** Thrown by assertProductEnabled as `PRODUCT_NOT_ENABLED:<key>`, so callers can
 *  catch it by prefix the same way they catch PLAN_VISIT_LIMIT_REACHED. */
export const PRODUCT_NOT_ENABLED = "PRODUCT_NOT_ENABLED"

export function isProductNotEnabledError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(`${PRODUCT_NOT_ENABLED}:`)
}

/** Hard gate for server code (service layer, server actions). Fails CLOSED. */
export async function assertProductEnabled(
  supabase: SupabaseClient,
  tenantId: string,
  key: ProductKey | AddonKey,
): Promise<void> {
  if (!(await isProductEnabled(supabase, tenantId, key))) throw new Error(`${PRODUCT_NOT_ENABLED}:${key}`)
}

/** All five at once (one query), for page loads that need several. */
export async function getEnabledProducts(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<Record<ProductKey | AddonKey, boolean>> {
  const result = { booking: false, queue: false, shisha: false, shifts: false, payroll: false }
  try {
    const { data, error } = await supabase
      .from("tenant_modules")
      .select("enabled, modules!inner(key), tenants!inner(status)")
      .eq("tenant_id", tenantId)
      .in("modules.key", [...PRODUCT_KEYS, ...ADDON_KEYS])
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as any[]) {
      const key = row.modules?.key as keyof typeof result | undefined
      if (key && key in result) result[key] = row.enabled === true && row.tenants?.status === "active"
    }
  } catch (err) {
    console.error("[plans] getEnabledProducts failed, treating all as off", { tenantId, error: err })
  }
  return result
}

/** The ONLY plan keys a tenant may be moved onto through the normal Booking & Queue
 *  upgrade flow (request AND approval). Deliberately a fixed list, not "any active
 *  row in `plans`": the `shisha` plan is a separate product's placeholder plan
 *  (it contains no booking/queue/kiosk), so applying it to a Booking & Queue shop
 *  would strip that shop's entitlements. Unknown keys are rejected too. */
export const BOOKING_QUEUE_PLAN_KEYS = ["free", "growth", "business"] as const

export function isBookingQueuePlanKey(planKey: unknown): planKey is (typeof BOOKING_QUEUE_PLAN_KEYS)[number] {
  return typeof planKey === "string" && (BOOKING_QUEUE_PLAN_KEYS as readonly string[]).includes(planKey)
}

/** Whether this tenant's CURRENT PLAN includes a module. Plan entitlement
 *  (plan_modules) is the source of truth here, deliberately NOT
 *  tenant_modules: that table is a sparse per-tenant on/off switch that
 *  defaults to false and only has rows for tenants an admin has touched,
 *  so requiring a row there would lock out features the plan already
 *  grants. Upgrades and downgrades take effect immediately because
 *  tenants.plan is the only thing that changes. */
export async function tenantHasModule(supabase: SupabaseClient, tenantId: string, moduleKey: ModuleKey): Promise<boolean> {
  const { data: tenant, error } = await supabase.from("tenants").select("plan").eq("id", tenantId).single()
  if (error) throw new Error(`Failed to resolve tenant's plan: ${error.message}`)
  return isModuleAllowedForPlan(supabase, tenant.plan, moduleKey)
}

/** Plan includes the module AND the tenant hasn't switched it off. For
 *  features an admin can turn on/off themselves: the plan says whether
 *  they're ALLOWED to, tenant_modules says whether they've OPTED OUT (or,
 *  with defaultOn false, whether they've OPTED IN).
 *
 *  defaultOn controls what "no tenant_modules row" means:
 *    true  -> on. The row only exists once an admin has touched the switch,
 *             so an untouched tenant gets whatever their plan includes, and
 *             only an explicit enabled=false turns it off.
 *    false -> off until an admin explicitly enables it (the default).
 *
 *  requirePlan (default true) controls whether the plan check runs at all.
 *  Pass false for modules that are NOT part of any plan and are billed on
 *  their own (shisha): then tenant_modules is the only switch.
 *
 *  A downgrade shuts a plan-gated feature off immediately either way, because
 *  the plan check comes first. Fails closed on any error. */
export async function isTenantModuleEnabled(
  supabase: SupabaseClient,
  tenantId: string,
  moduleKey: ModuleKey,
  options: { defaultOn?: boolean; requirePlan?: boolean } = {},
): Promise<boolean> {
  const defaultOn = options.defaultOn ?? false
  const requirePlan = options.requirePlan ?? true
  try {
    if (requirePlan && !(await tenantHasModule(supabase, tenantId, moduleKey))) return false

    const { data, error } = await supabase
      .from("tenant_modules")
      .select("enabled, modules!inner(key)")
      .eq("tenant_id", tenantId)
      .eq("modules.key", moduleKey)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return defaultOn
    return data.enabled === true
  } catch (err) {
    console.error("[plans] isTenantModuleEnabled failed, treating as disabled", { tenantId, moduleKey, error: err })
    return false
  }
}

/** The kiosk is automatic on every plan that includes it (Growth and
 *  Business): on unless the tenant's admin has explicitly switched it off.
 *  Single definition so the kiosk page, the kiosk server actions and the
 *  admin settings screen can never disagree about what "enabled" means. */
export async function isKioskEnabled(supabase: SupabaseClient, tenantId: string): Promise<boolean> {
  return isTenantModuleEnabled(supabase, tenantId, MODULE_KEYS.kiosk, { defaultOn: true })
}

/** Simple owner on/off switch for features that are NOT plan-gated (Public
 *  display, Staff clock-in). No tenant_modules row = never touched = ON, so
 *  existing shops keep working. Only an explicit enabled=false turns it off.
 *  Fails closed on any error. */
export async function isTenantSwitchedOn(
  supabase: SupabaseClient,
  tenantId: string,
  moduleKey: ModuleKey,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("tenant_modules")
      .select("enabled, modules!inner(key)")
      .eq("tenant_id", tenantId)
      .eq("modules.key", moduleKey)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return true
    return data.enabled === true
  } catch (err) {
    console.error("[plans] isTenantSwitchedOn failed, treating as off", { tenantId, moduleKey, error: err })
    return false
  }
}

/** Thrown by assertTenantHasModule so callers can catch it by name, the
 *  same way PLAN_VISIT_LIMIT_REACHED is handled. */
export const PLAN_MODULE_NOT_AVAILABLE = "PLAN_MODULE_NOT_AVAILABLE"

/** Hard gate for server code (kiosk server actions, API routes). Fails
 *  CLOSED: if the entitlement can't be verified, access is denied. */
export async function assertTenantHasModule(supabase: SupabaseClient, tenantId: string, moduleKey: ModuleKey): Promise<void> {
  const allowed = await tenantHasModule(supabase, tenantId, moduleKey)
  if (!allowed) throw new Error(`${PLAN_MODULE_NOT_AVAILABLE}:${moduleKey}`)
}

/** Whether to render the "Powered by ZozoQueue" label for this tenant.
 *  Fails OPEN, the opposite of the kiosk gate: if the lookup errors, keep
 *  the label so a transient DB hiccup never silently strips attribution
 *  from a tenant who hasn't paid to remove it. */
export async function shouldShowPoweredBy(supabase: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return !(await tenantHasModule(supabase, tenantId, MODULE_KEYS.removePoweredBy))
  } catch (err) {
    console.error("[plans] shouldShowPoweredBy failed, defaulting to showing label", { tenantId, error: err })
    return true
  }
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
  const queueVisits = rows.filter((r: any) => r.source === "queue_entry").length
  const bookingVisits = rows.filter((r: any) => r.source === "booking").length
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

  const staffCount = await countActiveStaff(supabase, tenantId)
  const staffLimit = await getTenantStaffLimit(supabase, tenantId)
  const currentBilling = calculateBilling(plan, visitsThisMonth, staffCount)

  // On per-staff plans the allowance grows with staff (visitsPerStaff x billed
  // staff), so what's left comes from the calculator's includedVisits, not the
  // raw visitLimit. For Free (flat allowance) the two are the same number.
  const allowance = currentBilling.includedVisits
  const visitsRemaining = allowance === null ? null : Math.max(allowance - visitsUsed, 0)
  const atLimit = plan.pricePerVisitCents === null && plan.visitLimit !== null && visitsUsed >= plan.visitLimit

  return { plan, visitsUsed, visitsThisMonth, visitsRemaining, atLimit, currentBilling, staffCount, staffLimit }
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

/** Active staff (staff.active = true) for a tenant. Both the staff limit and
 *  the extra-staff fee count active rows only, so deactivating someone frees a seat. */
async function countActiveStaff(supabase: SupabaseClient, tenantId: string): Promise<number> {
  const { count, error } = await supabase
    .from("staff")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("active", true)

  if (error) throw new Error(`Failed to count active staff: ${error.message}`)
  return count ?? 0
}

/**
 * Call this before adding a staff member or reactivating one. Returns a
 * customer-facing error message when the tenant's plan has no free staff seat,
 * or null when it's fine to proceed (same shape as assertPinAvailable in
 * app/admin/actions.ts, so callers can `if (err) return { ok: false, error: err }`).
 *
 * Only staff_limit is a hard cap. Staff above included_staff but within the
 * limit are allowed and simply billed at extra_staff_price_cents each.
 * Not race-proof: two simultaneous adds can overshoot the limit by one.
 */
export async function staffLimitError(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const limit = await getTenantStaffLimit(supabase, tenantId)
  if (limit === null) return null

  const active = await countActiveStaff(supabase, tenantId)
  if (active < limit) return null

  const noun = limit === 1 ? "staff member" : "staff members"
  return `Your shop allows up to ${limit} active ${noun}. Contact support to raise the limit.`
}

/** The shop's own staff cap (tenants.staff_limit, set by the platform admin).
 *  null = no cap. Deliberately NOT the plan's staff_limit: a plan is a
 *  Booking/Queue billing tier, and a shisha-only shop shouldn't inherit it. */
export async function getTenantStaffLimit(supabase: SupabaseClient, tenantId: string): Promise<number | null> {
  const { data, error } = await supabase.from("tenants").select("staff_limit").eq("id", tenantId).single()
  if (error) throw new Error(`Failed to load staff limit: ${error.message}`)
  return (data.staff_limit as number | null) ?? null
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

export type InvoiceProduct = "booking_queue" | "shisha"

export interface GeneratedInvoice {
  tenantId: string
  /** Which module this invoice bills. Each product is invoiced separately. */
  product: InvoiceProduct
  visitCount: number
  amountCents: number
  baseFeeCents: number
  extraStaffFeeCents: number
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
 * BOOKING & QUEUE invoices: one per tenant on a metered plan for last month.
 *
 * A shop is billed only if it actually runs Booking or Queue: either one of
 * the two is switched ON now (tenant_modules), or it recorded billable visits
 * in the period (it used the product and switched it off before month end).
 * A shisha-only shop, or a shop with both switched off and no usage, gets no
 * Booking & Queue invoice, so it never pays the plan's base fee for a module
 * it doesn't have. Shisha is invoiced separately (generateShishaInvoices).
 */
async function generateBookingQueueInvoices(supabase: SupabaseClient): Promise<GeneratedInvoice[]> {
  const { periodStart, periodEnd } = previousMonthRangeUtc()
  const billingPeriod = periodStart.slice(0, 7) // "2026-09-01" -> "2026-09", matches billable_visits.billing_period

  // "Metered" here just means "has a per-visit rate at all" -- Free
  // (price_per_visit_cents null) never gets an invoice row; Growth and
  // Business both do, even in a month with 0 overage, because they still
  // owe their flat base_fee_cents.
  const { data: meteredTenants, error: tenantsError } = await supabase
    .from("tenants")
    .select(
      "id, plan, plans!inner(key, price_cents, currency, visit_limit, visit_limit_period, staff_limit, price_per_visit_cents, included_staff, extra_staff_price_cents, visits_per_staff)",
    )
    .not("plans.price_per_visit_cents", "is", null)

  if (tenantsError) throw new Error(`Failed to load metered tenants: ${tenantsError.message}`)

  // Tenants with Booking or Queue switched on right now (active shops only).
  const { data: onRows, error: onError } = await supabase
    .from("tenant_modules")
    .select("tenant_id, modules!inner(key), tenants!inner(status)")
    .eq("enabled", true)
    .in("modules.key", ["booking", "queue"])
    .eq("tenants.status", "active")
  if (onError) throw new Error(`Failed to load Booking/Queue switches: ${onError.message}`)
  const runsBookingOrQueue = new Set<string>((onRows ?? []).map((row: any) => row.tenant_id as string))

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
      included_staff: number
      extra_staff_price_cents: number | null
      visits_per_staff: number | null
    }
    const tenantId = (tenant as any).id as string

    // Skip if this tenant already has an invoice for this exact period —
    // the unique constraint would reject the insert anyway, but checking
    // first avoids a noisy error on every routine re-run of the cron job.
    const { data: existing } = await supabase
      .from("tenant_invoices")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("product", "booking_queue")
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .maybeSingle()

    if (existing) continue

    // Ledger-backed, not a raw COUNT over bookings+queue_entries -- see
    // the header comment above countBillableVisits for why that matters.
    const visitCount = await countBillableVisits(supabase, tenantId, billingPeriod)

    // Not a Booking/Queue customer (module off, no usage this period): nothing to bill.
    if (!runsBookingOrQueue.has(tenantId) && visitCount === 0) continue

    const plan: Plan = rowToPlan({
      key: planRow.key,
      name: planRow.key, // invoicing only needs the numbers, not the display name
      price_cents: planRow.price_cents,
      currency: planRow.currency,
      visit_limit: planRow.visit_limit,
      visit_limit_period: planRow.visit_limit_period,
      staff_limit: planRow.staff_limit,
      price_per_visit_cents: planRow.price_per_visit_cents,
      included_staff: planRow.included_staff,
      extra_staff_price_cents: planRow.extra_staff_price_cents,
      visits_per_staff: planRow.visits_per_staff,
    })
    // Staff history isn't stored, so bill the active staff at generation time
    // (the cron runs on the 1st, effectively the end of the month just ended).
    const staffCount = await countActiveStaff(supabase, tenantId)
    const calc = calculateBilling(plan, visitCount, staffCount)

    if (calc.totalCents === 0) continue // nothing owed at all (shouldn't happen once a plan has a base fee, but stay safe)

    const { error: insertError } = await supabase.from("tenant_invoices").insert([
      {
        tenant_id: tenantId,
        product: "booking_queue",
        plan_key: planRow.key,
        period_start: periodStart,
        period_end: periodEnd,
        visit_count: visitCount,
        rate_cents: calc.perVisitRateCents ?? 0,
        amount_cents: calc.totalCents,
        base_fee_cents: calc.baseFeeCents,
        included_visits: calc.includedVisits,
        overage_visits: calc.overageVisits,
        staff_count: calc.staffCount,
        included_staff: calc.includedStaff,
        extra_staff: calc.extraStaff,
        extra_staff_fee_cents: calc.extraStaffFeeCents,
      },
    ])

    if (insertError) {
      console.error("[plans] Failed to create invoice", { tenantId, periodStart, error: insertError })
      continue
    }

    generated.push({
      tenantId,
      product: "booking_queue",
      visitCount,
      amountCents: calc.totalCents,
      baseFeeCents: calc.baseFeeCents,
      extraStaffFeeCents: calc.extraStaffFeeCents,
      overageVisits: calc.overageVisits,
    })
  }

  return generated
}

// ============================================================================
// SHISHA invoices: per-event fees (session / refill), billed monthly
// ----------------------------------------------------------------------------
// Source of truth is shisha_billing_events (written by the shisha service when
// a session starts or is refilled, each row carrying its own fee_amount in
// rands). The plan is NOT involved: Shisha is billed on its own, so a shisha
// shop never pays a Booking & Queue base fee, and a Booking & Queue shop
// never pays shisha fees.
//
// For last month's UNBILLED events, one invoice per tenant is created
// (product = 'shisha', plan_key = 'shisha', base fee 0), then exactly those
// events are marked 'billed' and linked via invoice_ref. 'waived' events are
// never touched. Re-running is safe: tenant_invoices is unique on
// (tenant_id, product, period_start, period_end).
// Shops are invoiced for shisha usage even if Shisha was switched off later:
// the usage happened.
// ============================================================================

const SHISHA_PAGE_SIZE = 1000

/** Rands (numeric from Postgres, may arrive as string) -> whole cents, rounded per event so sums never drift. */
function randsToCents(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** South Africa has no daylight saving: local midnight is always 22:00 UTC the day before. */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000

export async function generateShishaInvoices(supabase: SupabaseClient): Promise<GeneratedInvoice[]> {
  const { start: utcStart, end: utcEnd, periodStart, periodEnd } = previousMonthRangeUtc()
  // Shisha months follow South African time, the same as the shisha_usage_monthly view and the
  // platform Shisha page, so an invoice always matches the "last month" figure people see there.
  const start = new Date(utcStart.getTime() - SAST_OFFSET_MS)
  const end = new Date(utcEnd.getTime() - SAST_OFFSET_MS)

  interface ShishaEventRow {
    id: string
    tenant_id: string
    event_type: "session" | "refill"
    fee_amount: number | string
    currency: string | null
  }

  // Page through every unbilled event of the period (PostgREST caps one response at 1000 rows).
  const events: ShishaEventRow[] = []
  for (let from = 0; ; from += SHISHA_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("shisha_billing_events")
      .select("id, tenant_id, event_type, fee_amount, currency")
      .eq("status", "unbilled")
      .gte("occurred_at", start.toISOString())
      .lt("occurred_at", end.toISOString())
      .order("id", { ascending: true })
      .range(from, from + SHISHA_PAGE_SIZE - 1)

    if (error) throw new Error(`Failed to load shisha billing events: ${error.message}`)
    const page = (data ?? []) as ShishaEventRow[]
    events.push(...page)
    if (page.length < SHISHA_PAGE_SIZE) break
  }

  const byTenant = new Map<string, ShishaEventRow[]>()
  for (const event of events) {
    const list = byTenant.get(event.tenant_id) ?? []
    list.push(event)
    byTenant.set(event.tenant_id, list)
  }

  const generated: GeneratedInvoice[] = []

  for (const [tenantId, rows] of byTenant) {
    const { data: existing } = await supabase
      .from("tenant_invoices")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("product", "shisha")
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .maybeSingle()

    if (existing) {
      console.warn("[plans] Shisha invoice already exists for period, leaving events as they are", { tenantId, periodStart })
      continue
    }

    const sessions = rows.filter((r) => r.event_type === "session")
    const refills = rows.filter((r) => r.event_type === "refill")
    const sessionFeeCents = sessions.reduce((sum, r) => sum + randsToCents(r.fee_amount), 0)
    const refillFeeCents = refills.reduce((sum, r) => sum + randsToCents(r.fee_amount), 0)
    const totalCents = sessionFeeCents + refillFeeCents
    if (totalCents <= 0) continue

    const { data: invoice, error: insertError } = await supabase
      .from("tenant_invoices")
      .insert({
        tenant_id: tenantId,
        product: "shisha",
        plan_key: "shisha",
        period_start: periodStart,
        period_end: periodEnd,
        visit_count: rows.length,
        rate_cents: 0,
        amount_cents: totalCents,
        currency: rows[0].currency ?? "ZAR",
        base_fee_cents: 0,
        included_visits: null,
        overage_visits: 0,
        staff_count: 0,
        included_staff: 0,
        extra_staff: 0,
        extra_staff_fee_cents: 0,
        detail: {
          sessions: sessions.length,
          session_fee_cents: sessionFeeCents,
          refills: refills.length,
          refill_fee_cents: refillFeeCents,
        },
      })
      .select("id")
      .single()

    if (insertError || !invoice) {
      console.error("[plans] Failed to create shisha invoice", { tenantId, periodStart, error: insertError })
      continue
    }

    // Mark exactly the events that went into this invoice (chunked: keeps the URL short).
    const ids = rows.map((r) => r.id)
    for (let i = 0; i < ids.length; i += 200) {
      const { error: markError } = await supabase
        .from("shisha_billing_events")
        .update({ status: "billed", billed_at: new Date().toISOString(), invoice_ref: invoice.id })
        .in("id", ids.slice(i, i + 200))
        .eq("status", "unbilled")
      if (markError) {
        // The invoice exists; these events stay 'unbilled'. Loud on purpose: fix by hand, do not re-run.
        console.error("[plans] Shisha invoice created but events NOT marked billed", { tenantId, invoiceId: invoice.id, error: markError })
      }
    }

    generated.push({
      tenantId,
      product: "shisha",
      visitCount: rows.length,
      amountCents: totalCents,
      baseFeeCents: 0,
      extraStaffFeeCents: 0,
      overageVisits: 0,
    })
  }

  return generated
}

/**
 * Monthly cron entry point (unchanged name and signature, so
 * app/api/cron/generate-invoices/route.ts needs no edit): Booking & Queue
 * invoices plus Shisha invoices. One product failing never stops the other.
 */
export async function generateMonthlyInvoices(supabase: SupabaseClient): Promise<GeneratedInvoice[]> {
  const all: GeneratedInvoice[] = []
  const failures: unknown[] = []
  for (const run of [generateBookingQueueInvoices, generateShishaInvoices]) {
    try {
      all.push(...(await run(supabase)))
    } catch (error) {
      console.error(`[plans] ${run.name} failed`, error)
      failures.push(error)
    }
  }
  // Both products had their turn; now surface the failure so the cron run is not reported as clean.
  if (failures.length > 0) throw failures[0] instanceof Error ? failures[0] : new Error("Invoice generation failed")
  return all
}
