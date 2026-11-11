"use client"

// app/admin/events/BoxOffice.tsx
//
// Counter sales: pick a tier and quantity, choose how the customer pays, and
// sell. Cash, card and EFT are recorded; a Passport sale is charged to the
// customer's Passport (wallet) in the same step; complimentary tickets are for event
// managers only. "Admit now" marks the tickets as already inside, which is how
// door sales work (the buyer walks straight in).

import { useEffect, useMemo, useRef, useState } from "react"
import { loadPassportBalance, searchCustomers, sellTickets } from "./actions"
import { formatEventDate, formatMoney } from "./format"
import type { CustomerHit, EventSummary, PassportBalance, PaymentMethod, SaleReceipt } from "./types"
import { ACCENT_BG, ACCENT_RING, ACCENT_TEXT, BTN_GHOST, BTN_PRIMARY, Chip, EmptyState, FOCUS, INPUT, Icon, LABEL, PANEL, WELL } from "./ui"

const METHOD_LABEL: Record<PaymentMethod, { label: string; icon: string }> = {
  cash: { label: "Cash", icon: "money-bill-wave" },
  card: { label: "Card", icon: "credit-card" },
  eft: { label: "EFT", icon: "building-columns" },
  wallet: { label: "Passport", icon: "wallet" },
  complimentary: { label: "Complimentary", icon: "gift" },
}

