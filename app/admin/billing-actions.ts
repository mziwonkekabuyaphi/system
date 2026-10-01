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

export interface TenantInvoice {
  id: string
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

function deriveBillingStatus(tenantStatus: string, planKey: string, latestInvoice: TenantInvoice | null): BillingStatus {
  if (tenantStatus !== "active") return "cancelled"
  if (planKey === "free") return "trial_free"
  if (latestInvoice?.status === "overdue") return "overdue"
  if (latestInvoice?.status === "issued") return "payment_due"
  return "active"
}

export interface PlanModuleInfo {
  key: string
  name: string
}

export interface BillingSummary {
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

export async function getBillingSummary(): Promise<{ ok: true; data: BillingSummary } | { ok: false; error: string }> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  try {
    const [currentPlan, usage, visitBreakdown, allPlans, tenantRow] = await Promise.all([
      getTenantPlan(supabase, tenantId!),
      getTenantPlanUsage(supabase, tenantId!),
      getTenantVisitBreakdown(supabase, tenantId!),
      listPlans(supabase),
      supabase.from("tenants").select("status").eq("id", tenantId!).single(),
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
        "id, period_start, period_end, visit_count, rate_cents, amount_cents, currency, status, base_fee_cents, included_visits, overage_visits, staff_count, included_staff, extra_staff, extra_staff_fee_cents",
      )
      .eq("tenant_id", tenantId)
      .order("period_start", { ascending: false })
      .limit(12)

    const invoices: TenantInvoice[] = (invoiceRows ?? []).map((row: any) => ({
      id: row.id,
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

    const billingStatus = deriveBillingStatus(tenantRow.data?.status ?? "active", currentPlan.key, invoices[0] ?? null)

    return {
      ok: true,
      data: {
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
