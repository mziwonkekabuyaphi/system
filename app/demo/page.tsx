import type { ReactNode } from "react";
import "../auth/theme.css"; // reuse the same --qless-* tokens as login/signup
import styles from "./demo.module.css";
import { Logo } from "@/components/Logo";
import { SiteNav } from "./SiteNav";
import { QueueScenes } from "./QueueScenes";
import { StoryScene } from "./StoryScene";
import { ContactForm } from "./ContactForm";
import { getPublicPricing, overageFaq, freePlanFaq } from "@/lib/services/pricing";

export const metadata = {
  title: "ZozoQueue — WhatsApp & kiosk booking and queueing for real shops",
  description:
    "Give your shop two front doors: a WhatsApp number that books and queues customers, and a self-serve kiosk for walk-ins. Bookings that can’t clash, one live board, and payroll.",
};

// Pricing is still read from the database (it feeds the FAQ answers below), so
// re-generate every 5 minutes to pick up price changes. The Plans section itself
// was moved out of this page: see PlansSection.tsx.
export const revalidate = 300;

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login";
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";
/** The full pricing page. Change this if your landing page doesn't live at /demo. */
const PRICING_URL = "/demo/pricing";
/** The "How it works" page: a day in the shop, how it works, and what's included. */
const HOW_URL = "/demo/how-it-works";
/** The interactive demo page (WhatsApp, kiosk, waiting-area screen, dashboard). */
const DEMO_URL = "/demo/live";
const CONTACT_EMAIL = "hello@ndithini.com";
/** Legal pages. Leave empty until the pages exist: the footer only shows a link when it is set. */
const PRIVACY_URL = "";
const TERMS_URL = "";

// ---------------------------------------------------------------------------
// Copy lives in these lists so it can be edited without touching the layout.
// "A day in the shop", "How it works" and "What's included" now live in
// how-it-works/page.tsx.
// ---------------------------------------------------------------------------

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** The navy hero panel: who is next in line, and which door they came through. */
const HERO_QUEUE: Array<{ no: string; name: string; src: "WhatsApp" | "Kiosk" }> = [
  { no: "Q002", name: "Naledi P.", src: "WhatsApp" },
  { no: "Q003", name: "Zinhle D.", src: "Kiosk" },
];

/** Only things the product already does (same claims as the trust strip below). */
const HERO_TRUST = ["Official WhatsApp Cloud API", "No double-bookings", "WhatsApp updates are opt-in"];

/** A decorative QR graphic (not a working code), same pattern as the ticket on the How it works page. */
const HERO_QR = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
const HERO_QR_NOISE = "0110100101101001";

/**
 * Trust copy. Every line here restates something this page or the product already
 * does. Do not add certifications (ISO, SOC 2, POPIA "compliant"), customer logos or
 * testimonials until they are real and you can show them.
 */
const TRUST_STRIP: Array<{ title: string; text: string; icon: ReactNode }> = [
  {
    title: "Official WhatsApp API",
    text: "Connected through Meta’s Cloud API, on your own business number.",
    icon: <path d="M20.5 11.5a8 8 0 0 1-11.9 6.98L4 19.5l1.1-3.9A8 8 0 1 1 20.5 11.5Z" />,
  },
  {
    title: "Your data stays yours",
    text: "Every business is walled off from the others at the database level.",
    icon: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
  {
    title: "No double-bookings",
    text: "The database itself refuses two bookings for one person at one time.",
    icon: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  },
  {
    title: "Customers choose",
    text: "Kiosk WhatsApp updates are opt-in, never pre-ticked.",
    icon: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M8.5 12l2.5 2.5 4.5-5" />
      </>
    ),
  },
];

const SECURITY: Array<{ title: string; text: string }> = [
  {
    title: "Separate by design",
    text: "Each business’s bookings, queue, customers and messages are isolated at the database level. There is no view or export path that crosses into another business’s data.",
  },
  {
    title: "Official WhatsApp connection",
    text: "Messages run through Meta’s official Cloud API on a WhatsApp number that belongs to your business, not a workaround or a scraped account.",
  },
  {
    title: "Bookings enforced by the database",
    text: "Overlapping bookings and bookings outside your business hours are refused by the database, so the rules hold even when two people tap at the same second.",
  },
  {
    title: "Phone numbers masked in public",
    text: "The waiting-area screen only ever shows a customer’s number masked, so nobody in the room sees someone else’s details.",
  },
  {
    title: "Consent comes first",
    text: "On the kiosk, WhatsApp updates are a tick box that is never pre-ticked. Customers without WhatsApp can still book or queue with just a name and number.",
  },
  {
    title: "A person can always step in",
    text: "Any conversation can be handed to a human with one tap. The AI steps back and nothing is locked to the bot.",
  },
];

