import type { ReactNode } from "react";
import "../../auth/theme.css"; // same --qless-* tokens as the landing page
import styles from "../demo.module.css";
import { Logo } from "@/components/Logo";
import { SiteNav } from "../SiteNav";
import { HowItWorks } from "../HowItWorks";
import { FeatureShowcase } from "../FeatureShowcase";

export const metadata = {
  title: "How ZozoQueue works — WhatsApp & kiosk booking and queueing",
  description:
    "See how a customer goes from a WhatsApp message or a kiosk tap to a confirmed spot, what's included, and what a day in the shop looks like with ZozoQueue.",
};

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login";
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";
const HOME_URL = "/demo";
const PRICING_URL = "/demo/pricing";
const HOW_URL = "/demo/how-it-works";
const DEMO_URL = "/demo/live";
const CONTACT_EMAIL = "hello@ndithini.com";
/** Legal pages. Leave empty until the pages exist: the footer only shows a link when it is set. */
const PRIVACY_URL = "";
const TERMS_URL = "";

// ---------------------------------------------------------------------------
// Copy lives in these lists so it can be edited without touching the layout.
// Only claim what is live: reminders are NOT listed because none have been
// sent yet.
// ---------------------------------------------------------------------------

/** "A day in the shop": the use case, told as it happens. */
const DAY: Array<{ time: string; title: string; text: string }> = [
  {
    time: "22:48",
    title: "A customer books while the shop is closed",
    text: "Sipho messages after hours. The assistant shows real open times and confirms Saturday at 10:30. Nobody picked up a phone.",
  },
  {
    time: "08:55",
    title: "Staff clock in at the door",
    text: "Each person taps their PIN on the shared tablet. Hours are recorded for payroll, with no timesheets.",
  },
  {
    time: "09:10",
    title: "A walk-in checks themselves in",
    text: "The kiosk gives them a ticket and an estimated wait. If they shared a WhatsApp number, they’re messaged when it’s nearly their turn.",
  },
  {
    time: "11:30",
    title: "Appointments and walk-ins share one list",
    text: "Booked customers are pulled into the live queue shortly before their time, so your staff call names from one board.",
  },
  {
    time: "16:12",
    title: "A cancellation fills itself",
    text: "A customer cancels on WhatsApp. Whoever is on the waitlist for that day is messaged and can take the slot in a few taps.",
  },
  {
    time: "18:00",
    title: "Close up",
    text: "Visits are counted for your plan, and clocked hours become gross pay with PAYE and UIF estimated for you.",
  },
];

const STEPS: Array<{ title: string; text: string }> = [
  {
    title: "A customer arrives through either door",
    text: "They message your WhatsApp number (or scan the QR code at the door), or tap the kiosk as they walk in. No app to download, no account to create.",
  },
  {
    title: "Services, staff and hours are checked live",
    text: "The AI and the kiosk work from the same list of what you offer, who’s working and when you’re open, so neither offers a slot that doesn’t exist.",
  },
  {
    title: "A booking or queue spot is confirmed on the spot",
    text: "No back-and-forth. On WhatsApp they get a reference and a time. At the kiosk they get a ticket with their number, place in line and estimated wait.",
  },
  {
    title: "You see it land on your dashboard, live",
    text: "Chats, kiosk check-ins and bookings sit on one board, tagged by where they came from. Call the next customer, reschedule, or jump into a chat yourself.",
  },
  {
    title: "Customers are kept in the loop",
    text: "A WhatsApp heads-up when it’s nearly their turn (kiosk customers just opt in), and a message when it’s time. If the day is full, a waitlist message the moment a slot opens.",
  },
];

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

