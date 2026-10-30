// app/admin/shisha/ShishaCounter.tsx
//
// Staff counter screen (ported from the old Rands shisha-pos.html): pick a
// flavour, pick or SCAN a device, take payment, start, print a receipt. Live
// sessions sit beside it with one-tap Refill / Pause / End.
//
// It owns no data and calls no server action itself: ShishaManager passes the
// snapshot and the (permission-checked) handlers, so every rule stays in
// ./actions.ts. Needs shisha.operate (the Counter tab is hidden without it).
"use client"

import { BRAND_BG, BRAND_BORDER, BRAND_FOCUS_BORDER, BRAND_ON } from "@/components/admin/brand"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHODS,
  deriveDisplayStatus,
  paymentMethodLabel,
  liveRemainingSeconds,
  signedRemainingSeconds,
  type ShishaDisplayStatus,
  type ShishaSession,
  type ShishaSnapshot,
} from "./shisha-types"

export interface CounterStartInput {
  deviceId: string
  productId: string
  /** "" = no station (only possible when the shop doesn't require one) */
  locationId: string
  customerPhone: string
  paymentMethod: string
}

// --------------------------------------------------------------------------
// Small shared bits (same look as ShishaManager)
// --------------------------------------------------------------------------
const FIELD =
  `w-full rounded-md border border-[#D9D3C3] bg-white px-3 py-2 text-sm text-[#1C1A17] outline-none ${BRAND_FOCUS_BORDER}`
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-2 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY =
  `rounded-md ${BRAND_BG} ${BRAND_ON} px-4 py-3 text-base font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`
const BTN_DANGER =
  "rounded-md bg-[#7A2E2E] px-3 py-2 text-sm font-medium text-white hover:bg-[#651F1F] disabled:cursor-not-allowed disabled:opacity-50"
const CARD = "rounded-lg border border-[#E6E1D4] bg-white"
const TILE_BASE =
  "min-h-[56px] rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
const TILE_OFF = "border-[#D9D3C3] bg-white text-[#1C1A17] hover:bg-[#F3EEE2]"
const TILE_ON = `${BRAND_BORDER} ${BRAND_BG} ${BRAND_ON}`

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

const paymentLabel = paymentMethodLabel

/** Where a session is sitting, shown bold next to the device code. A session
 *  with no station (older ones, or shops that don't require it) shows a muted
 *  "No station" so the gap is visible rather than silently blank. */
export function StationTag({ name, className = "" }: { name: string | null; className?: string }) {
  return name ? (
    <span className={`font-semibold text-[#1C1A17] ${className}`}> · {name}</span>
  ) : (
    <span className={`font-normal text-[#8A8375] ${className}`}> · No station</span>
  )
}

// --------------------------------------------------------------------------
// Receipts (80mm thermal, printed through the browser like the old POS)
// --------------------------------------------------------------------------
interface ReceiptData {
  shopName: string
  deviceCode: string
  station: string | null
  flavour: string
  durationMinutes: number
  payment: string | null
  /** Grand total (session + refills). */
  amount: number
  currency: string
  at: Date
  timezone: string
  /** Refills charged on this session so far; shown as their own line when present. */
  refills?: { count: number; amount: number }
}

/** Flavour / shop / station names are typed by staff: never trust them in HTML. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

/** en-ZA formatting uses non-breaking spaces, which thermal printers print as junk. */
const plain = (v: string) => v.replace(/[\u00a0\u202f]/g, " ")

