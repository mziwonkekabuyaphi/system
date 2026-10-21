// app/demo/SiteNav.tsx
//
// The one top bar used by every public page: Overview (landing), How it works, Demo (live),
// Pricing, Sign in and Try for free. Each page passes `current` so its own link is marked.
// Change a link or a button here and it changes on all four pages.

import styles from "./demo.module.css"
import { Logo } from "@/components/Logo"

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login"
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup"

const LINKS = [
  { key: "home", label: "Overview", href: "/demo" },
  { key: "how", label: "How it works", href: "/demo/how-it-works" },
  { key: "demo", label: "Demo", href: "/demo/live" },
  { key: "pricing", label: "Pricing", href: "/demo/pricing" },
] as const

export type SiteNavPage = (typeof LINKS)[number]["key"]

export function SiteNav({ current }: { current: SiteNavPage }) {
  return (
    <nav className={`${styles.siteNav} ${styles.siteNavBar}`} aria-label="Main">
      <div className={`${styles.siteNavInner} ${styles.siteNavInnerBar}`}>
        <a className={styles.siteNavBrand} href="/demo">
          <Logo size={40} />
          ZozoQueue
        </a>
        <div className={styles.siteNavActions}>
          {LINKS.filter((l) => !(current === "home" && l.key === "home")).map((l) => (
            <a
              key={l.key}
              className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`}
              href={l.href}
              aria-current={l.key === current ? "page" : undefined}
            >
              {l.label}
            </a>
          ))}
          <a className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} href={SIGN_IN_URL}>
            Sign in
          </a>
          <a className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} href={SIGN_UP_URL}>
            Try for free
          </a>
        </div>
      </div>
    </nav>
  )
}
