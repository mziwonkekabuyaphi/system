"use client"

// app/demo/WhatsAppAdminDemo.tsx
//
// A playable copy of the "WhatsApp messages" settings card (app/admin/settings/WhatsAppTemplatesPanel.tsx):
// the messages a customer gets when they have NOT messaged the shop in the last 24 hours, such as
// someone who checked in at the kiosk. WhatsApp only allows those with a template Meta has approved.
//
// Visitors can switch each message on or off, reword it and watch the customer's phone update as
// they type, then "Submit to Meta": the status goes to "In review at Meta" and, a few seconds later,
// "Approved" (simulated: nothing is sent anywhere). Editing an approved message sends it back for
// review, just like the real thing. The shop, names and numbers come from the chosen industry
// (see industries.ts and IndustryContext.tsx). It is a demo: every name and number is made up.

import { useEffect, useRef, useState } from "react"
import admin from "./adminDemo.module.css"
import { useIndustry } from "./IndustryContext"
import type { Industry } from "./industries"

type TKey = "queue_joined" | "queue_almost_turn" | "queue_called" | "waitlist_slot_open"
type Status = "draft" | "pending" | "approved"
type Tpl = {
  key: TKey
  label: string
  when: string
  variables: string[]
  /** What's in the box right now. */
  body: string
  /** The wording Meta last saw. The box differs from it once the owner edits. */
  live: string
  enabled: boolean
  status: Status
}

const VARIABLE_LABELS: Record<string, string> = {
  customer_name: "customer’s first name",
  business_name: "your business name",
  service_name: "service",
  ticket: "ticket number",
  people_ahead: "people ahead",
  wait_minutes: "estimated wait (minutes)",
  booking_date: "the day they’re waiting for",
}

const STATUS_STYLE: Record<Status, { label: string; className: string }> = {
  draft: { label: "Not submitted", className: admin.stDraft },
  pending: { label: "In review at Meta", className: admin.stPending },
  approved: { label: "Approved", className: admin.stApproved },
}

const START: Array<Omit<Tpl, "live">> = [
  {
    key: "queue_joined",
    label: "Joined the queue",
    when: "Sent when someone joins the queue.",
    variables: ["customer_name", "business_name", "ticket", "people_ahead", "wait_minutes"],
    body: "Hi {{1}}, you’re in the queue at {{2}}. Your ticket is {{3}}. There are {{4}} people ahead of you and the wait is about {{5}} minutes.",
    enabled: true,
    status: "approved",
  },
  {
    key: "queue_almost_turn",
    label: "Nearly their turn",
    when: "Sent once, when they reach the “notify before turn” position in Queue rules.",
    variables: ["customer_name", "business_name", "ticket", "people_ahead"],
    body: "Hi {{1}}, you’re nearly up at {{2}}. Ticket {{3}} has {{4}} people ahead. Please head back to the shop.",
    enabled: true,
    status: "approved",
  },
  {
    key: "queue_called",
    label: "It’s their turn",
    when: "Sent when you call them from the queue.",
    variables: ["customer_name", "business_name", "ticket"],
    body: "Hi {{1}}, it’s your turn at {{2}}. Ticket {{3}}, please come to the counter.",
    enabled: true,
    status: "approved",
  },
  {
    key: "waitlist_slot_open",
    label: "A time opened up (waitlist)",
    when: "Sent when a booked time is freed up and this customer is next on the waitlist for that day.",
    variables: ["customer_name", "business_name", "booking_date"],
    body: "Hi {{1}}, a time just opened up at {{2}} for {{3}}. Reply to this message to book it.",
    enabled: true,
    status: "draft",
  },
]

const INITIAL: Tpl[] = START.map((t) => ({ ...t, live: t.body }))

/** Example values for the preview, from the chosen industry. */
function examples(x: Industry): Record<string, string> {
  return {
    customer_name: x.customer.split(" ")[0],
    business_name: x.shop,
    service_name: x.picked,
    ticket: x.ticket,
    people_ahead: String(x.chat.ahead),
    wait_minutes: String(x.chat.waitMin),
    booking_date: x.chat.day,
  }
}

function preview(t: Tpl, body: string, x: Industry): string {
  const values = examples(x)
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => values[t.variables[Number(n) - 1]] ?? "…")
}

// The real panel warns that promotional wording gets a template re-labelled "Marketing", which costs more.
const PROMO = /\b(sale|discount|offer|special|promo|deal|free|\d+\s?% ?off)\b/i

const REVIEW_MS = 2800

