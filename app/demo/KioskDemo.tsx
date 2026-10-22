"use client"

// app/demo/KioskDemo.tsx
//
// An auto-playing mock of the self-serve kiosk for the landing page, the counterpart to
// ChatDemo (WhatsApp) so the page shows BOTH ways a customer gets in. It is a demo, not
// the real kiosk: the shop, name and numbers are made up. The screens and their wording
// follow components/kiosk/KioskApp.tsx and the defaults in app/kiosk/[slug]/page.tsx
// (welcome -> choice -> service -> details -> ticket for the walk-in "Join the queue" path,
// welcome -> service -> date -> time -> details -> ticket for a booking-only kiosk).
//
// Under the tablet sits a cut-down copy of the real admin tab (KioskPanels.tsx: Customer
// options, Services, Local terms). Change a setting and the tablet changes with it: pick
// "Queue only" and the choice screen disappears, pick "No services" and the service screen
// goes, type a new heading and the tablet jumps to the screen it appears on.
//
// The shop, wording, services and colours come from the chosen industry (see industries.ts and
// IndustryContext.tsx). It only advances while it is on screen, and not at all for visitors who
// prefer reduced motion (they can still step through with the tabs). Clicking a tab, or typing
// in a field, stops the autoplay; touching a setting also stops industries rotating.
// No <p>/<h*> tags are used inside the tablet on purpose, so the landing page's global
// heading/paragraph styles can't leak into it.

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react"
import styles from "./demo.module.css"
import admin from "./adminDemo.module.css"
import { useIndustry } from "./IndustryContext"
import type { Industry } from "./industries"

export type KioskStep = "welcome" | "choice" | "service" | "date" | "time" | "details" | "ticket"
type Mode = "both" | "booking" | "queue"
type Path = "queue" | "booking"
type WordKey =
  | "tagline"
  | "choiceTitle"
  | "bookTitle"
  | "bookSub"
  | "queueTitle"
  | "queueSub"
  | "serviceTitle"
  | "dateTitle"
  | "timeTitle"
  | "detailsTitle"
  | "ticketBookingEyebrow"
  | "ticketQueueEyebrow"
type Words = Record<WordKey, string>

// Same defaults the real kiosk falls back to (see DEFAULT_* in KioskPanels.tsx).
const DEFAULT_WORDS = {
  tagline: "Tap anywhere to check in",
  dateTitle: "Which day works for you?",
  timeTitle: "Pick a time",
  detailsTitle: "Almost done — who are we booking for?",
  ticketBookingEyebrow: "Your booking",
  ticketQueueEyebrow: "Your place in line",
}

/** What each field shows when left empty: the industry's own wording, else the kiosk default. */
const defaultsFor = (x: Industry): Words => ({
  ...DEFAULT_WORDS,
  choiceTitle: x.choiceTitle,
  bookTitle: x.bookTitle,
  bookSub: x.bookSub,
  queueTitle: x.queueTitle,
  queueSub: x.queueSub,
  serviceTitle: x.serviceTitle,
})

const STEP_INFO: Record<KioskStep, { tab: string; caption: (p: Path) => string }> = {
  welcome: {
    tab: "Walk up",
    caption: () => "A tablet by your door, in your name, logo and colours. One tap and the customer is on their way.",
  },
  choice: {
    tab: "Book or queue",
    caption: () => "Offer a booking, the walk-in queue, or both. You can reword every button to suit your business.",
  },
  service: {
    tab: "Pick a service",
    caption: () => "Big, simple buttons. You can let customers tick more than one service for a combo.",
  },
  date: {
    tab: "Pick a day",
    caption: () => "Booking customers choose a day first. Only days you’re open are offered.",
  },
  time: {
    tab: "Pick a time",
    caption: () => "Then a time. Only real open times are shown, so two customers can’t clash.",
  },
  details: {
    tab: "Name and number",
    caption: () =>
      "Just a name and a phone number. If your shop is on WhatsApp, customers can opt in to updates about their visit.",
  },
  ticket: {
    tab: "Take a ticket",
    caption: (p) =>
      p === "booking"
        ? "A confirmation with their reference, day and time, printed at the kiosk. It lands in Appointments on your dashboard the moment they confirm, then the tablet resets for the next person."
        : "A ticket with their number, place in line and estimated wait, printed at the kiosk. It lands on your Live Queue board tagged “Kiosk”, then the tablet resets for the next person.",
  },
}

