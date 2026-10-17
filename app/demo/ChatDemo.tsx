"use client"

// app/demo/ChatDemo.tsx
//
// A scripted WhatsApp conversation that plays out on the landing page, so a
// visitor sees what THEIR customers will see. It is a demo, not a live bot:
// every message is written in SCENARIOS below.
//
// The wording follows the real bot where we have it:
//   - menus and confirmations: lib/services/messages/booking.ts
//   - queue messages and the waitlist alert: the approved/pending WhatsApp
//     templates in the whatsapp_templates table
// Names, prices and times are made up. If you change the bot's wording, edit
// the matching line here so the demo stays honest.

import { useEffect, useRef, useState, type ReactNode } from "react"
import styles from "./demo.module.css"

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

const SHOP = "Thabo’s Barbershop"

const SCENARIOS: Scenario[] = [
  {
    tab: "Book a time",
    caption: "A customer books a haircut at 11pm. Nobody at the shop picked up a phone.",
    messages: [
      { from: "me", text: "Hi" },
      {
        from: "bot",
        text: "Would you like to book a specific time, or join today’s walk-in queue? 💈",
        chips: ["📅 Book a time", "🚶 Join the queue"],
      },
      { from: "me", text: "📅 Book a time" },
      {
        from: "bot",
        text: "Here’s what we offer 💈\n\n1. *Haircut* — R120 (30 min)\n2. *Beard trim* — R60 (20 min)\n3. *Haircut + beard* — R160 (45 min)\n\nReply with a number to pick a service.",
      },
      { from: "me", text: "1" },
      { from: "bot", text: "Which day works for you? 📅\n\n1. Today\n2. Tomorrow\n3. Saturday\n\nReply with a number." },
      { from: "me", text: "3" },
      {
        from: "bot",
        text: "Available times for *Haircut* on Saturday:\n\n1. 09:00\n2. 09:30\n3. 10:30\n4. 14:00\n\nReply with a number.",
      },
      { from: "me", text: "3" },
      {
        from: "bot",
        text: "Just to confirm ✅\n\n*Service:* Haircut\n*Price:* R120\n*When:* Saturday at 10:30\n\nReply *yes* to confirm, or *no* to cancel.",
        chips: ["✅ Yes", "❌ No"],
      },
      { from: "me", text: "✅ Yes" },
      { from: "bot", text: "You’re booked, Sipho! 🎉\n\n*Haircut* on Saturday at 10:30\nReference: *K7Q2XM*\n\nSee you then!" },
    ],
  },
  {
    tab: "Join the queue",
    caption: "A walk-in joins from the street, then waits wherever they like. They are messaged when it’s nearly their turn.",
    messages: [
      { from: "me", text: "🚶 Join the queue" },
      {
        from: "bot",
        text: `Hi Sipho, you’re in the queue at ${SHOP} for Haircut. Your ticket is A014. There are 3 people ahead of you, with an estimated wait of 25 minutes. We’ll message you when it’s nearly your turn.`,
      },
      { from: "note", text: "20 minutes later" },
      {
        from: "bot",
        text: `Hi Sipho, you’re nearly up at ${SHOP}. There are 2 people ahead of you, so please make your way to us now.`,
      },
      { from: "note", text: "5 minutes later" },
      {
        from: "bot",
        text: `Hi Sipho, it’s your turn at ${SHOP}. Your Ticket number A014, please come to the front now.`,
      },
    ],
  },
  {
    tab: "Day is full",
    caption: "Saturday is fully booked. Instead of losing the customer, the shop keeps them. When someone cancels, they hear first.",
    messages: [
      { from: "bot", text: "Which day works for you? 📅\n\n1. Today\n2. Tomorrow\n3. Saturday\n\nReply with a number." },
      { from: "me", text: "3" },
      {
        from: "bot",
        text: "Saturday is fully booked, sorry! Want us to message you on WhatsApp if a time opens up?",
        chips: ["🔔 Notify me", "No thanks"],
      },
      { from: "me", text: "🔔 Notify me" },
      { from: "bot", text: "Done ✅ You’re on the waitlist for Saturday. We’ll message you if a time opens up." },
      { from: "note", text: "Saturday 16:12 · another customer cancels" },
      { from: "bot", text: `Hi Sipho, a time may have opened up at ${SHOP} on Saturday. Reply *book* to see available times.` },
      { from: "me", text: "book" },
      { from: "bot", text: "Available times for *Haircut* on Saturday:\n\n1. 10:30\n\nReply with a number." },
    ],
  },
]

/** Turns *word* into bold, keeps line breaks (CSS pre-line does the rest). */
function rich(text: string): ReactNode[] {
  return text.split(/\*(.+?)\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

export function ChatDemo() {
  const [active, setActive] = useState(0)
  const [shown, setShown] = useState(1)
  const [run, setRun] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scenario = SCENARIOS[active]
  const total = scenario.messages.length

  // Reveal one message at a time. Reduced-motion visitors get the whole chat.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(total)
      return
    }
    setShown(1)
    let count = 1
    const timer = setInterval(() => {
      count += 1
      setShown(count)
      if (count >= total) clearInterval(timer)
    }, 1600)
    return () => clearInterval(timer)
  }, [active, run, total])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [shown])

  return (
    <div className={styles.demoGrid}>
      <div>
        <div className={styles.demoTabs} role="tablist" aria-label="Example conversations">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.tab}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={i === active ? `${styles.demoTab} ${styles.demoTabActive}` : styles.demoTab}
              onClick={() => {
                setActive(i)
                setRun((r) => r + 1)
              }}
            >
              {s.tab}
            </button>
          ))}
        </div>
        <p className={styles.demoCaption}>{scenario.caption}</p>
        <div className={styles.demoActions}>
          <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} onClick={() => setRun((r) => r + 1)}>
            Replay
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`} onClick={() => setShown(total)}>
            Show the whole chat
          </button>
        </div>
        <p className={styles.demoFine}>An example conversation. Names, prices and times are made up.</p>
      </div>

      <div className={styles.phone} aria-label={`WhatsApp chat with ${SHOP}`}>
        <div className={styles.phoneHead}>
          <span className={styles.phoneAvatar} aria-hidden="true">T</span>
          <span>
            <strong>{SHOP}</strong>
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
