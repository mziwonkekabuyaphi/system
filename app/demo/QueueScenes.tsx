"use client"

// app/demo/QueueScenes.tsx
//
// Landing-page hero preview. It rotates through nine different businesses (the same nine as the
// /demo/live page: barbershop, beauty & nails, clinic, tyre centre, vet, retail, events,
// restaurant, pharmacy), each with its own live queue. Every ~1.7s something happens on the
// board: someone joins (via WhatsApp, the kiosk or a booking) or the next ticket is called.
// Next to each TV there is an iPhone-style phone playing a short WhatsApp chat for that business
// (join the queue, get a ticket, get called), the same look as the phone on /demo/live.
// To add another business, add one more object to SCENARIOS below; the tabs follow automatically.
//
// Self-contained: it does NOT use IndustryContext, so the landing page needs no provider.
// (The live page keeps using HeroRotator.)
//
// Like HeroRotator it only runs while on screen, pauses on hover / focus, and shows a still
// frame for visitors who prefer reduced motion. No <p>/<h*> tags on purpose: the landing hero
// has global `.heroMain p` / heading styles.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import styles from "./queueScenes.module.css"

type Source = "whatsapp" | "kiosk" | "booked"

type Scenario = {
  id: string
  tab: string
  shop: string
  initial: string
  tag: string // small label in the header bar
  prefix: string // ticket letter
  start: number // ticket number being served at the start
  counter: string // "Chair 2", "Room 3" ...
  details: string[] // what each customer is here for
  sources: Source[] // cycles through these as customers arrive
  perMin: number // minutes per place in line
  servedBase: number // "served today" at the start
  seed: number // offsets the names so each scenario looks different
  main: string
  accent: string
  onAccent: string
}

const NAMES = [
  "Sipho M.", "Mzonke B.", "Jaco V.", "Zinhle D.", "Mandla R.", "Ayanda T.", "Riaan B.", "Lerato N.",
  "Thabo K.", "Chantel F.", "Pieter S.", "Nomsa G.", "Keagan A.", "Fatima H.", "Bongani L.", "Elmarie W.",
]

