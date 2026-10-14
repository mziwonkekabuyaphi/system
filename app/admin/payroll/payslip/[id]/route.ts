// app/admin/payroll/payslip/[id]/route.ts
//
// GET /admin/payroll/payslip/<staff_payroll.id>[?bank=1]  ->  one payslip PDF.
//
// A route handler is NOT covered by app/admin/layout.tsx, so this does its own
// auth: payroll.view is re-checked server-side and the payslip is looked up by
// (id AND the signed-in user's tenantId), so another shop's id returns 404
// exactly like a non-existent one.
//
// ?bank=1 adds the bank line (last 4 digits only) to a payslip that isn't paid
// yet; once paid it's always included.

import { NextResponse } from "next/server"
import { loadPayslips, logPayslipDownload } from "@/lib/payroll/payslip-data"
import { payslipFilename, renderPayslipsPdf } from "@/lib/payroll/payslip-pdf"
import { UUID_RE, authorizePayslipRequest, pdfResponse } from "@/lib/payroll/payslip-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePayslipRequest()
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Payslip not found." }, { status: 404 })

  const includeBank = new URL(request.url).searchParams.get("bank") === "1"

  const result = await loadPayslips(auth.supabase, auth.tenantId, { payrollId: id }, { includeBank })
  if (!result.ok) {
    if (result.status === 500) console.error("[payslip] load failed", result.error)
    return NextResponse.json(
      { error: result.status === 404 ? "Payslip not found." : "Couldn't generate the payslip." },
      { status: result.status },
    )
  }

  const payslip = result.payslips[0]
  try {
    const bytes = await renderPayslipsPdf(
      [payslip],
      `Payslip ${payslip.employee.name} ${payslip.periodStart} to ${payslip.periodEnd}`,
    )
    await logPayslipDownload(auth.supabase, auth.tenantId, auth.userId, "Downloaded a payslip", payslip.staffId)
    return pdfResponse(bytes, payslipFilename(payslip.employee.name, payslip.periodStart, payslip.periodEnd))
  } catch (err) {
    console.error("[payslip] render failed", err)
    return NextResponse.json({ error: "Couldn't generate the payslip." }, { status: 500 })
  }
}
