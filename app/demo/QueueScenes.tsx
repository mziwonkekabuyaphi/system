"use client"

// app/demo/QueueScenes.tsx
//
// Landing-page hero preview. It rotates through four different businesses, each with its own
// live queue: a barbershop (walk-ins + WhatsApp), a clinic (mostly bookings), a tyre centre
// (bookings + walk-ins) and a restaurant (table waitlist). Every ~1.7s something happens on the
// board: someone joins (via WhatsApp, the kiosk or a booking) or the next ticket is called.
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
  "Sipho M.", "Naledi P.", "Jaco V.", "Zinhle D.", "Mandla R.", "Ayanda T.", "Riaan B.", "Lerato N.",
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

function Board({ s, active, still }: { s: Scenario; active: boolean; still: boolean }) {
  const tick = useTick(active && !still, EVENT_MS)
  const b = board(s, still ? 0 : tick)
  const longest = b.waiting.length ? b.waiting[b.waiting.length - 1].mins : 0

  return (
    <div className={styles.board}>
      <div className={styles.screen}>
        <div className={styles.bar}>
          <span className={styles.logo}>{s.initial}</span>
          <span className={styles.shop}>{s.shop}</span>
          <span className={styles.tag}>{s.tag}</span>
          <span className={styles.live}>
            <span className={styles.liveDot} aria-hidden="true" />
            Live
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
              <Board s={s} active={on && running} still={reduced} />
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
