import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Your landing page — ZozoQueue docs",
  description:
    "The Booking and Queue landing page for Business plan shops: pick the template, add your words and photos, preview it and publish it on a free address or your own domain.",
};

// Checked against Settings > Website (ZozoWeb) and the Booking & Queue template in the product.

const LIVE = [
  ["Services and prices", "Your real services, with duration and price, from your own setup."],
  ["Opening hours", "Taken from Settings, Business hours."],
  ["Book now and Join the queue", "Buttons that open your real booking page, so nothing is rebuilt and nothing goes out of date."],
  ["Colours and logo", "Taken from your Branding settings."],
];

const YOURS = [
  ["Headline and line under it", "Up to 80 and 160 characters."],
  ["About us", "Optional, up to 600 characters."],
  ["Main photo and photo gallery", "PNG, JPG or WEBP, up to 3 MB each, and up to 8 gallery photos."],
  ["Address", "Shown in the Visit section."],
  ["WhatsApp button", "Opens a chat with your number, with a message you choose already filled in."],
  ["Sections", "Switch services, opening hours, gallery and contact on or off."],
];

const STEPS = [
  ["Open Website", "In Settings, open Website. You need the Business plan, and your Booking or Queue setup switched on first, because the page is built from that data."],
  ["Pick the Booking & Queue template", "Clean and light, with your services, prices, Book now and Join the queue."],
  ["Add your words and photos", "Write your headline, an optional About us, and add a main photo and gallery."],
  ["Add your WhatsApp number", "Optional. A Chat on WhatsApp button appears for visitors."],
  ["Preview it", "Check how it looks. A new look only goes live when you publish."],
  ["Publish", "Your page goes live. Until you publish, visitors still see your normal booking page."],
];

const NOTES = [
  "Your page gets a free address. If you also connect your own domain, the home page of that domain shows your landing page too.",
  "If you switch the page off, your normal booking page is shown again, so nobody’s link breaks.",
  "Publishing keeps the live page separate from your draft, so editing never changes what visitors see until you publish.",
  "The page refreshes itself every few minutes, so new services and changed prices show up soon.",
  "The page has no live “people waiting” number on purpose, because a stale count would mislead walk-ins. The queue itself runs on your booking page.",
];

const QA = [
  ["Who gets a landing page?", "Every shop on the Business plan."],
  ["Do I have to build the page from scratch?", "No. Pick the template, change the words and photos, and your services, prices and hours fill in by themselves."],
  ["Can customers still book and join the queue?", "Yes. Book now and Join the queue open your real booking page, with all your booking and queue rules."],
  ["Can I use my own domain?", "Yes. Connect it under Custom domain. See Your own domain."],
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

export default function WebsitePage() {
  return (
    <DocsShell current="website">
      <div className={styles.block}>
        <h1>Your landing page</h1>
        <p>
          Included in the Business plan. Every Business plan shop gets a Booking and Queue landing page: a clean website of
          your own that shows your services and prices, and sends customers to book or join the queue.
        </p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#live">What fills in by itself</a></li>
          <li><a href="#yours">What you write</a></li>
          <li><a href="#steps">Publishing it</a></li>
          <li><a href="#notes">Good to know</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="live" className={`${styles.block} ${styles.detail}`}>
        <h2>What fills in by itself</h2>
        <Table head={["Part of the page", "Where it comes from"]} rows={LIVE} />
      </div>

      <div id="yours" className={`${styles.block} ${styles.detail}`}>
        <h2>What you write</h2>
        <Table head={["Part of the page", "Details"]} rows={YOURS} />
      </div>

      <div id="steps" className={styles.block}>
        <h2>Publishing it</h2>
        <ol className={styles.steps}>
          {STEPS.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div id="notes" className={`${styles.block} ${styles.detail}`}>
        <h2>Good to know</h2>
        <ul>
          {NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>

      <div id="questions" className={styles.block}>
        <h2>Common questions</h2>
        <div className={base.faqList}>
          {QA.map(([q, a]) => (
            <Faq key={q} q={q}>{a}</Faq>
          ))}
        </div>
      </div>
    </DocsShell>
  );
}
