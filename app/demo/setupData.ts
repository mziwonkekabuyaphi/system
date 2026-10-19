// app/demo/setupData.ts
//
// Types, starting data and small helpers for the "set it up yourself" demo
// (SetupDemo.tsx). Everything here is made up. Nothing is saved or sent anywhere.
//
// PAYROLL MATHS: the figures below are SARS's 2026/27 tax year (1 March 2026 to
// 28 February 2027), from the SARS "Guide for Employers in Respect of Employees' Tax (2027)".
// They change every March, so update TAX_YEAR_LABEL, BRACKETS and PRIMARY_REBATE then.
// This is an ESTIMATE for the demo (weekly pay annualised, primary rebate only: no
// medical credits, retirement fund or age rebates). The real payroll module is what
// a shop should rely on.

import type { Industry, IndustryId } from "./industries"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Brand = {
  name: string
  /** A data: URL from a file the visitor picked, or null. Never leaves the browser. */
  logo: string | null
  primary: string
  secondary: string
  customSidebar: boolean
  sidebarColor: string
  sidebarText: string
  accent: string
  removePoweredBy: boolean
}

export type BankAccountType = "" | "cheque" | "savings" | "transmission"

export type StaffMember = {
  id: string
  name: string
  jobTitle: string
  employeeNumber: string
  startDate: string
  hourlyRate: number | null
  pin: string
  phone: string
  email: string
  active: boolean
  /** Like the real admin, only the last 4 characters are ever kept. */
  idNumberLast4: string
  taxNumber: string
  bankName: string
  bankAccountType: BankAccountType
  bankAccountLast4: string
  bankBranchCode: string
}

export type StaffInput = {
  name: string
  jobTitle: string
  employeeNumber: string
  startDate: string
  hourlyRate: number | null
  pin: string
  phone: string
  email: string
  idNumber: string
  taxNumber: string
  bankName: string
  bankAccountType: BankAccountType
  bankAccountNumber: string
  bankBranchCode: string
}

export type Shift = { id: string; staffId: string; start: number; end: number | null }

export type ClockTheme = "dark" | "light" | "custom"
export type ClockSettings = {
  theme: ClockTheme
  backgroundColor: string
  tagline: string
  title: string
  prompt: string
  clockedInLabel: string
  clockedOutLabel: string
  invalidPinText: string
}

export type Employer = {
  legalName: string
  tradingName: string
  registrationNumber: string
  payeReference: string
  uifReference: string
  sdlReference: string
}

export type PunchResult =
  | { ok: true; name: string; action: "in" | "out"; at: number; workedMs: number | null }
  | { ok: false }

// Same defaults as the real clock pad (see DEFAULT_* in ClockPanels.tsx).
export const CLOCK_DEFAULTS = {
  title: "Clock in",
  prompt: "Enter your PIN to clock in or out",
  clockedInLabel: "Clocked in",
  clockedOutLabel: "Clocked out",
  invalidPinText: "PIN not recognized. Please try again.",
}