export function WhatsAppAdminDemo() {
  const { industry: x } = useIndustry()
  const [tpls, setTpls] = useState<Tpl[]>(INITIAL)
  const [selected, setSelected] = useState<TKey>("queue_joined")
  const [messages, setMessages] = useState<Partial<Record<TKey, string>>>({})
  const timers = useRef<Partial<Record<TKey, ReturnType<typeof setTimeout>>>>({})

  useEffect(() => {
    const t = timers.current
    return () => Object.values(t).forEach((id) => id && clearTimeout(id))
  }, [])

  const t = tpls.find((p) => p.key === selected) ?? tpls[0]
  const locked = t.status === "pending"
  const dirty = t.body !== t.live
  const promo = PROMO.test(t.body)
  const text = preview(t, t.body, x)

  function patch(key: TKey, change: Partial<Tpl>) {
    setTpls((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)))
  }
  function note(key: TKey, msg: string) {
    setMessages((m) => ({ ...m, [key]: msg }))
  }

  function toggle(p: Tpl) {
    patch(p.key, { enabled: !p.enabled })
    note(p.key, p.enabled ? "Turned off. Customers won’t get this message." : "Turned on.")
  }

  function submit(p: Tpl) {
    patch(p.key, { status: "pending", live: p.body })
    note(p.key, "Sent to Meta. Reviews usually take a few minutes.")
    const old = timers.current[p.key]
    if (old) clearTimeout(old)
    timers.current[p.key] = setTimeout(() => {
      patch(p.key, { status: "approved" })
      note(p.key, "Approved by Meta. Customers will now get this message.")
    }, REVIEW_MS)
  }

  // What the customer's phone would really do with this message right now.
  const delivered = t.enabled && t.status === "approved"
  const deliveryText = !t.enabled
    ? "Switched off: this customer won’t get this message."
    : t.status === "approved"
      ? "Delivered to customers who haven’t messaged you."
      : "Waiting for Meta’s approval. Until then, customers outside the 24-hour window won’t get this."

  return (
    <>
      <div className={admin.aHead}>
        <span className={admin.aTag}>In your dashboard · Settings › WhatsApp messages</span>
        <span className={admin.aLine}>
          Customers who check in at the kiosk have no open chat, so WhatsApp only lets you message them with wording Meta has approved.
          Edit it here and watch their phone.
        </span>
      </div>

      <div className={admin.tplLayout}>
        <div className={admin.aCard}>
          <span className={admin.aCardTitle}>Messages to customers who haven’t messaged you</span>
          <span className={admin.aCardSub}>Pick a message to read or reword it. The switch decides whether it’s sent at all.</span>

          <div className={admin.tplList}>
            {tpls.map((p) => (
              <div key={p.key} className={p.key === selected ? `${admin.tplRow} ${admin.tplRowOn}` : admin.tplRow}>
                <button type="button" className={admin.tplPick} aria-pressed={p.key === selected} onClick={() => setSelected(p.key)}>
                  <span className={admin.tplName}>{p.label}</span>
                  <span className={admin.tplWhen}>{p.when}</span>
                </button>
                <span className={`${admin.aStatus} ${STATUS_STYLE[p.status].className}`}>{STATUS_STYLE[p.status].label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.enabled}
                  aria-label={`Send “${p.label}” message`}
                  className={admin.aSwitch}
                  onClick={() => toggle(p)}
                />
              </div>
            ))}
          </div>

          <label className={admin.aField}>
            <span className={admin.aFieldLabel}>{`Wording: ${t.label}`}</span>
            <textarea
              className={admin.aInput}
              value={t.body}
              disabled={locked}
              maxLength={1024}
              onChange={(e) => patch(t.key, { body: e.target.value })}
            />
          </label>

          <p className={admin.aVars}>
            {t.variables.map((v, i) => (
              <span key={v}>
                <code>{`{{${i + 1}}}`}</code> {VARIABLE_LABELS[v] ?? v}
              </span>
            ))}
          </p>
          <p className={admin.aPreview}>
            <small>Preview: </small>
            {text}
          </p>

          {promo && (
            <p className={`${admin.aNote} ${admin.aNoteWarn}`}>
              Keep the wording factual. Promotional words like this can get a template re-labelled “Marketing”, which costs more.
            </p>
          )}
          {t.status === "approved" && dirty && (
            <p className={`${admin.aNote} ${admin.aNoteWarn}`}>
              Changing an approved template means Meta reviews it again. Until it’s approved, customers outside the 24-hour window
              won’t get this message.
            </p>
          )}
          {locked && <p className={admin.aNote}>This wording is with Meta, so it can’t be edited until the review is done.</p>}

          <div className={admin.aBtns}>
            {(t.status === "draft" || dirty) && (
              <button type="button" className={admin.aBtn} onClick={() => submit(t)} disabled={locked || !t.body.trim()}>
                Submit to Meta
              </button>
            )}
            {dirty && !locked && (
              <button type="button" className={`${admin.aBtn} ${admin.aBtnGhost}`} onClick={() => patch(t.key, { body: t.live })}>
                Discard changes
              </button>
            )}
            {messages[t.key] && <span className={admin.aMsg}>{messages[t.key]}</span>}
          </div>
        </div>

        <div className={admin.waWrap}>
          <span className={admin.waLabel}>What {x.customer.split(" ")[0]} sees</span>
          <div className={admin.waPhone}>
            <span className={admin.waNotch} aria-hidden="true" />
            <div className={admin.waHead}>
              <span className={admin.waAvatar}>{x.initial}</span>
              <span className={admin.waHeadText}>
                <span className={admin.waHeadName}>{x.shop}</span>
                <span className={admin.waHeadSub}>Business account</span>
              </span>
            </div>
            <div className={admin.waBody}>
              <span className={admin.waSys}>Checked in at the kiosk. No chat open with this shop yet.</span>
              <span key={`${x.id}-${t.key}`} className={delivered ? admin.waBubble : `${admin.waBubble} ${admin.waBubbleOff}`}>
                {text}
                <span className={admin.waTime}>09:41</span>
              </span>
            </div>
            <span className={admin.waHome} aria-hidden="true" />
          </div>
          <span className={delivered ? `${admin.waDelivery} ${admin.waOk}` : `${admin.waDelivery} ${admin.waNo}`} role="status">
            {deliveryText}
          </span>
        </div>
      </div>
    </>
  )
}
