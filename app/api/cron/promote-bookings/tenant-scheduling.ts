// lib/services/shared/tenant-scheduling.ts
/**
 * Shared scheduling primitives for the booking system: tenant timezone,
 * business hours for a given calendar date, and booking_settings reads.
 *
 * WHY THIS FILE EXISTS: booking.ts previously used hardcoded shop hours
 * (SHOP_OPEN_HOUR/SHOP_CLOSE_HOUR, both effectively UTC) and never read
 * tenant_settings.timezone, business_hours, or booking_settings at all.
 * A repo-wide search (see the header of app/api/cron/promote-bookings/
 * route.ts for the exact commands run) found no DB-level trigger or
 * function enforcing business hours or booking_settings against
 * availability — so this is genuinely new application-level logic, not
 * a duplicate of something that already exists elsewhere.
 *
 * This module is intentionally the ONE place that:
 *   - resolves a tenant's IANA timezone (tenant_settings.timezone)
 *   - resolves open/close hours for a specific calendar date
 *     (business_hours, keyed by day_of_week)
 *   - resolves booking_settings for a tenant
 *   - converts between a tenant-local "HH:MM on a given calendar date"
 *     and the equivalent UTC instant
 *
 * booking.ts (customer-facing availability + booking creation) and
 * app/admin/actions.ts (cancellation) both import from here rather than
 * each growing their own copy — this is the "one source of truth" the
 * spec asked for, extended to timezone/business-hours reads as well as
 * booking_settings itself.
 *
 * NO NEW DEPENDENCY: timezone conversion uses only the built-in Intl
 * API (the standard double-pass technique: format a UTC instant in the
 * target zone to find its offset, then apply that offset to a
 * wall-clock guess). This is correct for virtually every real booking
 * scenario. The one known limitation is the ~1-2 hour window right at a
 * DST transition, where the offset used is derived from a instant that
 * is close to, but not exactly, the instant being converted — a real
 * timezone library (date-fns-tz, Luxon) resolves this exactly, but
 * pulling one in for this one edge case would be exactly the kind of
 * unnecessary dependency/abstraction the spec asked to avoid. If DST-
 * boundary precision ever matters for this business, that's the trigger
 * to add one.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

// ============================================================================
// Timezone conversion (Intl-based, no dependency)
// ============================================================================

function getTimeZoneOffsetMinutes(utcMillis: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts = dtf.formatToParts(new Date(utcMillis))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  // Positive offset = local wall-clock time is ahead of UTC (e.g. +120 for UTC+2).
  return (asUTC - utcMillis) / 60_000
}

/**
 * Converts a wall-clock time ("HH:MM" or "HH:MM:SS", as Postgres `time`
 * columns come back via PostgREST) on a given calendar date, in a given
 * IANA timezone, to the equivalent UTC instant.
 */
export function zonedTimeToUtc(dateISO: string, hhmm: string, timeZone: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const [hour, minute] = hhmm.slice(0, 5).split(":").map(Number)

  // First guess: treat the wall-clock time as if it were UTC.
  const naiveUTCMillis = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offsetMinutes = getTimeZoneOffsetMinutes(naiveUTCMillis, timeZone)
  // The real UTC instant is the naive guess minus the zone's offset.
  return new Date(naiveUTCMillis - offsetMinutes * 60_000)
}

/** Today's calendar date, AS OBSERVED IN `timeZone`, formatted "YYYY-MM-DD"
 *  (en-CA formats dates in that exact order, which is why it's used here
 *  purely as a formatting trick, not for any locale-specific display). */
export function todayInTimezone(timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  return dtf.format(new Date())
}

/** Adds `days` (can be negative) to a "YYYY-MM-DD" calendar date string,
 *  pure calendar arithmetic — no timezone involved, since a calendar
 *  date plus N days is the same calendar date everywhere. */