// The order here must match SCENES in FeatureShowcase.tsx.
const FEATURES: Array<{ title: string; text: string; icon: ReactNode; isNew?: boolean }> = [
  {
    title: "WhatsApp AI receptionist",
    text: "Books appointments, joins the queue, and answers “are you open?” without anyone touching a phone.",
    icon: <path d="M20.5 11.5a8 8 0 0 1-11.9 6.98L4 19.5l1.1-3.9A8 8 0 1 1 20.5 11.5Z" />,
  },
  {
    title: "Self-service kiosk",
    text: "A tablet by the door where walk-ins book a time or join the queue in a few taps, in your name, logo and colours. It resets itself after every customer.",
    icon: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </>
    ),
  },
  {
    title: "Bookings that can’t clash",
    text: "Two customers can’t get the same staff member at the same time, even if they confirm in the same second.",
    icon: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  },
  {
    title: "Live queue with wait estimates",
    text: "Customers get a ticket, a place in line and an estimated wait. Appointments and the walk-in line sit on one screen that updates as it happens.",
    icon: (
      <>
        <path d="M8 6h12M8 12h12M8 18h12" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </>
    ),
  },
  {
    title: "Waitlist for full days",
    text: "When a day is full, customers ask to be told if a time opens up. When someone cancels, the next person is messaged.",
    isNew: true,
    icon: (
      <>
        <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </>
    ),
  },
  {
    title: "Branded booking ticket",
    text: "Confirmations can carry a ticket with a QR code, in your colours, sent straight to the customer on WhatsApp.",
    icon: (
      <>
        <path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7Z" />
        <path d="M9 11h2v2H9zM14 9v6" />
      </>
    ),
  },
  {
    title: "Staff, shifts and payroll",
    text: "Staff clock in with a PIN. Clocked hours turn into gross pay, with PAYE and UIF estimated for you. No spreadsheet.",
    icon: (
      <>
        <circle cx="9" cy="8.2" r="3.1" />
        <path d="M3.3 20c0-3.4 2.6-6.1 5.7-6.1s5.7 2.7 5.7 6.1" />
        <circle cx="17.2" cy="8.4" r="2.5" />
        <path d="M15.6 14.3c2.4.5 4.2 2.9 4.2 5.7" />
      </>
    ),
  },
  {
    title: "Business hours, enforced",
    text: "Set your hours once. The WhatsApp bot and kiosk simply can’t accept a booking outside them.",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.2 1.9" />
      </>
    ),
  },
  {
    title: "Your brand, not ours",
    text: "Your logo and colours on every screen customers see, with the option to remove “Powered by ZozoQueue” entirely.",
    icon: (
      <>
        <path d="M12.4 3H5.8A1.8 1.8 0 0 0 4 4.8v6.6c0 .48.19.93.53 1.27l8.4 8.4a1.8 1.8 0 0 0 2.54 0l6.6-6.6a1.8 1.8 0 0 0 0-2.54l-8.4-8.4A1.8 1.8 0 0 0 12.4 3Z" />
        <circle cx="8.4" cy="8.4" r="1.3" />
      </>
    ),
  },
];

export default function HowItWorksPage() {
  return (
    <div className={styles.page}>
      <SiteNav current="how" />

      <section id="how">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>How it works</p>
          <div className={styles.sectionHead}>
            <h1>From a WhatsApp message to a confirmed spot, with nobody at the till.</h1>
          </div>
          <HowItWorks steps={STEPS} />
        </div>
      </section>

      <section className={styles.flow} id="day">
        <div className={styles.wrap}>
          <p className={styles.sectionLabel}>A day in the shop</p>
          <div className={styles.sectionHead}>
            <h2>One ordinary Saturday, with ZozoQueue running the front desk.</h2>
          </div>
          <ol className={styles.timeline}>
            {DAY.map((item) => (
              <li key={item.time} className={styles.tlItem}>
                <span className={styles.tlTime}>{item.time}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="included">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>What&rsquo;s included</p>
          <div className={styles.sectionHead}>
            <h2>Everything the front of your shop needs, in one system.</h2>
          </div>
          <FeatureShowcase features={FEATURES} />
          <p style={{ marginTop: 32 }}>
            Which plan includes what? <a href={PRICING_URL}>See the full comparison</a>.
          </p>
        </div>
      </section>

      <section className={styles.closing}>
        <div className={styles.wrap} style={{ textAlign: "center" }}>
          <h2 style={{ margin: "0 auto" }}>Want to see it on your own shop?</h2>
          <p style={{ marginLeft: "auto", marginRight: "auto" }}>
            We&rsquo;ll run ZozoQueue on your own WhatsApp number and kiosk, with your own services and hours, in a
            20-minute walkthrough.
          </p>
          <div className={styles.heroCtas} style={{ justifyContent: "center" }}>
            <a className={`${styles.btn} ${styles.btnPrimary}`} href={`${HOME_URL}#contact`}>
              Book a demo
            </a>
            <a className={`${styles.btn} ${styles.btnSecondary}`} href={SIGN_UP_URL}>
              Try for free
            </a>
          </div>
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
              <a href={`${HOME_URL}#security`}>Security &amp; privacy</a>
              <a href={`${HOME_URL}#faq`}>FAQ</a>
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
