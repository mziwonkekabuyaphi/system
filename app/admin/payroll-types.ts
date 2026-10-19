// app/admin/payroll-types.ts
//
// Types for the Payroll feature. Kept in their own file so app/admin/types.ts
// does not need to change. The `declare module "./types"` block below adds the
// new optional fields to the existing AdminStaff and AdminStaffInput
// interfaces (TypeScript merges them), so every file that already imports
// those types sees the new fields automatically.

export type AdminBankAccountType = "cheque" | "savings" | "transmission"

/** What a payroll.view caller sees of staff_payroll_details. */
export interface AdminStaffPayrollDetails {
  /** Last 4 characters of the SA ID / passport number. */
  idNumberLast4: string | null
  /** SARS income tax reference (not masked: payroll.view callers also see it on payslips). */
  taxNumber: string | null
  bankName: string | null
  /** Last 4 digits of the bank account number. */
  bankAccountLast4: string | null
  bankBranchCode: string | null
  bankAccountType: AdminBankAccountType | null
}

/** Write shape for staff_payroll_details. Per field: `undefined` = leave
 *  unchanged, `null` (or "") = clear, string = set. idNumber and
 *  bankAccountNumber are never sent back to the browser (only their last 4),
 *  so the edit form leaves them `undefined` unless the admin types a new one. */
export interface AdminStaffPayrollDetailsInput {
  idNumber?: string | null
  taxNumber?: string | null
  bankName?: string | null
  bankAccountNumber?: string | null
  bankBranchCode?: string | null
  bankAccountType?: AdminBankAccountType | null
}

/** A shift still open (status 'active') whose clock-in falls inside the
 *  selected pay period. calculatePayroll() only counts 'completed' shifts, so
 *  these hours are NOT in the pay until the shift is clocked out. */
export interface AdminPayrollOpenShift {
  staffName: string
  /** ISO timestamp */
  loginTime: string
}

/** tenant_employer_details, one row per tenant (settings.manage to write,
 *  payroll.view or settings.manage to read). Address / phone / email on the
 *  payslip come from tenant_settings, not from here. */
export interface AdminEmployerDetails {
  legalName: string | null
  tradingName: string | null
  /** CIPC company / CC registration number. */
  registrationNumber: string | null
  /** SARS PAYE (employer) reference number. */
  payeReference: string | null
  /** Department of Employment and Labour UIF reference number. */
  uifReference: string | null
  /** Skills Development Levy reference number. */
  sdlReference: string | null
}


// ---------------------------------------------------------------------------
// Pay type: hourly (default), commission, or hybrid. Stored in
// staff_pay_profiles; no row means hourly, so nobody changes until an admin
// switches them.
// ---------------------------------------------------------------------------

export type AdminPayType = "hourly" | "commission" | "hybrid"

/** hybrid only. base_plus_commission = hourly pay AND commission on top.
 *  higher_of = whichever is bigger for the period (a guaranteed minimum). */
export type AdminHybridMode = "base_plus_commission" | "higher_of"

/** What a payroll.view caller sees. Commission is a percentage of the list
 *  price of the services the person delivered (e.g. 40 = 40%). */
export interface AdminStaffPayProfile {
  payType: AdminPayType
  /** 0-100, up to 2 decimals. null for hourly. */
  commissionRatePercent: number | null
  hybridMode: AdminHybridMode
}

/** Write shape; sent only with payroll.manage, and only when it changed. */
export interface AdminStaffPayProfileInput {
  payType: AdminPayType
  /** Required (0-100) for commission and hybrid, ignored for hourly. */
  commissionRatePercent?: number | null
  /** Only used for hybrid. Defaults to base_plus_commission. */
  hybridMode?: AdminHybridMode
}

/** Finished walk-ins nobody was credited for in the selected period. Only
 *  counted once the shop has someone on commission or hybrid. */
export interface AdminPayrollUnattributed {
  count: number
}

declare module "./types" {
  interface AdminStaff {
    /** Non-sensitive HR fields (staff.view may read them). */
    employeeNumber?: string | null
    /** ISO date (YYYY-MM-DD). */
    startDate?: string | null
    /** Present ONLY when the caller has payroll.view, same present-or-absent
     *  rule as hourlyRate: getAllStaff() adds this key conditionally, so a
     *  staff.view-only caller never receives it, not even as null. ID and bank
     *  account numbers are masked to their last 4 characters before they leave
     *  the server. */
    payrollDetails?: AdminStaffPayrollDetails
  }

  interface AdminStaffInput {
    /** Optional, staff.manage level. Omitted = leave unchanged; "" = clear. */
    employeeNumber?: string
    /** YYYY-MM-DD, or "" to clear. Omitted = leave unchanged. */
    startDate?: string
    /** Gated exactly like hourlyRate: setting ANY of it needs payroll.manage in
     *  addition to staff.manage. Omit the key entirely when the signed-in user
     *  lacks payroll.manage. */
    payrollDetails?: AdminStaffPayrollDetailsInput
    /** How this person is paid. Gated exactly like hourlyRate: setting it needs
     *  payroll.manage in addition to staff.manage. Omit the key when unchanged. */
    payProfile?: AdminStaffPayProfileInput
  }

  /** Commission fields on a payslip row. Optional so older rows and code that
   *  builds an AdminPayrollRecord keep compiling; read with ?? defaults.
   *  grossPay = basePay + commissionPay. */
  interface AdminPayrollRecord {
    payType?: AdminPayType
    hybridMode?: AdminHybridMode | null
    /** Hourly part (hours x rate). 0 for commission-only. */
    basePay?: number
    /** Commission earned in the period, before any higher-of comparison. */
    commissionEarned?: number
    /** The part of commission included in gross (for higher_of, only what
     *  exceeds the hourly amount). */
    commissionPay?: number
    /** Sum of list prices of the services commission was calculated on. */
    commissionSales?: number
    /** Rate in force when this was calculated, as a percentage. */
    commissionRatePercent?: number | null
    servicesCount?: number
  }
}
