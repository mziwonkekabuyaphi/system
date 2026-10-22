import type { ReactNode } from "react";
import "../../auth/theme.css"; // same --qless-* tokens as the landing page
import base from "../demo.module.css"; // shared page shell, buttons, FAQ and closing styles
import styles from "./docs.module.css";
import { SiteNav } from "../SiteNav";

export const metadata = {
  title: "ZozoQueue docs — from the problem it solves to your first day live",
  description:
    "How ZozoQueue works and how to set it up: WhatsApp booking assistant, walk-in kiosk, waiting-area screen, live dashboard, staff clock-in and payroll.",
};

const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";
const PRICING_URL = "/demo/pricing";
const HOW_URL = "/demo/how-it-works";
const DEMO_URL = "/demo/live";
const CONTACT_EMAIL = "hello@ndithini.com";

// ---------------------------------------------------------------------------
// Copy lives in these lists so it can be edited without touching the layout.
// Only describe what the product already does. Prices are NOT written here:
// they come from the database, so this page links to the pricing page instead.
// ---------------------------------------------------------------------------

const TOC = [
  { id: "solutions", label: "What it solves" },
  { id: "pieces", label: "The pieces" },
  { id: "setup", label: "Set up, step by step" },
  { id: "reference", label: "Settings reference" },
  { id: "team", label: "Roles & access" },
  { id: "billing", label: "Visits & billing" },
  { id: "help", label: "Troubleshooting" },
];

const SOLVES = [
  ["Customers message after hours and never hear back.", "The WhatsApp assistant replies at any hour and books or queues them."],
  ["Walk-ins on paper, appointments in a diary, never compared.", "Both land on one live board. A confirmed booking can be pulled into the queue shortly before it starts."],
  ["Two staff members booked for the same slot.", "The database refuses overlapping bookings, so two people tapping at the same second can’t both win."],
  ["A full day means a lost customer.", "The customer joins a waitlist. When someone cancels, the waitlist is messaged in the order they joined."],
  ["“Is it my turn yet?” at the counter.", "Customers get a WhatsApp message when they are nearly up and when they are called."],
  ["Hours worked and pay worked out by hand.", "Staff clock in on a PIN pad; payroll is calculated from real hours with a PAYE and UIF estimate."],
];

const PIECES = [
  ["WhatsApp assistant", "An AI receptionist on your own WhatsApp Business number (Meta’s Cloud API). Books, cancels, moves bookings and joins the queue. Any chat can be handed to a person with one tap."],
  ["Kiosk", "A tablet at the door. Walk-ins join the queue or book a time. You choose what the buttons say and which details to collect. It can print a ticket on a thermal printer."],
  ["Waiting-area screen", "Any TV with a browser. Rotating slides or a live board of who is being served and who is next. Phone numbers are only shown masked."],
  ["Live dashboard", "Where your team calls the next customer, manages bookings, reads WhatsApp conversations and changes settings."],
  ["Clock-in & payroll", "A shared PIN pad for staff to clock in and out. Completed shifts feed payroll."],
];

