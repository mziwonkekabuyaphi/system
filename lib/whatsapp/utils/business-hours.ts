// lib/whatsapp/utils/business-hours.ts
/**
 * "Are we open right now?" for the WhatsApp greeting, read from the shop's own
 * business_hours rows (admin: Settings > Business hours) in the shop's own
 * timezone (tenant_settings.timezone). Nothing is hardcoded, and it replaces
 * the old single-venue business-hours file from the previous bot.
 *
 * "Open" is decided by the database function is_tenant_open_now() — the SAME
 * check the queue's walk-in trigger uses — so the greeting can never say
 * "we're open" while a queue join is being refused (or the other way round).
 * business_hours is only read afterwards, to word WHEN the shop opens next.
 *
 * Never throws and never blocks: if anything fails we report "open/unknown"
 * (isClosed = false) and the greeting is exactly what it was before.
 *
 * business_hours.day_of_week: 0 = Sunday … 6 = Saturday.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

interface HoursRow {
  day_of_week: number
  is_closed: boolean
  open_time: string | null
  close_time: string | null
}

export interface OpenStatus {
  /** true ONLY when the database positively says the shop is closed now. */
  isClosed: boolean
  /** A friendly, ready-to-send note when closed; "" when open or unknown. */
  note: string
}

const OPEN_OR_UNKNOWN: OpenStatus = { isClosed: false, note: "" }

function hhmm(time: string | null): string {
  return (time ?? "").slice(0, 5)
}

/** The shop's current weekday (0-6) and minutes since local midnight. */
function localNow(timeZone: string, now: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now)
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? ""
  let hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10)
  if (hour === 24) hour = 0
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10)
  return { day: WEEKDAY_INDEX[weekday] ?? now.getUTCDay(), minutes: hour * 60 + minute }
}

function minutesOf(time: string | null): number | null {
  if (!time) return null
  const [h, m] = time.split(":")
  const hours = Number(h)
  const mins = Number(m)
  return Number.isFinite(hours) && Number.isFinite(mins) ? hours * 60 + mins : null
}

/** "today at 09:00" / "tomorrow at 09:00" / "on Monday at 09:00", or null. */
function describeNextOpening(rows: HoursRow[], timeZone: string, now: Date): string | null {
  const byDay = new Map(rows.map((r) => [Number(r.day_of_week), r]))
  const { day, minutes } = localNow(timeZone, now)

  // Later today (closed only because it is before opening time).
  const today = byDay.get(day)
  const todayOpen = minutesOf(today?.open_time ?? null)
  if (today && !today.is_closed && todayOpen !== null && minutes < todayOpen) {
    return `today at ${hhmm(today.open_time)}`
  }

  for (let offset = 1; offset <= 7; offset++) {
    const candidate = byDay.get((day + offset) % 7)
    if (candidate && !candidate.is_closed && candidate.open_time) {
      const when = offset === 1 ? "tomorrow" : `on ${DAY_NAMES[(day + offset) % 7]}`
      return `${when} at ${hhmm(candidate.open_time)}`
    }
  }
  return null
}

/**
 * Closed right now? If so, a gentle note: when we open again, that the
 * walk-in queue waits for opening time, and that booking is still open.
 */
export async function getOpenStatus(tenantId: string, now: Date = new Date()): Promise<OpenStatus> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return OPEN_OR_UNKNOWN

    const { data: isOpen, error } = await supabase.rpc("is_tenant_open_now", { p_tenant_id: tenantId })
    if (error) {
      console.error("[business-hours] is_tenant_open_now failed, treating as open", { tenantId, error })
      return OPEN_OR_UNKNOWN
    }
    if (isOpen !== false) return OPEN_OR_UNKNOWN

    let nextOpening: string | null = null
    try {
      const [{ data: rows }, { data: settings }] = await Promise.all([
        supabase
          .from("business_hours")
          .select("day_of_week, is_closed, open_time, close_time")
          .eq("tenant_id", tenantId),
        supabase.from("tenant_settings").select("timezone").eq("tenant_id", tenantId).maybeSingle(),
      ])
      nextOpening = describeNextOpening((rows ?? []) as HoursRow[], settings?.timezone || "UTC", now)
    } catch (error) {
      console.error("[business-hours] could not work out the next opening", { tenantId, error })
    }

    const opens = nextOpening ? `We open again ${nextOpening}. ` : ""
    return {
      isClosed: true,
      note:
        `We're closed at the moment 🌙 ${opens}` +
        "The walk-in queue starts when we open, but you can still book a time for our next opening hours right now.",
    }
  } catch (error) {
    console.error("[business-hours] open-status lookup failed, treating as open", { tenantId, error })
    return OPEN_OR_UNKNOWN
  }
}
