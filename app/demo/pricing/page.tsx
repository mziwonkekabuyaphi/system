// app/demo/pricing/page.tsx
//
// Full pricing page: plan cards, how the bill works, worked examples, a
// "what would I pay?" calculator, and pricing FAQs.
//
// EVERY number and feature name on this page is read from the database
// (plans, plan_modules, modules) via getPublicPricing(), and every example
// total is computed by the same calculateBilling() the admin Billing panel
// and the monthly invoice job use. Change a price in the database and this
// page, the landing page and the admin all change together (the page is
// re-generated every few minutes -- see `revalidate`). Only the story
// wording -- who the example shops are, how many staff and visits they have --
// is written here.

import "../../auth/theme.css"
import styles from "../demo.module.css"
import { Logo } from "@/components/Logo"
import { PlanCards } from "../PlanCards"
import { PriceCalculator } from "./PriceCalculator"
import {
  getPublicPricing,
  money,
  rate,
  joinList,
  plural,
  overageFaq,
  freePlanFaq,
  type PublicPlan,
} from "@/lib/services/pricing"
import { calculateBilling } from "@/lib/services/billing-calculator"

export const metadata = {
  title: "ZozoQueue pricing — simple plans that grow with your shop",
}

/** Re-generate from the database every 5 minutes. */
export const revalidate = 300

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login"
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup"
/** The landing page. Change this if the landing page lives somewhere else. */
const LANDING_URL = "/demo"

// ---------------------------------------------------------------------------
// Example shops. Only the story is written here; every number is computed.
// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ who: string; planKey: string; staff: number; visits: number }> = [
  { who: "Thabo, a one-man barber", planKey: "free", staff: 1, visits: 60 },
  { who: "Nomsa’s salon", planKey: "growth", staff: 2, visits: 400 },
  { who: "Nomsa’s salon in a busy month", planKey: "growth", staff: 2, visits: 600 },
  { who: "A barbershop", planKey: "growth", staff: 4, visits: 1000 },
  { who: "The same barbershop in a very busy month", planKey: "growth", staff: 4, visits: 1400 },
  { who: "A hair studio", planKey: "business", staff: 7, visits: 1750 },
  { who: "The same studio in a big month", planKey: "business", staff: 7, visits: 2500 },
  { who: "A shop with 9 people", planKey: "business", staff: 9, visits: 2250 },
]

function exampleLines(plan: PublicPlan, staff: number, visits: number): { lines: string[]; total: string } {
  const calc = calculateBilling(plan, visits, staff)
  const lines: string[] = [`Plan price: ${money(calc.baseFeeCents, plan.currency)}`]

  if (calc.extraStaff > 0 && plan.extraStaffPriceCents !== null) {
    lines.push(
      `Extra staff: ${calc.extraStaff} × ${money(plan.extraStaffPriceCents, plan.currency)} = ${money(calc.extraStaffFeeCents, plan.currency)}`,
    )
  }

  if (calc.includedVisits !== null) {
    const left = calc.includedVisits - visits
    lines.push(
      left >= 0
        ? `Visits: ${visits.toLocaleString("en-US")} used out of ${calc.includedVisits.toLocaleString("en-US")} included${plan.pricePerVisitCents === null ? ` (${left.toLocaleString("en-US")} left)` : ""}`
        : `Visits: ${visits.toLocaleString("en-US")} used, ${calc.includedVisits.toLocaleString("en-US")} included`,
    )
  }
  if (calc.overageVisits > 0 && plan.pricePerVisitCents !== null) {
    lines.push(
      `Extra visits: ${calc.overageVisits.toLocaleString("en-US")} × ${rate(plan.pricePerVisitCents, plan.currency)} = ${money(calc.usageChargeCents, plan.currency)}`,
    )
  }

  return { lines, total: money(calc.totalCents, plan.currency) }
}

