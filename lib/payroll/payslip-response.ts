// lib/payroll/payslip-response.ts
//
// Shared by the two payslip route handlers: the permission gate and the PDF
// response. Layout/rendering lives in payslip-pdf.ts, data in payslip-data.ts.

import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Re-checks payroll.view against the signed-in user's own session (never a
 *  client-supplied tenant or user id) and hands back the tenant-scoped context.
 *  requireTenantMember() inside redirects to /login when there is no session. */
export async function authorizePayslipRequest() {
  const check = await requireTenantPermission("payroll.view")
  if (!check.ok) {
    return { ok: false as const, response: NextResponse.json({ error: check.error }, { status: 403 }) }
  }
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return { ok: false as const, response: NextResponse.json({ error: "Supabase isn't configured." }, { status: 500 }) }
  }
  return { ok: true as const, supabase, tenantId: check.member.tenantId, userId: check.member.userId }
}

export function pdfResponse(bytes: Uint8Array, filename: string) {
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // Filenames are ASCII-only (see payslipFilename), so this is header-safe.
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Payslips are personal financial data: never cache them anywhere.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
