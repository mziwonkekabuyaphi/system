import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Payments & deposits — ZozoQueue docs",
  description:
    "Ask customers to pay when they book: connect a card provider, then choose full payment, a deposit or pay-after-service, plus a payment deadline and refund policy.",
};

// Checked against the Payments settings and Booking rules screens in the product.
// Card payments are optional and part of the Business plan.

const PROVIDERS = [
  ["Yoco", "Connect with your Yoco secret key."],
  ["Ozow", "Connect with your site code, API key and private key."],
  ["PayFast", "Connect with your merchant ID, merchant key and passphrase."],
  ["Paystack", "Connect with your Paystack secret key."],
  ["Peach Payments", "Connect with your entity ID and secret token."],
];

const RULES = [
  ["When customers pay", "Pay in full when booking, pay a deposit when booking, or pay after the service. Orders have their own wording: in full, deposit, or on collection or delivery."],
  ["Deposit", "A fixed amount in rand, or a percentage of the total. Only used when the timing is a deposit."],
  ["Payment deadline", "How long a customer has to pay before the booking or order is released. From 5 minutes to 7 days, or leave it blank for no deadline."],
  ["Refund policy", "Not stated, full refund, partial refund (you choose the percentage), or no refund, plus an optional note shown to customers."],
];

const STEPS = [
  ["Connect a card provider", "In Settings, open Payments, choose your provider and enter the details it asks for. Secret keys are saved encrypted and can’t be shown again. Start in test mode: no real money moves until you switch to live."],
  ["Set your payment rules", "Once a provider is connected, the Payment rules section appears. Set the rules for Bookings and for Orders separately, then save."],
  ["Switch on payment for bookings", "In Booking rules, turn on “Customers pay when they book”. Customers then get a card payment link (a QR code on the kiosk) for the total of the services they picked."],
  ["Test it", "Make a test booking in test mode and pay it. The booking should confirm once the payment arrives."],
];

const NOTES = [
  "You connect one card provider at a time. To switch provider, disconnect the current one first. The money goes straight to your own account with that provider.",
  "While the customer is paying, their time is held. The booking is confirmed once payment is verified. If they don’t pay in time, the time is released for someone else.",
  "Services with a price of 0 are booked without payment.",
  "If you also switch on “Require approval before confirming”, the customer pays first and you approve afterwards.",
  "Refunds are still made in your payment provider’s portal. For bookings, the cut-off is your cancellation window in Booking rules.",
  "If payments are off, bookings are free and confirm straight away.",
];

const QA = [
  ["Do I have to take payment?", "No. Payment is optional and off by default. Turn it on only if you want deposits or full payment up front."],
  ["Can I take a deposit instead of the full amount?", "Yes. Choose “Pay a deposit when booking”, then a fixed amount or a percentage of the total."],
  ["Can customers pay at the kiosk?", "Yes. The kiosk shows a QR code for the card payment link, and the booking confirms once they have paid."],
  ["Does ZozoQueue hold my customers’ money?", "No. Payments go straight to your own account with the provider you connected."],
  ["Can I take payments for orders too?", "The payment rules can be set for Bookings and Orders separately."],
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

export default function PaymentsPage() {
  return (
    <DocsShell current="payments">
      <div className={styles.block}>
        <h1>Payments &amp; deposits</h1>
        <p>
          Included in the Business plan, and optional. Ask customers to pay when they book, so a held time is a committed time. You choose whether they pay
          in full, put down a deposit or pay after the service, how long they have, and what your refund policy is.
        </p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#providers">Card providers</a></li>
          <li><a href="#rules">Payment rules</a></li>
          <li><a href="#steps">Turning it on</a></li>
          <li><a href="#notes">Good to know</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="providers" className={`${styles.block} ${styles.detail}`}>
        <h2>Card providers</h2>
        <p>Connect one of these. Each asks for its own details.</p>
        <Table head={["Provider", "What you enter"]} rows={PROVIDERS} />
      </div>

      <div id="rules" className={`${styles.block} ${styles.detail}`}>
        <h2>Payment rules</h2>
        <Table head={["Rule", "What it does"]} rows={RULES} />
      </div>

      <div id="steps" className={styles.block}>
        <h2>Turning it on</h2>
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
