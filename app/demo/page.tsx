import "../auth/theme.css"; // reuse the same --qless-* tokens as login/signup
import styles from "./demo.module.css";
import { Logo } from "@/components/Logo";

export const metadata = {
  title: "ZozoQueue — WhatsApp booking & queueing for real shops",
};

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login";
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";

export default function DemoPage() {
  return (
    <div className={styles.page}>
      <nav className={styles.siteNav}>
        <div className={`${styles.wrapWide} ${styles.siteNavInner}`}>
          <span className={styles.siteNavBrand}>
            <Logo size={20} />
            ZozoQueue
          </span>
          <div className={styles.siteNavActions}>
            <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={SIGN_IN_URL}>
              Sign in
            </a>
            <a className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} href={SIGN_UP_URL}>
              Sign up
            </a>
          </div>
        </div>
      </nav>

      <section className={styles.heroSplit}>
        <aside className={styles.heroStub}>
          <span className={styles.heroStubBrand}>
          <Logo size={22} />
          ZozoQueue
        </span>
          <div className={styles.heroStubTicket}>
            <span className={styles.heroStubLabel}>Now serving</span>
            <span className={styles.heroStubNumber}>001</span>
            <p className={styles.heroStubTagline}>
              Every business you manage, one held place in line.
            </p>
          </div>
          <span className={styles.heroStubLabel}>A Ndithini product</span>
        </aside>
        <div className={styles.heroMain}>
          <h1>Every WhatsApp message is a customer already trying to walk in.</h1>
          <p>
            ZozoQueue turns your shop&rsquo;s WhatsApp number into a booking desk and a queue
            list — so nobody waits on a reply, and nobody gets lost between the two.
          </p>
          <div className={styles.heroCtas}>
            <a className={`${styles.btn} ${styles.btnPrimary}`} href="#contact">
              Book a demo
            </a>
            <a className={`${styles.btn} ${styles.btnSecondary}`} href="#how">
              See how it works
            </a>
          </div>
        </div>
      </section>

      <section>
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>The problem</p>
          <div className={styles.sectionHead}>
            <h2>Bookings and walk-ins live in two different worlds — until now.</h2>
          </div>
          <div className={styles.split}>
            <div className={`${styles.splitCol} ${styles.problem}`}>
              <h3>Today, without ZozoQueue</h3>
              <ul>
                <li>Customers message after hours and never hear back</li>
                <li>
                  A walk-in queue on paper, a diary for appointments — never checked against
                  each other
                </li>
                <li>Double-bookings because two staff members took the same slot</li>
                <li>No record of who&rsquo;s waiting, for what, or since when</li>
              </ul>
            </div>
            <div className={`${styles.splitCol} ${styles.solution}`}>
              <h3>With ZozoQueue</h3>
              <ul>
                <li>An AI receptionist replies on WhatsApp instantly, any hour</li>
                <li>Bookings and the walk-in queue sit on one live board</li>
                <li>Availability checked in real time before anything is confirmed</li>
                <li>Every customer, wait time and no-show tracked automatically</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.flow} id="how">
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>How it works</p>
          <div className={styles.sectionHead}>
            <h2>From a WhatsApp message to a confirmed spot, with nobody at the till.</h2>
          </div>
          <div className={styles.flowSteps}>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>1</span>
              <div>
                <h3>Customer messages your WhatsApp number</h3>
                <p>
                  No app to download, no account to create — just the number they already
                  have saved, or a QR code at the door.
                </p>
              </div>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>2</span>
              <div>
                <h3>The AI checks services, staff and hours live</h3>
                <p>
                  It knows what you offer, who&rsquo;s working, and when you&rsquo;re
                  actually open — so it never offers a slot that doesn&rsquo;t exist.
                </p>
              </div>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>3</span>
              <div>
                <h3>A booking or queue spot is confirmed on the spot</h3>
                <p>
                  No back-and-forth. The customer gets a reference number and a time — or
                  their position in line and an estimated wait.
                </p>
              </div>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>4</span>
              <div>
                <h3>You see it land on your dashboard, live</h3>
                <p>
                  Call the next customer, reschedule, or jump into the chat yourself any time
                  the conversation needs a human.
                </p>
              </div>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>5</span>
              <div>
                <h3>A reminder goes out automatically</h3>
                <p>Fewer no-shows, without anyone having to remember to send a message.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>What&rsquo;s included</p>
          <div className={styles.sectionHead}>
            <h2>Everything the front of your shop needs, in one system.</h2>
          </div>
          <div className={styles.features}>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20.5 11.5a8 8 0 0 1-11.9 6.98L4 19.5l1.1-3.9A8 8 0 1 1 20.5 11.5Z" />
              </svg>
              <h3>WhatsApp AI receptionist</h3>
              <p>
                Books appointments, joins the queue, and answers &ldquo;are you
                open?&rdquo; without anyone touching a phone.
              </p>
            </div>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
                <path d="M3.5 9.5h17" />
                <path d="M8 3v4M16 3v4" />
              </svg>
              <h3>Live booking &amp; queue board</h3>
              <p>
                Today&rsquo;s appointments and the walk-in line, on one screen that updates
                as it happens.
              </p>
            </div>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M9 8h6M9 12h6M9 16h3" />
              </svg>
              <h3>Self-service kiosk</h3>
              <p>
                A tablet by the door lets walk-ins check themselves in — branded with your
                name, logo and colours.
              </p>
            </div>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="9" cy="8.2" r="3.1" />
                <path d="M3.3 20c0-3.4 2.6-6.1 5.7-6.1s5.7 2.7 5.7 6.1" />
                <circle cx="17.2" cy="8.4" r="2.5" />
                <path d="M15.6 14.3c2.4.5 4.2 2.9 4.2 5.7" />
              </svg>
              <h3>Staff &amp; shifts</h3>
              <p>
                Staff clock in and out with a PIN on a shared tablet — hours tracked
                automatically, no timesheets.
              </p>
            </div>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.2 1.9" />
              </svg>
              <h3>Business hours, enforced</h3>
              <p>
                Set your hours once — the WhatsApp bot and kiosk simply can&rsquo;t accept a
                booking outside them.
              </p>
            </div>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12.4 3H5.8A1.8 1.8 0 0 0 4 4.8v6.6c0 .48.19.93.53 1.27l8.4 8.4a1.8 1.8 0 0 0 2.54 0l6.6-6.6a1.8 1.8 0 0 0 0-2.54l-8.4-8.4A1.8 1.8 0 0 0 12.4 3Z" />
                <circle cx="8.4" cy="8.4" r="1.3" />
              </svg>
              <h3>Your brand, not ours</h3>
              <p>
                Your logo and colours on every screen customers see — with the option to
                remove &ldquo;Powered by ZozoQueue&rdquo; entirely.
              </p>
            </div>
            <div className={styles.feature}>
              <svg
                className={styles.featureIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                <path d="M3.5 10h17" />
                <path d="M8 14.5h3" />
              </svg>
              <h3>Payroll, calculated for you</h3>
              <p>
                Clocked hours turn into gross pay with PAYE and UIF worked out automatically
                — no spreadsheet, no guesswork.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.flow}>
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>Who it&rsquo;s built for</p>
          <div className={styles.sectionHead}>
            <h2>Any business that lives on both a calendar and a doorway.</h2>
          </div>
          <div className={styles.fitList}>
            <div className={styles.fitRow}>
              <h3>Hair salons &amp; barbershops</h3>
              <p>
                Regulars book ahead, walk-ins take a seat — both need to be seen by the same
                staff on the same clock.
              </p>
            </div>
            <div className={styles.fitRow}>
              <h3>Beauty &amp; nail studios</h3>
              <p>
                Service times vary by treatment; the WhatsApp bot only offers slots that
                actually fit.
              </p>
            </div>
            <div className={styles.fitRow}>
              <h3>Clinics &amp; aesthetic practices</h3>
              <p>
                Appointment-led, but a missed message can mean a missed patient — nothing
                here waits until morning.
              </p>
            </div>
            <div className={styles.fitRow}>
              <h3>Auto workshops &amp; tyre centres</h3>
              <p>
                Drop-ins for a quick job, bookings for a full service — one queue, not two
                systems.
              </p>
            </div>
            <div className={styles.fitRow}>
              <h3>Veterinary practices</h3>
              <p>
                Scheduled check-ups alongside same-day walk-ins, with reminders that cut down
                on no-shows.
              </p>
            </div>
            <div className={styles.fitRow}>
              <h3>Driving schools &amp; tutoring centres</h3>
              <p>
                Recurring lesson slots per student, booked and confirmed without a phone call
                each time.
              </p>
            </div>
            <div className={styles.fitRow}>
              <h3>Device &amp; phone repair shops</h3>
              <p>
                A drop-off queue that customers can check from their phone, instead of asking
                &ldquo;is it done yet?&rdquo; in person.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Plans</p>
          <div className={styles.sectionHead}>
            <h2>Start simple. Go private-label when you&rsquo;re ready.</h2>
          </div>
          <div className={styles.plans}>
            <div className={styles.plan}>
              <p className={styles.planName}>Mahala</p>
              <p className={styles.planPrice}>R0</p>
              <p className={styles.planMeter}>100 visits, once off &middot; 1 staff</p>
              <h3>Try it on real customers, no card needed</h3>
              <ul>
                <li>WhatsApp AI booking &amp; queue assistant</li>
                <li>Live admin dashboard</li>
                <li>Self-service kiosk</li>
                <li>Staff profiles &amp; PIN clock-in</li>
                <li>Business-hours enforcement</li>
              </ul>
            </div>
            <div className={`${styles.plan} ${styles.planBusiness}`}>
              <p className={styles.planName}>Growth</p>
              <p className={styles.planPrice}>
                R499<span className={styles.planPriceUnit}>/month</span>
              </p>
              <p className={styles.planMeter}>
                Includes 2 staff &middot; R149 per extra staff, up to 8 &middot; 250 visits per staff/month,
                then R1.50/visit
              </p>
              <h3>For a shop that&rsquo;s outgrown &ldquo;just trying it out&rdquo;</h3>
              <ul>
                <li>Everything in Mahala</li>
                <li>Staff shift tracking &amp; PAYE/UIF payroll</li>
                <li>Higher visit &amp; staff limits</li>
                <li>Priority support</li>
              </ul>
            </div>
            <div className={styles.plan}>
              <p className={styles.planName}>Business</p>
              <p className={styles.planPrice}>
                R1,499<span className={styles.planPriceUnit}>/month</span>
              </p>
              <p className={styles.planMeter}>
                Includes 5 staff &middot; R129 per extra staff, no limit &middot; 250 visits per staff/month,
                then R1.00/visit
              </p>
              <h3>Growth, fully under your own name</h3>
              <ul>
                <li>Everything in Growth</li>
                <li>Custom brand colours &amp; logo throughout</li>
                <li>Remove &ldquo;Powered by ZozoQueue&rdquo; entirely</li>
                <li>Add as many staff as you need</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section id="faq">
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>FAQ</p>
          <div className={styles.sectionHead}>
            <h2>Questions we get on every demo call.</h2>
          </div>
          <div className={styles.faqList}>
            <details className={styles.faqItem}>
              <summary>
                Do I need a new WhatsApp number?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                No. We connect to the WhatsApp number you already use for the business,
                through Meta&rsquo;s official Cloud API. Customers message the same number
                they&rsquo;ve always had saved.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                What if the AI gets something wrong, or a customer just wants a person?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                Any conversation can be handed to a human with one tap from the dashboard —
                the AI steps back and you type as yourself. Nothing is locked to the bot.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                Do walk-ins and appointments really share one queue?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                Yes, if you turn it on. A confirmed booking is automatically pulled into the
                live queue shortly before its start time, so your staff are calling names off
                one list — not checking a diary and a queue separately.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                What exactly counts as a &ldquo;visit&rdquo; against my plan limit?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                One completed queue entry or one completed booking — whichever actually
                happened. A booking that gets pulled into the queue and served is counted
                once, not twice.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                What happens if I go over my monthly visit limit?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                You&rsquo;re never cut off. Every staff member comes with 250 visits a month.
                Past that, extra visits are billed at R1.50 each on Growth and R1.00 each on
                Business, with no cap.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                Is my customer data kept separate from other businesses on ZozoQueue?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                Completely. Every business&rsquo;s bookings, queue, customers and messages
                are walled off at the database level — there&rsquo;s no view or export path
                that can cross into another business&rsquo;s data.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                How does the payroll number get calculated?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                From real clock-in and clock-out times at the PIN pad. Hours worked become
                gross pay, with a South African PAYE and UIF estimate calculated alongside it
                automatically.
              </p>
            </details>
            <details className={styles.faqItem}>
              <summary>
                Can I try it before paying anything?
                <svg
                  className={styles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={styles.faqAnswer}>
                Yes — the Mahala plan is free, with 100 visits to test on real customers and
                one staff member, so you can see it running in your own shop before deciding to
                upgrade.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section className={styles.closing} id="contact">
        <div className={styles.wrap} style={{ textAlign: "center" }}>
          <h2 style={{ margin: "0 auto" }}>Stop losing customers between messages.</h2>
          <p style={{ marginLeft: "auto", marginRight: "auto" }}>
            See ZozoQueue running on your own WhatsApp number, with your own services and
            hours, in a 20-minute walkthrough.
          </p>
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
  );
}
