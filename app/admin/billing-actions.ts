"use server"

// app/admin/billing-actions.ts
/**
 * Server Actions backing the admin's Plans & Billing panel.
 *
 * Same access pattern as the rest of app/admin/actions.ts:
 * requireTenantMember() gates every call, tenantId is re-resolved from
 * the session rather than trusted from the client. Billing has no
 * dedicated permission key in `permissions` (unlike the bookings.view /
 * queue.view style permission checks elsewhere) --
 * membership alone is enough, matching tenant_invoices' own RLS policy
 * (is_platform_admin() OR is_tenant_member(tenant_id), no permission
 * check). If that ever needs to change (e.g. a bookkeeper role that
 * shouldn't see billing), add a `billing.view` permission row and swap
 * requireTenantMember() for requireTenantPermission("billing.view") here
 * -- don't invent the check without the matching DB row and RLS update.
 *
 * NO PAYMENT PROCESSING HAPPENS HERE. There's no Yoco integration yet.
 * requestPlanUpgrade() just drops a row in plan_upgrade_requests for the
 * platform admin to action by hand (flip tenants.plan directly in
 * Supabase, or via a future platform-admin panel). When Yoco is wired
 * in, the natural next step is: this same request flow kicks off a
 * checkout session, and a webhook on success does what the manual
 * approval does today — update tenants.plan and mark the request
 * resolved. Nothing here needs to be thrown away for that to happen.
 *
 * BILLING STATUS is derived, not stored -- there's no tenants.billing_
 * status column, so deriveBillingStatus() below reads the same three
 * facts a human would (is the tenant active, are they on Free, what did
 * their last invoice do) rather than inventing a new source of truth
 * that could drift out of sync with the data it's summarizing.
 */

import { revalidatePath } from "next/cache"
import { EVENT_ADDONS, ORDER_ADDONS, type AddonCharge } from "@/lib/services/addons"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import {
  listPlans,
  getTenantPlan,
  getTenantPlanUsage,
  getTenantVisitBreakdown,
  getBillableModules,
  addonChargesFor,
  staffBilledPerHead,
  countOrdersInRange,
  countTicketsInRange,
  type BillableModules,
  isBookingQueuePlanKey,
  type Plan,
  type PlanUsage,
  type VisitBreakdown,
} from "@/lib/services/plans"

type ActionResult = { ok: true } | { ok: false; error: string }

async function getTenantScopedClient() {
  const { tenantId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) return { supabase: null, tenantId: null, error: "Supabase isn't configured." }
  return { supabase, tenantId, error: undefined as string | undefined }
}

export type InvoiceProduct = "booking_queue" | "shisha" | "staff" | "orders" | "events"

export interface TenantInvoice {
  id: string
  /** Which module this invoice bills. Older rows are all Booking & Queue. */
  product: InvoiceProduct
  /** Shisha invoices: { sessions, session_fee_cents, refills, refill_fee_cents }. null otherwise. */
  detail: { addons?: AddonCharge[]; addons_cents?: number; orders?: number; included_orders?: number; overage_orders?: number; usage_fee_cents?: number; tickets?: number; fee_per_ticket_cents?: number; staff?: number; fee_per_staff_cents?: number; sessions?: number; session_fee_cents?: number; refills?: number; refill_fee_cents?: number } | null
  periodStart: string
  periodEnd: string
  visitCount: number
  rateCents: number
  amountCents: number
  currency: string
  status: string
  /** Flat monthly platform fee on this invoice. 0 for anything issued before this column existed. */
  baseFeeCents: number
  /** Visits included in the base fee at the time this was issued. null = no included allotment. */
  includedVisits: number | null
  /** visitCount beyond includedVisits -- what rateCents actually got multiplied by. */
  overageVisits: number
  /** Active staff counted when this was issued. 0 for anything issued before per-staff pricing. */
  staffCount: number
  /** Staff covered by the base fee at the time. */
  includedStaff: number
  /** staffCount beyond includedStaff. */
  extraStaff: number
  /** extraStaff x the plan's per-extra-staff price at the time, in cents. */
  extraStaffFeeCents: number
}

