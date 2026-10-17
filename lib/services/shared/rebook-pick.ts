// lib/services/shared/rebook-pick.ts
/**
 * Pure helpers for the "Same again?" suggestion: given the free slots across the
 * offered dates and when the customer was last served, pick the one slot to
 * propose. No imports and no I/O on purpose, so it is trivial to test.
 *
 * Rule: prefer the earliest offered date that falls on the same weekday as the
 * last visit (their "usual day"); if none of those has a free slot, take the
 * earliest date that has any. Within that date, take the slot whose time of day
 * is closest to the last visit's (ties go to the earlier slot).
 */

export interface PickSlot {
  /** ISO start time. */
  start: string
  label: string
}

export interface PickDate {
  /** Tenant-local calendar date, YYYY-MM-DD. */
  date: string
  label: string
}

export function weekdayInTimezone(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(instant)
}

/** Weekday of a pure calendar date. Anchored at UTC noon so it can't roll over. */
export function weekdayOfDateISO(dateISO: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${dateISO}T12:00:00.000Z`),
  )
}

export function minutesOfDayInTimezone(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(instant)
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0)
  return hour * 60 + minute
}

export function pickSuggestedSlot(args: {
  dates: PickDate[]
  /** slotsByDate[i] holds the free slots for dates[i]. */
  slotsByDate: PickSlot[][]
  lastVisitAt: Date
  timezone: string
}): { date: PickDate; slot: PickSlot } | null {
  const { dates, slotsByDate, lastVisitAt, timezone } = args

  const withSlots: number[] = []
  for (let i = 0; i < dates.length; i++) {
    if ((slotsByDate[i] ?? []).length > 0) withSlots.push(i)
  }
  if (withSlots.length === 0) return null

  const usualWeekday = weekdayInTimezone(lastVisitAt, timezone)
  const chosenIndex = withSlots.find((i) => weekdayOfDateISO(dates[i].date) === usualWeekday) ?? withSlots[0]

  const usualMinutes = minutesOfDayInTimezone(lastVisitAt, timezone)
  let best: PickSlot | null = null
  let bestDistance = Infinity
  for (const slot of slotsByDate[chosenIndex]) {
    const distance = Math.abs(minutesOfDayInTimezone(new Date(slot.start), timezone) - usualMinutes)
    if (distance < bestDistance) {
      best = slot
      bestDistance = distance
    }
  }

  return best ? { date: dates[chosenIndex], slot: best } : null
}
