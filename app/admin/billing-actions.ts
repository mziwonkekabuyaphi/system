"use server"

// app/admin/billing-actions.ts
/**
 * Server Actions backing the admin's Plans & Billing panel.
 *
 * Same access pattern as the rest of app/admin/actions.ts:
 * requireTenantMember() gates every call, tenantId is re-resolved from
 * the session rather than trusted from the client.
 *
 * NO PAYMENT PROCESSING HAPPENS HERE. There's no Yoco integration yet.
 * requestPlanUpgrade() just drops a row in plan_upgrade_requests for the
 * platform admin to action by hand (flip tenants.plan directly in
 * Supabase, or via a future platform-admin panel). When Yoco is wired
 * in, the natural next step is: this same request flow kicks off a
 * checkout session, and a webhook on success does what the manual
 * approval does today — update tenants.plan and mark the request
 * resolved. Nothing here needs to be thrown away for that to happen.
 */

import { revalidatePath } from "next/cache"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { listPlans, getTenantPlan, getTenantPlanUsage, type Plan, type PlanUsage } from "@/lib/services/plans"

type ActionResult = { ok: true } | { ok: false; error: string }

async function getTenantScopedClient() {
  const { tenantId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) return { supabase: null as const, tenantId: null, error: "Supabase isn't configured." }
  return { supabase, tenantId, error: undefined as string | undefined }
}

export interface TenantInvoice {
  id: string
  periodStart: string
  periodEnd: string
  visitCount: number
  rateCents: number
  amountCents: number
  status: string
}

export interface BillingSummary {
  currentPlan: Plan
  usage: PlanUsage
  allPlans: Plan[]
  pendingRequest: { requestedPlanKey: string; createdAt: string } | null
  invoices: TenantInvoice[]
}

export async function getBillingSummary(): Promise<{ ok: true; data: BillingSummary } | { ok: false; error: string }> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  try {
    const [currentPlan, usage, allPlans] = await Promise.all([
      getTenantPlan(supabase, tenantId!),
      getTenantPlanUsage(supabase, tenantId!),
      listPlans(supabase),
    ])

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
      .select("id, period_start, period_end, visit_count, rate_cents, amount_cents, status")
      .eq("tenant_id", tenantId)
      .order("period_start", { ascending: false })
      .limit(12)

    const invoices: TenantInvoice[] = (invoiceRows ?? []).map((row) => ({
      id: row.id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      visitCount: row.visit_count,
      rateCents: row.rate_cents,
      amountCents: row.amount_cents,
      status: row.status,
    }))

    return {
      ok: true,
      data: {
        currentPlan,
        usage,
        allPlans,
        pendingRequest: pending ? { requestedPlanKey: pending.requested_plan_key, createdAt: pending.created_at } : null,
        invoices,
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
