// lib/services/shared/calendar-link.ts
/**
 * "Add to calendar" link for a booking: a Google Calendar "create event" URL with the title, start, end and
 * booking reference already filled in. One tap opens Google Calendar (the app on Android, the browser on iPhone)
 * with the event ready to save.
 *
 * PURE: no database access and no imports, so booking.ts, reschedule.ts and the kiosk can all use it.
 * Times are sent in UTC ("...Z"), so Google shows them in the customer's own time zone. A bad time returns null
 * (the caller just leaves the link out); it never throws.
 */

export interface CalendarEvent {
  title: string
  /** ISO start, e.g. "2026-11-20T08:30:00.000Z". */
  startISO: string
  endISO: string
  details?: string
  location?: string
}

/** "2026-11-20T08:30:00.000Z" -> "20261120T083000Z" (Google's format), or null if it isn't a real time. */
function toCalendarStamp(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
}

export function buildGoogleCalendarUrl(event: CalendarEvent): string | null {
  const start = toCalendarStamp(event.startISO)
  const end = toCalendarStamp(event.endISO)
  if (!start || !end || end <= start) return null

  // Built by hand (not URLSearchParams) so the "/" between the two times stays a plain "/", as Google's own links have it.
  const parts = [
    "action=TEMPLATE",
    `text=${encodeURIComponent(event.title)}`,
    `dates=${start}/${end}`,
  ]
  if (event.details) parts.push(`details=${encodeURIComponent(event.details)}`)
  if (event.location) parts.push(`location=${encodeURIComponent(event.location)}`)
  return `https://calendar.google.com/calendar/render?${parts.join("&")}`
}