/** Which screens a kiosk shows for the chosen settings (bookings always need a service). */
function stepsFor(mode: Mode, hasService: boolean): KioskStep[] {
  const s: KioskStep[] = ["welcome"]
  if (mode === "both") s.push("choice")
  if (hasService) s.push("service")
  if (mode === "booking") s.push("date", "time")
  s.push("details", "ticket")
  return s
}

/** The default flow, kept for anything that still imports it. */
export const KIOSK_STEPS: Array<{ id: KioskStep; tab: string; caption: string }> = stepsFor("both", true).map((id, i) => ({
  id,
  tab: `${i + 1}. ${STEP_INFO[id].tab}`,
  caption: STEP_INFO[id].caption("queue"),
}))

const STEP_MS = 3200

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const

// ---------------------------------------------------------------------------
// Screens (all spans/divs: see the note at the top)
// ---------------------------------------------------------------------------

type ScreenProps = { x: Industry; w: Words; path: Path; hasService: boolean; minutes: number }

function Welcome({ x, w }: ScreenProps) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kLogo}>{x.initial}</span>
      <span className={styles.kShop}>{x.shop}</span>
      <span className={`${styles.kTapLine} ${styles.kTarget}`}>{w.tagline}</span>
    </div>
  )
}

function Choice({ x, w }: ScreenProps) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>{w.choiceTitle}</span>
      <div className={styles.kTiles}>
        <div className={`${styles.kTile} ${styles.kTileBook}`}>
          <svg className={styles.kTileIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M4 10h16M8 3v4M16 3v4" />
          </svg>
          <span className={styles.kTileTitle}>{w.bookTitle}</span>
          <span className={styles.kTileSub}>{w.bookSub}</span>
        </div>
        <div className={`${styles.kTile} ${styles.kTileQueue} ${styles.kTarget}`}>
          <svg className={styles.kTileIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
          </svg>
          <span className={styles.kTileTitle}>{w.queueTitle}</span>
          <span className={styles.kTileSub}>{w.queueSub}</span>
        </div>
      </div>
    </div>
  )
}

function Service({ x, w }: ScreenProps) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>{w.serviceTitle}</span>
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

function DateScreen({ x, w }: ScreenProps) {
  const days = ["Today", "Tomorrow", x.chat.day, "Monday"]
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>{w.dateTitle}</span>
      <div className={styles.kServices}>
        {days.map((d) => (
          <span key={d} className={d === x.chat.day ? `${styles.kService} ${styles.kServiceOn} ${styles.kTarget}` : styles.kService}>
            {d}
          </span>
        ))}
      </div>
    </div>
  )
}

