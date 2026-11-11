"use client"

// app/admin/vvip/BuyerPanel.tsx
//
// The buyer slide-over (the Rands "Buyer & Tab Details" panel): who bought, how much they paid, the
// tab balance and how much of it is used, the booking's status moves, and the tab's transaction
// history with a form to log spend, top-ups and (managers only) adjustments.
//
// Money is never edited here. Every entry goes through a database function that changes the balance
// in one transaction and returns the new balance, which is shown. After any action the booking list
// and the ledger are reloaded from the server.
//
// Each transaction attempt carries one idempotency key; it is replaced when the form changes or
// after a success, so a double click or a retry after a dropped connection can't log it twice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { formatClock, formatMoney, formatShortDate } from "../events/format"
import { ACCENT_TEXT, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Chip, FOCUS, INPUT, Icon, LABEL, Modal, ProgressBar, WELL } from "../events/ui"
import { cancelBooking, loadTabLedger, setBookingStatus, tabAdjust, tabSpend, tabTopup } from "./actions"
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  ENTRY_LABEL,
  NEXT_STATUSES,
  PAYMENT_LABEL,
  type EntryType,
  type TabEntryReceipt,
  type TopupMethod,
  type VvipBooking,
  type VvipLedgerEntry,
  type VvipPermissions,
} from "./types"

type View = "overview" | "transactions"
type Filter = "all" | "topup" | "spend" | "adjustment"
type TxType = "spend" | "topup" | "adjustment"

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "topup", label: "Top-ups" },
  { value: "spend", label: "Spend" },
  { value: "adjustment", label: "Adjustments" },
]

