"use client"

// app/demo/FeatureShowcase.tsx
//
// The "What's included" section's body: a mockup stage with one scene per feature, and the
// feature cards underneath acting as its controls. Click a card (or its icon) to jump to that
// scene; otherwise it advances by itself while on screen, pauses on hover / focus, and never
// auto-plays for visitors who prefer reduced motion.
//
// The scenes follow the order of FEATURES in page.tsx (sixteen, at the time of writing):
//   1 WhatsApp AI  2 kiosk  3 bookings that can't clash  4 live queue  5 waitlist
//   6 branded ticket  7 staff & payroll  8 business hours  9 your brand
//   10 payments  11 booking rules  12 queue rules  13 own domain  14 own WhatsApp number  15 light/dark dashboard  16 bring your own AI
// If you add, remove or reorder a feature there, update SCENES below to match.
//
// It reuses the building blocks and stage styles from HowItWorks (smartphone, bubbles, panes,
// cards, mini dashboard, kiosk) so both sections look like one family; its own styles are in
// featureShowcase.module.css. The card grid keeps the page's own `features` / `feature` classes.
// No <p>/<h*> inside the mockup on purpose: the page has global heading styles.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import page from "./demo.module.css"
import m from "./howItWorks.module.css"
import f from "./featureShowcase.module.css"
import { Phone, Bubble, Pane, KioskWithPrinter, delay } from "./HowItWorks"

type Feature = { title: string; text: string; icon: ReactNode; isNew?: boolean }

const STEP_MS = 6500
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const

const Li = ({ d, children }: { d: number; children: ReactNode }) => (
  <span className={`${f.li} ${m.seq}`} style={delay(d)}>
    <span className={m.tick} aria-hidden="true">✓</span>
    <span>{children}</span>
  </span>
)

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function SceneAI() {
  return (
    <>
      <Pane cap="Answers questions and books, at any hour.">
        <Phone>
          <Bubble me d={0.2}>Are you open today?</Bubble>
          <Bubble d={0.9}>{"Yes! We’re open until 18:00 today. Want to book a time?"}</Bubble>
          <span className={`${m.chips} ${m.seq}`} style={delay(1.5)}>
            <span className={m.chip}>Book a time</span>
            <span className={m.chip}>Join the queue</span>
          </span>
        </Phone>
      </Pane>
      <Pane cap="And hands over to you with one tap.">
        <div className={m.card}>
          <span className={m.cardTitle}>What it handles</span>
          <Li d={0.3}>Books appointments</Li>
          <Li d={0.7}>Reschedules and cancels</Li>
          <Li d={1.1}>Joins the walk-in queue</Li>
          <Li d={1.5}>Answers “are you open?”</Li>
          <span className={`${m.dBtn} ${f.takeover} ${m.seq}`} style={delay(2)}>Take over this chat</span>
        </div>
      </Pane>
    </>
  )
}

function SceneKiosk() {
  return (
    <>
      <Pane cap="Walk-ins book a time or join the queue in a few taps.">
        <KioskWithPrinter receipt="queue" d={1.6}>
          <div className={m.kioskScreen}>
            <span className={f.kTitle}>How can we help?</span>
            <div className={f.tiles}>
              <span className={`${f.tile} ${f.tileA} ${m.seq}`} style={delay(0.3)}><b>Book a time</b><span>Pick a slot today</span></span>
              <span className={`${f.tile} ${f.tileB} ${f.tapped} ${m.seq}`} style={delay(0.6)}><b>Join the queue</b><span>We’ll call you</span></span>
            </div>
          </div>
        </KioskWithPrinter>
      </Pane>
      <Pane cap="It resets itself after every customer.">
        <div className={m.card}>
          <span className={m.cardTitle}>After each customer</span>
          <Li d={0.4}>Ticket handed over</Li>
          <Li d={0.9}>Their details cleared</Li>
          <Li d={1.4}>Back to the welcome screen</Li>
          <span className={`${f.ready} ${m.seq}`} style={delay(2)}>Ready for the next customer</span>
        </div>
      </Pane>
    </>
  )
}

function SceneClash() {
  return (
    <>
      <Pane cap="Two customers tap 14:30 with Thabo in the same second…">
        <div className={`${m.card} ${f.duel}`}>
          <span className={m.cardTitle}>14:02:07 · Naledi P.</span>
          <span className={f.slotBig}>14:30</span>
          <span className={`${f.result} ${f.resOk} ${m.seq}`} style={delay(0.6)}>✓ Confirmed</span>
        </div>
      </Pane>
      <Pane cap="…only one gets it. The other is offered the next time.">
        <div className={`${m.card} ${f.duel}`}>
          <span className={m.cardTitle}>14:02:07 · Jaco V.</span>
          <span className={`${f.slotBig} ${f.slotGone}`}>14:30</span>
          <span className={`${f.result} ${f.resNo} ${m.seq}`} style={delay(0.9)}>Just taken. How about 14:45?</span>
        </div>
      </Pane>
    </>
  )
}

