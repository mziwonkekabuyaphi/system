// app/platform/modules/page.tsx — per-shop module switches for the platform admin.
//
// Modules are grouped into FAMILIES: a product with the add-ons that belong to it, each with its own switch.
//   Product / Item Management   Stock take, Barcode / label printing
//   Staff Management            Shifts, Payroll, Staff clock-in, WhatsApp staff notifications
//   Event Management            Box office, VVIP tables & tabs
//   Booking & Queue             Kiosk, TV display
//   Shisha Lounge               Shisha monitor, Shisha mobile POS
// Customer Passport (wallet) and Custom domain are standalone.
// Everything else is decided by the shop's plan and is shown read-only at the bottom.
//
// An add-on is linked to its product in the database (public.module_requires). "On, hidden" = switched on but the
// product it needs is off; switching the product back on brings it back. See lib/tenant/effective-modules.ts.
//
// LAYOUT: an overview of how many shops use each module, then a shop picker (left) next to the selected shop's
// switches (right). The selected shop lives in the URL (?shop=<slug>) so a switch click keeps you on the same shop.
import Link from "next/link"
import { redirect } from "next/navigation"

import { PageHeader, PLATFORM_CARD } from "@/components/platform/PageHeader"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { setStaffLimitAction, setTenantModuleAction } from "./actions"

export const dynamic = "force-dynamic"

type Spec = {
  key: string
  label: string
  icon: string
  blurb: string
  hint?: string
  defaultOn: boolean
  planGated: boolean
  /** Registered and switchable, but the feature itself isn't built yet (a placeholder screen in the shop admin). */
  soon?: boolean
}

/** What "no tenant_modules row" means, mirroring lib/services/plans.ts and the modules table:
 *   booking, queue, shisha, orders, shifts, payroll, wallet, events, vvip, custom_domain, and the add-ons
 *   stock_take, barcode_labels, box_office, shisha_monitor, shisha_pos
 *                  not plan-gated, default OFF (opt-in)
 *   kiosk          plan must include it, default ON
 *   display        not plan-gated, default ON
 *   staff_clock_in not plan-gated, default ON
 *
 * Keep the keys in sync with SWITCHABLE_KEYS in ./actions.ts and the migration that registers them. */
const SPECS: Spec[] = [
  // ── products ──
  { key: "orders", label: "Product / Item Management", icon: "📦", blurb: "Products, catalogue, vendors and WhatsApp ordering with a live order board", defaultOn: false, planGated: false },
  { key: "staff", label: "Staff Management", icon: "👷", blurb: "Staff profiles and team management", hint: "R30 per staff, only when sold alone", defaultOn: false, planGated: false },
  { key: "events", label: "Event Management", icon: "🎟️", blurb: "Events, ticket sales and QR gate check-in", defaultOn: false, planGated: false },
  { key: "booking", label: "Booking", icon: "📅", blurb: "Customers book appointments by WhatsApp or online", defaultOn: false, planGated: false },
  { key: "queue", label: "Queue", icon: "🚶", blurb: "Walk-in tickets and a live queue", defaultOn: false, planGated: false },
  { key: "shisha", label: "Shisha Lounge", icon: "💨", blurb: "Sessions, coal refills and tracking", defaultOn: false, planGated: false },
  // ── add-ons ──
  { key: "stock_take", label: "Stock take", icon: "📋", blurb: "Count stock by hand and apply the differences", defaultOn: false, planGated: false },
  { key: "barcode_labels", label: "Barcode / label printing", icon: "🏷️", blurb: "Print barcodes and shelf labels for products", defaultOn: false, planGated: false, soon: true },
  { key: "shifts", label: "Shifts", icon: "🗓️", blurb: "Rosters, swaps and approvals", defaultOn: false, planGated: false },
  { key: "payroll", label: "Payroll", icon: "💵", blurb: "Staff pay runs", defaultOn: false, planGated: false },
  { key: "box_office", label: "Box office", icon: "🎫", blurb: "Sell tickets at the door or counter", defaultOn: false, planGated: false },
  { key: "vvip", label: "VVIP tables & tabs", icon: "🥂", blurb: "Reserved tables and customer tabs", defaultOn: false, planGated: false },
  { key: "kiosk", label: "Kiosk", icon: "🖥️", blurb: "Self-service kiosk", defaultOn: true, planGated: true },
  { key: "display", label: "TV display", icon: "📺", blurb: "Screen showing the queue to the room", defaultOn: true, planGated: false },
  { key: "shisha_monitor", label: "Shisha monitor", icon: "📡", blurb: "Shisha session board for a TV in the lounge", defaultOn: false, planGated: false },
  { key: "shisha_pos", label: "Shisha mobile POS", icon: "📱", blurb: "Take shisha orders and payments from a phone", defaultOn: false, planGated: false, soon: true },
  // ── standalone ──
  { key: "wallet", label: "Customer Passport", icon: "🪪", blurb: "A balance customers top up and spend (Events needs it)", defaultOn: false, planGated: false },
  { key: "whatsapp", label: "WhatsApp staff notifications", icon: "💬", blurb: "Alerts to staff on WhatsApp", defaultOn: false, planGated: false },
  { key: "custom_domain", label: "Custom domain", icon: "🌐", blurb: "Shop serves its pages on its own domain", defaultOn: false, planGated: false },
  { key: "staff_clock_in", label: "Staff clock-in", icon: "⏱️", blurb: "Staff profiles and PIN clock-in", defaultOn: true, planGated: false },
]
const SPEC_BY_KEY = new Map(SPECS.map((s) => [s.key, s]))
const SWITCHABLE_KEYS = new Set(SPECS.map((m) => m.key))

