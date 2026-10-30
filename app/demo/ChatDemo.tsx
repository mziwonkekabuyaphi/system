"use client"

// app/demo/ChatDemo.tsx
//
// A scripted WhatsApp conversation that plays out on the landing page, so a
// visitor sees what THEIR customers will see. It is a demo, not a live bot:
// every message is written in buildScenarios() below.
//
// The wording follows the real bot where we have it:
//   - menus and confirmations: lib/services/messages/booking.ts
//   - queue messages and the waitlist alert: the approved/pending WhatsApp
//     templates in the whatsapp_templates table
// Names, prices and times are made up. If you change the bot's wording, edit
// the matching line here so the demo stays honest.
//
// NOT from the real bot: the "Change a booking" chat (cancel / too late). The page copy says
// customers can cancel or move a booking up to a cut-off and are told politely when it is too
// late, but the exact wording below was written for this demo. Replace it with the real lines.
//
// The shop, services, prices, days and times come from the chosen industry
// (industries.ts + IndustryContext.tsx). Left to run, the demo plays each of its
// chats in turn and then moves on to the next industry; as soon as the
// visitor clicks a chat tab, a setting or picks an industry, it stops rotating.
//
// Under the phone sits a "Settings" panel for the assistant. Change one and the chat that it
// affects shows straight away, scrolled to the message that changed: switch a service off and
// it disappears from the menu, close earlier and later times vanish, turn the waitlist off and
// a full day becomes a lost customer, tighten the cancellation cut-off and a late cancel is
// refused.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import styles from "./demo.module.css"
import admin from "./adminDemo.module.css"
import { useIndustry } from "./IndustryContext"
import type { Industry } from "./industries"

type Message = {
  from: "me" | "bot" | "note"
  text: string
  /** Quick-reply buttons shown under a bot message. */
  chips?: string[]
  /** Marks the message a setting changes, so the phone can scroll to it. */
  focus?: string
}

type Scenario = {
  tab: string
  caption: string
  messages: Message[]
}

/** What the shop owner has set. The defaults are the "normal" shop. */
export type ChatConfig = {
  /** "Customers pick a service" (true) or "No services, one line" (false). */
  requireService: boolean
  /** Which of the three example services the assistant offers. */
  enabled: [boolean, boolean, boolean]
  /** Index (0-3) of the last booking time of the day. */
  lastTime: number
  /** Whether customers can ask to be told when a time opens up on a full day. */
  waitlist: boolean
  /** The queue place at which "you're nearly up" is sent (people ahead). */
  notifyAhead: number
  /** Customers can cancel or move a booking until this many hours before it starts. */
  cutoffHours: number
}

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  requireService: true,
  enabled: [true, true, true],
  lastTime: 3,
  waitlist: true,
  notifyAhead: 2,
  cutoffHours: 12,
}

/** In the "Change a booking" chat the booking is this many hours away. */
const BOOKING_IN_HOURS = 18

const rand = (n: number) => `R${n}`

/**
 * The example chats for one kind of shop. The wording is the bot's; the shop, services,
 * prices, days and times come from the chosen industry (industries.ts), so a nail studio, a
 * clinic and a tyre centre each see their own conversation. `cfg` is what the owner switched on.
 */
