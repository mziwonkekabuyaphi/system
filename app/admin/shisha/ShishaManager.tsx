// app/admin/shisha/ShishaManager.tsx
//
// Shisha tab. Mounted with no initial data (same pattern as CustomersManager /
// PayrollManager): it loads through refreshShisha() on mount, then polls it
// every REFRESH_MS while the tab is visible — the same approach QueueManager
// uses, since the admin has no realtime subscription. Timers tick locally each
// second from the server-stored anchor, so they never need a round trip.
"use client"

import { BRAND_BG, BRAND_FOCUS_BORDER, BRAND_ON } from "@/components/admin/brand"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AdminDialog } from "../AdminDialog"
import { printRequestSlip, slipProblem, toPlain, type RequestSlip } from "./shisha-request-print"
import { ShishaCounter, StationTag } from "./ShishaCounter"
import { ShishaDisplayDrawer } from "./ShishaDisplayDrawer"
import {
  acceptShishaRequest,
  addDevice,
  addFlavour,
  addStation,
  archiveDevice,
  archiveFlavour,
  archiveStation,
  endSession,
  pauseSession,
  refillSession,
  refreshShisha,
  rejectShishaRequest,
  resumeSession,
  setDeviceMaintenance,
  setFlavourAvailable,
  setStationActive,
  startSession,
  updateDevice,
  updateFlavour,
  updateShishaSettings,
  updateStation,
} from "./actions"
import {
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHODS,
  paymentMethodLabel,
  deriveDisplayStatus,
  liveRemainingSeconds,
  signedRemainingSeconds,
  type ShishaActionOk,
  type ShishaActionResult,
  type ShishaDevice,
  type ShishaDisplayStatus,
  type ShishaFlavour,
  type ShishaRequest,
  type ShishaRequestType,
  type ShishaSession,
  type ShishaSnapshot,
  type ShishaStation,
} from "./shisha-types"

const REFRESH_MS = 30_000
/** Staff who can operate poll faster: a customer is waiting on WhatsApp for their request. */
const STAFF_REFRESH_MS = 10_000
/** A request waiting longer than this is highlighted. */
const STALE_REQUEST_MS = 5 * 60_000
/** Auto-print setting + which requests already got a slip. Both live in THIS browser:
 *  only the PC the receipt printer is plugged into should have auto-print on. */
const AUTOPRINT_REQUESTS_KEY = "shishaAutoPrintRequests"
const PRINTED_REQUESTS_KEY = "shishaPrintedRequests"
/** A request older than this is never auto-printed (e.g. the tab was closed for hours). */
const MAX_SLIP_AGE_MS = 30 * 60_000

type Section = "counter" | "requests" | "sessions" | "flavours" | "devices" | "stations" | "timing"
type Notice = { kind: "success" | "error" | "warning"; text: string }
type Editing =
  | { kind: "flavour"; item: ShishaFlavour | null }
  | { kind: "device"; item: ShishaDevice | null }
  | { kind: "station"; item: ShishaStation | null }
type ArchiveTarget = { kind: "flavour" | "device" | "station"; id: string; name: string }

const FIELD =
  `w-full rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] outline-none ${BRAND_FOCUS_BORDER}`
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY =
  `rounded-md ${BRAND_BG} ${BRAND_ON} px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`
