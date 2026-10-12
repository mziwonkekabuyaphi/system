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
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { loadDisplayContext } from "../admin-data"
import {
  previousRange,
  resolveRange,
  type AnalyticsResult,
  type Billing,
  type Ops,
  type Payroll,
  type Preset,
  type Range,
} from "./model"

const PRESETS: Preset[] = ["7d", "30d", "90d", "custom"]

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
    const [{ timezone }, settings, billingCheck, payrollCheck] = await Promise.all([
      loadDisplayContext(supabase, tenantId),
      supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
      requireTenantPermission("billing.view"),
      requireTenantPermission("payroll.view"),
    ])

    const resolved = resolveRange(input.preset, timezone, { from: input.from, to: input.to })
    if ("error" in resolved) return { ok: false, error: resolved.error }
    const range: Range = resolved
    const prevRange = input.compare ? previousRange(range) : null

    const args = (r: Range) => ({ p_tenant_id: tenantId, p_start: r.start, p_end: r.end, p_tz: timezone })

    const [cur, prev, billing, payroll] = await Promise.all([
      supabase.rpc("analytics_dashboard", args(range)),
      prevRange ? supabase.rpc("analytics_dashboard", args(prevRange)) : Promise.resolve(null),
      billingCheck.ok ? supabase.rpc("analytics_billing", args(range)) : Promise.resolve(null),
      payrollCheck.ok ? supabase.rpc("analytics_payroll", args(range)) : Promise.resolve(null),
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

    return {
      ok: true,
      timezone,
      currency: settings.data?.currency ?? "ZAR",
      range,
      prevRange: prev && !prev.error ? prevRange : null,
      current: cur.data as Ops,
      previous: prev && !prev.error ? (prev.data as Ops) : null,
      billing: billing && !billing.error ? (billing.data as Billing) : null,
      payroll: payroll && !payroll.error ? (payroll.data as Payroll) : null,
      warnings,
    }
  } catch (err) {
    console.error("[analytics] getAnalytics failed", { tenantId, err })
    return { ok: false, error: "Couldn't load analytics. Try again." }
  }
}
