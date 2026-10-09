// app/admin/AddWalkInDialog.tsx
//
// "Add walk-in" form for the Queue screen. The addWalkIn() server action
// wraps lib/services/queue.ts's joinQueue() — the same function the kiosk and
// WhatsApp use — so ticket numbers, the plan visit cap and business-hours
// rules are the existing ones. Rendered inside <AdminDialog>, so state resets
// on every open.
"use client"

import { useEffect, useRef, useState } from "react"

import { addWalkIn, getWalkInOptions, type AdminBookableService } from "./actions"

const FIELD =
  "mt-1 w-full rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY =
  "rounded-md bg-[#7A2E3A] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#651F2A] disabled:cursor-not-allowed disabled:opacity-50"

export function AddWalkInForm({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (result: { ticketLabel: string; position: number; etaMinutes: number }) => void
}) {
  const [options, setOptions] = useState<{ services: AdminBookableService[]; requireService: boolean } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [serviceId, setServiceId] = useState("")
  const [phone, setPhone] = useState("")
  const [name, setName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getWalkInOptions()
      .then((r) => {
        if (cancelled) return
        if (r.ok) setOptions({ services: r.services, requireService: r.requireServiceSelection })
        else setLoadError(r.error)
      })
      .catch(() => !cancelled && setLoadError("Couldn't reach the server."))
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await addWalkIn({ serviceId: serviceId || null, phone, name })
      if (result.ok) onAdded(result)
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

  if (options === null) return <p className="text-[#8A8375]">Loading…</p>

  return (
    <form onSubmit={submit} className="space-y-3">
      {(options.services.length > 0 || options.requireService) && (
        <label className="block text-[#8A8375]">
          Service{options.requireService ? "" : " (optional)"}
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className={FIELD}
            required={options.requireService}
          >
            <option value="">{options.requireService ? "Choose a service…" : "No specific service"}</option>
            {options.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.durationMinutes} min
              </option>
            ))}
          </select>
        </label>
      )}

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
        <button type="submit" disabled={submitting || phone.trim() === ""} className={BTN_PRIMARY}>
          {submitting ? "Adding…" : "Add to queue"}
        </button>
      </div>
    </form>
  )
}
