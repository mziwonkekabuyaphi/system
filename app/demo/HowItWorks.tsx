"use client"

// app/demo/HowItWorks.tsx
//
// The "How it works" section's body: a mockup stage with one scene per step, and the step list
// underneath acting as its controls. Click a step (or its number) to jump to its scene; otherwise
// it advances by itself while on screen, pauses on hover / focus, and never auto-plays for
// visitors who prefer reduced motion.
//
// The five scenes follow the five steps in page.tsx (STEPS), using one example shop
// ("Mzansi Cuts", customer Naledi P.) throughout:
//   1 arrives (WhatsApp or kiosk)  2 checked live  3 confirmed  4 lands on the dashboard
//   5 kept in the loop (WhatsApp heads-up, waitlist)
//
// The step list re-uses the page's own classes (flowSteps / flowStep / flowNum) from
// demo.module.css so it looks exactly as before; the stage styles live in howItWorks.module.css.
// No <p>/<h*> inside the mockup on purpose: the page has global heading styles.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import page from "./demo.module.css"
import m from "./howItWorks.module.css"

type Step = { title: string; text: string }

const STEP_MS = 6500
const SHORT = ["A customer arrives", "Checked live", "Confirmed on the spot", "Lands on your dashboard", "Kept in the loop"]

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Phone({ children, name = "Mzansi Cuts" }: { children: ReactNode; name?: string }) {
  return (
    <div className={m.phone}>
      <div className={m.phoneScreen}>
        <span className={m.notch} aria-hidden="true" />
        <div className={m.status} aria-hidden="true">
          <span>14:31</span>
          <span className={m.statusIcons}>
            <svg viewBox="0 0 18 12" width="15" height="10" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.8" /><rect x="5" y="5" width="3" height="7" rx="0.8" /><rect x="10" y="2.5" width="3" height="9.5" rx="0.8" /><rect x="15" y="0" width="3" height="12" rx="0.8" /></svg>
            <svg viewBox="0 0 26 12" width="22" height="10" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="0.6" y="0.6" width="21" height="10.8" rx="3" /><rect x="2.4" y="2.4" width="14" height="7.2" rx="1.6" fill="currentColor" stroke="none" /><rect x="23" y="4" width="2" height="4" rx="1" fill="currentColor" stroke="none" /></svg>
          </span>
        </div>
        <div className={m.phoneHead}>
          <span className={m.avatar}>M</span>
          <span className={m.phoneName}>
            <b>{name}</b>
            <i>online</i>
          </span>
        </div>
        <div className={m.phoneBody}>{children}</div>
        <span className={m.homeBar} aria-hidden="true" />
      </div>
    </div>
  )
}

function Bubble({ me, d, children }: { me?: boolean; d: number; children: ReactNode }) {
  return (
    <span className={`${m.bubble} ${me ? m.me : m.bot} ${m.seq}`} style={{ "--d": `${d}s` } as CSSProperties}>
      {children}
    </span>
  )
}

function Pane({ cap, wide, children }: { cap: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? `${m.pane} ${m.paneWide}` : m.pane}>
      <div className={m.paneBody}>{children}</div>
      <span className={m.cap}>{cap}</span>
    </div>
  )
}

const delay = (d: number) => ({ "--d": `${d}s` }) as CSSProperties

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function SceneArrive() {
  return (
    <>
      <Pane cap="They message your WhatsApp number or scan the QR code…">
        <Phone>
          <Bubble me d={0.3}>Hi, can I get a fade today?</Bubble>
          <span className={`${m.bubble} ${m.bot} ${m.typing} ${m.seq}`} style={delay(1.1)} aria-hidden="true">
            <i /><i /><i />
          </span>
        </Phone>
      </Pane>
      <Pane cap="…or tap the kiosk as they walk in.">
        <div className={m.kiosk}>
          <div className={`${m.kioskScreen} ${m.center}`}>
            <span className={m.kLogo}>M</span>
            <span className={m.kShop}>Mzansi Cuts</span>
            <span className={m.kTap}>Tap anywhere to check in</span>
          </div>
        </div>
      </Pane>
    </>
  )
}

