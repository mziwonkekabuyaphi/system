// app/platform/modules/page.tsx — per-shop module switches for the platform admin.
// Switchable here: products (booking, queue, shisha, staff), add-ons, and the
// kiosk / public display / staff clock-in features.
// Everything else is decided by the shop's plan and is shown read-only.
// "On, hidden" = switched on but a module it needs is off (public.module_requires); see lib/tenant/effective-modules.ts.
import { redirect } from "next/navigation"

import { PageHeader, PLATFORM_CARD } from "@/components/platform/PageHeader"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { setStaffLimitAction, setTenantModuleAction } from "./actions"

export const dynamic = "force-dynamic"

type Group = "product" | "addon" | "feature"

/** What "no tenant_modules row" means, mirroring lib/services/plans.ts:
 *   booking, queue, shisha, shifts, payroll, wallet, events, vvip
 *                  isProductEnabled      not plan-gated, default OFF (opt-in)
 *   kiosk          isKioskEnabled        plan must include it, default ON
 *   display        isTenantSwitchedOn    not plan-gated, default ON
 *   staff_clock_in isTenantSwitchedOn    not plan-gated, default ON */
const SWITCHABLE: Array<{ key: string; label: string; hint?: string; defaultOn: boolean; planGated: boolean; group: Group }> = [
  { key: "booking", label: "Booking", defaultOn: false, planGated: false, group: "product" },
  { key: "queue", label: "Queue", defaultOn: false, planGated: false, group: "product" },
  { key: "shisha", label: "Shisha", defaultOn: false, planGated: false, group: "product" },
  { key: "staff", label: "Staff Management", hint: "R30 per staff, only when sold alone", defaultOn: false, planGated: false, group: "product" },
  { key: "shifts", label: "Shifts", defaultOn: false, planGated: false, group: "addon" },
  { key: "payroll", label: "Payroll", defaultOn: false, planGated: false, group: "addon" },
  { key: "whatsapp", label: "WhatsApp staff notifications", defaultOn: false, planGated: false, group: "addon" },
  { key: "wallet", label: "Passport (customer wallet)", defaultOn: false, planGated: false, group: "addon" },
  { key: "events", label: "Events & ticketing", defaultOn: false, planGated: false, group: "addon" },
  { key: "vvip", label: "VVIP tables & tabs", defaultOn: false, planGated: false, group: "addon" },
  { key: "kiosk", label: "Kiosk", defaultOn: true, planGated: true, group: "feature" },
  { key: "display", label: "Public display", defaultOn: true, planGated: false, group: "feature" },
  { key: "staff_clock_in", label: "Staff clock-in", defaultOn: true, planGated: false, group: "feature" },
]
const SWITCHABLE_KEYS = new Set(SWITCHABLE.map((m) => m.key))

const GROUPS: Array<{ id: Group; title: string; blurb: string }> = [
  { id: "product", title: "Products", blurb: "What the shop runs" },
  { id: "addon", title: "Add-ons", blurb: "Extras that build on a product" },
  { id: "feature", title: "Features", blurb: "On by default" },
]

type Tenant = { id: string; name: string; slug: string; status: string; plan: string; staff_limit: number | null }
type Mod = { id: string; key: string; name: string }
type State = "on" | "off" | "blocked" | "no_plan" | "missing"

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
}

