// app/admin/NewAppointmentDialog.tsx
//
// "New appointment" form for the Appointments screen. Everything that
// decides what's bookable — services, dates, free times, the final insert —
// comes from server actions that wrap lib/services/booking.ts (the same
// functions WhatsApp and the kiosk use). Nothing here computes availability.
//
// Rendered as the child of <AdminDialog>, which unmounts it on close, so the
// form state resets every time it's opened.
"use client"

import { useEffect, useRef, useState } from "react"

import {
  createAdminBooking,
  getAdminBookableServices,
  getAdminBookingDates,
  getAdminBookingSlots,
  type AdminBookableService,
} from "./actions"

const FIELD =
  "mt-1 w-full rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY =
  "rounded-md bg-[#1C1A17] px-3 py-1.5 text-sm text-[#FAF6EE] hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"

export function NewAppointmentForm({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (result: { bookingReference: string; startTime: string; dateISO: string }) => void
}) {
  const [services, setServices] = useState<AdminBookableService[] | null>(null)
  const [dates, setDates] = useState<Array<{ date: string; label: string }>>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [serviceId, setServiceId] = useState("")
  const [date, setDate] = useState("")
  const [slots, setSlots] = useState<Array<{ start: string; label: string }> | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [slotStart, setSlotStart] = useState("")
  const [phone, setPhone] = useState("")
  const [name, setName] = useState("")

  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [s, d] = await Promise.all([getAdminBookableServices(), getAdminBookingDates()])
      if (cancelled) return
      if (!s.ok) return setLoadError(s.error)
      if (!d.ok) return setLoadError(d.error)
      setServices(s.services)
      setDates(d.dates)
      if (d.dates[0]) setDate(d.dates[0].date)
    })().catch(() => !cancelled && setLoadError("Couldn't reach the server."))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setSlots(null)
    setSlotStart("")
    setSlotsError(null)
    if (!serviceId || !date) return
    let cancelled = false
    setSlotsLoading(true)
    getAdminBookingSlots(serviceId, date)
      .then((r) => {
        if (cancelled) return
        if (r.ok) setSlots(r.slots)
        else setSlotsError(r.error)
      })
      .catch(() => !cancelled && setSlotsError("Couldn't reach the server."))
      .finally(() => !cancelled && setSlotsLoading(false))
    return () => {
      cancelled = true
    }
  }, [serviceId, date])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current || !serviceId || !date || !slotStart) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await createAdminBooking({ serviceId, dateISO: date, slotStart, phone, name })
      if (result.ok) onCreated({ bookingReference: result.bookingReference, startTime: result.startTime, dateISO: date })
      else setError(result.error)
    } catch {
      setError("Something went wrong reaching the server. Please try again.")
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <p role="alert" className="rounded-md bg-[#7A2E2E]/10 px-3 py-2 text-[#7A2E2E]">
          {loadError}
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={BTN}>
            Close
          </button>
        </div>
      </div>
    )
  }

  if (services === null) return <p className="text-[#8A8375]">Loading…</p>

  if (services.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-[#8A8375]">There are no active services to book yet.</p>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={BTN}>
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-[#8A8375]">
        Service
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={FIELD} required>
          <option value="">Choose a service…</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.durationMinutes} min
            </option>
          ))}
        </select>
      </label>

      <label className="block text-[#8A8375]">
        Day
        <select value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} required>
          {dates.map((d) => (
            <option key={d.date} value={d.date}>
              {d.label} ({d.date})
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend className="text-[#8A8375]">Time</legend>
        <div className="mt-1" aria-live="polite">
          {!serviceId ? (
            <p className="text-[#8A8375]">Choose a service to see free times.</p>
          ) : slotsLoading ? (
            <p className="text-[#8A8375]">Checking availability…</p>
          ) : slotsError ? (
            <p role="alert" className="text-[#7A2E2E]">
              {slotsError}
            </p>
          ) : slots && slots.length === 0 ? (
            <p className="text-[#8A8375]">No free times that day (closed, fully booked, or outside your booking rules).</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {slots?.map((s) => (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => setSlotStart(s.start)}
                  aria-pressed={slotStart === s.start}
                  className={`rounded-md border px-2 py-1.5 text-sm tabular-nums ${
                    slotStart === s.start
                      ? "border-[#1C1A17] bg-[#1C1A17] text-[#FAF6EE]"
                      : "border-[#D9D3C3] bg-white text-[#1C1A17] hover:bg-[#F3EEE2]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      <label className="block text-[#8A8375]">
        Customer phone
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          autoComplete="off"
          placeholder="082 123 4567"
          className={FIELD}
          required
        />
      </label>

      <label className="block text-[#8A8375]">
        Customer name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" className={FIELD} />
      </label>

      {error && (
        <p role="alert" className="rounded-md bg-[#7A2E2E]/10 px-3 py-2 text-[#7A2E2E]">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} disabled={submitting} className={BTN}>
          Cancel
        </button>
        <button type="submit" disabled={submitting || !slotStart || phone.trim() === ""} className={BTN_PRIMARY}>
          {submitting ? "Booking…" : "Create appointment"}
        </button>
      </div>
    </form>
  )
}
