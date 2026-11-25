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

  type TenantRow = {
    id: string; name: string; slug: string; status: string; created_at?: string
    requested_modules?: string[] | null; pending_modules?: string[] | null; industry?: string | null
  }
  const all = (tenants.data ?? []) as TenantRow[]

  const [{ data: presetRows }, { data: moduleRows }] = await Promise.all([
    supabase.from("industry_presets").select("key, name"),
    supabase
      .from("modules")
      .select("key, name")
      .in("kind", ["product", "addon"])
      .neq("key", "custom_domain")
      .order("display_order", { nullsFirst: false }),
  ])
  const industryName = new Map((presetRows ?? []).map((p) => [p.key, p.name]))
  const moduleOptions = (moduleRows ?? []) as Array<{ key: string; name: string }>

  // Who signed up: owner's name and email, best-effort.
  async function owner(tenantId: string) {
    let ownerName: string | null = null
    let ownerEmail: string | null = null
    try {
      const { data: member } = await supabase!.from("tenant_members").select("profile_id").eq("tenant_id", tenantId).limit(1).maybeSingle()
      if (member?.profile_id) {
        const [{ data: profile }, { data: auth }] = await Promise.all([
          supabase!.from("profiles").select("full_name").eq("id", member.profile_id).maybeSingle(),
          supabase!.auth.admin.getUserById(member.profile_id),
        ])
        ownerName = profile?.full_name ?? null
        ownerEmail = auth?.user?.email ?? null
      }
    } catch {
      // The card still works without the owner's details.
    }
    return { ownerName, ownerEmail }
  }

  const toCard = async (t: TenantRow, requested: string[]) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    createdAt: t.created_at ?? null,
    requested,
    industry: t.industry ? industryName.get(t.industry) ?? t.industry : null,
    ...(await owner(t.id)),
  })

  // Shops that only asked for approval-gated modules (nothing live yet), oldest first.
  const pending = await Promise.all(
    all
      .filter((t) => t.status === "pending")
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
      // New signups store what's held in pending_modules; older ones only have requested_modules.
      .map((t) => toCard(t, t.pending_modules?.length ? t.pending_modules : t.requested_modules ?? [])),
  )

  // Live shops (Booking/Queue are self-serve) that also asked for modules needing approval.
  const requests = await Promise.all(
    all
      .filter((t) => t.status === "active" && (t.pending_modules?.length ?? 0) > 0)
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
      .map((t) => toCard(t, t.pending_modules ?? [])),
  )

  return <Tenants rows={rows} pending={pending} requests={requests} moduleOptions={moduleOptions} />
}
