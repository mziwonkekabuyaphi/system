"use client"

import { useState, useTransition } from "react"

import {
  updateBookingSettings,
  updateMessageSettings,
  updateQueueSettings,
} from "../settings-actions"
import type {
  AdminBookingSettings,
  AdminMessageSettings,
  AdminQueuePriorityMode,
  AdminQueueSettings,
} from "../types"
import {
  FieldRow,
  SaveRow,
  Toggle,
  inputClass,
} from "./ui"

// ---------------------------------------------------------------------------
const QUEUE_PRIORITY_MODE_OPTIONS: Array<{
  value: AdminQueuePriorityMode
  title: string
  description: string
}> = [
  {
    value: "fifo",
    title: "First come, first served",
    description: "A promoted booking is treated exactly like a walk-in, ordered by when it entered the queue.",
  },
  {
    value: "priority",
    title: "Honor appointment time",
    description:
      "A promoted booking is served at or before its actual appointment time wherever possible — even ahead of walk-ins who joined earlier.",
  },
  {
    value: "hybrid",
    title: "First come, but flag it",
    description:
      "Same order as \u201cFirst come, first served,\u201d but staff see a warning if a booking's wait would run past its appointment time.",
  },
]

export function BookingSettingsPanel({ initial }: { initial: AdminBookingSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBookingSettings(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">
              Link bookings to the queue
            </p>
            <p className="text-sm text-stone-500">
              When on, confirmed bookings automatically join the walk-in queue shortly before their start
              time, so front-of-house sees one unified line instead of two separate systems.
            </p>
          </div>
          <Toggle
            checked={form.unifyWithQueue}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, unifyWithQueue: next })}
          />
        </div>
        <p className="mt-3 text-xs text-stone-400">
          Checked automatically about once a minute — a booking won&apos;t appear in the queue instantly the
          moment it becomes eligible, but within about a minute of it. This doesn&apos;t change who&apos;s
          allowed to join the queue as a walk-in (see the Queue tab) — it only adds bookings alongside them.
        </p>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Timing &amp; cancellations</p>
        <p className="text-sm text-stone-500">Timing defaults for appointments at this location.</p>

        <div className="mt-4 space-y-3">
          <FieldRow
            label="Add to queue this many minutes before start time"
            hint="Calculated from each booking's start time, in your shop's timezone (Business Info tab) — not from when the booking was made."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.queueLeadTimeMinutes}
              onChange={(e) => setForm({ ...form, queueLeadTimeMinutes: Number(e.target.value) })}
            />
          </FieldRow>
          <FieldRow
            label="Minimum notice to book (minutes)"
            hint="Customers can't book an appointment sooner than this from right now. Enforced on every booking attempt, not just hidden in the time list."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.minNoticeMinutes}
              onChange={(e) => setForm({ ...form, minNoticeMinutes: Number(e.target.value) })}
            />
          </FieldRow>
          <FieldRow
            label="How far ahead customers can book (days)"
            hint="Customers can book up to and including this many days ahead, in your shop's timezone. Also still limited by your Opening Hours. Set to 0 for same-day booking only — the kiosk and booking flow then skip the date picker entirely and go straight to today's available times."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.maxAdvanceDays}
              onChange={(e) => setForm({ ...form, maxAdvanceDays: Number(e.target.value) })}
            />
          </FieldRow>
          <FieldRow
            label="Free cancellation window (minutes before start)"
            hint="Once a booking is inside this window, it can no longer be cancelled from the Today tab."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.cancellationWindowMinutes}
              onChange={(e) => setForm({ ...form, cancellationWindowMinutes: Number(e.target.value) })}
            />
          </FieldRow>
        </div>

        <SaveRow isPending={isPending} onSave={save} message={message} />
      </div>

      <div
        className={`rounded-2xl border border-stone-200 bg-white p-4 shadow-sm ${
          form.unifyWithQueue ? "" : "opacity-60"
        }`}
      >
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Queue priority</p>
        <p className="text-sm text-stone-500">
          How a promoted booking is ordered against walk-ins once it's in the queue.
          {!form.unifyWithQueue && " Only applies while \u201cLink bookings to the queue\u201d above is on."}
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {QUEUE_PRIORITY_MODE_OPTIONS.map((option) => {
            const selected = form.queuePriorityMode === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={!form.unifyWithQueue || isPending}
                onClick={() => setForm({ ...form, queuePriorityMode: option.value })}
                aria-pressed={selected}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed ${
                  selected
                    ? "border-[#7A2E3A] bg-[#7A2E3A]/5 ring-1 ring-[#7A2E3A]"
                    : "border-stone-300 bg-stone-50 hover:bg-stone-100 disabled:hover:bg-stone-50"
                }`}
              >
                <span className={`text-sm font-semibold ${selected ? "text-[#7A2E3A]" : "text-stone-800"}`}>
                  {option.title}
                </span>
                <span className="text-xs text-stone-500">{option.description}</span>
              </button>
            )
          })}
        </div>

        <SaveRow isPending={isPending} onSave={save} message={message} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
export function QueueSettingsPanel({
  initial,
  onSaved,
}: {
  initial: AdminQueueSettings
  onSaved?: (next: AdminQueueSettings) => void
}) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateQueueSettings(form)
      if (result.success) onSaved?.(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Walk-in line</p>
      <p className="text-sm text-stone-500">How the walk-in line behaves for this location.</p>

      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-stone-800">Auto-call next</p>
            <p className="text-sm text-stone-500">Automatically call the next customer when a slot frees up.</p>
          </div>
          <Toggle
            checked={form.autoCallNext}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, autoCallNext: next })}
          />
        </div>

        <FieldRow label="Maximum queue size (blank = no limit)">
          <input
            type="number"
            min={1}
            className={inputClass}
            value={form.maxQueueSize ?? ""}
            onChange={(e) => setForm({ ...form, maxQueueSize: e.target.value ? Number(e.target.value) : null })}
          />
        </FieldRow>

        <FieldRow label="Notify a customer this many people before their turn">
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.notifyBeforeTurnPosition}
            onChange={(e) => setForm({ ...form, notifyBeforeTurnPosition: Number(e.target.value) })}
          />
        </FieldRow>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-stone-800">Allow walk-ins via WhatsApp</p>
          <Toggle
            checked={form.allowWalkinWhatsapp}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, allowWalkinWhatsapp: next })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-stone-800">Allow walk-ins via kiosk</p>
          <Toggle
            checked={form.allowWalkinKiosk}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, allowWalkinKiosk: next })}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stone-100 pt-4">
          <div>
            <p className="text-sm font-medium text-stone-800">Require a service to join the queue</p>
            <p className="text-sm text-stone-500">
              Turn this off if walk-ins don&apos;t choose between services — they&apos;ll skip straight to giving
              their name and number on the kiosk, WhatsApp, and admin. You can also change this under Kiosk.
            </p>
          </div>
          <Toggle
            checked={form.requireServiceSelection}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, requireServiceSelection: next })}
          />
        </div>

        {!form.requireServiceSelection && (
          <FieldRow label="Estimated minutes to serve a walk-in with no service">
            <input
              type="number"
              min={1}
              className={inputClass}
              value={form.defaultServiceDurationMinutes}
              onChange={(e) =>
                setForm({ ...form, defaultServiceDurationMinutes: Number(e.target.value) })
              }
            />
          </FieldRow>
        )}

        <FieldRow label="Queue ticket number format">
          <input
            type="text"
            maxLength={4}
            placeholder="e.g. Q"
            className={inputClass}
            value={form.ticketNumberPrefix}
            onChange={(e) => setForm({ ...form, ticketNumberPrefix: e.target.value.toUpperCase() })}
          />
          <p className="text-sm text-stone-500 mt-1">
            Shown on printed kiosk tickets and WhatsApp confirmations — e.g. &quot;Q&quot; gives tickets like Q001,
            Q002. Use your own initials or a short word instead if you&apos;d rather not use Q (1–4 characters).
          </p>
        </FieldRow>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export function MessageSettingsPanel({ initial }: { initial: AdminMessageSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateMessageSettings(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Templates &amp; AI</p>
          <p className="text-sm text-stone-500">WhatsApp templates and default AI handling for conversations.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-stone-600">AI replies by default</span>
          <Toggle
            checked={form.aiEnabledDefault}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, aiEnabledDefault: next })}
          />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <FieldRow label="Booking confirmation">
          <textarea
            className={inputClass}
            rows={2}
            value={form.bookingConfirmationTemplate ?? ""}
            onChange={(e) => setForm({ ...form, bookingConfirmationTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Booking reminder">
          <textarea
            className={inputClass}
            rows={2}
            value={form.bookingReminderTemplate ?? ""}
            onChange={(e) => setForm({ ...form, bookingReminderTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Joined the queue">
          <textarea
            className={inputClass}
            rows={2}
            value={form.queueJoinedTemplate ?? ""}
            onChange={(e) => setForm({ ...form, queueJoinedTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Almost your turn">
          <textarea
            className={inputClass}
            rows={2}
            value={form.queueAlmostTurnTemplate ?? ""}
            onChange={(e) => setForm({ ...form, queueAlmostTurnTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="You've been called">
          <textarea
            className={inputClass}
            rows={2}
            value={form.queueCalledTemplate ?? ""}
            onChange={(e) => setForm({ ...form, queueCalledTemplate: e.target.value || null })}
          />
        </FieldRow>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}
