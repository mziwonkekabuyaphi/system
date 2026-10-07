// app/demo/PlanCards.tsx
//
// The three plan cards, shared by the landing page and /pricing so the two
// can never drift apart. Everything numeric or feature-related comes from the
// database via getPublicPricing(); only the one-line taglines are written by
// hand here, because they're marketing voice, not data.
//
// Each plan lists only what it ADDS on top of the cheaper plan, under an
// "Everything in <previous plan>" line -- computed from plan_modules.

import styles from "./demo.module.css"
import { money, planMeterLine, type PublicPlan } from "@/lib/services/pricing"

const TAGLINES: Record<string, string> = {
  free: "Try it on real customers, no card needed",
  growth: "For a shop that’s outgrown “just trying it out”",
  business: "Growth, fully under your own name",
}

/** The middle plan gets the highlighted card style the landing page already uses. */
const FEATURED_PLAN_KEY = "growth"

export function PlanCards({ plans }: { plans: PublicPlan[] }) {
  return (
    <div className={styles.plans}>
      {plans.map((plan, index) => {
        const previous = index > 0 ? plans[index - 1] : null
        const tagline = TAGLINES[plan.key]
        return (
          <div key={plan.key} className={plan.key === FEATURED_PLAN_KEY ? `${styles.plan} ${styles.planBusiness}` : styles.plan}>
            <p className={styles.planName}>{plan.name}</p>
            <p className={styles.planPrice}>
              {money(plan.priceCents, plan.currency)}
              {plan.priceCents > 0 && <span className={styles.planPriceUnit}>/month</span>}
            </p>
            <p className={styles.planMeter}>{planMeterLine(plan)}</p>
            {tagline && <h3>{tagline}</h3>}
            <ul>
              {previous && <li>Everything in {previous.name}</li>}
              {plan.newFeatures.map((feature) => (
                <li key={feature.key}>{feature.name}</li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
