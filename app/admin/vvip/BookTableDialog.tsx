"use client"

// app/admin/vvip/BookTableDialog.tsx
//
// Staff sell a table: pick a package, a table (or "first free"), the customer, how they pay, and
// optional notes. Cash, card and EFT are recorded; Passport is charged to the customer's Passport in
// the same step (their balance is shown first, so a shortfall is visible before the sale);
// complimentary is for VVIP managers only. The tab opens with the package's credit.
//
// The idempotency key is one per attempt and is replaced whenever the booking changes or after a
// success, so a dropped connection followed by a retry can't book (or charge) twice.

import { useEffect, useMemo, useRef, useState } from "react"
import type { CustomerHit, PassportBalance } from "../events/types"
import { formatMoney } from "../events/format"
import { ACCENT_BG, ACCENT_TEXT, BTN_GHOST, BTN_PRIMARY, FOCUS, INPUT, Icon, LABEL, Modal, WELL } from "../events/ui"
import { bookTable, loadVvipPassportBalance, searchVvipCustomers } from "./actions"
import type { BookablePayment, BookingReceipt, VvipPackage } from "./types"

const METHOD_LABEL: Record<BookablePayment, { label: string; icon: string }> = {
  cash: { label: "Cash", icon: "money-bill-wave" },
  card: { label: "Card", icon: "credit-card" },
  eft: { label: "EFT", icon: "building-columns" },
  wallet: { label: "Passport", icon: "wallet" },
  complimentary: { label: "Complimentary", icon: "gift" },
}

