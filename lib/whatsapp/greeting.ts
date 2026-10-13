// lib/whatsapp/greeting.ts
/**
 * Shared "smart greeting" phrase pool + time-aware picker for Zozoqueue.
 *
 * Same pool as the original project's greeting.ts. Only differences:
 *   1. WHITE-LABEL: the brand-name phrase ("Welcome to Zozoqueue,") is gone.
 *      QLess is multi-tenant, so no brand is hardcoded here. The shop's own
 *      name is added by action-router.ts's buildEntryReply() on a separate
 *      "Welcome to <shop>" line (tenant_branding.display_name, falling back
 *      to tenants.name).
 *   2. getSmartGreeting() takes an optional IANA `timeZone` so the time of
 *      day is the shop's local time, not the server's (Vercel runs in UTC,
 *      which would be 2 hours behind South Africa).
 */

export interface GreetingPhrase {
  text: string
  time: "morning" | "afternoon" | "evening" | "any"
  /** Implies the customer has been here before; skipped for new customers. */
  returningOnly?: boolean
}

export interface GreetingOptions {
  /** IANA zone, e.g. the tenant's timezone. Omit to use server local time. */
  timeZone?: string
  /** False for a customer we have no name/record for. Defaults to true. */
  isReturning?: boolean
  /** Only for testability; defaults to now. */
  date?: Date
}

export const GREETING_PHRASES: GreetingPhrase[] = [
  // Local
  { text: "Wamkelekile,", time: "any" },
  { text: "Molo,", time: "any" },
  { text: "Sawubona,", time: "any" },
  { text: "Molweni,", time: "any" },
  { text: "Sanibonani,", time: "any" },

  // Friendly
  { text: "Hello,", time: "any" },
  { text: "Hi there,", time: "any" },
  { text: "Hey,", time: "any" },
  { text: "Welcome,", time: "any" },
  { text: "Welcome back,", time: "any", returningOnly: true },

  // Time-based
  { text: "Good morning,", time: "morning" },
  { text: "Good afternoon,", time: "afternoon" },
  { text: "Good evening,", time: "evening" },

  // Concierge style
  { text: "It's great to see you,", time: "any" },
  { text: "Happy to have you back,", time: "any", returningOnly: true },
  { text: "Thanks for reaching out,", time: "any" },
]

function getHour(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours()
  const hour = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).format(date)
  return Number(hour)
}

function getTimeOfDay(date: Date, timeZone?: string): GreetingPhrase["time"] {
  const hour = getHour(date, timeZone)
  if (hour < 12) return "morning"
  if (hour < 17) return "afternoon"
  if (hour < 21) return "evening"
  return "any"
}

/**
 * Picks a random greeting phrase, weighted toward the current time of day
 * (falls back to the "any" pool if nothing matches).
 *
 * @param timeZone IANA zone, e.g. the tenant's timezone. Omit to use the
 *                 server's local time.
 * @param date     Only for testability; defaults to now.
 */
export function getSmartGreeting(options: GreetingOptions = {}): string {
  const { timeZone, isReturning = true, date = new Date() } = options
  const timeOfDay = getTimeOfDay(date, timeZone)
  const filtered = GREETING_PHRASES.filter(
    (g) => (g.time === timeOfDay || g.time === "any") && (isReturning || !g.returningOnly),
  )
  const available = filtered.length > 0 ? filtered : GREETING_PHRASES.filter((g) => g.time === "any")
  return available[Math.floor(Math.random() * available.length)].text
}
