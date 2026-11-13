"use client"

// app/scan/[slug]/ScannerApp.tsx
//
// The mobile gate scanner, converted from the original single-shop scanner.html.
// Same look and flow: pick the event and gate, big SCAN TICKET button, full-screen camera with
// torch / flip, manual entry (ticket number, phone or email), a result card that clears itself,
// live numbers and a live activity feed.
//
// What changed for the multi-tenant platform:
//   - it belongs to one tenant (from the URL slug) and wears that tenant's branding
//   - check-ins go through server actions -> scanner_check_in_* database functions
//   - no logout button, no login yet (see data.ts authorizeScan)
//   - the live feed and counts are refreshed by polling (the old page used a public realtime
//     subscription, which the new row-level security rightly doesn't allow)

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react"
import { loadScanEvents, loadScanSnapshot, submitScan } from "./actions"
import { ScanHeader, type SyncState } from "./ScanHeader"
import { clockTime, eventStamp } from "./time"
import type { ScanEvent, ScanOutcome, ScanResult, ScanSnapshot, ScanTenant } from "./types"

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

const QR_LIB_URL = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"
const GATE_OPENS_BEFORE_MS = 3 * 60 * 60 * 1000 // doors can open 3h before the listed start
const SNAPSHOT_EVERY_MS = 5_000
const EVENTS_EVERY_MS = 30_000
const SUCCESS_SHOWN_MS = 3_000
const REFUSAL_SHOWN_MS = 4_000
const SAME_CODE_BLOCK_MS = 2_500 // a QR still in frame must not re-trigger straight after a result

// ----------------------------------------------------------------------------
// html5-qrcode (loaded from the CDN on first use, like the original page)
// ----------------------------------------------------------------------------

interface QrReader {
  start(
    camera: unknown,
    config: unknown,
    onSuccess: (text: string) => void,
    onError?: (message: string) => void,
  ): Promise<unknown>
  stop(): Promise<unknown>
  clear(): void
  applyVideoConstraints(constraints: MediaTrackConstraints): Promise<unknown>
}

declare global {
  interface Window {
    Html5Qrcode?: new (elementId: string, verbose?: boolean) => QrReader
  }
}

let qrLibLoading: Promise<void> | null = null
function loadQrLibrary(): Promise<void> {
  if (window.Html5Qrcode) return Promise.resolve()
  if (!qrLibLoading) {
    qrLibLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script")
      script.src = QR_LIB_URL
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        qrLibLoading = null
        script.remove()
        reject(new Error("Couldn't load the camera scanner. Check your connection."))
      }
      document.head.appendChild(script)
    })
  }
  return qrLibLoading
}

// ----------------------------------------------------------------------------
// Event timing
// ----------------------------------------------------------------------------

type EventWindow = "live" | "upcoming" | "past"

function windowOf(ev: ScanEvent, now: number): EventWindow {
  const start = Date.parse(ev.startTime)
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN
  if (Number.isFinite(start) && now < start - GATE_OPENS_BEFORE_MS) return "upcoming"
  if (Number.isFinite(end) && now > end) return "past"
  return "live"
}

/** The event to start on: what's running now, else what's next, else the latest one. */
function pickDefault(events: ScanEvent[], now: number): string {
  const byStart = (a: ScanEvent, b: ScanEvent) => Date.parse(a.startTime) - Date.parse(b.startTime)
  const live = events.filter((e) => windowOf(e, now) === "live").sort((a, b) => byStart(b, a))
  if (live[0]) return live[0].id
  const next = events.filter((e) => windowOf(e, now) === "upcoming").sort(byStart)
  if (next[0]) return next[0].id
  return [...events].sort((a, b) => byStart(b, a))[0]?.id ?? ""
}

// ----------------------------------------------------------------------------
// Result card
// ----------------------------------------------------------------------------

type Tone = "success" | "used" | "error"

interface ResultView {
  tone: Tone
  title: string
  message: string
  rows: Array<[label: string, value: string]>
  ms: number
}