const STEPS: Array<{ title: string; text: ReactNode; items?: string[] }> = [
  {
    title: "Create your account",
    text: (
      <>
        <a href={SIGN_UP_URL}>Sign up</a>, name your business and you land in the dashboard. You can start on the free
        plan and upgrade later (<a href={PRICING_URL}>see plans</a>).
      </>
    ),
  },
  {
    title: "Set your opening hours",
    text: "In Settings, set an open and close time for each weekday and mark closed days. Also check your time zone and currency (ZAR by default).",
    items: ["Kiosk walk-ins and WhatsApp bookings are only accepted inside these hours."],
  },
  {
    title: "Add your services",
    text: "Each service has a name, a price, a duration in minutes and an active switch. Duration decides which time slots are offered.",
    items: [
      "Don’t need services? Turn off “require service selection” for bookings or for the queue and set a default duration instead.",
    ],
  },
  {
    title: "Add your staff",
    text: "Add each person with a name, job title and hourly rate. Give them a clock-in PIN (unique within your shop). Phone, email, employee number and start date are optional.",
    items: [
      "Link a staff member to a sign-in only if they need to open the dashboard.",
      "How many active staff you can have depends on your plan.",
    ],
  },
  {
    title: "Choose your booking rules",
    text: "Decide how far ahead and how late customers can book, how many services fit in one booking, and when cancelling is still allowed. See the reference below for every option.",
  },
  {
    title: "Choose your queue rules",
    text: "Pick a ticket prefix (Q gives Q001, Q002…), an optional maximum queue size, and which doors can join: WhatsApp, kiosk or both. Turn on auto-call if you want the next person called automatically.",
  },
  {
    title: "Connect your WhatsApp number",
    text: "ZozoQueue connects to Meta’s official WhatsApp Cloud API using a number that belongs to your business. You can use Meta’s guided sign-up or enter the connection details manually.",
    items: [
      "A new connection shows as pending until Meta verifies it, then becomes active.",
      "If your number is currently in the regular WhatsApp app, talk to us first so nothing is interrupted.",
      "If you don’t see WhatsApp under Modules, it isn’t part of your plan yet.",
    ],
  },
  {
    title: "Review your WhatsApp messages",
    text: "Six messages go out automatically: queue joined, almost your turn, called, booking confirmation, booking reminder and waitlist slot open. Meta reviews each wording before it can be sent.",
    items: [
      "Each message has an on/off switch of its own.",
      "Reminders default to two hours before the appointment; you can change the lead time.",
    ],
  },
  {
    title: "Set up the kiosk",
    text: "Open your shop’s kiosk link on a tablet. Choose whether it offers bookings, the queue or both, rename the buttons and screens, and pick which details to ask for: name, surname, phone, email or one custom question.",
    items: [
      "The WhatsApp updates tick box is never pre-ticked. Customers without WhatsApp can still join.",
      "Add your logo, colours and a short tagline. Removing “Powered by ZozoQueue” is a Business-plan option.",
    ],
  },
  {
    title: "Set up the waiting-area screen",
    text: "Open your display link on a TV and leave it on. Choose rotating slides, a live board or a split view, a dark, light or custom colour theme, and which queue details appear. Changes reach the screen by themselves within seconds.",
  },
  {
    title: "Turn on clock-in and payroll",
    text: "Put the clock-in page on a shared tablet. Staff enter their PIN to clock in and out. In payroll, choose hourly, commission or hybrid pay, add your employer details, then calculate a period and mark it paid.",
  },
  {
    title: "Invite your team",
    text: "Send an invite code to each person who needs the dashboard. Codes expire after 7 days. Pick Owner/Admin or Staff for each.",
  },
  {
    title: "Test, then go live",
    text: "Run through one real visit of each type before you announce it.",
    items: [
      "Message your WhatsApp number and book an appointment.",
      "Cancel it and check the waitlist or slot behaves as expected.",
      "Join the queue from the kiosk, then call the number from the dashboard.",
      "Check the TV shows the call and that the customer received their WhatsApp message.",
      "Clock one staff member in and out.",
    ],
  },
];

const BOOKING_SETTINGS = [
  ["Unify with queue", "Pull confirmed bookings into the live queue shortly before they start.", "Off"],
  ["Queue lead time", "How many minutes before start a booking joins the queue.", "15 min"],
  ["Minimum notice", "How soon before a slot a customer can still book.", "30 min"],
  ["Booking window", "How many days ahead customers can book.", "30 days"],
  ["Dates offered", "How many dates are shown at once (1–14).", "7"],
  ["Cancellation cut-off", "Customers can cancel or move up to this many minutes before the start.", "60 min"],
  ["Services per booking", "How many services one booking can include (1–5).", "1"],
  ["Choose a staff member", "Let customers ask for someone by name. Off means staff are assigned automatically.", "Off"],
  ["Default duration", "Slot length when services are switched off (5–480 min).", "30 min"],
  ["Reminders", "Send a WhatsApp reminder before the appointment (30–1440 min ahead).", "On, 120 min"],
];

const QUEUE_SETTINGS = [
  ["Ordering", "First in first out, priority, or hybrid.", "First in first out"],
  ["Auto-call next", "Call the next person automatically.", "Off"],
  ["Maximum queue size", "Stop new joins at this number. Empty means no limit.", "No limit"],
  ["Almost-your-turn alert", "Message the customer when this many people are ahead.", "2"],
  ["Who can join", "WhatsApp and kiosk are switched separately.", "Both on"],
  ["Ticket prefix", "1–4 characters shown before the number. Numbers restart each day.", "Q"],
  ["Services per entry", "How many services one walk-in can pick (1–5).", "1"],
  ["Default service time", "Estimated minutes when no service is picked.", "15 min"],
];