const SCENARIOS: Scenario[] = [
  {
    id: "barber",
    tab: "Barbershop",
    shop: "Mzansi Cuts",
    initial: "M",
    tag: "Walk-ins + WhatsApp",
    prefix: "B",
    start: 14,
    counter: "Chair 2",
    details: ["Fade", "Haircut & beard", "Kids cut", "Line-up", "Shave"],
    sources: ["kiosk", "whatsapp", "kiosk", "whatsapp", "booked"],
    perMin: 7,
    servedBase: 12,
    seed: 0,
    main: "#14325c",
    accent: "#f5a524",
    onAccent: "#0b1c36",
  },
  {
    id: "beauty",
    tab: "Beauty & nails",
    shop: "Cape Town’s Beauty Studio",
    initial: "C",
    tag: "Walk-ins + bookings",
    prefix: "N",
    start: 12,
    counter: "Station 2",
    details: ["Gel set", "Brow tint", "Manicure", "Lashes", "Pedicure"],
    sources: ["booked", "whatsapp", "kiosk", "booked", "whatsapp"],
    perMin: 12,
    servedBase: 9,
    seed: 2,
    main: "#7a2e62",
    accent: "#f2b6cf",
    onAccent: "#3e1630",
  },
  {
    id: "clinic",
    tab: "Clinic",
    shop: "Greenpoint Family Clinic",
    initial: "G",
    tag: "Booked + walk-in",
    prefix: "C",
    start: 31,
    counter: "Room 3",
    details: ["Check-up", "Flu shot", "Blood pressure", "Repeat prescription", "Wound dressing"],
    sources: ["booked", "booked", "whatsapp", "booked", "kiosk"],
    perMin: 10,
    servedBase: 24,
    seed: 5,
    main: "#0f766e",
    accent: "#fbbf24",
    onAccent: "#10312e",
  },
  {
    id: "tyres",
    tab: "Tyre centre",
    shop: "QuickFit Tyres",
    initial: "Q",
    tag: "Bays + bookings",
    prefix: "T",
    start: 52,
    counter: "Bay 1",
    details: ["Tyre change", "Wheel alignment", "Puncture repair", "Balancing", "Tyre check"],
    sources: ["whatsapp", "booked", "kiosk", "booked", "whatsapp"],
    perMin: 14,
    servedBase: 19,
    seed: 9,
    main: "#374151",
    accent: "#f97316",
    onAccent: "#1f1306",
  },
  {
    id: "vet",
    tab: "Vet",
    shop: "Hillcrest Vet Clinic",
    initial: "H",
    tag: "Same-day, no booking",
    prefix: "V",
    start: 22,
    counter: "Room 2",
    details: ["Check-up", "Vaccination", "Dental clean", "Sick pet", "Nail trim"],
    sources: ["kiosk", "kiosk", "whatsapp", "booked", "kiosk"],
    perMin: 12,
    servedBase: 16,
    seed: 4,
    main: "#2e6b3f",
    accent: "#f2c14e",
    onAccent: "#2a1f05",
  },
  {
    id: "retail",
    tab: "Retail",
    shop: "Bree Street Boutique",
    initial: "B",
    tag: "Collect + styling",
    prefix: "S",
    start: 40,
    counter: "Till 1",
    details: ["Click & collect", "Returns", "Personal styling", "Alterations", "Gift wrap"],
    sources: ["whatsapp", "kiosk", "whatsapp", "booked", "kiosk"],
    perMin: 6,
    servedBase: 27,
    seed: 7,
    main: "#3d3a8c",
    accent: "#d7f25a",
    onAccent: "#1c2a00",
  },
  {
    id: "events",
    tab: "Events",
    shop: "Table Bay Events Hub",
    initial: "T",
    tag: "Check-in + VIP",
    prefix: "E",
    start: 88,
    counter: "Desk 3",
    details: ["Registration", "Ticket collection", "Workshop", "VIP lounge", "Badge pickup"],
    sources: ["booked", "kiosk", "booked", "whatsapp", "booked"],
    perMin: 3,
    servedBase: 112,
    seed: 11,
    main: "#0d5c8c",
    accent: "#ffb703",
    onAccent: "#2b1f00",
  },
  {
    id: "restaurant",
    tab: "Restaurant",
    shop: "Braai & Co.",
    initial: "B",
    tag: "Table waitlist",
    prefix: "R",
    start: 7,
    counter: "Table 12",
    details: ["Party of 2", "Party of 4", "Party of 3", "Party of 6", "Party of 2"],
    sources: ["kiosk", "whatsapp", "booked", "whatsapp", "kiosk"],
    perMin: 8,
    servedBase: 31,
    seed: 3,
    main: "#7c2d12",
    accent: "#facc15",
    onAccent: "#2a1a05",
  },
  {
    id: "pharmacy",
    tab: "Pharmacy",
    shop: "Sunrise Pharmacy",
    initial: "S",
    tag: "Scripts + advice",
    prefix: "P",
    start: 63,
    counter: "Counter 2",
    details: ["Collect a script", "Flu vaccine", "Health check", "Ask the pharmacist", "Repeat script"],
    sources: ["kiosk", "whatsapp", "kiosk", "booked", "whatsapp"],
    perMin: 5,
    servedBase: 41,
    seed: 13,
    main: "#b3261e",
    accent: "#ffd9d4",
    onAccent: "#4a0f0a",
  },
]

const SOURCE_LABEL: Record<Source, string> = { whatsapp: "WhatsApp", kiosk: "Kiosk", booked: "Booked" }
const SOURCE_CLASS: Record<Source, string> = {
  whatsapp: styles.srcWhatsapp,
  kiosk: styles.srcKiosk,
  booked: styles.srcBooked,
}

const ROTATE_MS = 8000
const EVENT_MS = 1700
const ticketLabel = (s: Scenario, i: number) => `${s.prefix}${String(s.start + i).padStart(3, "0")}`

/** The i-th customer to arrive at this shop (0 = the one being served at the start). */
function customer(s: Scenario, i: number) {
  return {
    ticket: ticketLabel(s, i),
    name: NAMES[(i + s.seed) % NAMES.length],
    detail: s.details[(i + s.seed) % s.details.length],
    source: s.sources[i % s.sources.length],
  }
}

/**
 * The board after `t` events. Odd events: someone joins. Even events: the next ticket is called.
 * Closed-form so there is no state to keep in sync; the line stays 4-5 people long.
 */
function board(s: Scenario, t: number) {
  const serving = Math.floor(t / 2)
  const arrived = 5 + Math.ceil(t / 2) // customers 0..arrived-1 have shown up
  const waiting = []
  for (let i = serving + 1; i < arrived; i++) waiting.push({ ...customer(s, i), mins: (i - serving) * s.perMin })

  const log: Array<{ key: number; text: string; source?: Source }> = []
  for (let k = t; k >= Math.max(1, t - 2); k--) {
    if (k % 2 === 1) {
      const c = customer(s, 5 + (k - 1) / 2)
      log.push({ key: k, text: `${c.name} joined`, source: c.source })
    } else {
      const c = customer(s, k / 2)
      log.push({ key: k, text: `${c.ticket} called to ${s.counter}` })
    }
  }
  return { now: customer(s, serving), waiting, log, served: s.servedBase + serving }
}

