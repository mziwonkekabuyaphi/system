"use client"

// app/demo/DisplayDemo.tsx
//
// An auto-playing mock of the waiting-area TV (/display/[slug]) for the landing page, the
// counterpart to ChatDemo, KioskDemo and DashboardDemo. It is a demo, not the real screen: the
// shop, names and numbers are made up. It follows app/display/[slug]/DisplayScreen.tsx (rotating
// slides) and BoardScreen.tsx (live board), and the admin tab in DisplayPanels.tsx.
//
// The switches under the TV are the real admin switches (Settings > Display): layout, theme,
// which screens show, and which queue details show. Flip one and the TV changes straight away,
// so a visitor sees exactly what "the admin chooses what the TV shows" means.
//
// The shop, wording, services and colours follow the chosen industry (industries.ts and
// IndustryContext.tsx). Like KioskDemo, it only moves while on screen, never for visitors who
// prefer reduced motion (they get the "Next screen" / "Call next" buttons), and it hands over to
// the next industry at the end of a full run. No <p>/<h*> tags are used inside the TV on purpose,
// so the landing page's global heading/paragraph styles can't leak into it.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import styles from "./displayDemo.module.css"
import { useIndustry } from "./IndustryContext"
import type { Industry, IndustryId } from "./industries"

type Layout = "rotation" | "board"
type Theme = "dark" | "light"
type Screen = "menu" | "bookings" | "queue"
type Slide = "welcome" | Screen
type Details = { service: boolean; phone: boolean; surname: boolean; email: boolean; custom: boolean; wait: boolean; waited: boolean }

const SCREEN_ORDER: Screen[] = ["menu", "bookings", "queue"]
const BOARD_TICKS = 5

// ---------------------------------------------------------------------------
// EXAMPLE DATA (everything made up)
// ---------------------------------------------------------------------------

type Terms = { menu: string; bookings: string; queue: string; serving: string; waiting: string }
type ShopDisplay = {
  tagline: string
  /** Every shop words its own TV: these are the "Local terms" in the admin. */
  terms: Terms
  menu: Array<[name: string, price: number]>
  /** Start times are all after 09:40, the demo clock's starting time. */
  bookings: Array<[time: string, name: string, service: string]>
}

