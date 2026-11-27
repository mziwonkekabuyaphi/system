"use client"

// app/demo/AiKeyDemo.tsx
//
// An interactive mock of Settings > AI: the owner brings their own Claude or OpenAI key, switches the AI on
// and sets a monthly limit, and the WhatsApp reply changes from the standard menu to a natural answer.
// Nothing typed in the key box leaves the page. Every number below is made up.

import { useState } from "react"
import styles from "./liveExtras.module.css"

type Provider = "anthropic" | "openai"

const PROVIDERS: Array<{ id: Provider; label: string; placeholder: string }> = [
  { id: "anthropic", label: "Claude (Anthropic)", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", placeholder: "sk-…" },
]

const LIMITS = [100, 250, 500]
const MONTH_COST = 38.2
const REQUESTS = 412

const rand = (n: number) => `R${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function AiKeyDemo() {
  const [provider, setProvider] = useState<Provider>("anthropic")
  const [key, setKey] = useState("")
  const [saved, setSaved] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [limit, setLimit] = useState(250)
  const [reached, setReached] = useState(false)

  const active = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0]
  const aiOn = saved && enabled && !reached
  const pct = Math.min(100, Math.round(((reached ? limit : MONTH_COST) / limit) * 100))

  function save() {
    if (key.trim().length < 4) return
    setSaved(true)
  }

  function remove() {
    setSaved(false)
    setKey("")
    setReached(false)
  }

  return (
    <div className={styles.pair}>
      <div className={styles.card}>
        <span className={styles.cardTitle}>Settings · AI</span>
        <span className={styles.cardSub}>Use your own AI account for the WhatsApp assistant. You pay your provider directly.</span>

        <span className={styles.group}>Provider</span>
        <div className={styles.row} role="radiogroup" aria-label="AI provider">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={provider === p.id}
              className={styles.pill}
              aria-pressed={provider === p.id}
              onClick={() => {
                setProvider(p.id)
                setSaved(false)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <span className={styles.group}>{active.label} API key</span>
        <div className={styles.keyRow}>
          <input
            className={styles.input}
            type="password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setSaved(false)
            }}
            placeholder={active.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${active.label} API key (demo only)`}
          />
          {saved ? (
            <button type="button" className={styles.ghostBtn} onClick={remove}>Remove key</button>
          ) : (
            <button type="button" className={styles.primaryBtn} disabled={key.trim().length < 4} onClick={save}>Save key</button>
          )}
        </div>
        <span className={styles.hint}>
          {saved
            ? `Saved. Only the last 4 characters (…${key.trim().slice(-4)}) are ever shown again.`
            : "Type anything to try it. Nothing you type here is sent or stored. In your dashboard the key is saved encrypted."}
        </span>

        <span className={styles.group}>AI configuration</span>
        <button type="button" className={styles.switchRow} role="switch" aria-checked={enabled} onClick={() => setEnabled((e) => !e)}>
          <span className={styles.switchBox} data-on={enabled} aria-hidden="true"><i /></span>
          <span>
            <span className={styles.optTitle}>Enable AI</span>
            <span className={styles.optText}>Understands customer messages and answers questions. When off, customers get the standard menu.</span>
          </span>
        </button>

        <span className={styles.group}>Monthly spending limit</span>
        <div className={styles.row}>
          {LIMITS.map((l) => (
            <button key={l} type="button" className={styles.pill} aria-pressed={limit === l} onClick={() => { setLimit(l); setReached(false) }}>R{l}</button>
          ))}
        </div>
        <div className={styles.meter} role="img" aria-label={`${pct}% of the monthly limit used`}>
          <i style={{ width: `${pct}%` }} data-full={reached} />
        </div>
        <span className={styles.hint}>
          {reached
            ? `Limit reached (${rand(limit)}). AI pauses by itself until next month or until you raise the limit.`
            : `Example month: ${rand(MONTH_COST)} of ${rand(limit)} used, across ${REQUESTS} AI requests. AI pauses by itself at the limit.`}
        </span>
        <div className={styles.row} style={{ marginTop: 10 }}>
          <button type="button" className={styles.ghostBtn} onClick={() => setReached((r) => !r)}>
            {reached ? "Raise the limit again" : "Simulate reaching the limit"}
          </button>
        </div>
      </div>

      <div className={styles.phoneWrap}>
        <div className={styles.phone} aria-live="polite">
          <div className={styles.phoneHead}>Mzido&rsquo;s Barbershop</div>
          <div className={styles.chat}>
            <span className={`${styles.bubble} ${styles.me}`}>Hi, any space for a haircut Saturday morning? And are you open late on weekdays?</span>
            {aiOn ? (
              <>
                <span className={styles.bubble}>Hi! Saturday morning we have 09:00, 09:30 and 10:30 free for a haircut. On weekdays we close at 18:00. Want me to book one of those?</span>
                <span className={styles.chips}>
                  <span className={styles.chip}>09:00</span>
                  <span className={styles.chip}>09:30</span>
                  <span className={styles.chip}>10:30</span>
                </span>
              </>
            ) : (
              <span className={styles.bubble}>
                Welcome to Mzido&rsquo;s Barbershop! Reply 1 to book a time, 2 to join the queue, or 3 for our opening hours.
              </span>
            )}
          </div>
        </div>
        <span className={styles.status} data-on={aiOn}>
          {aiOn
            ? `AI on · ${active.label} · understands free text`
            : !saved
              ? "No key yet · customers get the standard menu"
              : reached
                ? "Paused at the limit · customers get the standard menu"
                : "AI switched off · customers get the standard menu"}
        </span>
        <span className={styles.fine}>An example chat and example usage. Names and numbers are made up.</span>
      </div>
    </div>
  )
}
