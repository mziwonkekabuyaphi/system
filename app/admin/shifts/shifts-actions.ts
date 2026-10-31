// app/admin/shifts/shifts-actions.ts
"use server"

/**
 * Server actions for Shifts. Same two-layer posture as app/admin/actions.ts:
 *   1. requireTenantPermission(shifts.view | shifts.manage) runs BEFORE any query.
 *   2. Every query on the service-role client is also filtered by tenant_id.
 *
 * Staff-facing reads (My shifts) are narrowed in code to the caller's own staff
 * row + PUBLISHED schedules, mirroring the RLS policies on scheduled_shifts.
 *
 * The swap functions (request/respond/cancel/review_shift_swap and
 * shift_swap_candidates) identify the caller with auth.uid() inside Postgres.
 * The service-role client has NO auth.uid(), so those calls go through the
 * signed-in user's own session client (getUserClient below).
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { createSessionClient } from "@/lib/supabase/session-server"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { getTenantPermissions, requireTenantPermission } from "@/lib/tenant/require-tenant-permission"

import { addDaysKey } from "../tz"
import type {
  ScheduledShift,
  ShiftAttendanceRow,
  ShiftResult,
  ShiftSchedule,
  ShiftScheduleType,
  ShiftSettings,
  ShiftsData,
  ShiftSwap,
  ShiftTemplate,
  SwapCandidate,
} from "./shift-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
const PERIOD_DAYS: Record<ShiftScheduleType, number> = { weekly: 7, biweekly: 14, monthly: 0 }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const hhmm = (t: string) => t.slice(0, 5)

async function ctx(level: "view" | "manage") {
  const check = await requireTenantPermission(`shifts.${level}` as const)
  if (!check.ok) return { error: check.error } as const
  const supabase = getSupabaseServerClient()
  if (!supabase) return { error: "Supabase isn't configured." } as const
  const { userId } = await requireTenantMember()
  return { supabase, tenantId: check.member.tenantId, userId } as const
}

async function getUserClient() {
  return createSessionClient()
}

async function ownStaffId(supabase: ServerClient, tenantId: string, userId: string) {
  const { data } = await supabase
    .from("staff")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("profile_id", userId)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/** Last day of a monthly period starting at `start` (the 1st, or any day: runs to the day before next month's same date). */
function monthlyEnd(start: string): string {
  const [y, m, d] = start.split("-").map(Number)
  const next = new Date(Date.UTC(y, m, d)) // month m (0-based) == next month
  next.setUTCDate(next.getUTCDate() - 1)
  const end = next.toISOString().slice(0, 10)
  // DB CHECK: monthly span must be 27..30 days (28..31 inclusive days).
  return end
}

// ============================================================================
// Load
// ============================================================================

