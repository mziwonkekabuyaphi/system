// app/admin/TodayBookings.tsx
"use client"

import { useState, useTransition } from "react"
import { cancelBooking } from "./actions"
import type { AdminBooking } from "./types"

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false })
}

export function TodayBookings({ bookings }: { bookings: AdminBooking[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  // Optimistic local overlay — page.tsx will confirm this on the next
  // revalidated fetch, but the owner shouldn't have to wait for a full
  // round trip to see a cancellation reflected.
  const [locallyCancelled, setLocallyCancelled] = useState<Set<string>>(new Set())

  function handleCancel(id: string) {
    setPendingId(id)
    startTransition(async () => {
      const result = await cancelBooking(id)
      if (result.ok) {
        setLocallyCancelled((prev) => new Set(prev).add(id))
      } else {
        window.alert(`Couldn't cancel that booking: ${result.error}`)
      }
      setPendingId(null)
    })
  }

  if (bookings.length === 0) {
    return <p className="text-[#8A8375]">Nothing on the book today.</p>
  }

  return (
    <ul className="divide-y divide-[#E6E1D4]">
      {bookings.map((b) => {
        const cancelled = b.status === "cancelled" || locallyCancelled.has(b.id)
        return (
          <li key={b.id} className="flex items-start justify-between gap-4 py-4">
            <div>
              <p className="text-[0.95rem] tabular-nums text-[#1C1A17]">{formatTime(b.startTime)}</p>
              <p
                className={`mt-0.5 text-[1.05rem] ${
                  cancelled ? "text-[#8A8375] line-through decoration-[#8A8375]/60" : "text-[#1C1A17]"
                }`}
              >
                {b.serviceName}
              </p>
              <p className="mt-0.5 text-sm text-[#8A8375]">
                {b.customerName ?? b.customerPhone} · {b.staffName}
              </p>
            </div>

            {cancelled ? (
              <span className="shrink-0 text-sm text-[#8A8375]">Cancelled</span>
            ) : (
              <button
                onClick={() => handleCancel(b.id)}
                disabled={isPending && pendingId === b.id}
                className="shrink-0 text-sm text-[#7A2E2E] underline decoration-[#7A2E2E]/40 underline-offset-4 hover:decoration-[#7A2E2E] disabled:opacity-50"
              >
                {isPending && pendingId === b.id ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
