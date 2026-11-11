// app/admin/events/format.ts
//
// Pure formatting + timezone helpers. Event times are stored as UTC instants
// but entered and shown in the shop's own timezone (tenant_settings.timezone),
// so a <input type="datetime-local"> value is converted explicitly, never via
// the browser's own zone.

import type { EventStatus } from "./types"

export const DEFAULT_TIMEZONE = "Africa/Johannesburg"

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat("en-ZA", { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_TIMEZONE
  }
}

export function formatMoney(amount: number, currency = "ZAR"): string {
  const whole = Math.abs(amount % 1) < 0.005
  try {
    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `R${amount.toFixed(whole ? 0 : 2)}`
  }
}

export function formatEventDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: safeTimezone(tz),
  }).format(new Date(iso))
}

export function formatClock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: safeTimezone(tz),
  }).format(new Date(iso))
}

export function formatShortDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    timeZone: safeTimezone(tz),
  }).format(new Date(iso))
}

function wallParts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(date)) p[part.type] = part.value
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  }
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" in the shop's timezone (for datetime-local). */
export function isoToLocalInput(iso: string | null, tz: string): string {
  if (!iso) return ""
  const w = wallParts(new Date(iso), safeTimezone(tz))
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`
}

/** "YYYY-MM-DDTHH:mm" read as wall time in the shop's timezone -> ISO instant. */
export function localInputToIso(value: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  const zone = safeTimezone(tz)
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  let guess = target
  // Two passes settle the offset, including across a DST change.
  for (let i = 0; i < 2; i += 1) {
    const w = wallParts(new Date(guess), zone)
    const wall = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
    guess -= wall - target
  }
  return new Date(guess).toISOString()
}

/** YYYY-MM-DD of an instant in the shop's timezone. */
export function dateKey(iso: string | Date, tz: string): string {
  const w = wallParts(typeof iso === "string" ? new Date(iso) : iso, safeTimezone(tz))
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`
}

export const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft",
  active: "On sale",
  ended: "Ended",
  cancelled: "Cancelled",
}
