import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { DocsShell, CONTACT_EMAIL, PRICING_URL } from "../DocsShell";

export const metadata = {
  title: "Troubleshooting — ZozoQueue docs",
  description:
    "Fixes for common problems: WhatsApp connection and messages, bookings and slots, the kiosk, ticket printing, the waiting-area screen, staff clock-in and plan features.",
};

// Copy lives in this list so it can be edited without touching the layout.
// Each group is a heading with questions under it; add a question by adding a [question, answer] pair.
const GROUPS: Array<{ id: string; short: string; title: string; items: Array<[string, string]> }> = [
  {
    id: "whatsapp",
    short: "WhatsApp",
    title: "WhatsApp connection and messages",
    items: [
      [
        "My WhatsApp number still shows as pending.",
        "If the badge says “Setting up”, the connection was started but not finished. Open Settings, then WhatsApp messages, and press Finish connecting. Meta can also take a little while to verify a new number. If it is still stuck after a day, email us your business name and we will check the connection with you.",
      ],
      [
        "The connection says “Needs attention”.",
        "Open Settings, then WhatsApp messages. The panel shows the last error it received. Press Try again. If it fails again, email us that error text and we will look at it with you.",
      ],
      [
        "I can’t connect WhatsApp, or the button is missing.",
        "Only the business owner can connect WhatsApp. It also has to be part of your plan. If it isn’t, the panel says so and points you to Billing.",
      ],
      [
        "A customer didn’t get a WhatsApp update.",
        "Check three things: the customer ticked the WhatsApp updates box (or messaged you first), the message is switched on, and Meta has approved its wording. Outside an open chat, WhatsApp only allows approved message templates.",
      ],
      [
        "A message wording was rejected.",
        "Meta decides this, and its reason is shown under the message in Settings, WhatsApp messages. Keep the wording plain and about the visit itself, not promotional. Promotional wording gets re-labelled “Marketing”, which costs more. Edit it and press Submit to Meta again. If it keeps failing, email us.",
      ],
      [
        "A message has been “In review at Meta” for a long time.",
        "Reviews usually take a few minutes. Press Refresh status to check. While a message is in review you can’t edit it, and customers who haven’t messaged you in the last 24 hours won’t receive it until Meta approves it.",
      ],
      [
        "I changed an approved message and it stopped sending.",
        "Changing the wording of an approved message sends it to Meta for review again. Until it is approved, customers outside the 24-hour window won’t get it.",
      ],
      [
        "The assistant answered something I’d rather handle myself.",
        "Open the conversation in the dashboard and take over the chat. You can hand it back to the assistant when you are done.",
      ],
      [
        "I connected a different number and the old one stopped working.",
        "A shop has one WhatsApp number at a time. Connecting a different number moves customer messages to it, and the old number stops receiving them. Reconnect the old number to switch back.",
      ],
    ],
  },
  {
    id: "bookings",
    short: "Bookings",
    title: "Bookings and time slots",
    items: [
      [
        "A time slot isn’t being offered.",
        "Slots only appear inside your opening hours, after the minimum notice, within the booking window, and when a staff member is free for the full service duration.",
      ],
      [
        "A customer can’t cancel or move their booking.",
        "Customers can change a booking only up to the cancellation cut-off before it starts (60 minutes by default). After that, your team can handle it from the dashboard.",
      ],
      [
        "A booking reminder wasn’t sent.",
        "Check that reminders are switched on in Booking rules, that the reminder message is on and approved by Meta, and that the customer’s number is a WhatsApp number. Reminders go out a set time before the appointment (two hours by default).",
      ],
      [
        "The waitlist didn’t message anyone.",
        "The waitlist is only messaged when a booked time is cancelled or moved, and only the next person waiting for that day. Check that the waitlist message is switched on and approved.",
      ],
    ],
  },
  {
    id: "kiosk",
    short: "Kiosk and queue",
    title: "The kiosk and the walk-in queue",
    items: [
      [
        "The kiosk is missing the booking or queue button.",
        "Check the kiosk registration type (bookings, queue or both), that the matching module is on for your plan, and that you are inside opening hours.",
      ],
      [
        "The kiosk skips the service screen.",
        "That happens when service selection is switched off. It also happens if you haven’t added any services yet and appointments still need one: the kiosk then skips the service screen and shows only the walk-in queue.",
      ],
      [
        "The queue won’t take any more people.",
        "Check Maximum queue size in Queue rules. Leave it empty for no limit.",
      ],
      [
        "Ticket numbers start again at 001.",
        "That is by design. Numbers restart each day, with the prefix you chose (Q by default).",
      ],
    ],
  },
  {
    id: "printing",
    short: "Ticket printing",
    title: "Ticket printing",
    items: [
      [
        "The kiosk says “Couldn’t print” but the ticket comes out.",
        "The first ticket after the PC starts can be slow, because the print helper is still waking up. Give it up to 30 seconds before tapping Try printing again, or you may get two tickets. The customer’s number stays on screen the whole time.",
      ],
      [
        "Nothing prints.",
        "Check that the printer is on, has paper and its cover is closed, and that the print helper program is running on the PC the printer is plugged into. Then tap Try printing again.",
      ],
      [
        "A ticket printed twice.",
        "This can happen if Try printing again is tapped while the first ticket is still on its way. Wait about 30 seconds before trying again.",
      ],
    ],
  },
  {
    id: "screen",
    short: "Waiting-area screen",
    title: "The waiting-area screen",
    items: [
      [
        "The TV shows nothing, or looks out of date.",
        "Check that the TV is online and open on your shop’s display link. It updates by itself within seconds, so if it seems stuck, reload the page.",
      ],
      [
        "Customers’ phone numbers look hidden.",
        "That is on purpose. The screen only ever shows phone numbers masked, so nobody’s number is read out to the room.",
      ],
    ],
  },
  {
    id: "staff",
    short: "Staff and clock-in",
    title: "Staff, clock-in and payroll",
    items: [
      [
        "A staff member can’t clock in.",
        "Check that they are active, that their PIN is set, and that nobody else in your shop has the same PIN.",
      ],
      [
        "A new team member can’t join.",
        "Invite codes expire after 7 days. Send them a new one.",
      ],
      [
        "A staff member can’t see payroll.",
        "That is by design. Payroll, including hours, pay and payslips, is only visible to owners and admins. The Staff role can’t see it.",
      ],
    ],
  },
  {
    id: "account",
    short: "Plan",
    title: "Your plan",
    items: [
      [
        "A feature is missing from my settings.",
        "Features are switched on per plan. If a module isn’t listed, it isn’t part of your plan yet. Request an upgrade from Billing in the dashboard, or see what each plan includes on the pricing page.",
      ],
    ],
  },
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

export default function TroubleshootingPage() {
  return (
    <DocsShell current="troubleshooting">
      <div className={styles.block}>
        <h1>Troubleshooting</h1>
        <p>The questions we hear most, grouped by where you’ll see the problem. If yours isn’t here, email us and a person will help.</p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          {GROUPS.map((g) => (
            <li key={g.id}><a href={`#${g.id}`}>{g.short}</a></li>
          ))}
          <li><a href="#still-stuck">Still stuck?</a></li>
        </ul>
      </nav>

      {GROUPS.map((g) => (
        <div key={g.id} id={g.id} className={`${styles.block} ${styles.detail}`}>
          <h2>{g.title}</h2>
          <div className={base.faqList}>
            {g.items.map(([q, a]) => (
              <Faq key={q} q={q}>{a}</Faq>
            ))}
          </div>
        </div>
      ))}

      <div id="still-stuck" className={styles.block}>
        <h2>Still stuck?</h2>
        <p>
          Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. It helps us fix it faster if you include:
        </p>
        <ul className={styles.points}>
          <li>Your business name.</li>
          <li>What you expected to happen, and what happened instead.</li>
          <li>Roughly when it happened.</li>
          <li>A screenshot, or the exact error text if you can see one.</li>
        </ul>
        <p>
          Not sure a feature is on your plan? <a href={PRICING_URL}>See what each plan includes</a>.
        </p>
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
