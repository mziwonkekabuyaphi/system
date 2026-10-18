"use client"

// app/demo/SetupContext.tsx
//
// The one place the "set it up yourself" demo keeps its state, so a change in one tab
// shows up in the others: branding colours reach the clock pad and the payslip, staff
// created in the Staff tab can clock in on the pad, and the hours they clock become pay.
// Nothing is persisted or sent anywhere: refresh the page and it starts again.
//
// Time: the demo has its own clock (real time plus a "skip ahead" offset), so a visitor
// can clock in, skip four hours, clock out, and see four hours of pay.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Industry } from "./industries"
import {
  DEFAULT_CLOCK,
  seedBrand,
  seedEmployer,
  seedShifts,
  seedStaff,
  type Brand,
  type ClockSettings,
  type Employer,
  type PunchResult,
  type Shift,
  type StaffInput,
  type StaffMember,
} from "./setupData"

type SaveResult = { ok: true; name: string } | { ok: false; error: string }

type Ctx = {
  industry: Industry
  brand: Brand
  setBrand: (patch: Partial<Brand>) => void
  staff: StaffMember[]
  saveStaff: (input: StaffInput, editingId?: string | null) => SaveResult
  removeStaff: (id: string) => void
  toggleStaff: (id: string) => void
  shifts: Shift[]
  forceClockOut: (shiftId: string) => void
  punch: (pin: string) => PunchResult
  clock: ClockSettings
  setClock: (patch: Partial<ClockSettings>) => void
  employer: Employer
  setEmployer: (patch: Partial<Employer>) => void
  /** The demo's "now": real time plus whatever the visitor has skipped ahead. */
  now: () => number
  skewMinutes: number
  skipAhead: (minutes: number) => void
  reset: () => void
}

const SetupCtx = createContext<Ctx | null>(null)

export function useSetup(): Ctx {
  const ctx = useContext(SetupCtx)
  if (!ctx) throw new Error("useSetup must be used inside <SetupProvider>")
  return ctx
}

const lastChars = (value: string, n: number) => value.replace(/\s|-/g, "").slice(-n)