function SceneQueue() {
  const rows: Array<[string, string, string, "whatsapp" | "kiosk" | "booked", string]> = [
    ["B014", "Sipho M.", "Fade", "kiosk", "Now serving"],
    ["B015", "Naledi P.", "Fade", "whatsapp", "Next up"],
    ["B016", "Zinhle D.", "Kids cut", "kiosk", "~14 min"],
    ["14:45", "Jaco V.", "Beard trim", "booked", "~20 min"],
  ]
  const label = { whatsapp: "WhatsApp", kiosk: "Kiosk", booked: "Booked" }
  const cls = { whatsapp: m.srcWhatsapp, kiosk: m.srcKiosk, booked: m.srcBooked }
  return (
    <Pane wide cap="Appointments and the walk-in line on one screen, each with a ticket, a place and an estimated wait.">
      <div className={m.dash}>
        <div className={m.dashBar}>
          <span className={m.dashLogo}>M</span>
          <b>Mzansi Cuts · Live queue</b>
          <span className={m.live}><span className={m.liveDot} aria-hidden="true" />Live</span>
        </div>
        <div className={m.dashRows}>
          {rows.map(([t, n, s, src, est], i) => (
            <span key={t} className={`${m.dRow} ${i === 0 ? f.serving : ""} ${m.seq}`} style={delay(0.15 + i * 0.15)}>
              <b>{t}</b>
              <span>{n}</span>
              <i>{s}</i>
              <span className={`${m.src} ${cls[src]}`}>{label[src]}</span>
              <em>{est}</em>
            </span>
          ))}
        </div>
      </div>
    </Pane>
  )
}

function SceneWaitlist() {
  return (
    <>
      <Pane cap="Thursday is full, so Zinhle asks to be told if a time opens up.">
        <div className={m.card}>
          <span className={m.cardTitle}>Thursday · 15:00</span>
          <span className={`${f.tl} ${m.seq}`} style={delay(0.2)}><b>Waitlist</b>Zinhle D. is next in line</span>
          <span className={`${f.tl} ${f.tlWarn} ${m.seq}`} style={delay(1)}><b>Cancelled</b>Sipho M. frees up 15:00</span>
          <span className={`${f.tl} ${f.tlOk} ${m.seq}`} style={delay(1.8)}><b>Offered</b>Zinhle is messaged straight away</span>
        </div>
      </Pane>
      <Pane cap="The next person can take the slot in a few taps.">
        <Phone>
          <Bubble d={1.9}>{"Good news, Zinhle! A time just opened up at 15:00 on Thursday. Reply to book it."}</Bubble>
          <Bubble me d={2.8}>Book it</Bubble>
          <Bubble d={3.4}>{"Done, you’re booked for Thursday 15:00 ✅"}</Bubble>
        </Phone>
      </Pane>
    </>
  )
}

const QR = [
  "1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111",
]
const QR_NOISE = "0110100101101001"

function SceneTicket() {
  return (
    <Pane wide cap="Confirmations can carry a ticket with a QR code, in your colours, sent straight to the customer on WhatsApp.">
      <div className={`${f.ticket} ${m.seq}`} style={delay(0.2)}>
        <span className={f.stub}>
          <span className={f.stubLogo}>M</span>
          <span>Mzansi Cuts</span>
        </span>
        <span className={f.ticketMain}>
          <span className={f.tEyebrow}>Booking ticket</span>
          <span className={f.tName}>Naledi P.</span>
          <span className={f.tLine}>Fade · Today at 14:30</span>
          <span className={f.tLine}>With Thabo · Reference ZQ-4821</span>
        </span>
        <span className={f.qr} aria-hidden="true">
          {QR.flatMap((row, r) =>
            row.split("").map((c, i) => (
              <i key={`${r}-${i}`} className={c === "1" || (r > 1 && r < 5 && i > 1 && i < 5 && QR_NOISE[(r * 7 + i) % QR_NOISE.length] === "1") ? f.qrOn : ""} />
            )),
          )}
        </span>
      </div>
    </Pane>
  )
}

