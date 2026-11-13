// app/scan/[slug]/time.ts
//
// Tiny formatting helpers, kept local so the scanner doesn't depend on the admin folders.
// Times are stored as UTC instants and shown in the tenant's own timezone.

function safe(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-ZA", { timeZone: tz })
    return tz
  } catch {
    return "Africa/Johannesburg"
  }
}

export function clockTime(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: safe(tz),
  }).format(d)
}

/** "Thu, 12 Nov, 20:00" */
export function eventStamp(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: safe(tz),
  }).format(d)
}
