import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell, HOW_URL, DEMO_URL } from "../DocsShell";

export const metadata = {
  title: "What ZozoQueue solves — ZozoQueue docs",
  description:
    "The everyday problems ZozoQueue removes for a shop: after-hours messages, walk-ins versus appointments, double bookings, full days, queue anxiety and hand-worked payroll.",
};

// Copy lives in this list so it can be edited without touching the layout.
const SOLVES = [
  ["Customers message after hours and never hear back.", "The WhatsApp assistant replies at any hour and books or queues them."],
  ["Walk-ins on paper, appointments in a diary, never compared.", "Both land on one live board. A confirmed booking can be pulled into the queue shortly before it starts."],
  ["Two staff members booked for the same slot.", "The database refuses overlapping bookings, so two people tapping at the same second can’t both win."],
  ["A full day means a lost customer.", "The customer joins a waitlist. When someone cancels, the waitlist is messaged in the order they joined."],
  ["“Is it my turn yet?” at the counter.", "Customers get a WhatsApp message when they are nearly up and when they are called."],
  ["Hours worked and pay worked out by hand.", "Staff clock in on a PIN pad; payroll is calculated from real hours with a PAYE and UIF estimate."],
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
