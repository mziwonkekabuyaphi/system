// app/platform/modules/page.tsx — per-shop module switches for the platform admin.
// Switchable here: kiosk, public display, staff clock-in, shisha.
// Everything else is decided by the shop's plan and is shown read-only.
// "On, hidden" = switched on but a module it needs is off (public.module_requires); see lib/tenant/effective-modules.ts.
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { setStaffLimitAction, setTenantModuleAction } from "./actions"

export const dynamic = "force-dynamic"

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"

/** What "no tenant_modules row" means, mirroring lib/services/plans.ts:
 *   booking, queue, shisha, shifts, payroll, wallet, events
 *                  isProductEnabled      not plan-gated, default OFF (opt-in)
 *   kiosk          isKioskEnabled        plan must include it, default ON
 *   display        isTenantSwitchedOn    not plan-gated, default ON
 *   staff_clock_in isTenantSwitchedOn    not plan-gated, default ON */
const SWITCHABLE: Array<{ key: string; label: string; defaultOn: boolean; planGated: boolean; group: "product" | "addon" | "feature" }> = [
  { key: "booking", label: "Booking", defaultOn: false, planGated: false, group: "product" },
  { key: "queue", label: "Queue", defaultOn: false, planGated: false, group: "product" },
  { key: "shisha", label: "Shisha", defaultOn: false, planGated: false, group: "product" },
  { key: "staff", label: "Staff Management (R30 per staff, only when sold alone)", defaultOn: false, planGated: false, group: "product" },
  { key: "shifts", label: "Shifts", defaultOn: false, planGated: false, group: "addon" },
  { key: "payroll", label: "Payroll", defaultOn: false, planGated: false, group: "addon" },
  { key: "whatsapp", label: "WhatsApp staff notifications", defaultOn: false, planGated: false, group: "addon" },
  { key: "wallet", label: "Passport (customer wallet)", defaultOn: false, planGated: false, group: "addon" },
  { key: "events", label: "Events & ticketing", defaultOn: false, planGated: false, group: "addon" },
  { key: "kiosk", label: "Kiosk", defaultOn: true, planGated: true, group: "feature" },
  { key: "display", label: "Public display", defaultOn: true, planGated: false, group: "feature" },
  { key: "staff_clock_in", label: "Staff clock-in", defaultOn: true, planGated: false, group: "feature" },
]
const SWITCHABLE_KEYS = new Set(SWITCHABLE.map((m) => m.key))

type Tenant = { id: string; name: string; slug: string; status: string; plan: string; staff_limit: number | null }
type Mod = { id: string; key: string; name: string }
type State = "on" | "off" | "blocked" | "no_plan" | "missing"

