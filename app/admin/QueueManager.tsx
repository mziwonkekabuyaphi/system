// app/admin/QueueManager.tsx
//
// Queue Management screen. Same file/export name as before so AdminView's
// import doesn't change.
//
// Bug fixed vs the previous version: it checked `result.success`, but every
// server action in actions.ts returns `{ ok: boolean }`. `success` was always
// undefined, so every Call / Done / Remove reported an error and never updated
// the list (the database write itself still went through).
//
// Live behaviour: there is no realtime subscription in the admin, so this
// screen polls refreshQueue() (a read-only server action that reloads just
// the queue) every REFRESH_MS while the tab is visible, and again when the tab
// regains focus. The status indicator reports exactly that — nothing more.
"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AddWalkInForm } from "./AddWalkInDialog"
import { AdminDialog } from "./AdminDialog"
import { callQueueEntry, markQueueEntryDone, refreshQueue, removeFromQueue } from "./actions"
import { formatDuration, formatTime } from "./tz"
import type { AdminQueueEntry } from "./types"

const REFRESH_MS = 30_000

type Notice = { kind: "success" | "error"; text: string }

const FIELD =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_CALL =
  "rounded-md bg-[#7A2E3A] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#651F2A] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_DONE =
  "rounded-md bg-[#4B6B54] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#3D5745] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_GHOST =
  "rounded-md px-3 py-1.5 text-sm text-[#8A8375] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"

const SOURCE_LABEL: Record<AdminQueueEntry["source"], string> = { walk_in: "Walk-in", booking: "Appointment" }
const SOURCE_BADGE: Record<AdminQueueEntry["source"], string> = {
  walk_in: "bg-[#1C1A17]/[0.07] text-[#1C1A17]",
  booking: "bg-[#2557A7]/10 text-[#2557A7]",
}

