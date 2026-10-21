"use client"

// app/demo/HeroRotator.tsx
//
// The hero's preview: instead of one dashboard, it rotates through the four things a shop
// actually puts in front of people:
//   1. the live dashboard     (your real <DashboardDemo compact />)
//   2. the waiting-room TV    (light theme)
//   3. the kiosk
//   4. WhatsApp
// The TV, kiosk and WhatsApp slides are short, lean previews (the full, playable versions
// are DisplayDemo / KioskDemo / ChatDemo further down the page). Shop name, services,
// tickets and colours come from industries.ts, and the dashboard slide gets the same shop
// name and service names, so all four slides show one consistent example shop.
//
// Industries: by default (standalone) the hero runs its OWN <IndustryProvider> and moves to
// the next industry after every INDUSTRY_EVERY slides, so a visitor sees barbers, a clinic,
// a restaurant, and so on, without scrolling.
// Pass standalone={false} to share the page's <IndustryProvider> instead, so the hero follows
// the page's IndustryPicker. A shared hero still rotates the industry on its own (the provider
// stops that as soon as the visitor picks one) unless you also pass rotateIndustry={false}.
//
// It only moves while on screen, pauses on hover / keyboard focus, and never auto-plays for
// visitors who prefer reduced motion (they get still frames and the tab buttons).
// No <p>/<h*> tags are used on purpose: the hero has global `.heroMain p` / heading styles.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import styles from "./heroRotator.module.css"
import { DashboardDemo } from "./DashboardDemo"
import { IndustryProvider, useIndustry } from "./IndustryContext"
import type { Industry } from "./industries"

type SlideId = "dashboard" | "tv" | "kiosk" | "whatsapp"

const SLIDES: Array<{ id: SlideId; tab: string }> = [
  { id: "dashboard", tab: "Dashboard" },
  { id: "tv", tab: "Waiting-room TV" },
  { id: "kiosk", tab: "Kiosk" },
  { id: "whatsapp", tab: "WhatsApp" },
]

const ROTATE_MS = 8000
/** Slides shown per industry before the next industry comes up (4 = one full lap). Use 1 to change shop on every slide. */
const INDUSTRY_EVERY = 4
const NAMES = ["Sipho M.", "Naledi P.", "Jaco V.", "Zinhle D.", "Mandla R.", "Ayanda T.", "Riaan B.", "Lerato N."]

function brandVars(x: Industry): CSSProperties {
  const b = x.brand
  return {
    "--hr-main": b?.main ?? "var(--qless-navy, #14325c)",
    "--hr-deep": b?.mainDeep ?? "var(--qless-navy-deep, #0b1c36)",
    "--hr-accent": b?.accent ?? "var(--qless-amber, #f5a524)",
    "--hr-on-accent": b?.onAccent ?? "#0b1c36",
  } as CSSProperties
}

/** "A016" -> { prefix: "A", n: 16 } */
function ticketParts(ticket: string) {
  return { prefix: ticket.match(/^[A-Za-z]+/)?.[0] ?? "A", n: parseInt(ticket.replace(/\D/g, ""), 10) || 10 }
}
const ticketLabel = (prefix: string, n: number) => `${prefix}${String(n).padStart(3, "0")}`

/** Counts up while `active`; frozen at 0 otherwise. */
function useTick(active: boolean, ms: number) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return tick
}

// ---------------------------------------------------------------------------
// 2. Waiting-room TV (light theme)
// ---------------------------------------------------------------------------

const TV_SCREENS = ["queue", "queue", "menu", "bookings"] as const

