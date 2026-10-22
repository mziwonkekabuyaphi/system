import base from "../demo.module.css"; // button styles
import styles from "./docs.module.css";
import { DocsShell, TOC, SIGN_UP_URL, DEMO_URL } from "./DocsShell";

export const metadata = {
  title: "ZozoQueue docs — from the problem it solves to your first day live",
  description:
    "How ZozoQueue works and how to set it up: WhatsApp booking assistant, walk-in kiosk, waiting-area screen, live dashboard, staff clock-in and payroll.",
};

const hero = (
  <header className={styles.head}>
    <div className={base.wrapWide}>
      <h1>ZozoQueue documentation</h1>
      <p>
        What ZozoQueue solves, how the pieces fit together, and how to get a shop from sign-up to its first live
        customer.
      </p>
      <div className={styles.headCtas}>
        <a className={`${base.btn} ${base.btnPrimary}`} href={SIGN_UP_URL}>Try for free</a>
        <a className={`${base.btn} ${base.btnSecondary}`} href={DEMO_URL}>See the live demo</a>
      </div>
    </div>
  </header>
);

// Each topic has its own page. The list and the one-line descriptions live in TOC (DocsShell.tsx).
export default function DocsHomePage() {
  return (
    <DocsShell hero={hero}>
      <div className={styles.block}>
        <h2>Start here</h2>
        <p>Read them in order, or jump to what you need.</p>
        <ul className={styles.topics}>
          {TOC.map((t) => (
            <li key={t.id}>
              <a href={t.href}>
                <strong>{t.label}</strong>
                <span>{t.blurb}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </DocsShell>
  );
}
