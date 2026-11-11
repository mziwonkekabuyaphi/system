// app/admin/passport/passport-types.ts
//
// Shared types for the Passport (customer wallet) admin. Plain data only: this file is imported by
// both the server actions and the client components, so it must not import anything server-only.

export type WalletStatus = "active" | "blocked" | "closed"

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "eft", label: "EFT" },
  { value: "other", label: "Other" },
] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"]
export const DEFAULT_PAYMENT_METHOD: PaymentMethod = "cash"

export const PRESET_AMOUNTS = [50, 100, 200, 500, 1000] as const

export interface PassportSettings {
  currency: string
  minTopup: number
  maxTopup: number
  /** null = no ceiling on a customer's balance. */
  maxBalance: number | null
  allowCustomerTopup: boolean
}

export const DEFAULT_PASSPORT_SETTINGS: PassportSettings = {
  currency: "ZAR",
  minTopup: 10,
  maxTopup: 5000,
  maxBalance: null,
  allowCustomerTopup: true,
}

/** One row of the Accounts list: a customer, with their Passport if they have one yet. */
export interface PassportAccount {
  customerId: string
  name: string
  phone: string | null
  email: string | null
  customerStatus: string
  customerSince: string
  /** null until the customer's first top-up creates their Passport. */
  walletId: string | null
  balance: number
  status: WalletStatus | null
  blockReason: string | null
  currency: string
}

export interface PassportLedgerEntry {
  id: string
  direction: "credit" | "debit"
  entryType: string
  amount: number
  balanceAfter: number
  description: string | null
  createdAt: string
  /** Name of the staff member who did it, when known. */
  by: string | null
}

export interface PassportRefund {
  id: string
  walletId: string
  customerName: string
  customerPhone: string | null
  amount: number
  reason: string
  status: "pending" | "approved" | "rejected"
  reviewNote: string | null
  createdAt: string
  processedAt: string | null
}

/** One entry on the Overview "recent activity" list. */
export interface PassportActivity extends PassportLedgerEntry {
  customerName: string
}

export interface PassportOverview {
  currency: string
  /** Everything customers currently hold with the venue (money owed back as spend). */
  totalBalance: number
  walletCount: number
  activeCount: number
  blockedCount: number
  /** Last 30 days. */
  topupsTotal: number
  spentTotal: number
  refundedTotal: number
  pendingRefunds: number
  /** Last 7 days, oldest first. */
  daily: Array<{ day: string; label: string; topups: number; spent: number }>
  recent: PassportActivity[]
}

export interface PassportAccountDetail {
  account: PassportAccount
  ledger: PassportLedgerEntry[]
  refunds: PassportRefund[]
  /** Totals across the whole ledger (not just the rows returned). */
  totals: { topups: number; spent: number; refunded: number; adjustments: number }
}

export interface PassportAccountsQuery {
  search?: string
  status?: "all" | WalletStatus | "no_wallet"
  sort?: "newest" | "name" | "balance"
  page?: number
}

export const ACCOUNTS_PAGE_SIZE = 20

export type PassportOk<T> = { ok: true } & T
export type PassportFail = { ok: false; error: string }
export type PassportResult<T = unknown> = PassportOk<T> | PassportFail

export const ENTRY_TYPE_LABEL: Record<string, string> = {
  topup: "Top-up",
  purchase: "Purchase",
  refund: "Refund",
  adjustment: "Adjustment",
}

export function entryTypeLabel(entryType: string): string {
  return ENTRY_TYPE_LABEL[entryType] ?? entryType.replace(/_/g, " ")
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}