const BTN_DANGER =
  "rounded-md bg-[#7A2E2E] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#651F1F] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_GHOST =
  "rounded-md px-3 py-1.5 text-sm text-[#8A8375] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const CARD = "rounded-lg border border-[#E6E1D4] bg-white"

const STATUS_LABEL: Record<ShishaDisplayStatus, string> = {
  active: "Running",
  refill: "Refill soon",
  paused: "Paused",
  expired: "Time's up",
}
const STATUS_BADGE: Record<ShishaDisplayStatus, string> = {
  active: "bg-[#4B6B54]/10 text-[#4B6B54]",
  refill: "bg-[#9A6A12]/10 text-[#9A6A12]",
  paused: "bg-[#1C1A17]/[0.07] text-[#6B6558]",
  expired: "bg-[#7A2E2E]/10 text-[#7A2E2E]",
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(totalSeconds, 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(sec).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** "2026-10" -> "October 2026" */
function formatMonth(month: string): string {
  const d = new Date(`${month}-01T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return month
  return new Intl.DateTimeFormat("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" }).format(d)
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className={`${CARD} px-4 py-3`}>
      <p className="text-xs uppercase tracking-wide text-[#8A8375]">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-3xl tabular-nums text-[#1C1A17]">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[#8A8375]">{hint}</p>}
    </div>
  )
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className={`${CARD} px-4 py-8 text-center text-sm text-[#8A8375]`}>{children}</p>
}

// ============================================================================
// Main
// ============================================================================

export function ShishaManager({
  timezone,
  canOperate,
  canManage,
}: {
  timezone: string
  canOperate: boolean
  canManage: boolean
}) {
  const [snap, setSnap] = useState<ShishaSnapshot | null>(null)
  // Floor staff (can operate, can't manage) land on the Counter; owners on Sessions.
  const [section, setSection] = useState<Section>(canOperate && !canManage ? "counter" : "sessions")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null)
  const [displayOpen, setDisplayOpen] = useState(false)

  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  // Bumped when a local action succeeds; a refresh that started before it is
  // discarded so it can't briefly put the old state back on screen.
  const mutationVersion = useRef(0)

  const doRefresh = useCallback(async () => {
    if (refreshingRef.current || busyRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    const versionAtStart = mutationVersion.current
    try {
      const result = await refreshShisha()
      if (mutationVersion.current !== versionAtStart) return
      if (result.ok) {
        setSnap(result.snapshot)
        setLastUpdated(Date.now())
        setRefreshFailed(false)
        setLoadError(null)
      } else {
        setRefreshFailed(true)
        setLoadError(result.error)
      }
    } catch {
      setRefreshFailed(true)
      setLoadError("Couldn't reach the server.")
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [])

  const pollMs = canOperate ? STAFF_REFRESH_MS : REFRESH_MS

  useEffect(() => {
    void doRefresh()
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void doRefresh()
    }, pollMs)
    const onVisible = () => {
      if (document.visibilityState === "visible") void doRefresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(poll)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [doRefresh, pollMs])

  useEffect(() => {
    if (notice?.kind !== "success") return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /** Runs one mutation, then reloads. Returns true on success so a dialog can close. */
  const run = useCallback(
    async (fn: () => Promise<ShishaActionResult>, successText: string | ((r: ShishaActionOk) => string)): Promise<boolean> => {
      if (busyRef.current) return false
      busyRef.current = true
      setBusy(true)
      setNotice(null)
      let ok = false
      try {
        const result = await fn()
        if (result.ok) {
          ok = true
          mutationVersion.current += 1
          const text = result.message ?? (typeof successText === "function" ? successText(result) : successText)
          // A warning means it worked but something around it didn't (e.g. the customer
          // couldn't be messaged): keep it on screen until dismissed.
          setNotice(
            result.warning
              ? { kind: "warning", text: `${text} ${result.warning}` }
              : { kind: "success", text },
          )
        } else {
          // The usual cause is someone else changing the same row first.
          setNotice({ kind: "error", text: result.error })
        }
      } catch {
        setNotice({ kind: "error", text: "Something went wrong reaching the server. Please try again." })
      } finally {
        busyRef.current = false
        setBusy(false)
      }
      void doRefresh()
      return ok
    },
    [doRefresh],
  )

  const stationById = useMemo(() => new Map((snap?.stations ?? []).map((s) => [s.id, s])), [snap])
  const occupiedDeviceIds = useMemo(
    () => new Set((snap?.sessions ?? []).map((s) => s.deviceId).filter((id): id is string => Boolean(id))),
    [snap],
  )

  const pendingCount = snap?.requests.length ?? 0

  // ---- Print a slip when a customer requests a session -----------------------
  // The WhatsApp message lands on the server, which can't reach the printer (the print
  // agent only listens on the shop PC). So THIS page, open on that PC, does the printing:
  // each refresh it looks for new session requests and sends them to the agent.
  const [autoPrintRequests, setAutoPrintRequests] = useState(false)
  const printedRequests = useRef<Set<string>>(new Set())
  const slipPrinting = useRef(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(AUTOPRINT_REQUESTS_KEY) === "true") setAutoPrintRequests(true)
      const saved: unknown = JSON.parse(localStorage.getItem(PRINTED_REQUESTS_KEY) ?? "[]")
      if (Array.isArray(saved)) {
        printedRequests.current = new Set(saved.filter((x): x is string => typeof x === "string"))
      }
    } catch {
      // Storage blocked: duplicates are still prevented while this tab stays open.
    }
  }, [])

  const rememberPrinted = useCallback(() => {
    try {
      localStorage.setItem(PRINTED_REQUESTS_KEY, JSON.stringify([...printedRequests.current].slice(-200)))
    } catch {
      /* ignore */
    }
  }, [])

  const slipFor = useCallback(
    (req: ShishaRequest, jobId: string): RequestSlip => {
      const amount = req.currentAmount ?? req.quotedAmount
      return {
        jobId,
        customer: req.customerName ?? req.customerPhone ?? "Unknown customer",
        phone: req.customerName ? req.customerPhone : null,
        station: req.stationName,
        flavour: req.flavourName ?? "Not specified",
        amountText: amount === null ? null : toPlain(formatMoney(amount, snap?.currency ?? "ZAR")),
        dateText: toPlain(
          new Date(req.createdAt).toLocaleString("en-ZA", {
            timeZone: timezone,
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        ),
      }
    },
    [snap?.currency, timezone],
  )

  useEffect(() => {
    if (!autoPrintRequests || !canOperate || !snap || slipPrinting.current) return
    const now = Date.now()
    const fresh = snap.requests.filter(
      (r) =>
        r.requestType === "order_session" &&
        !printedRequests.current.has(r.id) &&
        now - new Date(r.createdAt).getTime() < MAX_SLIP_AGE_MS,
    )
    if (fresh.length === 0) return

    slipPrinting.current = true
    void (async () => {
      try {
        for (const req of fresh) {
          // Marked BEFORE sending, so a slow printer or a re-render can't print it twice.
          printedRequests.current.add(req.id)
          rememberPrinted()
          const result = await printRequestSlip(slipFor(req, `request-${req.id}`), snap.shopName)
          const problem = slipProblem(result, req.customerName ?? req.customerPhone ?? "a customer")
          if (problem) setNotice({ kind: "warning", text: problem })
        }
      } finally {
        slipPrinting.current = false
      }
    })()
  }, [snap, autoPrintRequests, canOperate, slipFor, rememberPrinted])

  function changeAutoPrintRequests(on: boolean) {
    setAutoPrintRequests(on)
    try {
      localStorage.setItem(AUTOPRINT_REQUESTS_KEY, String(on))
    } catch {
      /* ignore */
    }
    if (on && snap) {
      // Requests already waiting are not printed retroactively.
      for (const r of snap.requests) printedRequests.current.add(r.id)
      rememberPrinted()
    }
  }

  async function printSlipNow(req: ShishaRequest) {
    if (!snap) return
    const who = req.customerName ?? req.customerPhone ?? "a customer"
    // Fresh job id, so staff can deliberately print the same slip again.
    const result = await printRequestSlip(slipFor(req, `request-${req.id}-${Date.now()}`), snap.shopName)
    const problem = slipProblem(result, who)
    setNotice(problem ? { kind: "warning", text: problem } : { kind: "success", text: "Slip printed." })
  }
  const refillText = (s: ShishaSession) => (r: ShishaActionOk) =>
    r.charged && r.charged > 0
      ? `${s.deviceCode} refilled · ${formatMoney(r.charged, snap?.currency ?? "ZAR")} charged.`
      : `${s.deviceCode} refilled.`

  const updatedLabel =
    lastUpdated === null
      ? "—"
      : new Date(lastUpdated).toLocaleTimeString("en-ZA", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false })

  const sections: Array<{ id: Section; label: string }> = [
    ...(canOperate ? [{ id: "counter" as const, label: "Counter" }] : []),
    ...(canOperate ? [{ id: "requests" as const, label: "Requests" }] : []),
    { id: "sessions", label: "Sessions" },
    { id: "flavours", label: "Flavours" },
    { id: "devices", label: "Devices" },
    { id: "stations", label: "Stations" },
    { id: "timing", label: "Timing" },
  ]

  async function confirmArchive() {
    const target = archiveTarget
    if (!target) return
    const fn =
      target.kind === "flavour"
        ? () => archiveFlavour(target.id)
        : target.kind === "device"
          ? () => archiveDevice(target.id)
          : () => archiveStation(target.id)
    const ok = await run(fn, `"${target.name}" archived.`)
    if (ok) setArchiveTarget(null)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-admin-serif)] text-xl text-[#1C1A17]">Shisha</h2>
          <p className="mt-0.5 text-sm text-[#8A8375]">Timed sessions, flavours, devices and stations.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-xs text-[#8A8375]" role="status">
            <span
              aria-hidden
              className={`inline-block h-2 w-2 rounded-full ${refreshFailed ? "bg-[#B3402A]" : "bg-[#4B6B54]"}`}
            />
            {refreshFailed
              ? `Can't reach the server — showing data as of ${updatedLabel}`
              : `Updates every ${pollMs / 1000}s · last ${updatedLabel}`}
          </p>
          <button type="button" onClick={() => void doRefresh()} disabled={refreshing || busy} className={BTN}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {canManage && (
            <button type="button" onClick={() => setDisplayOpen(true)} className={BTN}>
              TV display
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "bg-[#7A2E2E]/10 text-[#7A2E2E]"
              : notice.kind === "warning"
                ? "bg-[#9A6A12]/10 text-[#9A6A12]"
                : "bg-[#4B6B54]/10 text-[#4B6B54]"
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 underline underline-offset-2">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Shisha sections">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
            className={section === s.id ? BTN_PRIMARY : BTN}
          >
            {s.label}
            {s.id === "requests" && pendingCount > 0 && (
              <span
                className={`ml-2 inline-block min-w-[1.25rem] rounded-full px-1.5 text-center text-xs font-semibold ${
                  section === "requests" ? "bg-white/25 text-white" : "bg-[#7A2E2E] text-white"
                }`}
                aria-label={`${pendingCount} waiting`}
              >
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {canOperate && pendingCount > 0 && section !== "requests" && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#9A6A12]/30 bg-[#9A6A12]/10 px-3 py-2 text-sm text-[#9A6A12]"
        >
          <span>
            {pendingCount} customer {pendingCount === 1 ? "request is" : "requests are"} waiting for staff.
          </span>
          <button type="button" onClick={() => setSection("requests")} className={BTN}>
            Review
          </button>
        </div>
      )}

      {!snap ? (
        loadError ? (
          <div className={`${CARD} space-y-3 px-4 py-6 text-center`}>
            <p className="text-sm text-[#7A2E2E]">{loadError}</p>
            <button type="button" onClick={() => void doRefresh()} className={BTN}>
              Try again
            </button>
          </div>
        ) : (
          <EmptyState>Loading shisha data…</EmptyState>
        )
      ) : (
        <>
          {section === "counter" && canOperate && (
            <ShishaCounter
              snap={snap}
              timezone={timezone}
              busy={busy}
              occupiedDeviceIds={occupiedDeviceIds}
              onStart={(input) => run(() => startSession(input), "Session started.")}
              onPause={(s) => void run(() => pauseSession(s.id), `${s.deviceCode} paused.`)}
              onResume={(s) => void run(() => resumeSession(s.id), `${s.deviceCode} resumed.`)}
              onRefill={(s) => void run(() => refillSession(s.id), refillText(s))}
              onEnd={(s, method) => run(() => endSession(s.id, method), `${s.deviceCode} session ended.`)}
            />
          )}

          {section === "requests" && canOperate && (
            <RequestsPanel
              snap={snap}
              busy={busy}
              occupiedDeviceIds={occupiedDeviceIds}
              onAccept={(req, input) =>
                run(() => acceptShishaRequest({ requestId: req.id, ...input }), "Request accepted.")
              }
              onReject={(req, reason) => run(() => rejectShishaRequest(req.id, reason), "Request rejected.")}
              autoPrint={autoPrintRequests}
              onAutoPrintChange={changeAutoPrintRequests}
              onPrintSlip={(req) => void printSlipNow(req)}
            />
          )}

          {section === "sessions" && (
            <SessionsPanel
              snap={snap}
              timezone={timezone}
              canOperate={canOperate}
              busy={busy}
              occupiedDeviceIds={occupiedDeviceIds}
              onStart={(input) =>
                run(() => startSession(input), "Session started.")
              }
              onPause={(s) => void run(() => pauseSession(s.id), `${s.deviceCode} paused.`)}
              onResume={(s) => void run(() => resumeSession(s.id), `${s.deviceCode} resumed.`)}
              onRefill={(s) => void run(() => refillSession(s.id), refillText(s))}
              onEnd={(s, method) => run(() => endSession(s.id, method), `${s.deviceCode} session ended.`)}
            />
          )}

          {section === "flavours" && (
            <FlavoursPanel
              snap={snap}
              canManage={canManage}
              busy={busy}
              onAdd={() => setEditing({ kind: "flavour", item: null })}
              onEdit={(item) => setEditing({ kind: "flavour", item })}
              onToggle={(f) =>
                void run(
                  () => setFlavourAvailable(f.id, !f.isAvailable),
                  f.isAvailable ? `${f.name} marked out of stock.` : `${f.name} back in stock.`,
                )
              }
              onArchive={(f) => setArchiveTarget({ kind: "flavour", id: f.id, name: f.name })}
            />
          )}

          {section === "devices" && (
            <DevicesPanel
              snap={snap}
              canManage={canManage}
              busy={busy}
              occupiedDeviceIds={occupiedDeviceIds}
              stationById={stationById}
              onAdd={() => setEditing({ kind: "device", item: null })}
              onEdit={(item) => setEditing({ kind: "device", item })}
              onToggleMaintenance={(d) =>
                void run(
                  () => setDeviceMaintenance(d.id, d.status !== "maintenance"),
                  d.status === "maintenance" ? `${d.deviceCode} is available again.` : `${d.deviceCode} set to maintenance.`,
                )
              }
              onArchive={(d) => setArchiveTarget({ kind: "device", id: d.id, name: d.deviceCode })}
            />
          )}

          {section === "stations" && (
            <StationsPanel
              snap={snap}
              canManage={canManage}
              busy={busy}
              onAdd={() => setEditing({ kind: "station", item: null })}
              onEdit={(item) => setEditing({ kind: "station", item })}
              onToggle={(s) =>
                void run(
                  () => setStationActive(s.id, !s.isActive),
                  s.isActive ? `${s.name} hidden from customers.` : `${s.name} is visible to customers.`,
                )
              }
              onArchive={(s) => setArchiveTarget({ kind: "station", id: s.id, name: s.name })}
            />
          )}

          {section === "timing" && (
            <TimingPanel
              key={`${snap.settings.coalDurationMinutes}-${snap.settings.refillThresholdMinutes}-${snap.settings.requireStation}`}
              snap={snap}
              canManage={canManage}
              busy={busy}
              onSave={(input) => run(() => updateShishaSettings(input), "Timing saved.")}
            />
          )}
        </>
      )}

      {/* Add / edit */}
      <AdminDialog
        open={editing?.kind === "flavour"}
        title={editing?.kind === "flavour" && editing.item ? "Edit flavour" : "Add flavour"}
        onClose={() => !busy && setEditing(null)}
      >
        {editing?.kind === "flavour" && snap && (
          <FlavourForm
            key={editing.item?.id ?? "new"}
            initial={editing.item}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              const item = editing.item
              const ok = await run(
                () => (item ? updateFlavour(item.id, input) : addFlavour(input)),
                item ? `${input.name} updated.` : `${input.name} added.`,
              )
              if (ok) setEditing(null)
            }}
          />
        )}
      </AdminDialog>

      <AdminDialog
        open={editing?.kind === "device"}
        title={editing?.kind === "device" && editing.item ? "Edit device" : "Add device"}
        onClose={() => !busy && setEditing(null)}
      >
        {editing?.kind === "device" && snap && (
          <DeviceForm
            key={editing.item?.id ?? "new"}
            initial={editing.item}
            stations={snap.stations}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              const item = editing.item
              const ok = await run(
                () => (item ? updateDevice(item.id, input) : addDevice(input)),
                item ? `${input.deviceCode.toUpperCase()} updated.` : `${input.deviceCode.toUpperCase()} added.`,
              )
              if (ok) setEditing(null)
            }}
          />
        )}
      </AdminDialog>

      <AdminDialog
        open={editing?.kind === "station"}
        title={editing?.kind === "station" && editing.item ? "Edit station" : "Add station"}
        onClose={() => !busy && setEditing(null)}
      >
        {editing?.kind === "station" && (
          <StationForm
            key={editing.item?.id ?? "new"}
            initial={editing.item}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              const item = editing.item
              const ok = await run(
                () => (item ? updateStation(item.id, input) : addStation(input)),
                item ? `${input.name} updated.` : `${input.name} added.`,
              )
              if (ok) setEditing(null)
            }}
          />
        )}
      </AdminDialog>

      {/* Archive confirmation */}
      <AdminDialog
        open={archiveTarget !== null}
        title={archiveTarget ? `Archive ${archiveTarget.name}?` : "Archive?"}
        onClose={() => !busy && setArchiveTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setArchiveTarget(null)} disabled={busy} className={BTN}>
              Keep it
            </button>
            <button type="button" onClick={() => void confirmArchive()} disabled={busy} className={BTN_DANGER}>
              {busy ? "Archiving…" : "Archive"}
            </button>
          </>
        }
      >
        <p className="text-sm text-[#1C1A17]">
          It disappears from the lists and from new sessions. Past sessions keep it, so your history and totals stay
          correct.
        </p>
      </AdminDialog>

      {/* TV display settings: right-hand overlay panel */}
      {canManage && <ShishaDisplayDrawer open={displayOpen} onClose={() => setDisplayOpen(false)} />}
    </div>
  )
}

// ============================================================================
// Requests (WhatsApp requests waiting for staff)
// ============================================================================

const REQUEST_TYPE_LABEL: Record<ShishaRequestType, string> = {
  order_session: "New session",
  maintenance: "Coal refill",
  end_session: "End session",
  issue_report: "Issue report",
}

type AcceptInput = { deviceId?: string | null; locationId?: string | null; paymentMethod?: string | null }

function timeAgo(createdAt: string, now: number): string {
  const mins = Math.max(Math.floor((now - new Date(createdAt).getTime()) / 60_000), 0)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

/** The money line on a request card: what accepting would charge right now. */
function requestAmountText(req: ShishaRequest, currency: string): string | null {
  const quotedDiffers =
    req.quotedAmount !== null && req.currentAmount !== null && req.quotedAmount !== req.currentAmount
  if (req.requestType === "order_session" && req.currentAmount !== null) {
    return `Price now ${formatMoney(req.currentAmount, currency)}${
      quotedDiffers ? ` · customer was quoted ${formatMoney(req.quotedAmount as number, currency)}` : ""
    }`
  }
  if (req.requestType === "maintenance" && req.currentAmount !== null) {
    return req.currentAmount > 0 ? `Refill charge ${formatMoney(req.currentAmount, currency)}` : "Refill is free"
  }
  if (req.requestType === "end_session" && req.currentAmount !== null) {
    return `Session total ${formatMoney(req.currentAmount, currency)}`
  }
  return null
}

function RequestsPanel({
  snap,
  busy,
  occupiedDeviceIds,
  onAccept,
  onReject,
  autoPrint,
  onAutoPrintChange,
  onPrintSlip,
}: {
  snap: ShishaSnapshot
  busy: boolean
  occupiedDeviceIds: Set<string>
  onAccept: (req: ShishaRequest, input: AcceptInput) => Promise<boolean>
  onReject: (req: ShishaRequest, reason: string) => Promise<boolean>
  autoPrint: boolean
  onAutoPrintChange: (on: boolean) => void
  onPrintSlip: (req: ShishaRequest) => void
}) {
  const now = useNow(15_000)
  const [acting, setActing] = useState<{ kind: "accept" | "reject"; id: string } | null>(null)

  const freeDevices = useMemo(
    () => snap.devices.filter((d) => d.status !== "maintenance" && !occupiedDeviceIds.has(d.id)),
    [snap.devices, occupiedDeviceIds],
  )
  const activeStations = useMemo(() => snap.stations.filter((st) => st.isActive), [snap.stations])

  // Always show the freshest copy of the request being acted on; if someone else
  // handles it while the dialog is open, close the dialog.
  const target = acting ? (snap.requests.find((r) => r.id === acting.id) ?? null) : null
  useEffect(() => {
    if (acting && !target) setActing(null)
  }, [acting, target])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">Requests</h3>
        <p className="mt-0.5 text-sm text-[#8A8375]">
          Customers who asked on WhatsApp. They can't send another request until you accept or reject this one.
        </p>
        <label className="mt-3 flex items-start gap-2 text-sm text-[#1C1A17]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={autoPrint}
            onChange={(e) => onAutoPrintChange(e.target.checked)}
          />
          <span>
            Print a slip on this PC when a customer requests a session
            <span className="block text-xs text-[#8A8375]">
              Turn this on only on the PC with the receipt printer, and keep this page open there.
            </span>
          </span>
        </label>
      </div>

      {snap.requests.length === 0 ? (
        <EmptyState>No requests waiting. New ones appear here within {STAFF_REFRESH_MS / 1000} seconds.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {snap.requests.map((req) => {
            const stale = now - new Date(req.createdAt).getTime() > STALE_REQUEST_MS
            const amountText = requestAmountText(req, snap.currency)
            const details = [
              req.flavourName,
              req.stationName ? `Station: ${req.stationName}` : null,
              req.deviceCode ? `Device ${req.deviceCode}` : null,
            ]
              .filter(Boolean)
              .join(" · ")
            const needsSession = req.requestType === "maintenance" || req.requestType === "end_session"
            return (
              <li
                key={req.id}
                className={`space-y-3 p-4 ${stale ? "rounded-lg border border-[#9A6A12]/50 bg-[#FBF5E8]" : CARD}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
                      {REQUEST_TYPE_LABEL[req.requestType]}
                    </p>
                    <p className="truncate text-sm text-[#6B6558]">
                      {req.customerName ?? req.customerPhone ?? "Unknown customer"}
                      {req.customerName && req.customerPhone ? ` · ${req.customerPhone}` : ""}
                    </p>
                  </div>
                  <Badge className={stale ? "bg-[#9A6A12]/10 text-[#9A6A12]" : "bg-[#1C1A17]/[0.07] text-[#6B6558]"}>
                    {timeAgo(req.createdAt, now)}
                    {stale ? " · waiting" : ""}
                  </Badge>
                </div>

                {details && <p className="text-sm text-[#1C1A17]">{details}</p>}
                {req.issueLabel && <p className="text-sm text-[#1C1A17]">“{req.issueLabel}”</p>}
                {amountText && <p className="text-sm tabular-nums text-[#6B6558]">{amountText}</p>}

                {req.flavourIssue === "missing" && (
                  <p className="text-xs text-[#7A2E2E]">That flavour is no longer on the menu.</p>
                )}
                {req.flavourIssue === "out_of_stock" && (
                  <p className="text-xs text-[#7A2E2E]">That flavour is out of stock.</p>
                )}
                {needsSession && !req.sessionLive && (
                  <p className="text-xs text-[#9A6A12]">
                    The session this request was about has ended. Accepting looks for the customer's other live
                    session, otherwise reject it.
                  </p>
                )}
                {req.requestType === "maintenance" && req.sessionPaused && (
                  <p className="text-xs text-[#9A6A12]">That session is paused. Resume it before accepting the refill.</p>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      req.requestType === "issue_report"
                        ? void onAccept(req, {})
                        : setActing({ kind: "accept", id: req.id })
                    }
                    className={BTN_PRIMARY}
                  >
                    {req.requestType === "issue_report" ? "Mark handled" : "Accept"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setActing({ kind: "reject", id: req.id })}
                    className={BTN}
                  >
                    Reject
                  </button>
                  {req.requestType === "order_session" && (
                    <button type="button" onClick={() => onPrintSlip(req)} className={BTN}>
                      Print slip
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <AdminDialog
        open={acting?.kind === "accept" && target !== null}
        title={target ? `Accept · ${REQUEST_TYPE_LABEL[target.requestType]}` : "Accept"}
        onClose={() => !busy && setActing(null)}
      >
        {target && acting?.kind === "accept" && (
          <>
            {target.requestType === "order_session" && (
              <AcceptSessionForm
                key={target.id}
                req={target}
                devices={freeDevices}
                stations={activeStations}
                requireStation={snap.settings.requireStation}
                currency={snap.currency}
                busy={busy}
                onCancel={() => setActing(null)}
                onSubmit={async (input) => {
                  if (await onAccept(target, input)) setActing(null)
                }}
              />
            )}
            {target.requestType === "maintenance" && (
              <AcceptRefillForm
                key={target.id}
                req={target}
                currency={snap.currency}
                busy={busy}
                onCancel={() => setActing(null)}
                onSubmit={async () => {
                  if (await onAccept(target, {})) setActing(null)
                }}
              />
            )}
            {target.requestType === "end_session" && (
              <AcceptEndForm
                key={target.id}
                req={target}
                currency={snap.currency}
                busy={busy}
                onCancel={() => setActing(null)}
                onSubmit={async (input) => {
                  if (await onAccept(target, input)) setActing(null)
                }}
              />
            )}
          </>
        )}
      </AdminDialog>

      <AdminDialog
        open={acting?.kind === "reject" && target !== null}
        title="Reject request?"
        onClose={() => !busy && setActing(null)}
      >
        {target && acting?.kind === "reject" && (
          <RejectForm
            key={target.id}
            busy={busy}
            onCancel={() => setActing(null)}
            onSubmit={async (reason) => {
              if (await onReject(target, reason)) setActing(null)
            }}
          />
        )}
      </AdminDialog>
    </div>
  )
}

function RequestSummary({ req, currency }: { req: ShishaRequest; currency: string }) {
  const amountText = requestAmountText(req, currency)
  return (
    <div className="space-y-1 rounded-md bg-[#F3EEE2] p-3 text-sm text-[#1C1A17]">
      <p className="font-medium">{req.customerName ?? req.customerPhone ?? "Unknown customer"}</p>
      {req.flavourName && (
        <p>
          {req.flavourName}
          {req.stationName ? ` · ${req.stationName}` : ""}
        </p>
      )}
      {amountText && <p className="tabular-nums text-[#6B6558]">{amountText}</p>}
    </div>
  )
}

function AcceptSessionForm({
  req,
  devices,
  stations,
  requireStation,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  req: ShishaRequest
  devices: ShishaDevice[]
  stations: ShishaStation[]
  requireStation: boolean
  currency: string
  busy: boolean
  onCancel: () => void
  onSubmit: (input: AcceptInput) => Promise<void>
}) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "")
  // Pre-pick the station the customer asked for (if it's still offered).
  const [locationId, setLocationId] = useState(stations.find((st) => st.name === req.stationName)?.id ?? "")
  const [method, setMethod] = useState<string>(DEFAULT_PAYMENT_METHOD)

  if (devices.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[#1C1A17]">Every device is in use or under maintenance. Free one up, or reject.</p>
        <div className="flex justify-end">
          <button type="button" onClick={onCancel} className={BTN}>
            Close
          </button>
        </div>
      </div>
    )
  }

  const device = devices.find((d) => d.id === deviceId)
  const usual = stations.find((st) => st.id === device?.locationId) ?? null
  const effectiveStationId = locationId || usual?.id || ""
  const stationRequired = requireStation && stations.length > 0
  const stationMissing = stationRequired && !effectiveStationId
  const flavourBlocked = req.flavourIssue !== null
  const quotedDiffers =
    req.quotedAmount !== null && req.currentAmount !== null && req.quotedAmount !== req.currentAmount

  return (
    <div className="space-y-4">
      <RequestSummary req={req} currency={currency} />
      {quotedDiffers && (
        <p className="text-xs text-[#9A6A12]">
          The price changed since the customer asked. They'll be charged today's price and told the amount.
        </p>
      )}
      {flavourBlocked && (
        <p className="text-xs text-[#7A2E2E]">
          {req.flavourIssue === "missing" ? "That flavour is no longer on the menu." : "That flavour is out of stock."}{" "}
          Fix that first, or reject the request.
        </p>
      )}

      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Device</span>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={FIELD}>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.deviceCode}
              {d.deviceName ? ` — ${d.deviceName}` : ""}
            </option>
          ))}
        </select>
      </label>

      {stations.length > 0 && (
        <label className="block space-y-1 text-sm">
          <span className="text-[#8A8375]">
            Station
            {stationRequired && <span className="font-medium text-[#7A2E2E]"> * required</span>}
          </span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={FIELD}>
            <option value="">
              {usual ? `Device's usual: ${usual.name}` : stationRequired ? "Pick a station…" : "No station"}
            </option>
            {stations.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Paid by</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={FIELD}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !deviceId || stationMissing || flavourBlocked}
          onClick={() =>
            void onSubmit({ deviceId, locationId: effectiveStationId || null, paymentMethod: method })
          }
          className={BTN_PRIMARY}
        >
          {busy
            ? "Starting…"
            : stationMissing
              ? "Pick a station"
              : `Accept${req.currentAmount !== null ? ` · ${formatMoney(req.currentAmount, currency)}` : ""}`}
        </button>
      </div>
    </div>
  )
}

function AcceptRefillForm({
  req,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  req: ShishaRequest
  currency: string
  busy: boolean
  onCancel: () => void
  onSubmit: () => Promise<void>
}) {
  const charge = req.currentAmount ?? 0
  return (
    <div className="space-y-4">
      <RequestSummary req={req} currency={currency} />
      <p className="text-sm text-[#1C1A17]">
        {charge > 0
          ? `This refills the session and adds ${formatMoney(charge, currency)} to it. Collect it from the customer.`
          : "This refills the session. Refills are free for this flavour."}
      </p>
      {req.sessionPaused && (
        <p className="text-xs text-[#9A6A12]">That session is paused. Resume it in Sessions first.</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button type="button" disabled={busy || req.sessionPaused} onClick={() => void onSubmit()} className={BTN_PRIMARY}>
          {busy ? "Refilling…" : charge > 0 ? `Refill · ${formatMoney(charge, currency)}` : "Refill"}
        </button>
      </div>
    </div>
  )
}

function AcceptEndForm({
  req,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  req: ShishaRequest
  currency: string
  busy: boolean
  onCancel: () => void
  onSubmit: (input: AcceptInput) => Promise<void>
}) {
  const [method, setMethod] = useState<string>(DEFAULT_PAYMENT_METHOD)
  const alreadyPaid = paymentMethodLabel(req.sessionPaymentMethod)
  return (
    <div className="space-y-4">
      <RequestSummary req={req} currency={currency} />
      <p className="text-sm text-[#1C1A17]">The session ends and the device becomes available again.</p>
      {alreadyPaid ? (
        <p className="text-sm text-[#6B6558]">Payment on file: {alreadyPaid}. Collect any refills added since.</p>
      ) : (
        <label className="block space-y-1 text-sm">
          <span className="text-[#8A8375]">Paid by</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={FIELD}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onSubmit({ paymentMethod: alreadyPaid ? null : method })}
          className={BTN_DANGER}
        >
          {busy ? "Ending…" : "End session"}
        </button>
      </div>
    </div>
  )
}

function RejectForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState("")
  return (
    <div className="space-y-4">
      <p className="text-sm text-[#1C1A17]">
        The customer is told on WhatsApp, and can send a new request straight away.
      </p>
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Reason (optional, sent to the customer)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          placeholder="e.g. That flavour has run out"
          className={FIELD}
          autoFocus
        />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Keep it
        </button>
        <button type="button" disabled={busy} onClick={() => void onSubmit(reason)} className={BTN_DANGER}>
          {busy ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Sessions
// ============================================================================

function SessionsPanel({
  snap,
  timezone,
  canOperate,
  busy,
  occupiedDeviceIds,
  onStart,
  onPause,
  onResume,
  onRefill,
  onEnd,
}: {
  snap: ShishaSnapshot
  timezone: string
  canOperate: boolean
  busy: boolean
  occupiedDeviceIds: Set<string>
  onStart: (input: { deviceId: string; productId: string; locationId: string; customerPhone: string }) => Promise<boolean>
  onPause: (s: ShishaSession) => void
  onResume: (s: ShishaSession) => void
  onRefill: (s: ShishaSession) => void
  onEnd: (s: ShishaSession, method: string | null) => Promise<boolean>
}) {
  const now = useNow(1000)
  const [startOpen, setStartOpen] = useState(false)
  const [endTarget, setEndTarget] = useState<ShishaSession | null>(null)
  const [refillTarget, setRefillTarget] = useState<ShishaSession | null>(null)

  const rows = snap.sessions
    .map((s) => {
      const remaining = liveRemainingSeconds(s, now)
      return {
        s,
        remaining,
        signed: signedRemainingSeconds(s, now),
        status: deriveDisplayStatus(remaining, s.paused, snap.settings.refillThresholdMinutes),
      }
    })
    // Signed value so sessions that ran out sort most overdue first.
    .sort((a, b) => a.signed - b.signed)

  const needAttention = rows.filter((r) => r.status === "refill" || r.status === "expired").length
  const freeDevices = snap.devices.filter((d) => d.status !== "maintenance" && !occupiedDeviceIds.has(d.id))
  const availableFlavours = snap.flavours.filter((f) => f.isAvailable)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Live now" value={rows.length} />
        <Stat label="Need attention" value={needAttention} hint="Refill soon or time's up" />
        <Stat label="Free devices" value={freeDevices.length} />
        <Stat
          label="Today"
          value={formatMoney(snap.today.revenue, snap.currency)}
          hint={`${snap.today.sessions} ${snap.today.sessions === 1 ? "session" : "sessions"}`}
        />
      </div>

      {snap.usage && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="col-span-2">
            <Stat
              label={`Shisha fees · ${formatMonth(snap.usage.month)}`}
              value={formatMoney(snap.usage.amount, snap.usage.currency)}
              hint={`${snap.usage.sessions} ${snap.usage.sessions === 1 ? "session" : "sessions"} + ${snap.usage.refills} ${snap.usage.refills === 1 ? "refill" : "refills"} · invoiced on the 1st`}
            />
          </div>
        </div>
      )}

      {canOperate && (
        <div className="flex justify-end">
          <button type="button" onClick={() => setStartOpen(true)} disabled={busy} className={BTN_PRIMARY}>
            Start session
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState>
          No live sessions.{canOperate ? " Start one when a customer orders." : ""}
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ s, remaining, status }) => (
            <div key={s.id} className={`${CARD} space-y-3 p-4`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
                    {s.deviceCode}
                    <StationTag name={s.stationName} className="font-sans text-base" />
                  </p>
                  <p className="truncate text-sm text-[#6B6558]">{s.flavourName}</p>
                </div>
                <Badge className={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</Badge>
              </div>

              <p
                className={`font-[family-name:var(--font-admin-serif)] text-4xl tabular-nums ${
                  status === "expired" ? "text-[#7A2E2E]" : "text-[#1C1A17]"
                }`}
                aria-label="Time remaining"
              >
                {formatCountdown(remaining)}
              </p>

              <p className="text-xs text-[#8A8375]">
                {s.customerName ?? s.customerPhone ?? "Walk-in"} · started{" "}
                {new Date(s.startTime).toLocaleTimeString("en-ZA", {
                  timeZone: timezone,
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}{" "}
                · {s.refillCount} {s.refillCount === 1 ? "refill" : "refills"} · {formatMoney(s.totalAmount, snap.currency)}
                {s.refillTotal > 0 ? ` (incl. ${formatMoney(s.refillTotal, snap.currency)} refills)` : ""}
              </p>

              {canOperate && (
                <div className="flex flex-wrap gap-2">
                  {s.paused ? (
                    <button type="button" onClick={() => onResume(s)} disabled={busy} className={BTN_PRIMARY}>
                      Resume
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => (s.refillPrice > 0 ? setRefillTarget(s) : onRefill(s))}
                        disabled={busy}
                        className={status === "refill" || status === "expired" ? BTN_PRIMARY : BTN}
                      >
                        Refill{s.refillPrice > 0 ? ` · ${formatMoney(s.refillPrice, snap.currency)}` : ""}
                      </button>
                      <button type="button" onClick={() => onPause(s)} disabled={busy} className={BTN}>
                        Pause
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => setEndTarget(s)} disabled={busy} className={BTN_GHOST}>
                    End
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <AdminDialog open={startOpen} title="Start session" onClose={() => !busy && setStartOpen(false)}>
        {startOpen && (
          <StartSessionForm
            devices={freeDevices}
            flavours={availableFlavours}
            stations={snap.stations.filter((st) => st.isActive)}
            requireStation={snap.settings.requireStation}
            currency={snap.currency}
            busy={busy}
            onCancel={() => setStartOpen(false)}
            onSubmit={async (input) => {
              if (await onStart(input)) setStartOpen(false)
            }}
          />
        )}
      </AdminDialog>

      <AdminDialog
        open={refillTarget !== null}
        title={refillTarget ? `Refill ${refillTarget.deviceCode}?` : "Refill?"}
        onClose={() => !busy && setRefillTarget(null)}
      >
        {refillTarget && (
          <div className="space-y-4">
            <p className="text-sm text-[#1C1A17]">
              This adds {formatMoney(refillTarget.refillPrice, snap.currency)} to the session (the total becomes{" "}
              {formatMoney(refillTarget.totalAmount + refillTarget.refillPrice, snap.currency)}). Collect it from the
              customer.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRefillTarget(null)} disabled={busy} className={BTN}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onRefill(refillTarget)
                  setRefillTarget(null)
                }}
                className={BTN_PRIMARY}
              >
                Refill · {formatMoney(refillTarget.refillPrice, snap.currency)}
              </button>
            </div>
          </div>
        )}
      </AdminDialog>

      <AdminDialog
        open={endTarget !== null}
        title={endTarget ? `End ${endTarget.deviceCode}?` : "End session?"}
        onClose={() => !busy && setEndTarget(null)}
      >
        {endTarget && (
          <EndSessionForm
            session={endTarget}
            currency={snap.currency}
            busy={busy}
            onCancel={() => setEndTarget(null)}
            onSubmit={async (method) => {
              if (await onEnd(endTarget, method)) setEndTarget(null)
            }}
          />
        )}
      </AdminDialog>
    </div>
  )
}

function StartSessionForm({
  devices,
  flavours,
  stations,
  requireStation,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  devices: ShishaDevice[]
  flavours: ShishaFlavour[]
  /** Active stations only (the ones staff can pick). */
  stations: ShishaStation[]
  requireStation: boolean
  currency: string
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { deviceId: string; productId: string; locationId: string; customerPhone: string }) => Promise<void>
}) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "")
  const [locationId, setLocationId] = useState("")
  const [productId, setProductId] = useState(flavours[0]?.id ?? "")
  const [phone, setPhone] = useState("")

  if (devices.length === 0 || flavours.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[#1C1A17]">
          {devices.length === 0
            ? "Every device is in use or under maintenance."
            : "No flavours are in stock. Add one or mark one as in stock first."}
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={onCancel} className={BTN}>
            Close
          </button>
        </div>
      </div>
    )
  }

  const chosen = flavours.find((f) => f.id === productId)

  // Station = explicit pick, else the chosen device's usual station (if staff can
  // pick it, i.e. it's active). Same rule the server applies.
  const device = devices.find((d) => d.id === deviceId)
  const usualStation = stations.find((st) => st.id === device?.locationId) ?? null
  const effectiveStationId = locationId || usualStation?.id || ""
  const stationRequired = requireStation && stations.length > 0
  const stationMissing = stationRequired && !effectiveStationId

  return (
    <div className="space-y-4">
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Device</span>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={FIELD}>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.deviceCode}
              {d.deviceName ? ` — ${d.deviceName}` : ""}
            </option>
          ))}
        </select>
      </label>
      {stations.length > 0 && (
        <label className="block space-y-1 text-sm">
          <span className="text-[#8A8375]">
            Station
            {stationRequired && <span className="font-medium text-[#7A2E2E]"> * required</span>}
          </span>
          {stationRequired ? (
            <select
              value={effectiveStationId}
              onChange={(e) => setLocationId(e.target.value)}
              required
              aria-required="true"
              className={FIELD}
            >
              {!effectiveStationId && (
                <option value="" disabled>
                  Pick a station…
                </option>
              )}
              {stations.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                  {st.id === usualStation?.id ? " (device's usual station)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={FIELD}>
              <option value="">{usualStation ? `${usualStation.name} (device's usual station)` : "No station"}</option>
              {stations
                .filter((st) => st.id !== usualStation?.id)
                .map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
            </select>
          )}
        </label>
      )}
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Flavour</span>
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className={FIELD}>
          {flavours.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} · {formatMoney(f.price, currency)}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Customer cellphone (optional)</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          placeholder="Leave empty for a walk-in"
          className={FIELD}
        />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !deviceId || !productId || stationMissing}
          onClick={() => void onSubmit({ deviceId, productId, locationId: effectiveStationId, customerPhone: phone })}
          className={BTN_PRIMARY}
        >
          {busy
            ? "Starting…"
            : stationMissing
              ? "Pick a station to start"
              : `Start${chosen ? ` · ${formatMoney(chosen.price, currency)}` : ""}`}
        </button>
      </div>
    </div>
  )
}

function EndSessionForm({
  session,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  session: ShishaSession
  currency: string
  busy: boolean
  onCancel: () => void
  onSubmit: (method: string | null) => Promise<void>
}) {
  const [method, setMethod] = useState<string>(DEFAULT_PAYMENT_METHOD)
  // A payment already taken (e.g. up front at the counter) must never be overwritten.
  const alreadyPaid = paymentMethodLabel(session.paymentMethod)
  return (
    <div className="space-y-4">
      <p className="text-sm text-[#1C1A17]">
        {session.flavourName} · {formatMoney(session.totalAmount, currency)}. The device becomes available again.
      </p>
      {alreadyPaid ? (
        <p className="text-sm text-[#6B6558]">
          Already paid by {alreadyPaid}.
          {session.refillTotal > 0 ? " Collect any refills added since." : ""}
        </p>
      ) : (
        <label className="block space-y-1 text-sm">
          <span className="text-[#8A8375]">Paid by</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={FIELD}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Keep running
        </button>
        <button type="button" disabled={busy} onClick={() => void onSubmit(alreadyPaid ? null : method)} className={BTN_DANGER}>
          {busy ? "Ending…" : "End session"}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Flavours
// ============================================================================

function PanelHeader({
  title,
  hint,
  canManage,
  busy,
  addLabel,
  onAdd,
}: {
  title: string
  hint: string
  canManage: boolean
  busy: boolean
  addLabel: string
  onAdd: () => void
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">{title}</h3>
        <p className="mt-0.5 text-sm text-[#8A8375]">{hint}</p>
      </div>
      {canManage && (
        <button type="button" onClick={onAdd} disabled={busy} className={BTN_PRIMARY}>
          {addLabel}
        </button>
      )}
    </div>
  )
}

function FlavoursPanel({
  snap,
  canManage,
  busy,
  onAdd,
  onEdit,
  onToggle,
  onArchive,
}: {
  snap: ShishaSnapshot
  canManage: boolean
  busy: boolean
  onAdd: () => void
  onEdit: (f: ShishaFlavour) => void
  onToggle: (f: ShishaFlavour) => void
  onArchive: (f: ShishaFlavour) => void
}) {
  return (
    <div className="space-y-4">
      <PanelHeader
        title="Flavours"
        hint="What customers can order and what it costs."
        canManage={canManage}
        busy={busy}
        addLabel="Add flavour"
        onAdd={onAdd}
      />
      {snap.flavours.length === 0 ? (
        <EmptyState>No flavours yet.{canManage ? " Add your first one." : ""}</EmptyState>
      ) : (
        <ul className="divide-y divide-[#E6E1D4] overflow-hidden rounded-lg border border-[#E6E1D4] bg-white">
          {snap.flavours.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[#1C1A17]">{f.name}</p>
                <p className="text-xs tabular-nums text-[#8A8375]">
                  Session {formatMoney(f.price, snap.currency)} · Refill{" "}
                  {f.refillPrice > 0 ? formatMoney(f.refillPrice, snap.currency) : "free"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={f.isAvailable ? "bg-[#4B6B54]/10 text-[#4B6B54]" : "bg-[#7A2E2E]/10 text-[#7A2E2E]"}>
                  {f.isAvailable ? "In stock" : "Out of stock"}
                </Badge>
                {canManage && (
                  <>
                    <button type="button" onClick={() => onToggle(f)} disabled={busy} className={BTN}>
                      {f.isAvailable ? "Mark out of stock" : "Mark in stock"}
                    </button>
                    <button type="button" onClick={() => onEdit(f)} disabled={busy} className={BTN}>
                      Edit
                    </button>
                    <button type="button" onClick={() => onArchive(f)} disabled={busy} className={BTN_GHOST}>
                      Archive
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FlavourForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: ShishaFlavour | null
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { name: string; price: number; refillPrice: number }) => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [price, setPrice] = useState(initial ? String(initial.price) : "")
  const [refillPrice, setRefillPrice] = useState(initial ? String(initial.refillPrice) : "0")
  const priceNumber = price.trim() === "" ? NaN : Number(price)
  const refillNumber = refillPrice.trim() === "" ? NaN : Number(refillPrice)
  const valid =
    name.trim() !== "" &&
    Number.isFinite(priceNumber) &&
    priceNumber >= 0 &&
    Number.isFinite(refillNumber) &&
    refillNumber >= 0

  return (
    <div className="space-y-4">
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Double apple" className={FIELD} autoFocus />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Price</span>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="decimal"
          placeholder="250"
          className={FIELD}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Refill price</span>
        <input
          value={refillPrice}
          onChange={(e) => setRefillPrice(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className={FIELD}
        />
        <span className="block text-xs text-[#8A8375]">
          Charged each time a session with this flavour is refilled. 0 = refills are free.
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() => void onSubmit({ name, price: priceNumber, refillPrice: refillNumber })}
          className={BTN_PRIMARY}
        >
          {busy ? "Saving…" : "Save flavour"}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Devices
// ============================================================================

function DevicesPanel({
  snap,
  canManage,
  busy,
  occupiedDeviceIds,
  stationById,
  onAdd,
  onEdit,
  onToggleMaintenance,
  onArchive,
}: {
  snap: ShishaSnapshot
  canManage: boolean
  busy: boolean
  occupiedDeviceIds: Set<string>
  stationById: Map<string, ShishaStation>
  onAdd: () => void
  onEdit: (d: ShishaDevice) => void
  onToggleMaintenance: (d: ShishaDevice) => void
  onArchive: (d: ShishaDevice) => void
}) {
  return (
    <div className="space-y-4">
      <PanelHeader
        title="Devices"
        hint="Your hookahs. A device in use can't be edited out from under a live session."
        canManage={canManage}
        busy={busy}
        addLabel="Add device"
        onAdd={onAdd}
      />
      {snap.devices.length === 0 ? (
        <EmptyState>No devices yet.{canManage ? " Add your first one." : ""}</EmptyState>
      ) : (
        <ul className="divide-y divide-[#E6E1D4] overflow-hidden rounded-lg border border-[#E6E1D4] bg-white">
          {snap.devices.map((d) => {
            const inUse = occupiedDeviceIds.has(d.id)
            const state = d.status === "maintenance" ? "maintenance" : inUse ? "in_use" : "available"
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#1C1A17]">
                    {d.deviceCode}
                    {d.deviceName ? <span className="font-normal text-[#6B6558]"> — {d.deviceName}</span> : null}
                  </p>
                  <p className="text-xs text-[#8A8375]">
                    {(d.locationId && stationById.get(d.locationId)?.name) || "No usual station"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className={
                      state === "available"
                        ? "bg-[#4B6B54]/10 text-[#4B6B54]"
                        : state === "in_use"
                          ? "bg-[#2557A7]/10 text-[#2557A7]"
                          : "bg-[#9A6A12]/10 text-[#9A6A12]"
                    }
                  >
                    {state === "available" ? "Available" : state === "in_use" ? "In use" : "Maintenance"}
                  </Badge>
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => onToggleMaintenance(d)}
                        disabled={busy || inUse}
                        className={BTN}
                      >
                        {d.status === "maintenance" ? "Back in service" : "Maintenance"}
                      </button>
                      <button type="button" onClick={() => onEdit(d)} disabled={busy} className={BTN}>
                        Edit
                      </button>
                      <button type="button" onClick={() => onArchive(d)} disabled={busy || inUse} className={BTN_GHOST}>
                        Archive
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function DeviceForm({
  initial,
  stations,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: ShishaDevice | null
  stations: ShishaStation[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { deviceCode: string; deviceName: string; locationId: string | null }) => Promise<void>
}) {
  const [code, setCode] = useState(initial?.deviceCode ?? "")
  const [name, setName] = useState(initial?.deviceName ?? "")
  const [locationId, setLocationId] = useState(initial?.locationId ?? "")

  return (
    <div className="space-y-4">
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Device code</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="SH-031" className={FIELD} autoFocus />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Terrace hookah 1" className={FIELD} />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Usual station (optional)</span>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={FIELD}>
          <option value="">No usual station</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="block text-xs text-[#8A8375]">
          Pre-selected when staff start a session on this device. They can still pick a different station.
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || code.trim() === ""}
          onClick={() => void onSubmit({ deviceCode: code, deviceName: name, locationId: locationId || null })}
          className={BTN_PRIMARY}
        >
          {busy ? "Saving…" : "Save device"}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Stations
// ============================================================================

function StationsPanel({
  snap,
  canManage,
  busy,
  onAdd,
  onEdit,
  onToggle,
  onArchive,
}: {
  snap: ShishaSnapshot
  canManage: boolean
  busy: boolean
  onAdd: () => void
  onEdit: (s: ShishaStation) => void
  onToggle: (s: ShishaStation) => void
  onArchive: (s: ShishaStation) => void
}) {
  return (
    <div className="space-y-4">
      <PanelHeader
        title="Stations"
        hint="Areas of the venue where devices are set up."
        canManage={canManage}
        busy={busy}
        addLabel="Add station"
        onAdd={onAdd}
      />
      {snap.stations.length === 0 ? (
        <EmptyState>No stations yet.{canManage ? " Add your first one." : ""}</EmptyState>
      ) : (
        <ul className="divide-y divide-[#E6E1D4] overflow-hidden rounded-lg border border-[#E6E1D4] bg-white">
          {snap.stations.map((s) => {
            const deviceCount = snap.devices.filter((d) => d.locationId === s.id).length
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#1C1A17]">{s.name}</p>
                  <p className="text-xs text-[#8A8375]">
                    {deviceCount} {deviceCount === 1 ? "device" : "devices"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={s.isActive ? "bg-[#4B6B54]/10 text-[#4B6B54]" : "bg-[#1C1A17]/[0.07] text-[#6B6558]"}>
                    {s.isActive ? "Visible to customers" : "Hidden from customers"}
                  </Badge>
                  {canManage && (
                    <>
                      <button type="button" onClick={() => onToggle(s)} disabled={busy} className={BTN}>
                        {s.isActive ? "Hide" : "Show"}
                      </button>
                      <button type="button" onClick={() => onEdit(s)} disabled={busy} className={BTN}>
                        Edit
                      </button>
                      <button type="button" onClick={() => onArchive(s)} disabled={busy} className={BTN_GHOST}>
                        Archive
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function StationForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: ShishaStation | null
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { name: string }) => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? "")
  return (
    <div className="space-y-4">
      <label className="block space-y-1 text-sm">
        <span className="text-[#8A8375]">Station name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP terrace" className={FIELD} autoFocus />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || name.trim() === ""}
          onClick={() => void onSubmit({ name })}
          className={BTN_PRIMARY}
        >
          {busy ? "Saving…" : "Save station"}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Timing
// ============================================================================

function TimingPanel({
  snap,
  canManage,
  busy,
  onSave,
}: {
  snap: ShishaSnapshot
  canManage: boolean
  busy: boolean
  onSave: (input: { coalDurationMinutes: number; refillThresholdMinutes: number; requireStation: boolean }) => Promise<boolean>
}) {
  const [duration, setDuration] = useState(String(snap.settings.coalDurationMinutes))
  const [threshold, setThreshold] = useState(String(snap.settings.refillThresholdMinutes))
  const [requireStation, setRequireStation] = useState(snap.settings.requireStation)
  const d = Number(duration)
  const t = Number(threshold)
  const valid =
    Number.isInteger(d) && d >= 5 && d <= 480 && Number.isInteger(t) && t >= 1 && t <= 120 && t < d

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">Timing</h3>
        <p className="mt-0.5 text-sm text-[#8A8375]">
          Applies to new sessions and refills. Sessions already running keep the time they have.
        </p>
      </div>
      <div className={`${CARD} max-w-md space-y-4 p-4`}>
        <label className="block space-y-1 text-sm">
          <span className="text-[#8A8375]">Session length (minutes)</span>
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
            disabled={!canManage}
            className={FIELD}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-[#8A8375]">Warn this many minutes before time runs out</span>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="numeric"
            disabled={!canManage}
            className={FIELD}
          />
        </label>
        <div className="space-y-1 border-t border-[#E6E1D4] pt-4">
          <label className="flex items-center gap-2 text-sm text-[#1C1A17]">
            <input
              type="checkbox"
              checked={requireStation}
              onChange={(e) => setRequireStation(e.target.checked)}
              disabled={!canManage}
            />
            Require a station for every session
          </label>
          <p className="text-xs text-[#8A8375]">
            Link devices to a usual station in Devices to have it selected automatically.
          </p>
        </div>
        {!valid && canManage && (
          <p className="text-xs text-[#7A2E2E]">
            Session length is 5–480 minutes, the warning is 1–120 minutes and must be shorter than the session.
          </p>
        )}
        {canManage && (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy || !valid}
              onClick={() => void onSave({ coalDurationMinutes: d, refillThresholdMinutes: t, requireStation })}
              className={BTN_PRIMARY}
            >
              {busy ? "Saving…" : "Save timing"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