const DISPLAY: Record<IndustryId, ShopDisplay> = {
  barber: {
    tagline: "Walk-ins welcome",
    terms: { menu: "Price list", bookings: "Booked today", queue: "Live queue", serving: "Now serving", waiting: "Waiting" },
    menu: [["Haircut", 120], ["Beard trim", 60], ["Haircut + beard", 160], ["Kids cut", 90], ["Hot towel shave", 110]],
    bookings: [["10:00", "Sipho M.", "Haircut"], ["10:30", "Thando K.", "Haircut + beard"], ["11:15", "Lwazi N.", "Beard trim"], ["12:00", "Pieter L.", "Kids cut"]],
  },
  beauty: {
    tagline: "Treat yourself",
    terms: { menu: "Treatments", bookings: "Today’s bookings", queue: "Walk-ins", serving: "With us now", waiting: "Waiting" },
    menu: [["Gel set", 280], ["Brow tint", 90], ["Manicure", 150], ["Lashes", 350], ["Pedicure", 220]],
    bookings: [["10:00", "Zinhle D.", "Gel set"], ["10:30", "Ayanda T.", "Lashes"], ["11:30", "Thandi N.", "Manicure"], ["12:00", "Karabo S.", "Brow tint"]],
  },
  clinic: {
    tagline: "Care close to home",
    terms: { menu: "Our services", bookings: "Appointments", queue: "Waiting room", serving: "Now seeing", waiting: "Waiting" },
    menu: [["Consultation", 450], ["Blood pressure", 90], ["Vaccination", 220], ["Repeat script", 160], ["Wellness screen", 380]],
    bookings: [["10:00", "Lindiwe M.", "Consultation"], ["10:20", "Peter W.", "Vaccination"], ["10:45", "Busi K.", "Blood pressure"], ["11:15", "Themba S.", "Repeat script"]],
  },
  workshop: {
    tagline: "Drop in or book in",
    terms: { menu: "Price list", bookings: "Booked in", queue: "Drop-ins", serving: "On the ramp", waiting: "Next in line" },
    menu: [["Tyre repair", 150], ["Wheel alignment", 320], ["Full service", 1850], ["Battery check", 80], ["Brake inspection", 250]],
    bookings: [["10:00", "Pieter L.", "Full service"], ["10:30", "Sandile M.", "Wheel alignment"], ["11:30", "Anele D.", "Battery check"], ["12:00", "Hennie B.", "Brake inspection"]],
  },
  vet: {
    tagline: "Same-day visits welcome",
    terms: { menu: "Our services", bookings: "Today’s appointments", queue: "Walk-ins", serving: "In consult", waiting: "Waiting" },
    menu: [["Check-up", 380], ["Vaccination", 290], ["Dental clean", 950], ["Sick pet", 420], ["Microchip", 250]],
    bookings: [["10:00", "Lize V.", "Check-up"], ["10:30", "Sizwe N.", "Vaccination"], ["11:00", "Marelize P.", "Dental clean"], ["11:45", "Tumi R.", "Microchip"]],
  },
  retail: {
    tagline: "Shop, collect, return",
    terms: { menu: "Services", bookings: "Booked today", queue: "At the till", serving: "Now serving", waiting: "Waiting" },
    menu: [["Personal styling", 150], ["Alterations", 120], ["Wardrobe consult", 350], ["Gift wrapping", 40], ["Garment steaming", 60]],
    bookings: [["10:00", "Thandeka M.", "Personal styling"], ["10:30", "Lindo B.", "Alterations"], ["11:30", "Cathy W.", "Wardrobe consult"], ["12:15", "Sbu N.", "Gift wrapping"]],
  },
  events: {
    tagline: "Welcome to the show",
    terms: { menu: "Sessions", bookings: "Booked sessions", queue: "Check-in queue", serving: "At the desk", waiting: "Waiting" },
    menu: [["Workshop seat", 150], ["Venue tour", 80], ["VIP lounge", 300], ["Photo booth", 60], ["Meet & greet", 200]],
    bookings: [["10:00", "Kagiso L.", "Venue tour"], ["10:30", "Amahle Z.", "Workshop seat"], ["11:00", "Dylan P.", "VIP lounge"], ["12:00", "Naomi F.", "Meet & greet"]],
  },
  restaurant: {
    tagline: "Your table is nearly ready",
    terms: { menu: "Table deposits", bookings: "Reservations", queue: "Waiting list", serving: "Seating now", waiting: "Next up" },
    menu: [["Table for 2", 100], ["Table for 4", 200], ["Large group (6+)", 400], ["Chef’s tasting", 320], ["Sunday lunch", 220]],
    bookings: [["10:00", "Nomsa D.", "Table for 4"], ["10:30", "Chris V.", "Table for 2"], ["11:00", "Fatima S.", "Large group (6+)"], ["11:30", "Jabu M.", "Table for 2"]],
  },
  pharmacy: {
    tagline: "Open late, here to help",
    terms: { menu: "Our services", bookings: "Booked today", queue: "Waiting", serving: "Now serving", waiting: "Next up" },
    menu: [["Flu vaccine", 180], ["Health check", 120], ["Pharmacist consult", 150], ["Blood sugar test", 60], ["Blood pressure", 50]],
    bookings: [["10:00", "Fatima S.", "Flu vaccine"], ["10:20", "Mpho T.", "Health check"], ["11:00", "Alan K.", "Pharmacist consult"], ["11:40", "Zodwa N.", "Blood sugar test"]],
  },
}

