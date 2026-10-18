// app/demo/PlansSection.tsx
//
// The "Plans" block that used to sit near the bottom of the landing page (page.tsx),
// cut out to keep that page short. Nothing was changed except that it now takes its
// data as props. To bring it back, or to use it on /demo/pricing:
//
//   import { PlansSection } from "./PlansSection"
//   <PlansSection plans={pricing?.plans} />

import styles from "./demo.module.css"
import { PlanCards } from "./PlanCards"
import type { PublicPlan } from "@/lib/services/pricing"

export function PlansSection({ plans, pricingUrl = "/demo/pricing" }: { plans?: PublicPlan[]; pricingUrl?: string }) {
  return (
    <section>
      <div className={styles.wrapWide}>
        <p className={styles.sectionLabel}>Plans</p>
        <div className={styles.sectionHead}>
          <h2>Start simple. Go private-label when you&rsquo;re ready.</h2>
        </div>
        {plans ? (
          <PlanCards plans={plans} />
        ) : (
          <p>
            Our pricing is being updated. <a href="mailto:hello@ndithini.com">Get in touch</a> and we&rsquo;ll send it to
            you.
          </p>
        )}
        <div style={{ marginTop: 28, textAlign: "center" }}>
          <a className={`${styles.btn} ${styles.btnSecondary}`} href={pricingUrl}>
            See full pricing and examples
          </a>
        </div>
      </div>
    </section>
  )
}
