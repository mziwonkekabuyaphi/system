// app/platform/shisha/page.tsx — switch Shisha on/off per shop and see what each
// shop owes (per-session + per-refill fees) for this and last month.
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { setShishaEnabledAction } from "./actions"

export const dynamic = "force-dynamic"

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
// Same zone as shisha_usage_monthly and the in-app usage card.
const BILLING_TZ = "Africa/Johannesburg"
// Literal on purpose: this page must not depend on MODULE_KEYS.shisha existing
// (if plans.ts isn't updated it would be undefined and match no row).
const SHISHA_MODULE_KEY = "shisha"

type Tenant = { id: string; name: string; slug: string; status: string }
type Usage = { tenant_id: string; month: string; sessions: number; refills: number; amount: number | string; currency: string }

function monthKeys(): { thisMonth: string; lastMonth: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: BILLING_TZ }).format(new Date()) // YYYY-MM-DD
  const [y, m] = today.split("-").map(Number)
  const key = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`
  return { thisMonth: key(y, m), lastMonth: m === 1 ? key(y - 1, 12) : key(y, m - 1) }
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

function usageText(u: Usage | undefined): string {
  if (!u) return "—"
  return `${money(Number(u.amount), u.currency)} · ${u.sessions} sess + ${u.refills} refills`
}

export default async function PlatformShisha({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requirePlatformAdmin()
  const { error } = await searchParams
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const { thisMonth, lastMonth } = monthKeys()

  const modRes = await supabase.from("modules").select("id").eq("key", SHISHA_MODULE_KEY).maybeSingle()
  const moduleId = (modRes.data as { id: string } | null)?.id ?? null
  // Say WHY it is missing: a failed query and a missing row are different problems.
  const moduleProblem = modRes.error
    ? `Couldn't read the modules table: ${modRes.error.message}`
    : !moduleId
      ? "No row with key 'shisha' in the modules table of the database this app is connected to. The migration either didn't commit or was run on a different Supabase project."
      : null

  const [tenantsRes, switchesRes, usageRes] = await Promise.all([
    supabase.from("tenants").select("id, name, slug, status").order("name", { ascending: true }).limit(500),
    moduleId
      ? supabase.from("tenant_modules").select("tenant_id, enabled").eq("module_id", moduleId)
      : Promise.resolve({ data: [] as any[] }),
    supabase
      .from("shisha_usage_monthly")
      .select("tenant_id, month, sessions, refills, amount, currency")
      .in("month", [thisMonth, lastMonth]),
  ])

  const tenants = (tenantsRes.data ?? []) as Tenant[]
  const enabled = new Map<string, boolean>(((switchesRes.data ?? []) as any[]).map((r) => [r.tenant_id, r.enabled === true]))
  const usage = (usageRes.data ?? []) as Usage[]
  const usageFor = (tenantId: string, month: string) => usage.find((u) => u.tenant_id === tenantId && u.month === month)

  const rows = tenants
    .map((t) => ({ t, on: enabled.get(t.id) === true }))
    .sort((a, b) => Number(b.on) - Number(a.on) || a.t.name.localeCompare(b.t.name))

  const totalLast = usage.filter((u) => u.month === lastMonth).reduce((sum, u) => sum + Number(u.amount), 0)

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Shisha</h1>
        <p className="mt-1 text-sm text-stone-500">
          Shisha isn&apos;t part of any plan. A shop only gets it when you switch it on here, and it is billed per session and per refill.
        </p>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {moduleProblem && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">{moduleProblem}</p>
      )}

      <section className={card}>
        <p className="text-xs uppercase text-stone-400">Owed for last month (all shops)</p>
        <p className="mt-1 text-3xl text-stone-900 tabular-nums">{money(totalLast, "ZAR")}</p>
      </section>

      <section className={`${card} overflow-x-auto`}>
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-stone-400">
              <th className="py-2 pr-4 font-medium">Shop</th>
              <th className="py-2 pr-4 font-medium">Shisha</th>
              <th className="py-2 pr-4 font-medium">This month</th>
              <th className="py-2 pr-4 font-medium">Last month</th>
              <th className="py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-stone-500">No shops yet.</td>
              </tr>
            )}
            {rows.map(({ t, on }) => (
              <tr key={t.id}>
                <td className="py-2 pr-4">
                  <span className="text-stone-900">{t.name}</span>
                  <span className="ml-2 text-stone-500">/{t.slug} · {t.status}</span>
                </td>
                <td className="py-2 pr-4">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${on ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>
                    {on ? "On" : "Off"}
                  </span>
                </td>
                <td className="py-2 pr-4 tabular-nums text-stone-700">{usageText(usageFor(t.id, thisMonth))}</td>
                <td className="py-2 pr-4 tabular-nums text-stone-700">{usageText(usageFor(t.id, lastMonth))}</td>
                <td className="py-2 text-right">
                  <form action={setShishaEnabledAction}>
                    <input type="hidden" name="tenantId" value={t.id} />
                    <input type="hidden" name="enable" value={on ? "false" : "true"} />
                    <button
                      type="submit"
                      disabled={!moduleId}
                      className="rounded-full border border-stone-300 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                    >
                      {on ? "Switch off" : "Switch on"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  )
}