const FIT: Array<{ who: string; text: string }> = [
  {
    who: "Barbershops & hair salons",
    text: "Regulars book Saturday slots on WhatsApp while walk-ins take a ticket at the door. One list, one set of staff, no clashes.",
  },
  {
    who: "Beauty & nail studios",
    text: "A gel set takes longer than a brow tint. The assistant only offers times that fit the treatment, and a full Saturday goes on the waitlist.",
  },
  {
    who: "Clinics & aesthetic practices",
    text: "Appointment-led, but a missed message can mean a missed patient. After-hours messages get a booking, not silence until morning.",
  },
  {
    who: "Auto workshops & tyre centres",
    text: "Drop-ins for a quick job, bookings for a full service. Customers get a message when it’s their turn instead of hovering in the shop.",
  },
  {
    who: "Veterinary practices",
    text: "Check-ups booked ahead, same-day walk-ins in the same queue, and a human can take over any chat with one tap.",
  },
  {
    who: "Device & phone repair shops",
    text: "A drop-off queue that tells customers when it’s their turn, instead of “is it done yet?” at the counter.",
  },
];

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className={styles.faqItem}>
      <summary>
        {q}
        <svg className={styles.faqIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </summary>
      <p className={styles.faqAnswer}>{children}</p>
    </details>
  );
}

