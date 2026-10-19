// lib/payroll/payslip-pdf.ts
//
// Server-side payslip PDF (A4, ZAR, South African date format), built with
// pdf-lib (pure JS, no native/canvas dependencies). Replaces the previous
// browser-side jsPDF version: that one ran in the client with the full payroll
// record in the bundle, and `jspdf` was never in package.json. This module is
// only ever called from the authenticated route handlers in
// app/admin/payroll/, after payroll.view has been checked and the data has
// been loaded with tenant-scoped queries (see payslip-data.ts).
//
// Standard Helvetica only (no font files to ship). It can only draw WinAnsi
// characters, so safe() folds accents and swaps anything else for "?" instead
// of letting a stray character throw and fail the whole download.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib"
import { SARS_TAX_YEAR } from "./paye"
import type { PayslipData } from "./payslip-data"

const PAGE_W = 595.28
const PAGE_H = 841.89
const M = 48
const RIGHT = PAGE_W - M

const INK = rgb(0.11, 0.1, 0.09)
const MUTED = rgb(0.54, 0.51, 0.46)
const RULE = rgb(0.85, 0.83, 0.78)

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

// ---- formatting (South African conventions: "R 4 620,00", "14 Oct 2026") ----

const moneyFmt = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const spaces = /[\u00a0\u2009\u202f]/g

export function formatRand(value: number): string {
  return `R ${moneyFmt.format(Number.isFinite(value) ? value : 0)}`.replace(spaces, " ")
}

export function formatHours(value: number): string {
  return moneyFmt.format(Number.isFinite(value) ? value : 0).replace(spaces, " ")
}

/** "2026-10-14" -> "14 Oct 2026" */
export function formatDateKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number)
  if (!y || !m || !d) return key
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-ZA", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })
    .replace(spaces, " ")
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  cheque: "Cheque / current",
  savings: "Savings",
  transmission: "Transmission",
}

// ---- text helpers ----

function makeSafe(font: PDFFont) {
  const supported = new Set(font.getCharacterSet())
  return (input: string): string => {
    let out = ""
    for (const ch of input.replace(/[\r\n\t]+/g, " ").normalize("NFC")) {
      if (supported.has(ch.codePointAt(0)!)) {
        out += ch
        continue
      }
      const folded = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      out += folded && [...folded].every((c) => supported.has(c.codePointAt(0)!)) ? folded : "?"
    }
    return out
  }
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number, maxLines = 6): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate
      else {
        lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
  }
  return lines.slice(0, maxLines)
}

/** One row in the EARNINGS table. hours/rate are only set for hourly-style rows;
 *  amount === null makes it an explanatory note with no figure. */
type EarningsLine = { label: string; sub?: string; hours?: number; rate?: number; amount: number | null }

/** The earnings rows for a payslip, by pay type. Hourly payslips are exactly one
 *  "ordinary hours" row, as before. Commission is described as a percentage of the
 *  list price of the services done in the period. */
export function earningsLines(p: PayslipData): EarningsLine[] {
  const pct = p.commissionRatePercent != null ? `${p.commissionRatePercent}%` : "commission rate"
  const services = `${p.servicesCount} ${p.servicesCount === 1 ? "service" : "services"}`
  const commissionBasis = `${pct} of ${formatRand(p.commissionSales)} service sales (${services})`
  const hourlyRow = (label: string): EarningsLine => ({
    label,
    hours: p.hoursWorked,
    rate: p.hourlyRate,
    amount: p.basePay,
  })

  if (p.payType === "commission") {
    return [{ label: "Commission", sub: commissionBasis, amount: p.commissionPay }]
  }

  if (p.payType === "hybrid") {
    const hasHourly = p.hoursWorked > 0 || p.basePay > 0
    if (p.hybridMode === "higher_of") {
      if (p.commissionPay > 0) {
        return [
          ...(hasHourly ? [hourlyRow("Ordinary hours worked (guaranteed minimum)")] : []),
          {
            label: hasHourly ? "Commission above the guaranteed minimum" : "Commission",
            sub: `${commissionBasis} = ${formatRand(p.commissionEarned)}${hasHourly ? `, less ${formatRand(p.basePay)} hourly pay` : ""}`,
            amount: p.commissionPay,
          },
        ]
      }
      return [
        hourlyRow("Ordinary hours worked (guaranteed minimum)"),
        {
          label: "Commission",
          sub: `${commissionBasis} = ${formatRand(p.commissionEarned)}, which is not more than the hourly amount, so hourly pay applies`,
          amount: null,
        },
      ]
    }
    return [
      ...(hasHourly ? [hourlyRow("Ordinary hours worked")] : []),
      { label: "Commission", sub: commissionBasis, amount: p.commissionPay },
    ]
  }

  return [{ label: "Ordinary hours worked", hours: p.hoursWorked, rate: p.hourlyRate, amount: p.grossPay }]
}

type Fonts = { regular: PDFFont; bold: PDFFont; safeR: (s: string) => string; safeB: (s: string) => string }