export default async function PlatformModules({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requirePlatformAdmin()
  const { error } = await searchParams
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [tenantsRes, modulesRes, planModulesRes, switchesRes, staffRes, matrixRes, requiresRes] = await Promise.all([
    supabase.from("tenants").select("id, name, slug, status, plan, staff_limit").order("name", { ascending: true }).limit(500),
    supabase.from("modules").select("id, key, name").order("key", { ascending: true }),
    supabase.from("plan_modules").select("plan_key, module_id"),
    supabase.from("tenant_modules").select("tenant_id, module_id, enabled"),
    supabase.from("staff").select("tenant_id").eq("active", true).limit(10000),
    // Effective state for every shop in one call (modules + module_requires). Switch on + parent missing = "blocked".
    supabase.rpc("platform_effective_matrix"),
    supabase.from("module_requires").select("module_key, requires_key"),
  ])

  const loadError = tenantsRes.error ?? modulesRes.error ?? planModulesRes.error ?? switchesRes.error ?? staffRes.error ?? matrixRes.error ?? requiresRes.error
  const activeStaff = new Map<string, number>()
  for (const r of (staffRes.data ?? []) as Array<{ tenant_id: string }>) {
    activeStaff.set(r.tenant_id, (activeStaff.get(r.tenant_id) ?? 0) + 1)
  }
  const tenants = (tenantsRes.data ?? []) as Tenant[]
  const modules = (modulesRes.data ?? []) as Mod[]
  const moduleByKey = new Map(modules.map((m) => [m.key, m]))

  const planHas = new Set(((planModulesRes.data ?? []) as any[]).map((r) => `${r.plan_key}:${r.module_id}`))
  const rowFor = new Map<string, boolean>(
    ((switchesRes.data ?? []) as any[]).map((r) => [`${r.tenant_id}:${r.module_id}`, r.enabled === true]),
  )

  // Which modules each module needs ("Booking or Queue"), and each shop's effective state, from the database.
  const labelOf = (key: string) => modules.find((m) => m.key === key)?.name ?? key
  const parentsOf = new Map<string, string[]>()
  for (const r of (requiresRes.data ?? []) as Array<{ module_key: string; requires_key: string }>) {
    parentsOf.set(r.module_key, [...(parentsOf.get(r.module_key) ?? []), r.requires_key])
  }
  const needsText = (key: string) => {
    const parents = parentsOf.get(key)
    return parents && parents.length > 0 ? `needs ${parents.map(labelOf).join(" or ")}` : null
  }
  const blockedByParent = new Set<string>(
    ((matrixRes.data ?? []) as Array<{ tenant_id: string; module_key: string; requirements_met: boolean }>)
      .filter((r) => !r.requirements_met)
      .map((r) => `${r.tenant_id}:${r.module_key}`),
  )

  function stateOf(t: Tenant, spec: (typeof SWITCHABLE)[number]): State {
    const mod = moduleByKey.get(spec.key)
    if (!mod) return "missing"
    if (spec.planGated && !planHas.has(`${t.plan}:${mod.id}`)) return "no_plan"
    const row = rowFor.get(`${t.id}:${mod.id}`)
    const switchedOn = row === undefined ? spec.defaultOn : row
    if (switchedOn && blockedByParent.has(`${t.id}:${spec.key}`)) return "blocked"
    return switchedOn ? "on" : "off"
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
          Choose which products each shop runs (Booking, Queue, Shisha), its add-ons, and how many staff it can have. The plan
          only sets the billing tier and the plan-only extras listed at the bottom.
        </p>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Couldn&apos;t load everything: {loadError.message}
        </p>
      )}

      <section className={`${card} overflow-x-auto`}>
        <table className="w-full min-w-[1250px] text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-stone-400">
              <th className="py-2 pr-4 font-medium">Shop</th>
              <th className="py-2 pr-4 font-medium">Plan</th>
              {SWITCHABLE.map((m) => (
                <th key={m.key} className="py-2 pr-4 font-medium">{m.label}</th>
              ))}
              <th className="py-2 pr-4 font-medium">Staff cap</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {tenants.length === 0 && (
              <tr>
                <td colSpan={3 + SWITCHABLE.length} className="py-3 text-stone-500">No shops yet.</td>
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
                          <input type="hidden" name="enable" value={state === "on" || state === "blocked" ? "false" : "true"} />
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${state === "on" ? "bg-emerald-100 text-emerald-800" : state === "blocked" ? "bg-amber-100 text-amber-800" : "bg-stone-100 text-stone-600"}`}
                            title={state === "blocked" ? `Switched on, but hidden: ${needsText(spec.key)}` : undefined}
                          >
                            {state === "on" ? "On" : state === "blocked" ? "On, hidden" : "Off"}
                          </span>
                          <button
                            type="submit"
                            className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 hover:bg-stone-100"
                          >
                            {state === "on" || state === "blocked" ? "Switch off" : "Switch on"}
                          </button>
                          {state === "blocked" && <span className="text-xs text-amber-700">{needsText(spec.key)}</span>}
                        </form>
                      )}
                    </td>
                  )
                })}
                <td className="py-3 pr-4">
                  <form action={setStaffLimitAction} className="flex items-center gap-2">
                    <input type="hidden" name="tenantId" value={t.id} />
                    <input
                      type="number"
                      name="staffLimit"
                      min={1}
                      defaultValue={t.staff_limit ?? ""}
                      placeholder="No cap"
                      aria-label={`Staff cap for ${t.name}`}
                      className="w-20 rounded-lg border border-stone-300 px-2 py-1 text-xs"
                    />
                    <button type="submit" className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 hover:bg-stone-100">
                      Save
                    </button>
                  </form>
                  <span className="mt-1 block text-xs text-stone-500">{activeStaff.get(t.id) ?? 0} active now</span>
                </td>
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
              <span className="text-stone-900">
                {m.name}
                {needsText(m.key) && <span className="ml-2 text-xs text-stone-400">{needsText(m.key)}</span>}
              </span>
              <span className="text-stone-500">{plansFor(m.id).join(", ") || "no plan"}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
