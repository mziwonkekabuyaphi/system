import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell, PRICING_URL } from "../DocsShell";

export const metadata = {
  title: "Roles & access — ZozoQueue docs",
  description:
    "Who can do what in ZozoQueue: the Owner/Admin and Staff roles, a full list of what each can open, how to invite someone, and the difference between your staff list and dashboard logins.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// The access matrix below mirrors the permissions each role is given in the database. If those
// change, update MATRIX to match.

/** The two-line summary at the top. */
const ROLES = [
  ["Owner / Admin", "Everything in your business: settings, billing, staff, payroll, bookings, queue and conversations."],
  ["Staff", "Day-to-day work: the queue, bookings and customers, as far as your plan and permissions allow."],
];

/** What each role can do, area by area. */
const MATRIX = [
  ["Live walk-in queue: see it, call the next customer, finish or cancel", "Yes", "Yes"],
  ["Bookings: see and manage appointments", "Yes", "Yes"],
  ["Customers", "See and manage", "See only"],
  ["WhatsApp conversations", "See", "See"],
  ["WhatsApp message volume and inbox statistics", "Yes", "No"],
  ["Staff list: profiles, contact details and clock-in PINs", "See and manage", "See only"],
  ["Add, edit or deactivate staff, and force a clock-out", "Yes", "No"],
  ["Services: create, edit, reprice, switch on or off", "Yes", "No"],
  ["Settings and branding, including the kiosk and the waiting-area screen", "Yes", "No"],
  ["Connect or change the WhatsApp number", "Yes", "No"],
  ["Team: invite people, remove them, change roles", "Yes", "See the team only"],
  ["Billing: plan, invoices and upgrade requests", "Yes", "No"],
  ["Payroll: hours, gross pay, PAYE and UIF, net pay and payslips; calculate and mark paid", "Yes", "No"],
];

const WHO = [
  ["Owner / Admin", "The owner, and anyone you trust with money and settings: a manager or a business partner. You can have more than one."],
  ["Staff", "People who run the day: front desk, receptionists, the team calling customers and handling bookings. They get what they need to serve customers and nothing to do with pay, billing or settings."],
];

const INVITE = [
  ["Create the invite", "In your team settings, choose Owner / Admin or Staff for the person. You can add their email address if you like."],
  ["Share the code", "Send them the invite code. It stays valid for 7 days, and you can make a new one if it runs out."],
  ["They accept it", "They sign in, or create their login, and accept the invite. They join your business with the role you chose, and only see your business."],
  ["Change or remove them later", "An owner or admin can change someone’s role or remove them at any time."],
];

const GOOD_TO_KNOW = [
  "Everyone has exactly one role, and the two roles are the same for every shop. For example, you can’t give one staff member payroll access on its own. If they need it, they need the Owner / Admin role.",
  "Staff can see the staff list, including clock-in PINs, but never pay or compensation. Keep that in mind when deciding who gets a login.",
  "Only Owner / Admin can connect WhatsApp, change the number, or switch features on and off.",
  "Your plan decides which parts of ZozoQueue exist for you at all. A role can’t open something your plan doesn’t include. See the pricing page for what each plan has.",
];

const QA = [
  ["Can a staff member see what others earn?", "No. Payroll, including hours, gross pay, deductions and payslips, is only visible to Owner / Admin."],
  ["Can I give someone payroll access but not the rest?", "Not today. Access comes from the role, so payroll is part of Owner / Admin. If you need to pay people without giving them access, keep them on your staff list and have an owner run payroll."],
  ["Can a manager run settings but not billing?", "Not today. Owner / Admin covers both. Give that role only to people you are happy to have in both."],
  ["Does everyone on my staff list need a login?", "No. Staff who only clock in and get paid don’t need a login at all. Only invite the people who need to open the dashboard."],
  ["Can customers or other shops see my team?", "No. Everyone you invite only sees your own business, and your data is never shared with other shops."],
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

export default function TeamPage() {
  return (
    <DocsShell current="team">
      <div className={styles.block}>
        <h1>Roles &amp; access</h1>
        <p>
          Access is controlled by role. Everyone who logs in to your dashboard has one of two roles, chosen when you
          invite them. Pay details are never visible to the Staff role, so a team member who can see the roster can’t
          see what anyone earns.
        </p>
        <Table head={["Role", "Can do"]} rows={ROLES} />
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#matrix">What each role can do</a></li>
          <li><a href="#who">Who gets which role</a></li>
          <li><a href="#invite">Inviting someone</a></li>
          <li><a href="#logins">Staff list vs logins</a></li>
          <li><a href="#good-to-know">Good to know</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="matrix" className={`${styles.block} ${styles.detail}`}>
        <h2>What each role can do</h2>
        <p>This is the full list, area by area, as the roles are set up today.</p>
        <Table head={["Area", "Owner / Admin", "Staff"]} rows={MATRIX} />
      </div>

      <div id="who" className={`${styles.block} ${styles.detail}`}>
        <h2>Who gets which role</h2>
        <p>A simple rule: give people the smallest role that lets them do their job.</p>
        <dl className={styles.defs}>
          {WHO.map(([name, text]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div id="invite" className={styles.block}>
        <h2>Inviting someone</h2>
        <p>Each person you want in the dashboard gets their own invite, so you always know who did what.</p>
        <ol className={styles.steps}>
          {INVITE.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div id="logins" className={`${styles.block} ${styles.detail}`}>
        <h2>Your staff list vs dashboard logins</h2>
        <p>
          These are two different things. Your <strong>staff list</strong> is everyone who works for you: they clock in
          with a PIN and are paid through payroll. A <strong>dashboard login</strong> is for people who need to open
          ZozoQueue itself.
        </p>
        <ul className={styles.points}>
          <li>Add everyone who works for you to the staff list, even if they never log in.</li>
          <li>Only invite the people who need the dashboard. A staff member can be linked to a login, but doesn’t have to be.</li>
          <li>Roles apply to logins. Staff who only use the PIN pad have no role.</li>
        </ul>
      </div>

      <div id="good-to-know" className={`${styles.block} ${styles.detail}`}>
        <h2>Good to know</h2>
        <ul className={styles.points}>
          {GOOD_TO_KNOW.map((g) => <li key={g}>{g}</li>)}
        </ul>
        <p className={styles.related}>
          See <a href={PRICING_URL}>what each plan includes</a>, or read about <a href="/demo/docs/billing">visits &amp; billing</a>.
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