const ENTRY_ICON: Record<EntryType, string> = {
  opening: "flag",
  topup: "circle-plus",
  spend: "martini-glass",
  refund: "rotate-left",
  adjustment: "sliders",
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function BuyerPanel({
  booking,
  tz,
  currency,
  permissions,
  onClose,
  onChanged,
  flash,
}: {
  booking: VvipBooking
  tz: string
  currency: string
  permissions: VvipPermissions
  onClose: () => void
  onChanged: () => Promise<void>
  flash: (tone: "good" | "bad", text: string) => void
}) {
  const [view, setView] = useState<View>("overview")
  const [ledger, setLedger] = useState<VvipLedgerEntry[] | null>(null)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("all")
  const [moving, setMoving] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Focus moves into the panel on open and back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  const reloadLedger = useCallback(async () => {
    const res = await loadTabLedger(booking.id)
    if (res.ok) {
      setLedger(res.data)
      setLedgerError(null)
    } else {
      setLedgerError(res.error)
    }
  }, [booking.id])
  useEffect(() => {
    setLedger(null)
    void reloadLedger()
  }, [reloadLedger])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // The cancel dialog has its own Escape handling; don't close both at once.
    if (e.key === "Escape" && !cancelOpen) {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== "Tab" || !panelRef.current) return
    // Keep Tab inside the panel while it is open.
    const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  async function move(status: "checked_in" | "seated" | "completed" | "no_show", label: string) {
    setMoving(status)
    setMoveError(null)
    const res = await setBookingStatus(booking.id, status)
    setMoving(null)
    if (!res.ok) return setMoveError(res.error)
    flash("good", `${label}: done.`)
    await Promise.all([onChanged(), reloadLedger()])
  }

  const name = booking.customerName ?? "Unknown buyer"
  const used = Math.max(0, Math.min(booking.tabCreditIssued, booking.tabCreditIssued - booking.tabBalance))
  const usedPct = booking.tabCreditIssued > 0 ? Math.round((used / booking.tabCreditIssued) * 100) : 0
  const moves = permissions.operate ? NEXT_STATUSES[booking.status] : []
  const canCancel = permissions.manage && (booking.status === "confirmed" || booking.status === "checked_in")

  const shownLedger = useMemo(() => {
    if (!ledger) return null
    return filter === "all" ? ledger : ledger.filter((e) => e.entryType === filter)
  }, [ledger, filter])

  const subtitle = [booking.reference, booking.packageName, booking.tableLabel ? `Table ${booking.tableLabel}` : null].filter(Boolean).join(" · ")

  return (
    <>
      <div className="fixed inset-0 z-40 flex justify-end bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="buyer-h"
          onKeyDown={onKeyDown}
          className="flex h-full w-full max-w-md flex-col border-l border-stone-200 bg-card shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
            <div className="min-w-0">
              <h2 id="buyer-h" className="truncate font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">{name}</h2>
              <p className="mt-0.5 truncate text-xs text-stone-500">{booking.customerPhone ?? "No phone on file"}</p>
              <p className="truncate text-xs text-stone-500">{subtitle}</p>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className={`rounded-full p-1.5 text-stone-500 hover:bg-stone-500/10 ${FOCUS}`}>
              <Icon name="xmark" />
            </button>
          </div>

          <div role="tablist" aria-label="Buyer details" className="flex gap-1 border-b border-stone-200 px-5 pt-2">
            {(["overview", "transactions"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                id={`buyer-tab-${v}`}
                aria-selected={view === v}
                aria-controls={`buyer-pane-${v}`}
                onClick={() => setView(v)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs font-semibold ${FOCUS} ${
                  view === v ? "border-[var(--sb-accent,var(--color-admin-accent))] text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"
                }`}
              >
                {v === "overview" ? "Overview" : "Transactions"}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            {view === "overview" ? (
              <div role="tabpanel" id="buyer-pane-overview" aria-labelledby="buyer-tab-overview" className="space-y-5">
                <dl className="grid grid-cols-2 gap-2">
                  <Info label="Amount paid" value={booking.pricePaid === 0 ? "Free" : formatMoney(booking.pricePaid, currency)} sub={PAYMENT_LABEL[booking.paymentMethod]} />
                  <Info label="Tab credit issued" value={formatMoney(booking.tabCreditIssued, currency)} />
                  <Info label="Tab balance left" value={formatMoney(booking.tabBalance, currency)} accent />
                  <div className={`${WELL} px-3 py-2.5`}>
                    <dt className="text-[0.68rem] text-stone-500">Booking status</dt>
                    <dd className="mt-1"><Chip tone={BOOKING_STATUS_TONE[booking.status]}>{BOOKING_STATUS_LABEL[booking.status]}</Chip></dd>
                  </div>
                </dl>

                <div className={`${WELL} px-3 py-3`}>
                  <p className="text-[0.68rem] text-stone-500">Tab utilisation</p>
                  <div className="mt-2"><ProgressBar value={used} max={booking.tabCreditIssued} label="Tab credit used" /></div>
                  <p className="mt-1.5 text-xs text-stone-500">{usedPct}% used</p>
                </div>

                {booking.notes && (
                  <div className={`${WELL} px-3 py-2.5`}>
                    <p className="text-[0.68rem] text-stone-500">Notes</p>
                    <p className="mt-1 text-sm text-stone-700">{booking.notes}</p>
                  </div>
                )}

                {booking.status === "cancelled" && (
                  <div className={`${WELL} px-3 py-2.5 text-sm text-stone-700`}>
                    <p className="font-medium text-stone-900">Cancelled{booking.cancelReason ? `: ${booking.cancelReason}` : ""}</p>
                    {booking.refundedAmount > 0 && (
                      <p className="mt-1 text-xs text-stone-500">
                        {formatMoney(booking.refundedAmount, currency)} refunded {booking.refundMethod === "wallet" ? "to the customer's Passport." : "by hand. The money was handed back manually."}
                      </p>
                    )}
                  </div>
                )}

                {(moves.length > 0 || canCancel) && (
                  <section aria-labelledby="buyer-actions-h">
                    <h3 id="buyer-actions-h" className="mb-2 text-xs font-bold text-stone-700">Booking</h3>
                    <div className="flex flex-wrap gap-2">
                      {moves.map((m) => (
                        <button key={m.status} type="button" className={BTN_GHOST} disabled={moving !== null} onClick={() => void move(m.status, m.label)}>
                          <Icon name={m.icon} /> {moving === m.status ? "Saving…" : m.label}
                        </button>
                      ))}
                      {canCancel && (
                        <button type="button" className={BTN_DANGER} disabled={moving !== null} onClick={() => setCancelOpen(true)}>
                          <Icon name="ban" /> Cancel booking
                        </button>
                      )}
                    </div>
                    {moveError && <p role="alert" className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{moveError}</p>}
                  </section>
                )}
              </div>
            ) : (
              <div role="tabpanel" id="buyer-pane-transactions" aria-labelledby="buyer-tab-transactions" className="space-y-5">
                <div role="group" aria-label="Filter transactions" className="flex flex-wrap gap-1.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      aria-pressed={filter === f.value}
                      onClick={() => setFilter(f.value)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${FOCUS} ${
                        filter === f.value ? "border-transparent bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_16%,transparent)] text-stone-900" : "border-stone-200 text-stone-600 hover:bg-stone-500/10"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {ledgerError ? (
                  <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{ledgerError}</p>
                ) : shownLedger === null ? (
                  <div className="h-24 animate-pulse rounded-xl bg-stone-500/10" aria-busy="true" />
                ) : shownLedger.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
                    {filter === "all" ? "No transactions yet." : "Nothing in this filter."}
                  </p>
                ) : (
                  <ul className="space-y-2" aria-label="Tab transactions, newest first">
                    {shownLedger.map((e) => (
                      <li key={e.id} className={`${WELL} flex items-center gap-3 px-3 py-2.5`}>
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-500/10 ${ACCENT_TEXT}`}>
                          <Icon name={ENTRY_ICON[e.entryType] ?? "circle"} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-stone-900">{ENTRY_LABEL[e.entryType] ?? e.entryType}</span>
                          <span className="block truncate text-xs text-stone-500">
                            {e.description ? `${e.description} · ` : ""}{formatShortDate(e.createdAt, tz)} {formatClock(e.createdAt, tz)}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="block text-sm font-bold text-stone-900">
                            {e.direction === "credit" ? "+" : "−"}{formatMoney(e.amount, currency)}
                          </span>
                          <span className="block text-[0.68rem] text-stone-500">Balance {formatMoney(e.balanceAfter, currency)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {permissions.operate && (
                  <LogTransaction
                    bookingId={booking.id}
                    currency={currency}
                    canAdjust={permissions.manage}
                    onLogged={async (receipt) => {
                      flash("good", `Logged. New balance ${formatMoney(receipt.balanceAfter, currency)}.`)
                      await Promise.all([onChanged(), reloadLedger()])
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {cancelOpen && (
        <CancelBookingDialog
          booking={booking}
          currency={currency}
          onClose={() => setCancelOpen(false)}
          onConfirm={async (refund, reason) => {
            const res = await cancelBooking(booking.id, refund, reason)
            if (!res.ok) return res.error
            setCancelOpen(false)
            flash("good", refund && booking.pricePaid > 0 ? "Booking cancelled and refunded." : "Booking cancelled.")
            await Promise.all([onChanged(), reloadLedger()])
            return null
          }}
        />
      )}
    </>
  )
}

function Info({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`${WELL} px-3 py-2.5`}>
      <dt className="text-[0.68rem] text-stone-500">{label}</dt>
      <dd className={`mt-0.5 text-base font-bold ${accent ? ACCENT_TEXT : "text-stone-900"}`}>{value}</dd>
      {sub && <dd className="text-[0.68rem] text-stone-500">{sub}</dd>}
    </div>
  )
}

// ----------------------------------------------------------------------------

function LogTransaction({
  bookingId,
  currency,
  canAdjust,
  onLogged,
}: {
  bookingId: string
  currency: string
  canAdjust: boolean
  onLogged: (receipt: TabEntryReceipt) => Promise<void>
}) {
  const [type, setType] = useState<TxType>("spend")
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<TopupMethod>("cash")
  const [direction, setDirection] = useState<"credit" | "debit">("credit")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<TabEntryReceipt | null>(null)
  const keyRef = useRef<string>(crypto.randomUUID())

  // A different entry is a different attempt: new key.
  useEffect(() => {
    keyRef.current = crypto.randomUUID()
  }, [bookingId, type, amount, method, direction, note])

  async function submit() {
    setError(null)
    const value = amount.trim() === "" ? NaN : Number(amount)
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount above 0.")
    if (type === "adjustment" && !note.trim()) return setError("A reason is required for adjustments.")

    setBusy(true)
    const key = keyRef.current
    const res =
      type === "spend"
        ? await tabSpend(bookingId, value, note, key)
        : type === "topup"
          ? await tabTopup(bookingId, value, method, note, key)
          : await tabAdjust(bookingId, direction, value, note, key)
    setBusy(false)
    if (!res.ok) return setError(res.error)

    keyRef.current = crypto.randomUUID()
    setLast(res.data)
    setAmount("")
    setNote("")
    await onLogged(res.data)
  }

  return (
    <section className={`${WELL} space-y-3 p-4`} aria-labelledby="tx-h">
      <h3 id="tx-h" className={`flex items-center gap-2 text-xs font-bold ${ACCENT_TEXT}`}>
        <Icon name="circle-plus" /> Log transaction
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL} htmlFor="tx-type">Type</label>
          <select id="tx-type" className={INPUT} value={type} onChange={(e) => setType(e.target.value as TxType)}>
            <option value="spend">Spend (bar tab)</option>
            <option value="topup">Top-up</option>
            {canAdjust && <option value="adjustment">Adjustment</option>}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="tx-amount">Amount</label>
          <input id="tx-amount" type="number" min={0} step="0.01" inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
      </div>

      {type === "topup" && (
        <div>
          <label className={LABEL} htmlFor="tx-method">Paid by</label>
          <select id="tx-method" className={INPUT} value={method} onChange={(e) => setMethod(e.target.value as TopupMethod)}>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="eft">EFT</option>
          </select>
        </div>
      )}
      {type === "adjustment" && (
        <div>
          <label className={LABEL} htmlFor="tx-dir">Correction</label>
          <select id="tx-dir" className={INPUT} value={direction} onChange={(e) => setDirection(e.target.value as "credit" | "debit")}>
            <option value="credit">Add credit to the tab</option>
            <option value="debit">Remove credit from the tab</option>
          </select>
        </div>
      )}

      <div>
        <label className={LABEL} htmlFor="tx-note">{type === "adjustment" ? "Reason (required)" : "Note (optional)"}</label>
        <input
          id="tx-note"
          className={INPUT}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder={type === "adjustment" ? "Why is this being corrected?" : "e.g. Bottle service round 2"}
          required={type === "adjustment"}
        />
      </div>

      {error && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      {last && !error && (
        <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          Logged. New balance <strong>{formatMoney(last.balanceAfter, currency)}</strong>.
        </p>
      )}

      <button type="button" className={`${BTN_PRIMARY} w-full !py-2.5`} onClick={submit} disabled={busy}>
        <Icon name="check" /> {busy ? "Logging…" : "Log transaction"}
      </button>
    </section>
  )
}

// ----------------------------------------------------------------------------

function CancelBookingDialog({
  booking,
  currency,
  onClose,
  onConfirm,
}: {
  booking: VvipBooking
  currency: string
  onClose: () => void
  onConfirm: (refund: boolean, reason: string) => Promise<string | null>
}) {
  const paid = booking.pricePaid > 0 && booking.paymentMethod !== "complimentary" && booking.paymentMethod !== "free"
  const toPassport = booking.paymentMethod === "wallet"
  const [refund, setRefund] = useState(paid)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Modal
      title={`Cancel ${booking.reference}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>Keep booking</button>
          <button
            type="button"
            className={BTN_DANGER}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              const err = await onConfirm(refund, reason)
              if (err) {
                setError(err)
                setBusy(false)
              }
            }}
          >
            {busy ? "Cancelling…" : "Cancel booking"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          The table goes back on sale and the unused tab credit is removed. A booking can only be cancelled before the guests are seated, and only if the tab has had no activity. Settle the tab first if it has.
        </p>
        {paid && (
          <label className={`${WELL} flex cursor-pointer items-start gap-3 p-3 text-sm`}>
            <input type="checkbox" className="mt-0.5" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
            <span>
              <span className="font-medium text-stone-800">Refund {formatMoney(booking.pricePaid, currency)}</span>
              <span className="block text-xs text-stone-500">
                {toPassport
                  ? "The money goes back to the customer's Passport."
                  : "This is recorded as refunded. Hand the money back yourself."}
              </span>
            </span>
          </label>
        )}
        <div>
          <label className={LABEL} htmlFor="cb-reason">Reason (optional)</label>
          <input id="cb-reason" className={INPUT} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        {error && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
