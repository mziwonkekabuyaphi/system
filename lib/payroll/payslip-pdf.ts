// lib/payroll/payslip-pdf.ts
//
// Client-side payslip PDF, ported from the standalone app's downloadPayslipPDF
// (jsPDF, unit 'pt', A4) — same layout (header → staff/period block →
// hours/rate → gross → PAYE/UIF deductions → net → disclaimer footer),
// re-themed to this app's cream/wine palette and fed from tenant_branding/
// tenant_settings instead of a single hardcoded venue_settings row.
//
// Runs entirely in the browser (a "Download PDF" button's onClick), same
// as the old app — no server round trip, no PDF stored anywhere. The
// caller (PayrollManager.tsx) is responsible for only ever invoking this
// from a payroll.view-gated render path, since `record` carries gross
// pay / PAYE / UIF / net figures.
//
// jsPDF is loaded lazily (dynamic import) so it's not in the main admin
// bundle for users who never open the Payroll tab.

import type { AdminPayrollRecord } from "@/app/admin/types"

export interface PayslipBranding {
  businessName: string
  logoUrl: string | null
  primaryColor: string
  address: string | null
  contactEmail: string | null
  contactPhone: string | null
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "")
  const bigint = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16)
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255]
}

function fmtR(value: number): string {
  return `R${(value || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" })
}

/** Loads the tenant's logo as a data URL for embedding — jsPDF needs the
 *  image bytes, not a remote URL, and doing this fetch at generation time
 *  (rather than baking a logo in) is what lets this work for any tenant's
 *  branding instead of one hardcoded venue. Falls back to no logo (a
 *  text-only header) if the fetch fails, rather than failing the whole
 *  download — a missing logo shouldn't block someone getting their payslip. */
async function loadLogoDataUrl(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null
  try {
    const res = await fetch(logoUrl)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export async function downloadPayslipPDF(record: AdminPayrollRecord, branding: PayslipBranding): Promise<void> {
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 48
  const [pr, pg, pb] = hexToRgb(branding.primaryColor || "#2B6F5C")
  const ink: [number, number, number] = [28, 26, 23] // #1C1A17
  const muted: [number, number, number] = [138, 131, 117] // #8A8375

  let y = margin

  // ---- Header: logo (if available) + business name + payslip title ----
  const logoDataUrl = await loadLogoDataUrl(branding.logoUrl)
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "PNG", margin, y, 40, 40)
    } catch {
      // Unsupported format or corrupt data — fall through to text-only header.
    }
  }
  const headerTextX = logoDataUrl ? margin + 52 : margin
  doc.setFont("helvetica", "bold")
  doc.setFontSize(16)
  doc.setTextColor(...ink)
  doc.text(branding.businessName, headerTextX, y + 16)

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  const contactLine = [branding.address, branding.contactPhone, branding.contactEmail].filter(Boolean).join("  ·  ")
  if (contactLine) doc.text(contactLine, headerTextX, y + 30)

  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.setTextColor(pr, pg, pb)
  doc.text("PAYSLIP", pageWidth - margin, y + 16, { align: "right" })

  y += 64
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  doc.line(margin, y, pageWidth - margin, y)
  y += 24

  // ---- Staff + period block ----
  doc.setFont("helvetica", "bold")
  doc.setFontSize(12)
  doc.setTextColor(...ink)
  doc.text(record.staffName, margin, y)
  if (record.jobTitle) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text(record.jobTitle, margin, y + 14)
  }
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Pay period: ${fmtDate(record.periodStart)} – ${fmtDate(record.periodEnd)}`, pageWidth - margin, y, {
    align: "right",
  })
  doc.text(`Status: ${record.paymentStatus === "paid" ? "Paid" : "Pending"}`, pageWidth - margin, y + 14, {
    align: "right",
  })

  y += 44

  // ---- Line items ----
  const row = (label: string, sub: string, value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.setFontSize(10)
    doc.setTextColor(...ink)
    doc.text(label, margin, y)
    if (sub) {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(...muted)
      doc.text(sub, margin, y + 11)
    }
    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.setFontSize(10)
    doc.setTextColor(...ink)
    doc.text(value, pageWidth - margin, y, { align: "right" })
    y += sub ? 26 : 20
  }

  row("Hours worked", "", `${record.hoursWorked.toFixed(1)} hrs @ ${fmtR(record.hourlyRate)}/hr`)
  row("Gross pay", "", fmtR(record.grossPay), true)

  y += 6
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.25)
  doc.line(margin, y, pageWidth - margin, y)
  y += 20

  row("PAYE (est.)", "Per SARS 2026/27 brackets, annualised method", `– ${fmtR(record.paye)}`)
  row("UIF (employee, 1%)", "Capped per SARS earnings ceiling", `– ${fmtR(record.uif)}`)

  y += 6
  doc.setDrawColor(pr, pg, pb)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)
  y += 22

  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.setTextColor(pr, pg, pb)
  doc.text("Net pay", margin, y)
  doc.text(fmtR(record.finalPay), pageWidth - margin, y, { align: "right" })

  y += 40

  // ---- Footer disclaimer ----
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  const disclaimer =
    "PAYE estimated using SARS 2026/27 tax brackets (standard annualisation method for period-based pay); " +
    "UIF at 1%, capped per the monthly remuneration ceiling. This assumes a single, under-65 taxpayer with no " +
    "medical aid or retirement deductions. Confirm final liabilities with SARS or your accountant before final submission."
  const wrapped = doc.splitTextToSize(disclaimer, pageWidth - margin * 2)
  doc.text(wrapped, margin, y)

  const safeName = record.staffName.replace(/[^a-z0-9]+/gi, "_")
  doc.save(`payslip_${safeName}_${record.periodStart}_to_${record.periodEnd}.pdf`)
}