function TvPreview({ x, active, still }: { x: Industry; active: boolean; still: boolean }) {
  const tick = useTick(active && !still, 2800)
  const screen = still ? "queue" : TV_SCREENS[tick % TV_SCREENS.length]
  const { prefix, n } = ticketParts(x.ticket)
  const serving = n + (still ? 0 : Math.floor(tick / TV_SCREENS.length))
  const waiting = [1, 2, 3, 4].map((i) => ({
    ticket: ticketLabel(prefix, serving + i),
    name: NAMES[(serving + i) % NAMES.length],
    service: x.services[(serving + i) % x.services.length],
    mins: i * Math.max(5, Math.round(x.waitMin / 4)),
  }))

  return (
    <div className={styles.tv}>
      <div className={styles.tvScreen}>
        <div className={styles.tvBar}>
          <span className={styles.tvLogo}>{x.initial}</span>
          <span className={styles.tvShop}>{x.shop}</span>
          <span className={styles.tvTag}>
            {screen === "queue" ? "Live queue" : screen === "menu" ? "Price list" : "Booked today"}
          </span>
        </div>
        <div className={styles.tvBody} key={screen}>
          {screen === "queue" && (
            <>
              <div className={styles.tvNow}>
                <span className={styles.tvLabel}>Now serving</span>
                <span className={styles.tvBig}>{ticketLabel(prefix, serving)}</span>
                <span className={styles.tvWho}>{NAMES[serving % NAMES.length]}</span>
              </div>
              <div className={styles.tvList}>
                <span className={styles.tvLabel}>Waiting</span>
                {waiting.map((w) => (
                  <span key={w.ticket} className={styles.tvRow}>
                    <b>{w.ticket}</b>
                    <span>{w.name}</span>
                    <i>{w.service}</i>
                    <em>~{w.mins} min</em>
                  </span>
                ))}
              </div>
            </>
          )}
          {screen === "menu" && (
            <div className={`${styles.tvList} ${styles.tvWide}`}>
              {x.chat.menu.map((m) => (
                <span key={m.name} className={styles.tvPrice}>
                  <span>{m.name}</span>
                  <b>R{m.price}</b>
                </span>
              ))}
            </div>
          )}
          {screen === "bookings" && (
            <div className={`${styles.tvList} ${styles.tvWide}`}>
              {x.chat.times.slice(0, 3).map((t, i) => (
                <span key={t} className={styles.tvPrice}>
                  <b>{t}</b>
                  <span>
                    {NAMES[(i + 2) % NAMES.length]} · {x.services[i % x.services.length]}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Kiosk
// ---------------------------------------------------------------------------

const KIOSK_STEPS = ["welcome", "choice", "service", "ticket"] as const

function KioskPreview({ x, active, still }: { x: Industry; active: boolean; still: boolean }) {
  const tick = useTick(active && !still, 2300)
  const step = still ? "choice" : KIOSK_STEPS[tick % KIOSK_STEPS.length]

  return (
    <div className={styles.kiosk}>
      <div className={styles.kioskScreen} key={step}>
        {step === "welcome" && (
          <div className={styles.kCenter}>
            <span className={styles.kLogo}>{x.initial}</span>
            <span className={styles.kShop}>{x.shop}</span>
            <span className={styles.kTap}>Tap anywhere to check in</span>
          </div>
        )}
        {step === "choice" && (
          <>
            <span className={styles.kTitle}>{x.choiceTitle}</span>
            <div className={styles.kTiles}>
              <span className={`${styles.kTile} ${styles.kTileA}`}>
                <b>{x.bookTitle}</b>
                <span>{x.bookSub}</span>
              </span>
              <span className={`${styles.kTile} ${styles.kTileB} ${styles.kTapped}`}>
                <b>{x.queueTitle}</b>
                <span>{x.queueSub}</span>
              </span>
            </div>
          </>
        )}
        {step === "service" && (
          <>
            <span className={styles.kTitle}>{x.serviceTitle}</span>
            <div className={styles.kGrid}>
              {x.services.map((s) => (
                <span key={s} className={s === x.picked ? `${styles.kChoice} ${styles.kTapped}` : styles.kChoice}>
                  {s}
                </span>
              ))}
            </div>
          </>
        )}
        {step === "ticket" && (
          <div className={styles.kCenter}>
            <span className={styles.kEyebrow}>Your place in line</span>
            <span className={styles.kNumber}>{x.ticket}</span>
            <span className={styles.kFacts}>
              {x.customer} · {x.picked}
            </span>
            <span className={styles.kFacts}>
              Position {x.position} · about {x.waitMin} min
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. WhatsApp
// ---------------------------------------------------------------------------

type Msg = { from: "me" | "bot"; text: string; chips?: string[] }

function script(x: Industry): Msg[] {
  const c = x.chat
  const [a, b, d] = c.menu
  return [
    { from: "me", text: "Hi" },
    { from: "bot", text: `Hi ${c.name}! ${c.emoji} What would you like to do?`, chips: [x.bookTitle, x.queueTitle] },
    { from: "me", text: x.bookTitle },
    { from: "bot", text: `Here’s what we offer:\n1. ${a.name} · R${a.price}\n2. ${b.name} · R${b.price}\n3. ${d.name} · R${d.price}` },
    { from: "me", text: "1" },
    { from: "bot", text: `You’re booked! 🎉\n${a.name} on ${c.day} at ${c.times[2]}\nReference: ${c.ref}` },
  ]
}

function PhonePreview({ x, active, still }: { x: Industry; active: boolean; still: boolean }) {
  const tick = useTick(active && !still, 1500)
  const msgs = script(x)
  // Reveal one message at a time, hold on the last for a moment, then start over.
  const shown = still ? msgs.length : Math.min(msgs.length, (tick % (msgs.length + 3)) + 1)

  return (
    <div className={styles.phone}>
      <div className={styles.phoneScreen}>
        <div className={styles.phoneHead}>
          <span className={styles.phoneAvatar}>{x.initial}</span>
          <span className={styles.phoneName}>
            <b>{x.shop}</b>
            <i>WhatsApp Business</i>
          </span>
        </div>
        <div className={styles.phoneBody}>
          {msgs.slice(0, shown).map((m, i) => (
            <span key={i} className={m.from === "me" ? styles.rowMe : styles.rowBot}>
              <span className={m.from === "me" ? `${styles.bubble} ${styles.bubbleMe}` : `${styles.bubble} ${styles.bubbleBot}`}>{m.text}</span>
              {m.chips && (
                <span className={styles.chips}>
                  {m.chips.map((c) => (
                    <span key={c} className={styles.chip}>
                      {c}
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

// ---------------------------------------------------------------------------
// The rotator
// ---------------------------------------------------------------------------

export function HeroRotator({ standalone = true, rotateIndustry }: { standalone?: boolean; rotateIndustry?: boolean }) {
  const rotate = rotateIndustry ?? true
  if (standalone) {
    return (
      <IndustryProvider>
        <Rotator rotateIndustry={rotate} />
      </IndustryProvider>
    )
  }
  return <Rotator rotateIndustry={rotate} />
}

function Rotator({ rotateIndustry }: { rotateIndustry: boolean }) {
  const { industry, advance } = useIndustry()
  const laps = useRef(0) // auto-advanced slides so far
  const [slide, setSlide] = useState(0)
  const [epoch, setEpoch] = useState(0) // bumped to restart the timer and the progress bar
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
    const timer = setTimeout(() => {
      setSlide((s) => (s + 1) % SLIDES.length)
      laps.current += 1
      if (rotateIndustry && laps.current % INDUSTRY_EVERY === 0) advance()
    }, ROTATE_MS)
    return () => clearTimeout(timer)
  }, [running, slide, epoch, rotateIndustry, advance])

  function go(i: number) {
    setSlide((i + SLIDES.length) % SLIDES.length)
    setEpoch((e) => e + 1)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") go(slide + 1)
    else if (e.key === "ArrowLeft") go(slide - 1)
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={rootRef}
      className={running ? styles.rot : `${styles.rot} ${styles.rotIdle}`}
      style={{ ...brandVars(industry), "--hr-ms": `${ROTATE_MS}ms` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={styles.stage}>
        {SLIDES.map((s, i) => {
          const on = i === slide
          return (
            <div
              key={s.id}
              id={`hero-slide-${s.id}`}
              role="tabpanel"
              aria-labelledby={`hero-tab-${s.id}`}
              aria-hidden={!on}
              className={`${styles.slide} ${on ? styles.slideOn : ""} ${s.id === "dashboard" ? styles.slideWide : ""}`}
            >
              {s.id === "dashboard" && <DashboardDemo compact shop={industry.shop} services={industry.services} />}
              {s.id === "tv" && <TvPreview x={industry} active={on && running} still={reduced} />}
              {s.id === "kiosk" && <KioskPreview x={industry} active={on && running} still={reduced} />}
              {s.id === "whatsapp" && <PhonePreview x={industry} active={on && running} still={reduced} />}
            </div>
          )
        })}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="What your shop gets" onKeyDown={onKeyDown}>
        {SLIDES.map((s, i) => (
          <button
            key={s.id}
            id={`hero-tab-${s.id}`}
            type="button"
            role="tab"
            aria-selected={i === slide}
            aria-controls={`hero-slide-${s.id}`}
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
