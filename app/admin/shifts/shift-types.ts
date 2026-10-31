// app/admin/shifts/shift-types.ts
// Shapes for the Shifts screens. Mirrors the shift_* tables in the Ndithini Platform database.

export type ShiftScheduleType = "weekly" | "biweekly" | "monthly"
export type ShiftScheduleStatus = "draft" | "published"
export type ShiftStatus = "scheduled" | "cancelled" | "swapped"
export type SwapStatus =
  | "pending_colleague"
  | "pending_admin"
  | "approved"
  | "rejected"
  | "declined"
  | "cancelled"
export type AttendanceStatus = "on_time" | "late" | "no_show"

export interface ShiftTemplate {
  id: string
  name: string
  /** "HH:MM" */
  startTime: string
  endTime: string
  color: string | null
  active: boolean
}

export interface ShiftSchedule {
  id: string
  name: string | null
  type: ShiftScheduleType
  /** YYYY-MM-DD, inclusive */
  periodStart: string
  periodEnd: string
  status: ShiftScheduleStatus
}

export interface ScheduledShift {
  id: string
  scheduleId: string
  staffId: string
  templateId: string | null
  /** YYYY-MM-DD */
  date: string
  startTime: string
  endTime: string
  status: ShiftStatus
  note: string | null
}

export interface ShiftSwap {
  id: string
  shiftId: string
  requesterStaffId: string
  targetStaffId: string
  targetShiftId: string | null
  status: SwapStatus
  requesterNote: string | null
  reviewNote: string | null
  createdAt: string
}

export interface ShiftAttendanceRow {
  id: string
  scheduledShiftId: string
  staffId: string
  status: AttendanceStatus
  minutesLate: number | null
  overrideStatus: "on_time" | "excused" | null
  overrideNote: string | null
}

export interface ShiftSettings {
  lateGraceMinutes: number
  noShowAfterMinutes: number
  earlyClockInMinutes: number
  swapRequiresColleague: boolean
  swapMinNoticeHours: number
}

export interface ShiftStaffOption {
  id: string
  name: string
  jobTitle: string | null
}

export interface SwapCandidate {
  staffId: string
  staffName: string
  shiftId: string | null
  date: string | null
  startTime: string | null
  endTime: string | null
}

export interface ShiftsData {
  /** The signed-in user's own staff row, null if they have no staff profile. */
  myStaffId: string | null
  canManage: boolean
  staff: ShiftStaffOption[]
  templates: ShiftTemplate[]
  schedules: ShiftSchedule[]
  shifts: ScheduledShift[]
  swaps: ShiftSwap[]
  attendance: ShiftAttendanceRow[]
  /** Only for shifts.manage; null otherwise. */
  settings: ShiftSettings | null
}

export type ShiftResult<T = object> = ({ ok: true } & T) | { ok: false; error: string }
