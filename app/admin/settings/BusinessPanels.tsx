"use client"

import { useState, useTransition } from "react"

import {
  updateBusinessHours,
  updateGeneralInfo,
} from "../settings-actions"
import type {
  AdminBusinessHours,
  AdminTenantSettings,
} from "../types"
import {
  FieldRow,
  SaveRow,
  inputClass,
} from "./ui"

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// ---------------------------------------------------------------------------
// Business Info (formerly "General info")
// ---------------------------------------------------------------------------
export function BusinessInfoPanel({ initial }: { initial: AdminTenantSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateGeneralInfo(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Contact &amp; defaults</p>
      <p className="text-sm text-stone-500">Contact details and defaults shown to customers.</p>

      <div className="mt-4 space-y-3">
        <FieldRow
          label="Timezone"
          hint="Used everywhere a time is shown or calculated for customers — booking availability, cancellation cutoffs, and confirmations all use this."
        >
          <input
            className={inputClass}
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Currency">
          <input
            className={inputClass}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Contact email">
          <input
            className={inputClass}
            value={form.contactEmail ?? ""}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Contact phone">
          <input
            className={inputClass}
            value={form.contactPhone ?? ""}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Address">
          <textarea
            className={inputClass}
            rows={2}
            value={form.address ?? ""}
            onChange={(e) => setForm({ ...form, address: e.target.value || null })}
          />
        </FieldRow>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Opening Hours — controls what the kiosk and WhatsApp bot will accept.
// Times are entered in the tenant's own timezone (set above in Business
// Info) — the DB compares against that same timezone when deciding whether
// a walk-in or booking is allowed right now.
// ---------------------------------------------------------------------------
export function OpeningHoursPanel({ initial }: { initial: AdminBusinessHours }) {
  const [days, setDays] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function updateDay(dayOfWeek: number, patch: Partial<AdminBusinessHours[number]>) {
    setDays((prev) => prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)))
  }

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBusinessHours(days)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  const sorted = [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Opening Hours</p>
      <p className="text-sm text-stone-500">
        Controls when customers can join the queue on the kiosk or start a booking over WhatsApp. Times are in the
        timezone set above.
      </p>

      <div className="mt-4 space-y-2">
        {sorted.map((day) => (
          <div key={day.dayOfWeek} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2">
            <span className="w-24 shrink-0 text-sm font-medium text-stone-800">{DAY_LABELS[day.dayOfWeek]}</span>

            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input
                type="checkbox"
                checked={day.isClosed}
                onChange={(e) =>
                  updateDay(day.dayOfWeek, {
                    isClosed: e.target.checked,
                    openTime: e.target.checked ? null : day.openTime ?? "09:00",
                    closeTime: e.target.checked ? null : day.closeTime ?? "17:00",
                  })
                }
              />
              Closed
            </label>

            {!day.isClosed && (
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  className={`${inputClass} w-32`}
                  value={day.openTime ?? ""}
                  onChange={(e) => updateDay(day.dayOfWeek, { openTime: e.target.value })}
                />
                <span className="text-sm text-stone-400">to</span>
                <input
                  type="time"
                  className={`${inputClass} w-32`}
                  value={day.closeTime ?? ""}
                  onChange={(e) => updateDay(day.dayOfWeek, { closeTime: e.target.value })}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}
