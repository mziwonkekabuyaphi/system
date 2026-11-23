"use client"

// app/admin/payments/PaymentRulesSection.tsx
//
// "Payment rules" inside Settings > Payments: when customers pay, deposit,
// payment deadline and refund policy, set separately for Bookings and Orders.
// Rendered by PaymentsPanel once a card provider is connected. Loads and saves
// through policy-actions.ts, which validates again on the server.

import { useCallback, useEffect, useMemo, useState } from "react"

import { loadPaymentPolicies, updatePaymentPolicy } from "./policy-actions"
import type { DepositType, PaymentPolicies, PaymentPolicy, PaymentScope, PaymentTiming, RefundMode } from "./policy-types"
import { BTN_GHOST, BTN_PRIMARY, INPUT, LABEL, WELL } from "../events/ui"

type Unit = "minutes" | "hours" | "days"
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 }

interface Form {
  timing: PaymentTiming
  depositType: DepositType
  depositValue: string
  deadlineValue: string
  deadlineUnit: Unit
  refundMode: RefundMode | ""
  refundPercent: string
  refundNote: string
}

const SCOPE_LABEL: Record<PaymentScope, string> = { booking: "Bookings", order: "Orders" }

const TIMING_LABEL: Record<PaymentScope, Record<PaymentTiming, string>> = {
  booking: {
    full: "Pay in full when booking",
    deposit: "Pay a deposit when booking",
    after_service: "Pay after the service",
  },
  order: {
    full: "Pay in full when ordering",
    deposit: "Pay a deposit when ordering",
    after_service: "Pay on collection or delivery",
  },
}

const REFUND_OPTIONS: Array<{ value: RefundMode | ""; label: string }> = [
  { value: "", label: "Not stated" },
  { value: "full", label: "Full refund" },
  { value: "partial", label: "Partial refund" },
  { value: "none", label: "No refund" },
]

const PILL_ON = "border-transparent bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_16%,transparent)] text-stone-900"
const PILL_OFF = "border-stone-200 text-stone-600 hover:bg-stone-500/10"
const pill = (on: boolean) =>
  `rounded-full border px-4 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${on ? PILL_ON : PILL_OFF}`

function toForm(p: PaymentPolicy): Form {
  const minutes = p.paymentDeadlineMinutes
  let deadlineValue = ""
  let deadlineUnit: Unit = "hours"
  if (minutes !== null) {
    if (minutes % 1440 === 0) { deadlineValue = String(minutes / 1440); deadlineUnit = "days" }
    else if (minutes % 60 === 0) { deadlineValue = String(minutes / 60); deadlineUnit = "hours" }
    else { deadlineValue = String(minutes); deadlineUnit = "minutes" }
  }
  return {
    timing: p.paymentTiming,
    depositType: p.depositType ?? "percentage",
    depositValue: p.depositValue === null ? "" : String(p.depositValue),
    deadlineValue,
    deadlineUnit,
    refundMode: p.refundMode ?? "",
    refundPercent: p.refundPercent === null ? "" : String(p.refundPercent),
    refundNote: p.refundNote ?? "",
  }
}

function toPolicy(f: Form): PaymentPolicy {
  return {
    paymentTiming: f.timing,
    depositType: f.timing === "deposit" ? f.depositType : null,
    depositValue: f.timing === "deposit" && f.depositValue.trim() !== "" ? Number(f.depositValue) : null,
    paymentDeadlineMinutes:
      f.timing !== "after_service" && f.deadlineValue.trim() !== "" ? Number(f.deadlineValue) * UNIT_MINUTES[f.deadlineUnit] : null,
    refundMode: f.refundMode === "" ? null : f.refundMode,
    refundPercent: f.refundMode === "partial" && f.refundPercent.trim() !== "" ? Number(f.refundPercent) : null,
    refundNote: f.refundNote.trim() || null,
  }
}

