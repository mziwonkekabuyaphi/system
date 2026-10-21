"use client"

// app/demo/DashboardDemo.tsx
//
// An auto-playing mock of the shop dashboard for the landing page. It is a demo, not
// the real admin: every name, number and time below is made up (see EXAMPLE DATA).
// The tab names match the real sidebar in app/admin/AdminView.tsx.
//
// It only "ticks" while it is on screen, and not at all for visitors who prefer
// reduced motion. No <p>/<h*> tags are used inside the window on purpose, so the
// landing page's global heading/paragraph styles can't leak into it.

import { useEffect, useRef, useState } from "react"
import styles from "./demo.module.css"

export type DashView = "queue" | "bookings" | "inbox" | "analytics" | "payroll"

const VIEWS: Array<{ id: DashView; tab: string; nav: string; caption: string }> = [
  {
    id: "queue",
    tab: "Live queue",
    nav: "Live Queue",
    caption: "Walk-ins, kiosk check-ins and booked customers on one board. Call the next person and everyone behind moves up.",
  },
  {
    id: "bookings",
    tab: "Appointments",
    nav: "Appointments",
    caption: "Each staff member’s day at a glance. A booking made on WhatsApp lands here the moment it’s confirmed.",
  },
  {
    id: "inbox",
    tab: "Inbox",
    nav: "Inbox",
    caption: "Every WhatsApp conversation in one place. The AI handles the routine ones, and you can take over any chat with one tap.",
  },
  {
    id: "analytics",
    tab: "Analytics",
    nav: "Analytics",
    caption: "Visits, busiest days and waits, so you can staff the shop for the days that matter.",
  },
  {
    id: "payroll",
    tab: "Payroll",
    nav: "Payroll",
    caption: "Pay staff by the hour, by commission, or both. Clocked hours and the services each person delivers become gross pay, with PAYE and UIF estimated for you.",
  },
]

const NAV = ["Appointments", "Live Queue", "Inbox", "Customers", "Services", "Staff", "Payroll", "Analytics", "Billing & Plans", "Settings"]
const SHOP = "Mzido’s Barbershop"
const TICK_MS = 3200

// ---------------------------------------------------------------------------
// EXAMPLE DATA
// ---------------------------------------------------------------------------

type Source = "WhatsApp" | "Kiosk" | "Booked"
type Entry = { ticket: string; name: string; service: string; src: Source }
type QueueState = { serving: Entry; queue: Entry[]; next: number; served: number }

const POOL: Array<Omit<Entry, "ticket">> = [
  { name: "Sipho M.", service: "Haircut", src: "WhatsApp" },
  { name: "Aiden K.", service: "Beard trim", src: "Kiosk" },
  { name: "Naledi P.", service: "Braids", src: "Booked" },
  { name: "Jaco V.", service: "Haircut + beard", src: "Kiosk" },
  { name: "Zinhle D.", service: "Gel set", src: "WhatsApp" },
  { name: "Mandla R.", service: "Haircut", src: "Booked" },
  { name: "Ayanda T.", service: "Kids cut", src: "Kiosk" },
  { name: "Riaan B.", service: "Beard trim", src: "WhatsApp" },
]

function makeEntry(n: number): Entry {
  return { ...POOL[n % POOL.length], ticket: `A${String(n).padStart(3, "0")}` }
}

export function initialQueue(): QueueState {
  return { serving: makeEntry(14), queue: [15, 16, 17, 18, 19].map(makeEntry), next: 20, served: 9 }
}

/** "Call next": the first person is served, everyone moves up, a new customer joins the back. */
export function advanceQueue(s: QueueState): QueueState {
  return { serving: s.queue[0], queue: [...s.queue.slice(1), makeEntry(s.next)], next: s.next + 1, served: s.served + 1 }
}