function receiptWhen(r: ReceiptData): string {
  return plain(
    r.at.toLocaleString("en-ZA", {
      timeZone: r.timezone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  )
}

function buildReceiptHtml(r: ReceiptData): string {
  const when = receiptWhen(r)
  const row = (label: string, value: string) => `<div class="row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  body { margin: 0; width: 72mm; padding: 4mm; font: 12px/1.4 "Courier New", monospace; color: #000; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 2px; text-transform: uppercase; }
  .center { text-align: center; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .total { font-weight: bold; font-size: 14px; }
  .foot { text-align: center; margin-top: 6px; }
</style></head><body>
  <h1>${esc(r.shopName || "Shisha")}</h1>
  ${r.shopName ? '<div class="center">Shisha</div>' : ""}
  <hr>
  ${row("Device", r.deviceCode)}
  ${r.station ? row("Station", r.station) : ""}
  ${row("Flavour", r.flavour)}
  ${row("Duration", `${r.durationMinutes} min`)}
  ${r.refills && r.refills.count > 0 ? row("Session", formatMoney(r.amount - r.refills.amount, r.currency)) : ""}
  ${r.refills && r.refills.count > 0 ? row(`Refills (${r.refills.count})`, formatMoney(r.refills.amount, r.currency)) : ""}
  ${r.payment ? row("Payment", r.payment) : ""}
  <hr>
  <div class="row total"><span>TOTAL</span><span>${esc(formatMoney(r.amount, r.currency))}</span></div>
  <hr>
  <div class="center">${esc(when)}</div>
  <div class="foot">Enjoy your session.<br>Ask staff for a refill anytime.</div>
</body></html>`
}

/** FALLBACK ONLY (PCs with no print agent): prints through a hidden iframe so
 *  no page styles leak into the receipt. This always shows the browser's print
 *  dialog. Returns false if the browser blocked it. */
function printHtml(html: string): boolean {
  const iframe = document.createElement("iframe")
  iframe.setAttribute("aria-hidden", "true")
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" })
  document.body.appendChild(iframe)
  const win = iframe.contentWindow
  const doc = iframe.contentDocument
  if (!win || !doc) {
    iframe.remove()
    return false
  }
  doc.open()
  doc.write(html)
  doc.close()
  const cleanup = () => {
    if (iframe.isConnected) iframe.remove()
  }
  win.onafterprint = () => setTimeout(cleanup, 500)
  setTimeout(() => {
    try {
      win.focus()
      win.print()
    } catch {
      cleanup()
    }
    setTimeout(cleanup, 60_000) // fallback for browsers that never fire afterprint
  }, 150)
  return true
}

// Silent printing: the same local print agent the kiosk uses (runs on the PC
// the receipt printer is plugged into, listens on 127.0.0.1:4000). Only works
// when this page is opened in a browser ON that PC and from the origin the
// agent allows (CORS).
const PRINT_AGENT_URL = "http://127.0.0.1:4000"
const AGENT_TIMEOUT_MS = 25_000 // the very first print after an agent restart can be slow

type AgentResult = "printed" | "unreachable" | "timeout" | "failed"

function newJobId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function printViaAgent(r: ReceiptData): Promise<AgentResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS)
  try {
    const res = await fetch(`${PRINT_AGENT_URL}/print-shisha`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        shopName: r.shopName,
        receipt: {
          // Fresh id per print: a retry of the SAME job is never printed twice by
          // the agent, while "Reprint last receipt" (new id) prints again.
          jobId: newJobId(),
          deviceCode: r.deviceCode,
          station: r.station,
          flavour: r.flavour,
          durationText: `${r.durationMinutes} min`,
          payment: r.payment,
          amountText: plain(formatMoney(r.amount, r.currency)),
          // Only sent when the session has refills. A print agent that predates these
          // fields just ignores them and prints the grand total as before.
          sessionText: r.refills && r.refills.count > 0 ? plain(formatMoney(r.amount - r.refills.amount, r.currency)) : undefined,
          refillsText:
            r.refills && r.refills.count > 0
              ? `${r.refills.count} x refill ${plain(formatMoney(r.refills.amount, r.currency))}`
              : undefined,
          dateText: receiptWhen(r),
        },
      }),
    })
    return res.ok ? "printed" : "failed"
  } catch (e) {
    // Aborted = the agent may still be printing: don't fall back to a second print.
    if (e instanceof DOMException && e.name === "AbortError") return "timeout"
    return "unreachable" // refused / blocked: no agent on this PC
  } finally {
    clearTimeout(timer)
  }
}

// --------------------------------------------------------------------------
// QR scanning of device stickers
// --------------------------------------------------------------------------
type JsQrFn = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null
type Detect = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>

// Pinned version + integrity hash: the browser refuses the file if it differs.
const JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"
const JSQR_SRI = "sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx"

