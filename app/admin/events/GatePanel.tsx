"use client"

// app/admin/events/GatePanel.tsx
//
// Door check-in (the Rands "Monitor" view). The scan field keeps focus, so a
// hardware QR scanner (which types the code and presses Enter) or a person typing
// a ticket number both work. Every result, including failures, is kept in the
// event's scan log by the database.
//
// The ScanBox is the main stage: while idle a line sweeps up and down inside a
// viewfinder; when a scan comes back, the result takes over the same box, then
// the box returns to idle so the line resumes for the next person.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { checkInTicket, loadGate } from "./actions"
import { formatClock, formatEventDate } from "./format"
import type { CheckInResult, EventScan, EventSummary, GateSnapshot, ScanResult } from "./types"
import { BTN_GHOST, EmptyState, INPUT, Icon, LABEL, PANEL, ProgressBar, WELL } from "./ui"

const RESULT_STYLE: Record<ScanResult, { icon: string; box: string; title: string }> = {
  valid: { icon: "circle-check", box: "bg-emerald-600 text-white", title: "Let them in" },
  duplicate: { icon: "rotate-left", box: "bg-amber-500 text-black", title: "Already used" },
  invalid: { icon: "circle-xmark", box: "bg-red-600 text-white", title: "Not a valid ticket" },
  wrong_event: { icon: "calendar-xmark", box: "bg-red-600 text-white", title: "Wrong event" },
  cancelled: { icon: "ban", box: "bg-red-600 text-white", title: "Ticket cancelled" },
  event_closed: { icon: "lock", box: "bg-stone-700 text-white", title: "Gate is closed" },
}

const SCAN_LABEL: Record<ScanResult, string> = {
  valid: "Admitted",
  duplicate: "Duplicate",
  invalid: "Not found",
  wrong_event: "Wrong event",
  cancelled: "Cancelled",
  event_closed: "Gate closed",
}

/** How long a result stays in the box before it returns to the sweeping line. */
const RESULT_MS_GOOD = 4_000
const RESULT_MS_BAD = 8_000