type Family = { id: string; title: string; icon: string; blurb: string; products: string[]; addons: string[]; accent: string; bar: string }

/** `products` are the main switches of the family, `addons` build on them. Order here is the order on screen. */
const FAMILIES: Family[] = [
  { id: "items", title: "Product / Item Management", icon: "📦", blurb: "Products, catalogue and orders", products: ["orders"], addons: ["stock_take", "barcode_labels"], accent: "bg-amber-500", bar: "bg-amber-500" },
  { id: "staff", title: "Staff Management", icon: "👷", blurb: "Team, rosters, pay, clock-in and alerts", products: ["staff"], addons: ["shifts", "payroll", "staff_clock_in", "whatsapp"], accent: "bg-indigo-500", bar: "bg-indigo-500" },
  { id: "events", title: "Event Management", icon: "🎟️", blurb: "Tickets, door sales and tables", products: ["events"], addons: ["box_office", "vvip"], accent: "bg-rose-500", bar: "bg-rose-500" },
  { id: "bookqueue", title: "Booking & Queue", icon: "📅", blurb: "Appointments, walk-ins, kiosk and TV", products: ["booking", "queue"], addons: ["kiosk", "display"], accent: "bg-sky-500", bar: "bg-sky-500" },
  { id: "shisha", title: "Shisha Lounge", icon: "💨", blurb: "Sessions, monitor and POS", products: ["shisha"], addons: ["shisha_monitor", "shisha_pos"], accent: "bg-emerald-500", bar: "bg-emerald-500" },
]
const STANDALONE: string[] = ["wallet", "custom_domain"]

type Tenant = { id: string; name: string; slug: string; status: string; plan: string; staff_limit: number | null }
type Mod = { id: string; key: string; name: string }
type State = "on" | "off" | "blocked" | "no_plan" | "missing"

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
}

