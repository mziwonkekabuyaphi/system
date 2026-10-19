// lib/payroll/payslip-data.ts
//
// Server-only loader for everything a payslip needs. Used by the two
// authenticated route handlers under app/admin/payroll/. Callers MUST have
// already passed requireTenantPermission("payroll.view") and pass the tenantId
// from that check — never one taken from the request. Every query below is
// scoped by that tenantId (this runs on the service-role client, which bypasses
// RLS, so the .eq("tenant_id", …) filters are the actual cross-tenant guard).
//
// Full ID / bank account numbers are read here but are never returned: the
// output carries only the masked ID and the last 4 of the account.

import type { getSupabaseServerClient } from "@/lib/supabase/admin"
import { dateKeyInTz, safeTimezone } from "@/app/admin/tz"
import { last4, maskKeepLast4 } from "./staff-details"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

export interface PayslipData {
  payrollId: string
  staffId: string
  employer: {
    name: string
    tradingName: string | null
    address: string | null
    registrationNumber: string | null
    payeReference: string | null
    uifReference: string | null
    sdlReference: string | null
    phone: string | null
    email: string | null
    /** #RRGGBB */
    accentHex: string
  }
  employee: {
    name: string
    jobTitle: string | null
    employeeNumber: string | null
    /** e.g. "*********1234". Masked on purpose, see payslip-pdf.ts. */
    idNumberMasked: string | null
    taxNumber: string | null
    /** YYYY-MM-DD */
    startDate: string | null
  }
  /** YYYY-MM-DD, inclusive */
  periodStart: string
  periodEnd: string
  /** YYYY-MM-DD in the shop's timezone: the paid date once paid, else the day it was generated. */
  payslipDate: string
  hoursWorked: number
  hourlyRate: number
  grossPay: number
  /** How this payslip was worked out. Rows from before commission existed are 'hourly'. */
  payType: "hourly" | "commission" | "hybrid"
  /** hybrid only. */
  hybridMode: "base_plus_commission" | "higher_of" | null
  /** Hourly part (hours x rate). grossPay = basePay + commissionPay. */
  basePay: number
  /** Commission earned in the period, before any higher-of comparison. */
  commissionEarned: number
  /** The part of commission that is in grossPay (for higher_of: only what exceeds the hourly amount). */
  commissionPay: number
  /** Sum of the list prices commission was calculated on. */
  commissionSales: number
  /** Percentage, e.g. 40 or 12.5. null for hourly. */
  commissionRatePercent: number | null
  servicesCount: number
  paye: number
  uif: number
  totalDeductions: number
  netPay: number
  paymentStatus: "pending" | "paid"
  /** YYYY-MM-DD in the shop's timezone */
  paidDate: string | null
  /** Only populated when the payslip is paid, or the caller explicitly asked for it. */
  bank: { bankName: string | null; accountType: string | null; accountLast4: string | null; branchCode: string | null } | null
}

export type PayslipSelector = { payrollId: string } | { periodStart: string; periodEnd: string }

export type LoadPayslipsResult =
  | { ok: true; payslips: PayslipData[] }
  | { ok: false; status: 404 | 500; error: string }

const HEX = /^#[0-9a-fA-F]{6}$/
const DEFAULT_ACCENT = "#7A2E2E"

