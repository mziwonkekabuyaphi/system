// app/admin/TodayBookings.tsx
//
// The Appointments screen. Kept at this file/export name so AdminView's
// import and the "today" tab id don't change.
//
// Data: page.tsx loads a window of the shop's days (see
// BOOKING_WINDOW_DAYS_BACK/AHEAD in ./tz) already scoped to the active tenant
// on the server. Everything here — day/week navigation, search, filters,
// summary counts — is presentation over that window, never a security
// boundary. Actions go through the existing cancelBooking/completeBooking
// server actions, which re-check tenant, status and the cancellation window.
"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { AdminDialog } from "./AdminDialog"
import { NewAppointmentForm } from "./NewAppointmentDialog"
import { cancelBooking, completeBooking } from "./actions"
import {
  BOOKING_WINDOW_DAYS_AHEAD,
  BOOKING_WINDOW_DAYS_BACK,
  addDaysKey,
  dateKeyInTz,
  formatDateLong,
  formatDateShort,
  formatTime,
  startOfWeekKey,
} from "./tz"
import type { AdminBooking } from "./types"

type Status = AdminBooking["status"]
type Scope = "day" | "week"
type Notice = { kind: "success" | "error"; text: string }
type Action = "cancel" | "complete"

const STATUS_LABEL: Record<Status, string> = {
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
}

const STATUS_BADGE: Record<Status, string> = {
  confirmed: "bg-[#1C1A17]/[0.07] text-[#1C1A17]",
  completed: "bg-[#4B6B54]/10 text-[#4B6B54]",
  cancelled: "bg-[#7A2E2E]/10 text-[#7A2E2E]",
}

const FIELD =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY =
  "rounded-md bg-[#1C1A17] px-3 py-1.5 text-sm text-[#FAF6EE] hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
const BTN_DANGER =
  "rounded-md bg-[#7A2E2E] px-3 py-1.5 text-sm text-white hover:bg-[#651F2A] disabled:cursor-not-allowed disabled:opacity-50"

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-[#E6E1D4] bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-[#8A8375]">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-3xl tabular-nums text-[#1C1A17]">{value}</p>
      <p className="mt-0.5 text-xs text-[#8A8375]">{hint}</p>
    </div>
  )
}