const ROLES = [
  ["Owner / Admin", "Everything in your business: settings, billing, staff, payroll, bookings, queue and conversations."],
  ["Staff", "Day-to-day work: the queue, bookings and customers, as far as your plan and permissions allow."],
];

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className={base.faqItem}>
      <summary>
        {q}
        <svg className={base.faqIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </summary>
      <p className={base.faqAnswer}>{children}</p>
    </details>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className={base.page}>
      <SiteNav current="docs" />

      <header className={styles.head}>
        <div className={base.wrapWide}>
          <h1>ZozoQueue documentation</h1>
          <p>
            What ZozoQueue solves, how the pieces fit together, and how to get a shop from sign-up to its first live
            customer.
          </p>
          <div className={styles.headCtas}>
            <a className={`${base.btn} ${base.btnPrimary}`} href={SIGN_UP_URL}>Try for free</a>
            <a className={`${base.btn} ${base.btnSecondary}`} href={DEMO_URL}>See the live demo</a>
          </div>
        </div>
      </header>

      <div className={`${base.wrapWide} ${styles.layout}`}>
        <nav className={styles.toc} aria-label="On this page">
          {TOC.map((t) => <a key={t.id} href={`#${t.id}`}>{t.label}</a>)}
        </nav>

        <main className={styles.content}>
          <div className={styles.block} id="solutions">
            <h2>What it solves</h2>
            <p>
              Most shops have two front doors, the inbox and the doorway, and nothing connecting them. ZozoQueue puts both on one
              board. The <a href={HOW_URL}>How it works</a> page shows a day in the shop.
            </p>
            <Table head={["Today", "With ZozoQueue"]} rows={SOLVES} />
          </div>

          <div className={styles.block} id="pieces">
            <h2>The pieces</h2>
            <p>Everything belongs to your business and nothing is shared with other shops. You switch on only what you need.</p>
            <dl className={styles.defs}>
              {PIECES.map(([name, text]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className={styles.block} id="setup">
            <h2>Set up, step by step</h2>
            <p>Follow these in order. Each step takes minutes, and you can go live with only the first six if you don’t use WhatsApp yet.</p>
            <ol className={styles.steps}>
              {STEPS.map((s) => (
                <li key={s.title}>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  {s.items && (
                    <ul>
                      {s.items.map((i) => <li key={i}>{i}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>

          <div className={styles.block} id="reference">
            <h2>Settings reference</h2>
            <h3>Bookings</h3>
            <Table head={["Setting", "What it does", "Default"]} rows={BOOKING_SETTINGS} />
            <h3>Walk-in queue</h3>
            <Table head={["Setting", "What it does", "Default"]} rows={QUEUE_SETTINGS} />
          </div>

          <div className={styles.block} id="team">
            <h2>Roles &amp; access</h2>
            <p>
              Access is controlled by role. Payroll and pay details are held back for people who have been given payroll
              access, so a staff member who can see the roster can’t see what anyone earns.
            </p>
            <Table head={["Role", "Can do"]} rows={ROLES} />
          </div>

          <div className={styles.block} id="billing">
            <h2>Visits &amp; billing</h2>
            <p>
              A visit is one completed queue entry or one completed booking, whichever actually happened. A booking that
              is pulled into the queue and served counts once. Plans include a number of visits and staff, and extra
              visits or staff are charged at the rates on the <a href={PRICING_URL}>pricing page</a>. To change plan,
              request an upgrade from Billing in the dashboard.
            </p>
          </div>

          <div className={styles.block} id="help">
            <h2>Troubleshooting</h2>
            <div className={base.faqList}>
              <Faq q="My WhatsApp number still shows as pending.">
                A new connection stays pending until Meta has verified it. If it has been more than a day, email us your business
                name and we will check the connection with you.
              </Faq>
              <Faq q="A customer didn’t get a WhatsApp update.">
                Check three things: the customer ticked the WhatsApp updates box (or messaged you first), the message is
                switched on, and Meta has approved its wording. Outside an open chat, WhatsApp only allows approved
                message templates.
              </Faq>
              <Faq q="A message wording was rejected.">
                Meta decides this. Keep the wording plain and about the visit itself, not promotional, then resubmit. If
                it keeps failing, email us.
              </Faq>
              <Faq q="A time slot isn’t being offered.">
                Slots only appear inside your opening hours, after the minimum notice, within the booking window, and
                when a staff member is free for the full service duration.
              </Faq>
              <Faq q="The kiosk is missing the booking or queue button.">
                Check the kiosk registration type (bookings, queue or both), that the matching module is on for your plan,
                and that you are inside opening hours.
              </Faq>
              <Faq q="A staff member can’t clock in.">
                Check that they are active, that their PIN is set, and that nobody else in your shop has the same PIN.
              </Faq>
            </div>
          </div>
        </main>
      </div>

      <section className={base.closing}>
        <div className={base.wrap} style={{ textAlign: "center" }}>
          <h2 style={{ margin: "0 auto" }}>Stuck on a step?</h2>
          <p style={{ marginLeft: "auto", marginRight: "auto" }}>
            Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and a person will help you get live.
          </p>
        </div>
      </section>
    </div>
  );
}
