import type { ReactNode } from "react";
import "../../auth/theme.css"; // same --qless-* tokens as the landing page
import base from "../demo.module.css";
import styles from "./docs.module.css";
import { SiteNav } from "../SiteNav";

// Shared by every docs page: top bar, left-hand topic list, closing help strip.
export const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup";
export const PRICING_URL = "/demo/pricing";
export const HOW_URL = "/demo/how-it-works";
export const DEMO_URL = "/demo/live";
export const CONTACT_EMAIL = "hello@ndithini.com";

const DOCS_HOME = "/demo/docs";

/**
 * The left-hand topic list. Topics move to their own page one at a time: when you convert one,
 * point its href at the new page (like "solutions" below) and move its content there.
 * Every topic now has its own page; the docs home (page.tsx) lists them using the blurbs.
 */
export const TOC = [
  { id: "solutions", label: "What it solves", href: `${DOCS_HOME}/solutions`, blurb: "The everyday problems ZozoQueue removes, problem by problem." },
  { id: "pieces", label: "The pieces", href: `${DOCS_HOME}/pieces`, blurb: "WhatsApp assistant, kiosk, waiting-area screen, dashboard and clock-in." },
  { id: "setup", label: "Set up, step by step", href: `${DOCS_HOME}/setup`, blurb: "From sign-up to your first live customer." },
  { id: "reference", label: "Settings reference", href: `${DOCS_HOME}/reference`, blurb: "Every booking and queue setting, with its default." },
  { id: "team", label: "Roles & access", href: `${DOCS_HOME}/team`, blurb: "Who can do what: Owner/Admin and Staff." },
  { id: "billing", label: "Visits & billing", href: `${DOCS_HOME}/billing`, blurb: "How a visit is counted and how to change plan." },
  { id: "troubleshooting", label: "Troubleshooting", href: `${DOCS_HOME}/troubleshooting`, blurb: "Fixes for the questions we hear most." },
];

export function DocsShell({ current, hero, children }: { current?: string; hero?: ReactNode; children: ReactNode }) {
  return (
    <div className={base.page}>
      <SiteNav current="docs" />
      {hero}

      <div className={`${base.wrapWide} ${styles.layout}`}>
        <nav className={styles.toc} aria-label="Documentation topics">
          {TOC.map((t) => (
            <a key={t.id} href={t.href} aria-current={t.id === current ? "page" : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
        <main className={styles.content}>{children}</main>
      </div>

      <section className={base.closing}>
        <div className={base.wrap} style={{ textAlign: "center" }}>
          <h2 style={{ margin: "0 auto" }}>Stuck on a step?</h2>
          <p style={{ marginLeft: "auto", marginRight: "auto" }}>
            Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and a person will help you get live.
          </p>
        </div>
      </section>
    </div>
  );
}