const STAFF = ["Sipho", "Thandi", "Lwazi"]
const TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]
type Block = { col: number; row: number; span: number; name: string; service: string }
const BASE_BOOKINGS: Block[] = [
  { col: 0, row: 0, span: 1, name: "Aiden K.", service: "Beard trim" },
  { col: 0, row: 2, span: 2, name: "Naledi P.", service: "Braids" },
  { col: 1, row: 0, span: 1, name: "Mandla R.", service: "Haircut" },
  { col: 1, row: 1, span: 1, name: "Ayanda T.", service: "Kids cut" },
  { col: 1, row: 3, span: 1, name: "Riaan B.", service: "Haircut" },
  { col: 2, row: 1, span: 2, name: "Jaco V.", service: "Haircut + beard" },
  { col: 2, row: 4, span: 1, name: "Zinhle D.", service: "Gel set" },
]
const INCOMING: Block[] = [
  { col: 0, row: 5, span: 1, name: "Sipho M.", service: "Haircut" },
  { col: 1, row: 4, span: 1, name: "Lerato N.", service: "Beard trim" },
  { col: 2, row: 6, span: 1, name: "Kabelo S.", service: "Haircut" },
]

const CONVOS = [
  { name: "Zinhle D.", preview: "Thanks! Also is it okay if I…", tag: "You" },
  { name: "Sipho M.", preview: "Saturday at 10:30 works", tag: "AI" },
  { name: "Mr Dlamini", preview: "Do you do school cuts?", tag: "AI" },
  { name: "Riaan B.", preview: "What time do you close?", tag: "AI" },
]
type Bubble = { from: "me" | "ai" | "you" | "note"; text: string }
const THREAD: Bubble[] = [
  { from: "me", text: "Hi, can I move my gel set to Friday?" },
  { from: "ai", text: "Of course! Friday has 10:00, 13:30 and 15:00 free for a gel set. Which suits you?" },
  { from: "me", text: "13:30 please" },
  { from: "ai", text: "Done ✅ Moved to Friday at 13:30. Reference K7Q2XM." },
  { from: "me", text: "Thanks! Also is it okay if I bring my daughter?" },
  { from: "note", text: "Thabo took over this chat" },
  { from: "you", text: "Hi Zinhle, yes of course, bring her along! 😊" },
]

const DAYS = [
  { d: "Mon", v: 38 },
  { d: "Tue", v: 52 },
  { d: "Wed", v: 47 },
  { d: "Thu", v: 61 },
  { d: "Fri", v: 74 },
  { d: "Sat", v: 96 },
  { d: "Sun", v: 58 },
]

// One example of each way of paying someone, matching the real Payroll tab:
// hourly, hybrid (hourly + commission on top), commission only, and hybrid "higher of".
// Commission is a % of the list price of the services the person delivered.
type PayType = "hourly" | "commission" | "hybrid"
type PayRow = {
  name: string
  type: PayType
  hours: number
  rate: number // hourly rate, 0 for commission-only
  pct: number // commission %, 0 for hourly
  sales: number // list price of services delivered
  services: number
  mode?: "base_plus_commission" | "higher_of"
  paye: number // made-up estimate
}
const PAY: PayRow[] = [
  { name: "Sipho M.", type: "hourly", hours: 38.5, rate: 45, pct: 0, sales: 0, services: 0, paye: 0 },
  { name: "Thandi N.", type: "hybrid", mode: "base_plus_commission", hours: 41, rate: 50, pct: 30, sales: 3200, services: 21, paye: 210 },
  { name: "Lwazi K.", type: "commission", hours: 0, rate: 0, pct: 40, sales: 5400, services: 29, paye: 57 },
  { name: "Themba K.", type: "hybrid", mode: "higher_of", hours: 36, rate: 48, pct: 45, sales: 4800, services: 26, paye: 57 },
]

// Whole cents throughout, same as the real calculation.
function payFigures(p: PayRow) {
  const baseCents = p.type === "commission" ? 0 : Math.round(p.hours * p.rate * 100)
  const earned = p.type === "hourly" ? 0 : Math.round(p.sales * p.pct) // sales in rand × percent = cents
  const commissionCents = p.type === "hourly" ? 0 : p.mode === "higher_of" ? Math.max(0, earned - baseCents) : earned
  const grossCents = baseCents + commissionCents
  return { baseCents, earned, commissionCents, grossCents, uifCents: Math.round(grossCents / 100) }
}