export function buildScenarios(x: Industry, cfg: ChatConfig = DEFAULT_CHAT_CONFIG): Scenario[] {
  const c = x.chat
  const picked = c.menu.filter((_, i) => cfg.enabled[i])
  const offered = picked.length ? picked : [c.menu[0]]
  const m0 = offered[0]
  // Opening hours are enforced: nothing after the last booking time is ever offered.
  const t = c.times.filter((_, i) => i <= cfg.lastTime)
  const pick = Math.min(2, t.length - 1)
  const when = t[pick]

  const menuLine = (m: (typeof c.menu)[number], i: number) => `${i + 1}. *${m.name}* — ${rand(m.price)} (${m.mins} min)`
  const menuText = `Here’s what we offer ${c.emoji}\n\n${offered.map(menuLine).join("\n")}\n\nReply with a number to pick a service.`
  const dayMenu = `Which day works for you? 📅\n\n1. Today\n2. Tomorrow\n3. ${c.day}\n\nReply with a number.`
  const timeMenu = (name: string, list: string[]) =>
    `Available times for *${name}* on ${c.day}:\n\n${list.map((tm, i) => `${i + 1}. ${tm}`).join("\n")}\n\nReply with a number.`
  const ahead = cfg.notifyAhead === 1 ? "1 person ahead of you" : `${cfg.notifyAhead} people ahead of you`
  const cancelOk = cfg.cutoffHours < BOOKING_IN_HOURS

  return [
    {
      tab: "Book a time",
      caption: `A customer books after hours. Nobody at ${x.shop} picked up a phone.`,
      messages: [
        { from: "me", text: "Hi" },
        {
          from: "bot",
          text: `Would you like to book a specific time, or join today’s walk-in queue? ${c.emoji}`,
          chips: ["📅 Book a time", "🚶 Join the queue"],
        },
        { from: "me", text: "📅 Book a time" },
        { from: "bot", text: menuText, focus: "services" },
        { from: "me", text: "1" },
        { from: "bot", text: dayMenu },
        { from: "me", text: "3" },
        { from: "bot", text: timeMenu(m0.name, t), focus: "times" },
        { from: "me", text: String(pick + 1) },
        {
          from: "bot",
          text: `Just to confirm ✅\n\n*Service:* ${m0.name}\n*Price:* ${rand(m0.price)}\n*When:* ${c.day} at ${when}\n\nReply *yes* to confirm, or *no* to cancel.`,
          chips: ["✅ Yes", "❌ No"],
        },
        { from: "me", text: "✅ Yes" },
        {
          from: "bot",
          text: `You’re booked, ${c.name}! 🎉\n\n*${m0.name}* on ${c.day} at ${when}\nReference: *${c.ref}*\n\nSee you then!`,
        },
      ],
    },
    {
      tab: "Join the queue",
      caption: cfg.requireService
        ? "A walk-in joins from the street, picks what they’re here for, then waits wherever they like. They are messaged when it’s nearly their turn."
        : "A walk-in joins from the street with no questions asked, then waits wherever they like. They are messaged when it’s nearly their turn.",
      messages: [
        { from: "me", text: "🚶 Join the queue" },
        ...(cfg.requireService
          ? ([{ from: "bot", text: menuText, focus: "service" }, { from: "me", text: "1" }] as Message[])
          : []),
        {
          from: "bot",
          text: `Hi ${c.name}, you’re in the queue at ${x.shop}${cfg.requireService ? ` for ${m0.name}` : ""}. Your ticket is ${c.ticket}. There are ${c.ahead} people ahead of you, with an estimated wait of ${c.waitMin} minutes. We’ll message you when it’s nearly your turn.`,
          focus: "joined",
        },
        { from: "note", text: "20 minutes later" },
        {
          from: "bot",
          text: `Hi ${c.name}, you’re nearly up at ${x.shop}. There are ${ahead}, so please make your way to us now.`,
          focus: "nearly",
        },
        { from: "note", text: "5 minutes later" },
        {
          from: "bot",
          text: `Hi ${c.name}, it’s your turn at ${x.shop}. Your Ticket number ${c.ticket}, please come to the front now.`,
        },
      ],
    },
    {
      tab: "Day is full",
      caption: cfg.waitlist
        ? `${c.day} is fully booked. Instead of losing the customer, the shop keeps them. When someone cancels, they hear first.`
        : `${c.day} is fully booked, and the waitlist is off. The customer hears “fully booked” and the shop has no way to win them back.`,
      messages: [
        { from: "bot", text: dayMenu },
        { from: "me", text: "3" },
        cfg.waitlist
          ? {
              from: "bot",
              text: `${c.day} is fully booked, sorry! Want us to message you on WhatsApp if a time opens up?`,
              chips: ["🔔 Notify me", "No thanks"],
              focus: "waitlist",
            }
          : { from: "bot", text: `${c.day} is fully booked, sorry! Please pick another day.`, focus: "waitlist" },
        ...(cfg.waitlist
          ? ([
              { from: "me", text: "🔔 Notify me" },
              { from: "bot", text: `Done ✅ You’re on the waitlist for ${c.day}. We’ll message you if a time opens up.` },
              { from: "note", text: `${c.day} 16:12 · another customer cancels` },
              { from: "bot", text: `Hi ${c.name}, a time may have opened up at ${x.shop} on ${c.day}. Reply *book* to see available times.` },
              { from: "me", text: "book" },
              { from: "bot", text: timeMenu(m0.name, [c.times[2]]) },
            ] as Message[])
          : ([{ from: "note", text: "Waitlist is off · this customer is lost" }] as Message[])),
      ],
    },
    {
      tab: "Change a booking",
      caption: `Customers can cancel or move a booking on WhatsApp until ${cfg.cutoffHours} hours before it starts. This one starts in ${BOOKING_IN_HOURS} hours, so ${
        cancelOk ? "it goes through." : "the assistant politely says it’s too late."
      }`,
      messages: [
        { from: "me", text: "I need to cancel my booking" },
        {
          from: "bot",
          text: `Hi ${c.name}, I found your booking:\n\n*${m0.name}* on ${c.day} at ${when}\nReference: *${c.ref}*\n\nWould you like to cancel it?`,
          chips: ["❌ Cancel it", "Keep it"],
        },
        { from: "me", text: "❌ Cancel it" },
        { from: "note", text: `The booking starts in ${BOOKING_IN_HOURS} hours` },
        cancelOk
          ? { from: "bot", text: `Done ✅ Your booking has been cancelled. The time is free for someone else.`, focus: "cutoff" }
          : {
              from: "bot",
              text: `Sorry ${c.name}, bookings can only be changed or cancelled up to ${cfg.cutoffHours} hours before they start, and yours starts in ${BOOKING_IN_HOURS} hours. Please contact us directly and we’ll help.`,
              focus: "cutoff",
            },
        ...(cancelOk && cfg.waitlist
          ? ([{ from: "note", text: "Whoever is on the waitlist for that day is messaged" }] as Message[])
          : []),
      ],
    },
  ]
}

