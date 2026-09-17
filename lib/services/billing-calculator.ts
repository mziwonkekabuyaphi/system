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
 * THE ONE FORMULA THAT COVERS ALL THREE PLANS:
 *   overage_visits = visit_limit === null
 *     ? actual_visits                      -- Business: nothing is "included", every visit bills
 *     : max(actual_visits - visit_limit, 0) -- Growth: only visits past the included allotment bill
 *   usage_charge   = price_per_visit_cents === null ? 0 : overage_visits * price_per_visit_cents
 *   total          = base_fee_cents + usage_charge
 *
 * Free (visit_limit=100, price_per_visit_cents=null) falls out of this
 * for free: usage_charge is always 0 because there's no per-visit rate to
 * multiply by -- consistent with "No overage on Free" being enforced as
 * a hard block elsewhere (assertWithinVisitLimit in plans.ts), not billed.
 */

import type { Plan } from "./plans"

export interface BillingCalculation {
  planKey: string
  currency: string
  /** Flat monthly platform fee, in cents. 0 for Free. */
  baseFeeCents: number
  /** Visits included in the base fee before the per-visit rate applies.
   *  null = no included allotment at all (Business: every visit bills). */
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
  /** baseFeeCents + usageChargeCents. What the tenant actually owes for this period. */
  totalCents: number
}

export function calculateBilling(plan: Plan, actualVisits: number): BillingCalculation {
  const includedVisits = plan.visitLimit
  const includedVisitsUsed = includedVisits === null ? actualVisits : Math.min(actualVisits, includedVisits)
  const overageVisits = includedVisits === null ? actualVisits : Math.max(actualVisits - includedVisits, 0)
  const perVisitRateCents = plan.pricePerVisitCents
  const usageChargeCents = perVisitRateCents === null ? 0 : overageVisits * perVisitRateCents
  const baseFeeCents = plan.priceCents

  return {
    planKey: plan.key,
    currency: plan.currency,
    baseFeeCents,
    includedVisits,
    actualVisits,
    includedVisitsUsed,
    overageVisits,
    perVisitRateCents,
    usageChargeCents,
    totalCents: baseFeeCents + usageChargeCents,
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
