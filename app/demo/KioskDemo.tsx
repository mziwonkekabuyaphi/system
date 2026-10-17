"use client"

// app/demo/KioskDemo.tsx
//
// An auto-playing mock of the self-serve kiosk for the landing page, the counterpart to
// ChatDemo (WhatsApp) so the page shows BOTH ways a customer gets in. It is a demo, not
// the real kiosk: the shop, name and numbers are made up. The screens and their wording
// follow components/kiosk/KioskApp.tsx and the defaults in app/kiosk/[slug]/page.tsx
// (welcome -> choice -> service -> details -> ticket), shown for the walk-in "Join the queue" path.
// The shop, wording, services and colours come from the chosen industry (see industries.ts and
// IndustryContext.tsx), so the demo reads as a barbershop, a clinic, a tyre centre and so on.
//
// It only advances while it is on screen, and not at all for visitors who prefer reduced
// motion (they can still step through with the tabs). Clicking a tab stops the autoplay.
// No <p>/<h*> tags are used inside the tablet on purpose, so the landing page's global
// heading/paragraph styles can't leak into it.

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react"
import styles from "./demo.module.css"
import { useIndustry } from "./IndustryContext"
import type { Industry } from "./industries"

export type KioskStep = "welcome" | "choice" | "service" | "details" | "ticket"

export const KIOSK_STEPS: Array<{ id: KioskStep; tab: string; caption: string }> = [
  {
    id: "welcome",
    tab: "1. Walk up",
    caption: "A tablet by your door, in your name, logo and colours. One tap and the customer is on their way.",
  },
  {
    id: "choice",
    tab: "2. Book or queue",
    caption: "Offer a booking, the walk-in queue, or both. You can reword every button to suit your business.",
  },
  {
    id: "service",
    tab: "3. Pick a service",
    caption: "Big, simple buttons. You can let customers tick more than one service for a combo.",
  },
  {
    id: "details",
    tab: "4. Name and number",
    caption: "Just a name and a phone number. If your shop is on WhatsApp, customers can opt in to updates about their visit.",
  },
  {
    id: "ticket",
    tab: "5. Take a ticket",
    caption: "A ticket with their number, place in line and estimated wait. It lands on your Live Queue board tagged “Kiosk”, then the tablet resets for the next person.",
  },
]

const STEP_MS = 3200

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const

// ---------------------------------------------------------------------------
// Screens (all spans/divs: see the note at the top)
// ---------------------------------------------------------------------------

function Welcome({ x }: { x: Industry }) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kLogo}>{x.initial}</span>
      <span className={styles.kShop}>{x.shop}</span>
      <span className={`${styles.kTapLine} ${styles.kTarget}`}>Tap anywhere to check in</span>
    </div>
  )
}

function Choice({ x }: { x: Industry }) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>{x.choiceTitle}</span>
      <div className={styles.kTiles}>
        <div className={`${styles.kTile} ${styles.kTileBook}`}>
          <svg className={styles.kTileIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M4 10h16M8 3v4M16 3v4" />
          </svg>
          <span className={styles.kTileTitle}>{x.bookTitle}</span>
          <span className={styles.kTileSub}>{x.bookSub}</span>
        </div>
        <div className={`${styles.kTile} ${styles.kTileQueue} ${styles.kTarget}`}>
          <svg className={styles.kTileIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
          </svg>
          <span className={styles.kTileTitle}>{x.queueTitle}</span>
          <span className={styles.kTileSub}>{x.queueSub}</span>
        </div>
      </div>
    </div>
  )
}

function Service({ x }: { x: Industry }) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>{x.serviceTitle}</span>
      <div className={styles.kServices}>
        {x.services.map((s) => (
          <span
            key={s}
            className={s === x.picked ? `${styles.kService} ${styles.kServiceOn} ${styles.kTarget}` : styles.kService}
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  )
}

function Details({ x }: { x: Industry }) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>Almost done — who are we booking for?</span>
      <div className={styles.kForm}>
        <span className={styles.kField}>
          <span className={styles.kFieldLabel}>Your name</span>
          <span className={styles.kFieldBox}>{x.customer}</span>
        </span>
        <span className={styles.kField}>
          <span className={styles.kFieldLabel}>Phone number</span>
          <span className={styles.kFieldBox}>{x.phone}</span>
        </span>
        <span className={styles.kOptIn}>
          <span className={styles.kCheck}>✓</span>
          Send me WhatsApp updates about my visit
        </span>
        <span className={`${styles.kConfirm} ${styles.kTarget}`}>Confirm</span>
      </div>
    </div>
  )
}

