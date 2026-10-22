import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell, HOW_URL, DEMO_URL, PRICING_URL } from "../DocsShell";

export const metadata = {
  title: "What ZozoQueue solves — ZozoQueue docs",
  description:
    "The everyday problems ZozoQueue removes for a shop, one by one: after-hours messages, walk-ins versus appointments, double bookings, full days, waiting around and hand-worked payroll.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// Only describe what the product already does. Prices are NOT written here (see the pricing page).

/** The summary table at the top. */
const SOLVES = [
  ["Customers message after hours and never hear back.", "The WhatsApp assistant replies at any hour and books or queues them."],
  ["Walk-ins on paper, appointments in a diary, never compared.", "Both land on one live board. A confirmed booking can be pulled into the queue shortly before it starts."],
  ["Two staff members booked for the same slot.", "The database refuses overlapping bookings, so two people tapping at the same second can’t both win."],
  ["A full day means a lost customer.", "The customer joins a waitlist. When someone cancels, the waitlist is messaged in the order they joined."],
  ["“Is it my turn yet?” at the counter.", "Customers get a WhatsApp message when they are nearly up and when they are called."],
  ["Hours worked and pay worked out by hand.", "Staff clock in on a PIN pad; payroll is calculated from real hours with a PAYE and UIF estimate."],
];

/** One section per problem. `setup` lists the docs pages that cover switching it on. */
const DETAILS: Array<{
  id: string;
  short: string;
  title: string;
  today: string;
  points: string[];
  setup: Array<[string, string]>;
}> = [
  {
    id: "after-hours",
    short: "After-hours messages",
    title: "Customers message after hours and never hear back",
    today: "A message arrives at nine at night. Nobody sees it until morning, and by then the customer has booked somewhere that answered.",
    points: [
      "The assistant answers on your own WhatsApp Business number at any hour, so there is no separate number or app for customers to learn.",
      "It can book, cancel and move appointments, and add someone to the walk-in queue.",
      "It only offers times that fit the service they ask for, inside your opening hours.",
      "Any conversation can be handed to a person with one tap, and handed back.",
    ],
    setup: [["Connect your WhatsApp number", "/demo/docs/setup"], ["The pieces", "/demo/docs/pieces"]],
  },
  {
    id: "walk-ins-and-bookings",
    short: "Walk-ins and appointments",
    title: "Walk-ins on paper, appointments in a diary",
    today: "The paper list and the diary are never compared, so a walk-in can take the slot someone booked, or an appointment waits behind a queue nobody told them about.",
    points: [
      "Walk-ins check themselves in on the kiosk tablet, or from the WhatsApp assistant, and land on the same live board your team already works from.",
      "Turn on “unify with queue” and a confirmed booking joins the queue a set number of minutes before it starts (15 by default).",
      "Choose how the queue is ordered: first in first out, priority, or a hybrid of the two.",
      "Each door can be switched on or off separately, so you can run WhatsApp only, kiosk only, or both.",
    ],
    setup: [["Choose your booking and queue rules", "/demo/docs/setup"], ["Every option and its default", "/demo/docs/reference"]],
  },
  {
    id: "double-bookings",
    short: "Double bookings",
    title: "Two customers booked for the same slot",
    today: "Two people ask for the same barber at the same time, both get a yes, and one of them is turned away at the door.",
    points: [
      "Each service has a duration, so a gel set blocks out more of the diary than a brow tint.",
      "Slots are checked against that staff member’s existing bookings, and the database itself refuses an overlap. Two customers tapping at the same second can’t both get it.",
      "You decide whether customers can ask for a particular staff member. Off means staff are assigned automatically.",
      "Minimum notice, a booking window and a cancellation cut-off keep last-minute changes under your control.",
    ],
    setup: [["Add your services and staff", "/demo/docs/setup"], ["Booking settings", "/demo/docs/reference"]],
  },
  {
    id: "full-days",
    short: "Full days",
    title: "A full day means a lost customer",
    today: "Saturday is booked solid, the customer is told “sorry, we’re full” and goes elsewhere. Then someone cancels at noon and the slot sits empty.",
    points: [
      "When a day is full, the customer can join a waitlist for it instead of walking away.",
      "If a booked time is cancelled or moved, the people on that day’s waitlist are messaged in the order they joined.",
      "That message can be switched off or reworded to sound like your shop, and Meta reviews any new wording before it is sent.",
    ],
    setup: [["Review your WhatsApp messages", "/demo/docs/setup"]],
  },
  {
    id: "waiting-around",
    short: "Waiting around",
    title: "“Is it my turn yet?” at the counter",
    today: "Customers hover by the door or keep asking how long it will be, because nobody can tell them.",
    points: [
      "Each walk-in gets a ticket number with your prefix (Q001, Q002…), shown on screen and printable on a thermal receipt printer.",
      "Customers who opt in get a WhatsApp message when they are nearly up (when two people are ahead, by default) and again when they are called.",
      "A TV in the waiting area shows who is being served and who is next. Phone numbers are only shown masked.",
      "The estimated wait comes from the length of the services people have picked.",
    ],
    setup: [["Set up the kiosk and the waiting-area screen", "/demo/docs/setup"], ["Queue settings", "/demo/docs/reference"]],
  },
  {
    id: "payroll",
    short: "Payroll",
    title: "Hours worked and pay worked out by hand",
    today: "Someone adds up hours from a notebook at the end of the month, and pay is calculated from memory.",
    points: [
      "Staff clock in and out on a shared PIN pad. Completed shifts become hours worked.",
      "Pay can be hourly, commission or a hybrid of the two.",
      "Payroll adds an estimate of PAYE and UIF, and you mark each period paid when it is.",
      "Pay details are only visible to owners and admins, never to the Staff role.",
    ],
    setup: [["Turn on clock-in and payroll", "/demo/docs/setup"], ["Roles & access", "/demo/docs/team"]],
  },
];

/** Same six types of shop as the landing page. */
const FIT = [
  ["Barbershops & hair salons", "Regulars book Saturday slots on WhatsApp while walk-ins take a ticket at the door. One list, one set of staff, no clashes."],
  ["Beauty & nail studios", "A gel set takes longer than a brow tint. The assistant only offers times that fit the treatment, and a full Saturday goes on the waitlist."],
  ["Clinics & aesthetic practices", "Appointment-led, but a missed message can mean a missed patient. After-hours messages get a booking, not silence until morning."],
  ["Auto workshops & tyre centres", "Drop-ins for a quick job, bookings for a full service. Customers get a message when it’s their turn instead of hovering in the shop."],
  ["Veterinary practices", "Check-ups booked ahead, same-day walk-ins in the same queue, and a human can take over any chat with one tap."],
  ["Device & phone repair shops", "A drop-off queue that tells customers when it’s their turn, instead of “is it done yet?” at the counter."],
];

const GOOD_TO_KNOW = [
  "WhatsApp needs a number that isn’t already used in the regular WhatsApp or WhatsApp Business app. Meta bills you directly for the messages it carries.",
  "WhatsApp only lets a business message someone first with a template Meta has approved, which is why the messages are reviewed before they can be sent.",
  "The PAYE and UIF figures in payroll are estimates, so check them before you pay.",
  "Which features you get depends on your plan. See the pricing page for what each plan includes.",
];

export default function SolutionsPage() {
  return (
    <DocsShell current="solutions">
      <div className={styles.block}>
        <h1>What it solves</h1>
        <p>
          Most shops have two front doors, the inbox and the doorway, and nothing connecting them. ZozoQueue puts both
          on one board. Here is what changes, problem by problem.
        </p>
        <Table head={["Today", "With ZozoQueue"]} rows={SOLVES} />
        <p style={{ marginTop: 18 }}>
          Want to see it working? The <a href={HOW_URL}>How it works</a> page follows a day in the shop, and the{" "}
          <a href={DEMO_URL}>live demo</a> lets you try the kiosk yourself.
        </p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          {DETAILS.map((d) => (
            <li key={d.id}><a href={`#${d.id}`}>{d.short}</a></li>
          ))}
          <li><a href="#who-its-for">Who it’s built for</a></li>
        </ul>
      </nav>

      {DETAILS.map((d) => (
        <div key={d.id} id={d.id} className={`${styles.block} ${styles.detail}`}>
          <h2>{d.title}</h2>
          <p>{d.today}</p>
          <ul className={styles.points}>
            {d.points.map((p) => <li key={p}>{p}</li>)}
          </ul>
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

      <div id="who-its-for" className={styles.block}>
        <h2>Who it’s built for</h2>
        <p>Any shop that takes both appointments and walk-ins. A few we hear from most:</p>
        <dl className={styles.defs}>
          {FIT.map(([who, text]) => (
            <div key={who}>
              <dt>{who}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className={styles.block}>
        <h2>Good to know</h2>
        <ul className={styles.points}>
          {GOOD_TO_KNOW.map((g) => <li key={g}>{g}</li>)}
        </ul>
        <p>
          Ready to try it? <a href={PRICING_URL}>See the plans</a> or go straight to{" "}
          <a href="/demo/docs/setup">setting up</a>.
        </p>
        <div className={styles.pagers}>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/pieces">
            <span>Next</span>
            The pieces →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
