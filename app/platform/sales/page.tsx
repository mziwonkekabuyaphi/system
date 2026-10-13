// app/platform/sales/page.tsx — platform-admin console for commissions.
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

import { PlatformSales } from "./PlatformSales"

export const dynamic = "force-dynamic"

export default async function PlatformSalesPage() {
  await requirePlatformAdmin() // the real gate: everything below uses the service-role client
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [people, signups, payouts, rules, referrals, commissions] = await Promise.all([
    supabase.from("salespeople").select("id, profile_id, referral_code, status, created_at"),
    supabase.from("referral_signups").select("id, salesperson_id, business_name, contact_name, contact_phone, contact_email, notes, status, created_at").order("created_at", { ascending: false }).limit(100),
    supabase.from("commission_payouts").select("id, salesperson_id, period, total_cents, status, payment_reference, paid_at").order("created_at", { ascending: false }).limit(60),
    supabase.from("commission_rules").select("id, plan_key, bounty_cents, recurring_rate_bps, effective_from, effective_to").order("effective_from", { ascending: false }),
    supabase.from("tenant_referrals").select("tenant_id, salesperson_id, status, source"),
    supabase.from("commissions").select("salesperson_id, amount_cents, status").neq("status", "void"),
  ])

  const profileIds = (people.data ?? []).map((p) => p.profile_id)
  const { data: profiles } = profileIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", profileIds)
    : { data: [] as Array<{ id: string; full_name: string | null }> }
  const tenantIds = (referrals.data ?? []).map((r) => r.tenant_id)
  const { data: tenants } = tenantIds.length
    ? await supabase.from("tenants").select("id, name").in("id", tenantIds)
    : { data: [] as Array<{ id: string; name: string }> }

  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? "Unnamed"]))
  const tenantName = new Map((tenants ?? []).map((t) => [t.id, t.name]))
  const totals = new Map<string, { pending: number; approved: number; paid: number }>()
  for (const c of commissions.data ?? []) {
    const t = totals.get(c.salesperson_id) ?? { pending: 0, approved: 0, paid: 0 }
    if (c.status === "pending") t.pending += c.amount_cents
    else if (c.status === "approved") t.approved += c.amount_cents
    else if (c.status === "paid") t.paid += c.amount_cents
    totals.set(c.salesperson_id, t)
  }

  const salespeople = (people.data ?? []).map((p) => ({
    id: p.id,
    name: nameOf.get(p.profile_id) ?? "Unnamed",
    code: p.referral_code,
    status: p.status as string,
    ...(totals.get(p.id) ?? { pending: 0, approved: 0, paid: 0 }),
  }))
  const spName = new Map(salespeople.map((s) => [s.id, s.name]))

  return (
    <PlatformSales
      salespeople={salespeople}
      signups={(signups.data ?? []).map((s) => ({ ...s, salespersonName: spName.get(s.salesperson_id) ?? "—" }))}
      payouts={(payouts.data ?? []).map((p) => ({ ...p, salespersonName: spName.get(p.salesperson_id) ?? "—" }))}
      rules={rules.data ?? []}
      clients={(referrals.data ?? []).map((r) => ({
        tenantId: r.tenant_id,
        tenantName: tenantName.get(r.tenant_id) ?? r.tenant_id,
        salespersonId: r.salesperson_id,
        salespersonName: spName.get(r.salesperson_id) ?? "—",
        status: r.status as string,
      }))}
    />
  )
}