export async function loadShiftsData(): Promise<ShiftResult<{ data: ShiftsData }>> {
  const c = await ctx("view")
  if ("error" in c) return { ok: false, error: c.error }
  const { supabase, tenantId, userId } = c

  const { granted } = await getTenantPermissions(["shifts.manage"])
  const canManage = granted.has("shifts.manage")
  const myStaffId = await ownStaffId(supabase, tenantId, userId)
  if (!canManage && !myStaffId) {
    return { ok: false, error: "Your login isn't linked to a staff profile, so there are no shifts to show." }
  }

  const since = addDaysKey(new Date().toISOString().slice(0, 10), -60)

  let scheduleQuery = supabase
    .from("shift_schedules")
    .select("id, name, schedule_type, period_start, period_end, status")
    .eq("tenant_id", tenantId)
    .gte("period_end", since)
    .order("period_start", { ascending: false })
  if (!canManage) scheduleQuery = scheduleQuery.eq("status", "published")

  const [schedulesRes, templatesRes, staffRes, settingsRes] = await Promise.all([
    scheduleQuery,
    supabase
      .from("shift_templates")
      .select("id, name, start_time, end_time, color, active")
      .eq("tenant_id", tenantId)
      .order("start_time"),
    supabase.from("staff").select("id, name, job_title").eq("tenant_id", tenantId).eq("active", true).order("name"),
    canManage
      ? supabase.from("shift_settings").select("*").eq("tenant_id", tenantId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  for (const r of [schedulesRes, templatesRes, staffRes, settingsRes]) {
    if (r.error) return { ok: false, error: r.error.message }
  }

  const schedules: ShiftSchedule[] = (schedulesRes.data ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
    type: s.schedule_type,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    status: s.status,
  }))
  const scheduleIds = schedules.map((s) => s.id)

  let shiftQuery = supabase
    .from("scheduled_shifts")
    .select("id, schedule_id, staff_id, template_id, shift_date, start_time, end_time, status, note")
    .eq("tenant_id", tenantId)
    .in("schedule_id", scheduleIds.length ? scheduleIds : ["00000000-0000-0000-0000-000000000000"])
    .order("shift_date")
    .order("start_time")
  if (!canManage) shiftQuery = shiftQuery.eq("staff_id", myStaffId!)

  let swapQuery = supabase
    .from("shift_swap_requests")
    .select("id, shift_id, requester_staff_id, target_staff_id, target_shift_id, status, requester_note, review_note, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(100)
  if (!canManage) {
    swapQuery = swapQuery.or(`requester_staff_id.eq.${myStaffId},target_staff_id.eq.${myStaffId}`)
  }

  const [shiftsRes, swapsRes] = await Promise.all([shiftQuery, swapQuery])
  if (shiftsRes.error) return { ok: false, error: shiftsRes.error.message }
  if (swapsRes.error) return { ok: false, error: swapsRes.error.message }

  const mapShift = (s: any): ScheduledShift => ({
    id: s.id,
    scheduleId: s.schedule_id,
    staffId: s.staff_id,
    templateId: s.template_id,
    date: s.shift_date,
    startTime: hhmm(s.start_time),
    endTime: hhmm(s.end_time),
    status: s.status,
    note: s.note,
  })
  const shifts = (shiftsRes.data ?? []).map(mapShift)

  const swaps: ShiftSwap[] = (swapsRes.data ?? []).map((r: any) => ({
    id: r.id,
    shiftId: r.shift_id,
    requesterStaffId: r.requester_staff_id,
    targetStaffId: r.target_staff_id,
    targetShiftId: r.target_shift_id,
    status: r.status,
    requesterNote: r.requester_note,
    reviewNote: r.review_note,
    createdAt: r.created_at,
  }))

  // A swap can point at a colleague's shift the staff member doesn't own; pull
  // just those rows so the swap card can show the date and time.
  const known = new Set(shifts.map((s) => s.id))
  const missing = [...new Set(swaps.flatMap((s) => [s.shiftId, s.targetShiftId]).filter((id): id is string => !!id && !known.has(id)))]
  if (missing.length) {
    const { data: extra } = await supabase
      .from("scheduled_shifts")
      .select("id, schedule_id, staff_id, template_id, shift_date, start_time, end_time, status, note")
      .eq("tenant_id", tenantId)
      .in("id", missing)
    for (const s of extra ?? []) shifts.push(mapShift(s))
  }

  const shiftIds = shifts.map((s) => s.id)
  let attendance: ShiftAttendanceRow[] = []
  if (shiftIds.length) {
    let attQuery = supabase
      .from("shift_attendance")
      .select("id, scheduled_shift_id, staff_id, status, minutes_late, override_status, override_note")
      .eq("tenant_id", tenantId)
      .in("scheduled_shift_id", shiftIds)
    if (!canManage) attQuery = attQuery.eq("staff_id", myStaffId!)
    const { data: att } = await attQuery
    attendance = (att ?? []).map((a: any) => ({
      id: a.id,
      scheduledShiftId: a.scheduled_shift_id,
      staffId: a.staff_id,
      status: a.status,
      minutesLate: a.minutes_late,
      overrideStatus: a.override_status,
      overrideNote: a.override_note,
    }))
  }

  const sd: any = settingsRes.data
  const settings: ShiftSettings | null = sd
    ? {
        lateGraceMinutes: sd.late_grace_minutes,
        noShowAfterMinutes: sd.no_show_after_minutes,
        earlyClockInMinutes: sd.early_clock_in_minutes,
        swapRequiresColleague: sd.swap_requires_colleague,
        swapMinNoticeHours: sd.swap_min_notice_hours,
      }
    : null

  return {
    ok: true,
    data: {
      myStaffId,
      canManage,
      // Directory view only (id, name, title), same exposure as page.tsx's staff list.
      staff: (staffRes.data ?? []).map((s: any) => ({ id: s.id, name: s.name, jobTitle: s.job_title })),
      templates: (templatesRes.data ?? []).map(
        (t: any): ShiftTemplate => ({
          id: t.id,
          name: t.name,
          startTime: hhmm(t.start_time),
          endTime: hhmm(t.end_time),
          color: t.color,
          active: t.active,
        }),
      ),
      schedules,
      shifts,
      swaps,
      attendance,
      settings,
    },
  }
}

// ============================================================================
// Manager: templates, schedules, shifts
// ============================================================================

export async function saveShiftTemplate(input: {
  id?: string
  name: string
  startTime: string
  endTime: string
  color?: string | null
}): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const name = input.name.trim()
  if (!name) return { ok: false, error: "Give the shift a name, e.g. “Morning”." }
  if (!HHMM.test(input.startTime) || !HHMM.test(input.endTime)) return { ok: false, error: "Use times like 08:00." }
  if (input.startTime === input.endTime) return { ok: false, error: "Start and end time can't be the same." }
  const row = { name, start_time: input.startTime, end_time: input.endTime, color: input.color ?? null }
  const q = input.id
    ? c.supabase.from("shift_templates").update(row).eq("id", input.id).eq("tenant_id", c.tenantId)
    : c.supabase.from("shift_templates").insert({ ...row, tenant_id: c.tenantId })
  const { error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function setShiftTemplateActive(id: string, active: boolean): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const { error } = await c.supabase.from("shift_templates").update({ active }).eq("id", id).eq("tenant_id", c.tenantId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function createShiftSchedule(input: {
  type: ShiftScheduleType
  periodStart: string
  name?: string
}): Promise<ShiftResult<{ id: string }>> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  if (!DATE.test(input.periodStart)) return { ok: false, error: "Pick a start date." }
  const periodEnd =
    input.type === "monthly" ? monthlyEnd(input.periodStart) : addDaysKey(input.periodStart, PERIOD_DAYS[input.type] - 1)
  const { data, error } = await c.supabase
    .from("shift_schedules")
    .insert({
      tenant_id: c.tenantId,
      name: input.name?.trim() || null,
      schedule_type: input.type,
      period_start: input.periodStart,
      period_end: periodEnd,
      status: "draft",
      created_by: c.userId,
    })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: data.id }
}

export async function setSchedulePublished(scheduleId: string, published: boolean): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const { error } = await c.supabase
    .from("shift_schedules")
    .update({ status: published ? "published" : "draft" })
    .eq("id", scheduleId)
    .eq("tenant_id", c.tenantId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/admin")
  return { ok: true }
}

export async function deleteShiftSchedule(scheduleId: string): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const { error } = await c.supabase.from("shift_schedules").delete().eq("id", scheduleId).eq("tenant_id", c.tenantId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Create or edit one shift. Pass templateId to take its times, or explicit start/end. */
export async function saveScheduledShift(input: {
  id?: string
  scheduleId: string
  staffId: string
  date: string
  templateId?: string | null
  startTime?: string
  endTime?: string
  note?: string
}): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  if (!DATE.test(input.date)) return { ok: false, error: "Pick a date." }

  let start = input.startTime
  let end = input.endTime
  if (input.templateId) {
    const { data: t } = await c.supabase
      .from("shift_templates")
      .select("start_time, end_time")
      .eq("id", input.templateId)
      .eq("tenant_id", c.tenantId)
      .maybeSingle()
    if (!t) return { ok: false, error: "That shift type no longer exists." }
    start = hhmm(t.start_time)
    end = hhmm(t.end_time)
  }
  if (!start || !end || !HHMM.test(start) || !HHMM.test(end)) return { ok: false, error: "Use times like 08:00." }
  if (start === end) return { ok: false, error: "Start and end time can't be the same." }

  const row = {
    schedule_id: input.scheduleId,
    staff_id: input.staffId,
    template_id: input.templateId ?? null,
    shift_date: input.date,
    start_time: start,
    end_time: end,
    note: input.note?.trim() || null,
  }
  // The scheduled_shifts_validate trigger rejects dates outside the schedule's
  // period and clashing shifts for the same person; its message is shown as-is.
  const q = input.id
    ? c.supabase.from("scheduled_shifts").update(row).eq("id", input.id).eq("tenant_id", c.tenantId)
    : c.supabase.from("scheduled_shifts").insert({ ...row, tenant_id: c.tenantId, created_by: c.userId })
  const { error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deleteScheduledShift(id: string): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const { error } = await c.supabase.from("scheduled_shifts").delete().eq("id", id).eq("tenant_id", c.tenantId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Repeat a pattern: staff + shift type + weekdays (0=Sun..6=Sat) filled across the schedule's period. */
export async function applyWeeklyPattern(input: {
  scheduleId: string
  staffId: string
  templateId: string
  weekdays: number[]
}): Promise<ShiftResult<{ created: number }>> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  if (!input.weekdays.length || input.weekdays.some((d) => d < 0 || d > 6)) {
    return { ok: false, error: "Pick at least one weekday." }
  }
  const { data: sched } = await c.supabase
    .from("shift_schedules")
    .select("period_start, period_end")
    .eq("id", input.scheduleId)
    .eq("tenant_id", c.tenantId)
    .maybeSingle()
  if (!sched) return { ok: false, error: "Schedule not found." }

  const { error: ruleError } = await c.supabase.from("shift_recurrence_rules").insert({
    tenant_id: c.tenantId,
    staff_id: input.staffId,
    template_id: input.templateId,
    weekdays: input.weekdays,
    start_date: sched.period_start,
    end_date: sched.period_end,
    active: true,
    created_by: c.userId,
  })
  if (ruleError) return { ok: false, error: ruleError.message }

  const { data: created, error } = await c.supabase.rpc("apply_shift_recurrence", { p_schedule_id: input.scheduleId })
  if (error) return { ok: false, error: error.message }
  return { ok: true, created: Number(created ?? 0) }
}

export async function saveShiftSettings(input: ShiftSettings): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const { error } = await c.supabase
    .from("shift_settings")
    .upsert({
      tenant_id: c.tenantId,
      late_grace_minutes: input.lateGraceMinutes,
      no_show_after_minutes: input.noShowAfterMinutes,
      early_clock_in_minutes: input.earlyClockInMinutes,
      swap_requires_colleague: input.swapRequiresColleague,
      swap_min_notice_hours: input.swapMinNoticeHours,
    })
  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function overrideAttendance(
  attendanceId: string,
  status: "on_time" | "excused" | null,
  note?: string,
): Promise<ShiftResult> {
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const { error } = await c.supabase
    .from("shift_attendance")
    .update({
      override_status: status,
      override_note: status ? note?.trim() || null : null,
      override_by: status ? c.userId : null,
      override_at: status ? new Date().toISOString() : null,
    })
    .eq("id", attendanceId)
    .eq("tenant_id", c.tenantId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

// ============================================================================
// Swaps — go through the SIGNED-IN USER's client (the functions use auth.uid())
// ============================================================================

async function swapGuard() {
  const c = await ctx("view")
  if ("error" in c) return { error: c.error } as const
  return { user: await getUserClient() } as const
}

export async function getSwapCandidates(shiftId: string): Promise<ShiftResult<{ candidates: SwapCandidate[] }>> {
  const g = await swapGuard()
  if ("error" in g) return { ok: false, error: g.error }
  const { data, error } = await g.user.rpc("shift_swap_candidates", { p_shift_id: shiftId })
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    candidates: (data ?? []).map((r: any) => ({
      staffId: r.staff_id,
      staffName: r.staff_name,
      shiftId: r.shift_id,
      date: r.shift_date,
      startTime: r.start_time ? hhmm(r.start_time) : null,
      endTime: r.end_time ? hhmm(r.end_time) : null,
    })),
  }
}

export async function requestSwap(input: {
  shiftId: string
  targetStaffId: string
  targetShiftId?: string | null
  note?: string
}): Promise<ShiftResult> {
  const g = await swapGuard()
  if ("error" in g) return { ok: false, error: g.error }
  const { error } = await g.user.rpc("request_shift_swap", {
    p_shift_id: input.shiftId,
    p_target_staff_id: input.targetStaffId,
    p_target_shift_id: input.targetShiftId ?? null,
    p_note: input.note?.trim() || null,
  })
  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function respondSwap(requestId: string, accept: boolean): Promise<ShiftResult<{ status: string }>> {
  const g = await swapGuard()
  if ("error" in g) return { ok: false, error: g.error }
  const { data, error } = await g.user.rpc("respond_shift_swap", { p_request_id: requestId, p_accept: accept })
  return error ? { ok: false, error: error.message } : { ok: true, status: String(data) }
}

export async function cancelSwap(requestId: string): Promise<ShiftResult> {
  const g = await swapGuard()
  if ("error" in g) return { ok: false, error: g.error }
  const { error } = await g.user.rpc("cancel_shift_swap", { p_request_id: requestId })
  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function reviewSwap(requestId: string, approve: boolean, note?: string): Promise<ShiftResult<{ status: string }>> {
  // review_shift_swap checks shifts.manage itself; we also check here for a clean message.
  const c = await ctx("manage")
  if ("error" in c) return { ok: false, error: c.error }
  const user = await getUserClient()
  const { data, error } = await user.rpc("review_shift_swap", {
    p_request_id: requestId,
    p_approve: approve,
    p_note: note?.trim() || null,
  })
  return error ? { ok: false, error: error.message } : { ok: true, status: String(data) }
}