function Ticket({ x }: { x: Industry }) {
  return (
    <div className={styles.kScreen}>
      <div className={styles.kStub}>
        <div className={styles.kStubTop}>
          <span className={styles.kEyebrow}>Your place in line</span>
          <span className={styles.kNumber}>{x.ticket}</span>
        </div>
        <div className={styles.kPerf} aria-hidden="true" />
        <div className={styles.kStubBottom}>
          <span className={styles.kRow}>
            <span>Name</span>
            <strong>{x.customer}</strong>
          </span>
          <span className={styles.kRow}>
            <span>Service</span>
            <strong>{x.picked}</strong>
          </span>
          <span className={styles.kRow}>
            <span>Position</span>
            <strong>{x.position}</strong>
          </span>
          <span className={styles.kRow}>
            <span>Est. wait</span>
            <strong>{`${x.waitMin} min`}</strong>
          </span>
        </div>
      </div>
      <span className={`${styles.kDone} ${styles.kTarget}`}>Done</span>
    </div>
  )
}

const SCREENS: Record<KioskStep, (props: { x: Industry }) => ReactElement> = {
  welcome: Welcome,
  choice: Choice,
  service: Service,
  details: Details,
  ticket: Ticket,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KioskDemo({ initialStep = 0 }: { initialStep?: number }) {
  const [index, setIndex] = useState(Math.min(Math.max(initialStep, 0), KIOSK_STEPS.length - 1))
  const [auto, setAuto] = useState(true)
  const [onScreen, setOnScreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { industry, advance } = useIndustry()
  const indexRef = useRef(index)
  indexRef.current = index
  const lastIndustry = useRef(industry.id)

  // A new industry always starts again from the welcome screen (but not on first render).
  useEffect(() => {
    if (lastIndustry.current === industry.id) return
    lastIndustry.current = industry.id
    setIndex(0)
  }, [industry.id])

  // Only run while visible.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!auto || !onScreen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = setInterval(() => {
      const next = (indexRef.current + 1) % KIOSK_STEPS.length
      // A full run just finished: hand over to the next industry (a no-op once the visitor has picked one).
      if (next === 0) advance()
      setIndex(next)
    }, STEP_MS)
    return () => clearInterval(timer)
  }, [auto, onScreen, advance])

  const current = KIOSK_STEPS[index]
  const Screen = SCREENS[current.id]
  const b = industry.brand
  // Brand colours as CSS variables; without them the stylesheet falls back to the site's navy and amber.
  const brandVars = b
    ? ({
        "--k-main": b.main,
        "--k-main-deep": b.mainDeep,
        "--k-accent": b.accent,
        "--k-accent-deep": b.accentDeep,
        "--k-on-accent": b.onAccent,
      } as CSSProperties)
    : undefined

  return (
    <div ref={rootRef} className={styles.kioskLayout}>
      <div className={styles.tablet}>
        <div className={styles.tabletScreen} style={brandVars}>
          <div key={`${industry.id}-${current.id}`} className={styles.kFade}>
            <Screen x={industry} />
          </div>
        </div>
      </div>
      <div className={styles.kioskSide}>
        <div className={styles.kioskTabs} role="tablist" aria-label="Kiosk screens">
          {KIOSK_STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              className={i === index ? `${styles.demoTab} ${styles.demoTabActive}` : styles.demoTab}
              onClick={() => {
                setIndex(i)
                setAuto(false)
              }}
            >
              {s.tab}
            </button>
          ))}
        </div>
        <p className={styles.kioskCaption}>{current.caption}</p>
        {!auto && (
          <button type="button" className={styles.kioskResume} onClick={() => setAuto(true)}>
            Play automatically
          </button>
        )}
        <p className={styles.kioskFine}>An example kiosk. The shop, name and numbers are made up.</p>
      </div>
    </div>
  )
}