export function GatePanel({
  events,
  loadError,
  selectedId,
  onSelect,
  timezone,
  onScanned,
  onGoToEvents,
}: {
  events: EventSummary[] | null
  loadError: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  timezone: string
  onScanned: () => Promise<void>
  onGoToEvents: () => void
}) {
  const open = useMemo(() => (events ?? []).filter((e) => e.status === "active"), [events])
  const event = open.find((e) => e.id === selectedId) ?? open[0] ?? null

  const [code, setCode] = useState("")
  const [gate, setGate] = useState("Main gate")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckInResult | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [snap, setSnap] = useState<GateSnapshot | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const refreshSnap = useCallback(async () => {
    if (!event) return
    const res = await loadGate(event.id)
    if (res.ok) setSnap(res.data)
  }, [event])

  useEffect(() => {
    setSnap(null)
    setResult(null)
    void refreshSnap()
    // Other gates may be scanning too, so keep the counts and feed fresh.
    const id = setInterval(() => void refreshSnap(), 10_000)
    return () => clearInterval(id)
  }, [refreshSnap])

  useEffect(() => { input.current?.focus() }, [event?.id])

  // Hand the box back to the sweeping line after a while.
  useEffect(() => {
    if (!result && !scanError) return
    const good = result?.success === true
    const t = setTimeout(() => {
      setResult(null)
      setScanError(null)
    }, good ? RESULT_MS_GOOD : RESULT_MS_BAD)
    return () => clearTimeout(t)
  }, [result, scanError])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const value = code.trim()
    if (!event || !value || busy) return
    setBusy(true)
    setScanError(null)
    setResult(null)
    const res = await checkInTicket(event.id, value, gate.trim() || null)
    setBusy(false)
    setCode("")
    if (res.ok) {
      setResult(res.data)
      await Promise.all([refreshSnap(), res.data.success ? onScanned() : Promise.resolve()])
    } else {
      setScanError(res.error)
    }
    input.current?.focus()
  }

  if (loadError) return <EmptyState icon="triangle-exclamation" title="Couldn't load events">{loadError}</EmptyState>
  if (events === null) return <div className="h-64 animate-pulse rounded-3xl bg-stone-500/10" aria-busy="true" />
  if (!event) {
    return (
      <EmptyState icon="qrcode" title="No event is open for check-in" action={<button type="button" className={BTN_GHOST} onClick={onGoToEvents}>Go to Events</button>}>
        The gate opens when an event is on sale.
      </EmptyState>
    )
  }

  const sold = snap?.sold ?? event.ticketTypes.reduce((n, t) => n + t.sold, 0)

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
      <div className="space-y-5">
        <section className={`${PANEL} grid gap-4 p-5 sm:grid-cols-[1fr_200px]`}>
          <div>
            <label className={LABEL} htmlFor="gate-event">Event</label>
            <select id="gate-event" className={INPUT} value={event.id} onChange={(e) => onSelect(e.target.value)}>
              {open.map((e) => (
                <option key={e.id} value={e.id}>{e.name} · {formatEventDate(e.startTime, timezone)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="gate-name">This gate</label>
            <input id="gate-name" className={INPUT} value={gate} onChange={(e) => setGate(e.target.value)} />
          </div>
        </section>

        <ScanBox busy={busy} result={result} error={scanError} timezone={timezone} />

        <form onSubmit={submit} className={`${PANEL} p-5`}>
          <label className={LABEL} htmlFor="gate-code">Scan or type a ticket</label>
          <div className="flex gap-2">
            <input
              id="gate-code"
              ref={input}
              className={`${INPUT} !py-3.5 font-mono !text-lg`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="TKT-XXXXXXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              // A scanner types fast and presses Enter; refocusing keeps the next scan ready.
              onBlur={() => setTimeout(() => { if (document.activeElement === document.body) input.current?.focus() }, 50)}
            />
            <button type="submit" disabled={busy || !code.trim()} className={`${BTN_GHOST} !px-5`}>
              {busy ? "Checking…" : "Check in"}
            </button>
          </div>
        </form>
      </div>

      <div className="space-y-5">
        <section className={`${PANEL} p-5`} aria-label="Attendance">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-3xl font-bold text-stone-900">{snap?.admitted ?? "–"}</p>
              <p className="text-xs text-stone-500">checked in of {sold} sold</p>
            </div>
            {snap && snap.failed > 0 && <p className="text-xs text-stone-500">{snap.failed} refused so far</p>}
          </div>
          <div className="mt-3">
            <ProgressBar value={snap?.admitted ?? 0} max={sold} label="Checked in" />
          </div>
        </section>

        <section className={`${PANEL} p-5`} aria-labelledby="feed-h">
          <h2 id="feed-h" className="mb-3 text-sm font-bold text-stone-900">Recent scans</h2>
          {!snap ? (
            <div className="h-24 animate-pulse rounded-xl bg-stone-500/10" aria-busy="true" />
          ) : snap.recent.length === 0 ? (
            <p className="text-sm text-stone-500">Nothing scanned yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {snap.recent.map((s) => <ScanRow key={s.id} scan={s} timezone={timezone} />)}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * The viewfinder. Idle: corner brackets + a line sweeping up and down.
 * Busy: the line speeds up. Result / error: the box turns into the result card.
 */
function ScanBox({
  busy,
  result,
  error,
  timezone,
}: {
  busy: boolean
  result: CheckInResult | null
  error: string | null
  timezone: string
}) {
  const style = result ? RESULT_STYLE[result.result] : null
  const showing = Boolean(error || (result && style))

  // Screen readers get the outcome once, without hearing the idle text change.
  const announce = error ?? (result && style ? `${style.title}. ${result.message}` : "")

  const surface = error ? "bg-red-600 text-white" : style ? style.box : "bg-stone-900 text-white"

  return (
    <section aria-label="Scan result" className={`relative min-h-[17rem] overflow-hidden rounded-3xl transition-colors duration-200 ${surface}`}>
      <style>{`
        @keyframes gate-sweep { from { top: 10%; } to { top: 90%; } }
        .gate-sweep-line { animation: gate-sweep 2.2s ease-in-out infinite alternate; }
        .gate-sweep-line[data-busy="true"] { animation-duration: 0.7s; }
        @media (prefers-reduced-motion: reduce) {
          .gate-sweep-line { animation: none; top: 50%; }
        }
      `}</style>

      <div className="sr-only" aria-live="assertive" aria-atomic="true">{announce}</div>

      {showing ? (
        <div className="flex min-h-[17rem] flex-col justify-center p-6">
          <div className="flex items-center gap-4">
            <Icon name={error ? "triangle-exclamation" : style!.icon} className="text-5xl" />
            <div className="min-w-0">
              <p className="text-2xl font-bold">{error ? "Couldn't check in" : style!.title}</p>
              <p className="text-sm opacity-90">{error ?? result!.message}</p>
            </div>
          </div>
          {result && (result.ticketNumber || result.holder || result.ticketType) && (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/25 pt-4 text-sm sm:grid-cols-3">
              {result.ticketNumber && (<div><dt className="text-xs opacity-75">Ticket</dt><dd className="font-mono font-semibold">{result.ticketNumber}</dd></div>)}
              {result.ticketType && (<div><dt className="text-xs opacity-75">Tier</dt><dd className="font-semibold">{result.ticketType}</dd></div>)}
              {result.holder && (<div><dt className="text-xs opacity-75">Holder</dt><dd className="font-semibold">{result.holder}</dd></div>)}
              {result.entriesAllowed !== undefined && result.entriesAllowed > 1 && (
                <div><dt className="text-xs opacity-75">Entries</dt><dd className="font-semibold">{result.entriesUsed} of {result.entriesAllowed}</dd></div>
              )}
              {result.result === "duplicate" && result.lastScannedAt && (
                <div><dt className="text-xs opacity-75">First scanned</dt><dd className="font-semibold">{formatClock(result.lastScannedAt, timezone)}</dd></div>
              )}
            </dl>
          )}
        </div>
      ) : (
        <div className="relative min-h-[17rem]" aria-hidden="true">
          {/* Viewfinder corners */}
          <span className="absolute left-5 top-5 h-8 w-8 rounded-tl-xl border-l-4 border-t-4 border-white/70" />
          <span className="absolute right-5 top-5 h-8 w-8 rounded-tr-xl border-r-4 border-t-4 border-white/70" />
          <span className="absolute bottom-5 left-5 h-8 w-8 rounded-bl-xl border-b-4 border-l-4 border-white/70" />
          <span className="absolute bottom-5 right-5 h-8 w-8 rounded-br-xl border-b-4 border-r-4 border-white/70" />

          {/* The sweeping line */}
          <span
            data-busy={busy}
            className="gate-sweep-line absolute left-8 right-8 h-0.5 rounded-full bg-[var(--sb-accent,var(--color-admin-accent))] shadow-[0_0_14px_3px_var(--sb-accent,var(--color-admin-accent))]"
          />

          <div className="absolute inset-x-0 bottom-9 text-center text-sm font-medium text-white/70">
            {busy ? "Checking…" : "Ready to scan"}
          </div>
        </div>
      )}
    </section>
  )
}

function ScanRow({ scan, timezone }: { scan: EventScan; timezone: string }) {
  const good = scan.result === "valid"
  return (
    <li className={`${WELL} flex items-center gap-3 px-3 py-2 text-xs`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${good ? "bg-emerald-500" : scan.result === "duplicate" ? "bg-amber-500" : "bg-red-500"}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-stone-800">{scan.ticketNumber ?? "Unknown code"}</span>
      <span className="text-stone-500">{SCAN_LABEL[scan.result]}</span>
      <span className="text-stone-400">{formatClock(scan.scannedAt, timezone)}</span>
    </li>
  )
}