export const DEFAULT_CLOCK: ClockSettings = {
  theme: "dark",
  backgroundColor: "#15110d",
  tagline: "",
  title: "",
  prompt: "",
  clockedInLabel: "",
  clockedOutLabel: "",
  invalidPinText: "",
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** "#abc" or "#AABBCC" -> "#aabbcc". Returns null when it isn't a hex colour. */
export function normaliseHex(value: string): string | null {
  const v = value.trim()
  if (!HEX.test(v)) return null
  const c = v.slice(1).toLowerCase()
  return `#${c.length === 3 ? c.split("").map((x) => x + x).join("") : c}`
}

function luminance(hex: string): number {
  const h = normaliseHex(hex) ?? "#000000"
  const channel = (i: number) => {
    const v = parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Dark or light text, whichever reads better on this background. */
export function readableTextOn(bg: string): string {
  return contrast(bg, "#ffffff") >= contrast(bg, "#14181f") ? "#ffffff" : "#14181f"
}

/** The first colour that is readable against `bg`, so a brand colour never vanishes into it. */
export function visibleOn(bg: string, ...candidates: string[]): string {
  const ok = candidates.find((c) => contrast(c, bg) >= 3)
  return ok ?? readableTextOn(bg)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function money(n: number): string {
  return `R${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

export function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

export function fmtDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h === 0 ? `${m}m` : `${h}h ${m}m`
}

// ---------------------------------------------------------------------------
// Payroll maths (see the note at the top of this file)
// ---------------------------------------------------------------------------

export const TAX_YEAR_LABEL = "2026/27"
export const PRIMARY_REBATE = 17820
const BRACKETS = [
  { from: 0, rate: 0.18, base: 0 },
  { from: 245100, rate: 0.26, base: 44118 },
  { from: 383100, rate: 0.31, base: 79998 },
  { from: 530200, rate: 0.36, base: 125599 },
  { from: 695800, rate: 0.39, base: 185215 },
  { from: 887000, rate: 0.41, base: 259783 },
  { from: 1878600, rate: 0.45, base: 666339 },
]
const UIF_RATE = 0.01
/** UIF is only charged on the first R17,712 of a month's pay. */
const UIF_MONTHLY_CEILING = 17712
const PERIODS_PER_YEAR = 52 // the demo pays weekly
export const PAY_PERIOD_DAYS = 7

function annualTax(income: number): number {
  if (income <= 0) return 0
  for (let i = BRACKETS.length - 1; i >= 0; i--) {
    const b = BRACKETS[i]
    if (income > b.from) return b.base + (income - b.from) * b.rate
  }
  return 0
}

export type PayFigures = { gross: number; paye: number; uif: number; net: number; employerUif: number }

export function payFigures(hours: number, rate: number | null): PayFigures {
  const gross = round2(hours * (rate ?? 0))
  const annual = gross * PERIODS_PER_YEAR
  const paye = round2(Math.max(0, annualTax(annual) - PRIMARY_REBATE) / PERIODS_PER_YEAR)
  const ceiling = (UIF_MONTHLY_CEILING * 12) / PERIODS_PER_YEAR
  const uif = round2(Math.min(gross, ceiling) * UIF_RATE)
  return { gross, paye, uif, net: round2(gross - paye - uif), employerUif: uif }
}

// ---------------------------------------------------------------------------
// Starting data
// ---------------------------------------------------------------------------

export function seedBrand(x: Industry): Brand {
  const primary = normaliseHex(x.brand?.main ?? "") ?? "#14325c"
  const secondary = normaliseHex(x.brand?.accent ?? "") ?? "#f5a524"
  return {
    name: x.shop,
    logo: null,
    primary,
    secondary,
    customSidebar: false,
    sidebarColor: primary,
    sidebarText: readableTextOn(primary),
    accent: secondary,
    removePoweredBy: false,
  }
}

export function seedEmployer(x: Industry): Employer {
  return {
    legalName: `${x.shop} (Pty) Ltd`,
    tradingName: "",
    registrationNumber: "2019/123456/07",
    payeReference: "7123456789",
    uifReference: "U12345678",
    sdlReference: "L123456789",
  }
}

const TITLES: Record<IndustryId, [string, string, string]> = {
  barber: ["Senior barber", "Barber", "Apprentice barber"],
  beauty: ["Nail technician", "Beauty therapist", "Receptionist"],
  clinic: ["Nurse", "Receptionist", "Phlebotomist"],
  workshop: ["Technician", "Tyre fitter", "Service advisor"],
  vet: ["Vet nurse", "Receptionist", "Groomer"],
  retail: ["Store manager", "Sales assistant", "Stylist"],
  events: ["Event coordinator", "Registration host", "Floor steward"],
  restaurant: ["Head waiter", "Host", "Kitchen assistant"],
  pharmacy: ["Pharmacist", "Dispensing assistant", "Cashier"],
}

/** Used if an industry is ever added without its own job titles, so the page can't crash. */
const DEFAULT_TITLES: [string, string, string] = ["Manager", "Team member", "Trainee"]

export function seedStaff(id: IndustryId): StaffMember[] {
  const [t1, t2, t3] = TITLES[id] ?? DEFAULT_TITLES
  const base = { phone: "", email: "", active: true, taxNumber: "", bankBranchCode: "" }
  return [
    { ...base, id: "s1", name: "Thabo Mokoena", jobTitle: t1, employeeNumber: "001", startDate: "2023-02-01", hourlyRate: 135, pin: "1234", phone: "082 123 4567", idNumberLast4: "0083", bankName: "Capitec", bankAccountType: "savings", bankAccountLast4: "4821", bankBranchCode: "470010", taxNumber: "9876543210" },
    { ...base, id: "s2", name: "Lerato Dlamini", jobTitle: t2, employeeNumber: "002", startDate: "2024-06-10", hourlyRate: 120, pin: "5678", idNumberLast4: "0187", bankName: "FNB", bankAccountType: "cheque", bankAccountLast4: "7730", bankBranchCode: "250655" },
    { ...base, id: "s3", name: "Sipho Nkosi", jobTitle: t3, employeeNumber: "003", startDate: "2025-09-01", hourlyRate: 95, pin: "4321", idNumberLast4: "", bankName: "", bankAccountType: "", bankAccountLast4: "" },
  ]
}

/** A week of finished shifts so the payroll has something to add up on first load. */
export function seedShifts(staff: StaffMember[], nowMs: number): Shift[] {
  const out: Shift[] = []
  const midnight = new Date(nowMs)
  midnight.setHours(0, 0, 0, 0)
  staff.forEach((member, i) => {
    for (let d = 1; d <= 5; d++) {
      if (i === 2 && d === 3) continue // one day off, so the three people don't all match
      const start = midnight.getTime() - d * 86400000 + (8 * 60 + ((i * 17 + d * 11) % 25)) * 60000
      const hours = 8 + ((i + d) % 3) * 0.25
      out.push({ id: `seed-${member.id}-${d}`, staffId: member.id, start, end: start + hours * 3600000 })
    }
  })
  return out
}
