// lib/services/billing-calculator.ts
/**
 * Single source of truth for ZozoQ billing math. Nothing here touches
 * Supabase -- pure functions only, so the same calculation can run in a
 * server action (live "current estimated bill" preview), the monthly
 * invoicing cron (plans.ts's generateMonthlyInvoices), and a unit test,
 * without ever risking the three call sites drifting out of sync.
 *
 * ALL MONEY IS INTEGER CENTS. Never do money arithmetic in floats --
 * that's how a R499.00 becomes R498.9999999999999 somewhere down the
 * line. Division only ever happens at the very end, for display.
 *
 * THE ONE FORMULA THAT COVERS ALL THREE PLANS (per-staff pricing):
 *   billed_staff    = max(staff_count, included_staff)
 *   extra_staff     = max(staff_count - included_staff, 0)
 *   extra_staff_fee = extra_staff * (extra_staff_price_cents ?? 0)
 *   included_visits = visits_per_staff !== null
 *     ? visits_per_staff * billed_staff    -- Growth/Business: the allowance grows with staff
 *     : visit_limit                        -- Free: flat allowance (null = nothing included)
 *   overage_visits  = included_visits === null
 *     ? actual_visits                      -- nothing is "included", every visit bills
 *     : max(actual_visits - included_visits, 0)
 *   usage_charge    = price_per_visit_cents === null ? 0 : overage_visits * price_per_visit_cents
 *   total           = base_fee_cents + extra_staff_fee + usage_charge
 *
 * Free (visit_limit=100, price_per_visit_cents=null, no extra-staff price)
 * falls out of this for free: usage_charge and extra_staff_fee are always 0 --
 * consistent with "No overage on Free" being enforced as a hard block
 * elsewhere (assertWithinVisitLimit / staffLimitError in plans.ts), not billed.
 */

import type { Plan } from "./plans"

export interface BillingCalculation {
  planKey: string
  currency: string
  /** Flat monthly platform fee, in cents. 0 for Free. Covers `includedStaff` staff. */
  baseFeeCents: number
  /** Active staff being billed for. */
  staffCount: number
  /** Staff covered by the base fee. */
  includedStaff: number
  /** staffCount beyond includedStaff. */
  extraStaff: number
  /** extraStaff * the plan's price per extra staff, in cents. 0 when the plan doesn't offer extra staff. */
  extraStaffFeeCents: number
  /** Visits included in the base fee before the per-visit rate applies. On per-staff
   *  plans this is visitsPerStaff x max(staffCount, includedStaff).
   *  null = no included allotment at all (every visit bills). */
  includedVisits: number | null
  /** Total visits being billed for, in the period this calculation covers. */
  actualVisits: number
  /** min(actualVisits, includedVisits ?? actualVisits) -- visits that were "free" under the base fee. */
  includedVisitsUsed: number
  /** Visits beyond includedVisits (or ALL visits, when includedVisits is null). */
  overageVisits: number
  /** Rate charged per overage visit, in cents. null = no per-visit charge at all (Free). */
  perVisitRateCents: number | null
  /** overageVisits * (perVisitRateCents ?? 0). */
  usageChargeCents: number
  /** baseFeeCents + extraStaffFeeCents + usageChargeCents. What the tenant actually owes for this period. */
  totalCents: number
}

/**
 * @param staffCount Active staff to bill for. Defaults to the plan's included
 *   staff, i.e. "no extra staff", so a caller that doesn't know the staff count
 *   gets the plan's base price rather than an error.
 */
export function calculateBilling(plan: Plan, actualVisits: number, staffCount: number = plan.includedStaff): BillingCalculation {
  const billedStaff = Math.max(staffCount, plan.includedStaff)
  const extraStaff = Math.max(staffCount - plan.includedStaff, 0)
  const extraStaffFeeCents = extraStaff * (plan.extraStaffPriceCents ?? 0)

  const includedVisits = plan.visitsPerStaff !== null ? plan.visitsPerStaff * billedStaff : plan.visitLimit
  const includedVisitsUsed = includedVisits === null ? actualVisits : Math.min(actualVisits, includedVisits)
  const overageVisits = includedVisits === null ? actualVisits : Math.max(actualVisits - includedVisits, 0)
  const perVisitRateCents = plan.pricePerVisitCents
  const usageChargeCents = perVisitRateCents === null ? 0 : overageVisits * perVisitRateCents
  const baseFeeCents = plan.priceCents

  return {
    planKey: plan.key,
    currency: plan.currency,
    baseFeeCents,
    staffCount,
    includedStaff: plan.includedStaff,
    extraStaff,
    extraStaffFeeCents,
    includedVisits,
    actualVisits,
    includedVisitsUsed,
    overageVisits,
    perVisitRateCents,
    usageChargeCents,
    totalCents: baseFeeCents + extraStaffFeeCents + usageChargeCents,
  }
}

/** "R499.00", "R1,783.00" -- South African Rand from integer cents. Never
 *  format money any other way; this is the one place that does the /100. */
export function formatCents(cents: number, currency = "ZAR"): string {
  const symbol = currency === "ZAR" ? "R" : `${currency} `
  const rands = cents / 100
  return `${symbol}${rands.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Whole-number rand for compact UI moments ("R499/mo" not "R499.00/mo"). */
export function formatCentsCompact(cents: number, currency = "ZAR"): string {
  const symbol = currency === "ZAR" ? "R" : `${currency} `
  const rands = Math.round(cents / 100)
  return `${symbol}${rands.toLocaleString("en-ZA")}`
}
