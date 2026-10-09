// app/admin/tz.ts
//
// Pure, dependency-free timezone helpers shared by server (page.tsx,
// admin-data.ts) and client (TodayBookings.tsx, QueueManager.tsx).
//
// Why this exists: page.tsx used to compute "today" as a UTC calendar day,
// which for a South African shop (UTC+2) puts bookings made between 00:00
// and 02:00 local time on the wrong day. Everything day-based in the admin
// now goes through the tenant's own timezone (tenant_settings.timezone).

export const DEFAULT_TIMEZONE = "Africa/Johannesburg"

/** How much booking history/future page.tsx loads for the Appointments
 *  screen. The date picker is clamped to this window so staff never
 *  navigate to a day the page didn't fetch. */
export const BOOKING_WINDOW_DAYS_BACK = 14
export const BOOKING_WINDOW_DAYS_AHEAD = 30

/** Falls back to DEFAULT_TIMEZONE if the stored value isn't a valid IANA zone. */
export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_TIMEZONE
  }
}

function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** "YYYY-MM-DD" of an instant, as seen on the wall clock in `tz`. */
export function dateKeyInTz(value: Date | string | number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value))
}

/** The UTC instant at which calendar day `dateKey` starts in `tz`. */
export function startOfDayUtc(dateKey: string, tz: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number)
  const guess = Date.UTC(y, m - 1, d)
  // Two passes so the offset is taken at the right instant around DST changes.
  let t = guess - offsetMs(guess, tz)
  t = guess - offsetMs(t, tz)
  return new Date(t)
}

export function addDaysKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Monday of the week containing `dateKey`. */
export function startOfWeekKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  return addDaysKey(dateKey, -((dow + 6) % 7))
}

export function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
}

export function formatDateLong(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

export function formatDateShort(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

/** "12 min" / "1h 05m" — coarse on purpose, same posture as StaffManager's elapsedSince. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  if (totalMinutes < 60) return `${totalMinutes} min`
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h}h ${String(m).padStart(2, "0")}m`
}
