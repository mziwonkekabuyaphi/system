// app/platform/tenants/page.tsx — every shop on the platform, plus "create a shop".
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

import { Tenants } from "./Tenants"

export const dynamic = "force-dynamic"

export default async function TenantsPage() {
  await requirePlatformAdmin() // the real gate: everything below uses the service-role client
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [tenants, members, referrals, people] = await Promise.all([
    supabase.from("tenants").select("*").limit(1000),
    supabase.from("tenant_members").select("tenant_id").eq("status", "active"),
    supabase.from("tenant_referrals").select("tenant_id, salesperson_id"),
    supabase.from("salespeople").select("id, profile_id"),
  ])

  const profileIds = (people.data ?? []).map((p) => p.profile_id)
  const { data: profiles } = profileIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", profileIds)
    : { data: [] as Array<{ id: string; full_name: string | null }> }

  const profileName = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? "Unnamed"]))
  const salesName = new Map((people.data ?? []).map((p) => [p.id, profileName.get(p.profile_id) ?? "Unnamed"]))
  const referredBy = new Map((referrals.data ?? []).map((r) => [r.tenant_id, salesName.get(r.salesperson_id) ?? "—"]))
  const memberCount = new Map<string, number>()
  for (const m of members.data ?? []) memberCount.set(m.tenant_id, (memberCount.get(m.tenant_id) ?? 0) + 1)

  const rows = ((tenants.data ?? []) as Array<{ id: string; name: string; slug: string; status: string; created_at?: string }>)
    .map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      createdAt: t.created_at ?? null,
      members: memberCount.get(t.id) ?? 0,
      referredBy: referredBy.get(t.id) ?? null,
    }))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))

  return <Tenants rows={rows} />
}
