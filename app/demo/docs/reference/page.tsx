import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Settings reference — ZozoQueue docs",
  description:
    "Every booking and walk-in queue setting in ZozoQueue: what it does, its allowed range and its default value.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// Defaults and ranges here were checked against the database for a new shop. If those change, update this page.
// Columns: setting, what it does, allowed values, default.
const HEAD = ["Setting", "What it does", "Allowed", "Default"];

const BOOKING_SETTINGS = [
  ["Unify with queue", "Pull confirmed bookings into the live queue shortly before they start.", "On or off", "Off"],
  ["Queue priority", "First in first out, priority, or hybrid. Only applies while Unify with queue is on.", "Three choices", "First in first out"],
  ["Queue lead time", "How many minutes before start a booking joins the queue.", "0 or more minutes", "15 min"],
  ["Minimum notice", "How soon before a slot a customer can still book.", "0 or more minutes", "30 min"],
  ["Booking window", "How many days ahead customers can book.", "0 or more days", "30 days"],
  ["Dates offered", "How many dates are shown at once (1–14).", "1 to 14", "7"],
  ["Cancellation cut-off", "Customers can cancel or move up to this many minutes before the start.", "0 or more minutes", "60 min"],
  ["Services per booking", "How many services one booking can include (1–5).", "1 to 5", "1"],
  ["Choose a staff member", "Let customers ask for someone by name. Off means staff are assigned automatically.", "On or off", "Off"],
  ["Require a service to book", "Off means the kiosk and WhatsApp skip the service step and go straight to the date.", "On or off", "On"],
  ["Default duration", "Slot length when services are switched off (5–480 min).", "5 to 480 minutes", "30 min"],
  ["Reminders", "Send a WhatsApp reminder before the appointment (30–1440 min ahead).", "On or off, then 30 to 1440 minutes", "On, 120 min"],
];

const QUEUE_SETTINGS = [
  ["Auto-call next", "Call the next person automatically.", "On or off", "Off"],
  ["Maximum queue size", "Stop new joins at this number. Empty means no limit.", "1 or more, or empty", "No limit"],
  ["Almost-your-turn alert", "Message the customer when this many people are ahead.", "0 or more people", "2"],
  ["Who can join", "WhatsApp and kiosk are switched separately.", "Two on/off switches", "Both on"],
  ["Require a service to join", "Off means walk-ins skip the service step and go straight to their name and number.", "On or off", "On"],
  ["Services per entry", "How many services one walk-in can pick (1–5).", "1 to 5", "1"],
  ["Default service time", "Estimated minutes when no service is picked.", "1 or more minutes", "15 min"],
  ["Ticket prefix", "1–4 characters shown before the number. Numbers restart each day.", "1 to 4 characters", "Q"],
];

/** How each booking setting behaves, beyond the one-line description in the table. */
const BOOKING_NOTES = [
  "Unify with queue is checked about once a minute, so a booking appears in the queue within about a minute of becoming eligible, not the instant it does. It doesn’t change who may join the queue as a walk-in. It only adds bookings alongside them.",
  "Queue priority has three choices. “First come, first served” treats a promoted booking exactly like a walk-in. “Honor appointment time” serves it at or before its appointment time where possible, even ahead of walk-ins who joined earlier. “First come, but flag it” keeps first-come order, but staff see a warning if a booking’s wait would run past its appointment time.",
  "Queue lead time is counted back from each booking’s start time, in your shop’s time zone, not from when the booking was made.",
  "Minimum notice is enforced on every booking attempt, not just hidden from the list of times.",
  "Booking window means customers can book up to and including that many days ahead, in your shop’s time zone. Your opening hours still apply. At 0 it is same-day booking only, and the kiosk and booking flow skip the date picker and go straight to today’s times.",
  "Dates offered is how many date buttons the kiosk and WhatsApp list, starting from today. It is separate from the booking window, and the smaller of the two applies: listing 7 dates with a 3-day window still shows 4. Set it to 1 to offer today only.",
  "Cancellation cut-off: once a booking is inside this window it can no longer be cancelled from the Today screen in the dashboard.",
  "Services per booking: at 2 or more, the kiosk lets customers tick up to that many. WhatsApp keeps offering one.",
  "Choose a staff member works on WhatsApp, for example “book with Sipho”. The customer is only offered times that person is free, and is told if they aren’t available. They are never given a different person than the one they asked for. Rescheduling and the kiosk still assign staff automatically.",
  "Require a service to book, when off, makes every appointment use the Default duration, because there is no service to look up a length from. Bookings made this way show as “No service” in Today and Bookings. It is separate from the queue’s own “Require a service” switch.",
  "Reminders go out within about 5 minutes of the time you set. Examples: 120 is 2 hours before, 1440 is the day before. Bookings made inside that window don’t get a reminder, because the customer has only just heard about them. A customer who messaged you on WhatsApp in the last 24 hours gets it as a normal message. Everyone else only gets it if they agreed to WhatsApp updates and your reminder wording is approved by Meta.",
];

const QUEUE_NOTES = [
  "Auto-call next calls the next customer automatically when a slot frees up.",
  "Maximum queue size must be a whole number of 1 or more. Leave it empty for no limit. Once the queue reaches that size, it won’t take anyone else.",
  "Almost-your-turn alert decides when the “nearly their turn” message goes out. It is sent once, when the customer reaches that position.",
  "Who can join: allowing walk-ins via WhatsApp and via the kiosk are two separate switches. They don’t affect bookings.",
  "Require a service to join, when off, sends walk-ins straight to giving their name and number on the kiosk, WhatsApp and the dashboard. It is separate from the booking switch of the same name.",
  "Services per entry only appears while “Require a service to join” is on. At 2 or more the kiosk lets walk-ins tick several. WhatsApp keeps offering one.",
  "Default service time only appears while “Require a service to join” is off. It is your estimate of how long each walk-in with no service takes.",
  "Ticket prefix is shown in capital letters on printed kiosk tickets and WhatsApp confirmations. You can use your own initials or a short word instead of Q. Numbers start again at 001 each day.",
];