export function BoxOffice({
  events,
  loadError,
  selectedId,
  onSelect,
  canComplimentary,
  canChargePassport,
  timezone,
  currency,
  onSold,
  onGoToEvents,
}: {
  events: EventSummary[] | null
  loadError: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  canComplimentary: boolean
  canChargePassport: boolean
  timezone: string
  currency: string
  onSold: () => Promise<void>
  onGoToEvents: () => void
}) {
  const onSale = useMemo(() => (events ?? []).filter((e) => e.status === "active"), [events])
  const event = onSale.find((e) => e.id === selectedId) ?? onSale[0] ?? null

  const [tierId, setTierId] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [method, setMethod] = useState<PaymentMethod>("cash")
  const [admit, setAdmit] = useState(true)
  const [customer, setCustomer] = useState<CustomerHit | null>(null)
  const [phone, setPhone] = useState("")
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<CustomerHit[]>([])
  const [passport, setPassport] = useState<PassportBalance | null>(null)
  const [passportError, setPassportError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null)
  // One key per attempt: a retry after a dropped connection can't sell twice.
  const keyRef = useRef<string>(crypto.randomUUID())

  const tiers = useMemo(() => (event?.ticketTypes ?? []).filter((t) => t.isActive), [event])
  const tier = tiers.find((t) => t.id === tierId) ?? null
  const left = tier ? Math.max(tier.capacity - tier.sold, 0) : 0

  // Pick the first tier that still has places whenever the event changes.
  useEffect(() => {
    const first = tiers.find((t) => t.capacity - t.sold > 0) ?? null
    setTierId(first?.id ?? null)
    setQty(1)
  }, [event?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // A different cart is a different sale: new key.
  useEffect(() => {
    keyRef.current = crypto.randomUUID()
  }, [event?.id, tierId, qty, method, customer?.id, admit])

  useEffect(() => {
    if (customer || query.trim().length < 2) {
      setHits([])
      return
    }
    const handle = setTimeout(async () => {
      const res = await searchCustomers(query)
      setHits(res.ok ? res.data : [])
    }, 250)
    return () => clearTimeout(handle)
  }, [query, customer])

  const unit = method === "complimentary" ? 0 : tier?.price ?? 0
  const total = unit * qty

  // Paying by Passport: look up the customer's balance so the shortfall shows before the sale.
  useEffect(() => {
    setPassport(null)
    setPassportError(null)
    if (method !== "wallet" || !customer) return
    let cancelled = false
    void loadPassportBalance(customer.id).then((res) => {
      if (cancelled) return
      if (res.ok) setPassport(res.data)
      else setPassportError(res.error)
    })
    return () => { cancelled = true }
  }, [method, customer])

  const short = method === "wallet" && passport !== null && passport.balance < total
  const blockedPassport = method === "wallet" && passport !== null && (passport.status === "blocked" || passport.status === "closed")
  const methods = (Object.keys(METHOD_LABEL) as PaymentMethod[]).filter(
    (m) => (m !== "wallet" || canChargePassport) && (m !== "complimentary" || canComplimentary),
  )

  async function sell() {
    if (!event || !tier) return
    if (method === "wallet" && !customer) return setError("Choose the customer whose Passport pays for this.")
    setError(null)
    setBusy(true)
    const res = await sellTickets({
      eventId: event.id,
      ticketTypeId: tier.id,
      quantity: qty,
      paymentMethod: method,
      customerId: customer?.id ?? null,
      phone: customer ? null : phone,
      admit,
      gate: "box_office",
      idempotencyKey: keyRef.current,
    })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    setReceipt(res.data)
    keyRef.current = crypto.randomUUID()
    await onSold()
  }

  function another() {
    setReceipt(null)
    setQty(1)
    setCustomer(null)
    setPhone("")
    setQuery("")
    setError(null)
  }

  if (loadError) return <EmptyState icon="triangle-exclamation" title="Couldn't load events">{loadError}</EmptyState>
  if (events === null) return <div className="h-64 animate-pulse rounded-3xl bg-stone-500/10" aria-busy="true" />
  if (!event) {
    return (
      <EmptyState
        icon="ticket"
        title="No events are on sale"
        action={<button type="button" className={BTN_GHOST} onClick={onGoToEvents}>Go to Events</button>}
      >
        Put an event on sale and it will appear here for counter sales.
      </EmptyState>
    )
  }

  if (receipt) {
    return (
      <div className={`${PANEL} mx-auto max-w-xl p-6`}>
        <div className="flex items-center gap-3">
          <span className={`flex h-11 w-11 items-center justify-center rounded-full ${ACCENT_BG}`}><Icon name="check" /></span>
          <div>
            <h2 className="text-lg font-bold text-stone-900">
              {receipt.tickets.length} {receipt.tickets.length === 1 ? "ticket" : "tickets"} sold
            </h2>
            <p className="text-sm text-stone-500">
              {receipt.total === 0 ? "No charge" : formatMoney(receipt.total, currency)} · {METHOD_LABEL[receipt.paymentMethod as PaymentMethod]?.label ?? "Free"}
            </p>
          </div>
        </div>
        <ul className="mt-5 grid gap-2 sm:grid-cols-2" aria-label="Ticket numbers">
          {receipt.tickets.map((t) => (
            <li key={t.ticketNumber} className={`${WELL} flex items-center justify-between px-3 py-2.5`}>
              <span className="font-mono text-sm font-semibold text-stone-900">{t.ticketNumber}</span>
              <Chip tone={t.status === "used" ? "neutral" : "good"}>{t.status === "used" ? "Admitted" : "Valid"}</Chip>
            </li>
          ))}
        </ul>
        <button type="button" className={`${BTN_PRIMARY} mt-6`} onClick={another}>
          <Icon name="plus" /> Sell more tickets
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
      <div className="space-y-6">
        <section className={`${PANEL} p-5`}>
          <label className={LABEL} htmlFor="bo-event">Event</label>
          <select id="bo-event" className={INPUT} value={event.id} onChange={(e) => onSelect(e.target.value)}>
            {onSale.map((e) => (
              <option key={e.id} value={e.id}>{e.name} · {formatEventDate(e.startTime, timezone)}</option>
            ))}
          </select>
        </section>

        <section className={`${PANEL} p-5`} aria-labelledby="bo-tier">
          <h2 id="bo-tier" className="mb-3 text-sm font-bold text-stone-900">Ticket</h2>
          {tiers.length === 0 ? (
            <p className="text-sm text-stone-500">This event has no tiers on sale.</p>
          ) : (
            <div role="radiogroup" aria-labelledby="bo-tier" className="grid gap-3 sm:grid-cols-2">
              {tiers.map((t) => {
                const remaining = Math.max(t.capacity - t.sold, 0)
                const active = t.id === tierId
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={remaining === 0}
                    onClick={() => { setTierId(t.id); setQty(1) }}
                    className={`rounded-2xl border bg-card p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS} ${
                      active ? `border-transparent ${ACCENT_RING}` : "border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-bold text-stone-900">{t.name}</span>
                      <span className={`text-sm font-bold ${ACCENT_TEXT}`}>{t.price === 0 ? "Free" : formatMoney(t.price, currency)}</span>
                    </span>
                    <span className="mt-1 block text-xs text-stone-500">
                      {remaining === 0 ? "Sold out" : `${remaining} left`}
                      {t.entriesAllowed > 1 ? ` · ${t.entriesAllowed} entries` : ""}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className={`${PANEL} p-5`} aria-labelledby="bo-cust">
          <h2 id="bo-cust" className="mb-1 text-sm font-bold text-stone-900">Customer</h2>
          <p className="mb-3 text-xs text-stone-500">
            Optional for cash, card and EFT. Needed for Passport, so the right Passport is charged.
          </p>
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
            <div className="space-y-2">
              <div className="relative">
                <input
                  className={INPUT}
                  placeholder="Search by name or phone"
                  aria-label="Search customers"
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
              <input
                className={INPUT}
                placeholder="Or a phone number for a walk-in (optional)"
                aria-label="Walk-in phone number"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          )}
        </section>
      </div>

      <aside className={`${PANEL} h-fit space-y-5 p-5 lg:sticky lg:top-6`} aria-label="Sale summary">
        <div>
          <span className={LABEL} id="bo-qty">Quantity</span>
          <div className="flex items-center gap-3" role="group" aria-labelledby="bo-qty">
            <button type="button" className={`${BTN_GHOST} !h-9 !w-9 !p-0`} aria-label="One fewer" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
              <Icon name="minus" />
            </button>
            <output className="w-10 text-center text-2xl font-bold text-stone-900" aria-live="polite">{qty}</output>
            <button type="button" className={`${BTN_GHOST} !h-9 !w-9 !p-0`} aria-label="One more" disabled={!tier || qty >= Math.min(left, 50)} onClick={() => setQty((q) => q + 1)}>
              <Icon name="plus" />
            </button>
          </div>
        </div>

        <div>
          <span className={LABEL} id="bo-pay">Payment</span>
          <div role="radiogroup" aria-labelledby="bo-pay" className="grid grid-cols-2 gap-2">
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
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={admit} onChange={(e) => setAdmit(e.target.checked)} />
          <span>
            <span className="font-medium text-stone-800">Admit at the door now</span>
            <span className="block text-xs text-stone-500">Marks the tickets as already inside. Turn off to hand them over for later.</span>
          </span>
        </label>

        <div className="border-t border-stone-200 pt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-stone-500">Total</span>
            <span className="text-2xl font-bold text-stone-900">{total === 0 ? "Free" : formatMoney(total, currency)}</span>
          </div>
          {method === "wallet" && (
            <div className={`${WELL} mt-3 px-3 py-2 text-sm`} aria-live="polite">
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
                  Passport balance <strong>{formatMoney(passport.balance, currency)}</strong>
                  {short ? `. ${formatMoney(total - passport.balance, currency)} short, so top up first.` : ""}
                </span>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
          <button type="button" className={`${BTN_PRIMARY} mt-4 w-full !py-2.5 !text-sm`} disabled={busy || !tier || left === 0 || short || blockedPassport} onClick={sell}>
            {busy ? "Selling…" : `Sell ${qty} ${qty === 1 ? "ticket" : "tickets"}`}
          </button>
        </div>
      </aside>
    </div>
  )
}
