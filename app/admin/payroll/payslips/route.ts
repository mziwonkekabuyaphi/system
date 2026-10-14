// app/admin/payroll/payslips/route.ts
//
// GET /admin/payroll/payslips?start=YYYY-MM-DD&end=YYYY-MM-DD[&bank=1]
//   -> every calculated payslip for that exact period as ONE multi-page PDF
//      (one A4 page per employee).
//
// Same auth as the single-payslip route: payroll.view re-checked server-side,
// every query scoped by the signed-in user's own tenantId.

import { NextResponse } from "next/server"
import { loadPayslips, logPayslipDownload } from "@/lib/payroll/payslip-data"
import { allPayslipsFilename, renderPayslipsPdf } from "@/lib/payroll/payslip-pdf"
import { DATE_RE, authorizePayslipRequest, pdfResponse } from "@/lib/payroll/payslip-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await authorizePayslipRequest()
  if (!auth.ok) return auth.response

  const sp = new URL(request.url).searchParams
  const start = sp.get("start") ?? ""
  const end = sp.get("end") ?? ""
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || end < start) {
    return NextResponse.json({ error: "Provide a valid start and end date." }, { status: 400 })
  }
  const includeBank = sp.get("bank") === "1"

  const result = await loadPayslips(auth.supabase, auth.tenantId, { periodStart: start, periodEnd: end }, { includeBank })
  if (!result.ok) {
    if (result.status === 500) console.error("[payslips] load failed", result.error)
    return NextResponse.json(
      { error: result.status === 404 ? "No payslips for that period. Calculate payroll first." : "Couldn't generate the payslips." },
      { status: result.status },
    )
  }

  try {
    const bytes = await renderPayslipsPdf(result.payslips, `Payslips ${start} to ${end}`)
    await logPayslipDownload(
      auth.supabase,
      auth.tenantId,
      auth.userId,
      `Downloaded all payslips for ${start} to ${end} (${result.payslips.length} staff)`,
    )
    return pdfResponse(bytes, allPayslipsFilename(start, end))
  } catch (err) {
    console.error("[payslips] render failed", err)
    return NextResponse.json({ error: "Couldn't generate the payslips." }, { status: 500 })
  }
}
