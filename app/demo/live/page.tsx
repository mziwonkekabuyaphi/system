import type { Metadata } from "next";
import "../../auth/theme.css"; // same --qless-* tokens as the landing page
import styles from "../demo.module.css";
import { Logo } from "@/components/Logo";
import { ChatDemo } from "../ChatDemo";
import { KioskDemo } from "../KioskDemo";
import { WhatsAppAdminDemo } from "../WhatsAppAdminDemo";
import { IndustryProvider, IndustryPicker } from "../IndustryContext";
import { DashboardDemo } from "../DashboardDemo";
import { DisplayDemo } from "../DisplayDemo";
import { SetupDemo } from "../SetupDemo";

// app/demo/live/page.tsx
//
// The interactive demo page, linked from the "Demo" button in the landing page's nav.
// These sections were moved here unchanged from the landing page (app/demo/page.tsx):
// Two ways in, WhatsApp, WhatsApp messages (admin), the kiosk, the waiting-area screen and
// the dashboard, plus the new "Set it up yourself" workspace (SetupDemo.tsx: branding, staff,
// clock-in and payroll).

export const metadata: Metadata = {
  title: "ZozoQueue demo — WhatsApp, kiosk, waiting-area screen and dashboard",
  description:
    "Try ZozoQueue yourself: a customer books on WhatsApp, a walk-in checks in at the kiosk, the TV shows the queue, and your dashboard updates live.",
};

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login";
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";
const LANDING_URL = "/demo";
const PRICING_URL = "/demo/pricing";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export default function DemoLivePage() {
  return (
    <div className={styles.page}>
      <nav className={`${styles.siteNav} ${styles.siteNavBar}`}>
        <div className={`${styles.siteNavInner} ${styles.siteNavInnerBar}`}>
          <a className={styles.siteNavBrand} href={LANDING_URL}>
            <Logo size={40} />
            ZozoQueue
          </a>
          <div className={styles.siteNavActions}>
            <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={LANDING_URL}>
              Overview
            </a>
            <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={PRICING_URL}>
              Pricing
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

      <section id="channels">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Two ways in</p>
          <div className={styles.sectionHead}>
            <h2>Customers reach you on their phone or at your door. You run both from one place.</h2>
          </div>
          <div className={styles.channels}>
            <div className={styles.channel}>
              <svg className={styles.channelIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                <path d="M20.5 11.5a8 8 0 0 1-11.9 6.98L4 19.5l1.1-3.9A8 8 0 1 1 20.5 11.5Z" />
              </svg>
              <span className={styles.channelTag}>Channel one</span>
              <h3>WhatsApp</h3>
              <p>
                Customers message the number they already have saved, at any hour. The AI books, reschedules and
                cancels, answers &ldquo;are you open?&rdquo;, and hands over to you with one tap.
              </p>
              <a className={styles.channelLink} href="#demo">
                See a customer book on WhatsApp
              </a>
            </div>
            <div className={styles.channel}>
              <svg className={styles.channelIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M9 8h6M9 12h6M9 16h3" />
              </svg>
              <span className={styles.channelTag}>Channel two</span>
              <h3>Self-serve kiosk</h3>
              <p>
                A tablet by your door where walk-ins book a time or join the queue themselves, with big buttons and
                a ticket at the end. No one has to stop what they&rsquo;re doing at the till.
              </p>
              <a className={styles.channelLink} href="#kiosk">
                See the kiosk in action
              </a>
            </div>
          </div>
          <p className={styles.channelsNote}>
            Both channels book against the same diary and join the same queue, so a customer can&rsquo;t clash with
            another one, whichever door they came through.
          </p>
        </div>
      </section>

      <IndustryProvider>
      <section id="demo" className={styles.flow}>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Channel one: WhatsApp</p>
          <div className={styles.sectionHead}>
            <h2>On their phone, customers book in the chat they already have.</h2>
          </div>
          <IndustryPicker />
          <ChatDemo />

          <div style={{ marginTop: 72 }}>
            <p className={styles.sectionLabel}>When the customer hasn&rsquo;t messaged you</p>
            <div className={styles.sectionHead}>
              <h2>Kiosk customers get a WhatsApp too, and you choose the wording.</h2>
            </div>
            <p className={styles.sectionIntro}>
              Someone who checks in at the kiosk has no open chat with you, so WhatsApp only lets you message them with a template
              Meta has approved. Switch each message on or off, reword it, and send it for approval from your dashboard.
            </p>
            <WhatsAppAdminDemo />
          </div>
        </div>
      </section>

      <section id="kiosk">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Channel two: the self-serve kiosk</p>
          <div className={styles.sectionHead}>
            <h2>At your door, walk-ins check themselves in.</h2>
          </div>
          <p className={styles.sectionIntro}>
            Choose what the kiosk offers: bookings, the walk-in queue, or both. Every button, title and colour is
            yours to change, so it fits a clinic or a tyre centre as well as a barbershop. It resets after every
            customer or after a spell of inactivity, so one person&rsquo;s details never show up for the next.
          </p>
          <IndustryPicker />
          <KioskDemo />
        </div>
      </section>

      <section id="display" className={styles.flow}>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>On the wall: the waiting-area screen</p>
          <div className={styles.sectionHead}>
            <h2>Put a TV in the waiting area, and everyone can see where they stand.</h2>
          </div>
          <p className={styles.sectionIntro}>
            Open one link on any TV browser and leave it. No login, no app, no one to operate it. It shows your menu,
            today&rsquo;s bookings and the live queue, and keeps itself up to date. You decide what it shows: pick rotating
            slides or a live board, switch screens on and off, choose which details appear next to each name, and reword
            every heading. Customer phone numbers are always masked.
          </p>
          <IndustryPicker />
          <DisplayDemo />
        </div>
      </section>

      <section id="dashboard" className={styles.dashSection}>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Your side of the counter</p>
          <div className={styles.sectionHead}>
            <h2>And this is what you see, live.</h2>
          </div>
          <p className={styles.dashIntro}>
            Every WhatsApp chat, kiosk check-in and booking lands on one dashboard the moment it happens. Open each view below.
          </p>
          <DashboardDemo />
        </div>
      </section>

      <section id="setup" className={styles.flow}>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Set it up yourself</p>
          <div className={styles.sectionHead}>
            <h2>From your logo to payday, set up your whole shop right here.</h2>
          </div>
          <p className={styles.sectionIntro}>
            This is the same set-up you do in your own dashboard, in the order you would do it: brand it, add your team,
            let them clock in, and see their hours turn into pay. Change anything and the rest follows. Add a logo and
            your colours reach the clock pad and the payslip. Add a staff member and they can clock in with their PIN.
          </p>
          <IndustryPicker />
          <SetupDemo />
        </div>
      </section>
      </IndustryProvider>

      <footer>
        ZozoQueue — WhatsApp &amp; kiosk booking and queueing for shops that never close their door.
        <br />A Ndithini product.
      </footer>
    </div>
  );
}