/** Settings that only matter once another one is set. */
const LINKED = [
  "Queue priority is greyed out until “Unify with queue” is on.",
  "Default duration (bookings) only appears while “Require a service to book” is off.",
  "The reminder time only appears while Reminders are on.",
  "On the Queue page, Services per entry shows while “Require a service to join” is on, and Default service time shows while it is off.",
  "Dates offered and Booking window both limit the dates customers see. The smaller one wins.",
  "Keep the Cancellation cut-off shorter than the reminder time. If it is as long as, or longer than, the reminder time, customers who tap “Can’t make it” are told it is too late to cancel, and the page shows a warning.",
];

/** Goal-first lookup. */
const RECIPES = [
  ["Take same-day bookings only", "Set the Booking window to 0."],
  ["Stop last-minute bookings", "Raise Minimum notice."],
  ["Offer today only on the kiosk and WhatsApp", "Set Dates offered to 1."],
  ["Show bookings and walk-ins in one line", "Switch on Unify with queue, then choose a Queue priority."],
  ["Let customers ask for a particular person", "Switch on Choose a staff member. It works on WhatsApp."],
  ["Take walk-ins who don’t pick a service", "Switch off Require a service to join, and set the Default service time."],
  ["Stop the queue getting too long", "Set a Maximum queue size."],
  ["Use your own ticket letters", "Change the Ticket prefix to 1–4 characters."],
];

const QA = [
  ["I can’t pick a Queue priority option.", "The options are greyed out until Unify with queue is on. Queue priority only decides how a booking is ordered once it has joined the queue."],
  ["The kiosk shows fewer dates than I set.", "Dates offered and the Booking window both limit the list, and the smaller one applies. Listing 7 dates with a 3-day window shows 4."],
  ["A customer tapped “Can’t make it” on a reminder and was told it was too late to cancel.", "Your Cancellation cut-off is as long as, or longer than, the reminder time. Send the reminder earlier, or shorten the cut-off."],
  ["Customers can only pick one service on WhatsApp, even though I set Services per booking higher.", "That setting lets customers tick several on the kiosk. WhatsApp keeps offering one service for now."],
  ["Do ticket numbers carry on from yesterday?", "No. Numbers start again at 001 each day, with the prefix you chose."],
  ["I pressed Save on one card. Did the rest of the page save?", "On the Booking page every card shares one form, so any Save button saves the whole page, including edits you made in other cards. Check the message next to the button to be sure it worked."],
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

export default function ReferencePage() {
  return (
    <DocsShell current="reference">
      <div className={styles.block}>
        <h1>Settings reference</h1>
        <p>
          Every option you can change, with what it does and the value a new shop starts with. You will find them
          under Booking rules and Queue rules in the dashboard settings.
        </p>
        <p className={styles.note}>
          Only Owner / Admin logins can change settings. Changes take effect once you press Save.
        </p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#bookings">Bookings</a></li>
          <li><a href="#queue">Walk-in queue</a></li>
          <li><a href="#linked">Settings that depend on others</a></li>
          <li><a href="#recipes">I want to…</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="bookings" className={`${styles.block} ${styles.detail}`}>
        <h2>Bookings</h2>
        <p>
          Settings, on the Booking page. The cards are “Link bookings to the queue”, “Require a service to book”,
          “Timing &amp; cancellations”, “Allow customers to choose staff”, “Booking reminders” and “Queue priority”.
        </p>
        <Table head={HEAD} rows={BOOKING_SETTINGS} />
        <h3>How each one behaves</h3>
        <ul className={styles.points}>
          {BOOKING_NOTES.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>

      <div id="queue" className={`${styles.block} ${styles.detail}`}>
        <h2>Walk-in queue</h2>
        <p>Settings, on the Queue page, in the “Walk-in line” card.</p>
        <Table head={HEAD} rows={QUEUE_SETTINGS} />
        <h3>How each one behaves</h3>
        <ul className={styles.points}>
          {QUEUE_NOTES.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>

      <div id="linked" className={`${styles.block} ${styles.detail}`}>
        <h2>Settings that depend on others</h2>
        <p>If a setting seems to be missing or has no effect, check whether one of these applies.</p>
        <ul className={styles.points}>
          {LINKED.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </div>

      <div id="recipes" className={`${styles.block} ${styles.detail}`}>
        <h2>I want to…</h2>
        <p>Start from what you want, and find the setting to change.</p>
        <Table head={["If you want to…", "Change"]} rows={RECIPES} />
        <p className={styles.related}>
          New here? Follow <a href="/demo/docs/setup">Set up, step by step</a>, which links back to these settings at the right moment.
        </p>
      </div>

      <div id="questions" className={styles.block}>
        <h2>Common questions</h2>
        <div className={base.faqList}>
          {QA.map(([q, a]) => (
            <Faq key={q} q={q}>{a}</Faq>
          ))}
        </div>
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/setup">
            <span>Previous</span>
            ← Set up, step by step
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/team">
            <span>Next</span>
            Roles &amp; access →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