function TimeScreen({ x, w }: ScreenProps) {
  return (
    <div className={styles.kScreen}>
      {/* The real kiosk adds the date to this heading itself. */}
      <span className={styles.kTitle}>{`${w.timeTitle} — ${x.chat.day}`}</span>
      <div className={styles.kServices}>
        {x.chat.times.map((t, i) => (
          <span key={t} className={i === 2 ? `${styles.kService} ${styles.kServiceOn} ${styles.kTarget}` : styles.kService}>
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

function Details({ x, w }: ScreenProps) {
  return (
    <div className={styles.kScreen}>
      <span className={styles.kTitle}>{w.detailsTitle}</span>
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

function Ticket({ x, w, path, hasService, minutes }: ScreenProps) {
  const booking = path === "booking"
  // With no services there is nothing to take a length from, so the wait uses the shop's own minutes per customer.
  const wait = hasService ? x.waitMin : minutes * x.position
  return (
    <div className={styles.kScreen}>
      <div className={styles.kStub}>
        <div className={styles.kStubTop}>
          <span className={styles.kEyebrow}>{booking ? w.ticketBookingEyebrow : w.ticketQueueEyebrow}</span>
          <span className={styles.kNumber}>{booking ? x.chat.ref : x.ticket}</span>
        </div>
        <div className={styles.kPerf} aria-hidden="true" />
        <div className={styles.kStubBottom}>
          <span className={styles.kRow}>
            <span>Name</span>
            <strong>{x.customer}</strong>
          </span>
          {hasService && (
            <span className={styles.kRow}>
              <span>Service</span>
              <strong>{x.picked}</strong>
            </span>
          )}
          {booking ? (
            <>
              <span className={styles.kRow}>
                <span>Day</span>
                <strong>{x.chat.day}</strong>
              </span>
              <span className={styles.kRow}>
                <span>Time</span>
                <strong>{x.chat.times[2]}</strong>
              </span>
            </>
          ) : (
            <>
              <span className={styles.kRow}>
                <span>Position</span>
                <strong>{x.position}</strong>
              </span>
              <span className={styles.kRow}>
                <span>Est. wait</span>
                <strong>{`${wait} min`}</strong>
              </span>
            </>
          )}
        </div>
      </div>
      <span className={`${styles.kDone} ${styles.kTarget}`}>Done</span>
    </div>
  )
}

const SCREENS: Record<KioskStep, (props: ScreenProps) => ReactElement> = {
  welcome: Welcome,
  choice: Choice,
  service: Service,
  date: DateScreen,
  time: TimeScreen,
  details: Details,
  ticket: Ticket,
}

// ---------------------------------------------------------------------------
// Admin options (wording copied from KioskPanels.tsx)
// ---------------------------------------------------------------------------

const MODE_OPTIONS: Array<{ value: Mode; title: string; text: string }> = [
  { value: "both", title: "Booking and Queue", text: "Customers choose between booking a time or joining the walk-in queue." },
  { value: "booking", title: "Booking Only", text: "Customers go straight into picking a date and time. No walk-in option." },
  { value: "queue", title: "Queue Only", text: "Customers go straight into joining the walk-in queue. No booking option." },
]

const SERVICE_OPTIONS: Array<{ value: boolean; title: string; text: string }> = [
  {
    value: true,
    title: "Customers pick a service",
    text: "Each customer chooses what they’re here for. Best when services take different amounts of time.",
  },
  {
    value: false,
    title: "No services — one line",
    text: "Customers skip the service screen and just give their name and number. Everyone joins one shared line.",
  },
]

/** Which kiosk screen each wording field lives on, so editing it can jump the tablet there. */
const FIELD_STEP: Record<WordKey, KioskStep> = {
  tagline: "welcome",
  choiceTitle: "choice",
  bookTitle: "choice",
  bookSub: "choice",
  queueTitle: "choice",
  queueSub: "choice",
  serviceTitle: "service",
  dateTitle: "date",
  timeTitle: "time",
  detailsTitle: "details",
  ticketBookingEyebrow: "ticket",
  ticketQueueEyebrow: "ticket",
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KioskDemo({ initialStep = 0 }: { initialStep?: number }) {
  const { industry, advance, choose } = useIndustry()
  const [mode, setMode] = useState<Mode>("both")
  const [requireService, setRequireService] = useState(true)
  const [minutes, setMinutes] = useState(() => Math.max(1, Math.round(industry.waitMin / industry.position)))
  const [words, setWords] = useState<Partial<Record<WordKey, string>>>({})

  const hasService = requireService || mode === "booking"
  const path: Path = mode === "booking" ? "booking" : "queue"
  const steps = stepsFor(mode, hasService)

  const [index, setIndex] = useState(Math.min(Math.max(initialStep, 0), steps.length - 1))
  const [auto, setAuto] = useState(true)
  const [onScreen, setOnScreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const indexRef = useRef(index)
  indexRef.current = index
  const lenRef = useRef(steps.length)
  lenRef.current = steps.length
  const lastIndustry = useRef(industry.id)

  // A new industry always starts again from the welcome screen, with its own default wording
  // (but not on first render).
  useEffect(() => {
    if (lastIndustry.current === industry.id) return
    lastIndustry.current = industry.id
    setIndex(0)
    setWords({})
    setMinutes(Math.max(1, Math.round(industry.waitMin / industry.position)))
  }, [industry])

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
      const next = (indexRef.current + 1) % lenRef.current
      // A full run just finished: hand over to the next industry (a no-op once the visitor has picked one).
      if (next === 0) advance()
      setIndex(next)
    }, STEP_MS)
    return () => clearInterval(timer)
  }, [auto, onScreen, advance])

  const defaults = defaultsFor(industry)
  // An empty field means "use the default", exactly like the real admin.
  const w = Object.fromEntries(
    (Object.keys(defaults) as WordKey[]).map((k) => [k, words[k]?.trim() || defaults[k]]),
  ) as Words

  const safeIndex = Math.min(index, steps.length - 1)
  const currentId = steps[safeIndex]
  const Screen = SCREENS[currentId]
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

  // ---- admin actions ----
  // Touching any setting means the visitor is exploring, so stop the industries rotating under them.
  function changeMode(m: Mode) {
    choose(industry.id)
    setMode(m)
    setIndex(0)
  }
  function changeServices(v: boolean) {
    choose(industry.id)
    setRequireService(v)
    setIndex(0)
  }
  /** Show the screen a setting belongs to, and stop autoplay so it stays put while they type. */
  function jump(step: KioskStep) {
    choose(industry.id)
    const i = steps.indexOf(step)
    if (i >= 0) {
      setIndex(i)
      setAuto(false)
    }
  }
  function field(key: WordKey, label: string, max: number) {
    return (
      <label className={admin.aField}>
        <span className={admin.aFieldLabel}>{label}</span>
        <input
          className={admin.aInput}
          value={words[key] ?? ""}
          placeholder={defaults[key]}
          maxLength={max}
          onFocus={() => jump(FIELD_STEP[key])}
          onChange={(e) => {
            setWords({ ...words, [key]: e.target.value })
            jump(FIELD_STEP[key])
          }}
        />
        <span className={admin.aHint}>{`Defaults to “${defaults[key]}”.`}</span>
      </label>
    )
  }

  const showsBooking = mode !== "queue"
  const showsQueue = mode !== "booking"
  const bookingNeedsService = mode === "booking" && !requireService

  return (
    <>
      <div ref={rootRef} className={styles.kioskLayout}>
        <div className={styles.tablet}>
          <div className={styles.tabletScreen} style={brandVars}>
            <div key={`${industry.id}-${path}-${currentId}`} className={styles.kFade}>
              <Screen x={industry} w={w} path={path} hasService={hasService} minutes={minutes} />
            </div>
          </div>
        </div>
        <div className={styles.kioskSide}>
          <div className={styles.kioskTabs} role="tablist" aria-label="Kiosk screens">
            {steps.map((id, i) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={i === safeIndex}
                className={i === safeIndex ? `${styles.demoTab} ${styles.demoTabActive}` : styles.demoTab}
                onClick={() => {
                  setIndex(i)
                  setAuto(false)
                }}
              >
                {`${i + 1}. ${STEP_INFO[id].tab}`}
              </button>
            ))}
          </div>
          <p className={styles.kioskCaption}>{STEP_INFO[currentId].caption(path)}</p>
          {!auto && (
            <button type="button" className={styles.kioskResume} onClick={() => setAuto(true)}>
              Play automatically
            </button>
          )}
          <p className={styles.kioskFine}>An example kiosk. The shop, name and numbers are made up.</p>
        </div>
      </div>

      <div className={admin.aHead}>
        <span className={admin.aTag}>In your dashboard · Settings › Kiosk</span>
        <span className={admin.aLine}>You decide what the kiosk offers and what it says. Change a setting and the tablet follows.</span>
      </div>

      <div className={admin.aCols}>
        <div className={admin.aCol}>
          <div className={admin.aCard}>
            <span className={admin.aCardTitle}>Customer options</span>
            <span className={admin.aCardSub}>What customers are allowed to do at the kiosk.</span>
            <div className={`${admin.aOpts} ${admin.aOpts3}`} role="group" aria-label="Customer options">
              {MODE_OPTIONS.map((o) => (
                <button key={o.value} type="button" aria-pressed={mode === o.value} className={admin.aOpt} onClick={() => changeMode(o.value)}>
                  <span className={admin.aOptTitle}>{o.title}</span>
                  <span className={admin.aOptText}>{o.text}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={admin.aCard}>
            <span className={admin.aCardTitle}>Services</span>
            <span className={admin.aCardSub}>Does your shop need customers to choose a service before they join?</span>
            <div className={`${admin.aOpts} ${admin.aOpts2}`} role="group" aria-label="Services">
              {SERVICE_OPTIONS.map((o) => (
                <button
                  key={String(o.value)}
                  type="button"
                  aria-pressed={requireService === o.value}
                  className={admin.aOpt}
                  onClick={() => changeServices(o.value)}
                >
                  <span className={admin.aOptTitle}>{o.title}</span>
                  <span className={admin.aOptText}>{o.text}</span>
                </button>
              ))}
            </div>
            {!requireService && (
              <label className={`${admin.aField} ${admin.aMinutes}`}>
                <span className={admin.aFieldLabel}>Estimated minutes per customer</span>
                <input
                  type="number"
                  min={1}
                  className={admin.aInput}
                  value={Number.isFinite(minutes) ? minutes : ""}
                  onFocus={() => jump("ticket")}
                  onChange={(e) => {
                    setMinutes(Math.max(1, Number(e.target.value) || 1))
                    jump("ticket")
                  }}
                />
                <span className={admin.aHint}>Used to work out wait times when there’s no service to take the length from.</span>
              </label>
            )}
            <p className={bookingNeedsService ? `${admin.aNote} ${admin.aNoteWarn}` : admin.aNote}>
              {bookingNeedsService
                ? "Bookings always need a service, because the available times depend on how long it takes. So this kiosk still asks for one. Pair “No services” with Queue Only."
                : "Bookings always need a service (available times depend on how long it takes), so pair “No services” with Queue Only. This setting also applies to WhatsApp and admin walk-ins."}
            </p>
          </div>
        </div>

        <div className={admin.aCard}>
          <span className={admin.aCardTitle}>Local terms</span>
          <span className={admin.aCardSub}>
            Every piece of text on the kiosk is yours to change, in the order customers see it. Leave a field empty to use the default
            shown in it.
          </span>

          <span className={admin.aGroup}>1 · Welcome screen</span>
          <div className={admin.aFields}>{field("tagline", "Tagline", 80)}</div>

          {mode === "both" && (
            <>
              <span className={admin.aGroup}>2 · Choice screen</span>
              <span className={admin.aGroupHint}>Where customers pick booking or the walk-in queue. Rename these to fit your business.</span>
              <div className={admin.aFields}>{field("choiceTitle", "Screen heading", 80)}</div>
              <div className={`${admin.aFields} ${admin.aPair}`}>
                {field("bookTitle", "Booking card title", 40)}
                {field("bookSub", "Booking card subtitle", 100)}
                {field("queueTitle", "Queue card title", 40)}
                {field("queueSub", "Queue card subtitle", 100)}
              </div>
            </>
          )}

          {hasService && (
            <>
              <span className={admin.aGroup}>Service screen</span>
              <div className={admin.aFields}>{field("serviceTitle", "Screen heading", 80)}</div>
            </>
          )}

          {showsBooking && (
            <>
              <span className={admin.aGroup}>Booking screens</span>
              <span className={admin.aGroupHint}>Only on the booking path. The kiosk adds the day to the time heading itself.</span>
              <div className={`${admin.aFields} ${admin.aPair}`}>
                {field("dateTitle", "Date screen heading", 80)}
                {field("timeTitle", "Time screen heading", 40)}
              </div>
            </>
          )}

          <span className={admin.aGroup}>Details screen</span>
          <div className={admin.aFields}>{field("detailsTitle", "Name & phone screen heading", 80)}</div>

          <span className={admin.aGroup}>Final ticket</span>
          <span className={admin.aGroupHint}>Small label above the ticket number on the last screen.</span>
          <div className={`${admin.aFields} ${admin.aPair}`}>
            {showsBooking && field("ticketBookingEyebrow", "Ticket label — booking", 30)}
            {showsQueue && field("ticketQueueEyebrow", "Ticket label — queue", 30)}
          </div>
        </div>
      </div>
    </>
  )
}
