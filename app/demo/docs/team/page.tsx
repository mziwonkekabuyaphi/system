import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Roles & access — ZozoQueue docs",
  description:
    "Who can do what in ZozoQueue: Owner/Admin and Staff roles, and how pay details are kept from people without payroll access.",
};

// Copy lives in this list so it can be edited without touching the layout.
const ROLES = [
  ["Owner / Admin", "Everything in your business: settings, billing, staff, payroll, bookings, queue and conversations."],
  ["Staff", "Day-to-day work: the queue, bookings and customers, as far as your plan and permissions allow."],
];

export default function TeamPage() {
  return (
    <DocsShell current="team">
      <div className={styles.block}>
        <h1>Roles &amp; access</h1>
        <p>
          Access is controlled by role. Payroll and pay details are held back for people who have been given payroll
          access, so a staff member who can see the roster can’t see what anyone earns.
        </p>
        <Table head={["Role", "Can do"]} rows={ROLES} />
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/reference">
            <span>Previous</span>
            ← Settings reference
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/billing">
            <span>Next</span>
            Visits &amp; billing →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
