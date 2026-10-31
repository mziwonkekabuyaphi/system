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
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import {
  listPlans,
  getTenantPlan,
  getTenantPlanUsage,
  getTenantVisitBreakdown,
  getEnabledProducts,
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

export type InvoiceProduct = "booking_queue" | "shisha"

export interface TenantInvoice {
  id: string
  /** Which module this invoice bills. Older rows are all Booking & Queue. */
  product: InvoiceProduct
  /** Shisha invoices: { sessions, session_fee_cents, refills, refill_fee_cents }. null otherwise. */
  detail: { sessions?: number; session_fee_cents?: number; refills?: number; refill_fee_cents?: number } | null
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

export interface BillingSummary {
  /** Which modules are switched on for this shop (tenant_modules). Drives what the panel shows. */
  products: { booking: boolean; queue: boolean; shisha: boolean }
  /** Shisha usage and rates. null when the shop has never used Shisha and has it off. */
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

async function loadShishaBilling(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  switchedOn: boolean,
  hasShishaInvoices: boolean,
): Promise<ShishaBillingInfo | null> {
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
  // Nothing to show: Shisha off, never used, never invoiced.
  if (!switchedOn && usage.length === 0 && !hasShishaInvoices) return null

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
      getEnabledProducts(supabase, tenantId!),
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
      .limit(24) // two products per month now

    const invoices: TenantInvoice[] = (invoiceRows ?? []).map((row: any) => ({
      id: row.id,
      product: (row.product === "shisha" ? "shisha" : "booking_queue") as InvoiceProduct,
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
    const shisha = await loadShishaBilling(supabase, tenantId!, products.shisha, invoices.some((inv) => inv.product === "shisha"))

    return {
      ok: true,
      data: {
        products: { booking: products.booking, queue: products.queue, shisha: products.shisha },
        shisha,
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
