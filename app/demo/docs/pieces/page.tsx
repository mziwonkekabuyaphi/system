import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell, PRICING_URL } from "../DocsShell";

export const metadata = {
  title: "The pieces — ZozoQueue docs",
  description:
    "The five parts of ZozoQueue in detail: the WhatsApp assistant, the walk-in kiosk, the waiting-area screen, the live dashboard, and staff clock-in with payroll. How they fit together and which ones you need.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// Only describe what the product already does. Prices are NOT written here (see the pricing page).

/** The summary list at the top. */
const PIECES = [
  ["WhatsApp assistant", "An AI receptionist on your own WhatsApp Business number (Meta’s Cloud API). Books, cancels, moves bookings and joins the queue. Any chat can be handed to a person with one tap."],
  ["Kiosk", "A tablet at the door. Walk-ins join the queue or book a time. You choose what the buttons say and which details to collect. It can print a ticket on a thermal printer."],
  ["Waiting-area screen", "Any TV with a browser. Rotating slides or a live board of who is being served and who is next. Phone numbers are only shown masked."],
  ["Live dashboard", "Where your team calls the next customer, manages bookings, reads WhatsApp conversations and changes settings."],
  ["Clock-in & payroll", "A shared PIN pad for staff to clock in and out. Completed shifts feed payroll."],
];

/** One section per piece. `setup` lists the docs pages that cover switching it on. */
const DETAILS: Array<{
  id: string;
  short: string;
  title: string;
  intro: string;
  points: string[];
  note?: string;
  setup: Array<[string, string]>;
}> = [
  {
    id: "whatsapp",
    short: "WhatsApp assistant",
    title: "WhatsApp assistant",
    intro: "An AI receptionist that answers on your shop’s own WhatsApp Business number, through Meta’s official WhatsApp Cloud API. Customers message the number they already know.",
    points: [
      "Books, cancels and moves appointments, and adds people to the walk-in queue, all in plain chat.",
      "Only offers times that fit the service the customer asks for, inside your opening hours.",
      "Every conversation is visible in the dashboard. You can take over any chat with one tap and hand it back when you are done.",
      "Sends automatic messages for the key moments: joined the queue, nearly your turn, called, booking confirmation, booking reminder and a waitlist slot opening.",
      "You connect it by signing in with Meta, and ZozoQueue never sees your Meta password. Only the business owner can do this.",
      "The dashboard shows whether the connection is not connected, setting up, connected or needs attention. Connecting a different number later means your old one stops receiving customer messages.",
    ],
    note: "Use a number that isn’t already in the regular WhatsApp or WhatsApp Business app. Meta bills you directly for the messages, and it must approve the wording of messages sent to people who haven’t messaged you first.",
    setup: [["Connect your WhatsApp number", "/demo/docs/setup"], ["Review your WhatsApp messages", "/demo/docs/setup"], ["WhatsApp troubleshooting", "/demo/docs/troubleshooting"]],
  },
  {
    id: "kiosk",
    short: "Kiosk",
    title: "Kiosk",
    intro: "A tablet at the door, opened on your shop’s kiosk link. Customers check themselves in without asking at the counter.",
    points: [
      "Offers the walk-in queue, bookings or both. You choose.",
      "You choose the wording of the buttons and screens, and which details to ask for: name, surname, cellphone, email or one question of your own.",
      "Add your logo, colours and a short tagline so it looks like your shop. Removing “Powered by ZozoQueue” is a Business-plan option.",
      "The “WhatsApp updates” tick box is never pre-ticked, and customers without WhatsApp can still join.",
      "After check-in the customer sees their ticket number, then the screen returns to the start by itself, ready for the next person.",
      "The same kiosk link works on a phone, so a QR code at the door lets walk-ins check in from their own phone.",
      "It can print a ticket on a thermal receipt printer. Printing uses a small helper program that runs on the PC the printer is plugged into.",
    ],
    setup: [["Set up the kiosk", "/demo/docs/setup"], ["Queue and booking options", "/demo/docs/reference"]],
  },
  {
    id: "screen",
    short: "Waiting-area screen",
    title: "Waiting-area screen",
    intro: "Any TV with a browser, left on in the waiting area. It answers “who’s next?” so your team doesn’t have to.",
    points: [
      "Choose rotating slides, a live board of who is being served and who is next, or a split view of both.",
      "When someone is called, the screen highlights it for a few seconds so it is hard to miss.",
      "Phone numbers are only ever shown masked.",
      "Pick a dark, light or custom colour theme, and which queue details appear.",
      "It updates by itself within seconds, so nobody has to refresh it.",
    ],
    setup: [["Set up the waiting-area screen", "/demo/docs/setup"]],
  },
  {
    id: "dashboard",
    short: "Live dashboard",
    title: "Live dashboard",
    intro: "Where your team runs the day. Everything that happens at the door and on WhatsApp ends up here.",
    points: [
      "See the live queue and call the next customer, then mark them done or cancel them.",
      "See and manage bookings, including confirming, cancelling and completing them.",
      "Read WhatsApp conversations and take over from the assistant when a person is needed.",
      "Change everything about your shop in Settings: opening hours, services, staff, booking and queue rules, the kiosk, the screen, WhatsApp messages, payroll and billing.",
      "Access depends on role. Owners and admins can do everything, and staff get what they need for the day-to-day.",
    ],
    setup: [["Invite your team", "/demo/docs/setup"], ["Roles & access", "/demo/docs/team"]],
  },
  {
    id: "clock-in",
    short: "Clock-in & payroll",
    title: "Clock-in & payroll",
    intro: "A shared PIN pad page on a tablet. Staff enter their own PIN to clock in and out, and the hours flow into payroll.",
    points: [
      "Each staff member has a PIN that is unique within your shop. Clock-ins and clock-outs are recorded as shifts.",
      "Payroll turns completed shifts into hours worked and pay. Pay can be hourly, commission, or a hybrid of the two.",
      "Payroll adds an estimate of PAYE and UIF, and you mark each period paid when it is.",
      "Pay details are only visible to owners and admins, never to the Staff role.",
    ],
    setup: [["Turn on clock-in and payroll", "/demo/docs/setup"], ["Roles & access", "/demo/docs/team"]],
  },
];

/** Follow one customer through the pieces. */
const VISIT = [
  ["They join", "A customer messages your WhatsApp number or checks in at the kiosk. They can also book a time ahead."],
  ["They land on one board", "Walk-ins and bookings show up in the same live list in the dashboard. A booking can join the queue shortly before it starts."],
  ["They are kept informed", "If they opted in, they get a WhatsApp message when they join and again when they are nearly up. The waiting-area screen shows the queue."],
  ["They are called", "Your team presses call next. The customer is messaged and the screen highlights their number."],
  ["They are served", "Marking the visit complete counts it as one visit toward your plan."],
];

/** Which pieces to switch on for which goal. */
const NEEDS = [
  ["Take appointments and answer customers on WhatsApp", "WhatsApp assistant and the dashboard"],
  ["Let walk-ins check themselves in", "Kiosk and the dashboard"],
  ["Show the queue in the waiting area", "Waiting-area screen"],
  ["Message customers about their turn", "WhatsApp assistant"],
  ["Pay staff from real hours", "Clock-in & payroll"],
];

export default function PiecesPage() {
  return (
    <DocsShell current="pieces">
      <div className={styles.block}>
        <h1>The pieces</h1>
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

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          {DETAILS.map((d) => (
            <li key={d.id}><a href={`#${d.id}`}>{d.short}</a></li>
          ))}
          <li><a href="#together">How they fit together</a></li>
          <li><a href="#which">Which ones you need</a></li>
        </ul>
      </nav>

      {DETAILS.map((d) => (
        <div key={d.id} id={d.id} className={`${styles.block} ${styles.detail}`}>
          <h2>{d.title}</h2>
          <p>{d.intro}</p>
          <ul className={styles.points}>
            {d.points.map((p) => <li key={p}>{p}</li>)}
          </ul>
          {d.note && <p className={styles.note}>{d.note}</p>}
          <p className={styles.related}>
            Set it up:{" "}
            {d.setup.map(([label, href], i) => (
              <span key={label}>
                {i > 0 && " · "}
                <a href={href}>{label}</a>
              </span>
            ))}
          </p>
        </div>
      ))}

      <div id="together" className={styles.block}>
        <h2>How they fit together</h2>
        <p>Here is one customer’s visit, and which piece handles each moment.</p>
        <ol className={styles.steps}>
          {VISIT.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div id="which" className={styles.block}>
        <h2>Which ones you need</h2>
        <p>
          Each piece is switched on separately, so start with what matters most and add the rest later. Which pieces
          are included depends on your plan, so check the <a href={PRICING_URL}>pricing page</a>.
        </p>
        <Table head={["If you want to…", "Switch on"]} rows={NEEDS} />
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/solutions">
            <span>Previous</span>
            ← What it solves
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/setup">
            <span>Next</span>
            Set up, step by step →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