export function PaymentRulesSection() {
  const [policies, setPolicies] = useState<PaymentPolicies | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scope, setScope] = useState<PaymentScope>("booking")
  const [forms, setForms] = useState<Record<PaymentScope, Form> | null>(null)
  const [baselines, setBaselines] = useState<Record<PaymentScope, string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await loadPaymentPolicies()
    if (!res.ok) return setLoadError(res.error)
    const next = { booking: toForm(res.data.booking), order: toForm(res.data.order) }
    setPolicies(res.data)
    setForms(next)
    setBaselines({ booking: JSON.stringify(next.booking), order: JSON.stringify(next.order) })
  }, [])

  useEffect(() => { void load() }, [load])

  const form = forms?.[scope] ?? null
  const dirty = useMemo(() => (form && baselines ? JSON.stringify(form) !== baselines[scope] : false), [form, baselines, scope])

  if (loadError) return <p role="alert" className="text-sm text-red-600">{loadError}</p>
  if (!policies || !forms || !baselines || !form) return <div className="h-32 animate-pulse rounded-2xl bg-stone-500/10" aria-busy="true" />

  const cardOk = policies.cardConnected
  const paysUpFront = form.timing !== "after_service"

  function patch(change: Partial<Form>) {
    setForms((f) => (f ? { ...f, [scope]: { ...f[scope], ...change } } : f))
    setError(null)
    setDone(null)
  }

  function switchScope(next: PaymentScope) {
    setScope(next)
    setError(null)
    setDone(null)
  }

  async function save() {
    if (!form) return
    setBusy(true)
    setError(null)
    setDone(null)
    const res = await updatePaymentPolicy(scope, toPolicy(form))
    setBusy(false)
    if (!res.ok) return setError(res.error)
    const saved = toForm(res.data)
    setForms((f) => (f ? { ...f, [scope]: saved } : f))
    setBaselines((b) => (b ? { ...b, [scope]: JSON.stringify(saved) } : b))
    setDone(`${SCOPE_LABEL[scope]} payment rules saved.`)
  }

  return (
    <div className="space-y-5 border-t border-stone-200 pt-5">
      <div>
        <h3 className="text-sm font-bold text-stone-900">Payment rules</h3>
        <p className="mt-1 max-w-xl text-xs text-stone-500">Choose when customers pay and what happens if they cancel. Set separately for bookings and orders.</p>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Payment rules for">
        {(["booking", "order"] as PaymentScope[]).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={scope === s} className={pill(scope === s)} onClick={() => switchScope(s)}>
            {SCOPE_LABEL[s]}
          </button>
        ))}
      </div>

      <fieldset className="space-y-2">
        <legend className={LABEL}>When customers pay</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment timing">
          {(["full", "deposit", "after_service"] as PaymentTiming[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={form.timing === t}
              disabled={busy || (t !== "after_service" && !cardOk)}
              className={pill(form.timing === t)}
              onClick={() => patch({ timing: t })}
            >
              {TIMING_LABEL[scope][t]}
            </button>
          ))}
        </div>
        {!cardOk && <p className="text-xs text-amber-600">Connect a card payment provider to ask for payment up front.</p>}
      </fieldset>

      {form.timing === "deposit" && (
        <div className={`${WELL} space-y-3 p-3`}>
          <fieldset className="space-y-2">
            <legend className={LABEL}>Deposit type</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Deposit type">
              {([["fixed", "Fixed amount"], ["percentage", "Percentage"]] as Array<[DepositType, string]>).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={form.depositType === value} disabled={busy} className={pill(form.depositType === value)} onClick={() => patch({ depositType: value })}>
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1">
            <label className={LABEL} htmlFor={`pay-deposit-${scope}`}>{form.depositType === "fixed" ? "Deposit amount (R)" : "Deposit (% of the total)"}</label>
            <input
              id={`pay-deposit-${scope}`}
              type="number"
              inputMode="decimal"
              min={0}
              max={form.depositType === "percentage" ? 100 : undefined}
              step={form.depositType === "percentage" ? 1 : 0.01}
              className={INPUT}
              value={form.depositValue}
              disabled={busy}
              onChange={(e) => patch({ depositValue: e.target.value })}
            />
            <p className="text-xs text-stone-500">The customer pays this now and the rest {scope === "booking" ? "at the appointment" : "on collection or delivery"}.</p>
          </div>
        </div>
      )}

      {paysUpFront && (
        <div className="space-y-1">
          <label className={LABEL} htmlFor={`pay-deadline-${scope}`}>Payment deadline</label>
          <div className="flex gap-2">
            <input
              id={`pay-deadline-${scope}`}
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="No deadline"
              className={`${INPUT} max-w-[9rem]`}
              value={form.deadlineValue}
              disabled={busy}
              onChange={(e) => patch({ deadlineValue: e.target.value })}
            />
            <select aria-label="Deadline unit" className={`${INPUT} max-w-[8rem]`} value={form.deadlineUnit} disabled={busy} onChange={(e) => patch({ deadlineUnit: e.target.value as Unit })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
          <p className="text-xs text-stone-500">How long a customer has to pay before the {scope === "booking" ? "booking" : "order"} is released. Leave blank for no deadline (5 minutes to 7 days).</p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className={LABEL}>Refund policy</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Refund policy">
          {REFUND_OPTIONS.map((o) => (
            <button key={o.value || "unset"} type="button" role="radio" aria-checked={form.refundMode === o.value} disabled={busy} className={pill(form.refundMode === o.value)} onClick={() => patch({ refundMode: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
        {form.refundMode === "partial" && (
          <div className="space-y-1">
            <label className={LABEL} htmlFor={`pay-refund-${scope}`}>Refund (% of what was paid)</label>
            <input id={`pay-refund-${scope}`} type="number" inputMode="numeric" min={1} max={99} step={1} className={`${INPUT} max-w-[9rem]`} value={form.refundPercent} disabled={busy} onChange={(e) => patch({ refundPercent: e.target.value })} />
          </div>
        )}
        {form.refundMode !== "" && (
          <div className="space-y-1">
            <label className={LABEL} htmlFor={`pay-refund-note-${scope}`}>Note for customers (optional)</label>
            <textarea id={`pay-refund-note-${scope}`} rows={3} maxLength={500} className={INPUT} value={form.refundNote} disabled={busy} onChange={(e) => patch({ refundNote: e.target.value })} />
          </div>
        )}
        <p className="text-xs text-stone-500">
          {scope === "booking"
            ? "Refunds are still made in your payment provider's portal. For bookings, the cut-off is your cancellation window in Booking rules."
            : "Refunds are still made in your payment provider's portal."}
        </p>
      </fieldset>

      {error && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      {done && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">{done}</p>}

      <div className="flex gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save payment rules"}
        </button>
        <button
          type="button"
          className={BTN_GHOST}
          disabled={busy || !dirty}
          onClick={() => baselines && setForms((f) => (f ? { ...f, [scope]: JSON.parse(baselines[scope]) as Form } : f))}
        >
          Discard
        </button>
      </div>
    </div>
  )
}
