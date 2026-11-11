"use client"

// app/admin/events/GatePanel.tsx
//
// Door check-in (the Rands "Monitor" view). The scan field keeps focus, so a
// hardware QR scanner (which types the code and presses Enter) or a person typing
// a ticket number both work. Every result, including failures, is kept in the
// event's scan log by the database; this screen just shows the latest.

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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const value = code.trim()
    if (!event || !value || busy) return
    setBusy(true)
    setScanError(null)
    const res = await checkInTicket(event.id, value, gate.trim() || null)
    setBusy(false)
    setCode("")
    if (res.ok) {
      setResult(res.data)
      await Promise.all([refreshSnap(), res.data.success ? onScanned() : Promise.resolve()])
    } else {
      setResult(null)
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

  const style = result ? RESULT_STYLE[result.result] : null
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

        <div aria-live="assertive" aria-atomic="true">
          {scanError && <p role="alert" className="rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-600">{scanError}</p>}
          {result && style && (
            <div className={`rounded-3xl p-6 ${style.box}`}>
              <div className="flex items-center gap-4">
                <Icon name={style.icon} className="text-5xl" />
                <div className="min-w-0">
                  <p className="text-2xl font-bold">{style.title}</p>
                  <p className="text-sm opacity-90">{result.message}</p>
                </div>
              </div>
              {(result.ticketNumber || result.holder || result.ticketType) && (
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
          )}
        </div>
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
