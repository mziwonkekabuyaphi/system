import type { ReactNode } from "react";
import "../auth/theme.css"; // reuse the same --qless-* tokens as login/signup
import styles from "./demo.module.css";
import { Logo } from "@/components/Logo";
import { PlanCards } from "./PlanCards";
import { ChatDemo } from "./ChatDemo";
import { KioskDemo } from "./KioskDemo";
import { DashboardDemo } from "./DashboardDemo";
import { getPublicPricing, overageFaq, freePlanFaq } from "@/lib/services/pricing";

export const metadata = {
  title: "ZozoQueue — WhatsApp & kiosk booking and queueing for real shops",
  description:
    "Give your shop two front doors: a WhatsApp number that books and queues customers, and a self-serve kiosk for walk-ins. Bookings that can’t clash, one live board, and payroll.",
};

// Plans on this page are read from the database (same tables as the admin
// Billing panel), so re-generate every 5 minutes to pick up price changes.
export const revalidate = 300;

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login";
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";
/** The full pricing page. Change this if your landing page doesn't live at /demo. */
const PRICING_URL = "/demo/pricing";

// ---------------------------------------------------------------------------
// Copy lives in these lists so it can be edited without touching the layout.
// Only claim what is live: reminders are NOT listed because none have been
// sent yet (see the notes that came with this file).
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
      <nav className={styles.siteNav}>
        <div className={styles.siteNavInner}>
          <div className={styles.siteNavActions}>
            <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={SIGN_IN_URL}>
              Sign in
            </a>
            <a className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} href={SIGN_UP_URL}>
              Try for free
            </a>
          </div>
        </div>
      </nav>

      <section className={styles.heroSplit}>
        <aside className={styles.heroStub}>
          <span className={styles.heroStubBrand}>
            <Logo size={44} />
            ZozoQueue
          </span>
          <div className={styles.heroStubTicket}>
            <span className={styles.heroStubLabel}>Now serving</span>
            <span className={styles.heroStubNumber}>001</span>
            <p className={styles.heroStubTagline}>Every business you manage, one held place in line.</p>
          </div>
          <span className={styles.heroStubLabel}>A Ndithini product</span>
        </aside>
        <div className={styles.heroMain}>
          <div>
            <h1>Whether they message or walk in, they’re already in line.</h1>
            <p>
              ZozoQueue gives your shop two front doors: a WhatsApp number that books and queues customers around the
              clock, and a self-serve kiosk for walk-ins. Both feed one live board, so nobody waits on a reply and
              nobody gets lost between them.
            </p>
            <div className={styles.heroCtas}>
              <a className={`${styles.btn} ${styles.btnPrimary}`} href="#channels">
                See both ways in
              </a>
              <a className={`${styles.btn} ${styles.btnSecondary}`} href="#contact">
                Book a demo
              </a>
            </div>
          </div>
          <div className={styles.heroPreview}>
            <DashboardDemo compact />
          </div>
        </div>
      </section>

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

      <section id="demo" className={styles.flow}>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Channel one: WhatsApp</p>
          <div className={styles.sectionHead}>
            <h2>On their phone, customers book in the chat they already have.</h2>
          </div>
          <ChatDemo />
        </div>
      </section>

      <section id="kiosk">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Channel two: the self-serve kiosk</p>
          <div className={styles.sectionHead}>
            <h2>At your door, walk-ins check themselves in.</h2>
          </div>
          <p className={styles.sectionIntro}>
            Choose what the kiosk offers: bookings, the walk-in queue, or both. It resets after every customer or
            after a spell of inactivity, so one person&rsquo;s details never show up for the next.
          </p>
          <KioskDemo />
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
        </div>
      </section>

      <section>
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

      <section className={styles.flow} id="how">
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>How it works</p>
          <div className={styles.sectionHead}>
            <h2>From a WhatsApp message to a confirmed spot, with nobody at the till.</h2>
          </div>
          <div className={styles.flowSteps}>
            {STEPS.map((step, i) => (
              <div key={step.title} className={styles.flowStep}>
                <span className={styles.flowNum}>{i + 1}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </div>
            ))}
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
            {FEATURES.map((f) => (
              <div key={f.title} className={styles.feature}>
                <svg className={styles.featureIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                  {f.icon}
                </svg>
                <h3>
                  {f.title}
                  {f.isNew && <span className={styles.badgeNew}>New</span>}
                </h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 32 }}>
            Which plan includes what? <a href={PRICING_URL}>See the full comparison</a>.
          </p>
        </div>
      </section>

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

      <section>
        <div className={styles.wrapWide}>
          <p className={styles.sectionLabel}>Plans</p>
          <div className={styles.sectionHead}>
            <h2>Start simple. Go private-label when you&rsquo;re ready.</h2>
          </div>
          {pricing ? (
            <PlanCards plans={pricing.plans} />
          ) : (
            <p>
              Our pricing is being updated. <a href="mailto:hello@ndithini.com">Get in touch</a> and we&rsquo;ll send it to
              you.
            </p>
          )}
          <div style={{ marginTop: 28, textAlign: "center" }}>
            <a className={`${styles.btn} ${styles.btnSecondary}`} href={PRICING_URL}>
              See full pricing and examples
            </a>
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
          <a className={`${styles.btn} ${styles.btnPrimary}`} href="mailto:hello@ndithini.com">
            Get in touch
          </a>
        </div>
      </section>

      <footer>
        ZozoQueue — WhatsApp &amp; kiosk booking and queueing for shops that never close their door.
        <br />A Ndithini product.
      </footer>
    </div>
  );
}
