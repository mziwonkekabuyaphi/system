// app/platform/pricing/PricingEditor.tsx
"use client"

import { useState, useTransition, type ReactNode } from "react"

import { PLATFORM_CARD } from "@/components/platform/PageHeader"
import { updateBookingQueuePlan, updateFreePlan, updateShishaRates, updateStaffRates } from "./actions"

export type PlanRow = {
  key: string
  name: string
  priceRands: string
  includedStaff: string
  extraStaffRands: string
  staffLimit: string
  visitsPerStaff: string
  perVisitRands: string
  visitLimit: string
  updatedAt: string | null
}
export type StaffRates = { staff: string; payroll: string; shifts: string }
export type ShishaRates = { sessionFee: string; refillFee: string }

type Msg = { ok: boolean; text: string } | null

const inputCls = "w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm tabular-nums focus:border-stone-500 focus:outline-none"
const btn = "rounded-lg bg-stone-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"

const fmt = (s: string) => {
  const n = Number(s)
  return Number.isFinite(n) && s !== "" ? `R${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}` : "—"
}

function Field({ label, hint, prefix, suffix, value, onChange, placeholder }: {
  label: string
  hint?: string
  prefix?: string
  suffix?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-stone-600">{label}</span>
      <span className="flex items-center gap-1.5">
        {prefix && <span className="text-sm text-stone-500">{prefix}</span>}
        <input className={inputCls} inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        {suffix && <span className="whitespace-nowrap text-xs text-stone-500">{suffix}</span>}
      </span>
      {hint && <span className="mt-1 block text-[11px] text-stone-400">{hint}</span>}
    </label>
  )
}

function Section({ title, blurb, children }: { title: string; blurb: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
        <p className="text-xs text-stone-500">{blurb}</p>
      </div>
      {children}
    </section>
  )
}

function SaveBar({ busy, msg, onSave, label = "Save prices" }: { busy: boolean; msg: Msg; onSave: () => void; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-3">
      <button type="button" className={btn} disabled={busy} onClick={onSave}>{busy ? "Saving…" : label}</button>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</p>}
    </div>
  )
}

/** Runs a save action and turns its result into a message. */
function useSave() {
  const [busy, start] = useTransition()
  const [msg, setMsg] = useState<Msg>(null)
  const run = (fn: () => Promise<{ success: true } | { success: false; error: string }>) => {
    setMsg(null)
    start(async () => {
      const res = await fn()
      setMsg(res.success ? { ok: true, text: "Saved. New prices apply to future billing." } : { ok: false, text: res.error })
    })
  }
  return { busy, msg, run }
}

// ── Booking & Queue ──────────────────────────────────────────────────────────

