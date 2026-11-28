import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Your own domain — ZozoQueue docs",
  description:
    "Show your booking page, kiosk and waiting-area screen on your own web address, like book.yourshop.com, in two short steps.",
};

// Checked against Settings > Custom domain in the product.

const STEPS = [
  ["Type your address", "In Settings, open Custom domain and type the address you want, like book.yourshop.com. A subdomain (book., queue. or tickets. in front of your domain) is the easiest way to start."],
  ["Step 1: prove it’s yours", "We show you one DNS record. Sign in where you manage the domain (usually the company you bought it from), open its DNS settings and add that record. Some providers want only the first part of the name, others the whole name."],
  ["Step 2: point it at us", "Once ownership is confirmed, we show the record that connects the address. Add it in the same place. If the domain is also registered with another hosting account, we may ask for one more record."],
  ["Check it", "Press “Check now”. DNS changes usually take a few minutes, sometimes longer. The page re-checks by itself for a while. When it is live, the card shows your address."],
];

const NOTES = [
  "You can connect up to 3 domains, and choose which one is the main address.",
  "Your team still signs in on the main ZozoQueue site as usual.",
  "If you don’t add the ownership record in time, the request lapses and you can start again.",
  "If a live domain develops a problem, the card shows “Needs attention” with the reason in plain words.",
];

const QA = [
  ["Do I need to buy a domain?", "Yes, you need one you control. If you don’t have one, your shop keeps its standard ZozoQueue address."],
  ["Is it hard to set up?", "You add one or two records in your domain’s DNS settings. We show exactly what to type, and check it for you."],
  ["Which pages show on my address?", "Your booking page, kiosk and waiting-area screen. If you have published a landing page, the home page of your address shows it."],
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

export default function DomainPage() {
  return (
    <DocsShell current="domain">
      <div className={styles.block}>
        <h1>Your own domain</h1>
        <p>
          Included in the Business plan. Put your booking page, kiosk and waiting-area screen on your own address (and, on the Business plan, your landing page), like book.yourshop.com, so customers
          see your name, not ours.
        </p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#steps">Connecting it</a></li>
          <li><a href="#notes">Good to know</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="steps" className={styles.block}>
        <h2>Connecting it</h2>
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
