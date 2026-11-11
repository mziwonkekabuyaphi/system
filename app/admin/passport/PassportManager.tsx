// app/admin/passport/PassportManager.tsx
//
// Passport (customer wallet) pages. One component for the three sidebar entries (Overview, Accounts,
// Refunds), so moving between them keeps what was already loaded. Mounted with no initial data (same
// pattern as ShishaManager): it loads through the server actions, which check the permission and the
// module again. Styling uses the shared admin tokens (bg-card, text-ink, border-line, accent...), so
// the cream and the dark theme both work without anything theme-specific in here.
"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { BRAND_BG, BRAND_FOCUS_BORDER, BRAND_ON } from "@/components/admin/brand"

import { AdminDialog } from "../AdminDialog"
import { SettingsStatTile } from "../settings/ui"
import {
  adjustPassport,
  getPassportAccount,
  getPassportSettings,
  listPassportAccounts,
  listPassportRefunds,
  loadPassportOverview,
  requestPassportRefund,
  reviewPassportRefund,
  setPassportStatus,
  topUpPassport,
} from "./actions"
import {
  DEFAULT_PASSPORT_SETTINGS,
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHODS,
  PRESET_AMOUNTS,
  entryTypeLabel,
  formatMoney,
  type PassportAccount,
  type PassportAccountDetail,
  type PassportLedgerEntry,
  type PassportOverview,
  type PassportRefund,
  type PassportSettings,
  type PaymentMethod,
  type WalletStatus,
} from "./passport-types"

export type PassportSection = "overview" | "accounts" | "refunds"
export const PASSPORT_SECTION_LABELS: Record<PassportSection, string> = {
  overview: "Overview",
  accounts: "Accounts",
  refunds: "Refunds",
}

const REFRESH_MS = 30_000

const FIELD = `w-full rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink outline-none ${BRAND_FOCUS_BORDER}`
const BTN =
  "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY = `rounded-md ${BRAND_BG} ${BRAND_ON} px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`
const BTN_DANGER =
  "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-color hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
const BTN_GHOST = "rounded-md px-3 py-1.5 text-sm text-ink-muted hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50"
const CARD = "rounded-lg border border-line bg-card"

type Notice = { kind: "success" | "error"; text: string }
type DialogKind = "topup" | "adjust" | "refund" | "block" | "unblock" | "close"

const STATUS_BADGE: Record<string, string> = {
  active: "bg-success/10 text-success",
  blocked: "bg-accent/10 text-accent",
  closed: "bg-ink/[0.07] text-ink-soft",
  none: "bg-ink/[0.07] text-ink-soft",
  pending: "bg-warn/10 text-warn",
  approved: "bg-success/10 text-success",
  rejected: "bg-accent/10 text-accent",
}

