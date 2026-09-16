// lib/payroll/paye.ts
//
// South African PAYE + UIF estimate for a single pay period, ported from
// the standalone shop's staff-admin.js (same brackets, same annualisation
// method) — see that file's SARS_BRACKETS_2026_27 comment for the
// original. Kept as a pure, side-effect-free module so both the payroll
// Server Action (calculatePayroll) and the payslip PDF generator
// (lib/payroll/payslip-pdf.ts) import the exact same numbers instead of
// each hand-rolling their own.
//
// NOTE: this is an estimate for payslip purposes using the standard
// annualisation method for irregular/period-based pay. It assumes a
// single, under-65 taxpayer with no medical aid or retirement
// deductions. Confirm final liabilities with SARS / an accountant — this
// is not a certified payroll/tax filing calculation.

export const SARS_TAX_YEAR = "2026/27"

const SARS_BRACKETS_2026_27 = [
  { upto: 245_100, rate: 0.18 },
  { upto: 383_100, rate: 0.26 },
  { upto: 530_200, rate: 0.31 },
  { upto: 695_800, rate: 0.36 },
  { upto: 887_000, rate: 0.39 },
  { upto: 1_878_600, rate: 0.41 },
  { upto: Infinity, rate: 0.45 },
] as const

const SARS_PRIMARY_REBATE_2026_27 = 17_820
const UIF_RATE = 0.01
// Employee-side UIF, capped at 1% of the R17,712/month remuneration ceiling.
const UIF_MONTHLY_CAP = 177.12

function calcAnnualPAYE(annualTaxable: number): number {
  let tax = 0
  let floor = 0
  for (const bracket of SARS_BRACKETS_2026_27) {
    if (annualTaxable <= floor) break
    const inBracket = Math.min(annualTaxable, bracket.upto) - floor
    tax += inBracket * bracket.rate
    floor = bracket.upto
  }
  return Math.max(tax - SARS_PRIMARY_REBATE_2026_27, 0)
}

export interface PeriodDeductions {
  paye: number
  uif: number
  total: number
}

/**
 * Estimates PAYE + UIF for a single pay period by annualising the
 * period's gross pay, taxing the annual equivalent, then bringing the tax
 * back down to the period. periodDays is inclusive of both endpoints
 * (e.g. a full calendar month is ~28-31, not 27-30).
 */
export function calculatePeriodDeductions(grossForPeriod: number, periodDays: number): PeriodDeductions {
  const days = Math.max(periodDays, 1)
  const annualEquivalent = (grossForPeriod / days) * 365
  const annualPAYE = calcAnnualPAYE(annualEquivalent)
  const periodPAYE = annualPAYE * (days / 365)
  const uifCapForPeriod = UIF_MONTHLY_CAP * (days / 30)
  const periodUIF = Math.min(grossForPeriod * UIF_RATE, uifCapForPeriod)
  return { paye: periodPAYE, uif: periodUIF, total: periodPAYE + periodUIF }
}

/** Inclusive day count between two YYYY-MM-DD date strings. */
export function inclusiveDayCount(startDateISO: string, endDateISO: string): number {
  const start = new Date(`${startDateISO}T00:00:00Z`)
  const end = new Date(`${endDateISO}T00:00:00Z`)
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1)
}