export function SetupProvider({ industry, children }: { industry: Industry; children: ReactNode }) {
  const [brand, setBrandState] = useState<Brand>(() => seedBrand(industry))
  const [staff, setStaff] = useState<StaffMember[]>(() => seedStaff(industry.id))
  const [shifts, setShifts] = useState<Shift[]>([]) // seeded after mount: they depend on the time
  const [clock, setClockState] = useState<ClockSettings>(DEFAULT_CLOCK)
  const [employer, setEmployerState] = useState<Employer>(() => seedEmployer(industry))
  const [skewMinutes, setSkewMinutes] = useState(0)

  const touched = useRef(false)
  const counter = useRef(0)

  const seedAll = useCallback((x: Industry) => {
    const members = seedStaff(x.id)
    setBrandState(seedBrand(x))
    setStaff(members)
    setShifts(seedShifts(members, Date.now()))
    setClockState(DEFAULT_CLOCK)
    setEmployerState(seedEmployer(x))
    setSkewMinutes(0)
  }, [])

  // On first show, and when the visitor switches industry before touching anything.
  useEffect(() => {
    if (!touched.current) seedAll(industry)
  }, [industry, seedAll])

  const now = useCallback(() => Date.now() + skewMinutes * 60000, [skewMinutes])

  const setBrand = useCallback((patch: Partial<Brand>) => {
    touched.current = true
    setBrandState((b) => ({ ...b, ...patch }))
  }, [])
  const setClock = useCallback((patch: Partial<ClockSettings>) => {
    touched.current = true
    setClockState((c) => ({ ...c, ...patch }))
  }, [])
  const setEmployer = useCallback((patch: Partial<Employer>) => {
    touched.current = true
    setEmployerState((e) => ({ ...e, ...patch }))
  }, [])

  const saveStaff = useCallback(
    (input: StaffInput, editingId?: string | null): SaveResult => {
      const name = input.name.trim()
      if (!name) return { ok: false, error: "Please enter a name." }

      const pin = input.pin.trim()
      if (pin && !/^\d{4,6}$/.test(pin)) return { ok: false, error: "A clock-in PIN is 4 to 6 digits." }
      const clash = pin ? staff.find((m) => m.pin === pin && m.id !== editingId) : undefined
      if (clash) return { ok: false, error: `That PIN already belongs to ${clash.name}. Pick a different one.` }

      if (input.hourlyRate !== null && (!Number.isFinite(input.hourlyRate) || input.hourlyRate < 0)) {
        return { ok: false, error: "The hourly rate can’t be negative." }
      }
      if (input.idNumber.trim() && input.idNumber.trim().length < 6) {
        return { ok: false, error: "That ID or passport number looks too short." }
      }

      const previous = editingId ? staff.find((m) => m.id === editingId) : undefined
      // Like the real admin: a blank ID / account number means "leave what's saved", typing replaces it.
      const idLast4 = input.idNumber.trim() ? lastChars(input.idNumber.trim(), 4) : (previous?.idNumberLast4 ?? "")
      const acctLast4 = input.bankAccountNumber.trim()
        ? lastChars(input.bankAccountNumber.trim(), 4)
        : (previous?.bankAccountLast4 ?? "")

      const member: StaffMember = {
        id: previous?.id ?? `u${Date.now().toString(36)}${counter.current++}`,
        name,
        jobTitle: input.jobTitle.trim(),
        employeeNumber: input.employeeNumber.trim(),
        startDate: input.startDate,
        hourlyRate: input.hourlyRate,
        pin,
        phone: input.phone.trim(),
        email: input.email.trim(),
        active: previous?.active ?? true,
        idNumberLast4: idLast4,
        taxNumber: input.taxNumber.trim(),
        bankName: input.bankName.trim(),
        bankAccountType: input.bankAccountType,
        bankAccountLast4: acctLast4,
        bankBranchCode: input.bankBranchCode.trim(),
      }
      touched.current = true
      setStaff((list) => (previous ? list.map((m) => (m.id === previous.id ? member : m)) : [...list, member]))
      return { ok: true, name }
    },
    [staff],
  )

  const removeStaff = useCallback((id: string) => {
    touched.current = true
    setStaff((list) => list.filter((m) => m.id !== id))
    setShifts((list) => list.filter((s) => s.staffId !== id))
  }, [])

  const toggleStaff = useCallback((id: string) => {
    touched.current = true
    setStaff((list) => list.map((m) => (m.id === id ? { ...m, active: !m.active } : m)))
  }, [])

  const forceClockOut = useCallback(
    (shiftId: string) => {
      touched.current = true
      const at = now()
      setShifts((list) => list.map((s) => (s.id === shiftId && s.end === null ? { ...s, end: at } : s)))
    },
    [now],
  )

  const punch = useCallback(
    (pin: string): PunchResult => {
      touched.current = true
      const member = staff.find((m) => m.active && m.pin !== "" && m.pin === pin)
      if (!member) return { ok: false }
      const at = now()
      const open = shifts.find((s) => s.staffId === member.id && s.end === null)
      if (open) {
        setShifts((list) => list.map((s) => (s.id === open.id ? { ...s, end: at } : s)))
        return { ok: true, name: member.name, action: "out", at, workedMs: at - open.start }
      }
      setShifts((list) => [...list, { id: `p${at}-${counter.current++}`, staffId: member.id, start: at, end: null }])
      return { ok: true, name: member.name, action: "in", at, workedMs: null }
    },
    [staff, shifts, now],
  )

  const skipAhead = useCallback((minutes: number) => {
    touched.current = true
    setSkewMinutes((m) => m + minutes)
  }, [])

  const reset = useCallback(() => {
    touched.current = false
    seedAll(industry)
  }, [industry, seedAll])

  const value = useMemo<Ctx>(
    () => ({
      industry,
      brand,
      setBrand,
      staff,
      saveStaff,
      removeStaff,
      toggleStaff,
      shifts,
      forceClockOut,
      punch,
      clock,
      setClock,
      employer,
      setEmployer,
      now,
      skewMinutes,
      skipAhead,
      reset,
    }),
    [industry, brand, setBrand, staff, saveStaff, removeStaff, toggleStaff, shifts, forceClockOut, punch, clock, setClock, employer, setEmployer, now, skewMinutes, skipAhead, reset],
  )

  return <SetupCtx.Provider value={value}>{children}</SetupCtx.Provider>
}

