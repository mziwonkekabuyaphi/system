"use client"

import { useState, useTransition } from "react"

import { callQueueEntry, markQueueEntryDone, removeFromQueue } from "./actions"
import type { AdminQueueEntry } from "./types"

function formatWaitingSince(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

const STATUS_STYLES: Record<AdminQueueEntry["status"], string> = {
  waiting: "bg-stone-100 text-stone-600",
  called: "bg-[#4B6B54]/10 text-[#4B6B54]",
}

const STATUS_LABELS: Record<AdminQueueEntry["status"], string> = {
  waiting: "Waiting",
  called: "Called",
}

export function QueueManager({ initialQueue }: { initialQueue: AdminQueueEntry[] }) {
  const [queue, setQueue] = useState(initialQueue)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const waitingCount = queue.filter((q) => q.status === "waiting").length

  function handleCall(entry: AdminQueueEntry) {
    setError(null)
    setPendingId(entry.id)
    startTransition(async () => {
      const result = await callQueueEntry(entry.id)
      setPendingId(null)
      if (!result.success) {
        setError(result.error)
        return
      }
      setQueue((prev) => prev.map((q) => (q.id === entry.id ? { ...q, status: "called" as const } : q)))
    })
  }

  function handleDone(entry: AdminQueueEntry) {
    setError(null)
    setPendingId(entry.id)
    startTransition(async () => {
      const result = await markQueueEntryDone(entry.id)
      setPendingId(null)
      if (!result.success) {
        setError(result.error)
        return
      }
      setQueue((prev) => prev.filter((q) => q.id !== entry.id))
    })
  }

  function handleRemove(entry: AdminQueueEntry) {
    const who = entry.customerName ?? entry.customerPhone
    if (!window.confirm(`Remove ${who} from the queue?`)) return

    setError(null)
    setPendingId(entry.id)
    startTransition(async () => {
      const result = await removeFromQueue(entry.id)
      setPendingId(null)
      if (!result.success) {
        setError(result.error)
        return
      }
      setQueue((prev) => prev.filter((q) => q.id !== entry.id))
    })
  }

  if (queue.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 px-5 py-10 text-center text-stone-500">
        No one's queued up right now.
      </div>
    )
  }

  let waitingSeen = 0

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {queue.map((entry) => {
        if (entry.status === "waiting") waitingSeen += 1
        const isBusy = isPending && pendingId === entry.id

        return (
          <div key={entry.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">
                  {entry.status === "waiting" ? `#${waitingSeen} in line` : entry.serviceName}
                </p>
                {entry.status === "waiting" && <p className="text-sm text-stone-600">{entry.serviceName}</p>}
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[entry.status]}`}>
                {STATUS_LABELS[entry.status]}
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-100 pt-3 text-sm">
              <div>
                <p className="text-stone-800">{entry.customerName ?? "No name on file"}</p>
                <p className="text-stone-500">{entry.customerPhone}</p>
                <p className="mt-0.5 text-stone-400">joined at {formatWaitingSince(entry.joinedAt)}</p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {entry.status === "waiting" && (
                  <button
                    type="button"
                    onClick={() => handleCall(entry)}
                    disabled={isBusy}
                    className="rounded-full bg-[#7A2E3A] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#651F2A] disabled:opacity-50"
                  >
                    {isBusy ? "Calling…" : "Call"}
                  </button>
                )}
                {entry.status === "called" && (
                  <button
                    type="button"
                    onClick={() => handleDone(entry)}
                    disabled={isBusy}
                    className="rounded-full bg-[#4B6B54] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#3D5745] disabled:opacity-50"
                  >
                    {isBusy ? "Saving…" : "Done"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(entry)}
                  disabled={isBusy}
                  className="rounded-full px-3 py-1.5 text-sm font-medium text-stone-500 hover:bg-stone-100 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {waitingCount > 0 && (
        <p className="text-center text-sm text-stone-400">
          {waitingCount} {waitingCount === 1 ? "person" : "people"} waiting
        </p>
      )}
    </div>
  )
}
