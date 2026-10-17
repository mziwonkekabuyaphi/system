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
// The shop, services, prices, days and times come from the chosen industry
// (industries.ts + IndustryContext.tsx). Left to run, the demo plays each of its
// three chats in turn and then moves on to the next industry; as soon as the
// visitor clicks a chat tab or picks an industry, it stops rotating.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import styles from "./demo.module.css"
import { useIndustry } from "./IndustryContext"
import type { Industry } from "./industries"

type Message = {
  from: "me" | "bot" | "note"
  text: string
  /** Quick-reply buttons shown under a bot message. */
  chips?: string[]
}

type Scenario = {
  tab: string
  caption: string
  messages: Message[]
}

const rand = (n: number) => `R${n}`

/**
 * The three example chats for one kind of shop. The wording is the bot's; the shop, services,
 * prices, days and times come from the chosen industry (industries.ts), so a nail studio, a
 * clinic and a tyre centre each see their own conversation.
 */
export function buildScenarios(x: Industry): Scenario[] {
  const c = x.chat
  const [m0, m1, m2] = c.menu
  const t = c.times
  const menuLine = (m: (typeof c.menu)[number], i: number) => `${i + 1}. *${m.name}* — ${rand(m.price)} (${m.mins} min)`
  const dayMenu = `Which day works for you? 📅\n\n1. Today\n2. Tomorrow\n3. ${c.day}\n\nReply with a number.`

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
        {
          from: "bot",
          text: `Here’s what we offer ${c.emoji}\n\n${[m0, m1, m2].map(menuLine).join("\n")}\n\nReply with a number to pick a service.`,
        },
        { from: "me", text: "1" },
        { from: "bot", text: dayMenu },
        { from: "me", text: "3" },
        {
          from: "bot",
          text: `Available times for *${m0.name}* on ${c.day}:\n\n1. ${t[0]}\n2. ${t[1]}\n3. ${t[2]}\n4. ${t[3]}\n\nReply with a number.`,
        },
        { from: "me", text: "3" },
        {
          from: "bot",
          text: `Just to confirm ✅\n\n*Service:* ${m0.name}\n*Price:* ${rand(m0.price)}\n*When:* ${c.day} at ${t[2]}\n\nReply *yes* to confirm, or *no* to cancel.`,
          chips: ["✅ Yes", "❌ No"],
        },
        { from: "me", text: "✅ Yes" },
        {
          from: "bot",
          text: `You’re booked, ${c.name}! 🎉\n\n*${m0.name}* on ${c.day} at ${t[2]}\nReference: *${c.ref}*\n\nSee you then!`,
        },
      ],
    },
    {
      tab: "Join the queue",
      caption: "A walk-in joins from the street, then waits wherever they like. They are messaged when it’s nearly their turn.",
      messages: [
        { from: "me", text: "🚶 Join the queue" },
        {
          from: "bot",
          text: `Hi ${c.name}, you’re in the queue at ${x.shop} for ${m0.name}. Your ticket is ${c.ticket}. There are ${c.ahead} people ahead of you, with an estimated wait of ${c.waitMin} minutes. We’ll message you when it’s nearly your turn.`,
        },
        { from: "note", text: "20 minutes later" },
        {
          from: "bot",
          text: `Hi ${c.name}, you’re nearly up at ${x.shop}. There are 2 people ahead of you, so please make your way to us now.`,
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
      caption: `${c.day} is fully booked. Instead of losing the customer, the shop keeps them. When someone cancels, they hear first.`,
      messages: [
        { from: "bot", text: dayMenu },
        { from: "me", text: "3" },
        {
          from: "bot",
          text: `${c.day} is fully booked, sorry! Want us to message you on WhatsApp if a time opens up?`,
          chips: ["🔔 Notify me", "No thanks"],
        },
        { from: "me", text: "🔔 Notify me" },
        { from: "bot", text: `Done ✅ You’re on the waitlist for ${c.day}. We’ll message you if a time opens up.` },
        { from: "note", text: `${c.day} 16:12 · another customer cancels` },
        { from: "bot", text: `Hi ${c.name}, a time may have opened up at ${x.shop} on ${c.day}. Reply *book* to see available times.` },
        { from: "me", text: "book" },
        { from: "bot", text: `Available times for *${m0.name}* on ${c.day}:\n\n1. ${t[2]}\n\nReply with a number.` },
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
  const scenarios = useMemo(() => buildScenarios(industry), [industry])
  const [active, setActive] = useState(0)
  const [shown, setShown] = useState(1)
  const [run, setRun] = useState(0)
  const [onScreen, setOnScreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scenario = scenarios[active]
  const total = scenario.messages.length
  const shop = industry.shop

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
    if (!onScreen) return
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
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [shown])

  return (
    <div ref={rootRef} className={styles.demoGrid}>
      <div>
        <div className={styles.demoTabs} role="tablist" aria-label="Example conversations">
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
          <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} onClick={() => {
              setRun((r) => r + 1)
              choose(industry.id)
            }}>
            Replay
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} onClick={() => {
              setShown(total)
              choose(industry.id)
            }}>
            Show the whole chat
          </button>
        </div>
        <p className={styles.demoFine}>An example conversation. Names, prices and times are made up.</p>
      </div>

      <div className={styles.phone} aria-label={`WhatsApp chat with ${shop}`}>
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
              <div key={`${active}-${run}-${i}`} className={m.from === "me" ? styles.rowMe : styles.rowBot}>
                <div className={m.from === "me" ? `${styles.bubble} ${styles.bubbleMe}` : `${styles.bubble} ${styles.bubbleBot}`}>
                  {rich(m.text)}
                </div>
                {m.chips && (
                  <div className={styles.chips}>
                    {m.chips.map((c) => (
                      <span key={c} className={styles.chip}>
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}
