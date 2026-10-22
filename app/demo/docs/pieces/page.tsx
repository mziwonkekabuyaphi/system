import styles from "../docs.module.css";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "The pieces — ZozoQueue docs",
  description:
    "The five parts of ZozoQueue: the WhatsApp assistant, the walk-in kiosk, the waiting-area screen, the live dashboard, and staff clock-in with payroll.",
};

// Copy lives in this list so it can be edited without touching the layout.
const PIECES = [
  ["WhatsApp assistant", "An AI receptionist on your own WhatsApp Business number (Meta’s Cloud API). Books, cancels, moves bookings and joins the queue. Any chat can be handed to a person with one tap."],
  ["Kiosk", "A tablet at the door. Walk-ins join the queue or book a time. You choose what the buttons say and which details to collect. It can print a ticket on a thermal printer."],
  ["Waiting-area screen", "Any TV with a browser. Rotating slides or a live board of who is being served and who is next. Phone numbers are only shown masked."],
  ["Live dashboard", "Where your team calls the next customer, manages bookings, reads WhatsApp conversations and changes settings."],
  ["Clock-in & payroll", "A shared PIN pad for staff to clock in and out. Completed shifts feed payroll."],
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