function byPosition(a: AdminQueueEntry, b: AdminQueueEntry) {
  return (
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
    new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-[#E6E1D4] bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-[#8A8375]">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-3xl tabular-nums text-[#1C1A17]">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[#8A8375]">{hint}</p>}
    </div>
  )
}

export function QueueManager({
  initialQueue,
  timezone,
}: {
  initialQueue: AdminQueueEntry[]
  timezone: string
}) {
  const [queue, setQueue] = useState(initialQueue)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<{ id: string; action: "call" | "done" | "remove" | "next" } | null>(null)
  const busyRef = useRef(false)
  const [search, setSearch] = useState("")
  const [serviceFilter, setServiceFilter] = useState("all")
  const [sourceFilter, setSourceFilter] = useState<"all" | AdminQueueEntry["source"]>("all")
  const [removeTarget, setRemoveTarget] = useState<AdminQueueEntry | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [walkInOpen, setWalkInOpen] = useState(false)

  const [now, setNow] = useState(() => Date.now())
  const [lastUpdated, setLastUpdated] = useState(() => Date.now())
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  // Bumped whenever a local action succeeds; a refresh that started before
  // that is discarded so it can't briefly put the old state back on screen.
  const mutationVersion = useRef(0)

  // Pick up fresh server data when page.tsx re-renders (actions call
  // revalidatePath("/admin")).
  useEffect(() => {
    setQueue(initialQueue)
    setLastUpdated(Date.now())
  }, [initialQueue])

  // Formatted on the server with formatQueueTicketNumber() (lib/services/
  // queue.ts) so it can never disagree with the kiosk slip. Entries promoted
  // from a booking have no ticket number yet (see queue.ts "KNOWN GAP").
  const ticket = (e: Pick<AdminQueueEntry, "ticketLabel">) => e.ticketLabel ?? "—"

  const doRefresh = useCallback(async () => {
    if (refreshingRef.current || busyRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    const versionAtStart = mutationVersion.current
    try {
      const result = await refreshQueue()
      if (mutationVersion.current !== versionAtStart) return
      if (result.ok) {
        setQueue(result.entries)
        setLastUpdated(Date.now())
        setRefreshFailed(false)
      } else {
        setRefreshFailed(true)
      }
    } catch {
      setRefreshFailed(true)
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void doRefresh()
    }, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void doRefresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [doRefresh])

  useEffect(() => {
    if (notice?.kind !== "success") return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // ---- derived ------------------------------------------------------------
  // Queue order comes from getQueueSimulation() on the server (honours the
  // tenant's fifo / priority / hybrid mode), NOT from joined_at — under
  // 'priority' an appointment can be served before earlier walk-ins. joined_at
  // is only the tie-break / fallback if the simulation was unavailable.
  const waitingAll = useMemo(() => queue.filter((q) => q.status === "waiting").sort(byPosition), [queue])
  const servingAll = useMemo(
    () =>
      queue
        .filter((q) => q.status === "called")
        .sort(
          (a, b) =>
            new Date(a.calledAt ?? a.joinedAt).getTime() - new Date(b.calledAt ?? b.joinedAt).getTime(),
        ),
    [queue],
  )
  const doneToday = useMemo(() => queue.filter((q) => q.status === "done").length, [queue])

  const serviceOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const q of queue) m.set(q.serviceId ?? "none", q.serviceName)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [queue])

  const matches = useCallback(
    (q: AdminQueueEntry) => {
      if (serviceFilter !== "all" && (q.serviceId ?? "none") !== serviceFilter) return false
      if (sourceFilter !== "all" && q.source !== sourceFilter) return false
      const term = search.trim().toLowerCase()
      if (!term) return true
      return (
        (q.customerName ?? "").toLowerCase().includes(term) ||
        q.customerPhone.replace(/\s+/g, "").includes(term.replace(/\s+/g, "")) ||
        ticket(q).toLowerCase().includes(term)
      )
    },
    [search, serviceFilter, sourceFilter],
  )

  const waiting = waitingAll.filter(matches)
  const serving = servingAll.filter(matches)
  const filtersActive = search.trim() !== "" || serviceFilter !== "all" || sourceFilter !== "all"
  const positionOf = (id: string) => waitingAll.findIndex((q) => q.id === id) + 1 // place among those waiting
  const detailsEntry = detailsId ? (queue.find((q) => q.id === detailsId) ?? null) : null
  const anyBusy = busy !== null
  const who = (q: AdminQueueEntry) => q.customerName ?? q.customerPhone

  // ---- actions ------------------------------------------------------------
  async function perform(
    kind: "call" | "done" | "remove" | "next",
    entry: AdminQueueEntry,
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
    apply: (prev: AdminQueueEntry[]) => AdminQueueEntry[],
    successText: string,
  ) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy({ id: entry.id, action: kind })
    setNotice(null)
    try {
      const result = await fn()
      if (result.ok) {
        mutationVersion.current += 1
        setQueue(apply)
        setLastUpdated(Date.now())
        setNotice({ kind: "success", text: successText })
      } else {
        setNotice({ kind: "error", text: result.error })
        // The usual cause is someone else changing the entry first — reload.
        busyRef.current = false
        void doRefresh()
      }
    } catch {
      setNotice({ kind: "error", text: "Something went wrong reaching the server. Please try again." })
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const handleCall = (entry: AdminQueueEntry, kind: "call" | "next" = "call") =>
    perform(
      kind,
      entry,
      () => callQueueEntry(entry.id),
      (prev) =>
        prev.map((q) =>
          q.id === entry.id ? { ...q, status: "called" as const, calledAt: new Date().toISOString() } : q,
        ),
      `Called ${ticket(entry)} · ${who(entry)}.`,
    )

  // "Call next" calls the longest-waiting customer (joined_at ascending — the
  // same order the list is loaded in) through the SAME callQueueEntry action;
  // the server's status guard decides if someone else got there first.
  const handleCallNext = () => {
    const next = waitingAll[0]
    if (next) void handleCall(next, "next")
  }

  const handleDone = (entry: AdminQueueEntry) =>
    perform(
      "done",
      entry,
      () => markQueueEntryDone(entry.id),
      (prev) =>
        prev.map((q) =>
          q.id === entry.id ? { ...q, status: "done" as const, completedAt: new Date().toISOString() } : q,
        ),
      `${ticket(entry)} · ${who(entry)} marked as done.`,
    )

  async function handleRemoveConfirmed() {
    const entry = removeTarget
    if (!entry) return
    await perform(
      "remove",
      entry,
      () => removeFromQueue(entry.id),
      (prev) => prev.filter((q) => q.id !== entry.id),
      `${who(entry)} removed from the queue.`,
    )
    setRemoveTarget(null)
  }

  // ---- render -------------------------------------------------------------
  const updatedLabel = new Date(lastUpdated).toLocaleTimeString("en-ZA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-admin-serif)] text-xl text-[#1C1A17]">Queue Management</h2>
          <p className="mt-0.5 text-sm text-[#8A8375]">
            Walk-ins and appointments waiting to be served, in the order your queue mode sets.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-xs text-[#8A8375]" role="status">
            <span
              aria-hidden
              className={`inline-block h-2 w-2 rounded-full ${refreshFailed ? "bg-[#B3402A]" : "bg-[#4B6B54]"}`}
            />
            {refreshFailed
              ? `Can't reach the server — showing the queue as of ${updatedLabel}`
              : `Updates every ${REFRESH_MS / 1000}s · last ${updatedLabel}`}
          </p>
          <button type="button" onClick={() => void doRefresh()} disabled={refreshing || anyBusy} className={BTN}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" onClick={() => setWalkInOpen(true)} disabled={anyBusy} className={BTN}>
            Add walk-in
          </button>
          <button
            type="button"
            onClick={handleCallNext}
            disabled={anyBusy || waitingAll.length === 0}
            className={BTN_CALL}
          >
            {busy?.action === "next" ? "Calling…" : "Call next"}
          </button>
        </div>
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ${
            notice.kind === "error" ? "bg-[#7A2E2E]/10 text-[#7A2E2E]" : "bg-[#4B6B54]/10 text-[#4B6B54]"
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 underline underline-offset-2">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Waiting" value={waitingAll.length} />
        <SummaryCard label="Being served" value={servingAll.length} />
        <SummaryCard label="Done today" value={doneToday} />
      </div>

      {/* Now serving */}
      <section aria-labelledby="now-serving-heading">
        <h3 id="now-serving-heading" className="mb-2 text-sm font-semibold text-[#1C1A17]">
          Now serving
        </h3>
        {serving.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#D9D3C3] px-5 py-8 text-center text-[#8A8375]">
            {servingAll.length > 0 ? "No one being served matches these filters." : "Nobody is being served right now."}
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {serving.map((q) => (
              <li key={q.id} className="rounded-xl border-2 border-[#4B6B54]/40 bg-[#4B6B54]/[0.06] p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-[family-name:var(--font-admin-serif)] text-3xl tabular-nums text-[#1C1A17]">
                    {ticket(q)}
                  </p>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${SOURCE_BADGE[q.source]}`}>
                    {SOURCE_LABEL[q.source]}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailsId(q.id)}
                  className="mt-2 block w-full rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7A2E2E]"
                >
                  <p className="truncate text-[1.02rem] text-[#1C1A17]">{q.customerName ?? "No name on file"}</p>
                  <p className="truncate text-sm text-[#8A8375]">{q.serviceName}</p>
                  <p className="mt-1 text-xs text-[#8A8375]">
                    Called {q.calledAt ? formatTime(q.calledAt, timezone) : "—"} · with you for{" "}
                    {formatDuration(now - new Date(q.calledAt ?? q.joinedAt).getTime())}
                  </p>
                </button>
                <div className="mt-3 flex items-center gap-2">
                  <button type="button" onClick={() => void handleDone(q)} disabled={anyBusy} className={BTN_DONE}>
                    {busy?.id === q.id && busy.action === "done" ? "Saving…" : "Done"}
                  </button>
                  <button type="button" onClick={() => setRemoveTarget(q)} disabled={anyBusy} className={BTN_GHOST}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticket, name or phone"
          aria-label="Search the queue"
          className={`${FIELD} min-w-[14rem] flex-1`}
        />
        <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} aria-label="Filter by service" className={FIELD}>
          <option value="all">All services</option>
          {serviceOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as "all" | AdminQueueEntry["source"])}
          aria-label="Filter by source"
          className={FIELD}
        >
          <option value="all">Walk-ins &amp; appointments</option>
          <option value="walk_in">Walk-ins only</option>
          <option value="booking">Appointments only</option>
        </select>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setSearch("")
              setServiceFilter("all")
              setSourceFilter("all")
            }}
            className="text-sm text-[#7A2E2E] underline underline-offset-4"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Waiting */}
      <section aria-labelledby="waiting-heading">
        <h3 id="waiting-heading" className="mb-2 text-sm font-semibold text-[#1C1A17]">
          Waiting
          <span className="ml-2 font-normal text-[#8A8375]">{waitingAll.length}</span>
        </h3>
        {waiting.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#D9D3C3] px-5 py-10 text-center text-[#8A8375]">
            {waitingAll.length > 0 ? "No one waiting matches these filters." : "No one's queued up right now."}
          </div>
        ) : (
          <ul className="divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4] bg-white">
            {waiting.map((q) => {
              const position = positionOf(q.id)
              const rowBusy = busy?.id === q.id
              return (
                <li key={q.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={() => setDetailsId(q.id)}
                    className="flex min-w-0 flex-1 items-center gap-4 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7A2E2E]"
                  >
                    <span className="w-16 shrink-0 rounded-md bg-[#1C1A17] px-2 py-1 text-center font-mono text-sm tabular-nums text-[#FAF6EE]">
                      {ticket(q)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[1.02rem] text-[#1C1A17]">
                        {q.customerName ?? "No name on file"}
                        {position === 1 && (
                          <span className="ml-2 rounded-full bg-[#7A2E3A]/10 px-2 py-0.5 align-middle text-xs font-medium text-[#7A2E3A]">
                            Next
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-sm text-[#8A8375]">
                        {q.serviceName} · {q.customerPhone}
                      </span>
                      <span className="block text-xs text-[#8A8375]">
                        #{position} in line · joined {formatTime(q.joinedAt, timezone)} · waiting{" "}
                        {formatDuration(now - new Date(q.joinedAt).getTime())}
                        {q.etaMinutes !== null && <> · est. {q.etaMinutes === 0 ? "now" : `~${q.etaMinutes} min`}</>}
                      </span>
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-2 sm:justify-end">
                    {q.runningLate && (
                      <span
                        className="rounded-full bg-[#B3402A]/10 px-2.5 py-0.5 text-xs font-medium text-[#B3402A]"
                        title="Estimated to start after its appointment time"
                      >
                        Running late
                      </span>
                    )}
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${SOURCE_BADGE[q.source]}`}>
                      {SOURCE_LABEL[q.source]}
                    </span>
                    <button type="button" onClick={() => void handleCall(q)} disabled={anyBusy} className={BTN_CALL}>
                      {rowBusy && busy?.action !== "remove" ? "Calling…" : "Call"}
                    </button>
                    <button type="button" onClick={() => setRemoveTarget(q)} disabled={anyBusy} className={BTN_GHOST}>
                      Remove
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Add walk-in — wraps joinQueue() in lib/services/queue.ts */}
      <AdminDialog open={walkInOpen} title="Add walk-in" onClose={() => setWalkInOpen(false)}>
        <AddWalkInForm
          onClose={() => setWalkInOpen(false)}
          onAdded={({ ticketLabel, position, etaMinutes }) => {
            setWalkInOpen(false)
            setNotice({
              kind: "success",
              text: `Added as ${ticketLabel} — #${position} in line, about ${etaMinutes === 0 ? "now" : `${etaMinutes} min`}.`,
            })
            void doRefresh()
          }}
        />
      </AdminDialog>

      {/* Details */}
      <AdminDialog
        open={detailsEntry !== null}
        title="Queue entry"
        onClose={() => setDetailsId(null)}
        footer={
          <button type="button" onClick={() => setDetailsId(null)} className={BTN}>
            Close
          </button>
        }
      >
        {detailsEntry && (
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2">
            <dt className="text-[#8A8375]">Ticket</dt>
            <dd className="font-mono">{ticket(detailsEntry)}</dd>
            <dt className="text-[#8A8375]">Status</dt>
            <dd>
              {detailsEntry.status === "waiting"
                ? `Waiting (#${positionOf(detailsEntry.id)} in line)`
                : detailsEntry.status === "called"
                  ? "Being served"
                  : "Done"}
            </dd>
            <dt className="text-[#8A8375]">Customer</dt>
            <dd>{detailsEntry.customerName ?? "No name on file"}</dd>
            <dt className="text-[#8A8375]">Phone</dt>
            <dd>
              {detailsEntry.customerPhone ? (
                <a href={`tel:${detailsEntry.customerPhone}`} className="underline underline-offset-2">
                  {detailsEntry.customerPhone}
                </a>
              ) : (
                "—"
              )}
            </dd>
            <dt className="text-[#8A8375]">Service</dt>
            <dd>{detailsEntry.serviceName}</dd>
            <dt className="text-[#8A8375]">Source</dt>
            <dd>{SOURCE_LABEL[detailsEntry.source]}</dd>
            <dt className="text-[#8A8375]">Joined</dt>
            <dd className="tabular-nums">{formatTime(detailsEntry.joinedAt, timezone)}</dd>
            {detailsEntry.calledAt && (
              <>
                <dt className="text-[#8A8375]">Called</dt>
                <dd className="tabular-nums">{formatTime(detailsEntry.calledAt, timezone)}</dd>
              </>
            )}
            {detailsEntry.completedAt && (
              <>
                <dt className="text-[#8A8375]">Finished</dt>
                <dd className="tabular-nums">{formatTime(detailsEntry.completedAt, timezone)}</dd>
              </>
            )}
          </dl>
        )}
      </AdminDialog>

      {/* Remove confirmation */}
      <AdminDialog
        open={removeTarget !== null}
        title="Remove from the queue?"
        onClose={() => !anyBusy && setRemoveTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setRemoveTarget(null)} disabled={anyBusy} className={BTN}>
              Keep in queue
            </button>
            <button
              type="button"
              onClick={() => void handleRemoveConfirmed()}
              disabled={anyBusy}
              className="rounded-md bg-[#7A2E2E] px-3 py-1.5 text-sm text-white hover:bg-[#651F2A] disabled:opacity-50"
            >
              {busy?.action === "remove" ? "Removing…" : "Remove"}
            </button>
          </>
        }
      >
        {removeTarget && (
          <p>
            <strong>{who(removeTarget)}</strong> ({ticket(removeTarget)}) will be taken out of the queue.
            This can&apos;t be undone.
          </p>
        )}
      </AdminDialog>
    </div>
  )
}
