"use client"

// app/demo/SiteNav.tsx
//
// The one top bar used by every public page. It stays pinned to the top while scrolling.
// Desktop: logo + zozoQ name, then Overview (landing), How it works, Demo (live), Docs, Pricing
// on the left; Sign in and Try for free on the right.
// Phones (860px and under): name, Try for free and a burger button. The page links and Sign in
// open in a dropdown under the bar (closes on a link tap, Escape, or a tap outside). Each page passes `current` so its own link is marked.
// Change a link or a button here and it changes on all four pages.

import { useEffect, useRef, useState } from "react"
import styles from "./demo.module.css"
import { Logo } from "@/components/Logo"

const SIGN_IN_URL = "https://system-eta-azure.vercel.app/login"
const SIGN_UP_URL = "https://system-eta-azure.vercel.app/signup"

const LINKS = [
  { key: "home", label: "Overview", href: "/demo" },
  { key: "how", label: "How it works", href: "/demo/how-it-works" },
  { key: "demo", label: "Demo", href: "/demo/live" },
  { key: "docs", label: "Docs", href: "/demo/docs" },
  { key: "pricing", label: "Pricing", href: "/demo/pricing" },
] as const

export type SiteNavPage = (typeof LINKS)[number]["key"]

export function SiteNav({ current }: { current: SiteNavPage }) {
  const [open, setOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const burgerRef = useRef<HTMLButtonElement>(null)

  // While the menu is open: Escape closes it (focus goes back to the burger), and so does a tap outside.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        burgerRef.current?.focus()
      }
    }
    const onPointer = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPointer)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPointer)
    }
  }, [open])

  // Rotating a tablet or widening the window to the desktop layout: reset the menu.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 861px)")
    const onChange = () => {
      if (mq.matches) setOpen(false)
    }
    mq.addEventListener?.("change", onChange)
    return () => mq.removeEventListener?.("change", onChange)
  }, [])

  const linkClass = `${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`

  return (
    <nav ref={navRef} className={`${styles.siteNav} ${styles.siteNavBar}`} aria-label="Main">
      <div className={`${styles.siteNavInner} ${styles.siteNavInnerBar}`}>
        <div className={styles.siteNavLeft}>
          <a className={styles.siteNavBrand} href="/demo">
            <Logo size={40} />
            zozoQ
          </a>
          <div
            id="site-nav-menu"
            className={`${styles.siteNavActions} ${styles.siteNavLinksLeft} ${open ? styles.siteNavOpen : ""}`}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) setOpen(false)
            }}
          >
            {LINKS.filter((l) => !(current === "home" && l.key === "home")).map((l) => (
              <a key={l.key} className={linkClass} href={l.href} aria-current={l.key === current ? "page" : undefined}>
                {l.label}
              </a>
            ))}
            {/* Phones only: Sign in lives in the menu so the bar stays short */}
            <a className={`${linkClass} ${styles.siteNavMenuOnly}`} href={SIGN_IN_URL}>
              Sign in
            </a>
          </div>
        </div>
        <div className={`${styles.siteNavActions} ${styles.siteNavRight}`}>
          <a className={`${linkClass} ${styles.siteNavDesktopOnly}`} href={SIGN_IN_URL}>
            Sign in
          </a>
          <a className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} href={SIGN_UP_URL}>
            Try for free
          </a>
          <button
            ref={burgerRef}
            type="button"
            className={styles.siteNavBurger}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="site-nav-menu"
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
    </nav>
  )
}
