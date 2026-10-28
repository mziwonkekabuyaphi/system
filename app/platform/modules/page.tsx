// app/platform/modules/page.tsx — per-shop module switches for the platform admin.
// Switchable here: kiosk, public display, staff clock-in, shisha.
// Everything else is decided by the shop's plan and is shown read-only.
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { setTenantModuleAction } from "./actions"

export const dynamic = "force-dynamic"

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"

/** What "no tenant_modules row" means, mirroring lib/services/plans.ts:
 *   kiosk          isKioskEnabled        plan must include it, default ON
 *   display        isTenantSwitchedOn    not plan-gated, default ON
 *   staff_clock_in isTenantSwitchedOn    not plan-gated, default ON
 *   shisha         opt-in, no plan       default OFF (also billed per use) */
const SWITCHABLE: Array<{ key: string; label: string; defaultOn: boolean; planGated: boolean }> = [
  { key: "kiosk", label: "Kiosk", defaultOn: true, planGated: true },
  { key: "display", label: "Public display", defaultOn: true, planGated: false },
  { key: "staff_clock_in", label: "Staff clock-in", defaultOn: true, planGated: false },
  { key: "shisha", label: "Shisha", defaultOn: false, planGated: false },
]
const SWITCHABLE_KEYS = new Set(SWITCHABLE.map((m) => m.key))

type Tenant = { id: string; name: string; slug: string; status: string; plan: string }
type Mod = { id: string; key: string; name: string }
type State = "on" | "off" | "no_plan" | "missing"

export default async function PlatformModules({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requirePlatformAdmin()
  const { error } = await searchParams
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [tenantsRes, modulesRes, planModulesRes, switchesRes] = await Promise.all([
    supabase.from("tenants").select("id, name, slug, status, plan").order("name", { ascending: true }).limit(500),
    supabase.from("modules").select("id, key, name").order("key", { ascending: true }),
    supabase.from("plan_modules").select("plan_key, module_id"),
    supabase.from("tenant_modules").select("tenant_id, module_id, enabled"),
  ])

  const loadError = tenantsRes.error ?? modulesRes.error ?? planModulesRes.error ?? switchesRes.error
  const tenants = (tenantsRes.data ?? []) as Tenant[]
  const modules = (modulesRes.data ?? []) as Mod[]
  const moduleByKey = new Map(modules.map((m) => [m.key, m]))

  const planHas = new Set(((planModulesRes.data ?? []) as any[]).map((r) => `${r.plan_key}:${r.module_id}`))
  const rowFor = new Map<string, boolean>(
    ((switchesRes.data ?? []) as any[]).map((r) => [`${r.tenant_id}:${r.module_id}`, r.enabled === true]),
  )

  function stateOf(t: Tenant, spec: (typeof SWITCHABLE)[number]): State {
    const mod = moduleByKey.get(spec.key)
    if (!mod) return "missing"
    if (spec.planGated && !planHas.has(`${t.plan}:${mod.id}`)) return "no_plan"
    const row = rowFor.get(`${t.id}:${mod.id}`)
    return (row === undefined ? spec.defaultOn : row) ? "on" : "off"
  }

  // Plan-only modules, with the plans that include them.
  const plansFor = (moduleId: string) =>
    [...new Set(((planModulesRes.data ?? []) as any[]).filter((r) => r.module_id === moduleId).map((r) => r.plan_key as string))].sort()
  const planOnly = modules.filter((m) => !SWITCHABLE_KEYS.has(m.key))

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Modules</h1>
        <p className="mt-1 text-sm text-stone-500">
          Switch modules on or off per shop. Modules not listed in the table below are set by the shop&apos;s plan.
        </p>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Couldn&apos;t load everything: {loadError.message}
        </p>
      )}

      <section className={`${card} overflow-x-auto`}>
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-stone-400">
              <th className="py-2 pr-4 font-medium">Shop</th>
              <th className="py-2 pr-4 font-medium">Plan</th>
              {SWITCHABLE.map((m) => (
                <th key={m.key} className="py-2 pr-4 font-medium">{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {tenants.length === 0 && (
              <tr>
                <td colSpan={2 + SWITCHABLE.length} className="py-3 text-stone-500">No shops yet.</td>
              </tr>
            )}
            {tenants.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="py-3 pr-4">
                  <span className="text-stone-900">{t.name}</span>
                  <span className="block text-xs text-stone-500">/{t.slug} · {t.status}</span>
                </td>
                <td className="py-3 pr-4 text-stone-700">{t.plan}</td>
                {SWITCHABLE.map((spec) => {
                  const state = stateOf(t, spec)
                  return (
                    <td key={spec.key} className="py-3 pr-4">
                      {state === "no_plan" || state === "missing" ? (
                        <span className="text-xs text-stone-400">{state === "no_plan" ? "Not in plan" : "Not registered"}</span>
                      ) : (
                        <form action={setTenantModuleAction} className="flex items-center gap-2">
                          <input type="hidden" name="tenantId" value={t.id} />
                          <input type="hidden" name="moduleKey" value={spec.key} />
                          <input type="hidden" name="enable" value={state === "on" ? "false" : "true"} />
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${state === "on" ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}
                          >
                            {state === "on" ? "On" : "Off"}
                          </span>
                          <button
                            type="submit"
                            className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 hover:bg-stone-100"
                          >
                            {state === "on" ? "Switch off" : "Switch on"}
                          </button>
                        </form>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={card}>
        <p className="text-sm font-semibold text-stone-800">Set by plan</p>
        <p className="mt-0.5 text-sm text-stone-500">To give a shop one of these, change the shop&apos;s plan.</p>
        <div className="mt-2 divide-y divide-stone-100 text-sm">
          {planOnly.map((m) => (
            <div key={m.id} className="flex justify-between gap-4 py-2">
              <span className="text-stone-900">{m.name}</span>
              <span className="text-stone-500">{plansFor(m.id).join(", ") || "no plan"}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
