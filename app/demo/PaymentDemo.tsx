"use client"

// app/demo/PaymentDemo.tsx
//
// An interactive mock of "Payment rules" (Settings > Payments + Booking rules) next to the WhatsApp
// chat it controls. Every name, price and time is made up. Nothing here takes a real payment.
// No <p>/<h*> tags inside the phone on purpose, so the page's global heading styles can't leak in.

import { useEffect, useState } from "react"
import styles from "./liveExtras.module.css"

type Timing = "full" | "deposit" | "after_service"
type DepositType = "percentage" | "fixed"
type Refund = "none_stated" | "full" | "partial" | "none"

const TOTAL = 300
const SERVICE = "haircut"
const SLOT = "Saturday at 10:30"

const TIMINGS: Array<{ id: Timing; title: string; text: string }> = [
  { id: "full", title: "Pay in full", text: "When they book" },
  { id: "deposit", title: "Pay a deposit", text: "When they book" },
  { id: "after_service", title: "Pay after", text: "The service" },
]

const DEADLINES: Array<{ id: string; label: string }> = [
  { id: "30 minutes", label: "30 min" },
  { id: "2 hours", label: "2 hours" },
  { id: "1 day", label: "1 day" },
]

const REFUNDS: Array<{ id: Refund; label: string }> = [
  { id: "none_stated", label: "Not stated" },
  { id: "full", label: "Full refund" },
  { id: "partial", label: "Partial (50%)" },
  { id: "none", label: "No refund" },
]

const rand = (n: number) => `R${n.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`

export function PaymentDemo() {
  const [timing, setTiming] = useState<Timing>("deposit")
  const [depositType, setDepositType] = useState<DepositType>("percentage")
  const [deadline, setDeadline] = useState("2 hours")
  const [refund, setRefund] = useState<Refund>("partial")
  const [approval, setApproval] = useState(false)
  // 0 nothing yet · 1 customer asks · 2 shop replies · 3 paid · 4 approved / final
  const [step, setStep] = useState(0)

  const deposit = depositType === "percentage" ? Math.round(TOTAL * 0.5) : 100
  const dueNow = timing === "full" ? TOTAL : timing === "deposit" ? deposit : 0

  // Changing any rule restarts the chat so the visitor sees the new wording.
  useEffect(() => setStep(0), [timing, depositType, deadline, refund, approval])

  // The first two lines play by themselves, then the visitor taps.
  useEffect(() => {
    if (step >= 2) return
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? 500 : 900)
    return () => clearTimeout(t)
  }, [step])

  const refundLine =
    refund === "full" ? "Refunds: full refund." : refund === "partial" ? "Refunds: 50% back if you cancel in time." : refund === "none" ? "Refunds: no refund." : ""

  const needsPay = dueNow > 0
  const paid = step >= 3
  const done = needsPay ? (approval ? step >= 4 : paid) : approval ? step >= 4 : false

  return (
    <div className={styles.pair}>
      <div className={styles.card}>
        <span className={styles.cardTitle}>Payment rules · Bookings</span>
        <span className={styles.cardSub}>Optional. Change a rule and watch the chat change. An example booking: a {rand(TOTAL)} {SERVICE}.</span>

        <span className={styles.group}>When customers pay</span>
        <div className={styles.opts3}>
          {TIMINGS.map((o) => (
            <button key={o.id} type="button" className={styles.opt} aria-pressed={timing === o.id} onClick={() => setTiming(o.id)}>
              <span className={styles.optTitle}>{o.title}</span>
              <span className={styles.optText}>{o.text}</span>
            </button>
          ))}
        </div>

        {timing === "deposit" && (
          <>
            <span className={styles.group}>Deposit</span>
            <div className={styles.row}>
              <button type="button" className={styles.pill} aria-pressed={depositType === "percentage"} onClick={() => setDepositType("percentage")}>Percentage (50%)</button>
              <button type="button" className={styles.pill} aria-pressed={depositType === "fixed"} onClick={() => setDepositType("fixed")}>Fixed amount (R100)</button>
            </div>
          </>
        )}

        {timing !== "after_service" && (
          <>
            <span className={styles.group}>Payment deadline</span>
            <div className={styles.row}>
              {DEADLINES.map((d) => (
                <button key={d.id} type="button" className={styles.pill} aria-pressed={deadline === d.id} onClick={() => setDeadline(d.id)}>{d.label}</button>
              ))}
            </div>
          </>
        )}

        <span className={styles.group}>Refund policy</span>
        <div className={styles.row}>
          {REFUNDS.map((r) => (
            <button key={r.id} type="button" className={styles.pill} aria-pressed={refund === r.id} onClick={() => setRefund(r.id)}>{r.label}</button>
          ))}
        </div>

        <span className={styles.group}>Approval</span>
        <button type="button" className={styles.switchRow} role="switch" aria-checked={approval} onClick={() => setApproval((a) => !a)}>
          <span className={styles.switchBox} data-on={approval} aria-hidden="true"><i /></span>
          <span>
            <span className={styles.optTitle}>Require approval before confirming</span>
            <span className={styles.optText}>You approve each booking yourself. If payment is required too, they pay first.</span>
          </span>
        </button>
      </div>

      <div className={styles.phoneWrap}>
        <div className={styles.phone} aria-live="polite">
          <div className={styles.phoneHead}>Mzido&rsquo;s Barbershop</div>
          <div className={styles.chat}>
            {step >= 1 && <span className={`${styles.bubble} ${styles.me}`}>Book me a {SERVICE} {SLOT}</span>}
            {step >= 2 && (
              <span className={styles.bubble}>
                {timing === "after_service"
                  ? approval
                    ? `Thanks! Your request for ${SLOT} is with the shop. Your time is held while they review it. You pay ${rand(TOTAL)} after your ${SERVICE}.`
                    : `You’re booked for ${SLOT}. You pay ${rand(TOTAL)} after your ${SERVICE}.`
                  : `Pay your ${timing === "deposit" ? `${rand(deposit)} deposit` : rand(TOTAL)} to confirm ${SLOT}. Your time is held for ${deadline}. ${refundLine}`}
              </span>
            )}
            {step === 2 && needsPay && (
              <button type="button" className={styles.chipBtn} onClick={() => setStep(3)}>Pay now (demo)</button>
            )}
            {paid && needsPay && <span className={`${styles.bubble} ${styles.system}`}>Payment of {rand(dueNow)} received.</span>}
            {paid && needsPay && approval && step < 4 && (
              <span className={styles.bubble}>Your request is with the shop for approval. We’ll message you as soon as it’s confirmed.</span>
            )}
            {done && <span className={`${styles.bubble} ${styles.ok}`}>✓ Booked: {SERVICE}, {SLOT}.</span>}
          </div>
        </div>

        {approval && ((needsPay && step === 3) || (!needsPay && step === 2)) && (
          <button type="button" className={styles.shopBtn} onClick={() => setStep(4)}>
            Shop view: approve this booking
          </button>
        )}
        <span className={styles.fine}>
          {needsPay && step < 3 ? `Not paid within ${deadline}? The time is released for someone else. ` : ""}
          An example chat. Names, prices and times are made up, and no real payment is taken.
        </span>
      </div>
    </div>
  )
}