function SceneCheck() {
  const checks = [
    ["Service", "Fade · 30 min"],
    ["Staff", "Thabo is in until 17:00"],
    ["Hours", "Open today until 18:00"],
    ["Diary", "No clash with Jaco V. at 14:00"],
  ]
  return (
    <>
      <Pane cap="The AI and the kiosk check the same live list.">
        <div className={m.card}>
          <span className={m.cardTitle}>Checking…</span>
          {checks.map(([k, v], i) => (
            <span key={k} className={`${m.check} ${m.seq}`} style={delay(0.3 + i * 0.5)}>
              <span className={m.tick} aria-hidden="true">✓</span>
              <b>{k}</b>
              <span>{v}</span>
            </span>
          ))}
        </div>
      </Pane>
      <Pane cap="So a slot that doesn’t exist is never offered.">
        <div className={m.card}>
          <span className={m.cardTitle}>Today’s slots</span>
          <div className={m.slots}>
            {[
              ["14:00", "taken"],
              ["14:30", "pick"],
              ["15:00", ""],
              ["15:30", ""],
              ["16:00", ""],
              ["16:30", ""],
            ].map(([t, s], i) => (
              <span
                key={t}
                className={`${m.slot} ${s === "taken" ? m.slotTaken : ""} ${s === "pick" ? m.slotPick : ""} ${m.seq}`}
                style={delay(2.3 + i * 0.08)}
              >
                {t}
              </span>
            ))}
          </div>
          <span className={`${m.note} ${m.seq}`} style={delay(2.9)}>14:00 is already booked, so it’s greyed out.</span>
        </div>
      </Pane>
    </>
  )
}

function SceneConfirm() {
  return (
    <>
      <Pane cap="On WhatsApp: a reference and a time.">
        <Phone>
          <Bubble me d={0.1}>14:30 please</Bubble>
          <Bubble d={0.7}>
            {"You’re booked! 🎉\nFade today at 14:30\nReference: ZQ-4821"}
          </Bubble>
        </Phone>
      </Pane>
      <Pane cap="At the kiosk: a ticket with place in line and wait.">
        <div className={m.kiosk}>
          <div className={`${m.kioskScreen} ${m.center}`}>
            <span className={`${m.kEyebrow} ${m.seq}`} style={delay(0.2)}>Your place in line</span>
            <span className={`${m.kNumber} ${m.seq}`} style={delay(0.5)}>B015</span>
            <span className={`${m.kFacts} ${m.seq}`} style={delay(0.9)}>Naledi P. · Fade</span>
            <span className={`${m.kFacts} ${m.seq}`} style={delay(1.1)}>Position 3 · about 20 min</span>
          </div>
        </div>
      </Pane>
    </>
  )
}

function SceneDashboard() {
  const rows: Array<[string, string, string, "whatsapp" | "kiosk" | "booked", string, boolean?]> = [
    ["B014", "Sipho M.", "Fade", "kiosk", "In the chair"],
    ["B015", "Naledi P.", "Fade", "whatsapp", "Waiting", true],
    ["14:30", "Jaco V.", "Beard trim", "booked", "Booked"],
    ["B016", "Zinhle D.", "Kids cut", "kiosk", "Waiting"],
  ]
  const label = { whatsapp: "WhatsApp", kiosk: "Kiosk", booked: "Booked" }
  const cls = { whatsapp: m.srcWhatsapp, kiosk: m.srcKiosk, booked: m.srcBooked }
  return (
    <Pane wide cap="Chats, kiosk check-ins and bookings land on one board, tagged by where they came from.">
      <div className={m.dash}>
        <div className={m.dashBar}>
          <span className={m.dashLogo}>M</span>
          <b>Mzansi Cuts · Today’s board</b>
          <span className={m.live}><span className={m.liveDot} aria-hidden="true" />Live</span>
        </div>
        <div className={m.dashRows}>
          {rows.map(([t, n, s, src, st, fresh], i) => (
            <span key={t} className={`${m.dRow} ${fresh ? m.dNew : ""} ${m.seq}`} style={delay(0.15 + i * 0.12)}>
              <b>{t}</b>
              <span>{n}</span>
              <i>{s}</i>
              <span className={`${m.src} ${cls[src]}`}>{label[src]}</span>
              <em>{st}</em>
            </span>
          ))}
        </div>
        <div className={`${m.dActions} ${m.seq}`} style={delay(0.9)}>
          <span className={m.dBtn}>Call next</span>
          <span className={m.dBtnGhost}>Reschedule</span>
          <span className={m.dBtnGhost}>Open chat</span>
        </div>
      </div>
    </Pane>
  )
}