export function TodayBookings({
  initialBookings,
  timezone,
}: {
  initialBookings: AdminBooking[]
  timezone: string
}) {
  const todayKey = dateKeyInTz(new Date(), timezone)
  const minKey = addDaysKey(todayKey, -BOOKING_WINDOW_DAYS_BACK)
  const maxKey = addDaysKey(todayKey, BOOKING_WINDOW_DAYS_AHEAD)

  const [selectedDate, setSelectedDate] = useState(todayKey)
  const [scope, setScope] = useState<Scope>("day")
  const [search, setSearch] = useState("")
  const [serviceFilter, setServiceFilter] = useState("all")
  const [staffFilter, setStaffFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all")

  // Optimistic overlay: shows the result of a successful action immediately.
  // page.tsx's data is revalidated by the actions themselves, and the real
  // status then arrives through initialBookings, so this never goes stale.
  const [overrides, setOverrides] = useState<Record<string, Status>>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [busy, setBusy] = useState<{ id: string; action: Action } | null>(null)
  const busyRef = useRef(false) // blocks a second submit before React re-renders

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (notice?.kind !== "success") return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // ---- derived data -------------------------------------------------------
  const bookings = useMemo(
    () =>
      initialBookings.map((b) => ({
        ...b,
        status: overrides[b.id] ?? b.status,
        dayKey: dateKeyInTz(b.startTime, timezone),
      })),
    [initialBookings, overrides, timezone],
  )

  const rangeStart = scope === "week" ? startOfWeekKey(selectedDate) : selectedDate
  const rangeEnd = scope === "week" ? addDaysKey(rangeStart, 6) : selectedDate

  const inRange = useMemo(
    () => bookings.filter((b) => b.dayKey >= rangeStart && b.dayKey <= rangeEnd),
    [bookings, rangeStart, rangeEnd],
  )

  const counts = useMemo(
    () => ({
      scheduled: inRange.filter((b) => b.status !== "cancelled").length,
      completed: inRange.filter((b) => b.status === "completed").length,
      cancelled: inRange.filter((b) => b.status === "cancelled").length,
      // Across the whole loaded window (not just the selected day): confirmed
      // bookings that haven't started yet.
      upcoming: bookings.filter((b) => b.status === "confirmed" && new Date(b.startTime).getTime() > now).length,
    }),
    [inRange, bookings, now],
  )

  const serviceOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bookings) m.set(b.serviceId ?? "none", b.serviceName)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [bookings])

  const staffOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bookings) m.set(b.staffId, b.staffName)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [bookings])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const qDigits = q.replace(/\s+/g, "")
    return inRange.filter((b) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false
      if (serviceFilter !== "all" && (b.serviceId ?? "none") !== serviceFilter) return false
      if (staffFilter !== "all" && b.staffId !== staffFilter) return false
      if (!q) return true
      return (
        (b.customerName ?? "").toLowerCase().includes(q) ||
        b.customerPhone.replace(/\s+/g, "").includes(qDigits) ||
        b.bookingReference.toLowerCase().includes(q) ||
        b.serviceName.toLowerCase().includes(q) ||
        b.staffName.toLowerCase().includes(q)
      )
    })
  }, [inRange, search, statusFilter, serviceFilter, staffFilter])

  const groups = useMemo(() => {
    const m = new Map<string, typeof visible>()
    for (const b of visible) m.set(b.dayKey, [...(m.get(b.dayKey) ?? []), b])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [visible])

  const filtersActive =
    search.trim() !== "" || serviceFilter !== "all" || staffFilter !== "all" || statusFilter !== "all"

  const detailsBooking = detailsId ? (bookings.find((b) => b.id === detailsId) ?? null) : null
  const cancelTarget = confirmCancelId ? (bookings.find((b) => b.id === confirmCancelId) ?? null) : null

  // ---- navigation ---------------------------------------------------------
  const step = scope === "week" ? 7 : 1
  const clamp = (key: string) => (key < minKey ? minKey : key > maxKey ? maxKey : key)
  const goPrev = () => setSelectedDate((d) => clamp(addDaysKey(d, -step)))
  const goNext = () => setSelectedDate((d) => clamp(addDaysKey(d, step)))
  const canPrev = rangeStart > minKey
  const canNext = rangeEnd < maxKey

  const heading =
    scope === "week"
      ? `${formatDateShort(rangeStart)} – ${formatDateShort(rangeEnd)}`
      : selectedDate === todayKey
        ? `Today · ${formatDateLong(selectedDate)}`
        : formatDateLong(selectedDate)

  // ---- actions ------------------------------------------------------------
  async function run(action: Action, id: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy({ id, action })
    setDialogError(null)
    try {
      const result = action === "cancel" ? await cancelBooking(id) : await completeBooking(id)
      if (result.ok) {
        setOverrides((prev) => ({ ...prev, [id]: action === "cancel" ? "cancelled" : "completed" }))
        setNotice({
          kind: "success",
          text: action === "cancel" ? "Appointment cancelled." : "Appointment marked as completed.",
        })
        setConfirmCancelId(null)
      } else if (action === "cancel") {
        // Shown inside the confirm dialog so the reason (e.g. the cancellation
        // window) is next to the button that triggered it.
        setDialogError(result.error)
      } else {
        setNotice({ kind: "error", text: `Couldn't mark that appointment as completed: ${result.error}` })
      }
    } catch {
      const text = "Something went wrong reaching the server. Please try again."
      if (action === "cancel") setDialogError(text)
      else setNotice({ kind: "error", text })
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const anyBusy = busy !== null
  const label = (b: { customerName: string | null; customerPhone: string }) => b.customerName ?? b.customerPhone

  // ---- render -------------------------------------------------------------
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-admin-serif)] text-xl text-[#1C1A17]">Appointments</h2>
          <p className="mt-0.5 text-sm text-[#8A8375]">
            Scheduled visits for your shop. Customers book through WhatsApp or the kiosk; you can also book for them,
            and complete or cancel appointments here.
          </p>
        </div>
        <button type="button" onClick={() => setNewOpen(true)} className={BTN_PRIMARY}>
          New appointment
        </button>
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

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          label={scope === "week" ? "This week" : selectedDate === todayKey ? "Today" : "This day"}
          value={counts.scheduled}
          hint="Not cancelled"
        />
        <SummaryCard label="Upcoming" value={counts.upcoming} hint={`Confirmed, next ${BOOKING_WINDOW_DAYS_AHEAD} days`} />
        <SummaryCard label="Completed" value={counts.completed} hint={scope === "week" ? "This week" : "This day"} />
        <SummaryCard label="Cancelled" value={counts.cancelled} hint={scope === "week" ? "This week" : "This day"} />
      </div>

      {/* Date navigation */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button type="button" onClick={goPrev} disabled={!canPrev} className={BTN} aria-label={`Previous ${scope}`}>
            ←
          </button>
          <button
            type="button"
            onClick={() => setSelectedDate(todayKey)}
            disabled={selectedDate === todayKey}
            className={BTN}
          >
            Today
          </button>
          <button type="button" onClick={goNext} disabled={!canNext} className={BTN} aria-label={`Next ${scope}`}>
            →
          </button>
        </div>
        <input
          type="date"
          value={selectedDate}
          min={minKey}
          max={maxKey}
          onChange={(e) => e.target.value && setSelectedDate(clamp(e.target.value))}
          aria-label="Jump to date"
          className={FIELD}
        />
        <div className="flex overflow-hidden rounded-md border border-[#D9D3C3]" role="group" aria-label="View">
          {(["day", "week"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              aria-pressed={scope === s}
              className={`px-3 py-1.5 text-sm ${
                scope === s ? "bg-[#1C1A17] text-[#FAF6EE]" : "bg-white text-[#1C1A17] hover:bg-[#F3EEE2]"
              }`}
            >
              {s === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <p className="ml-auto text-sm text-[#8A8375]">{heading}</p>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone or reference"
          aria-label="Search appointments"
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
        <select value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} aria-label="Filter by staff" className={FIELD}>
          <option value="all">All staff</option>
          {staffOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | Status)}
          aria-label="Filter by status"
          className={FIELD}
        >
          <option value="all">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setSearch("")
              setServiceFilter("all")
              setStaffFilter("all")
              setStatusFilter("all")
            }}
            className="text-sm text-[#7A2E2E] underline underline-offset-4"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#D9D3C3] px-5 py-10 text-center text-[#8A8375]">
          {filtersActive && inRange.length > 0
            ? "No appointments match these filters."
            : scope === "week"
              ? "Nothing on the book this week."
              : selectedDate === todayKey
                ? "Nothing on the book today."
                : "Nothing on the book for this day."}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(([dayKey, rows]) => (
            <section key={dayKey}>
              {scope === "week" && (
                <h3 className="mb-2 text-sm font-semibold text-[#1C1A17]">
                  {dayKey === todayKey ? `Today · ${formatDateShort(dayKey)}` : formatDateShort(dayKey)}
                  <span className="ml-2 font-normal text-[#8A8375]">{rows.length}</span>
                </h3>
              )}
              <ul className="divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4] bg-white">
                {rows.map((b) => {
                  const rowBusy = busy?.id === b.id
                  const minutes = Math.round((new Date(b.endTime).getTime() - new Date(b.startTime).getTime()) / 60000)
                  return (
                    <li
                      key={b.id}
                      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <button
                        type="button"
                        onClick={() => setDetailsId(b.id)}
                        className="flex min-w-0 flex-1 items-start gap-4 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7A2E2E]"
                      >
                        <div className="w-14 shrink-0">
                          <p className="text-[0.95rem] tabular-nums text-[#1C1A17]">{formatTime(b.startTime, timezone)}</p>
                          <p className="text-xs tabular-nums text-[#8A8375]">{minutes} min</p>
                        </div>
                        <div className="min-w-0">
                          <p
                            className={`truncate text-[1.02rem] ${
                              b.status === "cancelled" ? "text-[#8A8375] line-through decoration-[#8A8375]/60" : "text-[#1C1A17]"
                            }`}
                          >
                            {b.serviceName}
                          </p>
                          <p className="truncate text-sm text-[#8A8375]">
                            {label(b)} · {b.staffName}
                          </p>
                          <p className="text-xs text-[#8A8375]">Ref {b.bookingReference}</p>
                        </div>
                      </button>

                      <div className="flex shrink-0 items-center gap-3 sm:justify-end">
                        <StatusBadge status={b.status} />
                        {b.status === "confirmed" && (
                          <>
                            <button
                              type="button"
                              onClick={() => run("complete", b.id)}
                              disabled={anyBusy}
                              className={BTN}
                            >
                              {rowBusy && busy?.action === "complete" ? "Completing…" : "Complete"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDialogError(null)
                                setConfirmCancelId(b.id)
                              }}
                              disabled={anyBusy}
                              className="rounded-md px-2 py-1.5 text-sm text-[#7A2E2E] underline decoration-[#7A2E2E]/40 underline-offset-4 hover:decoration-[#7A2E2E] disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* New appointment — availability, staff assignment and every booking
          rule come from lib/services/booking.ts via createAdminBooking(). */}
      <AdminDialog open={newOpen} title="New appointment" onClose={() => setNewOpen(false)}>
        <NewAppointmentForm
          onClose={() => setNewOpen(false)}
          onCreated={({ bookingReference, startTime, dateISO }) => {
            setNewOpen(false)
            setNotice({
              kind: "success",
              text: `Appointment booked for ${formatDateShort(dateISO)} at ${formatTime(startTime, timezone)} (ref ${bookingReference}).`,
            })
            if (dateISO >= minKey && dateISO <= maxKey) setSelectedDate(dateISO)
          }}
        />
      </AdminDialog>

      {/* Details */}
      <AdminDialog
        open={detailsBooking !== null}
        title="Appointment details"
        onClose={() => setDetailsId(null)}
        footer={
          detailsBooking?.status === "confirmed" ? (
            <>
              <button type="button" onClick={() => setDetailsId(null)} className={BTN}>
                Close
              </button>
              <button
                type="button"
                disabled={anyBusy}
                onClick={() => {
                  setDialogError(null)
                  setConfirmCancelId(detailsBooking.id)
                  setDetailsId(null)
                }}
                className={BTN}
              >
                Cancel appointment…
              </button>
              <button
                type="button"
                disabled={anyBusy}
                onClick={async () => {
                  const id = detailsBooking.id
                  await run("complete", id)
                  setDetailsId(null)
                }}
                className={BTN_PRIMARY}
              >
                {busy?.action === "complete" ? "Completing…" : "Mark completed"}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setDetailsId(null)} className={BTN}>
              Close
            </button>
          )
        }
      >
        {detailsBooking && (
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2">
            <dt className="text-[#8A8375]">Status</dt>
            <dd>
              <StatusBadge status={detailsBooking.status} />
            </dd>
            <dt className="text-[#8A8375]">Customer</dt>
            <dd>{detailsBooking.customerName ?? "No name on file"}</dd>
            <dt className="text-[#8A8375]">Phone</dt>
            <dd>
              {detailsBooking.customerPhone ? (
                <a href={`tel:${detailsBooking.customerPhone}`} className="underline underline-offset-2">
                  {detailsBooking.customerPhone}
                </a>
              ) : (
                "—"
              )}
            </dd>
            <dt className="text-[#8A8375]">Service</dt>
            <dd>{detailsBooking.serviceName}</dd>
            <dt className="text-[#8A8375]">Staff</dt>
            <dd>{detailsBooking.staffName}</dd>
            <dt className="text-[#8A8375]">Date</dt>
            <dd>{formatDateLong(detailsBooking.dayKey)}</dd>
            <dt className="text-[#8A8375]">Time</dt>
            <dd className="tabular-nums">
              {formatTime(detailsBooking.startTime, timezone)} – {formatTime(detailsBooking.endTime, timezone)}
            </dd>
            <dt className="text-[#8A8375]">Reference</dt>
            <dd className="font-mono">{detailsBooking.bookingReference}</dd>
          </dl>
        )}
      </AdminDialog>

      {/* Cancel confirmation */}
      <AdminDialog
        open={cancelTarget !== null}
        title="Cancel this appointment?"
        onClose={() => !anyBusy && setConfirmCancelId(null)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmCancelId(null)} disabled={anyBusy} className={BTN}>
              Keep appointment
            </button>
            <button
              type="button"
              onClick={() => cancelTarget && run("cancel", cancelTarget.id)}
              disabled={anyBusy}
              className={BTN_DANGER}
            >
              {busy?.action === "cancel" ? "Cancelling…" : "Cancel appointment"}
            </button>
          </>
        }
      >
        {cancelTarget && (
          <>
            <p>
              {cancelTarget.serviceName} for <strong>{label(cancelTarget)}</strong> at{" "}
              {formatTime(cancelTarget.startTime, timezone)} on {formatDateShort(cancelTarget.dayKey)}.
            </p>
            <p className="mt-2 text-[#8A8375]">This can&apos;t be undone from here.</p>
            {dialogError && (
              <p role="alert" className="mt-3 rounded-md bg-[#7A2E2E]/10 px-3 py-2 text-[#7A2E2E]">
                {dialogError}
              </p>
            )}
          </>
        )}
      </AdminDialog>
    </div>
  )
}