function ScenePayroll() {
  return (
    <>
      <Pane cap="Staff clock in with a PIN.">
        <div className={`${m.card} ${f.pad}`}>
          <span className={m.cardTitle}>Clock in</span>
          <span className={f.dots} aria-hidden="true"><i className={f.dotOn} /><i className={f.dotOn} /><i className={f.dotOn} /><i className={f.dotOn} /></span>
          <span className={f.keys} aria-hidden="true">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "✓"].map((k, i) => (
              <i key={i} className={k === "" ? f.keyGhost : k === "✓" ? f.keyGo : ""}>{k}</i>
            ))}
          </span>
          <span className={`${f.result} ${f.resOk} ${m.seq}`} style={delay(0.8)}>Thabo clocked in at 08:02</span>
        </div>
      </Pane>
      <Pane cap="Hours become gross pay, with PAYE and UIF estimated for you.">
        <div className={m.card}>
          <span className={m.cardTitle}>Payslip · Thabo · this week</span>
          {[
            ["Hours worked", "38.5 h"],
            ["Gross pay", "R3,850.00"],
            ["PAYE (estimate)", "−R312.00"],
            ["UIF (estimate)", "−R38.50"],
          ].map(([k, v], i) => (
            <span key={k} className={`${f.pay} ${m.seq}`} style={delay(0.4 + i * 0.35)}><span>{k}</span><b>{v}</b></span>
          ))}
          <span className={`${f.pay} ${f.payNet} ${m.seq}`} style={delay(1.9)}><span>Net pay</span><b>R3,499.50</b></span>
        </div>
      </Pane>
    </>
  )
}

function SceneHours() {
  return (
    <>
      <Pane cap="Set your hours once.">
        <div className={m.card}>
          <span className={m.cardTitle}>Business hours</span>
          {[
            ["Mon – Fri", "08:00 – 18:00", false],
            ["Saturday", "08:00 – 14:00", false],
            ["Sunday", "Closed", true],
          ].map(([d, h, off], i) => (
            <span key={String(d)} className={`${f.hours} ${off ? f.hoursOff : ""} ${m.seq}`} style={delay(0.2 + i * 0.3)}><b>{d}</b><span>{h}</span></span>
          ))}
        </div>
      </Pane>
      <Pane cap="The bot and kiosk simply can’t accept a booking outside them.">
        <Phone>
          <Bubble me d={0.8}>Can I book for 19:00?</Bubble>
          <Bubble d={1.5}>{"Sorry, we close at 18:00 today. The closest times are 17:00 or 17:30."}</Bubble>
          <span className={`${m.chips} ${m.seq}`} style={delay(2.1)}>
            <span className={m.chip}>17:00</span>
            <span className={m.chip}>17:30</span>
          </span>
        </Phone>
      </Pane>
    </>
  )
}

function BrandScreen({ name, initial, main, accent, onAccent, powered }: { name: string; initial: string; main: string; accent: string; onAccent: string; powered: boolean }) {
  const vars = { "--b-main": main, "--b-accent": accent, "--b-on": onAccent } as CSSProperties
  return (
    <KioskWithPrinter receipt="booking" shop={name} d={1.2}>
      <div className={`${m.kioskScreen} ${m.center} ${f.brand}`} style={vars}>
        <span className={f.bLogo}>{initial}</span>
        <span className={m.kShop}>{name}</span>
        <span className={f.bTap}>Tap to check in</span>
        {powered && <span className={f.powered}>Powered by ZozoQueue</span>}
      </div>
    </KioskWithPrinter>
  )
}

function SceneBrand() {
  return (
    <>
      <Pane cap="Your logo and colours on every screen customers see…">
        <BrandScreen name="Mzansi Cuts" initial="M" main="#14325c" accent="#f5a524" onAccent="#0b1c36" powered />
      </Pane>
      <Pane cap="…and “Powered by ZozoQueue” can come off entirely.">
        <BrandScreen name="Greenpoint Clinic" initial="G" main="#0f766e" accent="#fbbf24" onAccent="#10312e" powered={false} />
      </Pane>
    </>
  )
}

function ScenePayments() {
  return (
    <>
      <Pane cap="The customer pays to hold their time…">
        <Phone>
          <Bubble me d={0.2}>Book me a haircut Saturday 10:30</Bubble>
          <Bubble d={0.9}>{"Done! Pay your R150 deposit to confirm 10:30. Your time is held for you."}</Bubble>
          <span className={`${m.chips} ${m.seq}`} style={delay(1.5)}>
            <span className={m.chip}>Pay now</span>
          </span>
          <Bubble d={2.2}>{"Payment received. You’re booked for Saturday at 10:30."}</Bubble>
        </Phone>
      </Pane>
      <Pane cap="…under rules you set, for bookings and orders.">
        <div className={m.card}>
          <span className={m.cardTitle}>Payment rules · Bookings</span>
          {[
            ["When they pay", "Deposit"],
            ["Deposit", "50% of the total"],
            ["Pay within", "2 hours"],
            ["Refund policy", "Partial refund"],
          ].map(([k, v], i) => (
            <span key={k} className={`${f.pay} ${m.seq}`} style={delay(0.3 + i * 0.35)}><span>{k}</span><b>{v}</b></span>
          ))}
          <span className={`${f.result} ${f.resNo} ${m.seq}`} style={delay(1.9)}>Not paid in time? The slot is released.</span>
        </div>
      </Pane>
    </>
  )
}