function SceneLoop() {
  return (
    <>
      <Pane cap="A heads-up when it’s nearly their turn, and a message when it is.">
        <Phone>
          <Bubble d={0.2}>{"Almost your turn, Naledi! ⏳\n2 people ahead of you."}</Bubble>
          <Bubble d={1.2}>{"It’s your turn! 🎉\nPlease come to Chair 2."}</Bubble>
        </Phone>
      </Pane>
      <Pane cap="If the day is full, the waitlist hears the moment a slot opens.">
        <Phone>
          <Bubble d={0.2}>{"Good news, Zinhle! A slot just opened at 15:00 today. Want it?"}</Bubble>
          <span className={`${m.chips} ${m.seq}`} style={delay(0.8)}>
            <span className={m.chip}>Yes, take it</span>
            <span className={m.chip}>No thanks</span>
          </span>
          <Bubble me d={1.5}>Yes, take it</Bubble>
          <Bubble d={2.1}>{"Done, you’re booked for 15:00 ✅"}</Bubble>
        </Phone>
      </Pane>
    </>
  )
}

const SCENES = [SceneArrive, SceneCheck, SceneConfirm, SceneDashboard, SceneLoop]

// ---------------------------------------------------------------------------
// The section body
// ---------------------------------------------------------------------------

export function HowItWorks({ steps }: { steps: Step[] }) {
  const [active, setActive] = useState(0)
  const [epoch, setEpoch] = useState(0) // bumped to restart the timer and the step's progress bar
  const [onScreen, setOnScreen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const count = Math.min(steps.length, SCENES.length)

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
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const running = onScreen && !paused && !reduced

  useEffect(() => {
    if (running) setEpoch((e) => e + 1)
  }, [running])

  useEffect(() => {
    if (!running) return
    const t = setTimeout(() => setActive((a) => (a + 1) % count), STEP_MS)
    return () => clearTimeout(t)
  }, [running, active, epoch, count])

  function go(i: number) {
    setActive(i)
    setEpoch((e) => e + 1)
  }

  return (
    <div
      ref={rootRef}
      className={running ? m.root : `${m.root} ${m.rootIdle}`}
      style={{ "--hw-ms": `${STEP_MS}ms` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={m.stage} role="group" aria-label="Illustration of the selected step">
        <div className={m.stageHead}>
          <span className={m.stageStep}>Step {active + 1} of {count}</span>
          <span className={m.stageTitle}>{SHORT[active]}</span>
        </div>
        <div className={m.scenes}>
          {SCENES.slice(0, count).map((Scene, i) => (
            <div
              key={i}
              aria-hidden={i !== active}
              className={i === active ? `${m.scene} ${m.sceneOn}` : m.scene}
            >
              <Scene />
            </div>
          ))}
        </div>
      </div>

      <div className={page.flowSteps}>
        {steps.map((step, i) => (
          <div
            key={step.title}
            className={i === active ? `${page.flowStep} ${m.step} ${m.stepOn}` : `${page.flowStep} ${m.step}`}
            onClick={() => go(i)}
          >
            {i === active && <span key={epoch} className={m.stepBar} aria-hidden="true" />}
            <button
              type="button"
              className={`${page.flowNum} ${m.numBtn}`}
              aria-label={`Show step ${i + 1}: ${step.title}`}
              aria-current={i === active ? "step" : undefined}
              onClick={(e) => {
                e.stopPropagation()
                go(i)
              }}
            >
              {i + 1}
            </button>
            <div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