export default async function PlatformModules({ searchParams }: { searchParams: Promise<{ error?: string; q?: string; shop?: string }> }) {
  await requirePlatformAdmin()
  const { error, q, shop } = await searchParams
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
  const selected = tenants.find((t) => t.slug === shop) ?? tenants[0] ?? null
  const modules = (modulesRes.data ?? []) as Mod[]
  const moduleByKey = new Map(modules.map((m) => [m.key, m]))

  const planHas = new Set(((planModulesRes.data ?? []) as any[]).map((r) => `${r.plan_key}:${r.module_id}`))
  const rowFor = new Map<string, boolean>(
    ((switchesRes.data ?? []) as any[]).map((r) => [`${r.tenant_id}:${r.module_id}`, r.enabled === true]),
  )

  // Which modules each module needs ("Booking or Queue"), and each shop's effective state, from the database.
  const labelOf = (key: string) => SPEC_BY_KEY.get(key)?.label ?? modules.find((m) => m.key === key)?.name ?? key
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

  function stateOf(t: Tenant, spec: Spec): State {
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
  for (const spec of SPECS) {
    adoption.set(spec.key, allTenants.filter((t) => stateOf(t, spec) === "on").length)
  }

  // Plan-only modules, with the plans that include them.
  const plansFor = (moduleId: string) =>
    [...new Set(((planModulesRes.data ?? []) as any[]).filter((r) => r.module_id === moduleId).map((r) => r.plan_key as string))].sort()
  const planOnly = modules.filter((m) => !SWITCHABLE_KEYS.has(m.key))

  const shopHref = (slug: string) => {
    const p = new URLSearchParams()
    if (q) p.set("q", q)
    p.set("shop", slug)
    return `/platform/modules?${p.toString()}`
  }
  const specsOf = (keys: string[]) => keys.map((k) => SPEC_BY_KEY.get(k)).filter((s): s is Spec => Boolean(s))
  const familyOn = (t: Tenant, f: Family) => f.products.some((k) => { const s = SPEC_BY_KEY.get(k); return s ? stateOf(t, s) === "on" : false })
  const onCount = (t: Tenant) => SPECS.filter((s) => stateOf(t, s) === "on").length

  return (
    <main className="space-y-6">
      <PageHeader
        title="Modules & add-ons"
        count={allTenants.length}
        description="Choose which products each shop runs and the add-ons that build on them, plus how many staff it can have. Add-ons sit under the product they belong to. The plan only sets the billing tier and the plan-only extras listed at the bottom."
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
            {needle && (
              <Link href="/platform/modules" className="text-sm text-stone-500 underline-offset-2 hover:underline">
                Clear
              </Link>
            )}
          </form>
        }
      />

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Couldn&apos;t load everything: {loadError.message}
        </p>
      )}

      {/* ── Overview: how many shops use each module, family by family ───────── */}
      <section aria-label="Adoption across all shops" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-800">In use across {allTenants.length} shops</h2>
          <p className="text-xs text-stone-400">Shops with the module switched on and not hidden</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {FAMILIES.map((f) => (
            <div key={f.id} className={`${PLATFORM_CARD} p-4`}>
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-800">
                <span aria-hidden="true">{f.icon}</span>
                {f.title}
              </p>
              <AdoptionList specs={specsOf(f.products)} adoption={adoption} total={allTenants.length} bar={f.bar} />
              <p className="mb-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-stone-400">Add-ons</p>
              <AdoptionList specs={specsOf(f.addons)} adoption={adoption} total={allTenants.length} bar="bg-stone-400" />
            </div>
          ))}
          <div className={`${PLATFORM_CARD} p-4`}>
            <p className="mb-3 text-sm font-semibold text-stone-800">Standalone</p>
            <AdoptionList specs={specsOf(STANDALONE)} adoption={adoption} total={allTenants.length} bar="bg-stone-500" />
          </div>
        </div>
      </section>

      {tenants.length === 0 ? (
        <p className={`${PLATFORM_CARD} p-6 text-sm text-stone-500`}>{needle ? `No shops match “${q}”.` : "No shops yet."}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          {/* ── Shop picker ───────────────────────────────────────────────────── */}
          <aside aria-label="Shops" className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start">
            <div className={`${PLATFORM_CARD} flex max-h-72 flex-col overflow-hidden lg:max-h-[calc(100vh-2rem)]`}>
              <p className="border-b border-stone-100 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-stone-400">
                {needle ? `${tenants.length} of ${allTenants.length} shops` : `${tenants.length} shops`}
              </p>
              <nav className="flex-1 space-y-1 overflow-y-auto p-2">
                {tenants.map((t) => {
                  const active = selected?.id === t.id
                  return (
                    <Link
                      key={t.id}
                      href={shopHref(t.slug)}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-xl px-3 py-2.5 transition-colors ${active ? "bg-stone-900 text-white" : "text-stone-800 hover:bg-stone-100"}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{t.name}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${active ? "bg-white/15 text-white" : "bg-stone-100 text-stone-600"}`}>
                          {t.plan}
                        </span>
                      </span>
                      <span className="mt-1.5 flex items-center gap-1" aria-hidden="true">
                        {FAMILIES.map((f) => {
                          const on = familyOn(t, f)
                          const dot = on ? "bg-emerald-500" : active ? "bg-white/25" : "bg-stone-200"
                          return <span key={f.id} title={`${f.title}: ${on ? "on" : "off"}`} className={`h-1.5 w-4 rounded-full ${dot}`} />
                        })}
                      </span>
                    </Link>
                  )
                })}
              </nav>
            </div>
          </aside>

          {/* ── Selected shop ─────────────────────────────────────────────────── */}
          {selected && (
            <section aria-label={`Modules for ${selected.name}`} className="min-w-0 space-y-6">
              <div className={`${PLATFORM_CARD} overflow-hidden`}>
                <header className="flex flex-wrap items-center justify-between gap-4 bg-gradient-to-br from-stone-900 to-stone-700 px-6 py-5 text-white">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-xl font-semibold">{selected.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset ${STATUS_STYLE[selected.status] ?? "bg-stone-100 text-stone-600 ring-stone-200"}`}>
                        {selected.status}
                      </span>
                      <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium capitalize text-white">{selected.plan}</span>
                    </div>
                    <p className="mt-1 text-xs text-stone-300">/{selected.slug}</p>
                  </div>

                  <form action={setStaffLimitAction} className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
                    <input type="hidden" name="tenantId" value={selected.id} />
                    <label className="text-xs text-stone-200" htmlFor={`cap-${selected.id}`}>
                      Staff cap
                      <span className="ml-1 text-stone-400">({activeStaff.get(selected.id) ?? 0} active)</span>
                    </label>
                    <input
                      id={`cap-${selected.id}`}
                      type="number"
                      name="staffLimit"
                      min={1}
                      defaultValue={selected.staff_limit ?? ""}
                      placeholder="No cap"
                      className="w-24 rounded-lg border border-stone-500 bg-white px-2 py-1.5 text-sm text-stone-900"
                    />
                    <button type="submit" className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-stone-900 hover:bg-stone-100">
                      Save
                    </button>
                  </form>
                </header>

                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-stone-100 px-6 py-3 text-xs text-stone-500">
                  <span>
                    <span className="font-semibold tabular-nums text-stone-900">{onCount(selected)}</span> of {SPECS.length} modules on
                  </span>
                  <Legend />
                </div>
              </div>

              {FAMILIES.map((f) => (
                <FamilyCard key={f.id} family={f} tenantId={selected.id} specs={SPEC_BY_KEY} stateOf={(s) => stateOf(selected, s)} needsText={needsText} />
              ))}

              <div className={`${PLATFORM_CARD} overflow-hidden`}>
                <div className="border-b border-stone-100 px-5 py-3">
                  <h3 className="text-sm font-semibold text-stone-800">Standalone</h3>
                  <p className="text-xs text-stone-400">Not tied to one product</p>
                </div>
                <ul className="grid gap-3 p-4 sm:grid-cols-2">
                  {specsOf(STANDALONE).map((spec) => (
                    <li key={spec.key}>
                      <ModuleRow tenantId={selected.id} spec={spec} state={stateOf(selected, spec)} needs={needsText(spec.key)} kind="addon" />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>
      )}

      <section className={`${PLATFORM_CARD} p-5`}>
        <p className="text-sm font-semibold text-stone-800">Set by plan</p>
        <p className="mt-0.5 text-sm text-stone-500">To give a shop one of these, change the shop&apos;s plan.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {planOnly.map((m) => (
            <div key={m.id} className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
              <p className="text-sm font-medium text-stone-900">{m.name}</p>
              {needsText(m.key) && <p className="text-xs text-stone-400">{needsText(m.key)}</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                {plansFor(m.id).length === 0 && <span className="text-xs text-stone-400">No plan</span>}
                {plansFor(m.id).map((p) => (
                  <span key={p} className="rounded-full bg-white px-2 py-0.5 text-xs capitalize text-stone-600 ring-1 ring-inset ring-stone-200">{p}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

/** Adoption bars for a list of modules (overview). */
function AdoptionList({ specs, adoption, total, bar }: { specs: Spec[]; adoption: Map<string, number>; total: number; bar: string }) {
  return (
    <ul className="space-y-2.5">
      {specs.map((s) => {
        const n = adoption.get(s.key) ?? 0
        const pct = total > 0 ? Math.round((n / total) * 100) : 0
        return (
          <li key={s.key}>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-stone-700">
                <span aria-hidden="true" className="mr-1.5">{s.icon}</span>
                {s.label}
              </span>
              <span className="shrink-0 tabular-nums text-stone-500">
                <span className="font-semibold text-stone-900">{n}</span> / {total}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-100" role="presentation">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** One product family for the selected shop: the product switch(es) on top, its add-ons nested underneath. */
function FamilyCard({
  family,
  tenantId,
  specs,
  stateOf,
  needsText,
}: {
  family: Family
  tenantId: string
  specs: Map<string, Spec>
  stateOf: (s: Spec) => State
  needsText: (key: string) => string | null
}) {
  const products = family.products.map((k) => specs.get(k)).filter((s): s is Spec => Boolean(s))
  const addons = family.addons.map((k) => specs.get(k)).filter((s): s is Spec => Boolean(s))
  const productOn = products.some((p) => stateOf(p) === "on")
  const addonsOn = addons.filter((a) => stateOf(a) === "on").length

  return (
    <div className={`${PLATFORM_CARD} overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`h-8 w-1.5 shrink-0 rounded-full ${family.accent}`} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-stone-800">{family.title}</h3>
            <p className="text-xs text-stone-400">{family.blurb}</p>
          </div>
        </div>
        <span className="shrink-0 text-xs text-stone-500">
          <span className="font-semibold tabular-nums text-stone-900">{addonsOn}</span> of {addons.length} add-ons on
        </span>
      </div>

      <div className="space-y-4 p-4">
        <ul className={products.length > 1 ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
          {products.map((spec) => (
            <li key={spec.key}>
              <ModuleRow tenantId={tenantId} spec={spec} state={stateOf(spec)} needs={needsText(spec.key)} kind="product" />
            </li>
          ))}
        </ul>

        <div>
          <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
            Add-ons
            {!productOn && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-800">Switch the product on first</span>}
          </p>
          <ul className="grid gap-3 border-l-2 border-stone-200 pl-4 sm:grid-cols-2">
            {addons.map((spec) => (
              <li key={spec.key}>
                <ModuleRow tenantId={tenantId} spec={spec} state={stateOf(spec)} needs={needsText(spec.key)} kind="addon" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/** One module for the selected shop: icon, name, what it is, its state and the switch. */
function ModuleRow({ tenantId, spec, state, needs, kind }: { tenantId: string; spec: Spec; state: State; needs: string | null; kind: "product" | "addon" }) {
  const tone =
    state === "on"
      ? "border-emerald-200 bg-emerald-50/60"
      : state === "blocked"
        ? "border-amber-200 bg-amber-50/60"
        : "border-stone-200 bg-white"
  const pill =
    state === "on"
      ? { text: "On", cls: "bg-emerald-100 text-emerald-800" }
      : state === "blocked"
        ? { text: "On, hidden", cls: "bg-amber-100 text-amber-800" }
        : state === "no_plan"
          ? { text: "Not in plan", cls: "bg-stone-100 text-stone-500" }
          : state === "missing"
            ? { text: "Not registered", cls: "bg-stone-100 text-stone-500" }
            : { text: "Off", cls: "bg-stone-100 text-stone-500" }
  const note =
    state === "blocked" ? (needs ?? "A required module is off") : state === "no_plan" || state === "missing" ? null : (spec.hint ?? needs)
  const canSwitch = state !== "no_plan" && state !== "missing"
  const big = kind === "product"

  const labelCls = `font-semibold ${state === "on" || state === "blocked" ? "text-stone-900" : "text-stone-700"}`

  return (
    <div className={`flex h-full items-center gap-3 rounded-2xl border transition-colors ${big ? "p-4" : "p-3"} ${tone}`}>
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-stone-200 ${big ? "h-11 w-11 text-2xl" : "h-10 w-10 text-lg"}`}
      >
        {spec.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={`${big ? "text-sm" : "text-[13px]"} ${labelCls}`}>{spec.label}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${pill.cls}`}>{pill.text}</span>
          {spec.soon && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">In development</span>}
        </p>
        <p className="text-xs text-stone-500">{spec.blurb}</p>
        {note && <p className={`mt-1 text-xs ${state === "blocked" ? "text-amber-700" : "text-stone-400"}`}>{state === "blocked" ? `Hidden · ${note}` : note}</p>}
      </div>
      {canSwitch && <Switch tenantId={tenantId} moduleKey={spec.key} label={spec.label} state={state} />}
    </div>
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
      <span className="inline-flex items-center gap-1.5">{dot("bg-amber-500")} On, hidden (needs its product)</span>
      <span className="inline-flex items-center gap-1.5">{dot("bg-stone-300")} Off</span>
    </div>
  )
}