/** Turns *word* into bold, keeps line breaks (CSS pre-line does the rest). */
function rich(text: string): ReactNode[] {
  return text.split(/\*(.+?)\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

export function ChatDemo() {
  const { industry, rotating, advance, choose } = useIndustry()
  const [cfg, setCfg] = useState<ChatConfig>(DEFAULT_CHAT_CONFIG)
  const scenarios = useMemo(() => buildScenarios(industry, cfg), [industry, cfg])
  const [active, setActive] = useState(0)
  const [shown, setShown] = useState(1)
  const [run, setRun] = useState(0)
  const [onScreen, setOnScreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scenario = scenarios[active]
  const total = scenario.messages.length
  const shop = industry.shop

  // Set when a setting changed: show the whole chat at once, scrolled to the message it changed.
  const instant = useRef(false)
  const focusKey = useRef<string | null>(null)

  // Rotation reads the latest values without restarting the playback below.
  const rotation = useRef({ rotating, advance, active })
  rotation.current = { rotating, advance, active }

  // Only play while visible, so a visitor who scrolls down meets the start of the chat, not its end.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === "undefined") {
      setOnScreen(true)
      return
    }
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Reveal one message at a time. Reduced-motion visitors get the whole chat (and no rotation).
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(total)
      return
    }
    if (instant.current) {
      instant.current = false
      setShown(total)
      return
    }
    if (!onScreen) return
    focusKey.current = null
    setShown(1)
    let count = 1
    let pause: ReturnType<typeof setTimeout> | undefined
    const timer = setInterval(() => {
      count += 1
      setShown(count)
      if (count >= total) {
        clearInterval(timer)
        // Chat finished: after a beat, play the next chat, then the next industry.
        pause = setTimeout(() => {
          const r = rotation.current
          if (!r.rotating) return
          if (r.active < scenarios.length - 1) setActive(r.active + 1)
          else {
            setActive(0)
            r.advance()
          }
        }, 3500)
      }
    }, 1600)
    return () => {
      clearInterval(timer)
      clearTimeout(pause)
    }
  }, [active, run, total, onScreen, industry.id, scenarios.length])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const key = focusKey.current
    if (key) {
      const target = el.querySelector<HTMLElement>(`[data-focus="${key}"]`)
      if (!target) return // not rendered yet: the next update will find it
      focusKey.current = null
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12
      el.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [shown, run])

  /** Apply a setting, then show the chat it affects, scrolled to the changed message. */
  function change(next: Partial<ChatConfig>, scenarioIndex: number, focus: string) {
    choose(industry.id) // the visitor is exploring: stop rotating industries
    setCfg((c) => ({ ...c, ...next }))
    instant.current = true
    focusKey.current = focus
    setActive(scenarioIndex)
    setRun((r) => r + 1)
  }

  function toggleService(i: number) {
    const enabled = cfg.enabled.map((v, j) => (j === i ? !v : v)) as ChatConfig["enabled"]
    if (!enabled.some(Boolean)) return // at least one service stays on
    change({ enabled }, 0, "services")
  }

  const onlyOne = cfg.enabled.filter(Boolean).length === 1
  const c = industry.chat

  return (
    <>
      <div ref={rootRef} className={styles.demoGrid}>
        <div>
          <div className={`${styles.demoTabs} ${styles.demoTabsVertical}`} role="tablist" aria-label="Example conversations">
            {scenarios.map((s, i) => (
              <button
                key={s.tab}
                type="button"
                role="tab"
                aria-selected={i === active}
                className={i === active ? `${styles.demoTab} ${styles.demoTabActive}` : styles.demoTab}
                onClick={() => {
                  setActive(i)
                  setRun((r) => r + 1)
                  choose(industry.id) // the visitor is exploring: stop rotating industries
                }}
              >
                {s.tab}
              </button>
            ))}
          </div>
          <p className={styles.demoCaption}>{scenario.caption}</p>
          <div className={styles.demoActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`}
              onClick={() => {
                setRun((r) => r + 1)
                choose(industry.id)
              }}
            >
              Replay
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`}
              onClick={() => {
                setShown(total)
                choose(industry.id)
              }}
            >
              Show the whole chat
            </button>
          </div>
          <p className={styles.demoFine}>An example conversation. Names, prices and times are made up.</p>
        </div>

        <div className={styles.phone} aria-label={`WhatsApp chat with ${shop}`}>
          <span className={styles.phoneNotch} aria-hidden="true" />
          <div className={styles.phoneStatus} aria-hidden="true">
            <span>9:41</span>
            <span className={styles.phoneStatusIcons}>
              <svg viewBox="0 0 18 12" width="15" height="10" fill="currentColor">
                <rect x="0" y="8" width="3" height="4" rx="0.8" />
                <rect x="5" y="5" width="3" height="7" rx="0.8" />
                <rect x="10" y="2.5" width="3" height="9.5" rx="0.8" />
                <rect x="15" y="0" width="3" height="12" rx="0.8" />
              </svg>
              <svg viewBox="0 0 26 12" width="22" height="10" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="0.6" y="0.6" width="21" height="10.8" rx="3" />
                <rect x="2.4" y="2.4" width="14" height="7.2" rx="1.6" fill="currentColor" stroke="none" />
                <rect x="23" y="4" width="2" height="4" rx="1" fill="currentColor" stroke="none" />
              </svg>
            </span>
          </div>
          <div className={styles.phoneHead}>
            <span className={styles.phoneAvatar} aria-hidden="true">{industry.initial}</span>
            <span>
              <strong>{shop}</strong>
              <small>WhatsApp Business</small>
            </span>
          </div>
          <div className={styles.phoneBody} ref={bodyRef} aria-live="polite">
            {scenario.messages.slice(0, shown).map((m, i) =>
              m.from === "note" ? (
                <p key={`${active}-${run}-${i}`} className={styles.sysNote}>
                  {m.text}
                </p>
              ) : (
                <div key={`${active}-${run}-${i}`} data-focus={m.focus} className={m.from === "me" ? styles.rowMe : styles.rowBot}>
                  <div className={m.from === "me" ? `${styles.bubble} ${styles.bubbleMe}` : `${styles.bubble} ${styles.bubbleBot}`}>
                    {rich(m.text)}
                  </div>
                  {m.chips && (
                    <div className={styles.chips}>
                      {m.chips.map((chip) => (
                        <span key={chip} className={styles.chip}>
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
          <span className={styles.phoneHome} aria-hidden="true" />
        </div>
      </div>

      <div className={admin.aHead}>
        <span className={admin.aTag}>In your dashboard · Settings</span>
        <span className={admin.aLine}>You set the rules once. Change one and the chat it affects plays straight away.</span>
      </div>

      <div className={admin.aCols}>
        <div className={admin.aCol}>
          <div className={admin.aCard}>
            <span className={admin.aCardTitle}>Services</span>
            <span className={admin.aCardSub}>What the assistant offers. At least one stays on.</span>
            <div className={admin.aRows}>
              {c.menu.map((m, i) => (
                <div key={m.name} className={admin.aToggle}>
                  <span className={admin.aField}>
                    <span className={admin.aFieldLabel}>{m.name}</span>
                    <span className={admin.aPrice}>{`${rand(m.price)} · ${m.mins} min`}</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={cfg.enabled[i]}
                    aria-label={`Offer ${m.name}`}
                    disabled={cfg.enabled[i] && onlyOne}
                    className={admin.aSwitch}
                    onClick={() => toggleService(i)}
                  />
                </div>
              ))}
            </div>

            <span className={admin.aGroup}>Does a customer need to choose one?</span>
            <div className={`${admin.aOpts} ${admin.aOpts2}`} role="group" aria-label="Services">
              <button
                type="button"
                aria-pressed={cfg.requireService}
                className={admin.aOpt}
                onClick={() => change({ requireService: true }, 1, "service")}
              >
                <span className={admin.aOptTitle}>Customers pick a service</span>
                <span className={admin.aOptText}>Best when services take different amounts of time.</span>
              </button>
              <button
                type="button"
                aria-pressed={!cfg.requireService}
                className={admin.aOpt}
                onClick={() => change({ requireService: false }, 1, "joined")}
              >
                <span className={admin.aOptTitle}>No services — one line</span>
                <span className={admin.aOptText}>Walk-ins just join. Everyone shares one line.</span>
              </button>
            </div>
          </div>

          <div className={admin.aCard}>
            <span className={admin.aCardTitle}>Business hours</span>
            <span className={admin.aCardSub}>Set once. The assistant can’t offer a time outside them.</span>
            <label className={admin.aField}>
              <span className={admin.aFieldLabel}>Last booking of the day</span>
              <select
                className={`${admin.aInput} ${admin.aSelect}`}
                value={cfg.lastTime}
                onChange={(e) => change({ lastTime: Number(e.target.value) }, 0, "times")}
              >
                {c.times.map((tm, i) => (
                  <option key={tm} value={i}>
                    {tm}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className={admin.aCol}>
          <div className={admin.aCard}>
            <span className={admin.aCardTitle}>Queue rules</span>
            <span className={admin.aCardSub}>When the “nearly your turn” message goes out.</span>
            <label className={admin.aField}>
              <span className={admin.aFieldLabel}>Notify when this many people are ahead</span>
              <select
                className={`${admin.aInput} ${admin.aSelect}`}
                value={cfg.notifyAhead}
                onChange={(e) => change({ notifyAhead: Number(e.target.value) }, 1, "nearly")}
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? "1 person" : `${n} people`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={admin.aCard}>
            <span className={admin.aCardTitle}>Full days &amp; cancellations</span>
            <span className={admin.aCardSub}>What happens when the diary is full, and when a customer changes their mind.</span>
            <div className={admin.aRows}>
              <div className={admin.aToggle}>
                <span className={admin.aField}>
                  <span className={admin.aFieldLabel}>Waitlist for full days</span>
                  <span className={admin.aHint}>Customers ask to be told if a time opens up. The next person is messaged when someone cancels.</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={cfg.waitlist}
                  aria-label="Waitlist for full days"
                  className={admin.aSwitch}
                  onClick={() => change({ waitlist: !cfg.waitlist }, 2, "waitlist")}
                />
              </div>
            </div>
            <label className={admin.aField} style={{ marginTop: 6 }}>
              <span className={admin.aFieldLabel}>Customers can cancel or move a booking until</span>
              <select
                className={`${admin.aInput} ${admin.aSelect}`}
                value={cfg.cutoffHours}
                onChange={(e) => change({ cutoffHours: Number(e.target.value) }, 3, "cutoff")}
              >
                {[2, 12, 24, 48].map((h) => (
                  <option key={h} value={h}>{`${h} hours before`}</option>
                ))}
              </select>
              <span className={admin.aHint}>Inside the cut-off they’re told politely it’s too late, so your day doesn’t change under you.</span>
            </label>
          </div>
        </div>
      </div>
    </>
  )
}