export default async function PlatformModules({ searchParams }: { searchParams: Promise<{ error?: string; q?: string }> }) {
  await requirePlatformAdmin()
  const { error, q } = await searchParams
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
  const allTenants = (tenantsRes.data ?? []) as Tenant[]
  const needle = (q ?? "").trim().toLowerCase()
  const tenants = needle ? allTenants.filter((t) => `${t.name} ${t.slug}`.toLowerCase().includes(needle)) : allTenants
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
    return parents && parents.length > 0 ? `Needs ${parents.map(labelOf).join(" or ")}` : null
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

  // How many shops have each module effectively on (hidden ones don't count).
  const adoption = new Map<string, number>()
  for (const spec of SWITCHABLE) {
    adoption.set(spec.key, allTenants.filter((t) => stateOf(t, spec) === "on").length)
  }

  // Plan-only modules, with the plans that include them.
  const plansFor = (moduleId: string) =>
    [...new Set(((planModulesRes.data ?? []) as any[]).filter((r) => r.module_id === moduleId).map((r) => r.plan_key as string))].sort()
  const planOnly = modules.filter((m) => !SWITCHABLE_KEYS.has(m.key))

  return (
    <main className="space-y-6">
      <PageHeader
        title="Modules & add-ons"
        count={allTenants.length}
        description="Choose which products each shop runs, the add-ons that build on them, and how many staff it can have. The plan only sets the billing tier and the plan-only extras listed at the bottom."
        actions={
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Find a shop…"
              aria-label="Find a shop"
              className="w-48 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
            />
            <button type="submit" className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
              Search
            </button>
          </form>
        }
      />

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Couldn&apos;t load everything: {loadError.message}
        </p>
      )}

      {/* Adoption across all shops, grouped the same way as each shop card below. */}
      <section className={`${PLATFORM_CARD} p-5`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-stone-800">In use across {allTenants.length} shops</p>
          <Legend />
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.id}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">{g.title}</p>
              <div className="flex flex-wrap gap-1.5">
                {SWITCHABLE.filter((s) => s.group === g.id).map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700">
                    {s.label.replace(/ \(.*\)$/, "")}
                    <span className="font-semibold tabular-nums text-stone-900">{adoption.get(s.key) ?? 0}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {tenants.length === 0 && (
        <p className={`${PLATFORM_CARD} p-6 text-sm text-stone-500`}>{needle ? `No shops match “${q}”.` : "No shops yet."}</p>
      )}

      {tenants.map((t) => (
        <section key={t.id} className={`${PLATFORM_CARD} overflow-hidden`}>
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-100 bg-stone-50/70 px-5 py-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-semibold text-stone-900">{t.name}</h2>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset ${STATUS_STYLE[t.status] ?? "bg-stone-100 text-stone-600 ring-stone-200"}`}>
                  {t.status}
                </span>
                <span className="rounded-full bg-stone-900 px-2 py-0.5 text-[11px] font-medium capitalize text-white">{t.plan}</span>
              </div>
              <p className="mt-0.5 text-xs text-stone-500">/{t.slug}</p>
            </div>

            <form action={setStaffLimitAction} className="flex items-center gap-2">
              <input type="hidden" name="tenantId" value={t.id} />
              <label className="text-xs text-stone-500" htmlFor={`cap-${t.id}`}>
                Staff cap
                <span className="ml-1 text-stone-400">({activeStaff.get(t.id) ?? 0} active)</span>
              </label>
              <input
                id={`cap-${t.id}`}
                type="number"
                name="staffLimit"
                min={1}
                defaultValue={t.staff_limit ?? ""}
                placeholder="No cap"
                className="w-24 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
              />
              <button type="submit" className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100">
                Save
              </button>
            </form>
          </header>

          <div className="grid divide-y divide-stone-100 md:grid-cols-3 md:divide-x md:divide-y-0">
            {GROUPS.map((g) => (
              <div key={g.id} className="p-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">{g.title}</p>
                <p className="mb-3 text-xs text-stone-400">{g.blurb}</p>
                <ul className="space-y-3">
                  {SWITCHABLE.filter((s) => s.group === g.id).map((spec) => {
                    const state = stateOf(t, spec)
                    const needs = needsText(spec.key)
                    return (
                      <li key={spec.key} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className={`text-sm ${state === "on" ? "font-medium text-stone-900" : "text-stone-700"}`}>{spec.label}</p>
                          {state === "blocked" ? (
                            <p className="text-xs text-amber-700">On, but hidden · {needs ?? "a required module is off"}</p>
                          ) : state === "no_plan" ? (
                            <p className="text-xs text-stone-400">Not in this plan</p>
                          ) : state === "missing" ? (
                            <p className="text-xs text-stone-400">Not registered</p>
                          ) : (
                            (spec.hint ?? needs) && <p className="text-xs text-stone-400">{spec.hint ?? needs}</p>
                          )}
                        </div>
                        {state !== "no_plan" && state !== "missing" && <Switch tenantId={t.id} moduleKey={spec.key} label={spec.label} state={state} />}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className={`${PLATFORM_CARD} p-5`}>
        <p className="text-sm font-semibold text-stone-800">Set by plan</p>
        <p className="mt-0.5 text-sm text-stone-500">To give a shop one of these, change the shop&apos;s plan.</p>
        <div className="mt-3 divide-y divide-stone-100 text-sm">
          {planOnly.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="text-stone-900">
                {m.name}
                {needsText(m.key) && <span className="ml-2 text-xs text-stone-400">{needsText(m.key)}</span>}
              </span>
              <span className="flex flex-wrap gap-1">
                {plansFor(m.id).length === 0 && <span className="text-xs text-stone-400">No plan</span>}
                {plansFor(m.id).map((p) => (
                  <span key={p} className="rounded-full bg-stone-100 px-2 py-0.5 text-xs capitalize text-stone-600">{p}</span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

/** One module switch. A form + submit button, so it works without client JS. */
function Switch({ tenantId, moduleKey, label, state }: { tenantId: string; moduleKey: string; label: string; state: State }) {
  const isOn = state === "on" || state === "blocked"
  const track = state === "on" ? "bg-emerald-600" : state === "blocked" ? "bg-amber-500" : "bg-stone-300"
  return (
    <form action={setTenantModuleAction} className="shrink-0">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="moduleKey" value={moduleKey} />
      <input type="hidden" name="enable" value={isOn ? "false" : "true"} />
      <button
        type="submit"
        role="switch"
        aria-checked={isOn}
        aria-label={`${isOn ? "Switch off" : "Switch on"} ${label}`}
        title={isOn ? "Switch off" : "Switch on"}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 ${track}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${isOn ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </form>
  )
}

function Legend() {
  const dot = (c: string) => <span className={`inline-block h-2 w-2 rounded-full ${c}`} />
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
      <span className="inline-flex items-center gap-1.5">{dot("bg-emerald-600")} On</span>
      <span className="inline-flex items-center gap-1.5">{dot("bg-amber-500")} On, hidden (needs a parent module)</span>
      <span className="inline-flex items-center gap-1.5">{dot("bg-stone-300")} Off</span>
    </div>
  )
}
