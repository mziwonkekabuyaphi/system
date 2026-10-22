import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell, PRICING_URL, CONTACT_EMAIL } from "../DocsShell";

export const metadata = {
  title: "Visits & billing — ZozoQueue docs",
  description:
    "How ZozoQueue counts a visit, how plans and invoices work, where to see your usage, and how to request a plan change.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// Prices are NOT written here: plans are read from the database, so this page links to the pricing page.
// Facts below were checked against the billing code and the database triggers that record visits.

/** The four terms used on the rest of the page. */
const TERMS = [
  ["Visit", "One finished customer interaction. It is what your plan counts and, on paid plans, what extra usage is billed on."],
  ["Allowance", "The number of visits your plan includes before anything extra is charged, or before new bookings stop on the free plan."],
  ["Extra visits", "Visits beyond your allowance on a paid plan. They are billed at your plan’s per-visit rate and never block your customers."],
  ["Included staff", "The active staff your base fee covers. Active staff beyond that are billed per person, up to your plan’s limit."],
];

/** What counts, situation by situation. */
const COUNTS = [
  ["A walk-in is served and marked Done", "Yes, one visit."],
  ["A booking joins the queue and is marked Done", "Yes, one visit. It is counted from its queue entry, never twice."],
  ["A booking is marked Completed and never joined the queue", "Yes, one visit."],
  ["A booking is cancelled, or the customer doesn’t show", "No. A booking only counts once it is marked Completed."],
  ["Someone joins the queue but leaves or is cancelled before Done", "No. A queue entry only counts once it is marked Done."],
  ["The same visit is marked finished more than once", "Counted once."],
];

const VISIT_POINTS = [
  "A visit is counted at the moment it is finished: Done in the queue, or Completed for a booking that never joined the queue.",
  "A visit is one record, however many services it included.",
  "Visits are counted by calendar month in UTC, which is two hours behind South African time. A visit finished between midnight and 02:00 on the 1st is counted in the month before.",
  "The free plan counts every visit since you started, and the count never resets. Paid plans count visits for the current calendar month.",
];

/** What the Plans & Billing screen shows. */
const SCREEN = [
  "Your current plan and what it includes.",
  "Visits used and visits remaining, for the period your plan counts.",
  "A split of those visits into walk-in and queue visits, and bookings that never joined the queue.",
  "Your active staff compared with your plan’s staff limit.",
  "An estimate of this month’s bill, with the base fee, any extra staff and any extra visits shown separately. On the free plan it is always zero.",
  "A comparison of every plan, including which parts of ZozoQueue each one includes.",
  "Any upgrade request that is waiting for approval.",
  "Your last 12 invoices.",
];

/** Plans compared in words, with no figures. */
const PLANS = [
  [
    "Mahala (the free plan)",
    "A fixed allowance that never resets. Once it is used up, new bookings and queue joins stop until you upgrade.",
    "A small cap on active staff.",
    "No invoices.",
  ],
  [
    "Growth and Business",
    "A monthly allowance that grows with your staff. Extra visits are billed per visit. Customers are never blocked for using too many.",
    "A number of staff are included. More are billed per person. Growth has a cap on active staff, and Business has none.",
    "One invoice a month.",
  ],
];

/** How a paid plan’s bill is built. */
const BILL = [
  ["Start with the base fee", "A flat monthly fee that covers the staff your plan includes."],
  ["Add extra staff", "Each active staff member above the included number is billed per person. Deactivated staff don’t count."],
  ["Work out your visit allowance", "Your plan includes a number of visits per staff member each month, multiplied by the staff you are billed for. You are always billed for at least the included staff, so the allowance never drops below that."],
  ["Add extra visits", "Visits beyond your allowance are billed at the per-visit rate."],
  ["That is your total", "Total = base fee + extra staff + extra visits."],
];

const INVOICE_STATUS = [
  ["Issued", "The invoice has been created and is waiting for payment."],
  ["Paid", "Payment has been received."],
  ["Overdue", "The invoice is past its due date and still unpaid."],
  ["Void", "The invoice was cancelled and nothing is owed."],
];

const BILLING_STATUS = [
  ["Active", "You are on a paid plan and nothing is waiting for payment."],
  ["Free plan", "You are on Mahala. There is nothing to pay."],
  ["Payment due", "Your latest invoice is issued and unpaid."],
  ["Overdue", "Your latest invoice is overdue."],
  ["Cancelled", "Your shop is no longer active."],
];

const CHANGE = [
  ["Open Plans & Billing", "Owners and admins can open it from the dashboard. The Staff role can’t."],
  ["Compare the plans", "Check which parts of ZozoQueue each plan includes, and see the pricing page for the figures."],
  ["Request the plan you want", "Pick the plan and, if you like, add a note. You can only have one request waiting at a time."],
  ["We approve it", "A person at ZozoQueue reviews the request. There is no card checkout yet. When it is approved, your shop moves to the new plan straight away."],
  ["Your features follow", "Features that come with the new plan are available immediately. If a plan is ever lowered, features it doesn’t include switch off immediately."],
];

const QA = [
  ["Is a booking counted twice if it joined the queue?", "No. A booking that joined the queue is counted once, from its queue entry. Only bookings that never joined the queue are counted as bookings."],
  ["Do cancelled bookings or no-shows count?", "No. A booking only counts once it is marked Completed, and a queue entry only counts once it is marked Done."],
  ["I’m on the free plan and customers can’t book or join the queue.", "You have probably used the free allowance, which never resets. Request an upgrade in Plans & Billing and customers can book again once it is approved."],
  ["Will I be blocked if I go over my allowance on a paid plan?", "No. Extra visits are billed instead of blocked, so your customers are never turned away for using too many."],
  ["Why can’t I add or reactivate a staff member?", "You have reached your plan’s limit on active staff. Deactivating someone frees a place, or you can request an upgrade."],
  ["Does deactivating staff lower my invoice?", "Yes, only active staff are billed. Staff are counted on the day the invoice is created, so deactivate anyone who has left before the 1st of the month."],
  ["Which month is a visit counted in?", "The calendar month in UTC. Because that is two hours behind South African time, a visit finished just after midnight on the 1st counts in the month before."],
  ["How do I move to a cheaper plan?", "Requests in Plans & Billing are for upgrades. For anything else, email us and we will help."],
  ["Where do I find my invoices?", "In Plans & Billing. It shows your last 12, with the base fee, visits, extra staff and total on each."],
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

export default function BillingPage() {
  return (
    <DocsShell current="billing">
      <div className={styles.block}>
        <h1>Visits &amp; billing</h1>
        <p>
          ZozoQueue plans are built around visits and active staff. This page explains what counts as a visit, how
          your usage and invoices work, and how to change plan. For prices and what each plan includes, see the{" "}
          <a href={PRICING_URL}>pricing page</a>.
        </p>
        <dl className={styles.defs}>
          {TERMS.map(([name, text]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#visit">What counts as a visit</a></li>
          <li><a href="#usage">Seeing your usage</a></li>
          <li><a href="#plans">How plans differ</a></li>
          <li><a href="#bill">How a bill is worked out</a></li>
          <li><a href="#invoices">Invoices</a></li>
          <li><a href="#change">Changing plan</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="visit" className={`${styles.block} ${styles.detail}`}>
        <h2>What counts as a visit</h2>
        <p>A visit is counted when it is finished, not when it is booked or when the customer joins.</p>
        <Table head={["What happens", "Counts?"]} rows={COUNTS} />
        <ul className={styles.points}>
          {VISIT_POINTS.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>

      <div id="usage" className={`${styles.block} ${styles.detail}`}>
        <h2>Seeing your usage</h2>
        <p>Owners and admins can open Plans &amp; Billing in the dashboard. It shows:</p>
        <ul className={styles.points}>
          {SCREEN.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <p className={styles.note}>The estimate is for the current month only, and is a preview of the invoice that will be created after the month ends.</p>
      </div>

      <div id="plans" className={`${styles.block} ${styles.detail}`}>
        <h2>How plans differ</h2>
        <p>
          The exact allowances, limits and prices are on the <a href={PRICING_URL}>pricing page</a>. The way they
          work is the same for everyone:
        </p>
        <Table head={["Plan", "Visits", "Staff", "Invoices"]} rows={PLANS} />
        <p className={styles.related}>
          Which parts of ZozoQueue you can use also depends on your plan. See{" "}
          <a href="/demo/docs/team">Roles &amp; access</a> for what each role can open.
        </p>
      </div>

      <div id="bill" className={styles.block}>
        <h2>How a bill is worked out</h2>
        <p>For Growth and Business, each month’s total is built like this:</p>
        <ol className={styles.steps}>
          {BILL.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
        <p className={styles.note}>
          An imaginary example, not a real plan: a plan includes 2 staff and 100 visits per staff each month. A shop
          with 3 active staff is billed for 3 staff, so its allowance is 300 visits. If it finishes 340 visits, it pays
          the base fee, one extra staff member, and 40 extra visits.
        </p>
      </div>

      <div id="invoices" className={`${styles.block} ${styles.detail}`}>
        <h2>Invoices</h2>
        <p>
          Growth and Business get one invoice a month, created on the 1st for the month that has just ended. The free
          plan has no invoices. Each invoice shows the base fee, your visits, the allowance, any extra visits, your
          staff and any extra staff.
        </p>
        <h3>Invoice status</h3>
        <Table head={["Status", "Meaning"]} rows={INVOICE_STATUS} />
        <h3>Your billing status</h3>
        <p>Plans &amp; Billing also shows one overall status, worked out from your plan and your latest invoice.</p>
        <Table head={["Status", "Meaning"]} rows={BILLING_STATUS} />
        <p className={styles.note}>
          There is no card payment inside ZozoQueue yet, so invoices are settled with you directly. Staff are counted on
          the day the invoice is created, so the staff you have active then are the staff you are billed for.
        </p>
      </div>

      <div id="change" className={styles.block}>
        <h2>Changing plan</h2>
        <ol className={styles.steps}>
          {CHANGE.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div id="questions" className={styles.block}>
        <h2>Common questions</h2>
        <div className={base.faqList}>
          {QA.map(([q, a]) => (
            <Faq key={q} q={q}>{a}</Faq>
          ))}
        </div>
        <p>
          Something about your bill doesn’t look right? Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>{" "}
          with your business name and the month in question.
        </p>
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/team">
            <span>Previous</span>
            ← Roles &amp; access
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/troubleshooting">
            <span>Next</span>
            Troubleshooting →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
