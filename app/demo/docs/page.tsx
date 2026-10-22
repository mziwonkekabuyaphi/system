import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Troubleshooting — ZozoQueue docs",
  description:
    "Fixes for common problems: WhatsApp stuck on pending, missing customer updates, rejected message wording, missing time slots, the kiosk and staff clock-in.",
};

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

export default function TroubleshootingPage() {
  return (
    <DocsShell current="troubleshooting">
      <div className={styles.block}>
        <h1>Troubleshooting</h1>
        <p>The questions we hear most. If yours isn’t here, email us and a person will help.</p>
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
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/billing">
            <span>Previous</span>
            ← Visits &amp; billing
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