/** Phones and emails are always partly hidden on the real TV; the full values never reach it. */
const PEOPLE: Array<[first: string, surname: string, phone: string]> = [
  ["Sipho", "Mokoena", "082 *** **21"],
  ["Aiden", "Kruger", "071 *** **84"],
  ["Naledi", "Pillay", "083 *** **07"],
  ["Jaco", "Venter", "084 *** **56"],
  ["Zinhle", "Dube", "072 *** **39"],
  ["Mandla", "Radebe", "082 *** **90"],
  ["Ayanda", "Tshabalala", "076 *** **12"],
  ["Riaan", "Botha", "081 *** **45"],
  ["Lerato", "Naidoo", "079 *** **63"],
  ["Kabelo", "Sithole", "073 *** **28"],
]
const EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.com"]

/** Each shop's own kiosk question, and what customers typed. Shown exactly as typed on the real TV. */
const CUSTOM: Record<IndustryId, { label: string; answers: [string, string, string] }> = {
  barber: { label: "Preferred barber", answers: ["Thabo", "Lerato", "Any barber"] },
  beauty: { label: "Preferred therapist", answers: ["Sisipho", "Any therapist", "Naledi"] },
  clinic: { label: "Visit type", answers: ["First visit", "Follow-up", "Check-up"] },
  workshop: { label: "Car registration", answers: ["CA 123-456", "CY 88 421", "CJ 55 902"] },
  vet: { label: "Pet’s name", answers: ["Rex", "Bella", "Milo"] },
  retail: { label: "Order number", answers: ["#48213", "#48307", "#48360"] },
  events: { label: "Ticket type", answers: ["General", "VIP", "Speaker"] },
  restaurant: { label: "Occasion", answers: ["Birthday", "Anniversary", "Business lunch"] },
  pharmacy: { label: "Collection code", answers: ["C-4821", "C-4833", "C-4850"] },
}
const REFS = ["K7Q2XM", "P4N8RC", "T9W3HD", "M2X7BL", "V6J5QE"]

// ---------------------------------------------------------------------------
// A tiny fake queue that ticks along (the demo clock is just minutes since midnight)
// ---------------------------------------------------------------------------

