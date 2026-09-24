// app/admin/TodayBookings.tsx
"use client"

import { useState, useTransition } from "react"
import { cancelBooking, completeBooking } from "./actions"
import type { AdminBooking } from "./types"

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false })
}

type PendingAction = "cancel" | "complete"

export function TodayBookings({ initialBookings }: { initialBookings: AdminBooking[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [isPending, startTransition] = useTransition()
  // Optimistic local overlay — page.tsx will confirm this on the next
  // revalidated fetch, but the owner shouldn't have to wait for a full
  // round trip to see a cancellation or completion reflected.
  const [locallyCancelled, setLocallyCancelled] = useState<Set<string>>(new Set())
  const [locallyCompleted, setLocallyCompleted] = useState<Set<string>>(new Set())

  function handleCancel(id: string) {
    setPendingId(id)
    setPendingAction("cancel")
    startTransition(async () => {
      const result = await cancelBooking(id)
      if (result.ok) {
        setLocallyCancelled((prev) => new Set(prev).add(id))
      } else {
        window.alert(`Couldn't cancel that booking: ${result.error}`)
      }
      setPendingId(null)
      setPendingAction(null)
    })
  }

  function handleComplete(id: string) {
    setPendingId(id)
    setPendingAction("complete")
    startTransition(async () => {
      const result = await completeBooking(id)
      if (result.ok) {
        setLocallyCompleted((prev) => new Set(prev).add(id))
      } else {
        window.alert(`Couldn't mark that booking as completed: ${result.error}`)
      }
      setPendingId(null)
      setPendingAction(null)
    })
  }

  if (initialBookings.length === 0) {
    return <p className="text-[#8A8375]">Nothing on the book today.</p>
  }

  return (
    <ul className="divide-y divide-[#E6E1D4]">
      {initialBookings.map((b) => {
        const cancelled = b.status === "cancelled" || locallyCancelled.has(b.id)
        const completed = b.status === "completed" || locallyCompleted.has(b.id)
        const rowPending = isPending && pendingId === b.id

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
            ) : completed ? (
              <span className="shrink-0 text-sm text-[#8A8375]">Completed</span>
            ) : (
              <div className="flex shrink-0 items-center gap-4">
                <button
                  onClick={() => handleComplete(b.id)}
                  disabled={rowPending}
                  className="text-sm text-[#1C1A17] underline decoration-[#1C1A17]/30 underline-offset-4 hover:decoration-[#1C1A17] disabled:opacity-50"
                >
                  {rowPending && pendingAction === "complete" ? "Completing…" : "Complete"}
                </button>
                <button
                  onClick={() => handleCancel(b.id)}
                  disabled={rowPending}
                  className="text-sm text-[#7A2E2E] underline decoration-[#7A2E2E]/40 underline-offset-4 hover:decoration-[#7A2E2E] disabled:opacity-50"
                >
                  {rowPending && pendingAction === "cancel" ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