function payBasis(p: PayRow): string {
  if (p.type === "hourly") return `${p.hours} h × ${rand(p.rate)}`
  if (p.type === "commission") return `${p.pct}% commission · ${p.services} services · ${rand(p.sales)} sales`
  if (p.mode === "higher_of") {
    const f = payFigures(p)
    return `Higher of hourly or ${p.pct}%: paid on ${f.commissionCents > 0 ? "commission" : "hourly"}`
  }
  return `Hourly + ${p.pct}% commission · ${p.services} services`
}
// Deterministic on purpose: toLocaleString() output differs between Node and browsers
// (and en-ZA uses comma decimals), which would cause a hydration mismatch. "R1 732.50".
const rand = (n: number) => {
  const [whole, cents] = n.toFixed(2).split(".")
  return `R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0")}.${cents}`
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.dashStat}>
      <span className={styles.dashLabel}>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const SRC_CLASS: Record<Source, string> = { WhatsApp: styles.srcWhatsApp, Kiosk: styles.srcKiosk, Booked: styles.srcBooked }

function QueuePanel({ q, label }: { q: QueueState; label: (service: string) => string }) {
  return (
    <>
      <div className={styles.dashStats}>
        <Stat label="Waiting" value={String(q.queue.length)} />
        <Stat label="Est. wait" value={`${q.queue.length * 8} min`} />
        <Stat label="Served today" value={String(q.served)} />
      </div>
      <div className={styles.dashQueueGrid}>
        <div className={styles.dashServing}>
          <span className={styles.dashLabelOnDark}>Now serving</span>
          <span key={q.serving.ticket} className={`${styles.dashTicket} ${styles.dashNew}`}>
            {q.serving.ticket}
          </span>
          <strong>{q.serving.name}</strong>
          <span className={styles.dashLabelOnDark}>{label(q.serving.service)}</span>
          <span className={styles.dashCall}>Call next →</span>
        </div>
        <div className={styles.dashList}>
          {q.queue.map((e, i) => (
            <div key={e.ticket} className={i === q.queue.length - 1 ? `${styles.dashRow} ${styles.dashNew}` : styles.dashRow}>
              <span className={styles.dashMono}>{e.ticket}</span>
              <span className={styles.dashWho}>
                <strong>{e.name}</strong>
                <span className={styles.dashMuted}>{label(e.service)}</span>
              </span>
              <span className={`${styles.dashSrc} ${SRC_CLASS[e.src]}`}>{e.src}</span>
              <span className={styles.dashMono}>~{(i + 1) * 8} min</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function BookingsPanel({ step }: { step: number }) {
  const added = INCOMING.slice(0, step % (INCOMING.length + 1))
  const newest = added[added.length - 1]
  const blocks = [...BASE_BOOKINGS, ...added]
  return (
    <>
      <div className={styles.dashHeadRow}>
        <strong>Saturday</strong>
        {newest ? (
          <span key={newest.name} className={`${styles.dashToast} ${styles.dashNew}`}>
            New booking on WhatsApp: {newest.name}, {newest.service}, {TIMES[newest.row]}
          </span>
        ) : (
          <span className={styles.dashMuted}>{blocks.length} bookings</span>
        )}
      </div>
      <div className={styles.dashCal}>
        <span />
        {STAFF.map((s) => (
          <span key={s} className={styles.dashColHead}>
            {s}
          </span>
        ))}
        {TIMES.map((t, r) => (
          <span key={t} className={styles.dashTime} style={{ gridRow: r + 2, gridColumn: 1 }}>
            {t}
          </span>
        ))}
        {TIMES.flatMap((t, r) =>
          STAFF.map((s, c) => <span key={`${t}-${s}`} className={styles.dashCell} style={{ gridRow: r + 2, gridColumn: c + 2 }} />),
        )}
        {blocks.map((b) => (
          <span
            key={`${b.col}-${b.row}`}
            className={b === newest ? `${styles.dashBlock} ${styles.dashNew}` : styles.dashBlock}
            style={{ gridRow: `${b.row + 2} / span ${b.span}`, gridColumn: b.col + 2 }}
          >
            <strong>{b.name}</strong>
            <span>{b.service}</span>
          </span>
        ))}
      </div>
    </>
  )
}

function InboxPanel({ step }: { step: number }) {
  const shown = Math.min(THREAD.length, 2 + (step % (THREAD.length - 1)))
  const typing = shown < THREAD.length && THREAD[shown].from !== "me"
  return (
    <div className={styles.dashInbox}>
      <div className={styles.dashConvos}>
        {CONVOS.map((c, i) => (
          <div key={c.name} className={i === 0 ? `${styles.dashConvo} ${styles.dashConvoActive}` : styles.dashConvo}>
            <span className={styles.dashWho}>
              <strong>{c.name}</strong>
              <span className={styles.dashMuted}>{c.preview}</span>
            </span>
            <span className={c.tag === "AI" ? styles.tagAi : styles.tagYou}>{c.tag}</span>
          </div>
        ))}
      </div>
      <div className={styles.dashThread}>
        <div className={styles.dashHeadRow}>
          <strong>Zinhle D.</strong>
          <span className={styles.dashTakeover}>Take over chat</span>
        </div>
        <div className={styles.dashMsgs}>
          {THREAD.slice(0, shown).map((m, i) =>
            m.from === "note" ? (
              <span key={i} className={styles.dashSysNote}>
                {m.text}
              </span>
            ) : (
              <span key={i} className={`${styles.dashMsg} ${m.from === "me" ? styles.msgIn : m.from === "ai" ? styles.msgAi : styles.msgYou}`}>
                {m.text}
              </span>
            ),
          )}
          {typing && (
            <span className={`${styles.dashMsg} ${styles.msgAi} ${styles.dashTyping}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function AnalyticsPanel() {
  const max = Math.max(...DAYS.map((d) => d.v))
  return (
    <>
      <div className={styles.dashStats}>
        <Stat label="Visits this week" value="426" />
        <Stat label="Booked on WhatsApp" value="61%" />
        <Stat label="Avg. wait" value="14 min" />
      </div>
      <div className={styles.dashChart}>
        <div className={styles.dashHeadRow}>
          <strong>Visits per day</strong>
          <span className={styles.dashMuted}>Saturday is your busiest day</span>
        </div>
        <div className={styles.dashBars}>
          {DAYS.map((d, i) => (
            <div key={d.d} className={styles.dashBarCol}>
              <span className={styles.dashMono}>{d.v}</span>
              <span
                className={d.v === max ? `${styles.dashBarFill} ${styles.dashBarTop}` : styles.dashBarFill}
                style={{ height: `${(d.v / max) * 100}%`, animationDelay: `${i * 70}ms` }}
              />
              <span className={styles.dashMuted}>{d.d}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

const PAY_TAG_LABEL: Record<PayType, string> = { hourly: "Hourly", commission: "Commission", hybrid: "Hybrid" }
const PAY_TAG_CLASS: Record<PayType, string> = { hourly: styles.payHourly, commission: styles.payCommission, hybrid: styles.payHybrid }

function PayrollPanel() {
  return (
    <>
      <div className={styles.dashHeadRow}>
        <strong>This week</strong>
        <span className={styles.dashClocked}>{PAY.length} clocked in</span>
      </div>
      <div className={styles.dashTableWrap}>
        <table className={styles.dashTable}>
          <thead>
            <tr>
              <th>Staff</th>
              <th>Hours</th>
              <th>Commission</th>
              <th>Gross pay</th>
              <th>Est. PAYE</th>
              <th>Est. UIF</th>
            </tr>
          </thead>
          <tbody>
            {PAY.map((p) => {
              // Whole cents, so 1% of R1 732.50 is R17.33 (half up) and not R17.32 from float error.
              const f = payFigures(p)
              return (
                <tr key={p.name}>
                  <td>
                    <span className={styles.dashWho}>
                      <strong>
                        {p.name}
                        <span className={`${styles.dashPayTag} ${PAY_TAG_CLASS[p.type]}`}>{PAY_TAG_LABEL[p.type]}</span>
                      </strong>
                      <span className={styles.dashMuted}>{payBasis(p)}</span>
                    </span>
                  </td>
                  <td className={styles.dashMono}>{p.type === "commission" ? "—" : p.hours}</td>
                  <td className={styles.dashMono}>{p.type === "hourly" ? "—" : rand(f.commissionCents / 100)}</td>
                  <td className={styles.dashMono}>{rand(f.grossCents / 100)}</td>
                  <td className={styles.dashMono}>{rand(p.paye)}</td>
                  <td className={styles.dashMono}>{rand(f.uifCents / 100)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** The six service names the example queue uses, in order of first appearance. */
const BASE_SERVICES = Array.from(new Set(POOL.map((p) => p.service)))

export function DashboardDemo({
  compact = false,
  initialView = "queue",
  shop = SHOP,
  services,
}: {
  compact?: boolean
  initialView?: DashView
  /** Shop name shown in the window. Defaults to the example barbershop. */
  shop?: string
  /** Service names to show on the live queue instead of the barbershop ones (mapped by position). */
  services?: readonly string[]
}) {
  const label = (service: string) => {
    const at = BASE_SERVICES.indexOf(service)
    return services && services.length > 0 && at >= 0 ? services[at % services.length] : service
  }
  const [view, setView] = useState<DashView>(compact ? "queue" : initialView)
  const [step, setStep] = useState(0)
  const [q, setQ] = useState<QueueState>(initialQueue)
  const [onScreen, setOnScreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Only run while visible.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!onScreen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = setInterval(() => {
      setStep((n) => n + 1)
      setQ(advanceQueue)
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [onScreen])

  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]

  const window_ = (
    <div className={styles.dashWindow} aria-hidden={compact || undefined}>
      <div className={styles.dashChrome}>
        <span className={styles.dashDots}>
          <i />
          <i />
          <i />
        </span>
        <span className={styles.dashUrl}>{shop} · {compact ? "Live Queue" : current.nav}</span>
        <span className={styles.dashLive}>Live</span>
      </div>
      <div className={styles.dashBody}>
        {!compact && (
          <div className={styles.dashSide}>
            <span className={styles.dashBrand}>
              <span className={styles.dashBrandMark}>{shop.charAt(0).toUpperCase()}</span>
              {shop}
            </span>
            {NAV.map((n) => (
              <span key={n} className={n === current.nav ? `${styles.dashNav} ${styles.dashNavActive}` : styles.dashNav}>
                {n}
              </span>
            ))}
          </div>
        )}
        <div className={styles.dashMain} key={view}>
          {view === "queue" && <QueuePanel q={q} label={label} />}
          {view === "bookings" && <BookingsPanel step={step} />}
          {view === "inbox" && <InboxPanel step={step} />}
          {view === "analytics" && <AnalyticsPanel />}
          {view === "payroll" && <PayrollPanel />}
        </div>
      </div>
    </div>
  )

  if (compact) {
    return (
      <div ref={rootRef} className={`${styles.dash} ${styles.dashCompact}`}>
        {window_}
      </div>
    )
  }

  return (
    <div ref={rootRef} className={styles.dash}>
      <div className={styles.dashLayout}>
        <div>
          <div className={styles.dashTabs} role="tablist" aria-label="Dashboard views">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === view}
                className={v.id === view ? `${styles.demoTab} ${styles.demoTabActive}` : styles.demoTab}
                onClick={() => setView(v.id)}
              >
                {v.tab}
              </button>
            ))}
          </div>
          <p className={styles.dashCaption}>{current.caption}</p>
          <p className={styles.dashFine}>An example dashboard. Names, numbers and times are made up.</p>
        </div>
        {window_}
      </div>
    </div>
  )
}