function drawPayslip(page: PDFPage, p: PayslipData, f: Fonts, pageNo: number, pageCount: number) {
  const accent = hexToRgb(p.employer.accentHex)

  const text = (
    s: string,
    x: number,
    y: number,
    o: { size?: number; bold?: boolean; color?: RGB; align?: "left" | "right" } = {},
  ) => {
    const font = o.bold ? f.bold : f.regular
    const size = o.size ?? 10
    const str = (o.bold ? f.safeB : f.safeR)(s)
    const w = font.widthOfTextAtSize(str, size)
    page.drawText(str, { x: o.align === "right" ? x - w : x, y, size, font, color: o.color ?? INK })
  }
  const rule = (y: number, color = RULE, thickness = 0.6) =>
    page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness, color })

  // Accent bar across the very top.
  page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: accent })

  // ---- Employer (BCEA s33: employer's name and address) ----
  let ly = PAGE_H - M - 6
  text(p.employer.name, M, ly, { size: 16, bold: true })
  ly -= 15
  if (p.employer.tradingName) {
    text(`t/a ${p.employer.tradingName}`, M, ly, { size: 9, color: MUTED })
    ly -= 12
  }
  if (p.employer.address) {
    for (const line of wrap(p.employer.address, f.regular, 9, 300, 4)) {
      text(line, M, ly, { size: 9, color: MUTED })
      ly -= 12
    }
  }
  const refs = [
    p.employer.registrationNumber && `Reg. no. ${p.employer.registrationNumber}`,
    p.employer.payeReference && `PAYE ref. ${p.employer.payeReference}`,
    p.employer.uifReference && `UIF ref. ${p.employer.uifReference}`,
    p.employer.sdlReference && `SDL ref. ${p.employer.sdlReference}`,
  ].filter(Boolean) as string[]
  if (refs.length) {
    for (const line of wrap(refs.join("   |   "), f.regular, 8.5, 330, 3)) {
      text(line, M, ly, { size: 8.5, color: MUTED })
      ly -= 11.5
    }
  }
  const contact = [p.employer.phone, p.employer.email].filter(Boolean).join("   |   ")
  if (contact) {
    text(contact, M, ly, { size: 8.5, color: MUTED })
    ly -= 11.5
  }

  text("PAYSLIP", RIGHT, PAGE_H - M - 6, { size: 20, bold: true, color: accent, align: "right" })

  let y = Math.min(ly, PAGE_H - M - 30) - 10
  rule(y)
  y -= 22

  // ---- Employee + period blocks ----
  const rowsLeft: Array<[string, string | null]> = [
    ["Employee", p.employee.name],
    ["Occupation", p.employee.jobTitle],
    ["Employee no.", p.employee.employeeNumber],
    // Masked on purpose: payslips get emailed and forwarded. BCEA s33 does not
    // require the ID number on a payslip; the full number stays in the records.
    ["ID / passport no.", p.employee.idNumberMasked],
    ["Income tax no.", p.employee.taxNumber],
    ["Start date", p.employee.startDate ? formatDateKey(p.employee.startDate) : null],
  ]
  const rowsRight: Array<[string, string | null]> = [
    ["Pay period", `${formatDateKey(p.periodStart)} - ${formatDateKey(p.periodEnd)}`],
    ["Payslip date", formatDateKey(p.payslipDate)],
    ["Status", p.paymentStatus === "paid" ? (p.paidDate ? `Paid on ${formatDateKey(p.paidDate)}` : "Paid") : "Pending payment"],
  ]
  const colR = M + 290
  const block = (rows: Array<[string, string | null]>, x: number, valueX: number, startY: number) => {
    let by = startY
    for (const [label, value] of rows) {
      if (!value) continue // omit the line entirely rather than print "null" / blanks
      text(label, x, by, { size: 8.5, color: MUTED })
      text(value, valueX, by, { size: 10, bold: label === "Employee" })
      by -= 16
    }
    return by
  }
  const leftEnd = block(rowsLeft, M, M + 92, y)
  const rightEnd = block(rowsRight, colR, colR + 70, y)
  y = Math.min(leftEnd, rightEnd) - 6
  rule(y)
  y -= 22

  // ---- Earnings ----
  const colHours = 350
  const colRate = 440
  const header = (title: string, withCols: boolean) => {
    page.drawRectangle({ x: M, y: y - 6, width: RIGHT - M, height: 20, color: rgb(0.96, 0.94, 0.9) })
    text(title, M + 8, y, { size: 8.5, bold: true, color: MUTED })
    if (withCols) {
      text("HOURS", colHours, y, { size: 8.5, bold: true, color: MUTED, align: "right" })
      text("RATE", colRate, y, { size: 8.5, bold: true, color: MUTED, align: "right" })
    }
    text("AMOUNT", RIGHT - 8, y, { size: 8.5, bold: true, color: MUTED, align: "right" })
    y -= 24
  }

  const lines = earningsLines(p)
  header("EARNINGS", lines.some((l) => l.hours !== undefined))
  lines.forEach((l, i) => {
    text(l.label, M + 8, y)
    if (l.hours !== undefined) text(formatHours(l.hours), colHours, y, { align: "right" })
    if (l.rate !== undefined) text(`${formatRand(l.rate)} / hr`, colRate, y, { align: "right" })
    if (l.amount !== null) text(formatRand(l.amount), RIGHT - 8, y, { align: "right" })
    y -= 12
    if (l.sub) {
      for (const sub of wrap(l.sub, f.regular, 8.5, RIGHT - M - 16, 3)) {
        text(sub, M + 8, y, { size: 8.5, color: MUTED })
        y -= 11.5
      }
    }
    if (i < lines.length - 1) y -= 6
  })
  rule(y, RULE)
  y -= 16
  text("Gross earnings", M + 8, y, { bold: true })
  text(formatRand(p.grossPay), RIGHT - 8, y, { bold: true, align: "right" })
  y -= 30

  // ---- Deductions (BCEA s33: amount and purpose of each deduction) ----
  header("DEDUCTIONS", false)
  text("PAYE (income tax, estimated)", M + 8, y)
  text(formatRand(p.paye), RIGHT - 8, y, { align: "right" })
  y -= 18
  text("UIF (employee contribution, estimated)", M + 8, y)
  text(formatRand(p.uif), RIGHT - 8, y, { align: "right" })
  y -= 12
  rule(y, RULE)
  y -= 16
  text("Total deductions", M + 8, y, { bold: true })
  text(formatRand(p.totalDeductions), RIGHT - 8, y, { bold: true, align: "right" })
  y -= 30

  // ---- Net pay ----
  page.drawRectangle({ x: M, y: y - 14, width: RIGHT - M, height: 38, color: accent })
  const white = rgb(1, 1, 1)
  text("NET PAY", M + 12, y, { size: 13, bold: true, color: white })
  text(formatRand(p.netPay), RIGHT - 12, y, { size: 15, bold: true, color: white, align: "right" })
  y -= 44

  // ---- Payment ----
  text("PAYMENT", M, y, { size: 8.5, bold: true, color: MUTED })
  y -= 16
  text(
    p.paymentStatus === "paid"
      ? `Paid${p.paidDate ? ` on ${formatDateKey(p.paidDate)}` : ""}`
      : "Not yet marked as paid",
    M,
    y,
  )
  y -= 15
  if (p.bank) {
    const type = p.bank.accountType ? ACCOUNT_TYPE_LABEL[p.bank.accountType] ?? p.bank.accountType : null
    const parts = [
      p.bank.bankName,
      type && `${type} account`,
      p.bank.accountLast4 && `account ending ${p.bank.accountLast4}`,
      p.bank.branchCode && `branch ${p.bank.branchCode}`,
    ].filter(Boolean) as string[]
    if (parts.length) {
      for (const line of wrap(`To: ${parts.join(", ")}`, f.regular, 10, RIGHT - M, 3)) {
        text(line, M, y)
        y -= 14
      }
    }
  }

  // ---- Footer ----
  const disclaimer =
    `PAYE and UIF on this payslip are ESTIMATES calculated by the system using the SARS ${SARS_TAX_YEAR} tax tables ` +
    "(annualised method; single taxpayer under 65; primary rebate only; no medical-aid, retirement-fund or other " +
    "deductions or credits). They are not official SARS figures. Confirm all amounts with your accountant or SARS " +
    "before submitting returns or relying on them."
  let fy = M + 14 + 11 * Math.min(wrap(disclaimer, f.regular, 8, RIGHT - M, 6).length, 6)
  rule(fy + 8)
  for (const line of wrap(disclaimer, f.regular, 8, RIGHT - M, 6)) {
    text(line, M, fy - 4, { size: 8, color: MUTED })
    fy -= 11
  }
  text(`Page ${pageNo} of ${pageCount}`, RIGHT, M - 8, { size: 8, color: MUTED, align: "right" })
}

/** One A4 page per payslip, in the order given. */
export async function renderPayslipsPdf(payslips: PayslipData[], title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const fonts: Fonts = { regular, bold, safeR: makeSafe(regular), safeB: makeSafe(bold) }

  doc.setTitle(fonts.safeR(title))
  doc.setProducer("Payroll")
  doc.setCreator("Payroll")

  payslips.forEach((p, i) => {
    const page = doc.addPage([PAGE_W, PAGE_H])
    drawPayslip(page, p, fonts, i + 1, payslips.length)
  })
  return doc.save()
}

/** "Payslip_Thabo_Nkosi_2026-09-01_to_2026-09-30.pdf": ASCII only so it is
 *  safe in a Content-Disposition header on every browser. */
export function payslipFilename(staffName: string, periodStart: string, periodEnd: string): string {
  const safeName =
    staffName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "Staff"
  return `Payslip_${safeName}_${periodStart}_to_${periodEnd}.pdf`
}

export function allPayslipsFilename(periodStart: string, periodEnd: string): string {
  return `Payslips_${periodStart}_to_${periodEnd}.pdf`
}