export default async function DemoPage() {
  const pricing = await getPublicPricing();

  return (
    <div className={styles.page}>
      <SiteNav current="home" />

      <section className={styles.heroSplit}>
        <aside className={styles.heroStub}>
          <div className={styles.heroStubTicket}>
            <span className={styles.heroStubLabel}>Now serving</span>
            <span className={styles.heroStubNumber}>Q001</span>
            <p className={styles.heroStubTagline}>Every business you manage, one held place in line.</p>
          </div>

          <div className={styles.heroStubSection}>
            <span className={styles.heroStubLabel}>Up next</span>
            <ul className={styles.heroQueue}>
              {HERO_QUEUE.map((q) => (
                <li key={q.no} className={styles.heroQueueRow}>
                  <span className={styles.heroQueueNo}>{q.no}</span>
                  <span>{q.name}</span>
                  <span className={`${styles.heroQueueTag} ${q.src === "WhatsApp" ? styles.heroTagWhatsApp : styles.heroTagKiosk}`}>{q.src}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className={`${styles.heroStubSection} ${styles.heroStubExtra}`}>
            <span className={styles.heroStubLabel}>Two front doors</span>
            <div className={styles.heroDoors}>
              <div className={styles.heroDoor}>
                <strong>WhatsApp</strong>
                <span>Books around the clock</span>
              </div>
              <div className={styles.heroDoor}>
                <strong>Kiosk</strong>
                <span>Walk-ins check themselves in</span>
              </div>
            </div>
          </div>

          <ul className={`${styles.heroTrust} ${styles.heroStubExtra}`}>
            {HERO_TRUST.map((t) => (
              <li key={t}>
                <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8.5 12.2l2.4 2.4 4.6-5" />
                </svg>
                {t}
              </li>
            ))}
          </ul>

          <div className={`${styles.heroQr} ${styles.heroStubExtra}`}>
            <span className={styles.heroQrCode} aria-hidden="true">
              {HERO_QR.flatMap((row, r) =>
                row.split("").map((c, i) => (
                  <i
                    key={`${r}-${i}`}
                    className={c === "1" || (r > 1 && r < 5 && i > 1 && i < 5 && HERO_QR_NOISE[(r * 7 + i) % HERO_QR_NOISE.length] === "1") ? styles.heroQrOn : ""}
                  />
                )),
              )}
            </span>
            <span className={styles.heroQrText}>
              <strong>Scan to join the queue</strong>
              <span>A QR code at your door puts walk-ins in line.</span>
            </span>
          </div>

          <span className={`${styles.heroStubLabel} ${styles.heroStubFoot}`}>A Ndithini product</span>
        </aside>
        <div className={styles.heroMain}>
          <div className={styles.heroPreview}>
            <QueueScenes />
          </div>
          <div>
            <h1>Whether they message or walk in, they’re already in line.</h1>
            <p>
              ZozoQueue gives your shop two front doors: a WhatsApp number that books and queues customers around the
              clock, and a self-serve kiosk for walk-ins. Both feed one live board, so nobody waits on a reply and
              nobody gets lost between them.
            </p>
            <div className={styles.heroCtas}>
              <a className={`${styles.btn} ${styles.btnPrimary}`} href={`${DEMO_URL}#channels`}>
                See both ways in
              </a>
              <a className={`${styles.btn} ${styles.btnSecondary}`} href="#contact">
                Book a demo
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.trustStrip} aria-label="Why shops trust ZozoQueue">
        <ul className={styles.trustList}>
          {TRUST_STRIP.map((t) => (
            <li key={t.title} className={styles.trustItem}>
              <svg className={styles.trustIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                {t.icon}
              </svg>
              <div>
                <strong>{t.title}</strong>
                <span>{t.text}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.flow}>
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>The problem</p>
          <div className={styles.sectionHead}>
            <h2>Bookings and walk-ins live in two different worlds, until now.</h2>
          </div>
          <div className={styles.split}>
            <div className={`${styles.splitCol} ${styles.problem}`}>
              <h3>Today, without ZozoQueue</h3>
              <ul>
                <li>Customers message after hours and never hear back</li>
                <li>A walk-in queue on paper, a diary for appointments, never checked against each other</li>
                <li>Double-bookings because two staff members took the same slot</li>
                <li>A full day means a lost customer</li>
              </ul>
            </div>
            <div className={`${styles.splitCol} ${styles.solution}`}>
              <h3>With ZozoQueue</h3>
              <ul>
                <li>An AI receptionist replies on WhatsApp instantly, any hour</li>
                <li>Bookings and the walk-in queue sit on one live board, fed by WhatsApp and the kiosk</li>
                <li>A staff member can’t be booked twice for the same time</li>
                <li>A full day becomes a waitlist, and a cancellation fills itself</li>
              </ul>
            </div>
          </div>
          <p style={{ marginTop: 32 }}>
            Curious how it all fits together? <a href={HOW_URL}>See how it works</a>.
          </p>
        </div>
      </section>

      <StoryScene />

      <section className={styles.flow}>
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>Who it&rsquo;s built for</p>
          <div className={styles.sectionHead}>
            <h2>Any business that lives on both a calendar and a doorway.</h2>
          </div>
          <div className={styles.fitList}>
            {FIT.map((row) => (
              <div key={row.who} className={styles.fitRow}>
                <h3>{row.who}</h3>
                <p>{row.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.security} id="security">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Security &amp; privacy</p>
          <div className={styles.sectionHead}>
            <h2>Your customers’ details are handled like they matter.</h2>
          </div>
          <p className={styles.sectionIntro}>
            You are trusting us with your customer list and your front door. Here is what that looks like in practice.
          </p>
          <div className={styles.securityGrid}>
            {SECURITY.map((s) => (
              <div key={s.title} className={styles.securityItem}>
                <svg className={styles.securityTick} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8.5 12.2l2.4 2.4 4.6-5" />
                </svg>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </div>
            ))}
          </div>
          <p className={styles.securityNote}>
            Questions about security or how your data is handled? Email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and a person will answer.
          </p>
        </div>
      </section>

      <section id="faq">
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>FAQ</p>
          <div className={styles.sectionHead}>
            <h2>Questions we get on every demo call.</h2>
          </div>
          <div className={styles.faqList}>
            <Faq q="Do I need a new WhatsApp number?">
              You use a WhatsApp number that belongs to your business, connected through Meta&rsquo;s official Cloud API.
              If your number is currently used in the regular WhatsApp app, we&rsquo;ll walk you through your options
              before anything changes.
            </Faq>
            <Faq q="Do my customers need WhatsApp to use ZozoQueue?">
              No. The kiosk works with just a name and a phone number. If your shop has WhatsApp connected, the kiosk
              also offers a tick box for WhatsApp updates about their visit. It&rsquo;s never pre-ticked, so customers
              choose.
            </Faq>
            <Faq q="What do I need to run the kiosk?">
              A tablet or screen with a web browser, opened on your shop&rsquo;s kiosk link. You decide whether it
              offers bookings, the walk-in queue or both, and what each button says. Which plans include it is on the{" "}
              <a href={PRICING_URL}>pricing page</a>.
            </Faq>
            <Faq q="What do I need for the waiting-area TV?">
              Any TV or screen with a web browser, opened on your shop&rsquo;s display link and left on. You choose rotating
              slides or a live board, which screens to show, and which queue details appear. A customer&rsquo;s phone number is
              only ever shown masked, and changes you make in settings reach the TV by themselves within seconds. Which plans
              include it is on the <a href={PRICING_URL}>pricing page</a>.
            </Faq>
            <Faq q="Can two customers book the same barber at the same time?">
              No. The database itself refuses two overlapping bookings for one staff member, so even two people tapping
              &ldquo;confirm&rdquo; in the same second can&rsquo;t both get the slot. The second one is offered another time.
            </Faq>
            <Faq q="What happens when a day is fully booked?">
              The customer can ask to be told if a time opens up. When someone cancels, the people on that day&rsquo;s
              waitlist are messaged in the order they joined, and they book the slot themselves in WhatsApp.
            </Faq>
            <Faq q="Can customers cancel or move a booking themselves?">
              Yes, on WhatsApp, up to the cancellation cut-off you set. Inside the cut-off they&rsquo;re told politely that
              it&rsquo;s too late, so your day doesn&rsquo;t change under you.
            </Faq>
            <Faq q="What if the AI gets something wrong, or a customer just wants a person?">
              Any conversation can be handed to a human with one tap from the dashboard. The AI steps back and you type as
              yourself. Nothing is locked to the bot.
            </Faq>
            <Faq q="Do walk-ins and appointments really share one queue?">
              Yes, if you turn it on. A confirmed booking is automatically pulled into the live queue shortly before its
              start time, so your staff are calling names off one list, not checking a diary and a queue separately.
            </Faq>
            <Faq q="What exactly counts as a “visit” against my plan limit?">
              One completed queue entry or one completed booking, whichever actually happened. A booking that gets pulled
              into the queue and served is counted once, not twice.
            </Faq>
            <Faq q="What happens if I go over my monthly visit limit?">{overageFaq(pricing?.plans)}</Faq>
            <Faq q="Is my customer data kept separate from other businesses on ZozoQueue?">
              Completely. Every business&rsquo;s bookings, queue, customers and messages are walled off at the database
              level. There&rsquo;s no view or export path that can cross into another business&rsquo;s data.
            </Faq>
            <Faq q="How does the payroll number get calculated?">
              From real clock-in and clock-out times at the PIN pad. Hours worked become gross pay, with a South African
              PAYE and UIF estimate calculated alongside it automatically.
            </Faq>
            <Faq q="Can I try it before paying anything?">{freePlanFaq(pricing?.plans)}</Faq>
          </div>
        </div>
      </section>

      <section className={styles.closing} id="contact">
        <div className={styles.wrap} style={{ textAlign: "center" }}>
          <h2 style={{ margin: "0 auto" }}>Stop losing customers in the inbox and at the door.</h2>
          <p style={{ marginLeft: "auto", marginRight: "auto" }}>
            See ZozoQueue running on your own WhatsApp number and kiosk, with your own services and hours, in a
            20-minute walkthrough.
          </p>
          <ContactForm email={CONTACT_EMAIL} />
        </div>
      </section>

      <footer className={styles.siteFooter}>
        <div className={styles.wrapWide}>
          <div className={styles.footerGrid}>
            <div className={styles.footerBrandCol}>
              <span className={styles.footerBrand}>
                <Logo size={32} />
                ZozoQueue
              </span>
              <p>WhatsApp &amp; kiosk booking and queueing for shops that never close their door.</p>
            </div>
            <nav aria-label="Product" className={styles.footerCol}>
              <h4>Product</h4>
              <a href={HOW_URL}>How it works</a>
              <a href={DEMO_URL}>Live demo</a>
              <a href={PRICING_URL}>Pricing</a>
              <a href="#security">Security &amp; privacy</a>
              <a href="#faq">FAQ</a>
            </nav>
            <nav aria-label="Account" className={styles.footerCol}>
              <h4>Account</h4>
              <a href={SIGN_IN_URL}>Sign in</a>
              <a href={SIGN_UP_URL}>Try for free</a>
            </nav>
            <div className={styles.footerCol}>
              <h4>Contact</h4>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              <span>A Ndithini product</span>
            </div>
          </div>
          <div className={styles.footerBase}>
            <span>© {new Date().getFullYear()} Ndithini. All rights reserved.</span>
            {(PRIVACY_URL || TERMS_URL) && (
              <span className={styles.footerLegal}>
                {PRIVACY_URL && <a href={PRIVACY_URL}>Privacy policy</a>}
                {TERMS_URL && <a href={TERMS_URL}>Terms of service</a>}
              </span>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