function PlusIcon() {
  return (
    <svg className={styles.faqIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className={styles.faqItem}>
      <summary>
        {q}
        <PlusIcon />
      </summary>
      <p className={styles.faqAnswer}>{a}</p>
    </details>
  )
}

export default async function PricingPage() {
  const pricing = await getPublicPricing()
  const plans = pricing?.plans ?? []

  const free = plans.find((p) => p.priceCents === 0)
  const paid = plans.filter((p) => p.priceCents > 0)
  const byKey = new Map(plans.map((p) => [p.key, p]))

  // --- "How your bill is worked out" text, from the plan rows ---------------
  const perStaffVisits = paid.find((p) => p.visitsPerStaff !== null)?.visitsPerStaff ?? null
  const step1 = `${joinList(paid.map((p) => `${money(p.priceCents, p.currency)} on ${p.name}`))}, per month. ${free ? `${free.name} is always ${money(0)}.` : ""}`.trim()
  const step2 = `Each plan includes some staff (${joinList(paid.map((p) => `${p.includedStaff} on ${p.name}`))}). Every active person above that costs ${joinList(
    paid.filter((p) => p.extraStaffPriceCents !== null).map((p) => `${money(p.extraStaffPriceCents!, p.currency)} a month on ${p.name}`),
  )}. Staff you switch off are not counted.`
  const step3 =
    perStaffVisits !== null
      ? `Every staff member brings ${perStaffVisits.toLocaleString("en-US")} visits a month with them. Add those up. Any visits above that total cost ${joinList(
          paid.filter((p) => p.pricePerVisitCents !== null).map((p) => `${rate(p.pricePerVisitCents!, p.currency)} each on ${p.name}`),
        )}. A visit is counted when a customer has been served.`
      : "Visits above your allowance are billed per visit. A visit is counted when a customer has been served."

  // --- "Which plan should I choose?" ---------------------------------------
  const choose: string[] = plans.map((plan, i) => {
    const previous = i > 0 ? plans[i - 1] : null
    if (!previous) return `Just you, and you want to try it out: ${plan.name}.`
    const features = joinList(plan.newFeatures.map((f) => f.name))
    const upTo = plan.staffLimit !== null ? `up to ${plan.staffLimit} people` : "any number of people"
    const moreThan = previous.staffLimit !== null ? `, or more than ${previous.staffLimit} staff` : ""
    return i === plans.length - 1
      ? `You want ${features}${moreThan}: ${plan.name}.`
      : `${upTo.charAt(0).toUpperCase()}${upTo.slice(1)}, and you want ${features}: ${plan.name}.`
  })

  // --- A fair warning about the top plan -----------------------------------
  const growth = byKey.get("growth")
  const business = byKey.get("business")
  const topPlanTip =
    growth && business
      ? (() => {
          const g = calculateBilling(growth, 1000, 4)
          const b = calculateBilling(business, 1000, 4)
          return `${business.name} costs more than ${growth.name} for the same shop. With 4 staff and 1,000 visits you would pay ${money(g.totalCents, growth.currency)} on ${growth.name} but ${money(b.totalCents, business.currency)} on ${business.name}. Choose ${business.name} for the extra features, not to save money.`
        })()
      : null

  return (
    <div className={styles.page}>
      <nav className={`${styles.siteNav} ${styles.siteNavBar}`}>
        <div className={`${styles.siteNavInner} ${styles.siteNavInnerBar}`}>
          <span className={styles.siteNavBrand}>
            <Logo size={40} />
            ZozoQueue
          </span>
          <div className={styles.siteNavActions}>
            <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={LANDING_URL}>
              Overview
            </a>
            <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={SIGN_IN_URL}>
              Sign in
            </a>
            <a className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} href={SIGN_UP_URL}>
              Try for free
            </a>
          </div>
        </div>
      </nav>

      <section>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Pricing</p>
          <div className={styles.sectionHead}>
            <h2>Simple pricing that grows with your shop.</h2>
          </div>
          <p style={{ maxWidth: 640, margin: "0 0 32px" }}>
            Start free. Pay by the size of your team. All prices are in South African Rand and are per month.
          </p>

          {pricing ? (
            <PlanCards plans={plans} />
          ) : (
            <p>
              Our pricing is being updated. <a href="mailto:hello@ndithini.com">Get in touch</a> and we’ll send it to you.
            </p>
          )}
        </div>
      </section>

      {pricing && (
        <>
          <section>
            <div className={styles.wrap}>
              <p className={styles.sectionLabel}>Two words</p>
              <div className={styles.sectionHead}>
                <h2>Staff and visits. That’s all you need to know.</h2>
              </div>
              <div className={styles.fitList}>
                <div className={styles.fitRow}>
                  <h3>Staff</h3>
                  <p>Every person who works in your shop and is switched on in ZozoQueue. Staff you switch off are not counted.</p>
                </div>
                <div className={styles.fitRow}>
                  <h3>Visits</h3>
                  <p>One customer who has been served. A visit is counted when their booking or queue turn is finished.</p>
                </div>
              </div>
            </div>
          </section>

          <section className={styles.flow}>
            <div className={styles.wrap}>
              <p className={styles.sectionLabel}>Your bill</p>
              <div className={styles.sectionHead}>
                <h2>Your monthly bill, in three steps.</h2>
              </div>
              <div className={styles.flowSteps}>
                <div className={styles.flowStep}>
                  <span className={styles.flowNum}>1</span>
                  <div>
                    <h3>Start with the plan price</h3>
                    <p>{step1}</p>
                  </div>
                </div>
                <div className={styles.flowStep}>
                  <span className={styles.flowNum}>2</span>
                  <div>
                    <h3>Add any extra staff</h3>
                    <p>{step2}</p>
                  </div>
                </div>
                <div className={styles.flowStep}>
                  <span className={styles.flowNum}>3</span>
                  <div>
                    <h3>Add any extra visits</h3>
                    <p>{step3}</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className={styles.wrap}>
              <p className={styles.sectionLabel}>Real examples</p>
              <div className={styles.sectionHead}>
                <h2>What real shops would pay.</h2>
              </div>
              <div className={styles.fitList}>
                {SCENARIOS.map((s) => {
                  const plan = byKey.get(s.planKey)
                  if (!plan) return null
                  const { lines, total } = exampleLines(plan, s.staff, s.visits)
                  const tooBigForGrowth =
                    s.planKey === "business" && growth?.staffLimit != null && s.staff > growth.staffLimit
                      ? ` ${growth.name} stops at ${growth.staffLimit} staff, so this shop needs ${plan.name}.`
                      : ""
                  return (
                    <div key={`${s.who}-${s.visits}`} className={styles.fitRow}>
                      <h3>
                        {s.who} — {plan.name}
                      </h3>
                      <p>
                        {s.staff} {plural(s.staff, "staff member", "staff")}, {s.visits.toLocaleString("en-US")} visits. {lines.join(" · ")}.
                        {tooBigForGrowth} <strong>Total: {total}{plan.priceCents > 0 ? " a month" : ""}.</strong>
                      </p>
                    </div>
                  )
                })}
                {topPlanTip && (
                  <div className={styles.fitRow}>
                    <h3>A tip about {business?.name}</h3>
                    <p>{topPlanTip}</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className={styles.flow}>
            <div className={styles.wrapWide}>
              <p className={styles.sectionLabel}>Try your own numbers</p>
              <div className={styles.sectionHead}>
                <h2>What would I pay?</h2>
              </div>
              <PriceCalculator plans={plans.map(({ features: _features, newFeatures: _newFeatures, ...plan }) => plan)} />
            </div>
          </section>

          <section>
            <div className={styles.wrap}>
              <p className={styles.sectionLabel}>Which plan?</p>
              <div className={styles.sectionHead}>
                <h2>Which plan should I choose?</h2>
              </div>
              <div className={styles.fitList}>
                {choose.map((line) => (
                  <div key={line} className={styles.fitRow}>
                    <p>{line}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="faq">
            <div className={styles.wrap}>
              <p className={styles.sectionLabel}>FAQ</p>
              <div className={styles.sectionHead}>
                <h2>Pricing questions.</h2>
              </div>
              <div className={styles.faqList}>
                <Faq q={`Is ${free?.name ?? "the free plan"} free forever?`} a={freePlanFaq(plans)} />
                <Faq q="What if I go over my visits?" a={overageFaq(plans)} />
                <Faq
                  q="What if I add a new staff member?"
                  a="We count your active staff when your monthly invoice is made. Only keep people switched on if they work for you. Staff you switch off are not counted."
                />
                <Faq
                  q="How do I upgrade?"
                  a="Open the Billing page in your admin, choose the plan you want, and send the request. Our team switches your plan for you."
                />
                <Faq
                  q="Can I see what I owe?"
                  a="Yes. The Billing page shows your plan, your visits, your staff, an estimate of this month’s bill, and your past invoices."
                />
                <Faq
                  q="How do I pay?"
                  a="You receive a monthly invoice. We agree the payment method with you when you upgrade."
                />
              </div>
            </div>
          </section>
        </>
      )}

      <section className={styles.closing} id="contact">
        <div className={styles.wrap} style={{ textAlign: "center" }}>
          <h2 style={{ margin: "0 auto" }}>Not sure which plan fits?</h2>
          <p style={{ marginLeft: "auto", marginRight: "auto" }}>Tell us about your shop and we’ll point you to the right one.</p>
          <a className={`${styles.btn} ${styles.btnPrimary}`} href="mailto:hello@ndithini.com">
            Get in touch
          </a>
        </div>
      </section>

      <footer>
        ZozoQueue — WhatsApp booking &amp; queueing for shops that never close their door.
        <br />A Ndithini product.
      </footer>
    </div>
  )
}
