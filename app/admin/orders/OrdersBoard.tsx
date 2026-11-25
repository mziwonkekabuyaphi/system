"use client"

// app/admin/orders/OrdersBoard.tsx
//
// Live board for the kitchen / counter. Replaces nothing from the old single-shop
// admin (that screen only managed products); this is the screen that lets staff
// work the orders customers place over WhatsApp.
//
// Refresh: polls listOrders() every 15s while the tab is visible, and again
// whenever the person returns to the tab. Moving an order uses a compare-and-set
// on the status the screen showed, so two devices can't both "advance" one order.

import { useCallback, useEffect, useMemo, useState } from "react"

import { acceptOrder, advanceOrder, assignDriver, cancelOrder, declineOrder, listOrders } from "./actions"
import { Pill, Stat, btn, cardCls, cx, inputCls, money, useNotice, useNow } from "./ui"
import { nextOrderStep, type AdminDriver, type AdminOrder, type AdminOrderVendor, type DriverDispatchMode, type OrderStatus } from "./types"

const POLL_MS = 15_000

export function OrdersBoard({
  orders,
  onOrdersChange,
  vendors,
  drivers,
  dispatchMode,
  canOperate,
  timezone,
  currency,
}: {
  orders: AdminOrder[]
  onOrdersChange: (next: AdminOrder[] | ((prev: AdminOrder[]) => AdminOrder[])) => void
  vendors: AdminOrderVendor[]
  drivers: AdminDriver[]
  dispatchMode: DriverDispatchMode
  canOperate: boolean
  timezone: string
  currency: string
}) {
  const [vendorFilter, setVendorFilter] = useState("")
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const { show, node } = useNotice()
  const now = useNow()

  const refresh = useCallback(
    async (quiet = true) => {
      setRefreshing(true)
      const res = await listOrders()
      setRefreshing(false)
      if (res.ok) onOrdersChange(res.data)
      else if (!quiet) show(res.error, true)
    },
    [onOrdersChange, show],
  )

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void refresh(true)
    const id = setInterval(tick, POLL_MS)
    document.addEventListener("visibilitychange", tick)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [refresh])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders.filter(
      (o) =>
        (!vendorFilter || o.vendorId === vendorFilter) &&
        (!q || o.orderNumber.toLowerCase().includes(q) || o.customerPhone.includes(q) || (o.customerName ?? "").toLowerCase().includes(q)),
    )
  }, [orders, vendorFilter, query])

  const by = (...s: OrderStatus[]) => visible.filter((o) => s.includes(o.status))
  const allColumns: Array<{ title: string; list: AdminOrder[] }> = [
    { title: "New", list: by("placed").reverse() }, // oldest first: that's the one to make next
    { title: "Preparing", list: by("preparing").reverse() },
    { title: "Ready", list: by("ready").reverse() },
    { title: "Out for delivery", list: by("out_for_delivery").reverse() },
  ]
  // The delivery column only appears once the shop has delivery orders on the board.
  const columns = allColumns.filter((c) => c.title !== "Out for delivery" || visible.some((o) => o.fulfilment === "delivery"))
  const scheduled = by("scheduled").sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor)))
  const awaitingPayment = by("pending")
  // Shops that don't auto-accept: oldest first, that's the customer who has waited longest.
  const awaitingAcceptance = by("awaiting_acceptance").reverse()
  const finished = by("collected", "completed", "cancelled")

  const openCount = orders.filter((o) => ["placed", "preparing", "ready", "out_for_delivery"].includes(o.status)).length

  async function advance(o: AdminOrder) {
    setBusy(o.id)
    const res = await advanceOrder(o.id, o.status)
    setBusy(null)
    if (!res.ok) {
      show(res.error, true)
      void refresh(true)
      return
    }
    onOrdersChange((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: res.data.status, paymentStatus: res.data.paymentStatus } : x)))
  }

  async function assign(o: AdminOrder, driverId: string | null) {
    setBusy(o.id)
    const res = await assignDriver(o.id, driverId)
    setBusy(null)
    if (!res.ok) {
      show(res.error, true)
      void refresh(true)
      return
    }
    onOrdersChange((prev) => prev.map((x) => (x.id === o.id ? { ...x, driverId: res.data.driverId, driverName: res.data.driverName } : x)))
    show(driverId ? `${o.orderNumber} given to ${res.data.driverName}.` : `${o.orderNumber} has no driver now.`)
  }

  async function accept(o: AdminOrder) {
    setBusy(o.id)
    const res = await acceptOrder(o.id)
    setBusy(null)
    if (!res.ok) {
      show(res.error, true)
      void refresh(true)
      return
    }
    onOrdersChange((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: res.data.status } : x)))
    show(`${o.orderNumber} accepted. The customer has been told.`)
  }

  async function decline(o: AdminOrder) {
    const paidNote =
      o.paymentStatus === "paid"
        ? o.paymentMethod === "wallet"
          ? " The customer's wallet will be refunded."
          : " It was paid by card, so the refund has to be done through your card provider."
        : ""
    if (!window.confirm(`Decline ${o.orderNumber}? The customer will be told.${paidNote}`)) return
    setBusy(o.id)
    const res = await declineOrder(o.id)
    setBusy(null)
    if (!res.ok) {
      show(res.error, true)
      void refresh(true)
      return
    }
    onOrdersChange((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: "cancelled", paymentStatus: res.data.paymentStatus } : x)))
    show(res.data.paymentStatus === "refund_pending" ? `${o.orderNumber} declined. Card refund still to do.` : `${o.orderNumber} declined. The customer has been told.`)
  }

  async function cancel(o: AdminOrder) {
    const paidNote =
      o.paymentStatus === "paid"
        ? o.paymentMethod === "wallet"
          ? " The customer's wallet will be refunded."
          : " It was paid by card, so the refund has to be done through your card provider."
        : ""
    if (!window.confirm(`Cancel ${o.orderNumber}?${paidNote}`)) return
    setBusy(o.id)
    const res = await cancelOrder(o.id)
    setBusy(null)
    if (!res.ok) {
      show(res.error, true)
      void refresh(true)
      return
    }
    onOrdersChange((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: "cancelled", paymentStatus: res.data.paymentStatus } : x)))
    show(res.data.paymentStatus === "refund_pending" ? `${o.orderNumber} cancelled. Card refund still to do.` : `${o.orderNumber} cancelled.`)
  }

  const card = (o: AdminOrder) => (
    <OrderCard key={o.id} order={o} now={now} timezone={timezone} currency={currency} busy={busy === o.id} canOperate={canOperate} onAdvance={advance} onCancel={cancel} onAccept={accept} onDecline={decline} drivers={drivers} dispatchMode={dispatchMode} onAssign={assign} />
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 items-stretch gap-3 lg:grid-cols-4">
        <Stat label="Open orders" value={openCount} hint="New, preparing or ready" />
        <Stat label="New" value={columns[0].list.length} hint="Waiting to be made" />
        <Stat label="Scheduled" value={orders.filter((o) => o.status === "scheduled").length} hint="Booked for later" />
        <Stat label="Awaiting payment" value={orders.filter((o) => o.status === "pending").length} hint="Card checkout not finished" />
      </div>

      {awaitingAcceptance.length > 0 && (
        <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-admin-text">
            Waiting for you to accept
            <Pill tone="warn">{awaitingAcceptance.length}</Pill>
          </h2>
          <p className="text-xs text-admin-text/60">The customer is waiting for your answer. Accepting sends the order to the board; declining cancels it and refunds a wallet payment.</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{awaitingAcceptance.map(card)}</div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input className={cx(inputCls, "max-w-xs")} placeholder="Search order number, name or phone" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search orders" />
        {vendors.length > 1 && (
          <select className={cx(inputCls, "max-w-[14rem]")} value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} aria-label="Filter by vendor">
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={cx(btn.ghost, "ml-auto")} onClick={() => void refresh(false)} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className={cx("grid gap-4", columns.length > 3 ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
        {columns.map((c) => (
          <section key={c.title} className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-medium text-admin-text">
              {c.title}
              <Pill>{c.list.length}</Pill>
            </h2>
            {c.list.length === 0 ? <p className="rounded-xl border border-dashed border-admin-text/15 px-4 py-8 text-center text-sm text-admin-text/50">Nothing here.</p> : c.list.map(card)}
          </section>
        ))}
      </div>

      {scheduled.length > 0 && (
        <Group title="Scheduled for later" count={scheduled.length} defaultOpen>
          {scheduled.map(card)}
        </Group>
      )}
      {awaitingPayment.length > 0 && (
        <Group title="Waiting for card payment" count={awaitingPayment.length} hint="These move on by themselves when the payment comes through, or expire after 30 minutes.">
          {awaitingPayment.map(card)}
        </Group>
      )}
      <Group title="Finished in the last 24 hours" count={finished.length}>
        {finished.map(card)}
      </Group>
      {node}
    </div>
  )
}

function Group({ title, count, hint, defaultOpen = false, children }: { title: string; count: number; hint?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="space-y-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-2 text-sm font-medium text-admin-text">
        <span className={cx("inline-block transition-transform", open && "rotate-90")} aria-hidden="true">
          ›
        </span>
        {title}
        <Pill>{count}</Pill>
      </button>
      {open && (
        <>
          {hint && <p className="text-xs text-admin-text/60">{hint}</p>}
          {count === 0 ? <p className="text-sm text-admin-text/50">Nothing here.</p> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>}
        </>
      )}
    </section>
  )
}

function timeLabel(iso: string, timezone: string, withDate: boolean) {
  const d = new Date(iso)
  const time = new Intl.DateTimeFormat("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(d)
  if (!withDate) return time
  return `${new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", timeZone: timezone }).format(d)}, ${time}`
}

function ago(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ${m % 60} min ago`
}

function PaymentBadge({ o }: { o: AdminOrder }) {
  if (o.paymentStatus === "paid") return <Pill tone="good">Paid · {o.paymentMethod}</Pill>
  if (o.paymentStatus === "refunded") return <Pill tone="info">Refunded</Pill>
  if (o.paymentStatus === "refund_pending") return <Pill tone="warn">Card refund to do</Pill>
  if (o.paymentStatus === "failed") return <Pill tone="bad">Payment failed</Pill>
  if (o.paymentMethod === "cash") return <Pill tone="warn">Cash due</Pill>
  return <Pill tone="warn">Awaiting payment</Pill>
}

function OrderCard({
  order: o,
  now,
  timezone,
  currency,
  busy,
  canOperate,
  onAdvance,
  onCancel,
  onAccept,
  onDecline,
  drivers,
  dispatchMode,
  onAssign,
}: {
  order: AdminOrder
  now: number
  timezone: string
  currency: string
  busy: boolean
  canOperate: boolean
  onAdvance: (o: AdminOrder) => void
  onCancel: (o: AdminOrder) => void
  onAccept: (o: AdminOrder) => void
  onDecline: (o: AdminOrder) => void
  drivers: AdminDriver[]
  dispatchMode: DriverDispatchMode
  onAssign: (o: AdminOrder, driverId: string | null) => void
}) {
  const waiting = o.status === "awaiting_acceptance"
  const next = nextOrderStep(o.status, o.fulfilment)
  const cancellable = !["collected", "completed", "cancelled"].includes(o.status)
  const closed = o.status === "cancelled"
  const driverStage = o.fulfilment === "delivery" && ["scheduled", "placed", "preparing", "ready", "out_for_delivery"].includes(o.status)
  const activeDrivers = drivers.filter((d) => d.isActive || d.id === o.driverId)
  return (
    <article className={cx(cardCls, "space-y-3 p-4", closed && "opacity-60")}>
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-admin-text">{o.orderNumber}</p>
          <p className="text-xs text-admin-text/60">
            {ago(o.createdAt, now)} · {timeLabel(o.createdAt, timezone, false)}
          </p>
        </div>
        <p className="font-medium tabular-nums text-admin-text">{money(o.total, currency)}</p>
      </header>

      <ul className="space-y-1 text-sm text-admin-text">
        {o.items.map((i, idx) => (
          <li key={idx} className="flex gap-2">
            <span className="w-7 shrink-0 tabular-nums text-admin-text/60">{i.quantity}×</span>
            <span>{i.name}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-1 text-xs text-admin-text/70">
        <p>
          {o.customerName || "Customer"} · <a className="underline-offset-2 hover:underline" href={`tel:+${o.customerPhone.replace(/\D/g, "")}`}>{o.customerPhone}</a>
        </p>
        {o.fulfilment === "delivery" ? (
          <>
            <p className="font-medium text-admin-text">Deliver to {o.deliveryAddress}</p>
            <p>
              {o.deliveryArea}
              {o.deliveryFee > 0 ? ` · delivery fee ${money(o.deliveryFee, currency)}` : ""}
            </p>
            <p>Pick up from {o.collectionPoint || o.vendorName}</p>
          </>
        ) : o.fulfilment === "dine_in" ? (
          <>
            <p className="font-medium text-admin-text">Dine-in{o.tableLabel ? ` · table ${o.tableLabel}` : ""}</p>
            <p>Prepare at {o.collectionPoint || o.vendorName}</p>
          </>
        ) : (
          <>
            <p>Collect from {o.collectionPoint || o.vendorName}</p>
            {o.tableLabel && <p>Table {o.tableLabel}</p>}
          </>
        )}
        {o.scheduledFor && o.status === "scheduled" && <p className="font-medium text-admin-text">For {timeLabel(o.scheduledFor, timezone, true)}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {closed ? <Pill tone="bad">Cancelled</Pill> : ["collected", "completed"].includes(o.status) ? <Pill tone="good">{o.fulfilment === "delivery" ? "Delivered" : o.fulfilment === "dine_in" ? "Served" : "Collected"}</Pill> : null}
        {waiting && <Pill tone="warn">Needs accepting</Pill>}
        <PaymentBadge o={o} />
        {driverStage && o.driverId && <Pill tone="info">Driver: {o.driverName ?? "assigned"}</Pill>}
        {driverStage && !o.driverId && o.status === "ready" && <Pill tone="warn">{dispatchMode === "first_come" ? "Waiting for a driver to take it" : "Needs a driver"}</Pill>}
      </div>

      {canOperate && driverStage && (activeDrivers.length > 0 || o.driverId) && (
        <label className="flex items-center gap-2 text-xs text-admin-text/70">
          <span className="shrink-0">Driver</span>
          <select
            className={cx(inputCls, "py-1.5")}
            value={o.driverId ?? ""}
            disabled={busy}
            onChange={(e) => onAssign(o, e.target.value || null)}
            aria-label={`Driver for ${o.orderNumber}`}
          >
            <option value="">{dispatchMode === "first_come" ? "Open to all drivers" : "No driver yet"}</option>
            {activeDrivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.onDuty ? "● " : ""}
                {d.name}
                {d.isActive ? "" : " (switched off)"}
              </option>
            ))}
          </select>
        </label>
      )}

      {canOperate && waiting && (
        <div className="flex gap-2 pt-1">
          <button type="button" className={cx(btn.primary, "flex-1")} disabled={busy} onClick={() => onAccept(o)}>
            {busy ? "Saving…" : "Accept order"}
          </button>
          <button type="button" className={btn.danger} disabled={busy} onClick={() => onDecline(o)}>
            Decline
          </button>
        </div>
      )}

      {canOperate && !waiting && (next || cancellable) && (
        <div className="flex gap-2 pt-1">
          {next && (
            <button type="button" className={cx(btn.primary, "flex-1")} disabled={busy} onClick={() => onAdvance(o)}>
              {busy ? "Saving…" : next.label}
            </button>
          )}
          {cancellable && (
            <button type="button" className={btn.danger} disabled={busy} onClick={() => onCancel(o)}>
              Cancel
            </button>
          )}
        </div>
      )}
    </article>
  )
}