export function BookTableDialog({
  packages,
  currency,
  canComplimentary,
  canChargePassport,
  onClose,
  onBooked,
}: {
  packages: VvipPackage[]
  currency: string
  canComplimentary: boolean
  canChargePassport: boolean
  onClose: () => void
  onBooked: (receipt: BookingReceipt) => void
}) {
  // Only packages that are on sale and still have a free table can be booked.
  const bookable = useMemo(() => packages.filter((p) => p.status === "active" && p.tables.some((t) => !t.booked)), [packages])

  const [packageId, setPackageId] = useState(bookable[0]?.id ?? "")
  const [tableId, setTableId] = useState("")
  const [method, setMethod] = useState<BookablePayment>("cash")
  const [notes, setNotes] = useState("")
  const [customer, setCustomer] = useState<CustomerHit | null>(null)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<CustomerHit[]>([])
  const [passport, setPassport] = useState<PassportBalance | null>(null)
  const [passportError, setPassportError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef<string>(crypto.randomUUID())

  const pkg = bookable.find((p) => p.id === packageId) ?? null
  const freeTables = useMemo(() => (pkg ? pkg.tables.filter((t) => !t.booked) : []), [pkg])
  const price = pkg ? (method === "complimentary" ? 0 : pkg.price) : 0

  // A different booking is a different attempt: new key.
  useEffect(() => {
    keyRef.current = crypto.randomUUID()
  }, [packageId, tableId, method, customer?.id, notes])

  // Changing package invalidates a chosen table.
  useEffect(() => { setTableId("") }, [packageId])

  useEffect(() => {
    if (customer || query.trim().length < 2) {
      setHits([])
      return
    }
    const handle = setTimeout(async () => {
      const res = await searchVvipCustomers(query)
      setHits(res.ok ? res.data : [])
    }, 250)
    return () => clearTimeout(handle)
  }, [query, customer])

  // Paying by Passport: look up the balance so a shortfall shows before the sale.
  useEffect(() => {
    setPassport(null)
    setPassportError(null)
    if (method !== "wallet" || !customer) return
    let cancelled = false
    void loadVvipPassportBalance(customer.id).then((res) => {
      if (cancelled) return
      if (res.ok) setPassport(res.data)
      else setPassportError(res.error)
    })
    return () => { cancelled = true }
  }, [method, customer])

  const short = method === "wallet" && passport !== null && passport.balance < price
  const blockedPassport = method === "wallet" && passport !== null && (passport.status === "blocked" || passport.status === "closed")
  const methods = (Object.keys(METHOD_LABEL) as BookablePayment[]).filter(
    (m) => (m !== "wallet" || canChargePassport) && (m !== "complimentary" || canComplimentary),
  )

  async function submit() {
    if (!pkg) return
    if (!customer) return setError("Choose the customer who is booking.")
    setError(null)
    setBusy(true)
    const res = await bookTable({
      packageId: pkg.id,
      tableId: tableId || null,
      customerId: customer.id,
      paymentMethod: method,
      notes,
      idempotencyKey: keyRef.current,
    })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    keyRef.current = crypto.randomUUID()
    onBooked(res.data)
  }

  return (
    <Modal
      title="Book a table"
      size="lg"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={busy || !pkg || !customer || short || blockedPassport}>
            {busy ? "Booking…" : price === 0 ? "Book table" : `Book table · ${formatMoney(price, currency)}`}
          </button>
        </>
      }
    >
      {bookable.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">
          No table is available to book. A package needs to be active and have a free table.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="bk-pkg">Package</label>
              <select id="bk-pkg" className={INPUT} value={packageId} onChange={(e) => setPackageId(e.target.value)}>
                {bookable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.eventName ? ` · ${p.eventName}` : ""} · {formatMoney(p.price, currency)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="bk-table">Table</label>
              <select id="bk-table" className={INPUT} value={tableId} onChange={(e) => setTableId(e.target.value)}>
                <option value="">First free table ({freeTables.length} free)</option>
                {freeTables.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
          </div>
          {pkg && (
            <p className="text-xs text-stone-500">
              Comes with {formatMoney(pkg.tabCredit, currency)} of bar tab credit and {pkg.seatsPerTable} {pkg.seatsPerTable === 1 ? "seat" : "seats"}.
            </p>
          )}

          <div>
            <span className={LABEL} id="bk-cust">Customer</span>
            {customer ? (
              <div className={`${WELL} flex items-center justify-between px-3 py-2.5`}>
                <span className="text-sm text-stone-900">
                  <span className="font-semibold">{customer.name ?? "Customer"}</span>
                  <span className="ml-2 text-stone-500">{customer.phone}</span>
                </span>
                <button type="button" onClick={() => { setCustomer(null); setQuery("") }} className={`rounded-full px-2 py-1 text-xs font-semibold text-stone-600 hover:bg-stone-500/10 ${FOCUS}`}>
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  className={INPUT}
                  placeholder="Search by name or phone"
                  aria-labelledby="bk-cust"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {hits.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-stone-200 bg-card shadow-lg">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => { setCustomer(h); setHits([]) }}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-stone-500/10 ${FOCUS}`}
                        >
                          <span className="font-medium text-stone-900">{h.name ?? "Customer"}</span>
                          <span className="text-stone-500">{h.phone}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div>
            <span className={LABEL} id="bk-pay">Payment</span>
            <div role="radiogroup" aria-labelledby="bk-pay" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  onClick={() => setMethod(m)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${FOCUS} ${
                    method === m ? `border-transparent ${ACCENT_BG}` : "border-stone-200 text-stone-700 hover:bg-stone-500/10"
                  }`}
                >
                  <Icon name={METHOD_LABEL[m].icon} /> {METHOD_LABEL[m].label}
                </button>
              ))}
            </div>
            {method === "complimentary" && <p className="mt-2 text-xs text-stone-500">The table is given away: no charge, and the tab still opens with its credit.</p>}
            {method === "wallet" && (
              <div className={`${WELL} mt-2 px-3 py-2 text-sm`} aria-live="polite">
                {!customer ? (
                  <span className="text-stone-500">Choose a customer to check their Passport balance.</span>
                ) : passportError ? (
                  <span className="text-red-600">{passportError}</span>
                ) : !passport ? (
                  <span className="text-stone-500">Checking Passport…</span>
                ) : blockedPassport ? (
                  <span className="text-red-600">This Passport is {passport.status}{passport.blockReason ? `: ${passport.blockReason}` : "."}</span>
                ) : (
                  <span className={short ? "text-red-600" : "text-stone-700"}>
                    Passport balance <strong className={short ? "" : ACCENT_TEXT}>{formatMoney(passport.balance, currency)}</strong>
                    {short ? `. ${formatMoney(price - passport.balance, currency)} short, so top up first.` : ""}
                  </span>
                )}
              </div>
            )}
          </div>

          <div>
            <label className={LABEL} htmlFor="bk-notes">Notes (optional)</label>
            <textarea id="bk-notes" rows={2} className={INPUT} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