/** Counts events while `active`; starts again from 0 each time the slide comes back. */
function useTick(active: boolean, ms: number) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    setTick(0)
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return tick
}

function scenarioVars(s: Scenario): CSSProperties {
  return { "--qs-main": s.main, "--qs-accent": s.accent, "--qs-on-accent": s.onAccent } as CSSProperties
}

// ---------------------------------------------------------------------------
// The phone: a short WhatsApp chat that goes with each TV
// ---------------------------------------------------------------------------

type Msg = { from: "me" | "bot"; text: string; chips?: string[] }

/** The first customer after the opening line-up who joins by WhatsApp, so the phone and the TV agree. */
function chatCustomer(s: Scenario) {
  for (let i = 5; i < 5 + s.sources.length; i++) {
    const c = customer(s, i)
    if (c.source === "whatsapp") return c
  }
  return customer(s, 5)
}

function chatScript(s: Scenario): Msg[] {
  const c = chatCustomer(s)
  const first = c.name.split(" ")[0]
  const options = [c.detail, ...s.details.filter((d) => d !== c.detail)]
    .filter((d, i, all) => all.indexOf(d) === i)
    .slice(0, 3)
  const ahead = 4
  return [
    { from: "me", text: "Hi" },
    { from: "bot", text: `Hi ${first}! 👋 Welcome to ${s.shop}. What would you like to do?`, chips: ["Join the queue", "Book a time"] },
    { from: "me", text: "Join the queue" },
    { from: "bot", text: "What do you need today?", chips: options },
    { from: "me", text: c.detail },
    { from: "bot", text: `You’re in line! 🎟️\nTicket ${c.ticket} · ${c.detail}\n${ahead} ahead of you, about ${ahead * s.perMin} min` },
    { from: "bot", text: `You’re next! 🔔 Please head to ${s.counter}.` },
  ]
}