function SceneRules() {
  return (
    <>
      <Pane cap="Decide who can book, when, and how often.">
        <div className={m.card}>
          <span className={m.cardTitle}>Booking rules</span>
          <Li d={0.3}>Minimum notice and how far ahead</Li>
          <Li d={0.7}>Cancel and reschedule cut-offs</Li>
          <Li d={1.1}>Limits per customer</Li>
          <Li d={1.5}>Repeat appointments you set up</Li>
          <Li d={1.9}>Approve each booking first (optional)</Li>
        </div>
      </Pane>
      <Pane cap="Switch on approval and you confirm each request.">
        <Phone>
          <Bubble me d={0.2}>Book me Friday 14:00</Bubble>
          <Bubble d={0.9}>{"Thanks! Your request is with the shop and your time is held while they review it."}</Bubble>
          <span className={`${f.result} ${f.resOk} ${m.seq}`} style={delay(1.8)}>✓ Approved by the shop</span>
        </Phone>
      </Pane>
    </>
  )
}

function SceneQueueRules() {
  return (
    <>
      <Pane cap="Choose how the walk-in line behaves.">
        <div className={m.card}>
          <span className={m.cardTitle}>Queue rules</span>
          <Li d={0.3}>Auto-call the next customer</Li>
          <Li d={0.7}>Heads-up a few people before their turn</Li>
          <Li d={1.1}>Maximum queue size</Li>
          <Li d={1.5}>Let customers leave or check their place</Li>
          <Li d={1.9}>Show an estimated wait</Li>
        </div>
      </Pane>
      <Pane cap="Walk-ins can join on WhatsApp, the kiosk, or both.">
        <div className={m.card}>
          <span className={m.cardTitle}>Where walk-ins can join</span>
          {[
            ["WhatsApp", "On"],
            ["Kiosk", "On"],
          ].map(([k, v], i) => (
            <span key={k} className={`${f.pay} ${m.seq}`} style={delay(0.3 + i * 0.4)}><span>{k}</span><b>{v}</b></span>
          ))}
          <span className={`${f.result} ${f.resOk} ${m.seq}`} style={delay(1.3)}>Bookings are set separately</span>
        </div>
      </Pane>
    </>
  )
}

function SceneDomain() {
  return (
    <>
      <Pane cap="Type your domain, add the records we show you…">
        <div className={m.card}>
          <span className={m.cardTitle}>Connect your own domain</span>
          <span className={`${f.pay} ${m.seq}`} style={delay(0.3)}><span>Address</span><b>book.mzansicuts.co.za</b></span>
          <Li d={0.8}>Add the DNS records at your registrar</Li>
          <Li d={1.3}>We check them for you</Li>
          <Li d={1.8}>Connected</Li>
        </div>
      </Pane>
      <Pane cap="…and customers see your address, not ours.">
        <div className={`${m.card} ${f.duel}`}>
          <span className={m.cardTitle}>Booking page</span>
          <span className={f.addr}>book.mzansicuts.co.za</span>
          <span className={`${f.result} ${f.resOk} ${m.seq}`} style={delay(0.8)}>✓ Live on your own address</span>
        </div>
      </Pane>
    </>
  )
}

function SceneWhatsApp() {
  return (
    <>
      <Pane cap="Connect your own number from Settings.">
        <div className={m.card}>
          <span className={m.cardTitle}>Connect WhatsApp</span>
          <Li d={0.3}>Sign in with Meta in a pop-up</Li>
          <Li d={0.8}>Choose the number to use</Li>
          <Li d={1.3}>Your number is connected</Li>
          <span className={`${f.result} ${f.resOk} ${m.seq}`} style={delay(1.9)}>Connected</span>
        </div>
      </Pane>
      <Pane cap="Meta bills you directly for the messages.">
        <div className={m.card}>
          <span className={m.cardTitle}>Who pays for what</span>
          {[
            ["WhatsApp number", "Yours"],
            ["Meta message charges", "Billed to you by Meta"],
            ["Customer chats", "On your number"],
          ].map(([k, v], i) => (
            <span key={k} className={`${f.pay} ${m.seq}`} style={delay(0.3 + i * 0.4)}><span>{k}</span><b>{v}</b></span>
          ))}
        </div>
      </Pane>
    </>
  )
}