function loadJsQr(): Promise<JsQrFn> {
  const w = window as unknown as { jsQR?: JsQrFn }
  if (typeof w.jsQR === "function") return Promise.resolve(w.jsQR)
  return new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = JSQR_URL
    s.integrity = JSQR_SRI
    s.crossOrigin = "anonymous"
    s.async = true
    s.onload = () =>
      typeof w.jsQR === "function" ? resolve(w.jsQR) : reject(new Error("The QR scanner didn't start."))
    s.onerror = () => reject(new Error("Couldn't load the QR scanner. Pick the device from the list instead."))
    document.head.appendChild(s)
  })
}

/** Native BarcodeDetector where the browser has it (Chrome / Android), jsQR otherwise (Safari / iOS). */
async function makeDetector(): Promise<Detect> {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector
  if (BD) {
    try {
      const detector = new BD({ formats: ["qr_code"] })
      return async (video) => (await detector.detect(video))[0]?.rawValue ?? null
    } catch {
      /* fall through to jsQR */
    }
  }
  const jsQR = await loadJsQr()
  return async (video, canvas) => {
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    return jsQR(img.data, w, h)?.data ?? null
  }
}

/** Accepts whatever the stickers were printed with: a plain code ("SH-003"),
 *  a small JSON payload, or a URL carrying the code in its query string. */
function extractDeviceCode(raw: string): string {
  try {
    const obj = JSON.parse(raw)
    if (obj && (obj.device_code || obj.deviceCode)) return String(obj.device_code || obj.deviceCode)
  } catch {
    /* not JSON */
  }
  try {
    const url = new URL(raw)
    const fromQuery = url.searchParams.get("device_code") || url.searchParams.get("device") || url.searchParams.get("code")
    if (fromQuery) return fromQuery
  } catch {
    /* not a URL */
  }
  return raw
}

function QrScanner({ onResult, onClose }: { onResult: (raw: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const stopAll = () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
    }

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser can't use the camera here (it needs a secure https page).")
        }
        const detect = await makeDetector()
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        if (cancelled) {
          media.getTracks().forEach((t) => t.stop())
          return
        }
        stream = media
        const video = videoRef.current
        if (!video) return
        video.srcObject = media
        await video.play()
        const canvas = document.createElement("canvas")

        const tick = async () => {
          if (cancelled) return
          if (video.readyState >= 2) {
            try {
              const raw = await detect(video, canvas)
              if (raw && !cancelled) {
                stopAll()
                onResultRef.current(raw.trim())
                return
              }
            } catch {
              /* a bad frame: just try the next one */
            }
          }
          timer = setTimeout(() => void tick(), 150)
        }
        void tick()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Camera access failed.")
      }
    }

    void start()
    return stopAll
  }, [])

  return (
    <div role="dialog" aria-modal="true" aria-label="Scan device QR code" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/85 p-4">
      <p className="text-sm text-white">Point the camera at the QR code on the device.</p>
      <video ref={videoRef} playsInline muted className="max-h-[60vh] w-full max-w-md rounded-lg bg-black object-cover" />
      {error && <p className="max-w-md rounded-md bg-[#7A2E2E] px-3 py-2 text-center text-sm text-white">{error}</p>}
      <button type="button" onClick={onClose} className={BTN}>
        Cancel
      </button>
    </div>
  )
}

// --------------------------------------------------------------------------
// The counter
// --------------------------------------------------------------------------
const AUTOPRINT_KEY = "shishaCounterAutoPrint"

