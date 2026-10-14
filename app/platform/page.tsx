// app/platform/page.tsx — platform overview: how many shops, what needs attention.
import Link from "next/link"
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

export const dynamic = "force-dynamic"

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"

export default async function PlatformHome() {
  await requirePlatformAdmin()
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [all, active, people, pending, recent, upgrades] = await Promise.all([
    supabase.from("tenants").select("id", { count: "exact", head: true }),
    supabase.from("tenants").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("salespeople").select("id", { count: "exact", head: true }).neq("status", "terminated"),
    supabase.from("referral_signups").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("tenants").select("*").limit(200),
    supabase.from("plan_upgrade_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ])

  const newest = ((recent.data ?? []) as Array<{ id: string; name: string; slug: string; status: string; created_at?: string }>)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, 8)

  const stats: Array<[string, number, string?]> = [
    ["Shops", all.count ?? 0, "/platform/tenants"],
    ["Active shops", active.count ?? 0, "/platform/tenants"],
    ["Salespeople", people.count ?? 0, "/platform/sales"],
    ["Sign-up requests waiting", pending.count ?? 0, "/platform/sales"],
    ["Upgrade requests waiting", upgrades.count ?? 0, "/platform/upgrades"],
  ]

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Overview</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map(([label, value, href]) => (
          <Link key={label} href={href ?? "#"} className={card}>
            <p className="text-xs uppercase text-stone-400">{label}</p>
            <p className="mt-1 text-3xl text-stone-900 tabular-nums">{value}</p>
          </Link>
        ))}
      </div>
      <section className={card}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-stone-800">Newest shops</p>
          <Link href="/platform/tenants" className="text-sm text-stone-600 underline">All shops / create one</Link>
        </div>
        <div className="divide-y divide-stone-100 text-sm">
          {newest.length === 0 && <p className="py-2 text-stone-500">No shops yet.</p>}
          {newest.map((t) => (
            <div key={t.id} className="flex justify-between py-2">
              <span className="text-stone-900">{t.name}</span>
              <span className="text-stone-500">/{t.slug} · {t.status}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