/** Derived, not stored -- see the file header for why. Ordered roughly by
 *  how alarming it is, for a UI that wants to sort or prioritize by it. */
export type BillingStatus = "active" | "trial_free" | "payment_due" | "overdue" | "cancelled"

function deriveBillingStatus(
  tenantStatus: string,
  planKey: string,
  invoices: TenantInvoice[],
  runsBookingQueue: boolean,
): BillingStatus {
  if (tenantStatus !== "active") return "cancelled"
  // "Free plan" only describes a shop that actually runs Booking or Queue; a shisha-only shop
  // sits on the free plan row but is billed through its Shisha invoices.
  if (planKey === "free" && runsBookingQueue) return "trial_free"
  // Latest month across ALL products decides: any overdue wins, then any issued.
  const latestStart = invoices[0]?.periodStart
  const latest = invoices.filter((inv) => inv.periodStart === latestStart)
  if (latest.some((inv) => inv.status === "overdue")) return "overdue"
  if (latest.some((inv) => inv.status === "issued")) return "payment_due"
  return "active"
}

export interface PlanModuleInfo {
  key: string
  name: string
}

export interface ShishaMonth {
  sessions: number
  refills: number
  amountCents: number
}

export interface ShishaBillingInfo {
  /** What one session / one refill costs this shop, in cents (shop-specific rate, else the platform default). */
  sessionFeeCents: number
  refillFeeCents: number
  currency: string
  thisMonth: ShishaMonth
  lastMonth: ShishaMonth
}

export interface StaffBillingInfo {
  perStaffCents: number
  currency: string
  /** Active staff right now; the month-end count is what gets invoiced. */
  activeStaff: number
  /** activeStaff x perStaffCents: this month's bill if the month ended now. */
  estimatedCents: number
}

export interface OrderBillingInfo {
  monthlyFeeCents: number
  includedOrders: number
  perOrderCents: number
  currency: string
  /** Completed orders so far this month. */
  ordersThisMonth: number
  overageOrders: number
  /** Stock take and barcode / label printing, each a flat monthly fee. */
  addons: AddonCharge[]
  /** monthly fee + overage + add-ons, if the month ended now (staff are billed separately). */
  estimatedCents: number
}

export interface EventBillingInfo {
  perTicketCents: number
  currency: string
  ticketsThisMonth: number
  /** Box office (per ticket) and Tables and Tabs (per table), with this month's usage and what it adds. */
  addons: AddonCharge[]
  /** tickets x fee + add-ons, if the month ended now (staff are billed separately). */
  estimatedCents: number
}

export interface BillingSummary {
  /** Which modules are switched on for this shop (tenant_modules). Drives what the panel shows. */
  products: BillableModules
  /** Per-head staff bill. null when the shop runs Booking or Queue (staff are inside its plan), or runs no staff-bearing module. */
  staff: StaffBillingInfo | null
  /** Order Management: monthly fee + included orders + per-order overage. null when Orders is off. */
  orders: OrderBillingInfo | null
  /** Event Management: a fee per ticket sold. null when Events is off. */
  events: EventBillingInfo | null
  /** Shisha usage and rates. null whenever Shisha is switched off for the shop. */
  shisha: ShishaBillingInfo | null
  currentPlan: Plan
  usage: PlanUsage
  visitBreakdown: VisitBreakdown
  allPlans: Plan[]
  /** Real capabilities per plan, straight from plan_modules/modules -- never hand-authored copy. */
  planModules: Record<string, PlanModuleInfo[]>
  pendingRequest: { requestedPlanKey: string; createdAt: string } | null
  invoices: TenantInvoice[]
  billingStatus: BillingStatus
  /** Sum of amount_cents across invoices still 'issued' or 'overdue'. 0 if fully settled. */
  outstandingCents: number
}