function Badge({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[kind] ?? STATUS_BADGE.none}`}>{children}</span>
}

function useDateFormat(timezone: string) {
  return useMemo(() => {
    let fmt: Intl.DateTimeFormat
    try {
      fmt = new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: timezone })
    } catch {
      fmt = new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short" })
    }
    return (iso: string | null | undefined): string => {
      if (!iso) return "—"
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? "—" : fmt.format(d)
    }
  }, [timezone])
}

function parseAmount(text: string): number | null {
  const n = Number(text.trim().replace(/\s/g, "").replace(",", "."))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

function newKey(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  }
}

// ============================================================================
// Main component
// ============================================================================

export function PassportManager({
  timezone,
  canOperate,
  canManage,
  section,
  onSectionChange,
}: {
  timezone: string
  /** wallet.operate (counter top-ups, refund requests). Managers hold it too. */
  canOperate: boolean
  /** wallet.manage (corrections, block, approve refunds). */
  canManage: boolean
  section: PassportSection
  onSectionChange: (next: PassportSection) => void
}) {
  const [settings, setSettings] = useState<PassportSettings>(DEFAULT_PASSPORT_SETTINGS)
  const [pendingRefunds, setPendingRefunds] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Bumped after any change so the other pages reload what they show.
  const [version, setVersion] = useState(0)
  const fmtDate = useDateFormat(timezone)
  const money = useCallback((n: number, currency?: string) => formatMoney(n, currency ?? settings.currency), [settings.currency])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await getPassportSettings()
      if (!cancelled && res.ok) setSettings(res.settings)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const changed = useCallback(() => setVersion((v) => v + 1), [])

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-1" aria-label="Passport pages">
        {(Object.keys(PASSPORT_SECTION_LABELS) as PassportSection[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSectionChange(s)}
            aria-current={section === s ? "page" : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
              section === s ? "border-selected bg-selected text-on-color" : "border-line-strong bg-card text-ink-soft hover:bg-tint"
            }`}
          >
            {PASSPORT_SECTION_LABELS[s]}
            {s === "refunds" && pendingRefunds > 0 && (
              <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[0.65rem] font-bold text-on-color">{pendingRefunds}</span>
            )}
          </button>
        ))}
      </nav>

      {notice && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${notice.kind === "success" ? "bg-success/10 text-success" : "bg-accent/10 text-accent"}`}
        >
          {notice.text}
        </p>
      )}

      {section === "overview" && (
        <OverviewPage
          version={version}
          money={money}
          fmtDate={fmtDate}
          onPendingRefunds={setPendingRefunds}
          onOpenRefunds={() => onSectionChange("refunds")}
        />
      )}
      {section === "accounts" && (
        <AccountsPage
          version={version}
          settings={settings}
          money={money}
          fmtDate={fmtDate}
          canOperate={canOperate}
          canManage={canManage}
          setNotice={setNotice}
          onChanged={changed}
        />
      )}
      {section === "refunds" && (
        <RefundsPage
          version={version}
          money={money}
          fmtDate={fmtDate}
          canManage={canManage}
          setNotice={setNotice}
          onChanged={changed}
          onPending={setPendingRefunds}
        />
      )}
    </div>
  )
}

type Money = (n: number, currency?: string) => string
type FmtDate = (iso: string | null | undefined) => string

// ============================================================================
// Overview
// ============================================================================

function OverviewPage({
  version,
  money,
  fmtDate,
  onPendingRefunds,
  onOpenRefunds,
}: {
  version: number
  money: Money
  fmtDate: FmtDate
  onPendingRefunds: (n: number) => void
  onOpenRefunds: () => void
}) {
  const [data, setData] = useState<PassportOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await loadPassportOverview()
    if (res.ok) {
      setData(res.overview)
      setError(null)
      onPendingRefunds(res.overview.pendingRefunds)
    } else {
      setError(res.error)
    }
  }, [onPendingRefunds])

  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, REFRESH_MS)
    return () => clearInterval(id)
  }, [load, version])

  if (error && !data) return <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">{error}</p>
  if (!data) return <p className="text-sm text-ink-muted">Loading…</p>

  const peak = Math.max(1, ...data.daily.flatMap((d) => [d.topups, d.spent]))
  const cur = data.currency

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SettingsStatTile label="Held in Passports" value={money(data.totalBalance, cur)} hint="Money customers can still spend" />
        <SettingsStatTile
          label="Passports"
          value={String(data.walletCount)}
          hint={`${data.activeCount} active${data.blockedCount ? ` · ${data.blockedCount} blocked` : ""}`}
        />
        <SettingsStatTile label="Top-ups (30 days)" value={money(data.topupsTotal, cur)} hint="Money added" />
        <SettingsStatTile label="Spent (30 days)" value={money(data.spentTotal, cur)} hint={`Refunded ${money(data.refundedTotal, cur)}`} />
      </div>

      {data.pendingRefunds > 0 && (
        <button
          type="button"
          onClick={onOpenRefunds}
          className="flex w-full items-center justify-between rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-left text-sm text-ink hover:bg-warn/15"
        >
          <span>
            <strong>{data.pendingRefunds}</strong> refund request{data.pendingRefunds === 1 ? "" : "s"} waiting for a decision
          </span>
          <span className="text-ink-muted">Review →</span>
        </button>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${CARD} p-4`}>
          <h3 className="text-sm font-semibold text-ink">Last 7 days</h3>
          <div className="mt-3 flex h-40 items-end gap-2" role="img" aria-label="Top-ups and spending for each of the last seven days">
            {data.daily.map((d) => (
              <div key={d.day} className="flex h-full flex-1 flex-col justify-end gap-1">
                <div className="flex flex-1 items-end justify-center gap-1">
                  <div
                    className="w-full max-w-[14px] rounded-t bg-success"
                    style={{ height: `${Math.max(d.topups > 0 ? 3 : 0, (d.topups / peak) * 100)}%` }}
                    title={`Top-ups ${money(d.topups, cur)}`}
                  />
                  <div
                    className="w-full max-w-[14px] rounded-t bg-accent"
                    style={{ height: `${Math.max(d.spent > 0 ? 3 : 0, (d.spent / peak) * 100)}%` }}
                    title={`Spent ${money(d.spent, cur)}`}
                  />
                </div>
                <span className="text-center text-[0.65rem] text-ink-muted">{d.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-xs text-ink-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-success" /> Top-ups
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-accent" /> Spent
            </span>
          </div>
        </section>

        <section className={`${CARD} p-4`}>
          <h3 className="text-sm font-semibold text-ink">Recent activity</h3>
          {data.recent.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">Nothing yet. Top up a customer from the Accounts page to get started.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {data.recent.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-ink">
                      {e.customerName} <span className="text-ink-muted">· {entryTypeLabel(e.entryType)}</span>
                    </p>
                    <p className="text-xs text-ink-muted">
                      {fmtDate(e.createdAt)}
                      {e.by ? ` · ${e.by}` : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 font-medium ${e.direction === "credit" ? "text-success" : "text-accent"}`}>
                    {e.direction === "credit" ? "+" : "−"}
                    {money(e.amount, cur)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

// ============================================================================
// Accounts
// ============================================================================

function AccountsPage({
  version,
  settings,
  money,
  fmtDate,
  canOperate,
  canManage,
  setNotice,
  onChanged,
}: {
  version: number
  settings: PassportSettings
  money: Money
  fmtDate: FmtDate
  canOperate: boolean
  canManage: boolean
  setNotice: (n: Notice | null) => void
  onChanged: () => void
}) {
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [status, setStatus] = useState<"all" | WalletStatus>("all")
  const [sort, setSort] = useState<"newest" | "name" | "balance">("newest")
  const [page, setPage] = useState(0)
  const [accounts, setAccounts] = useState<PassportAccount[]>([])
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(0)
  }, [debounced, status, sort])

  useEffect(() => {
    const mine = ++requestRef.current
    setLoading(true)
    void (async () => {
      const res = await listPassportAccounts({ search: debounced, status, sort, page })
      if (mine !== requestRef.current) return // a newer search already started
      setLoading(false)
      if (res.ok) {
        setAccounts(res.accounts)
        setTotal(res.total)
        setPageSize(res.pageSize)
        setListError(null)
      } else {
        setListError(res.error)
      }
    })()
  }, [debounced, status, sort, page, version])

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section className={`${CARD} flex min-h-[28rem] flex-col`}>
        <div className="space-y-2 border-b border-line p-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone or email…"
            aria-label="Search customers"
            className={FIELD}
          />
          <div className="flex gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={FIELD} aria-label="Filter by status">
              <option value="all">All customers</option>
              <option value="active">Active Passports</option>
              <option value="blocked">Blocked</option>
              <option value="closed">Closed</option>
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={FIELD} aria-label="Sort">
              <option value="newest">Newest</option>
              <option value="name">Name A–Z</option>
              <option value="balance">Highest balance</option>
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {listError && <p className="m-1 rounded-md bg-accent/10 px-3 py-2 text-sm text-accent">{listError}</p>}
          {!listError && loading && accounts.length === 0 && <p className="p-3 text-sm text-ink-muted">Loading…</p>}
          {!listError && !loading && accounts.length === 0 && (
            <p className="p-3 text-sm text-ink-muted">
              {debounced || status !== "all" ? "No customers match." : "No customers yet. Customers appear here once they book, queue or use WhatsApp."}
            </p>
          )}
          <ul className="space-y-1.5">
            {accounts.map((a) => (
              <li key={a.customerId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(a.customerId)}
                  aria-current={selectedId === a.customerId ? "true" : undefined}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selectedId === a.customerId ? "border-accent bg-accent/[0.08]" : "border-line bg-card hover:bg-tint"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
                    <span className="block truncate text-xs text-ink-muted">{a.phone ?? a.email ?? "No contact details"}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold text-ink">{a.walletId ? money(a.balance, a.currency) : "—"}</span>
                    <Badge kind={a.status ?? "none"}>{a.status ? a.status : "No Passport"}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-muted">
          <span>
            {total} customer{total === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-2">
            <button type="button" className={BTN_GHOST} disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ← Prev
            </button>
            <span>
              {page + 1} / {pages}
            </span>
            <button type="button" className={BTN_GHOST} disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          </span>
        </div>
      </section>

      <AccountPanel
        key={selectedId ?? "none"}
        customerId={selectedId}
        version={version}
        settings={settings}
        money={money}
        fmtDate={fmtDate}
        canOperate={canOperate}
        canManage={canManage}
        setNotice={setNotice}
        onChanged={onChanged}
      />
    </div>
  )
}

// ============================================================================
// Selected account
// ============================================================================

type AccountTab = "overview" | "transactions" | "refunds"

function AccountPanel({
  customerId,
  version,
  settings,
  money,
  fmtDate,
  canOperate,
  canManage,
  setNotice,
  onChanged,
}: {
  customerId: string | null
  version: number
  settings: PassportSettings
  money: Money
  fmtDate: FmtDate
  canOperate: boolean
  canManage: boolean
  setNotice: (n: Notice | null) => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<PassportAccountDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<AccountTab>("overview")
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [typeFilter, setTypeFilter] = useState("all")

  useEffect(() => {
    if (!customerId) return
    let cancelled = false
    void (async () => {
      const res = await getPassportAccount(customerId)
      if (cancelled) return
      if (res.ok) {
        setDetail(res.detail)
        setError(null)
      } else {
        setError(res.error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [customerId, version])

  if (!customerId) {
    return (
      <section className={`${CARD} flex min-h-[28rem] items-center justify-center p-6 text-center`}>
        <p className="max-w-xs text-sm text-ink-muted">Pick a customer on the left to see their Passport, top it up or look at what they have spent.</p>
      </section>
    )
  }
  if (error && !detail) return <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">{error}</p>
  if (!detail) return <p className="text-sm text-ink-muted">Loading…</p>

  const { account, ledger, refunds, totals } = detail
  const hasWallet = account.walletId !== null
  const isActive = account.status === "active" || account.status === null
  const customerOk = account.customerStatus === "active"

  const filtered = typeFilter === "all" ? ledger : ledger.filter((e) => e.entryType === typeFilter)

  return (
    <section className={`${CARD} overflow-hidden`}>
      {/* Passport card */}
      <div className="border-b border-line bg-tint/60 p-4">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.14em] text-accent">Passport</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-[family-name:var(--font-admin-serif)] text-xl text-ink">{account.name}</h3>
            <p className="truncate text-xs text-ink-muted">{[account.phone, account.email].filter(Boolean).join(" · ") || "No contact details"}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-ink">{hasWallet ? money(account.balance, account.currency) : money(0, account.currency)}</p>
            <Badge kind={account.status ?? "none"}>{account.status ?? "No Passport yet"}</Badge>
          </div>
        </div>
        {account.status === "blocked" && account.blockReason && (
          <p className="mt-2 text-xs text-accent">Blocked: {account.blockReason}</p>
        )}
        {!customerOk && <p className="mt-2 text-xs text-warn">This customer is {account.customerStatus}, so their Passport can't be used.</p>}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 border-b border-line p-3">
        {canOperate && (
          <button type="button" className={BTN_PRIMARY} disabled={!customerOk || account.status === "closed"} onClick={() => setDialog("topup")}>
            + Top up
          </button>
        )}
        {canOperate && hasWallet && (
          <button type="button" className={BTN} disabled={account.status === "closed"} onClick={() => setDialog("refund")}>
            Refund
          </button>
        )}
        {canManage && hasWallet && (
          <button type="button" className={BTN} disabled={account.status === "closed"} onClick={() => setDialog("adjust")}>
            Correct balance
          </button>
        )}
        {canManage && hasWallet && account.status === "active" && (
          <button type="button" className={BTN} onClick={() => setDialog("block")}>
            Block
          </button>
        )}
        {canManage && hasWallet && account.status === "blocked" && (
          <button type="button" className={BTN} onClick={() => setDialog("unblock")}>
            Unblock
          </button>
        )}
        {canManage && hasWallet && account.status !== "closed" && account.balance === 0 && (
          <button type="button" className={BTN_GHOST} onClick={() => setDialog("close")}>
            Close Passport
          </button>
        )}
        {!canOperate && !canManage && <p className="text-xs text-ink-muted">You can view Passports but not change them.</p>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line px-3 pt-2">
        {(["overview", "transactions", "refunds"] as AccountTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            className={`rounded-t-md px-3 py-1.5 text-sm font-medium ${
              tab === t ? "border-b-2 border-accent text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {t === "overview" ? "Overview" : t === "transactions" ? "Transactions" : `Refunds${refunds.length ? ` (${refunds.length})` : ""}`}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === "overview" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SettingsStatTile label="Topped up" value={money(totals.topups, account.currency)} />
              <SettingsStatTile label="Spent" value={money(totals.spent, account.currency)} />
              <SettingsStatTile label="Refunded" value={money(totals.refunded, account.currency)} />
              <SettingsStatTile label="Corrections" value={money(totals.adjustments, account.currency)} />
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-ink-muted">Customer since</dt>
                <dd className="text-ink">{fmtDate(account.customerSince)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-ink-muted">Last activity</dt>
                <dd className="text-ink">{ledger[0] ? fmtDate(ledger[0].createdAt) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-ink-muted">Top-up limits</dt>
                <dd className="text-ink">
                  {money(settings.minTopup)} – {money(settings.maxTopup)}
                  {settings.maxBalance !== null ? ` (balance up to ${money(settings.maxBalance)})` : ""}
                </dd>
              </div>
            </dl>
            {ledger.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase text-ink-muted">Latest</h4>
                <LedgerList entries={ledger.slice(0, 5)} currency={account.currency} money={money} fmtDate={fmtDate} />
              </div>
            )}
          </div>
        )}

        {tab === "transactions" && (
          <div className="space-y-3">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${FIELD} max-w-[12rem]`} aria-label="Filter by type">
              <option value="all">All types</option>
              <option value="topup">Top-ups</option>
              <option value="purchase">Purchases</option>
              <option value="refund">Refunds</option>
              <option value="adjustment">Corrections</option>
            </select>
            {filtered.length === 0 ? (
              <p className="text-sm text-ink-muted">{ledger.length === 0 ? "No transactions yet." : "No transactions of that type."}</p>
            ) : (
              <LedgerList entries={filtered} currency={account.currency} money={money} fmtDate={fmtDate} showBalance />
            )}
            {ledger.length >= 200 && <p className="text-xs text-ink-muted">Showing the latest 200 transactions.</p>}
          </div>
        )}

        {tab === "refunds" && (
          <div>
            {refunds.length === 0 ? (
              <p className="text-sm text-ink-muted">No refund requests for this customer.</p>
            ) : (
              <ul className="divide-y divide-line">
                {refunds.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="text-ink">{r.reason}</p>
                      <p className="text-xs text-ink-muted">
                        {fmtDate(r.createdAt)}
                        {r.reviewNote ? ` · ${r.reviewNote}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-medium text-ink">{money(r.amount, account.currency)}</p>
                      <Badge kind={r.status}>{r.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <AccountDialogs
        kind={dialog}
        onClose={() => setDialog(null)}
        account={account}
        settings={settings}
        money={money}
        setNotice={setNotice}
        onDone={() => {
          setDialog(null)
          onChanged()
        }}
      />
    </section>
  )
}

function LedgerList({
  entries,
  currency,
  money,
  fmtDate,
  showBalance = false,
}: {
  entries: PassportLedgerEntry[]
  currency: string
  money: Money
  fmtDate: FmtDate
  showBalance?: boolean
}) {
  return (
    <ul className="divide-y divide-line">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate text-ink">
              {entryTypeLabel(e.entryType)}
              {e.description ? <span className="text-ink-muted"> · {e.description}</span> : null}
            </p>
            <p className="text-xs text-ink-muted">
              {fmtDate(e.createdAt)}
              {e.by ? ` · ${e.by}` : ""}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className={`font-medium ${e.direction === "credit" ? "text-success" : "text-accent"}`}>
              {e.direction === "credit" ? "+" : "−"}
              {money(e.amount, currency)}
            </p>
            {showBalance && <p className="text-xs text-ink-muted">Balance {money(e.balanceAfter, currency)}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

// ============================================================================
// Dialogs (top up, correct, refund, block, unblock, close)
// ============================================================================

function AccountDialogs({
  kind,
  onClose,
  account,
  settings,
  money,
  setNotice,
  onDone,
}: {
  kind: DialogKind | null
  onClose: () => void
  account: PassportAccount
  settings: PassportSettings
  money: Money
  setNotice: (n: Notice | null) => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<PaymentMethod>(DEFAULT_PAYMENT_METHOD)
  const [text, setText] = useState("")
  const [direction, setDirection] = useState<"credit" | "debit">("debit")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per time the dialog is opened: a double click or a retry after a slow network can
  // never take the money twice, because the database returns the first result for the same key.
  const keyRef = useRef(newKey())

  useEffect(() => {
    if (kind) {
      setAmount("")
      setText("")
      setError(null)
      setBusy(false)
      setMethod(DEFAULT_PAYMENT_METHOD)
      setDirection("debit")
      keyRef.current = newKey()
    }
  }, [kind])

  const parsed = parseAmount(amount)

  async function submit() {
    if (!kind) return
    setError(null)
    setBusy(true)
    let result: { ok: true } | { ok: false; error: string }
    let success = ""
    if (kind === "topup") {
      if (parsed === null) return fail("Enter an amount above zero.")
      const res = await topUpPassport({ customerId: account.customerId, amount: parsed, method, note: text, key: keyRef.current })
      result = res
      success = `Topped up ${money(parsed, account.currency)} for ${account.name}.`
    } else if (kind === "adjust") {
      if (parsed === null) return fail("Enter an amount above zero.")
      const res = await adjustPassport({ customerId: account.customerId, direction, amount: parsed, reason: text, key: keyRef.current })
      result = res
      success = `Balance corrected for ${account.name}.`
    } else if (kind === "refund") {
      if (parsed === null) return fail("Enter an amount above zero.")
      result = await requestPassportRefund({ customerId: account.customerId, amount: parsed, reason: text })
      success = "Refund request sent. A manager can approve it on the Refunds page."
    } else {
      if (!account.walletId) return fail("This customer has no Passport yet.")
      const status: WalletStatus = kind === "block" ? "blocked" : kind === "unblock" ? "active" : "closed"
      result = await setPassportStatus({ walletId: account.walletId, status, reason: text })
      success = kind === "block" ? `${account.name}'s Passport is blocked.` : kind === "unblock" ? "Passport unblocked." : "Passport closed."
    }
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNotice({ kind: "success", text: success })
    onDone()
  }

  function fail(message: string): void {
    setBusy(false)
    setError(message)
  }

  const titles: Record<DialogKind, string> = {
    topup: "Top up Passport",
    adjust: "Correct balance",
    refund: "Refund request",
    block: "Block Passport",
    unblock: "Unblock Passport",
    close: "Close Passport",
  }

  return (
    <AdminDialog
      open={kind !== null}
      title={kind ? titles[kind] : ""}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={kind === "block" || kind === "close" ? BTN_DANGER : BTN_PRIMARY} disabled={busy} onClick={() => void submit()}>
            {busy ? "Working…" : kind === "topup" ? "Add money" : kind === "adjust" ? "Save correction" : kind === "refund" ? "Send request" : kind === "block" ? "Block" : kind === "unblock" ? "Unblock" : "Close"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-muted">
          {account.name}
          {account.walletId ? ` · balance ${money(account.balance, account.currency)}` : " · no Passport yet (the first top-up creates it)"}
        </p>

        {(kind === "topup" || kind === "adjust" || kind === "refund") && (
          <>
            {kind === "adjust" && (
              <div className="flex gap-2" role="radiogroup" aria-label="Direction">
                {(["debit", "credit"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={direction === d}
                    onClick={() => setDirection(d)}
                    className={`flex-1 rounded-md border px-3 py-1.5 ${direction === d ? "border-selected bg-selected text-on-color" : "border-line-strong bg-card text-ink hover:bg-tint"}`}
                  >
                    {d === "debit" ? "Take money off" : "Add money"}
                  </button>
                ))}
              </div>
            )}
            <label className="block space-y-1">
              <span className="text-ink-muted">Amount ({account.currency})</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className={FIELD} autoFocus />
            </label>
            {kind === "topup" && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_AMOUNTS.map((p) => (
                    <button key={p} type="button" className={BTN} onClick={() => setAmount(String(p))}>
                      {money(p, account.currency).replace(/[,.]00$/, "")}
                    </button>
                  ))}
                </div>
                <label className="block space-y-1">
                  <span className="text-ink-muted">Paid by</span>
                  <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={FIELD}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-ink-muted">
                  Allowed: {money(settings.minTopup)} – {money(settings.maxTopup)} per top-up.
                </p>
              </>
            )}
          </>
        )}

        {(kind === "adjust" || kind === "refund" || kind === "block") && (
          <label className="block space-y-1">
            <span className="text-ink-muted">{kind === "block" ? "Reason (the customer may see this)" : "Reason"}</span>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} className={FIELD} placeholder={kind === "adjust" ? "e.g. corrected a wrong top-up" : kind === "refund" ? "e.g. drink returned" : "e.g. suspected misuse"} />
          </label>
        )}
        {kind === "topup" && (
          <label className="block space-y-1">
            <span className="text-ink-muted">Note (optional)</span>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} className={FIELD} />
          </label>
        )}
        {kind === "refund" && <p className="text-xs text-ink-muted">Approved refunds are added back to the customer's Passport.</p>}
        {kind === "unblock" && <p className="text-ink">The customer will be able to top up and spend again.</p>}
        {kind === "close" && <p className="text-ink">A closed Passport can't be used again. This only works at a zero balance.</p>}

        {error && <p className="rounded-md bg-accent/10 px-3 py-2 text-accent">{error}</p>}
      </div>
    </AdminDialog>
  )
}

// ============================================================================
// Refunds
// ============================================================================

function RefundsPage({
  version,
  money,
  fmtDate,
  canManage,
  setNotice,
  onChanged,
  onPending,
}: {
  version: number
  money: Money
  fmtDate: FmtDate
  canManage: boolean
  setNotice: (n: Notice | null) => void
  onChanged: () => void
  onPending: (n: number) => void
}) {
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending")
  const [refunds, setRefunds] = useState<PassportRefund[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<{ refund: PassportRefund; approve: boolean } | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await listPassportRefunds(filter)
      if (cancelled) return
      if (res.ok) {
        setRefunds(res.refunds)
        setError(null)
        onPending(res.pending)
      } else {
        setError(res.error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filter, version, onPending])

  async function confirm() {
    if (!reviewing) return
    setBusy(true)
    setDialogError(null)
    const res = await reviewPassportRefund({ requestId: reviewing.refund.id, approve: reviewing.approve, note })
    setBusy(false)
    if (!res.ok) {
      setDialogError(res.error)
      return
    }
    setNotice({
      kind: "success",
      text: reviewing.approve ? `Refund of ${money(reviewing.refund.amount)} approved and added to ${reviewing.refund.customerName}'s Passport.` : "Refund declined.",
    })
    setReviewing(null)
    setNote("")
    onChanged()
  }

  return (
    <section className={`${CARD} p-4`}>
      <div className="mb-3 flex flex-wrap gap-1">
        {(["pending", "approved", "rejected", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-current={filter === f ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize ${
              filter === f ? "border-selected bg-selected text-on-color" : "border-line-strong bg-card text-ink-soft hover:bg-tint"
            }`}
          >
            {f === "rejected" ? "Declined" : f}
          </button>
        ))}
      </div>

      {error && <p className="rounded-md bg-accent/10 px-3 py-2 text-sm text-accent">{error}</p>}
      {!error && !refunds && <p className="text-sm text-ink-muted">Loading…</p>}
      {!error && refunds && refunds.length === 0 && <p className="text-sm text-ink-muted">No refund requests here.</p>}
      {refunds && refunds.length > 0 && (
        <ul className="divide-y divide-line">
          {refunds.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {r.customerName} <span className="font-normal text-ink-muted">· {money(r.amount)}</span>
                </p>
                <p className="text-ink-soft">{r.reason}</p>
                <p className="text-xs text-ink-muted">
                  {fmtDate(r.createdAt)}
                  {r.reviewNote ? ` · ${r.reviewNote}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge kind={r.status}>{r.status === "rejected" ? "declined" : r.status}</Badge>
                {r.status === "pending" && canManage && (
                  <>
                    <button type="button" className={BTN_PRIMARY} onClick={() => { setNote(""); setDialogError(null); setReviewing({ refund: r, approve: true }) }}>
                      Approve
                    </button>
                    <button type="button" className={BTN} onClick={() => { setNote(""); setDialogError(null); setReviewing({ refund: r, approve: false }) }}>
                      Decline
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!canManage && refunds && refunds.some((r) => r.status === "pending") && (
        <p className="mt-3 text-xs text-ink-muted">Only a manager can approve or decline refunds.</p>
      )}

      <AdminDialog
        open={reviewing !== null}
        title={reviewing?.approve ? "Approve refund" : "Decline refund"}
        onClose={() => setReviewing(null)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN_GHOST} onClick={() => setReviewing(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className={reviewing?.approve ? BTN_PRIMARY : BTN_DANGER} onClick={() => void confirm()} disabled={busy}>
              {busy ? "Working…" : reviewing?.approve ? "Approve and add to Passport" : "Decline"}
            </button>
          </div>
        }
      >
        {reviewing && (
          <div className="space-y-3 text-sm">
            <p className="text-ink">
              {reviewing.refund.customerName} · {money(reviewing.refund.amount)}
            </p>
            <p className="text-ink-muted">{reviewing.refund.reason}</p>
            <label className="block space-y-1">
              <span className="text-ink-muted">Note (optional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={FIELD} />
            </label>
            {reviewing.approve && <p className="text-xs text-ink-muted">The amount is added to the customer's Passport straight away.</p>}
            {dialogError && <p className="rounded-md bg-accent/10 px-3 py-2 text-accent">{dialogError}</p>}
          </div>
        )}
      </AdminDialog>
    </section>
  )
}
