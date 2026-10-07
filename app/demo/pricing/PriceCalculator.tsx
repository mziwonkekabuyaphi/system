"use client"

// app/demo/pricing/PriceCalculator.tsx
//
// "What would I pay?" -- a visitor enters their staff count and visits per
// month and sees the price on every plan side by side. It uses the SAME
// calculateBilling() the admin Billing panel and the monthly invoice job use,
// on plan rows passed in from the database, so this page can't quote a number
// that the real bill wouldn't match.

import { useMemo, useState } from "react"
import styles from "../demo.module.css"
import { calculateBilling } from "@/lib/services/billing-calculator"
import type { Plan } from "@/lib/services/plans"

/** "R1,499" for whole rands, "R1.50" when there are cents. (Same rule as money()
 *  in lib/services/pricing.ts, which can't be imported here: it's server-only.) */
function money(cents: number, currency: string): string {
  const symbol = currency === "ZAR" ? "R" : `${currency} `
  return `${symbol}${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`
}

function clampInt(text: string, min: number, max: number): number {
  const n = Math.floor(Number(text))
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

const inputStyle: React.CSSProperties = {
  width: 140,
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(128,128,128,0.45)",
  background: "transparent",
  color: "inherit",
  font: "inherit",
}

export function PriceCalculator({ plans }: { plans: Plan[] }) {
  const [staffText, setStaffText] = useState("3")
  const [visitsText, setVisitsText] = useState("600")

  const staff = clampInt(staffText, 1, 200)
  const visits = clampInt(visitsText, 0, 1_000_000)

  const results = useMemo(
    () =>
      plans.map((plan) => {
        const calc = calculateBilling(plan, visits, staff)
        const onceOff = plan.visitLimitPeriod === "lifetime"

        let unavailable: string | null = null
        if (plan.staffLimit !== null && staff > plan.staffLimit) {
          unavailable = `${plan.name} allows up to ${plan.staffLimit} staff.`
        } else if (plan.pricePerVisitCents === null && plan.visitLimit !== null && visits > plan.visitLimit) {
          unavailable = onceOff
            ? `${plan.name} covers ${plan.visitLimit.toLocaleString("en-US")} visits, once off.`
            : `${plan.name} covers ${plan.visitLimit.toLocaleString("en-US")} visits a month.`
        }
        return { plan, calc, unavailable, onceOff }
      }),
    [plans, staff, visits],
  )

  // "Best price" is only for plans you could stay on every month, so a once-off
  // trial plan never takes the badge.
  const best = results
    .filter((r) => !r.unavailable && !r.onceOff)
    .reduce<(typeof results)[number] | null>((winner, r) => (!winner || r.calc.totalCents < winner.calc.totalCents ? r : winner), null)

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, margin: "0 0 28px" }}>
        <label htmlFor="calc-staff" style={{ display: "grid", gap: 6 }}>
          <span>How many staff?</span>
          <input
            id="calc-staff"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={staffText}
            onChange={(e) => setStaffText(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label htmlFor="calc-visits" style={{ display: "grid", gap: 6 }}>
          <span>Customers served per month?</span>
          <input
            id="calc-visits"
            type="number"
            inputMode="numeric"
            min={0}
            step={50}
            value={visitsText}
            onChange={(e) => setVisitsText(e.target.value)}
            style={inputStyle}
          />
        </label>
      </div>

      <div className={styles.plans}>
        {results.map(({ plan, calc, unavailable, onceOff }) => {
          const isBest = best?.plan.key === plan.key
          const parts: string[] = []
          if (calc.baseFeeCents > 0) parts.push(`${money(calc.baseFeeCents, plan.currency)} plan`)
          if (calc.extraStaff > 0) {
            parts.push(`${money(calc.extraStaffFeeCents, plan.currency)} for ${calc.extraStaff} extra staff`)
          }
          if (calc.overageVisits > 0 && calc.usageChargeCents > 0) {
            parts.push(`${money(calc.usageChargeCents, plan.currency)} for ${calc.overageVisits.toLocaleString("en-US")} extra visits`)
          }

          return (
            <div key={plan.key} className={isBest ? `${styles.plan} ${styles.planBusiness}` : styles.plan} style={unavailable ? { opacity: 0.6 } : undefined}>
              <p className={styles.planName}>
                {plan.name}
                {isBest ? " · best price for you" : ""}
              </p>
              {unavailable ? (
                <>
                  <p className={styles.planPrice}>—</p>
                  <p className={styles.planMeter}>{unavailable}</p>
                </>
              ) : (
                <>
                  <p className={styles.planPrice}>
                    {money(calc.totalCents, plan.currency)}
                    {!onceOff && calc.totalCents > 0 && <span className={styles.planPriceUnit}>/month</span>}
                  </p>
                  <p className={styles.planMeter}>
                    {onceOff
                      ? `Free for your first ${plan.visitLimit?.toLocaleString("en-US")} visits, once off.`
                      : parts.length > 0
                        ? parts.join(" + ")
                        : "No charge"}
                  </p>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