const SHISHA_BILLING_TZ = "Africa/Johannesburg" // same month boundaries as shisha_usage_monthly and invoicing

function shishaMonthKeys(): { thisMonth: string; lastMonth: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: SHISHA_BILLING_TZ }).format(new Date()) // YYYY-MM-DD
  const [y, m] = today.split("-").map(Number)
  const key = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`
  return { thisMonth: key(y, m), lastMonth: m === 1 ? key(y - 1, 12) : key(y, m - 1) }
}

const toCents = (rands: unknown): number => Math.round(Number(rands) * 100) || 0

async function loadStaffBilling(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  products: BillableModules,
): Promise<StaffBillingInfo | null> {
  // Booking & Queue include staff in their plan. Shisha, Orders, Events and standalone Staff pay per head.
  if (!staffBilledPerHead(products)) return null

  const [ratesRes, countRes] = await Promise.all([
    supabase
      .from("staff_billing_rates")
      .select("tenant_id, fee_per_staff, currency")
      .eq("module_key", "staff")
      .eq("is_active", true)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`),
    supabase.from("staff").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
  ])
  const rates = (ratesRes.data ?? []) as Array<{ tenant_id: string | null; fee_per_staff: number | string; currency: string }>
  const rate = rates.find((r) => r.tenant_id === tenantId) ?? rates.find((r) => r.tenant_id === null)
  const perStaffCents = rate ? toCents(rate.fee_per_staff) : 0
  const activeStaff = countRes.count ?? 0
  return { perStaffCents, currency: rate?.currency ?? "ZAR", activeStaff, estimatedCents: perStaffCents * activeStaff }
}

/** First instant of the current UTC month, matching how Booking & Queue months work. */
function thisMonthRangeUtc(): { from: string; to: string } {
  const now = new Date()
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  }
}

async function loadOrderBilling(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  switchedOn: boolean,
): Promise<OrderBillingInfo | null> {
  if (!switchedOn) return null
  const { from, to } = thisMonthRangeUtc()
  const [ratesRes, ordersThisMonth] = await Promise.all([
    supabase
      .from("order_billing_rates")
      .select("tenant_id, monthly_fee, included_orders, per_order_fee, currency")
      .eq("is_active", true)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`),
    countOrdersInRange(supabase, tenantId, from, to),
  ])
  const rates = (ratesRes.data ?? []) as Array<{ tenant_id: string | null; monthly_fee: number | string; included_orders: number; per_order_fee: number | string; currency: string }>
  const rate = rates.find((r) => r.tenant_id === tenantId) ?? rates.find((r) => r.tenant_id === null)
  const monthlyFeeCents = rate ? toCents(rate.monthly_fee) : 0
  const perOrderCents = rate ? toCents(rate.per_order_fee) : 0
  const includedOrders = rate?.included_orders ?? 0
  const overageOrders = Math.max(ordersThisMonth - includedOrders, 0)
  const addons = (await addonChargesFor(supabase, [tenantId], "orders", ORDER_ADDONS, { fromIso: from, toIso: to })).get(tenantId) ?? []
  const addonsCents = addons.reduce((sum, a) => sum + a.feeCents, 0)
  return {
    monthlyFeeCents,
    includedOrders,
    perOrderCents,
    currency: rate?.currency ?? "ZAR",
    ordersThisMonth,
    overageOrders,
    addons,
    estimatedCents: monthlyFeeCents + overageOrders * perOrderCents + addonsCents,
  }
}

async function loadEventBilling(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  switchedOn: boolean,
): Promise<EventBillingInfo | null> {
  if (!switchedOn) return null
  const { from, to } = thisMonthRangeUtc()
  const [ratesRes, ticketsThisMonth] = await Promise.all([
    supabase
      .from("event_billing_rates")
      .select("tenant_id, ticket_fee, currency")
      .eq("is_active", true)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`),
    countTicketsInRange(supabase, tenantId, from, to),
  ])
  const rates = (ratesRes.data ?? []) as Array<{ tenant_id: string | null; ticket_fee: number | string; currency: string }>
  const rate = rates.find((r) => r.tenant_id === tenantId) ?? rates.find((r) => r.tenant_id === null)
  const perTicketCents = rate ? toCents(rate.ticket_fee) : 0
  const addons = (await addonChargesFor(supabase, [tenantId], "events", EVENT_ADDONS, { fromIso: from, toIso: to })).get(tenantId) ?? []
  const addonsCents = addons.reduce((sum, a) => sum + a.feeCents, 0)
  return { perTicketCents, currency: rate?.currency ?? "ZAR", ticketsThisMonth, addons, estimatedCents: perTicketCents * ticketsThisMonth + addonsCents }
}

