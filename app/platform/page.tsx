// app/platform/page.tsx — platform overview: what needs attention, then how the platform is doing.
import Link from "next/link"
import { redirect } from "next/navigation"

import { PageHeader, PLATFORM_CARD } from "@/components/platform/PageHeader"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

export const dynamic = "force-dynamic"

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
}

export default async function PlatformHome() {
  await requirePlatformAdmin()
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [all, active, people, pending, recent, upgrades, enquiries, awaiting] = await Promise.all([
    supabase.from("tenants").select("id", { count: "exact", head: true }),
    supabase.from("tenants").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("salespeople").select("id", { count: "exact", head: true }).neq("status", "terminated"),
    supabase.from("referral_signups").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("tenants").select("*").limit(200),
    supabase.from("plan_upgrade_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("contact_requests").select("id", { count: "exact", head: true }).eq("status", "new"),
    supabase.from("tenants").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ])

  const newest = ((recent.data ?? []) as Array<{ id: string; name: string; slug: string; status: string; plan?: string; created_at?: string }>)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, 8)

  const attention: Array<{ label: string; hint: string; value: number; href: string }> = [
    { label: "Shops waiting for approval", hint: "Approve or reject new shops", value: awaiting.count ?? 0, href: "/platform/tenants" },
    { label: "Upgrade requests", hint: "Plan changes to review", value: upgrades.count ?? 0, href: "/platform/upgrades" },
    { label: "Sign-up requests", hint: "Referred by your salespeople", value: pending.count ?? 0, href: "/platform/sales" },
    { label: "New enquiries", hint: "From the website", value: enquiries.count ?? 0, href: "/platform/leads" },
  ]
  const totalWaiting = attention.reduce((n, a) => n + a.value, 0)

  const stats: Array<{ label: string; value: number; href: string }> = [
    { label: "Shops", value: all.count ?? 0, href: "/platform/tenants" },
    { label: "Active shops", value: active.count ?? 0, href: "/platform/tenants" },
    { label: "Salespeople", value: people.count ?? 0, href: "/platform/sales" },
  ]

  return (
    <main className="space-y-6">
      <PageHeader
        title="Overview"
        description={totalWaiting > 0 ? `${totalWaiting} item${totalWaiting === 1 ? "" : "s"} waiting for you.` : "Nothing is waiting for you right now."}
        actions={
          <Link href="/platform/modules" className="rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-stone-700">
            Manage modules
          </Link>
        }
      />

      <section aria-label="Needs attention" className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">Needs attention</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {attention.map((a) => (
            <Link
              key={a.label}
              href={a.href}
              className={`${PLATFORM_CARD} group p-4 transition hover:border-stone-300 hover:shadow ${a.value > 0 ? "border-l-4 border-l-amber-400" : ""}`}
            >
              <p className="text-sm text-stone-600">{a.label}</p>
              <p className={`mt-2 text-3xl font-semibold tabular-nums ${a.value > 0 ? "text-stone-900" : "text-stone-300"}`}>{a.value}</p>
              <p className="mt-1 text-xs text-stone-400 group-hover:text-stone-600">{a.hint} →</p>
            </Link>
          ))}
        </div>
      </section>

      <section aria-label="Platform" className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">Platform</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <Link key={s.label} href={s.href} className={`${PLATFORM_CARD} p-4 transition hover:border-stone-300 hover:shadow`}>
              <p className="text-sm text-stone-600">{s.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-stone-900">{s.value}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className={`${PLATFORM_CARD} overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-stone-800">Newest shops</h2>
          <Link href="/platform/tenants" className="text-sm text-stone-600 hover:text-stone-900 hover:underline">
            All shops / create one
          </Link>
        </div>
        {newest.length === 0 ? (
          <p className="px-5 py-6 text-sm text-stone-500">No shops yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100 text-sm">
            {newest.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-stone-900">{t.name}</p>
                  <p className="text-xs text-stone-500">/{t.slug}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${STATUS_STYLE[t.status] ?? "bg-stone-100 text-stone-600 ring-stone-200"}`}>
                  {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