export function addDaysToDateString(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** 0=Sunday..6=Saturday, matching business_hours.day_of_week. A calendar
 *  date string's weekday doesn't depend on timezone (it's already a
 *  specific day, not an instant), so no timeZone parameter is needed. */
export function dayOfWeekForDateString(dateISO: string): number {
  const [year, month, day] = dateISO.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * True when `dateISO` falls within [today, today + maxAdvanceDays]
 * inclusive — i.e. `max_advance_days = 30` means the boundary day 30
 * days out IS bookable, not just the 29 days before it. Both inputs are
 * calendar date strings (already resolved in the tenant's timezone by
 * the caller), so this is pure calendar-day arithmetic.
 */
export function isWithinAdvanceWindow(dateISO: string, todayISO: string, maxAdvanceDays: number): boolean {
  const [ty, tm, td] = todayISO.split("-").map(Number)
  const [dy, dm, dd] = dateISO.split("-").map(Number)
  const todayUTC = Date.UTC(ty, tm - 1, td)
  const targetUTC = Date.UTC(dy, dm - 1, dd)
  const offsetDays = Math.round((targetUTC - todayUTC) / 86_400_000)
  return offsetDays >= 0 && offsetDays <= maxAdvanceDays
}

// ============================================================================
// tenant_settings.timezone
// ============================================================================

// Only used if a tenant somehow has no tenant_settings row / no timezone
// value — every tenant should have one via the required Business Info
// form (see BusinessInfoPanel in SettingsManager.tsx), so this is a
// last-resort fallback, not the expected path. Chosen to match the rest
// of this codebase's South Africa-specific defaults (en-ZA formatting,
// ZAR prices) rather than an arbitrary UTC guess.
const DEFAULT_TIMEZONE = "Africa/Johannesburg"

export async function getTenantTimezone(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from("tenant_settings")
    .select("timezone")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load tenant timezone: ${error.message}`)
  return data?.timezone?.trim() || DEFAULT_TIMEZONE
}

// ============================================================================
// business_hours
// ============================================================================

export interface DayHours {
  isClosed: boolean
  openTime: string | null
  closeTime: string | null
}

/**
 * Resolves this tenant's configured hours for the weekday of `dateISO`
 * (already a tenant-local calendar date — see callers). No row for that
 * day_of_week is treated as CLOSED, not "open all day" — same fail-closed
 * posture as the kiosk module gate (resolveKioskModuleEnabled in
 * app/kiosk/[slug]/page.tsx): "not configured yet" must never silently
 * mean "anything goes."
 */
export async function getBusinessHoursForDate(
  supabase: SupabaseClient,
  tenantId: string,
  dateISO: string,
): Promise<DayHours> {
  const dayOfWeek = dayOfWeekForDateString(dateISO)

  const { data, error } = await supabase
    .from("business_hours")
    .select("is_closed, open_time, close_time")
    .eq("tenant_id", tenantId)
    .eq("day_of_week", dayOfWeek)
    .maybeSingle()

  if (error) throw new Error(`Failed to load business hours: ${error.message}`)
  if (!data) return { isClosed: true, openTime: null, closeTime: null }

  return { isClosed: data.is_closed, openTime: data.open_time, closeTime: data.close_time }
}

// ============================================================================
// booking_settings
// ============================================================================

/** Mirrors booking_settings.queue_priority_mode (added by
 *  supabase/migrations/20260915_add_queue_priority_mode.sql) — see that
 *  migration's comment, and lib/services/queue.ts's
 *  getQueueSimulation(), for exactly what each value does. Only has any
 *  effect while unifyWithQueue is true. app/admin/types.ts's
 *  AdminQueuePriorityMode is the same union, kept in sync by hand rather
 *  than imported, same cross-boundary reasoning as
 *  AdminKioskRegistrationType/KioskRegistrationType. */
export type QueuePriorityMode = "fifo" | "priority" | "hybrid"

const VALID_QUEUE_PRIORITY_MODES: QueuePriorityMode[] = ["fifo", "priority", "hybrid"]

export interface TenantBookingSettings {
  unifyWithQueue: boolean
  queueLeadTimeMinutes: number
  minNoticeMinutes: number
  maxAdvanceDays: number
  cancellationWindowMinutes: number
  queuePriorityMode: QueuePriorityMode
}

// Mirrors booking_settings' own column DEFAULTs exactly. Used only if a
// tenant's row is somehow missing (it shouldn't be — tenant_id is the
// primary key and a row is expected to exist per tenant), so
// availability/creation never hard-crash for a tenant that hasn't
// touched Settings > Booking yet.
const DEFAULT_BOOKING_SETTINGS: TenantBookingSettings = {
  unifyWithQueue: false,
  queueLeadTimeMinutes: 15,
  minNoticeMinutes: 30,
  maxAdvanceDays: 30,
  cancellationWindowMinutes: 60,
  queuePriorityMode: "fifo",
}

export async function getBookingSettings(supabase: SupabaseClient, tenantId: string): Promise<TenantBookingSettings> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select(
      "unify_with_queue, queue_lead_time_minutes, min_notice_minutes, max_advance_days, cancellation_window_minutes, queue_priority_mode",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load booking settings: ${error.message}`)
  if (!data) return DEFAULT_BOOKING_SETTINGS

  const queuePriorityMode = VALID_QUEUE_PRIORITY_MODES.includes(data.queue_priority_mode as QueuePriorityMode)
    ? (data.queue_priority_mode as QueuePriorityMode)
    : "fifo"

  return {
    unifyWithQueue: data.unify_with_queue,
    queueLeadTimeMinutes: data.queue_lead_time_minutes,
    minNoticeMinutes: data.min_notice_minutes,
    maxAdvanceDays: data.max_advance_days,
    cancellationWindowMinutes: data.cancellation_window_minutes,
    queuePriorityMode,
  }
}
