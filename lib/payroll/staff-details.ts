// lib/payroll/staff-details.ts
//
// Pure helpers for the sensitive staff payroll fields (staff_payroll_details):
// normalisation, validation and masking. Shared by the staff Server Actions
// (app/admin/actions.ts) and the payslip generator so both apply the same
// rules. No I/O, no imports.
//
// Validation is deliberately a typo-catcher, not an authority: the SARS
// income-tax reference, SA ID and bank formats below are the common shapes,
// but anything that fails here is rejected, so keep them conservative.

import type { AdminBankAccountType } from "@/app/admin/payroll-types"

export const BANK_ACCOUNT_TYPES: AdminBankAccountType[] = ["cheque", "savings", "transmission"]

/** Last 4 characters of a number, or null if empty. The full value must never
 *  be sent to the browser or written to a log; this is what's allowed instead. */
export function last4(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.replace(/\s+/g, "")
  if (!v) return null
  return v.slice(-4)
}

/** "*********1234" — for payslips / any display. Pads so the length hints at a 13-digit ID. */
export function maskKeepLast4(value: string | null | undefined, totalLength = 13): string | null {
  const tail = last4(value)
  if (!tail) return null
  return "*".repeat(Math.max(totalLength - tail.length, 0)) + tail
}

/** Luhn check, as used by the 13-digit South African ID number. */
function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function validDateParts(yy: number, mm: number, dd: number): boolean {
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false
  // Century is ambiguous in an SA ID; the day only has to exist in some century.
  for (const century of [1900, 2000]) {
    const d = new Date(Date.UTC(century + yy, mm - 1, dd))
    if (d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd) return true
  }
  return false
}

export type NormalizeResult = { ok: true; value: string | null } | { ok: false; error: string }

/** SA ID (13 digits, valid date + Luhn) OR a passport number (5-20 letters/digits). */
export function normalizeIdNumber(raw: string): NormalizeResult {
  const v = raw.replace(/[\s-]+/g, "").toUpperCase()
  if (!v) return { ok: true, value: null }
  if (/^\d{13}$/.test(v)) {
    const ok = validDateParts(Number(v.slice(0, 2)), Number(v.slice(2, 4)), Number(v.slice(4, 6))) && luhnValid(v)
    if (!ok) return { ok: false, error: "That ID number doesn't look valid. Check it, or enter a passport number instead." }
    return { ok: true, value: v }
  }
  if (/^[A-Z0-9]{5,20}$/.test(v)) return { ok: true, value: v }
  return { ok: false, error: "Enter a 13-digit South African ID number or a passport number." }
}

/** SARS income tax reference: 10 digits. */
export function normalizeTaxNumber(raw: string): NormalizeResult {
  const v = raw.replace(/[\s-]+/g, "")
  if (!v) return { ok: true, value: null }
  if (!/^\d{10}$/.test(v)) return { ok: false, error: "A SARS income tax number is 10 digits." }
  return { ok: true, value: v }
}

export function normalizeBankAccountNumber(raw: string): NormalizeResult {
  const v = raw.replace(/[\s-]+/g, "")
  if (!v) return { ok: true, value: null }
  if (!/^\d{4,20}$/.test(v)) return { ok: false, error: "A bank account number is digits only (4-20 digits)." }
  return { ok: true, value: v }
}

/** Universal branch codes in SA are 6 digits. */
export function normalizeBranchCode(raw: string): NormalizeResult {
  const v = raw.replace(/[\s-]+/g, "")
  if (!v) return { ok: true, value: null }
  if (!/^\d{6}$/.test(v)) return { ok: false, error: "A branch code is 6 digits." }
  return { ok: true, value: v }
}

export function normalizeShortText(raw: string, label: string, max: number): NormalizeResult {
  const v = raw.trim()
  if (!v) return { ok: true, value: null }
  if (v.length > max) return { ok: false, error: `${label} must be ${max} characters or fewer.` }
  return { ok: true, value: v }
}

/** Accepts "" (= none) or a real calendar date as YYYY-MM-DD. */
export function normalizeIsoDate(raw: string, label: string): NormalizeResult {
  const v = raw.trim()
  if (!v) return { ok: true, value: null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: `${label} must be a valid date.` }
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    return { ok: false, error: `${label} must be a valid date.` }
  }
  return { ok: true, value: v }
}