function ThemeBox({ dark }: { dark?: boolean }) {
  return (
    <div className={`${f.themeBox} ${dark ? f.themeDark : f.themeLight}`}>
      <span className={f.themeSide} aria-hidden="true" />
      <span className={f.themeMain}>
        <span className={f.themeRow}><b>B014</b><span>Sipho M.</span><span>Now serving</span></span>
        <span className={f.themeRow}><b>B015</b><span>Naledi P.</span><span>Next up</span></span>
        <span className={f.themeRow}><b>B016</b><span>Jaco V.</span><span>Waiting</span></span>
      </span>
    </div>
  )
}

function SceneTheme() {
  return (
    <>
      <Pane cap="A light dashboard for bright shops…">
        <ThemeBox />
      </Pane>
      <Pane cap="…or a dark one that’s easier on the eyes.">
        <ThemeBox dark />
      </Pane>
    </>
  )
}

function SceneAiKey() {
  return (
    <>
      <Pane cap="Add your own Claude or OpenAI key…">
        <div className={m.card}>
          <span className={m.cardTitle}>Settings · AI</span>
          <Li d={0.3}>Choose Claude or OpenAI</Li>
          <Li d={0.7}>Paste your API key (saved encrypted)</Li>
          <Li d={1.1}>Switch the AI on</Li>
          <span className={`${f.pay} ${m.seq}`} style={delay(1.6)}><span>Monthly limit</span><b>R250.00</b></span>
        </div>
      </Pane>
      <Pane cap="…and your assistant understands normal sentences.">
        <Phone>
          <Bubble me d={0.2}>Any space Saturday morning? Open late on weekdays?</Bubble>
          <Bubble d={1.0}>{"Saturday we have 09:00, 09:30 and 10:30 free. On weekdays we close at 18:00. Want me to book one?"}</Bubble>
          <span className={`${m.chips} ${m.seq}`} style={delay(1.7)}>
            <span className={m.chip}>09:00</span>
            <span className={m.chip}>09:30</span>
            <span className={m.chip}>10:30</span>
          </span>
        </Phone>
      </Pane>
    </>
  )
}

const SCENES = [SceneAI, SceneKiosk, SceneClash, SceneQueue, SceneWaitlist, SceneTicket, ScenePayroll, SceneHours, SceneBrand, ScenePayments, SceneRules, SceneQueueRules, SceneDomain, SceneWhatsApp, SceneTheme, SceneAiKey]

// ---------------------------------------------------------------------------
// The section body
// ---------------------------------------------------------------------------

export function FeatureShowcase({ features }: { features: Feature[] }) {
  const [active, setActive] = useState(0)
  const [epoch, setEpoch] = useState(0) // bumped to restart the timer and the card's progress bar
  const [onScreen, setOnScreen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const count = Math.min(features.length, SCENES.length)

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
      className={running ? f.root : `${f.root} ${f.rootIdle}`}
      style={{ "--fs-ms": `${STEP_MS}ms` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={`${m.stage} ${f.stage}`} role="group" aria-label="Illustration of the selected feature">
        <div className={m.stageHead}>
          <span className={m.stageStep}>Feature {active + 1} of {count}</span>
          <span className={m.stageTitle}>{features[active].title}</span>
        </div>
        <div className={m.scenes}>
          {SCENES.slice(0, count).map((Scene, i) => (
            <div key={i} aria-hidden={i !== active} className={i === active ? `${m.scene} ${m.sceneOn}` : m.scene}>
              <Scene />
            </div>
          ))}
        </div>
      </div>

      <div className={`${page.features} ${f.grid}`}>
        {features.map((ft, i) => (
          <div
            key={ft.title}
            className={`${page.feature} ${f.card} ${i === active ? f.cardOn : ""}`}
            onClick={() => go(i)}
          >
            {i === active && <span key={epoch} className={f.bar} aria-hidden="true" />}
            <button
              type="button"
              className={f.iconBtn}
              aria-label={`Show ${ft.title}`}
              aria-current={i === active ? "true" : undefined}
              onClick={(e) => {
                e.stopPropagation()
                go(i)
              }}
            >
              <svg className={page.featureIcon} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                {ft.icon}
              </svg>
            </button>
            <h3>
              {ft.title}
              {ft.isNew && <span className={page.badgeNew}>New</span>}
            </h3>
            <p>{ft.text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