async function loadShishaBilling(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  switchedOn: boolean,
): Promise<ShishaBillingInfo | null> {
  // Shisha switched off: no Shisha usage card, even if there is old usage on record. Invoices already
  // issued still appear in the invoice history and in "Outstanding", because those are real bills.
  if (!switchedOn) return null

  const { thisMonth, lastMonth } = shishaMonthKeys()

  const [usageRes, ratesRes] = await Promise.all([
    supabase
      .from("shisha_usage_monthly")
      .select("month, sessions, refills, amount, currency")
      .eq("tenant_id", tenantId)
      .in("month", [thisMonth, lastMonth]),
    supabase
      .from("shisha_billing_rates")
      .select("tenant_id, session_fee, refill_fee, currency")
      .eq("is_active", true)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`),
  ])
  if (usageRes.error) throw new Error(`Failed to load shisha usage: ${usageRes.error.message}`)

  const usage = (usageRes.data ?? []) as Array<{ month: string; sessions: number; refills: number; amount: number | string; currency: string }>
  const monthOf = (month: string): ShishaMonth => {
    const rows = usage.filter((u) => u.month === month)
    return {
      sessions: rows.reduce((n, r) => n + Number(r.sessions), 0),
      refills: rows.reduce((n, r) => n + Number(r.refills), 0),
      amountCents: rows.reduce((n, r) => n + toCents(r.amount), 0),
    }
  }

  // The shop's own active rate wins over the platform default (tenant_id null).
  const rates = (ratesRes.data ?? []) as Array<{ tenant_id: string | null; session_fee: number | string; refill_fee: number | string; currency: string }>
  const rate = rates.find((r) => r.tenant_id === tenantId) ?? rates.find((r) => r.tenant_id === null)

  return {
    sessionFeeCents: rate ? toCents(rate.session_fee) : 0,
    refillFeeCents: rate ? toCents(rate.refill_fee) : 0,
    currency: rate?.currency ?? usage[0]?.currency ?? "ZAR",
    thisMonth: monthOf(thisMonth),
    lastMonth: monthOf(lastMonth),
  }
}

export async function getBillingSummary(): Promise<{ ok: true; data: BillingSummary } | { ok: false; error: string }> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  try {
    const [currentPlan, usage, visitBreakdown, allPlans, tenantRow, products] = await Promise.all([
      getTenantPlan(supabase, tenantId!),
      getTenantPlanUsage(supabase, tenantId!),
      getTenantVisitBreakdown(supabase, tenantId!),
      listPlans(supabase),
      supabase.from("tenants").select("status").eq("id", tenantId!).single(),
      getBillableModules(supabase, tenantId!),
    ])

    // Real capabilities per plan for the comparison section -- straight
    // from plan_modules/modules, never hand-authored feature copy.
    const { data: planModuleRows } = await supabase
      .from("plan_modules")
      .select("plan_key, modules(key, name)")
      .in(
        "plan_key",
        allPlans.map((p) => p.key),
      )

    const planModules: Record<string, PlanModuleInfo[]> = {}
    for (const row of planModuleRows ?? []) {
      const mod = (row as any).modules as { key: string; name: string } | null
      if (!mod) continue
      const planKey = (row as any).plan_key as string
      if (!planModules[planKey]) planModules[planKey] = []
      planModules[planKey].push({ key: mod.key, name: mod.name })
    }

    const { data: pending } = await supabase
      .from("plan_upgrade_requests")
      .select("requested_plan_key, created_at")
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: invoiceRows } = await supabase
      .from("tenant_invoices")
      .select(
        "id, product, detail, period_start, period_end, visit_count, rate_cents, amount_cents, currency, status, base_fee_cents, included_visits, overage_visits, staff_count, included_staff, extra_staff, extra_staff_fee_cents",
      )
      .eq("tenant_id", tenantId)
      .order("period_start", { ascending: false })
      .limit(48) // up to five products per month now

    const invoices: TenantInvoice[] = (invoiceRows ?? []).map((row: any) => ({
      id: row.id,
      product: (["shisha", "staff", "orders", "events"].includes(row.product) ? row.product : "booking_queue") as InvoiceProduct,
      detail: row.detail ?? null,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      visitCount: row.visit_count,
      rateCents: row.rate_cents,
      amountCents: row.amount_cents,
      currency: row.currency,
      status: row.status,
      baseFeeCents: row.base_fee_cents,
      includedVisits: row.included_visits,
      overageVisits: row.overage_visits,
      staffCount: row.staff_count,
      includedStaff: row.included_staff,
      extraStaff: row.extra_staff,
      extraStaffFeeCents: row.extra_staff_fee_cents,
    }))

    const outstandingCents = invoices
      .filter((inv) => inv.status === "issued" || inv.status === "overdue")
      .reduce((sum, inv) => sum + inv.amountCents, 0)

    const runsBookingQueue = products.booking || products.queue
    const billingStatus = deriveBillingStatus(tenantRow.data?.status ?? "active", currentPlan.key, invoices, runsBookingQueue)
    const shisha = await loadShishaBilling(supabase, tenantId!, products.shisha)
    const staff = await loadStaffBilling(supabase, tenantId!, products)
    const [orders, events] = await Promise.all([
      loadOrderBilling(supabase, tenantId!, products.orders),
      loadEventBilling(supabase, tenantId!, products.events),
    ])

    return {
      ok: true,
      data: {
        products,
        shisha,
        staff,
        orders,
        events,
        currentPlan,
        usage,
        visitBreakdown,
        allPlans,
        planModules,
        pendingRequest: pending ? { requestedPlanKey: pending.requested_plan_key, createdAt: pending.created_at } : null,
        invoices,
        billingStatus,
        outstandingCents,
      },
    }
  } catch (err) {
    console.error("[billing] getBillingSummary failed", { tenantId, error: err })
    return { ok: false, error: "Couldn't load billing information." }
  }
}

export async function requestPlanUpgrade(planKey: string, note?: string): Promise<ActionResult> {
  // Server Actions are public endpoints: refuse anything that is not a real
  // Booking & Queue plan (this rejects "shisha" and unknown keys) BEFORE any
  // database work, so a bypassed UI can never file such a request.
  if (!isBookingQueuePlanKey(planKey)) {
    return { ok: false, error: "That plan isn't available for upgrade requests. Please choose one of the plans shown in Billing." }
  }

  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  // Don't stack duplicate pending requests for the same tenant.
  const { data: existing } = await supabase
    .from("plan_upgrade_requests")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .maybeSingle()

  if (existing) {
    return { ok: false, error: "You already have an upgrade request pending review." }
  }

  const { error: insertError } = await supabase.from("plan_upgrade_requests").insert([
    {
      tenant_id: tenantId,
      requested_plan_key: planKey,
      note: note?.trim() || null,
    },
  ])

  if (insertError) return { ok: false, error: insertError.message }

  revalidatePath("/admin")
  return { ok: true }
}