export async function loadPayslips(
  supabase: ServerClient,
  tenantId: string,
  selector: PayslipSelector,
  opts: { includeBank: boolean },
): Promise<LoadPayslipsResult> {
  let query = supabase
    .from("staff_payroll")
    .select(
      "id, staff_id, period_start, period_end, hours_worked, hourly_rate, gross_pay, paye, uif, deductions, final_pay, payment_status, paid_at, pay_type, hybrid_mode, base_pay, commission_earned, commission_pay, commission_sales, commission_rate_bps, services_count",
    )
    .eq("tenant_id", tenantId)

  query =
    "payrollId" in selector
      ? query.eq("id", selector.payrollId)
      : query.eq("period_start", selector.periodStart).eq("period_end", selector.periodEnd)

  const { data: rows, error } = await query.order("created_at", { ascending: true })
  if (error) return { ok: false, status: 500, error: error.message }
  if (!rows || rows.length === 0) return { ok: false, status: 404, error: "Payslip not found." }

  const staffIds = [...new Set(rows.map((r: any) => r.staff_id as string))]

  const [staffRes, detailsRes, employerRes, settingsRes, brandingRes, tenantRes] = await Promise.all([
    supabase
      .from("staff")
      .select("id, name, job_title, employee_number, start_date")
      .eq("tenant_id", tenantId)
      .in("id", staffIds),
    supabase
      .from("staff_payroll_details")
      .select("staff_id, id_number, tax_number, bank_name, bank_account_number, bank_branch_code, bank_account_type")
      .eq("tenant_id", tenantId)
      .in("staff_id", staffIds),
    supabase
      .from("tenant_employer_details")
      .select("legal_name, trading_name, registration_number, paye_reference, uif_reference, sdl_reference")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase
      .from("tenant_settings")
      .select("timezone, address, contact_email, contact_phone")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase.from("tenant_branding").select("display_name, primary_color").eq("tenant_id", tenantId).maybeSingle(),
    supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
  ])

  for (const r of [staffRes, detailsRes, employerRes, settingsRes, brandingRes, tenantRes]) {
    if (r.error) return { ok: false, status: 500, error: r.error.message }
  }

  const staffById = new Map<string, any>((staffRes.data ?? []).map((s: any) => [s.id, s]))
  const detailsById = new Map<string, any>((detailsRes.data ?? []).map((d: any) => [d.staff_id, d]))

  const employer = employerRes.data
  const tz = safeTimezone(settingsRes.data?.timezone)
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null)

  const legalName = clean(employer?.legal_name)
  const tradingName = clean(employer?.trading_name)
  const displayName = clean(brandingRes.data?.display_name) ?? clean(tenantRes.data?.name)
  const employerName = legalName ?? tradingName ?? displayName ?? "Employer"
  const accent = brandingRes.data?.primary_color && HEX.test(brandingRes.data.primary_color)
    ? brandingRes.data.primary_color
    : DEFAULT_ACCENT

  const today = dateKeyInTz(new Date(), tz)

  const payslips: PayslipData[] = rows.map((r: any) => {
    const staff = staffById.get(r.staff_id)
    const d = detailsById.get(r.staff_id)
    const paid = r.payment_status === "paid"
    const showBank = paid || opts.includeBank
    const hasBank = d && (d.bank_name || d.bank_account_number)

    return {
      payrollId: r.id,
      staffId: r.staff_id,
      employer: {
        name: employerName,
        // Only show a trading name when it adds something to the legal name.
        tradingName: legalName && tradingName && tradingName !== legalName ? tradingName : null,
        address: clean(settingsRes.data?.address),
        registrationNumber: clean(employer?.registration_number),
        payeReference: clean(employer?.paye_reference),
        uifReference: clean(employer?.uif_reference),
        sdlReference: clean(employer?.sdl_reference),
        phone: clean(settingsRes.data?.contact_phone),
        email: clean(settingsRes.data?.contact_email),
        accentHex: accent,
      },
      employee: {
        name: staff?.name ?? "Unknown staff",
        jobTitle: clean(staff?.job_title),
        employeeNumber: clean(staff?.employee_number),
        idNumberMasked: maskKeepLast4(d?.id_number),
        taxNumber: clean(d?.tax_number),
        startDate: staff?.start_date ?? null,
      },
      periodStart: r.period_start,
      periodEnd: r.period_end,
      payslipDate: paid && r.paid_at ? dateKeyInTz(r.paid_at, tz) : today,
      hoursWorked: Number(r.hours_worked),
      hourlyRate: Number(r.hourly_rate),
      grossPay: Number(r.gross_pay),
      payType: (r.pay_type ?? "hourly") as PayslipData["payType"],
      hybridMode: (r.hybrid_mode ?? null) as PayslipData["hybridMode"],
      basePay: Number(r.base_pay ?? 0),
      commissionEarned: Number(r.commission_earned ?? 0),
      commissionPay: Number(r.commission_pay ?? 0),
      commissionSales: Number(r.commission_sales ?? 0),
      commissionRatePercent: r.commission_rate_bps == null ? null : Number(r.commission_rate_bps) / 100,
      servicesCount: Number(r.services_count ?? 0),
      paye: Number(r.paye),
      uif: Number(r.uif),
      totalDeductions: Number(r.deductions),
      netPay: Number(r.final_pay),
      paymentStatus: paid ? "paid" : "pending",
      paidDate: paid && r.paid_at ? dateKeyInTz(r.paid_at, tz) : null,
      bank:
        showBank && hasBank
          ? {
              bankName: clean(d.bank_name),
              accountType: clean(d.bank_account_type),
              accountLast4: last4(d.bank_account_number),
              branchCode: clean(d.bank_branch_code),
            }
          : null,
    }
  })

  return { ok: true, payslips }
}

/** Best-effort audit row (same table/shape as logActivity() in actions.ts, which
 *  is a private helper of a "use server" file and can't be imported here).
 *  Never includes amounts or ID/bank numbers. Failure is logged, never thrown. */
export async function logPayslipDownload(
  supabase: ServerClient,
  tenantId: string,
  actorProfileId: string,
  action: string,
  staffId?: string | null,
): Promise<void> {
  const { error } = await supabase.from("staff_activity_logs").insert([
    {
      tenant_id: tenantId,
      staff_id: staffId ?? null,
      actor_profile_id: actorProfileId,
      category: "payroll",
      action,
    },
  ])
  if (error) console.error(`Failed to log activity (payroll): ${error.message}`)
}