export function ShishaCounter({
  snap,
  timezone,
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
  busy: boolean
  occupiedDeviceIds: Set<string>
  onStart: (input: CounterStartInput) => Promise<boolean>
  onPause: (s: ShishaSession) => void
  onResume: (s: ShishaSession) => void
  onRefill: (s: ShishaSession) => void
  onEnd: (s: ShishaSession, method: string | null) => Promise<boolean>
}) {
  const now = useNow(1000)

  const [productId, setProductId] = useState("")
  const [deviceId, setDeviceId] = useState("")
  const [stationId, setStationId] = useState("")
  const [phone, setPhone] = useState("")
  const [payment, setPayment] = useState<string>(PAYMENT_METHODS[0].value)
  const [scanOpen, setScanOpen] = useState(false)
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const [autoPrint, setAutoPrint] = useState(true)
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null)
  const [printing, setPrinting] = useState(false)
  const printingRef = useRef(false)

  const [endingId, setEndingId] = useState<string | null>(null)
  const [endMethod, setEndMethod] = useState<string>(DEFAULT_PAYMENT_METHOD)
  const [refillConfirmId, setRefillConfirmId] = useState<string | null>(null)

  // Auto-print preference lives in this browser (one counter terminal, one setting).
  useEffect(() => {
    try {
      if (localStorage.getItem(AUTOPRINT_KEY) === "false") setAutoPrint(false)
    } catch {
      /* storage blocked: keep the default */
    }
  }, [])
  function changeAutoPrint(value: boolean) {
    setAutoPrint(value)
    try {
      localStorage.setItem(AUTOPRINT_KEY, String(value))
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (flash?.kind !== "ok") return
    const t = setTimeout(() => setFlash(null), 3500)
    return () => clearTimeout(t)
  }, [flash])

  const flavours = useMemo(() => snap.flavours.filter((f) => f.isAvailable), [snap.flavours])
  const freeDevices = useMemo(
    () => snap.devices.filter((d) => d.status !== "maintenance" && !occupiedDeviceIds.has(d.id)),
    [snap.devices, occupiedDeviceIds],
  )
  const stationName = useCallback(
    (id: string | null) => snap.stations.find((st) => st.id === id)?.name ?? null,
    [snap.stations],
  )

  // A selection that became invalid after a refresh (device taken, flavour sold out) just drops out.
  const flavour = flavours.find((f) => f.id === productId) ?? null
  const device = freeDevices.find((d) => d.id === deviceId) ?? null

  // Station = where the customer sits, picked per session. A device's own
  // station only pre-selects when staff haven't picked one.
  const activeStations = useMemo(() => snap.stations.filter((st) => st.isActive), [snap.stations])
  const pickedStation = activeStations.find((st) => st.id === stationId) ?? null
  // The device's usual station (only if staff can actually pick it: active).
  const deviceStation = activeStations.find((st) => st.id === device?.locationId) ?? null
  const effectiveStation = pickedStation ?? deviceStation
  // Required only when the shop can offer a station (same rule as the server).
  const stationRequired = snap.settings.requireStation && activeStations.length > 0
  const stationMissing = stationRequired && !effectiveStation

  const rows = snap.sessions
    .map((s) => {
      const remaining = liveRemainingSeconds(s, now)
      const signed = signedRemainingSeconds(s, now)
      return {
        s,
        remaining,
        signed,
        status: deriveDisplayStatus(remaining, s.paused, snap.settings.refillThresholdMinutes),
      }
    })
    // Signed value: sessions that ran out sort by how long ago, most overdue first.
    .sort((a, b) => a.signed - b.signed)

  // Expired or refill-soon (paused ones are deliberately excluded), most overdue first.
  const attention = rows.filter((r) => r.status === "expired" || r.status === "refill")

  function receiptFor(d: { deviceCode: string }, f: { name: string; price: number }): ReceiptData {
    return {
      shopName: snap.shopName,
      deviceCode: d.deviceCode,
      station: effectiveStation?.name ?? null,
      flavour: f.name,
      durationMinutes: snap.settings.coalDurationMinutes,
      payment: paymentLabel(payment),
      amount: f.price,
      currency: snap.currency,
      at: new Date(),
      timezone,
    }
  }

  /** Receipt for a session that is already running, with its refills itemised. */
  function receiptForSession(s: ShishaSession): ReceiptData {
    return {
      shopName: snap.shopName,
      deviceCode: s.deviceCode,
      station: s.stationName,
      flavour: s.flavourName,
      durationMinutes: snap.settings.coalDurationMinutes,
      payment: paymentLabel(s.paymentMethod),
      amount: s.totalAmount,
      currency: snap.currency,
      at: new Date(),
      timezone,
      refills: s.refillCount > 0 ? { count: s.refillCount, amount: s.refillTotal } : undefined,
    }
  }

  /** Silent print through the local print agent. Only if no agent exists on this
   *  PC (connection refused) does it fall back to the browser's print window. */
  async function printReceipt(receipt: ReceiptData) {
    if (printingRef.current) return
    printingRef.current = true
    setPrinting(true)
    try {
      const result = await printViaAgent(receipt)
      if (result === "printed") {
        setFlash({ kind: "ok", text: "Receipt printed." })
      } else if (result === "unreachable") {
        if (printHtml(buildReceiptHtml(receipt))) {
          setFlash({ kind: "ok", text: "No receipt printer is connected to this PC, so the print window opened instead." })
        } else {
          setFlash({ kind: "error", text: "Couldn't print the receipt. Use Reprint last receipt." })
        }
      } else if (result === "timeout") {
        setFlash({ kind: "error", text: "The receipt printer didn't answer in time. Check whether a slip came out before reprinting." })
      } else {
        setFlash({ kind: "error", text: "The receipt printer reported a problem. Check the paper and cover, then use Reprint last receipt." })
      }
    } finally {
      printingRef.current = false
      setPrinting(false)
    }
  }

  async function submit() {
    if (!flavour || !device || busy || stationMissing) return
    const receipt = receiptFor(device, flavour)
    const ok = await onStart({
      deviceId: device.id,
      productId: flavour.id,
      locationId: effectiveStation?.id ?? "",
      customerPhone: phone,
      paymentMethod: payment,
    })
    if (!ok) return // ShishaManager already shows why (e.g. device just taken)
    setLastReceipt(receipt)
    if (autoPrint) void printReceipt(receipt)
    setDeviceId("")
    setStationId("")
    setPhone("")
  }

  function handleScan(raw: string) {
    setScanOpen(false)
    const code = extractDeviceCode(raw).trim().toUpperCase()
    const match = snap.devices.find((d) => d.deviceCode.toUpperCase() === code)
    if (!match) return setFlash({ kind: "error", text: `No device found for "${code}".` })
    if (match.status === "maintenance") return setFlash({ kind: "error", text: `${match.deviceCode} is under maintenance.` })
    if (occupiedDeviceIds.has(match.id)) return setFlash({ kind: "error", text: `${match.deviceCode} already has a live session.` })
    setDeviceId(match.id)
    setFlash({ kind: "ok", text: `Selected ${match.deviceCode}.` })
  }

  async function confirmEnd(s: ShishaSession) {
    // If the customer already paid at the counter, ending must not ask again.
    const ok = await onEnd(s, s.paymentMethod ? null : endMethod)
    if (ok) {
      setEndingId(null)
      setEndMethod(DEFAULT_PAYMENT_METHOD)
    }
  }

  const noSetup = flavours.length === 0 || (snap.devices.length === 0)

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {scanOpen && <QrScanner onResult={handleScan} onClose={() => setScanOpen(false)} />}

      {/* ---------------- Needs attention ---------------- */}
      {attention.length > 0 && (
        <section
          className="space-y-2 rounded-lg border border-[#7A2E2E]/30 bg-[#7A2E2E]/[0.06] p-3 lg:col-span-2"
          aria-label="Needs attention"
        >
          <h3 className="text-sm font-semibold text-[#7A2E2E]">
            Needs attention <span className="font-normal">({attention.length})</span>
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {attention.map(({ s, remaining, signed, status }) => (
              <li
                key={s.id}
                className={`flex items-center justify-between gap-3 rounded-md border bg-white px-3 py-2 ${
                  status === "expired" ? "border-[#7A2E2E]/40" : "border-[#9A6A12]/40"
                }`}
              >
                <p className="min-w-0 truncate text-sm">
                  <span className="font-semibold text-[#1C1A17]">{s.deviceCode}</span>
                  <StationTag name={s.stationName} />
                </p>
                <p
                  className={`shrink-0 text-sm font-semibold tabular-nums ${
                    status === "expired" ? "text-[#7A2E2E]" : "text-[#9A6A12]"
                  }`}
                >
                  {status === "expired" ? `${formatCountdown(-signed)} over` : `${formatCountdown(remaining)} left`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------- New session ---------------- */}
      <section className={`${CARD} space-y-5 p-4`} aria-label="New session">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">New session</h3>
          <button type="button" onClick={() => setScanOpen(true)} disabled={busy || snap.devices.length === 0} className={BTN}>
            Scan QR
          </button>
        </div>

        {flash && (
          <p
            role={flash.kind === "error" ? "alert" : "status"}
            className={`rounded-md px-3 py-2 text-sm ${flash.kind === "error" ? "bg-[#7A2E2E]/10 text-[#7A2E2E]" : "bg-[#4B6B54]/10 text-[#4B6B54]"}`}
          >
            {flash.text}
          </p>
        )}

        {noSetup ? (
          <p className="text-sm text-[#8A8375]">
            {flavours.length === 0
              ? "No flavours are in stock yet. A manager needs to add one first."
              : "No devices have been added yet. A manager needs to add one first."}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm text-[#8A8375]">Flavour</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {flavours.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={flavour?.id === f.id}
                    onClick={() => setProductId(f.id)}
                    className={`${TILE_BASE} ${flavour?.id === f.id ? TILE_ON : TILE_OFF}`}
                  >
                    <span className="block font-medium">{f.name}</span>
                    <span className="block text-xs opacity-80">{formatMoney(f.price, snap.currency)}</span>
                  </button>
                ))}
              </div>
            </div>

            {activeStations.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-[#8A8375]">
                  Station
                  {stationRequired && (
                    <>
                      {" "}
                      <span className="font-medium text-[#7A2E2E]" aria-hidden>
                        * required
                      </span>
                      <span className="sr-only">(required)</span>
                    </>
                  )}
                </p>
                <div
                  role="group"
                  aria-label={stationRequired ? "Station (required)" : "Station"}
                  className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                >
                  {activeStations.map((st) => {
                    const selected = effectiveStation?.id === st.id
                    const isUsual = deviceStation?.id === st.id
                    return (
                      <button
                        key={st.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setStationId(stationId === st.id ? "" : st.id)}
                        className={`${TILE_BASE} ${selected ? TILE_ON : TILE_OFF}`}
                      >
                        <span className="block truncate font-medium">{st.name}</span>
                        {isUsual && <span className="block truncate text-xs opacity-80">(device&apos;s usual station)</span>}
                      </button>
                    )
                  })}
                </div>
                {stationMissing && flavour && device && (
                  <p className="text-xs text-[#7A2E2E]">Pick where this customer is sitting to start the session.</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm text-[#8A8375]">Device</p>
              {freeDevices.length === 0 ? (
                <p className="text-sm text-[#7A2E2E]">Every device is in use or under maintenance.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {freeDevices.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      aria-pressed={device?.id === d.id}
                      onClick={() => setDeviceId(d.id)}
                      className={`${TILE_BASE} ${device?.id === d.id ? TILE_ON : TILE_OFF}`}
                    >
                      <span className="block font-medium">{d.deviceCode}</span>
                      <span className="block truncate text-xs opacity-80">{d.deviceName || "\u00a0"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm text-[#8A8375]">Paid by</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    aria-pressed={payment === m.value}
                    onClick={() => setPayment(m.value)}
                    className={`${TILE_BASE} text-center ${payment === m.value ? TILE_ON : TILE_OFF}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

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

            <button type="button" onClick={() => void submit()} disabled={busy || !flavour || !device || stationMissing} className={`${BTN_PRIMARY} w-full`}>
              {busy
                ? "Working…"
                : flavour && device && stationMissing
                  ? "Pick a station to start"
                  : flavour && device
                  ? `Start ${device.deviceCode}${effectiveStation ? ` · ${effectiveStation.name}` : ""} · ${formatMoney(flavour.price, snap.currency)}`
                  : "Pick a flavour and a device"}
            </button>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E6E1D4] pt-3 text-sm">
              <label className="flex items-center gap-2 text-[#1C1A17]">
                <input type="checkbox" checked={autoPrint} onChange={(e) => changeAutoPrint(e.target.checked)} />
                Print receipt when a session starts
              </label>
              <button
                type="button"
                onClick={() => lastReceipt && void printReceipt(lastReceipt)}
                disabled={!lastReceipt || printing}
                className={BTN}
              >
                {printing ? "Printing…" : "Reprint last receipt"}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ---------------- Live sessions ---------------- */}
      <section className="space-y-3" aria-label="Live sessions">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
          Live now <span className="text-sm text-[#8A8375]">({rows.length})</span>
        </h3>

        {rows.length === 0 && (
          <div className={`${CARD} px-4 py-8 text-center text-sm text-[#8A8375]`}>No live sessions. Start one on the left.</div>
        )}

        {rows.map(({ s, remaining, status }) => (
          <article key={s.id} className={`${CARD} p-4`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-[#1C1A17]">
                  {s.deviceCode}
                  <StationTag name={s.stationName} />
                </p>
                <p className="truncate text-sm text-[#8A8375]">
                  {s.flavourName} · {formatMoney(s.totalAmount, snap.currency)}
                  {s.refillCount > 0
                    ? ` · ${s.refillCount} refill${s.refillCount === 1 ? "" : "s"}${
                        s.refillTotal > 0 ? ` (${formatMoney(s.refillTotal, snap.currency)})` : ""
                      }`
                    : ""}
                </p>
                <p className="truncate text-xs text-[#8A8375]">
                  {s.customerName || s.customerPhone || "Walk-in"}
                  {s.paymentMethod ? ` · ${paymentLabel(s.paymentMethod)}` : " · payment not recorded"}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-2xl font-semibold tabular-nums text-[#1C1A17]">{formatCountdown(remaining)}</p>
                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  // A refill that costs money asks first; a free one goes straight through.
                  if (s.refillPrice > 0) setRefillConfirmId(refillConfirmId === s.id ? null : s.id)
                  else onRefill(s)
                }}
                disabled={busy || s.paused}
                className={BTN}
              >
                Refill{s.refillPrice > 0 ? ` · ${formatMoney(s.refillPrice, snap.currency)}` : ""}
              </button>
              {s.paused ? (
                <button type="button" onClick={() => onResume(s)} disabled={busy} className={BTN}>
                  Resume
                </button>
              ) : (
                <button type="button" onClick={() => onPause(s)} disabled={busy} className={BTN}>
                  Pause
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setEndingId(endingId === s.id ? null : s.id)
                  setEndMethod(DEFAULT_PAYMENT_METHOD)
                }}
                disabled={busy}
                className={BTN}
              >
                End…
              </button>
              <button type="button" onClick={() => void printReceipt(receiptForSession(s))} disabled={printing} className={BTN}>
                Receipt
              </button>
            </div>

            {refillConfirmId === s.id && (
              <div className="mt-3 space-y-3 rounded-md bg-[#F3EEE2] p-3">
                <p className="text-sm text-[#1C1A17]">
                  A refill adds {formatMoney(s.refillPrice, snap.currency)} (total becomes{" "}
                  {formatMoney(s.totalAmount + s.refillPrice, snap.currency)}). Collect it from the customer.
                </p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setRefillConfirmId(null)} disabled={busy} className={BTN}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRefillConfirmId(null)
                      onRefill(s)
                    }}
                    className={`${BTN_PRIMARY} !px-3 !py-2 !text-sm`}
                  >
                    Refill · {formatMoney(s.refillPrice, snap.currency)}
                  </button>
                </div>
              </div>
            )}

            {endingId === s.id && (
              <div className="mt-3 space-y-3 rounded-md bg-[#F3EEE2] p-3">
                {s.paymentMethod ? (
                  <p className="text-sm text-[#1C1A17]">
                    Already paid by {paymentLabel(s.paymentMethod)}.
                    {s.refillTotal > 0 ? ` Refills added since (${formatMoney(s.refillTotal, snap.currency)}): make sure that was collected.` : ""}{" "}
                    The device becomes available again.
                  </p>
                ) : (
                  <label className="block space-y-1 text-sm">
                    <span className="text-[#8A8375]">Paid by</span>
                    <select value={endMethod} onChange={(e) => setEndMethod(e.target.value)} className={FIELD}>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEndingId(null)} disabled={busy} className={BTN}>
                    Keep running
                  </button>
                  <button type="button" onClick={() => void confirmEnd(s)} disabled={busy} className={BTN_DANGER}>
                    {busy ? "Ending…" : "End session"}
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