const START_MIN = 9 * 60 + 40
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}
const ticketLabel = (n: number) => `A${String(n).padStart(3, "0")}`
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`)

type Entry = {
  n: number
  first: string
  surname: string
  phone: string
  email: string
  custom: string
  service: string
  walkIn: boolean
  ref: string
  at: number
}
type Sim = { id: IndustryId; serving: Entry; waiting: Entry[]; next: number; clock: number }

function makeEntry(x: Industry, n: number, at: number): Entry {
  const [first, surname, phone] = PEOPLE[n % PEOPLE.length]
  const email = `${first[0].toLowerCase()}***@${EMAIL_DOMAINS[n % EMAIL_DOMAINS.length]}`
  const custom = CUSTOM[x.id].answers[n % 3]
  return { n, first, surname, phone, email, custom, service: x.services[n % x.services.length], walkIn: n % 3 !== 1, ref: REFS[n % REFS.length], at }
}

function initialSim(x: Industry): Sim {
  const base = parseInt(x.ticket.slice(1), 10) || 10
  return {
    id: x.id,
    serving: makeEntry(x, base - 3, START_MIN - 6),
    waiting: [base - 2, base - 1, base, base + 1].map((n, i) => makeEntry(x, n, START_MIN - [16, 12, 8, 5][i])),
    next: base + 2,
    clock: START_MIN,
  }
}

/** "Call next": the first person in line is served, everyone moves up, someone new joins. */
function tickSim(x: Industry, s: Sim): Sim {
  const clock = s.clock + 3
  return {
    id: x.id,
    serving: { ...s.waiting[0], at: clock },
    waiting: [...s.waiting.slice(1), makeEntry(x, s.next, clock)],
    next: s.next + 1,
    clock,
  }
}

type Tone = "calm" | "warn" | "hot"
const waitingTone = (m: number): Tone => (m >= 30 ? "hot" : m >= 15 ? "warn" : "calm")

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const

export function DisplayDemo() {
  const { industry: x, advance } = useIndustry()
  const data = DISPLAY[x.id]
  const t = data.terms

  const [layout, setLayout] = useState<Layout>("rotation")
  const [theme, setTheme] = useState<Theme>("dark")
  const [show, setShow] = useState<Record<Screen, boolean>>({ menu: true, bookings: true, queue: true })
  const [det, setDet] = useState<Details>({ service: true, phone: false, surname: true, email: false, custom: false, wait: true, waited: true })
  const [step, setStep] = useState(0)
  // Surname off = first name only, like the real TV (where the surname is never sent at all).
  const who = (e: Entry) => (det.surname ? `${e.first} ${e.surname}` : e.first)
  const customLabel = CUSTOM[x.id].label
  const [ticks, setTicks] = useState(0)
  const [sim, setSim] = useState<Sim>(() => initialSim(x))
  const [onScreen, setOnScreen] = useState(false)
  const [reduced, setReduced] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastIndustry = useRef(x.id)

  // The sim is rebuilt for a new industry in an effect; until then, render a fresh one so a
  // barber's queue never shows up under a clinic's colours for even a frame.
  const view = sim.id === x.id ? sim : initialSim(x)

  const seq: Slide[] = ["welcome", ...SCREEN_ORDER.filter((k) => show[k])]
  const seqLen = seq.length
  const idx = step % seqLen
  const current: Slide | "board" = layout === "board" ? "board" : seq[idx]

  const reset = useCallback((ind: Industry) => {
    setSim(initialSim(ind))
    setStep(0)
    setTicks(0)
  }, [])

  // A new industry always starts again from the top (but not on first render).
  useEffect(() => {
    if (lastIndustry.current === x.id) return
    lastIndustry.current = x.id
    reset(x)
  }, [x, reset])

  // Only run while visible, and never for reduced motion.
  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const playing = onScreen && !reduced

  useEffect(() => {
    if (!playing) return
    const ms = layout === "board" ? 3400 : seqLen === 1 ? 5000 : current === "welcome" ? 2600 : current === "queue" ? 4400 : 3200
    const id = setTimeout(() => {
      if (layout === "board") {
        if (ticks + 1 >= BOARD_TICKS) {
          // A full run just finished: hand over to the next industry (a no-op once the visitor has picked one).
          advance()
          reset(x)
        } else {
          setSim((prev) => tickSim(x, prev.id === x.id ? prev : initialSim(x)))
          setTicks(ticks + 1)
        }
      } else if (idx + 1 >= seqLen) {
        advance()
        reset(x)
      } else {
        setStep(idx + 1)
      }
    }, ms)
    return () => clearTimeout(id)
  }, [playing, layout, step, ticks, seqLen, idx, current, x, advance, reset])

  function toggleScreen(k: Screen) {
    const next = { ...show, [k]: !show[k] }
    setShow(next)
    // Switching a screen ON jumps straight to it, so the change is visible immediately.
    if (!show[k] && layout === "rotation") setStep(["welcome", ...SCREEN_ORDER.filter((s) => next[s])].indexOf(k))
  }
  function chooseLayout(l: Layout) {
    setLayout(l)
    setStep(0)
    setTicks(0)
  }
  const callNext = () => setSim((prev) => tickSim(x, prev.id === x.id ? prev : initialSim(x)))

  // Brand colours as CSS variables; without them the stylesheet falls back to the site's navy and amber.
  const b = x.brand
  const vars = (
    b
      ? {
          "--d-a": theme === "dark" ? b.accent : b.main,
          "--d-s": b.accentDeep,
          "--d-t": b.main,
          "--d-ts": b.accentDeep,
        }
      : {}
  ) as CSSProperties

  const per = Math.max(5, Math.round(x.waitMin / x.position / 5) * 5)
  const nothingOn = !show.menu && !show.bookings && !show.queue
  const badge = (walkIn: boolean) => (walkIn ? "Walk-in" : "Booking")
  const brandInitial = x.initial

  // ---- rotating slides ------------------------------------------------------

  function renderQueueRow(e: Entry, i: number, serving: boolean) {
    const waited = view.clock - e.at
    return (
      <tr key={e.n} className={serving ? `${styles.dRow} ${styles.dRowCalled}` : styles.dRow}>
        <td className={styles.dLead}>{ticketLabel(e.n)}</td>
        <td className={styles.dName}>{who(e)}</td>
        {det.service && <td className={styles.dMuted}>{e.service}</td>}
        {det.phone && <td className={styles.dMuted}>{e.phone}</td>}
        {det.email && <td className={styles.dMuted}>{e.email}</td>}
        {det.custom && <td className={styles.dMuted}>{e.custom}</td>}
        {det.wait && <td className={styles.dNum}>{serving ? "—" : i === 0 ? "Next up" : `~${mins(i * per)}`}</td>}
        {det.waited && <td className={styles.dNum}>{serving ? "—" : waited < 1 ? "Just now" : mins(waited)}</td>}
      </tr>
    )
  }

  function renderSlide(key: Slide) {
    if (key === "welcome") {
      return (
        <div key="welcome" className={`${styles.dSlide} ${styles.dWelcome}`}>
          <span className={styles.dGlow} aria-hidden="true" />
          <span className={styles.dMono}>{brandInitial}</span>
          <span className={styles.dBrand}>{x.shop}</span>
          <span className={styles.dTagline}>{data.tagline}</span>
        </div>
      )
    }
    if (key === "menu") {
      return (
        <div key="menu" className={styles.dSlide}>
          <span className={styles.dCorner}>{x.shop}</span>
          <span className={styles.dTitle}>{t.menu}</span>
          <div className={styles.dMenu}>
            {data.menu.map(([name, price]) => (
              <div key={name} className={styles.dMenuRow}>
                <span className={styles.dMenuName}>{name}</span>
                <span className={styles.dLeader} aria-hidden="true" />
                <span className={styles.dMenuPrice}>R{price}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    if (key === "bookings") {
      return (
        <div key="bookings" className={styles.dSlide}>
          <span className={styles.dCorner}>{x.shop}</span>
          <span className={styles.dTitle}>{t.bookings}</span>
          <div className={styles.dMenu}>
            {data.bookings.map(([time, name, service]) => (
              <div key={time} className={styles.dBookRow}>
                <span className={styles.dBookTime}>{time}</span>
                <span className={styles.dBookName}>{name}</span>
                <span className={styles.dLeader} aria-hidden="true" />
                <span className={styles.dBookSvc}>{service}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    const cols = 2 + [det.service, det.phone, det.email, det.custom, det.wait, det.waited].filter(Boolean).length
    return (
      <div key="queue" className={styles.dSlide}>
        <span className={styles.dCorner}>{x.shop}</span>
        <span className={styles.dTitle}>{t.queue}</span>
        <table className={styles.dTable}>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Name</th>
              {det.service && <th>Service</th>}
              {det.phone && <th>Phone</th>}
              {det.email && <th>Email</th>}
              {det.custom && <th>{customLabel}</th>}
              {det.wait && <th className={styles.dNum}>Est. wait</th>}
              {det.waited && <th className={styles.dNum}>Waited</th>}
            </tr>
          </thead>
          <tbody>
            <tr className={`${styles.dGroup} ${styles.dGroupServing}`}>
              <td colSpan={cols}>{t.serving}</td>
            </tr>
            {renderQueueRow(view.serving, 0, true)}
            <tr className={styles.dGroup}>
              <td colSpan={cols}>Up next</td>
            </tr>
            {view.waiting.map((e, i) => renderQueueRow(e, i, false))}
          </tbody>
        </table>
      </div>
    )
  }

  // ---- live board -----------------------------------------------------------

  function queueTicket(e: Entry, i: number, serving: boolean) {
    const m = view.clock - e.at
    const tone: Tone = serving ? "calm" : waitingTone(m)
    const showEst = !serving && det.wait
    return (
      <div key={e.n} className={serving ? `${styles.bTicket} ${styles.bServing}` : styles.bTicket}>
        <span className={styles.bClip} />
        <span className={styles.bTop}>
          <span className={styles.bNum}>{ticketLabel(e.n)}</span>
          <span className={styles.bBadge}>{badge(e.walkIn)}</span>
        </span>
        <span className={styles.bCustomer}>
          {who(e)}
          {det.phone && <span className={styles.bSub}> · {e.phone}</span>}
        </span>
        {det.service && <span className={styles.bItem}>{e.service}</span>}
        {det.email && <span className={styles.bItem}>{e.email}</span>}
        {det.custom && (
          <span className={styles.bItem}>
            {customLabel}: {e.custom}
          </span>
        )}
        {(det.waited || showEst) && (
          <span className={styles.bFoot}>
            {det.waited ? (
              <span className={`${styles.bChip} ${styles[`tone_${tone}`]}`}>
                {serving ? (m < 1 ? "Just called" : `Serving ${mins(m)}`) : m < 1 ? "Just joined" : `Waiting ${mins(m)}`}
              </span>
            ) : (
              <span />
            )}
            {showEst && <span className={styles.bAction}>{i === 0 ? "Next up" : `Est. ~${mins(i * per)}`}</span>}
          </span>
        )}
      </div>
    )
  }

  function bookingTicket([time, name, service]: [string, string, string]) {
    const until = toMin(time) - view.clock
    return (
      <div key={time} className={styles.bTicket}>
        <span className={styles.bClip} />
        <span className={styles.bTop}>
          <span className={styles.bNum}>{time}</span>
          <span className={styles.bBadge}>Booking</span>
        </span>
        <span className={styles.bCustomer}>{name}</span>
        <span className={styles.bItem}>{service}</span>
        <span className={styles.bFoot}>
          <span className={`${styles.bChip} ${styles[`tone_${until <= 15 ? "warn" : "calm"}`]}`}>
            {until <= 0 ? "Starting now" : `In ${mins(until)}`}
          </span>
          <span />
        </span>
      </div>
    )
  }

  function renderBoard() {
    const cols = (show.queue ? 2 : 0) + (show.bookings ? 1 : 0)
    return (
      <div key="board" className={styles.bStage}>
        <div className={styles.bHead}>
          <span className={styles.bBrand}>
            <span className={styles.bLogo}>{brandInitial}</span>
            <span className={styles.bBrandText}>
              <span className={styles.bEyebrow}>{data.tagline}</span>
              <span className={styles.bTitle}>{x.shop}</span>
            </span>
          </span>
          <span className={styles.bRight}>
            <span className={styles.bPill}>
              <span className={styles.bDot} />
              Live
            </span>
            <span className={styles.bClock}>
              <span className={styles.bTime}>{hhmm(view.clock)}</span>
              <span className={styles.bDate}>{x.chat.day}</span>
            </span>
          </span>
        </div>

        {cols === 0 ? (
          <div className={styles.bBlank}>
            <span className={styles.bBlankName}>{x.shop}</span>
            <span className={styles.bBlankTag}>{data.tagline}</span>
          </div>
        ) : (
          <div className={styles.bBoard} style={{ "--cols": cols } as CSSProperties}>
            {show.queue && (
              <>
                <div className={styles.bCol}>
                  <div className={styles.bColHead}>
                    <span className={styles.bColTitle}>{t.waiting}</span>
                    <span className={styles.bCount}>{view.waiting.length}</span>
                  </div>
                  <div className={styles.bRail}>{view.waiting.map((e, i) => queueTicket(e, i, false))}</div>
                </div>
                <div className={`${styles.bCol} ${styles.bColServing}`}>
                  <div className={styles.bColHead}>
                    <span className={styles.bColTitle}>{t.serving}</span>
                    <span className={styles.bCount}>1</span>
                  </div>
                  <div className={styles.bRail}>{queueTicket(view.serving, 0, true)}</div>
                </div>
              </>
            )}
            {show.bookings && (
              <div className={styles.bCol}>
                <div className={styles.bColHead}>
                  <span className={styles.bColTitle}>{t.bookings}</span>
                  <span className={styles.bCount}>{data.bookings.length}</span>
                </div>
                <div className={styles.bRail}>{data.bookings.map(bookingTicket)}</div>
              </div>
            )}
          </div>
        )}

        {show.menu && (
          <div className={styles.bFooter}>
            <span className={styles.bFooterLabel}>{t.menu}</span>
            <span className={styles.bTickerWrap}>
              <span className={styles.bTicker}>
                {data.menu.map(([name, price]) => (
                  <span key={name}>
                    {name} <b>R{price}</b>
                  </span>
                ))}
              </span>
            </span>
          </div>
        )}
      </div>
    )
  }

  // ---- page chrome ----------------------------------------------------------

  const screenRows: Array<{ id: Screen; title: string; text: string }> = [
    { id: "menu", title: "Menu", text: "Your bookable services and prices." },
    { id: "bookings", title: "Upcoming bookings", text: "Confirmed appointments coming up next." },
    { id: "queue", title: "Live queue", text: "Who’s being served now and who’s waiting." },
  ]
  const detailRows: Array<{ id: keyof Details; title: string; text: string }> = [
    { id: "service", title: "Service", text: "Turn this off if you don’t want services shown here." },
    { id: "phone", title: "Cellphone number", text: "Always masked. The full number never reaches the TV. Off by default, because this screen is public." },
    { id: "surname", title: "Surname", text: "Show the surname after the first name. Off shows first names only: the surname is then never sent to the TV." },
    { id: "email", title: "Email address", text: "Always partly hidden (m***@gmail.com). Only for customers who gave an email at the kiosk. Off by default, because this screen is public." },
    { id: "custom", title: "Custom question answer", text: "The answer to your own kiosk question, shown as typed. Everyone in the waiting area can read it, so only turn it on if that’s fine." },
    { id: "wait", title: "Estimated wait time", text: "How much longer each waiting customer is likely to wait." },
    { id: "waited", title: "Time waited so far", text: "How long each customer has already been in the queue." },
  ]

  return (
    <div ref={rootRef} className={styles.dLayout}>
      <div className={styles.tv}>
        <div
          className={theme === "light" ? `${styles.dScreen} ${styles.dLight}` : styles.dScreen}
          style={vars}
          role="img"
          aria-label={`Example waiting-area TV for ${x.shop}`}
        >
          <div key={`${x.id}-${layout}-${current}`} className={styles.dFade}>
            {layout === "board" ? renderBoard() : renderSlide(current as Slide)}
          </div>
          <span className={styles.dGlare} aria-hidden="true" />
          {layout === "rotation" && seqLen > 1 && (
            <div className={styles.dDots} aria-hidden="true">
              {seq.map((k, i) => (
                <span key={k} className={i === idx ? `${styles.dDot} ${styles.dDotOn}` : styles.dDot} />
              ))}
            </div>
          )}
        </div>
        <span className={styles.tvLed} aria-hidden="true" />
      </div>

      <div className={styles.dActions}>
        {layout === "rotation" ? (
          <button type="button" className={styles.dBtn} onClick={() => setStep(idx + 1)}>
            Next screen
            <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        ) : (
          <button type="button" className={styles.dBtn} onClick={callNext}>
            Call next customer
            <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        )}
        {nothingOn && (
          <span className={styles.dHint} role="status">
            Everything is switched off, so the TV just shows your name.
          </span>
        )}
      </div>

      <div className={styles.dAdminHead}>
        <span className={styles.dAdminTag}>In your dashboard · Settings › Display</span>
        <span className={styles.dAdminLine}>You choose what the TV shows. Flip a switch and watch it change.</span>
      </div>

      <div className={styles.dAdmin}>
        <div className={styles.dCard}>
          <span className={styles.dCardTitle}>Layout &amp; look</span>
          <span className={styles.dCardSub}>How the TV is arranged and what it looks like.</span>

          <span className={styles.dGroupLabel}>Layout</span>
          <div className={styles.dOpts} role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === "rotation"} className={styles.dOpt} onClick={() => chooseLayout("rotation")}>
              <span className={styles.dOptTitle}>Rotating slides</span>
              <span className={styles.dOptText}>One big screen at a time. Best for a glance from across the room.</span>
            </button>
            <button type="button" aria-pressed={layout === "board"} className={styles.dOpt} onClick={() => chooseLayout("board")}>
              <span className={styles.dOptTitle}>Live board</span>
              <span className={styles.dOptText}>Everything at once, as ticket columns, with your menu scrolling along the bottom.</span>
            </button>
          </div>

          <span className={styles.dGroupLabel}>Colour theme</span>
          <div className={styles.dOpts} role="group" aria-label="Colour theme">
            <button type="button" aria-pressed={theme === "dark"} className={styles.dOpt} onClick={() => setTheme("dark")}>
              <span className={styles.dOptTitle}>
                <i className={styles.dSwatch} style={{ background: "#15110d" }} />
                Dark
              </span>
              <span className={styles.dOptText}>Easy on the eyes in dim rooms.</span>
            </button>
            <button type="button" aria-pressed={theme === "light"} className={styles.dOpt} onClick={() => setTheme("light")}>
              <span className={styles.dOptTitle}>
                <i className={styles.dSwatch} style={{ background: "#faf8f5" }} />
                Light
              </span>
              <span className={styles.dOptText}>Suits bright, airy spaces.</span>
            </button>
          </div>
        </div>

        <div className={styles.dCard}>
          <span className={styles.dCardTitle}>Screens to show</span>
          <span className={styles.dCardSub}>A screen with nothing to show is skipped automatically.</span>
          {screenRows.map((r) => (
            <div key={r.id} className={styles.dToggle}>
              <span className={styles.dToggleText}>
                <span className={styles.dToggleTitle}>
                  {r.title}
                  {layout === "rotation" && current === r.id && <span className={styles.dNow}>On screen</span>}
                </span>
                <span className={styles.dToggleDesc}>{r.text}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={show[r.id]}
                aria-label={r.title}
                className={styles.dSwitch}
                onClick={() => toggleScreen(r.id)}
              />
            </div>
          ))}
        </div>

        <div className={styles.dCard}>
          <span className={styles.dCardTitle}>Queue ticket details</span>
          <span className={styles.dCardSub}>What shows next to each customer’s name.</span>
          {detailRows.map((r) => (
            <div key={r.id} className={styles.dToggle}>
              <span className={styles.dToggleText}>
                <span className={styles.dToggleTitle}>{r.title}</span>
                <span className={styles.dToggleDesc}>{r.text}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={det[r.id]}
                aria-label={r.title}
                className={styles.dSwitch}
                onClick={() => setDet({ ...det, [r.id]: !det[r.id] })}
              />
            </div>
          ))}
        </div>
      </div>

      <p className={styles.dFine}>
        An example screen. The shop, names and numbers are made up. On a real TV the welcome slide shows once, when the screen
        first starts, and every heading and label is yours to reword.
      </p>
    </div>
  )
}