const TITLES: Record<ScanResult, string> = {
  valid: "ACCESS GRANTED",
  duplicate: "ALREADY CHECKED IN",
  invalid: "INVALID TICKET",
  wrong_event: "WRONG EVENT",
  cancelled: "TICKET CANCELLED",
  event_closed: "GATE CLOSED",
}

const TONE_STYLE: Record<Tone, { band: string; bg: string; fg: string; icon: string }> = {
  success: { band: "var(--success)", bg: "var(--success-bg)", fg: "var(--success)", icon: "circle-check" },
  used: { band: "var(--warning)", bg: "var(--warning-bg)", fg: "var(--warning)", icon: "ban" },
  error: { band: "var(--error)", bg: "var(--error-bg)", fg: "var(--error)", icon: "circle-xmark" },
}

function describe(o: ScanOutcome, eventName: string, tz: string): ResultView {
  const tone: Tone = o.success ? "success" : o.result === "duplicate" ? "used" : "error"
  const rows: ResultView["rows"] = []
  if (o.holder) rows.push(["Guest", o.holder])
  if (o.ticketType) rows.push(["Ticket", o.ticketType + (o.ticketCount && o.ticketCount > 1 ? ` ×${o.ticketCount}` : "")])
  if (o.ticketNumber) rows.push(["Number", o.ticketNumber])
  if (o.entriesAllowed && o.entriesAllowed > 1 && o.entriesUsed !== undefined) {
    rows.push(["Entries", `${o.entriesUsed} of ${o.entriesAllowed}`])
  }
  if (o.result === "duplicate" && o.lastScannedAt) rows.push(["Last scan", clockTime(o.lastScannedAt, tz)])
  if (rows.length > 0) {
    rows.push(["Event", eventName])
    rows.push(["Scanned", clockTime(new Date().toISOString(), tz)])
  }
  return {
    tone,
    title: TITLES[o.result],
    message: o.message || (o.success ? "Welcome!" : "Check-in refused"),
    rows,
    ms: o.success ? SUCCESS_SHOWN_MS : REFUSAL_SHOWN_MS,
  }
}

// ----------------------------------------------------------------------------
// Feedback (sound + vibration), created on the first tap so phones allow it
// ----------------------------------------------------------------------------

let audio: AudioContext | null = null
function audioContext(): AudioContext | null {
  try {
    if (!audio) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      audio = new Ctor()
    }
    return audio
  } catch {
    return null
  }
}

function feedback(success: boolean) {
  try {
    navigator.vibrate?.(success ? [80] : [120, 60, 120])
  } catch {
    /* not supported */
  }
  try {
    const ctx = audioContext()
    if (!ctx) return
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    if (success) {
      ;[523, 659, 783].forEach((freq, i) => {
        const osc = ctx.createOscillator()
        osc.type = "sine"
        osc.frequency.value = freq
        osc.connect(gain)
        gain.gain.setValueAtTime(0.13, ctx.currentTime + i * 0.1)
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.1 + 0.3)
        osc.start(ctx.currentTime + i * 0.1)
        osc.stop(ctx.currentTime + i * 0.1 + 0.32)
      })
    } else {
      const osc = ctx.createOscillator()
      osc.type = "sawtooth"
      osc.frequency.setValueAtTime(300, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.3)
      osc.connect(gain)
      gain.gain.setValueAtTime(0.14, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
      osc.start()
      osc.stop(ctx.currentTime + 0.38)
    }
  } catch {
    /* sound is a nicety, never a failure */
  }
}

// ----------------------------------------------------------------------------
// Small pieces
// ----------------------------------------------------------------------------

function Icon({ name, className = "", style }: { name: string; className?: string; style?: CSSProperties }) {
  return <i className={`fa-solid fa-${name} ${className}`} style={style} aria-hidden="true" />
}