function Phone({ s, active, still }: { s: Scenario; active: boolean; still: boolean }) {
  const tick = useTick(active && !still, 1000) // one message a second, so the ticket shows well inside the 8s slide
  const msgs = chatScript(s)
  const shown = still ? msgs.length : Math.min(msgs.length, tick + 1)

  return (
    <div className={styles.phone} aria-hidden="true">
      <div className={styles.phoneScreen}>
        <div className={styles.phoneHead}>
          <span className={styles.phoneAvatar}>{s.initial}</span>
          <span className={styles.phoneName}>
            <b>{s.shop}</b>
            <i>WhatsApp Business</i>
          </span>
        </div>
        <div className={styles.phoneBody}>
          {msgs.slice(0, shown).map((m, i) => (
            <span key={i} className={m.from === "me" ? styles.rowMe : styles.rowBot}>
              <span className={m.from === "me" ? `${styles.bubble} ${styles.bubbleMe}` : `${styles.bubble} ${styles.bubbleBot}`}>{m.text}</span>
              {m.chips && (
                <span className={styles.chips}>
                  {m.chips.map((chip) => (
                    <span key={chip} className={styles.chip}>
                      {chip}
                    </span>
                  ))}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function Board({ s, active, still }: { s: Scenario; active: boolean; still: boolean }) {
  const tick = useTick(active && !still, EVENT_MS)
  const b = board(s, still ? 0 : tick)
  const longest = b.waiting.length ? b.waiting[b.waiting.length - 1].mins : 0
  const mins = 14 * 60 + 32 + Math.floor((still ? 0 : tick) / 2)
  const clock = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`

  return (
    <div className={styles.tvWrap}>
    <div className={styles.board}>
      <div className={styles.screen}>
        <span className={styles.glare} aria-hidden="true" />
        <div className={styles.bar}>
          <span className={styles.logo}>{s.initial}</span>
          <span className={styles.shop}>{s.shop}</span>
          <span className={styles.tag}>{s.tag}</span>
          <span className={styles.live}>
            <span className={styles.liveDot} aria-hidden="true" />
            Live
          </span>
          <span className={styles.clock} aria-hidden="true">
            <svg viewBox="0 0 20 14" width="15" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M2 5.2a11 11 0 0 1 16 0M5 8.4a6.6 6.6 0 0 1 10 0" /><circle cx="10" cy="11.6" r="1.2" fill="currentColor" stroke="none" />
            </svg>
            {clock}
          </span>
        </div>

        <div className={styles.body}>
          <div className={styles.left}>
            <div className={styles.now} key={b.now.ticket}>
              <span className={styles.label}>Now serving</span>
              <span className={styles.big}>{b.now.ticket}</span>
              <span className={styles.who}>{b.now.name}</span>
              <span className={styles.counter}>{s.counter} · {b.now.detail}</span>
            </div>
            <div className={styles.stats}>
              <span className={styles.stat}>
                <b>{b.waiting.length}</b>
                in line
              </span>
              <span className={styles.stat}>
                <b>~{longest}m</b>
                longest wait
              </span>
              <span className={styles.stat}>
                <b>{b.served}</b>
                served today
              </span>
            </div>
          </div>

          <div className={styles.right}>
            <span className={styles.label}>Up next</span>
            <div className={styles.rows}>
              {b.waiting.map((w, i) => (
                <span key={w.ticket} className={styles.row}>
                  <b>{w.ticket}</b>
                  <span className={styles.rowMain}>
                    <span>{w.name}</span>
                    <i>{w.detail}</i>
                  </span>
                  <span className={`${styles.src} ${SOURCE_CLASS[w.source]}`}>{SOURCE_LABEL[w.source]}</span>
                  <em>{i === 0 ? "next" : `~${w.mins} min`}</em>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.feed}>
          {b.log.length === 0 && <span className={styles.feedItem}>Waiting for the next customer…</span>}
          {b.log.map((l, i) => (
            <span key={l.key} className={i === 0 ? `${styles.feedItem} ${styles.feedNew}` : styles.feedItem}>
              {l.source && <span className={`${styles.feedDot} ${SOURCE_CLASS[l.source]}`} aria-hidden="true" />}
              {l.text}
              {l.source && ` via ${SOURCE_LABEL[l.source]}`}
            </span>
          ))}
        </div>
      </div>
      <span className={styles.led} aria-hidden="true" />
    </div>
    <div className={styles.stand} aria-hidden="true">
      <span className={styles.neck} />
      <span className={styles.foot} />
    </div>
    </div>
  )
}

export function QueueScenes() {
  const [slide, setSlide] = useState(0)
  const [epoch, setEpoch] = useState(0) // bumped to restart the timer and progress bar
  const [onScreen, setOnScreen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.("change", onChange)
    return () => mq.removeEventListener?.("change", onChange)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === "undefined") {
      setOnScreen(true)
      return
    }
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const running = onScreen && !paused && !reduced

  useEffect(() => {
    if (running) setEpoch((e) => e + 1)
  }, [running])

  useEffect(() => {
    if (!running) return
    const timer = setTimeout(() => setSlide((s) => (s + 1) % SCENARIOS.length), ROTATE_MS)
    return () => clearTimeout(timer)
  }, [running, slide, epoch])

  function go(i: number) {
    setSlide((i + SCENARIOS.length) % SCENARIOS.length)
    setEpoch((e) => e + 1)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") go(slide + 1)
    else if (e.key === "ArrowLeft") go(slide - 1)
    else return
    e.preventDefault()
  }

  const current = SCENARIOS[slide]

  return (
    <div
      ref={rootRef}
      className={running ? styles.rot : `${styles.rot} ${styles.rotIdle}`}
      style={{ ...scenarioVars(current), "--qs-ms": `${ROTATE_MS}ms` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={styles.stage}>
        {SCENARIOS.map((s, i) => {
          const on = i === slide
          return (
            <div
              key={s.id}
              id={`qs-slide-${s.id}`}
              role="tabpanel"
              aria-labelledby={`qs-tab-${s.id}`}
              aria-hidden={!on}
              className={on ? `${styles.slide} ${styles.slideOn}` : styles.slide}
              style={scenarioVars(s)}
            >
              <div className={styles.deck}>
                <Board s={s} active={on && running} still={reduced} />
                <Phone s={s} active={on && running} still={reduced} />
              </div>
            </div>
          )
        })}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Queues for different businesses" onKeyDown={onKeyDown}>
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            id={`qs-tab-${s.id}`}
            type="button"
            role="tab"
            aria-selected={i === slide}
            aria-controls={`qs-slide-${s.id}`}
            tabIndex={i === slide ? 0 : -1}
            className={i === slide ? `${styles.tab} ${styles.tabOn}` : styles.tab}
            onClick={() => go(i)}
          >
            {s.tab}
            {i === slide && <span key={epoch} className={styles.tabBar} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  )
}
