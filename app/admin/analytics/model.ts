// app/admin/analytics/model.ts
//
// Types, reporting-window logic and formatters shared by the Server Action
// and the dashboard. No "use server" here so it can be imported anywhere.
//
// WINDOW SEMANTICS (documented once, used everywhere):
//   * A range is tenant-local calendar dates, start INCLUSIVE, end EXCLUSIVE.
//     A custom range's user-facing "to" is inclusive; we add one day here.
//   * Postgres converts the dates to instants with `AT TIME ZONE tenant tz`,
//     so DST days are 23/25 hours long rather than being off by one.
//   * The comparison range is the immediately preceding range of equal length.
import { addDaysKey, dateKeyInTz } from "../tz"

export type Preset = "7d" | "30d" | "90d" | "custom"
export interface Range { start: string; end: string } // YYYY-MM-DD, end EXCLUSIVE

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const MAX_RANGE_DAYS = 366

export function dayCount(r: Range): number {
  return Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000)
}

export function resolveRange(
  preset: Preset,
  tz: string,
  custom?: { from?: string; to?: string },
): Range | { error: string } {
  if (preset === "custom") {
    const { from, to } = custom ?? {}
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) return { error: "Choose a start and end date." }
    if (from > to) return { error: "The start date must be on or before the end date." }
    const r = { start: from, end: addDaysKey(to, 1) }
    if (dayCount(r) > MAX_RANGE_DAYS) return { error: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.` }
    return r
  }
  const days = preset === "7d" ? 7 : preset === "90d" ? 90 : 30
  const today = dateKeyInTz(new Date(), tz)
  return { start: addDaysKey(today, -(days - 1)), end: addDaysKey(today, 1) } // includes today
}

export function previousRange(r: Range): Range {
  return { start: addDaysKey(r.start, -dayCount(r)), end: r.start }
}

/** null when the base is 0 (or either value is missing): the UI shows "–", never an invented %. */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || prev === 0) return null
  return ((cur - prev) / prev) * 100
}

/** Safe ratio: null on a zero denominator. */
export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d
}

/** Percentage (0-100) or null on a zero denominator; a real 0 stays 0. */
export function pctOf(n: number, d: number): number | null {
  return d === 0 ? null : (n / d) * 100
}

// ---------------------------------------------------------------- payload types
export interface DailyRow {
  date: string
  bookings_created: number
  appointments_scheduled: number
  walk_ins: number
  completed_visits: number
  messages_in: number
  messages_out: number
  new_customers: number
}

export interface Ops {
  meta: { start: string; end_exclusive: string; timezone: string }
  bookings: {
    created: number; created_confirmed: number; created_completed: number; created_cancelled: number
    scheduled: number; scheduled_completed: number; scheduled_cancelled: number
    avg_lead_hours: number | null
    by_hour: { hour: number; count: number }[]
    by_weekday: { dow: number; count: number }[]
    by_staff: { staff_id: string; name: string; active: boolean; scheduled: number; completed: number }[]
  }
  queue: {
    entries: number; waiting: number; called: number; done: number; cancelled: number
    walk_in: number; from_booking: number
    avg_wait_seconds: number | null; wait_sample: number
    avg_service_seconds: number | null; service_sample: number
    current_waiting: number; current_called: number
    by_hour: { hour: number; count: number }[]
    by_weekday: { dow: number; count: number }[]
  }
  customers: {
    total_registered: number; registered_before_window: number; new_registrations: number
    completed_visits: number; served: number; first_time: number; returning: number; repeat_in_period: number
  }
  services: {
    active_count: number; inactive_count: number
    no_service: { bookings: number; walk_ins: number }
    items: {
      service_id: string; name: string; active: boolean; configured_price: number; duration_minutes: number
      bookings: number; walk_ins: number; queue_entries: number
    }[]
  }
  staff: {
    active_count: number; clocked_in_now: number; completed_shifts: number
    shift_hours: number; avg_shift_hours: number | null; shifts_using_fallback_hours: number
    hours_by_staff: { staff_id: string; name: string; shifts: number; hours: number }[]
    activity_by_category: { category: string; count: number }[]
    recent_activity: { at: string; category: string; action: string; staff_name: string | null }[]
  }
  messaging: {
    conversations_created: number; conversations_total: number; conversations_active_in_period: number
    last_activity: string | null
    by_status: { status: string; count: number }[]
    by_handling: { active: number; handoff: number; paused: number; resolved: number }
    ai_enabled: number; ai_disabled: number
    incoming: number; outgoing: number
    by_type: { type: string; count: number }[]
    integrations: { provider: string; status: string }[]
  }
  daily: DailyRow[]
}

export interface Billing {
  plan: {
    key: string; name: string; price_cents: number; currency: string
    visit_limit: number | null; visit_limit_period: string; staff_limit: number | null
    included_staff: number; price_per_visit_cents: number | null
  } | null
  by_status: { currency: string; status: string; count: number; amount_cents: number }[]
  outstanding_all_time: { currency: string; count: number; amount_cents: number; overdue_count: number; overdue_amount_cents: number }[]
  trend: {
    invoice_id: string; period_start: string; period_end: string; plan_key: string; currency: string; status: string
    amount_cents: number; base_fee_cents: number; extra_staff_fee_cents: number
    visit_count: number; overage_visits: number; paid_at: string | null
  }[]
  plan_distribution: { plan_key: string; count: number }[]
  visits: { total: number; by_source: { source: string; count: number }[] }
}

export interface Payroll {
  currency: string | null
  records: number; hours: number; gross: number; paye: number; uif: number; deductions: number; final: number
  paid_final: number; pending_final: number; paid_count: number; pending_count: number
  by_period: { period_start: string; period_end: string; gross: number; paye: number; uif: number; deductions: number; final: number; paid_final: number; pending_final: number }[]
  by_staff: { staff_id: string; name: string; hours: number; gross: number; final: number }[]
}

export interface AnalyticsData {
  timezone: string
  currency: string
  range: Range
  prevRange: Range | null
  current: Ops
  previous: Ops | null
  /** null = caller lacks billing.view (or the section failed: see warnings). */
  billing: Billing | null
  /** null = caller lacks payroll.view (or the section failed: see warnings). */
  payroll: Payroll | null
  warnings: string[]
}

export type AnalyticsResult = ({ ok: true } & AnalyticsData) | { ok: false; error: string }

// ---------------------------------------------------------------- formatters
/** Integer cents -> display string, using the INVOICE's own currency. */
export function formatCents(cents: number, currency: string): string {
  return formatMoney(cents / 100, currency)
}

/** Major-unit numeric (payroll, configured prices) -> display string. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "–"
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const formatPct = (v: number | null, digits = 0) => (v == null ? "–" : `${v.toFixed(digits)}%`)
export const formatNum = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString())
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