/** A stat number that flashes green/red when it changes. */
function StatNumber({ value }: { value: number }) {
  const previous = useRef(value)
  const [flash, setFlash] = useState<"up" | "down" | null>(null)
  useEffect(() => {
    if (previous.current === value) return
    setFlash(value > previous.current ? "up" : "down")
    previous.current = value
    const t = setTimeout(() => setFlash(null), 650)
    return () => clearTimeout(t)
  }, [value])
  return <div className={`stat-num${flash ? ` bump-${flash}` : ""}`}>{value}</div>
}

const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* private mode: remembering is optional */
    }
  },
}

// ----------------------------------------------------------------------------
// The scanner
// ----------------------------------------------------------------------------

export function ScannerApp({ tenant, initialEvents }: { tenant: ScanTenant; initialEvents: ScanEvent[] }) {
  const { slug, timezone } = tenant

  const [events, setEvents] = useState<ScanEvent[]>(initialEvents)
  const [eventId, setEventId] = useState("")
  const [gate, setGate] = useState("Main Gate")
  const [forced, setForced] = useState(false)
  const [now, setNow] = useState<number | null>(null)

  const [snap, setSnap] = useState<ScanSnapshot | null>(null)
  const [snapFailed, setSnapFailed] = useState(false)
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const [scannerOpen, setScannerOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [camera, setCamera] = useState<"environment" | "user">("environment")
  const [torch, setTorch] = useState(false)
  const [status, setStatus] = useState<"ready" | "busy" | "offline">("ready")
  const [result, setResult] = useState<ResultView | null>(null)
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null)
  const [manualStrip, setManualStrip] = useState("")
  const [manualSheet, setManualSheet] = useState("")

  // Refs: the camera callback is created once, so it reads the latest values from here.
  const readerRef = useRef<QrReader | null>(null)
  const lockRef = useRef(false) // true while a check-in is running or its result is on screen
  const lastCodeRef = useRef<{ code: string; at: number }>({ code: "", at: 0 })
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapRequest = useRef(0)
  const processRef = useRef<(raw: string) => Promise<void>>(async () => {})
  const sheetInput = useRef<HTMLInputElement>(null)

  const event = events.find((e) => e.id === eventId) ?? null
  const win: EventWindow = event && now !== null ? windowOf(event, now) : "live"
  const canScan = event !== null && (win === "live" || forced)

  // ---- toast ---------------------------------------------------------------
  const showToast = useCallback((message: string, error = false) => {
    setToast({ message, error })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  // ---- clock (event timing is re-checked every 30s) -----------------------------
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // ---- remembered choices (per tenant, per device) -------------------------------
  useEffect(() => {
    const savedGate = store.get(`ndi-scan:${slug}:gate`)
    if (savedGate) setGate(savedGate)
  }, [slug])

  useEffect(() => {
    store.set(`ndi-scan:${slug}:gate`, gate)
  }, [slug, gate])

  // ---- keep a valid event selected --------------------------------------------
  useEffect(() => {
    if (now === null) return
    if (events.some((e) => e.id === eventId)) return
    const saved = store.get(`ndi-scan:${slug}:event`)
    setEventId(saved && events.some((e) => e.id === saved) ? saved : pickDefault(events, now))
    setForced(false)
  }, [events, eventId, now, slug])

  const chooseEvent = (id: string) => {
    setEventId(id)
    setForced(false)
    setSnap(null)
    store.set(`ndi-scan:${slug}:event`, id)
  }

  // ---- live numbers ----------------------------------------------------------------
  const refreshSnapshot = useCallback(async () => {
    if (!eventId) return
    const request = ++snapRequest.current
    try {
      const res = await loadScanSnapshot(slug, eventId)
      if (request !== snapRequest.current) return // a newer request is already in flight
      if (res.ok) {
        setSnap(res.data)
        setSnapFailed(false)
      } else {
        setSnapFailed(true)
      }
    } catch {
      if (request === snapRequest.current) setSnapFailed(true)
    }
  }, [slug, eventId])

  useEffect(() => {
    setSnap(null)
    if (!eventId) return
    void refreshSnapshot()
    const id = setInterval(() => {
      if (!document.hidden) void refreshSnapshot()
    }, SNAPSHOT_EVERY_MS)
    const onVisible = () => {
      if (!document.hidden) void refreshSnapshot()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [eventId, refreshSnapshot])

  // ---- event list (new events appear, closed ones drop off) ------------------------------
  const refreshEvents = useCallback(async () => {
    try {
      const res = await loadScanEvents(slug)
      if (res.ok) setEvents(res.data)
    } catch {
      /* keep what we have */
    }
  }, [slug])

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) void refreshEvents()
    }, EVENTS_EVERY_MS)
    return () => clearInterval(id)
  }, [refreshEvents])

  const refreshAll = async () => {
    setRefreshing(true)
    await Promise.all([refreshEvents(), refreshSnapshot()])
    setRefreshing(false)
  }

  // ---- network status -------------------------------------------------------------------
  useEffect(() => {
    setOnline(navigator.onLine)
    const up = () => {
      setOnline(true)
      void refreshSnapshot()
    }
    const down = () => setOnline(false)
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    return () => {
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
    }
  }, [refreshSnapshot])

  useEffect(() => {
    if (!online) setStatus("offline")
    else setStatus((s) => (s === "offline" ? "ready" : s))
  }, [online])

  // ---- keep the screen awake at the entrance -------------------------------------------------
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    const request = async () => {
      try {
        if (!("wakeLock" in navigator) || document.hidden) return
        const s = await navigator.wakeLock.request("screen")
        if (cancelled) void s.release()
        else sentinel = s
      } catch {
        /* optional */
      }
    }
    void request()
    const onVisible = () => {
      if (!document.hidden) void request()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      void sentinel?.release().catch(() => {})
    }
  }, [])

  // ---- result card ---------------------------------------------------------------------------
  const dismissResult = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current)
    dismissTimer.current = null
    setResult(null)
    setStatus(navigator.onLine ? "ready" : "offline")
    lastCodeRef.current = { ...lastCodeRef.current, at: Date.now() }
    // Short breather so the QR that was just read isn't read again as the card closes.
    setTimeout(() => {
      lockRef.current = false
    }, 400)
  }, [])

  const showResult = useCallback(
    (view: ResultView) => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
      setResult(view)
      dismissTimer.current = setTimeout(dismissResult, view.ms)
    },
    [dismissResult],
  )

  useEffect(
    () => () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    [],
  )

  // ---- the check-in itself --------------------------------------------------------------------
  const processScan = useCallback(
    async (raw: string) => {
      if (!event) {
        showResult({ tone: "error", title: "NO EVENT SELECTED", message: "Choose an event before scanning.", rows: [], ms: REFUSAL_SHOWN_MS })
        return
      }
      setStatus("busy")
      setPending((n) => n + 1)
      try {
        const res = await submitScan(slug, event.id, raw, gate)
        if (res.ok) {
          feedback(res.data.success)
          showResult(describe(res.data, event.name, timezone))
        } else {
          feedback(false)
          showResult({ tone: "error", title: "CHECK-IN FAILED", message: res.error, rows: [], ms: REFUSAL_SHOWN_MS })
        }
      } catch {
        feedback(false)
        showResult(
          navigator.onLine
            ? { tone: "error", title: "CHECK-IN FAILED", message: "Couldn't reach the server. Try that ticket again.", rows: [], ms: REFUSAL_SHOWN_MS }
            : { tone: "error", title: "NETWORK ERROR", message: "You appear to be offline. Check your connection and try again.", rows: [], ms: REFUSAL_SHOWN_MS },
        )
      } finally {
        setPending((n) => Math.max(0, n - 1))
        void refreshSnapshot()
      }
    },
    [event, slug, gate, timezone, showResult, refreshSnapshot],
  )

  useEffect(() => {
    processRef.current = processScan
  })

  /** Typed entries (ticket number, phone or email) go through the same path as a camera read. */
  const submitTyped = (value: string) => {
    const code = value.trim()
    if (!code || lockRef.current || !canScan) return
    lockRef.current = true
    lastCodeRef.current = { code, at: Date.now() }
    void processRef.current(code)
  }

  // ---- camera ------------------------------------------------------------------------------------
  useEffect(() => {
    if (!scannerOpen) return
    let cancelled = false

    const onDecode = (text: string) => {
      if (!text || lockRef.current) return
      const last = lastCodeRef.current
      if (text === last.code && Date.now() - last.at < SAME_CODE_BLOCK_MS) return
      lockRef.current = true
      lastCodeRef.current = { code: text, at: Date.now() }
      void processRef.current(text)
    }

    ;(async () => {
      try {
        await loadQrLibrary()
      } catch (err) {
        if (!cancelled) {
          showToast(err instanceof Error ? err.message : "Couldn't load the camera scanner.", true)
          setScannerOpen(false)
        }
        return
      }
      if (cancelled || !window.Html5Qrcode) return

      const host = document.getElementById("readerContainer")
      if (host) host.innerHTML = ""
      const reader = new window.Html5Qrcode("readerContainer", false)
      readerRef.current = reader
      try {
        await reader.start(
          { facingMode: camera },
          {
            fps: 15,
            qrbox: { width: 280, height: 280 },
            disableFlip: false,
            experimentalFeatures: { useBarCodeDetectorIfSupported: false },
            formatsToSupport: [0], // QR codes only: faster
            rememberLastUsedCamera: true,
            videoConstraints: {
              facingMode: camera,
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 24, max: 30 },
              focusMode: "continuous",
              exposureMode: "continuous",
            },
          },
          onDecode,
        )
      } catch (err) {
        if (!cancelled) {
          const why = err instanceof Error ? err.message : String(err)
          showToast(`Camera error: ${why}`, true)
          setScannerOpen(false)
        }
        return
      }
      if (cancelled) {
        // Closed while the camera was still starting.
        try {
          await reader.stop()
          reader.clear()
        } catch {
          /* already stopped */
        }
      }
    })()

    return () => {
      cancelled = true
      const reader = readerRef.current
      readerRef.current = null
      if (reader) {
        void reader
          .stop()
          .then(() => reader.clear())
          .catch(() => {})
      }
    }
  }, [scannerOpen, camera, showToast])

  const toggleTorch = () => {
    const next = !torch
    setTorch(next)
    readerRef.current
      ?.applyVideoConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints)
      .catch(() => {
        setTorch(false)
        showToast("Flash not supported on this device", true)
      })
  }

  const openScanner = () => {
    if (!canScan) return
    audioContext() // unlock sound on this tap
    void audio?.resume?.()
    setScannerOpen(true)
  }

  const closeScanner = () => {
    setScannerOpen(false)
    setTorch(false)
    setStatus(navigator.onLine ? "ready" : "offline")
  }

  const openSheet = () => {
    if (!canScan) return
    audioContext()
    setSheetOpen(true)
    setTimeout(() => sheetInput.current?.focus(), 100)
  }

  // ---- keyboard (handy on a tablet with a keyboard) ----------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")
      if (result && (e.key === " " || e.key === "Enter")) {
        e.preventDefault()
        dismissResult()
        return
      }
      if (e.key === "Escape") {
        if (result) dismissResult()
        else if (sheetOpen) setSheetOpen(false)
        else if (scannerOpen) closeScanner()
        return
      }
      if (typing || scannerOpen || sheetOpen || result) return
      if (e.key === "s") {
        e.preventDefault()
        openScanner()
      } else if (e.key === "m") {
        e.preventDefault()
        openSheet()
      } else if (e.key === "r") {
        e.preventDefault()
        void refreshAll()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  })

  // ---- numbers for the tiles ----------------------------------------------------------------
  const sold = snap?.sold ?? 0
  const admitted = snap?.admitted ?? 0
  const percent = sold > 0 ? Math.min(100, Math.round((admitted / sold) * 100)) : 0

  const sync: SyncState = !online ? "offline" : snapFailed ? "reconnecting" : "live"
  const tone = result ? TONE_STYLE[result.tone] : null
  const options = useMemo(() => events.map((e) => ({ id: e.id, label: `${e.name} · ${eventStamp(e.startTime, timezone)}` })), [events, timezone])

  const notLiveMessage =
    win === "upcoming"
      ? "Gate isn't open yet. Check-in opens 3 hours before the event starts."
      : "This event has finished."

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="ndi-scan" style={tenant.brandVars as CSSProperties}>
      <ScanHeader name={tenant.name} logoUrl={tenant.logoUrl} sync={sync} />

      <div className={`offline-banner${online ? "" : " show"}`} role="status">
        <Icon name="wifi" /> No network. Check-ins need a connection.
      </div>

      {event && !canScan && now !== null && (
        <div className="no-event-banner show" role="status">
          <Icon name="calendar-xmark" />
          <span>{notLiveMessage}</span>
          <button type="button" onClick={() => setForced(true)}>
            Scan anyway
          </button>
        </div>
      )}

      <div className="main-container">
        {events.length === 0 ? (
          <div className="unavailable">
            <div className="unavailable-card">
              <Icon name="calendar-xmark" />
              <h2>No event is open for check-in</h2>
              <p>An event shows up here once it is on sale (status Active). Create or open one in your admin, then refresh.</p>
              <button type="button" className="sheet-submit" style={{ marginTop: 18 }} onClick={() => void refreshAll()}>
                Refresh
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* EVENT & GATE */}
            <div className="command-strip">
              <div className="command-group grow">
                <label className="cmd-label" htmlFor="ndi-event">
                  <Icon name="calendar-days" /> Event
                </label>
                <select id="ndi-event" className="cmd-select" value={eventId} onChange={(e) => chooseEvent(e.target.value)}>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {event && now !== null && win === "live" && (
                  <div className="event-active-badge">
                    <span className="event-active-dot" />
                    ACTIVE NOW
                  </div>
                )}
                {event && now !== null && win !== "live" && (
                  <div className="event-soon-badge">{win === "upcoming" ? "NOT OPEN YET" : "FINISHED"}</div>
                )}
              </div>
              <div className="command-group gate">
                <label className="cmd-label" htmlFor="ndi-gate">
                  <Icon name="door-open" /> Gate
                </label>
                <input
                  id="ndi-gate"
                  type="text"
                  className="cmd-input"
                  placeholder="Main Gate"
                  value={gate}
                  maxLength={40}
                  onChange={(e) => setGate(e.target.value)}
                />
              </div>
              <div className="command-group">
                <span className="cmd-label">&nbsp;</span>
                <button type="button" className="cmd-btn" title="Refresh" aria-label="Refresh" onClick={() => void refreshAll()}>
                  <Icon name="rotate" style={refreshing ? { animation: "ndi-spin 0.6s linear infinite" } : undefined} />
                </button>
              </div>
            </div>

            {/* STATS */}
            <div className="stats-row">
              <div className="stat-tile t-green">
                <div className="stat-icon"><Icon name="user-check" /></div>
                <StatNumber value={admitted} />
                <div className="stat-lbl">Checked In</div>
              </div>
              <div className="stat-tile t-blue">
                <div className="stat-icon"><Icon name="ticket" /></div>
                <StatNumber value={Math.max(0, sold - admitted)} />
                <div className="stat-lbl">Remaining</div>
              </div>
              <div className="stat-tile t-red">
                <div className="stat-icon"><Icon name="circle-xmark" /></div>
                <StatNumber value={snap?.refused ?? 0} />
                <div className="stat-lbl">Refused</div>
              </div>
              <div className="stat-tile t-amber">
                <div className="stat-icon"><Icon name="hourglass-half" /></div>
                <StatNumber value={pending} />
                <div className="stat-lbl">Pending</div>
              </div>
            </div>

            {/* ATTENDANCE */}
            <div className="progress-section">
              <div className="progress-head">
                <span>Attendance · {admitted} of {sold} sold</span>
                <strong>{percent}%</strong>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Attendance"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>

            {/* SCAN + MANUAL */}
            <div className="scan-hero">
              <button type="button" className="scan-main-btn" disabled={!canScan} onClick={openScanner} aria-label="Open QR scanner">
                <div className="btn-icon"><Icon name="qrcode" /></div>
                <div className="btn-text">
                  <span className="btn-label">SCAN TICKET</span>
                  <span className="btn-sub">Tap to open camera</span>
                </div>
              </button>
              <button type="button" className="manual-hero-btn" disabled={!canScan} onClick={openSheet} aria-label="Enter code manually">
                <Icon name="keyboard" />
                <span>Manual</span>
              </button>
            </div>

            {/* LIVE FEED */}
            <div className="feed-section">
              <div className="feed-head">
                <div className="feed-head-left">
                  <h3>
                    <Icon name="clock" style={{ color: "var(--accent-text)", marginRight: 6 }} />
                    Live Activity
                  </h3>
                </div>
                <div className="live-pill"><span className="live-dot" />Live</div>
              </div>
              <div className="scans-list" aria-live="polite">
                {!snap || snap.recent.length === 0 ? (
                  <div className="empty-feed">
                    <Icon name="camera" />
                    <p>{snap ? "No scans yet" : "Loading…"}</p>
                    {snap && <span>Scan a ticket to begin check-in</span>}
                  </div>
                ) : (
                  snap.recent.map((s) => {
                    const refused = s.result !== "valid"
                    const warn = s.result === "duplicate"
                    return (
                      <div className="scan-item" key={s.id}>
                        <div className={`scan-dot${refused ? (warn ? " warn" : " rejected") : ""}`} />
                        <div className="scan-body">
                          <div className="scan-id">{s.ticketNumber ?? "Unknown code"}</div>
                          <div className="scan-type">
                            {s.ticketType ?? "–"}
                            {refused && <span className={`scan-chip${warn ? " warn" : ""}`}>{TITLES[s.result].toLowerCase()}</span>}
                          </div>
                        </div>
                        <div className="scan-meta">
                          <div className="scan-time-val">{clockTime(s.scannedAt, timezone)}</div>
                          <div className="scan-gate">{s.gate ?? "–"}</div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </>
        )}

        <div className="powered">
          <Icon name="shield-halved" />
          <span>
            Secure live validation
            {tenant.showPoweredBy && (
              <>
                {" · Powered by "}
                <strong>Ndithini</strong>
              </>
            )}
          </span>
        </div>
      </div>

      {/* CAMERA */}
      <div className={`scanner-modal${scannerOpen ? " active" : ""}`} role="dialog" aria-label="QR scanner" aria-hidden={!scannerOpen}>
        <div className="scanner-topbar">
          <div className="scanner-topbar-left">
            <h3>
              <Icon name="qrcode" style={{ marginRight: 8, color: "rgba(255,255,255,0.7)" }} />
              Scan Ticket
            </h3>
            <div className={`scanner-status-badge ${status}`}>
              <span className="scanner-status-dot" />
              <span>{status === "ready" ? "Ready" : status === "busy" ? "Processing…" : "Offline"}</span>
            </div>
          </div>
          <button type="button" className="scanner-close-btn" onClick={closeScanner} aria-label="Close scanner">
            <Icon name="xmark" />
          </button>
        </div>

        <div className="scanner-viewport">
          <div id="readerContainer" />
          <div className="scan-vignette" />
          <div className={`scan-guide${status === "busy" ? " processing" : ""}`}>
            <div className="corner corner-tl" />
            <div className="corner corner-tr" />
            <div className="corner corner-bl" />
            <div className="corner corner-br" />
            <div className="scan-laser" />
          </div>
          <div className={`processing-overlay${status === "busy" ? " active" : ""}`}>
            <div className="proc-spinner" />
            <div className="proc-label">Validating…</div>
          </div>
        </div>

        <div className="scan-hint">
          <Icon name="expand" style={{ marginRight: 5 }} />
          Align QR code within the frame
        </div>

        <div className="cam-controls">
          <button type="button" className={`cam-btn${torch ? " torch-on" : ""}`} onClick={toggleTorch} title="Toggle flash" aria-label="Toggle flash">
            <Icon name="lightbulb" />
          </button>
          <button
            type="button"
            className="cam-btn"
            onClick={() => {
              setTorch(false) // the flash belongs to the back camera
              setCamera((c) => (c === "environment" ? "user" : "environment"))
            }}
            title="Flip camera"
            aria-label="Flip camera"
          >
            <Icon name="camera-rotate" />
          </button>
        </div>

        <form
          className="manual-strip"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            submitTyped(manualStrip)
            setManualStrip("")
          }}
        >
          <input
            type="text"
            className="manual-field"
            placeholder="Ticket number, phone, or email…"
            aria-label="Ticket number, phone, or email"
            value={manualStrip}
            onChange={(e) => setManualStrip(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button type="submit" className="manual-go">VERIFY</button>
        </form>
      </div>

      {/* MANUAL SHEET */}
      <div
        className={`sheet-overlay${sheetOpen ? " active" : ""}`}
        role="dialog"
        aria-label="Manual ticket entry"
        aria-hidden={!sheetOpen}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSheetOpen(false)
        }}
      >
        <form
          className="sheet"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            const value = manualSheet
            setSheetOpen(false)
            setManualSheet("")
            submitTyped(value)
          }}
        >
          <div className="sheet-handle" />
          <h3>Manual Check-In</h3>
          <input
            ref={sheetInput}
            type="text"
            className="sheet-input"
            placeholder="Ticket number, phone, or email…"
            aria-label="Ticket number, phone, or email"
            value={manualSheet}
            onChange={(e) => setManualSheet(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button type="submit" className="sheet-submit">VERIFY TICKET</button>
          <span
            className="sheet-cancel"
            role="button"
            tabIndex={0}
            onClick={() => {
              setSheetOpen(false)
              setManualSheet("")
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                setSheetOpen(false)
                setManualSheet("")
              }
            }}
          >
            Cancel
          </span>
        </form>
      </div>

      {/* RESULT */}
      <div className={`result-overlay${result ? " active" : ""}`} role="dialog" aria-live="assertive" aria-label="Check-in result">
        {result && tone && (
          <div className="result-card" key={`${result.title}-${result.message}-${result.rows.length}`}>
            <div className="result-band" style={{ ["--band-color" as string]: tone.band }} />
            <div className="result-body">
              <div
                className={`result-icon-wrap${result.tone === "success" ? " success-ring" : ""}`}
                style={{ ["--icon-bg" as string]: tone.bg, ["--icon-color" as string]: tone.fg }}
              >
                <Icon name={tone.icon} />
              </div>
              <div className="result-verdict">{result.title}</div>
              <div className="result-sub">{result.message}</div>
              {result.rows.length > 0 && (
                <div className="result-info">
                  {result.rows.map(([label, value]) => (
                    <div className="result-row" key={label}>
                      <span className="result-row-label">{label}</span>
                      <span className="result-row-val">{value}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="result-timer">
                <div
                  className="result-timer-fill"
                  style={{ ["--timer-color" as string]: tone.fg, ["--timer-duration" as string]: `${result.ms}ms` }}
                />
              </div>
              <button
                type="button"
                className="result-dismiss"
                style={{ ["--dismiss-bg" as string]: tone.bg, ["--dismiss-color" as string]: tone.fg }}
                onClick={dismissResult}
                autoFocus
              >
                Scan Next Ticket
              </button>
            </div>
          </div>
        )}
      </div>

      {/* TOAST */}
      <div className={`toast${toast ? " show" : ""}${toast?.error ? " err" : ""}`} role="status">
        {toast?.message}
      </div>
    </div>
  )
}
