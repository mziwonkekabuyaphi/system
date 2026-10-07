// lib/services/pricing.ts
/**
 * Public pricing data for the marketing pages (landing page + /pricing).
 *
 * EVERYTHING a visitor sees about plans -- prices, staff, visit allowances,
 * feature lists, and the numbers inside the FAQ answers -- is read from the
 * same `plans` / `plan_modules` / `modules` tables the admin Billing panel
 * uses, so the website and the admin can never disagree. Edit a price or a
 * feature in the database and both update (within the pages' revalidate
 * window). Nothing in here hardcodes a price.
 *
 * Server-only: it uses the service-role client. The marketing pages are
 * server components, so nothing sensitive reaches the browser -- they only
 * render the plan fields below.
 *
 * Returns null on any failure so a database hiccup shows a friendly "get in
 * touch" message instead of crashing the whole marketing page.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { listPlans, type Plan } from "@/lib/services/plans"

export interface PlanFeature {
  key: string
  name: string
}

export interface PublicPlan extends Plan {
  /** Every module on this plan, in display order. */
  features: PlanFeature[]
  /** Modules this plan adds on top of the previous (cheaper) plan. */
  newFeatures: PlanFeature[]
}

/** Display order for features. Unknown keys sort after these, alphabetically. */
const FEATURE_ORDER = [
  "booking",
  "queue",
  "live_dashboard",
  "kiosk",
  "staff_clock_in",
  "business_hours",
  "whatsapp",
  "payroll",
  "priority_support",
  "branding",
  "remove_powered_by",
]

export async function getPublicPricing(): Promise<{ plans: PublicPlan[] } | null> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return null

  try {
    const plans = await listPlans(supabase)
    if (plans.length === 0) return null

    const { data, error } = await supabase
      .from("plan_modules")
      .select("plan_key, modules(key, name)")
      .in(
        "plan_key",
        plans.map((p) => p.key),
      )
    if (error) throw new Error(error.message)

    const byPlan = new Map<string, PlanFeature[]>()
    for (const row of data ?? []) {
      const mod = (row as any).modules as { key: string; name: string } | null
      if (!mod) continue
      const planKey = (row as any).plan_key as string
      const list = byPlan.get(planKey) ?? []
      list.push({ key: mod.key, name: mod.name })
      byPlan.set(planKey, list)
    }

    const rank = (key: string) => {
      const i = FEATURE_ORDER.indexOf(key)
      return i === -1 ? FEATURE_ORDER.length : i
    }

    let previousKeys = new Set<string>()
    const result: PublicPlan[] = plans.map((plan) => {
      const features = (byPlan.get(plan.key) ?? []).sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name))
      const newFeatures = features.filter((f) => !previousKeys.has(f.key))
      previousKeys = new Set(features.map((f) => f.key))
      return { ...plan, features, newFeatures }
    })

    return { plans: result }
  } catch (err) {
    console.error("[pricing] failed to load public pricing", err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Copy helpers -- every number comes from the plan rows
// ---------------------------------------------------------------------------

/** "R499", "R1,499" for whole rands; "R1.50" when there are cents. Deliberately
 *  NOT the admin's formatCents (en-ZA gives "R1 499,00"): the marketing pages
 *  and the plans guide write money as R1,499 and R1.50, so that's what visitors see. */
export function money(cents: number, currency = "ZAR"): string {
  const symbol = currency === "ZAR" ? "R" : `${currency} `
  return `${symbol}${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** Per-visit rates always show cents ("R1.50", "R1.00") so rates read the same way everywhere. */
export function rate(cents: number, currency = "ZAR"): string {
  const symbol = currency === "ZAR" ? "R" : `${currency} `
  return `${symbol}${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** ["a", "b", "c"] -> "a, b and c" */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

/** The small line under a plan's price, e.g.
 *  "100 visits, once off · 1 staff"  or
 *  "Includes 2 staff · R149 per extra staff, up to 8 · 250 visits per staff/month, then R1.50/visit". */
export function planMeterLine(plan: Plan): string {
  if (plan.visitsPerStaff === null) {
    const visits =
      plan.visitLimit === null
        ? "Unlimited visits"
        : `${plan.visitLimit.toLocaleString("en-US")} visits${plan.visitLimitPeriod === "lifetime" ? ", once off" : " a month"}`
    return `${visits} · ${plan.includedStaff} ${plural(plan.includedStaff, "staff", "staff")}`
  }

  const parts = [`Includes ${plan.includedStaff} staff`]
  if (plan.extraStaffPriceCents !== null) {
    const limit = plan.staffLimit === null ? "no limit" : `up to ${plan.staffLimit}`
    parts.push(`${money(plan.extraStaffPriceCents, plan.currency)} per extra staff, ${limit}`)
  }
  const perVisit = plan.pricePerVisitCents !== null ? `, then ${rate(plan.pricePerVisitCents, plan.currency)}/visit` : ""
  parts.push(`${plan.visitsPerStaff.toLocaleString("en-US")} visits per staff/month${perVisit}`)
  return parts.join(" · ")
}

/** FAQ: "What happens if I go over my monthly visit limit?" */
export function overageFaq(plans: PublicPlan[] | null | undefined): string {
  const metered = (plans ?? []).filter((p) => p.pricePerVisitCents !== null && p.visitsPerStaff !== null)
  if (metered.length === 0) {
    return "You’re never cut off. Visits past your allowance are billed per visit — get in touch for the current rates."
  }
  const sameAllowance = metered.every((p) => p.visitsPerStaff === metered[0].visitsPerStaff)
  const allowance = sameAllowance
    ? `Every staff member comes with ${metered[0].visitsPerStaff!.toLocaleString("en-US")} visits a month.`
    : "Every staff member comes with a monthly visit allowance."
  const rates = joinList(metered.map((p) => `${rate(p.pricePerVisitCents!, p.currency)} each on ${p.name}`))
  return `You’re never cut off. ${allowance} Past that, extra visits are billed at ${rates}, with no cap.`
}

/** FAQ: "Can I try it before paying anything?" */
export function freePlanFaq(plans: PublicPlan[] | null | undefined): string {
  const free = (plans ?? []).find((p) => p.priceCents === 0)
  if (!free) return "Yes — get in touch and we’ll set you up to try it on real customers before you pay anything."

  const visits =
    free.visitLimit === null
      ? "unlimited visits"
      : `${free.visitLimit.toLocaleString("en-US")} visits${free.visitLimitPeriod === "lifetime" ? " once off" : " a month"}`
  const kiosk = free.features.some((f) => f.key === "kiosk") ? " with the self-service kiosk included," : ""
  const whatsappPlan = (plans ?? []).find((p) => p.key !== free.key && p.newFeatures.some((f) => f.key === "whatsapp"))
  const whatsappNote =
    whatsappPlan && !free.features.some((f) => f.key === "whatsapp") ? ` WhatsApp booking comes with ${whatsappPlan.name}.` : ""

  return (
    `Yes — the ${free.name} plan is free, with ${visits} to test on real customers and ` +
    `${free.includedStaff} staff ${plural(free.includedStaff, "member")},${kiosk} so you can see it running in ` +
    `your own shop before deciding to upgrade.${whatsappNote}`
  )
}
