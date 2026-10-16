// lib/services/shared/queue-day.ts
/**
 * "When did the shop's current day start?" as a real UTC instant, in the
 * tenant's own timezone. A queue entry that joined BEFORE this moment belongs
 * to a previous day and can never still be waiting for a walk-in turn.
 *
 * Used by BOTH the nightly stale-queue sweep (app/api/cron/sweep-stale-queue)
 * and queue.ts's simulation guard, so "stale" means exactly the same thing in
 * both places.
 *
 * Pure and dependency-free (Intl only). Handles DST via a two-pass offset fix.
 */

/** Offset of `timeZone` from UTC at instant `at`, in ms (e.g. +2h => 7_200_000). */
function tzOffsetMillis(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The tenant-local calendar date for `now`, as YYYY-MM-DD. */
function localDateString(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

/**
 * Midnight at the start of the tenant's current local day, as a Date (UTC
 * instant). An invalid timezone falls back to UTC rather than throwing.
 */
export function startOfTenantDay(timeZone: string, now: Date = new Date()): Date {
  let tz = timeZone || "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch {
    tz = "UTC"
  }

  const [y, m, d] = localDateString(tz, now).split("-").map(Number)
  const localMidnightAsUtc = Date.UTC(y, m - 1, d)

  let guess = localMidnightAsUtc
  for (let i = 0; i < 2; i++) {
    guess = localMidnightAsUtc - tzOffsetMillis(tz, new Date(guess))
  }
  return new Date(guess)
}
