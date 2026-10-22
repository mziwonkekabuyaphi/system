import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Settings reference — ZozoQueue docs",
  description:
    "Every booking and walk-in queue setting in ZozoQueue: what it does, its allowed range and its default value.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// Defaults here must match the database defaults for a new shop.
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

export default function ReferencePage() {
  return (
    <DocsShell current="reference">
      <div className={styles.block}>
        <h1>Settings reference</h1>
        <p>
          Every option you can change, with what it does and the value a new shop starts with. You will find them
          under Booking rules and Queue rules in the dashboard settings.
        </p>
        <h3>Bookings</h3>
        <Table head={["Setting", "What it does", "Default"]} rows={BOOKING_SETTINGS} />
        <h3>Walk-in queue</h3>
        <Table head={["Setting", "What it does", "Default"]} rows={QUEUE_SETTINGS} />
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
