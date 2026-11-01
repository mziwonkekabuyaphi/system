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
  SettingsCard,
  inputClass,
} from "./ui"

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** Today's weekday (0 = Sunday) in the shop's timezone. Falls back to the device's day if the timezone isn't valid. */
export function todayIndex(timezone: string): number {
  try {
    const short = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(new Date())
    const i = DAY_SHORT.indexOf(short)
    if (i >= 0) return i
  } catch {
    // an unknown timezone name: use the device's day below
  }
  return new Date().getDay()
}

// ---------------------------------------------------------------------------
// Business Info (formerly "General info")
// ---------------------------------------------------------------------------
export function BusinessInfoPanel({
  initial,
  onSaved,
}: {
  initial: AdminTenantSettings
  /** Lets the page keep its summary tiles in step after a successful save. */
  onSaved?: (next: AdminTenantSettings) => void
}) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateGeneralInfo(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
      if (result.success) onSaved?.(form)
    })
  }

  return (
    <SettingsCard title="Contact & defaults" description="Contact details and defaults shown to customers.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
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
        </div>
        <FieldRow label="Currency">
          <input
            className={inputClass}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Contact phone">
          <input
            className={inputClass}
            value={form.contactPhone ?? ""}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value || null })}
          />
        </FieldRow>
        <div className="sm:col-span-2">
          <FieldRow label="Contact email">
            <input
              className={inputClass}
              value={form.contactEmail ?? ""}
              onChange={(e) => setForm({ ...form, contactEmail: e.target.value || null })}
            />
          </FieldRow>
        </div>
        <div className="sm:col-span-2">
          <FieldRow label="Address">
            <textarea
              className={inputClass}
              rows={2}
              value={form.address ?? ""}
              onChange={(e) => setForm({ ...form, address: e.target.value || null })}
            />
          </FieldRow>
        </div>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </SettingsCard>
  )
}

// ---------------------------------------------------------------------------
// Opening Hours — controls what the kiosk and WhatsApp bot will accept.
// Times are entered in the tenant's own timezone (set above in Business
// Info) — the DB compares against that same timezone when deciding whether
// a walk-in or booking is allowed right now.
// ---------------------------------------------------------------------------
export function OpeningHoursPanel({
  initial,
  timezone,
  onSaved,
}: {
  initial: AdminBusinessHours
  /** The shop's timezone, only used to mark which row is today. */
  timezone?: string
  /** Lets the page keep its summary tiles in step after a successful save. */
  onSaved?: (next: AdminBusinessHours) => void
}) {
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
      if (result.success) onSaved?.(days)
    })
  }

  const sorted = [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
  const today = timezone ? todayIndex(timezone) : -1

  return (
    <SettingsCard
      title="Opening Hours"
      description="Controls when customers can join the queue on the kiosk or start a booking over WhatsApp. Times are in the timezone set above."
    >
      <div className="space-y-2">
        {sorted.map((day) => {
          const isToday = day.dayOfWeek === today
          return (
            <div
              key={day.dayOfWeek}
              className={`flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border bg-canvas px-3 py-2 ${
                isToday ? "border-line border-l-[3px] border-l-accent" : "border-line"
              }`}
            >
              <span className="w-24 shrink-0 text-sm font-medium text-ink">
                {DAY_LABELS[day.dayOfWeek]}
                {isToday && <span className="block text-[10px] font-semibold uppercase tracking-wide text-accent">Today</span>}
              </span>

              <label className="flex w-[4.5rem] cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
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
                    className={`${inputClass} !w-[7.25rem] !px-2`}
                    value={day.openTime ?? ""}
                    onChange={(e) => updateDay(day.dayOfWeek, { openTime: e.target.value })}
                  />
                  <span className="text-sm text-ink-muted">to</span>
                  <input
                    type="time"
                    className={`${inputClass} !w-[7.25rem] !px-2`}
                    value={day.closeTime ?? ""}
                    onChange={(e) => updateDay(day.dayOfWeek, { closeTime: e.target.value })}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </SettingsCard>
  )
}