function PaidPlanCard({ plan }: { plan: PlanRow }) {
  const [v, setV] = useState(plan)
  const { busy, msg, run } = useSave()
  const set = (k: keyof PlanRow) => (val: string) => setV((cur) => ({ ...cur, [k]: val }))

  return (
    <div className={`${PLATFORM_CARD} space-y-4 p-5`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-stone-900">{plan.name}</h3>
        <p className="text-xs text-stone-400">Now {fmt(plan.priceRands)} / month</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Monthly price" prefix="R" value={v.priceRands} onChange={set("priceRands")} suffix="/ month" />
        <Field label="Staff included" value={v.includedStaff} onChange={set("includedStaff")} suffix="staff" />
        <Field label="Price per extra staff" prefix="R" value={v.extraStaffRands} onChange={set("extraStaffRands")} suffix="/ month" />
        <Field label="Staff limit" value={v.staffLimit} onChange={set("staffLimit")} placeholder="No limit" hint="Leave blank for no limit." />
        <Field label="Visits included per staff" value={v.visitsPerStaff} onChange={set("visitsPerStaff")} suffix="/ month" />
        <Field label="Price per extra visit" prefix="R" value={v.perVisitRands} onChange={set("perVisitRands")} suffix="/ visit" hint="Charged once a shop passes its included visits." />
      </div>
      <SaveBar
        busy={busy}
        msg={msg}
        onSave={() =>
          run(() =>
            updateBookingQueuePlan({
              key: plan.key,
              priceRands: v.priceRands,
              includedStaff: v.includedStaff,
              extraStaffRands: v.extraStaffRands,
              staffLimit: v.staffLimit,
              visitsPerStaff: v.visitsPerStaff,
              perVisitRands: v.perVisitRands,
            }),
          )
        }
      />
    </div>
  )
}

function FreePlanCard({ plan }: { plan: PlanRow }) {
  const [visitLimit, setVisitLimit] = useState(plan.visitLimit)
  const [includedStaff, setIncludedStaff] = useState(plan.includedStaff)
  const { busy, msg, run } = useSave()

  return (
    <div className={`${PLATFORM_CARD} space-y-4 p-5`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-stone-900">{plan.name} <span className="text-xs font-normal text-stone-400">(free plan)</span></h3>
        <p className="text-xs text-stone-400">R0, always</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Free visits, once off" value={visitLimit} onChange={setVisitLimit} suffix="visits" hint="Once used up, the shop is blocked until it upgrades." />
        <Field label="Staff included" value={includedStaff} onChange={setIncludedStaff} suffix="staff" />
      </div>
      <SaveBar busy={busy} msg={msg} label="Save" onSave={() => run(() => updateFreePlan({ visitLimit, includedStaff }))} />
    </div>
  )
}

// ── Staff Management ─────────────────────────────────────────────────────────

function StaffCard({ rates }: { rates: StaffRates }) {
  const [v, setV] = useState(rates)
  const { busy, msg, run } = useSave()
  return (
    <div className={`${PLATFORM_CARD} space-y-4 p-5`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Staff Management" prefix="R" value={v.staff} onChange={(x) => setV({ ...v, staff: x })} suffix="per staff / month" hint="Billed when sold on its own. Included with Booking, Queue and Shisha." />
        <Field label="Payroll add-on" prefix="R" value={v.payroll} onChange={(x) => setV({ ...v, payroll: x })} suffix="per staff / month" />
        <Field label="Shifts add-on" prefix="R" value={v.shifts} onChange={(x) => setV({ ...v, shifts: x })} suffix="per staff / month" />
      </div>
      <p className="text-[11px] text-stone-400">Today the monthly invoice run only bills the Staff Management fee. The Payroll and Shifts fees are saved here for when those get billed.</p>
      <SaveBar busy={busy} msg={msg} onSave={() => run(() => updateStaffRates(v))} />
    </div>
  )
}

// ── Shisha ───────────────────────────────────────────────────────────────────

function ShishaCard({ rates }: { rates: ShishaRates }) {
  const [v, setV] = useState(rates)
  const { busy, msg, run } = useSave()
  return (
    <div className={`${PLATFORM_CARD} space-y-4 p-5`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fee per session" prefix="R" value={v.sessionFee} onChange={(x) => setV({ ...v, sessionFee: x })} suffix="per session" hint="Charged when a shisha session starts." />
        <Field label="Fee per refill" prefix="R" value={v.refillFee} onChange={(x) => setV({ ...v, refillFee: x })} suffix="per refill" hint="Charged each time a session is refilled." />
      </div>
      <p className="text-[11px] text-stone-400">Sessions and refills already recorded keep the fee they were recorded at.</p>
      <SaveBar busy={busy} msg={msg} onSave={() => run(() => updateShishaRates(v))} />
    </div>
  )
}

export function PricingEditor({ plans, staff, shisha }: { plans: PlanRow[]; staff: StaffRates; shisha: ShishaRates }) {
  const free = plans.find((p) => p.key === "free")
  const paid = plans.filter((p) => p.key !== "free")

  return (
    <div className="space-y-8">
      <Section title="Booking & Queue" blurb="Monthly plans. A shop pays the monthly price, plus extra staff and extra visits beyond what's included.">
        <div className="grid gap-4 lg:grid-cols-2">
          {paid.map((p) => <PaidPlanCard key={p.key} plan={p} />)}
        </div>
        {free && <FreePlanCard plan={free} />}
      </Section>

      <Section title="Staff Management" blurb="Per active staff member, per month.">
        <StaffCard rates={staff} />
      </Section>

      <Section title="Shisha" blurb="Pay-as-you-go: a fee for each session and each refill. No monthly plan fee.">
        <ShishaCard rates={shisha} />
      </Section>
    </div>
  )
}
