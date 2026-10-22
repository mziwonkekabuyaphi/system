import type { ReactNode } from "react";
import styles from "../docs.module.css";
import { DocsShell, SIGN_UP_URL, PRICING_URL } from "../DocsShell";

export const metadata = {
  title: "Set up, step by step — ZozoQueue docs",
  description:
    "From sign-up to your first live customer: opening hours, services, staff, booking and queue rules, WhatsApp, the kiosk, the waiting-area screen, clock-in and a go-live test.",
};

// Copy lives in this list so it can be edited without touching the layout.
const STEPS: Array<{ title: string; text: ReactNode; items?: string[] }> = [
  {
    title: "Create your account",
    text: (
      <>
        <a href={SIGN_UP_URL}>Sign up</a>, name your business and you land in the dashboard. You can start on the free
        plan and upgrade later (<a href={PRICING_URL}>see plans</a>).
      </>
    ),
  },
  {
    title: "Set your opening hours",
    text: "In Settings, set an open and close time for each weekday and mark closed days. Also check your time zone and currency (ZAR by default).",
    items: ["Kiosk walk-ins and WhatsApp bookings are only accepted inside these hours."],
  },
  {
    title: "Add your services",
    text: "Each service has a name, a price, a duration in minutes and an active switch. Duration decides which time slots are offered.",
    items: [
      "Don’t need services? Turn off “require service selection” for bookings or for the queue and set a default duration instead.",
    ],
  },
  {
    title: "Add your staff",
    text: "Add each person with a name, job title and hourly rate. Give them a clock-in PIN (unique within your shop). Phone, email, employee number and start date are optional.",
    items: [
      "Link a staff member to a sign-in only if they need to open the dashboard.",
      "How many active staff you can have depends on your plan.",
    ],
  },
  {
    title: "Choose your booking rules",
    text: (
      <>
        Decide how far ahead and how late customers can book, how many services fit in one booking, and when cancelling is still allowed. See the{" "}
        <a href="/demo/docs/reference">settings reference</a> for every option.
      </>
    ),
  },
  {
    title: "Choose your queue rules",
    text: "Pick a ticket prefix (Q gives Q001, Q002…), an optional maximum queue size, and which doors can join: WhatsApp, kiosk or both. Turn on auto-call if you want the next person called automatically.",
  },
  {
    title: "Connect your WhatsApp number",
    text: "ZozoQueue connects to Meta’s official WhatsApp Cloud API using a number that belongs to your business. You can use Meta’s guided sign-up or enter the connection details manually.",
    items: [
      "A new connection shows as pending until Meta verifies it, then becomes active.",
      "If your number is currently in the regular WhatsApp app, talk to us first so nothing is interrupted.",
      "If you don’t see WhatsApp under Modules, it isn’t part of your plan yet.",
    ],
  },
  {
    title: "Review your WhatsApp messages",
    text: "Six messages go out automatically: queue joined, almost your turn, called, booking confirmation, booking reminder and waitlist slot open. Meta reviews each wording before it can be sent.",
    items: [
      "Each message has an on/off switch of its own.",
      "Reminders default to two hours before the appointment; you can change the lead time.",
    ],
  },
  {
    title: "Set up the kiosk",
    text: "Open your shop’s kiosk link on a tablet. Choose whether it offers bookings, the queue or both, rename the buttons and screens, and pick which details to ask for: name, surname, phone, email or one custom question.",
    items: [
      "The WhatsApp updates tick box is never pre-ticked. Customers without WhatsApp can still join.",
      "Add your logo, colours and a short tagline. Removing “Powered by ZozoQueue” is a Business-plan option.",
    ],
  },
  {
    title: "Set up the waiting-area screen",
    text: "Open your display link on a TV and leave it on. Choose rotating slides, a live board or a split view, a dark, light or custom colour theme, and which queue details appear. Changes reach the screen by themselves within seconds.",
  },
  {
    title: "Turn on clock-in and payroll",
    text: "Put the clock-in page on a shared tablet. Staff enter their PIN to clock in and out. In payroll, choose hourly, commission or hybrid pay, add your employer details, then calculate a period and mark it paid.",
  },
  {
    title: "Invite your team",
    text: "Send an invite code to each person who needs the dashboard. Codes expire after 7 days. Pick Owner/Admin or Staff for each.",
  },
  {
    title: "Test, then go live",
    text: "Run through one real visit of each type before you announce it.",
    items: [
      "Message your WhatsApp number and book an appointment.",
      "Cancel it and check the waitlist or slot behaves as expected.",
      "Join the queue from the kiosk, then call the number from the dashboard.",
      "Check the TV shows the call and that the customer received their WhatsApp message.",
      "Clock one staff member in and out.",
    ],
  },
];

export default function SetupPage() {
  return (
    <DocsShell current="setup">
      <div className={styles.block}>
        <h1>Set up, step by step</h1>
        <p>Follow these in order. Each step takes minutes, and you can go live with only the first six if you don’t use WhatsApp yet.</p>
        <ol className={styles.steps}>
          {STEPS.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              {s.items && (
                <ul>
                  {s.items.map((i) => <li key={i}>{i}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ol>
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/pieces">
            <span>Previous</span>
            ← The pieces
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/reference">
            <span>Next</span>
            Settings reference →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
