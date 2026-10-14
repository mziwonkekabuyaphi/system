// app/platform/upgrades/page.tsx — plan upgrade requests waiting for approval.
// Tenants request Growth/Business from Billing & Plans; until card billing
// exists, a platform admin approves here, which flips tenants.plan.
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

import { approveUpgrade, declineUpgrade } from "./actions"

export const dynamic = "force-dynamic"

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"

type RequestRow = {
  id: string
  tenant_id: string
  requested_plan_key: string
  note: string | null
  status: "pending" | "approved" | "declined"
  created_at: string
  resolved_at: string | null
  tenants: { name: string; slug: string; plan: string } | null
}

type PlanRow = { key: string; name: string; price_cents: number; currency: string }

function formatDate(iso: string | null) {
  if (!iso) return ""
  return new Date(iso).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default async function UpgradeRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>
}) {
  await requirePlatformAdmin()
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const { error: errorMessage, done } = await searchParams

  const [requestsResult, plansResult] = await Promise.all([
    supabase
      .from("plan_upgrade_requests")
      .select("id, tenant_id, requested_plan_key, note, status, created_at, resolved_at, tenants ( name, slug, plan )")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("plans").select("key, name, price_cents, currency"),
  ])

  const requests = (requestsResult.data ?? []) as unknown as RequestRow[]
  const plans = new Map(((plansResult.data ?? []) as PlanRow[]).map((p) => [p.key, p]))
  const planName = (key: string) => plans.get(key)?.name ?? key
  const planPrice = (key: string) => {
    const p = plans.get(key)
    if (!p || !p.price_cents) return null
    return `${p.currency} ${(p.price_cents / 100).toFixed(2)}`
  }

  const pending = requests.filter((r) => r.status === "pending").reverse() // oldest first
  const resolved = requests.filter((r) => r.status !== "pending").slice(0, 20)

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">
          Upgrade requests
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          Approving switches the shop to the requested plan straight away. Collect payment first if you need to.
        </p>
      </div>

      {requestsResult.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn&apos;t load requests: {requestsResult.error.message}
        </p>
      )}
      {errorMessage && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>}
      {done && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {done === "approved" ? "Approved. The shop is now on the new plan." : "Request declined."}
        </p>
      )}

      <section className={card}>
        <p className="mb-2 text-sm font-semibold text-stone-800">Waiting for approval ({pending.length})</p>
        <div className="divide-y divide-stone-100 text-sm">
          {pending.length === 0 && <p className="py-2 text-stone-500">Nothing waiting.</p>}
          {pending.map((r) => {
            const price = planPrice(r.requested_plan_key)
            return (
              <div key={r.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <p className="text-stone-900">
                    <span className="font-semibold">{r.tenants?.name ?? "Unknown shop"}</span>
                    {r.tenants?.slug && <span className="text-stone-500"> · /{r.tenants.slug}</span>}
                  </p>
                  <p className="text-stone-700">
                    {r.tenants ? planName(r.tenants.plan) : "?"} → <span className="font-semibold">{planName(r.requested_plan_key)}</span>
                    {price && <span className="text-stone-500"> ({price}/month)</span>}
                  </p>
                  <p className="text-xs text-stone-400">Requested {formatDate(r.created_at)}</p>
                  {r.note && <p className="text-xs text-stone-500">Note: {r.note}</p>}
                </div>
                <div className="flex gap-2">
                  <form action={approveUpgrade}>
                    <input type="hidden" name="id" value={r.id} />
                    <button
                      type="submit"
                      className="rounded-full bg-stone-900 px-4 py-1.5 text-sm text-white hover:bg-stone-700"
                    >
                      Approve
                    </button>
                  </form>
                  <form action={declineUpgrade}>
                    <input type="hidden" name="id" value={r.id} />
                    <button
                      type="submit"
                      className="rounded-full border border-stone-300 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
                    >
                      Decline
                    </button>
                  </form>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className={card}>
        <p className="mb-2 text-sm font-semibold text-stone-800">Recently handled</p>
        <div className="divide-y divide-stone-100 text-sm">
          {resolved.length === 0 && <p className="py-2 text-stone-500">No handled requests yet.</p>}
          {resolved.map((r) => (
            <div key={r.id} className="flex justify-between gap-3 py-2">
              <span className="text-stone-900">
                {r.tenants?.name ?? "Unknown shop"}{" "}
                <span className="text-stone-500">→ {planName(r.requested_plan_key)}</span>
              </span>
              <span className={r.status === "approved" ? "text-emerald-700" : "text-stone-500"}>
                {r.status} · {formatDate(r.resolved_at)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
