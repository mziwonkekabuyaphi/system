"use client"

// app/admin/vvip/BuyersView.tsx
//
// Section "tabs": four stat cards and a searchable, filterable, paged table of table buyers. The
// totals come from the server (computed over every booking, read page by page), not from the rows
// on screen. Row action opens the buyer panel.

import { useMemo, useState } from "react"
import { formatMoney } from "../events/format"
import { ACCENT_TEXT, BTN_GHOST, Chip, EmptyState, FOCUS, INPUT, Icon, PANEL, ProgressBar, WELL } from "../events/ui"
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE, type BookingStatus, type VvipBooking, type VvipData } from "./types"

const PAGE_SIZE = 25
const STATUS_FILTERS: Array<{ value: "all" | BookingStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "confirmed", label: BOOKING_STATUS_LABEL.confirmed },
  { value: "checked_in", label: BOOKING_STATUS_LABEL.checked_in },
  { value: "seated", label: BOOKING_STATUS_LABEL.seated },
  { value: "completed", label: BOOKING_STATUS_LABEL.completed },
  { value: "cancelled", label: BOOKING_STATUS_LABEL.cancelled },
  { value: "no_show", label: BOOKING_STATUS_LABEL.no_show },
]

function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

export function BuyersView({
  data,
  loadError,
  onRetry,
  tz,
  currency,
  onOpen,
  onGoToTables,
}: {
  data: VvipData | null
  loadError: string | null
  onRetry: () => void
  tz: string
  currency: string
  onOpen: (bookingId: string) => void
  onGoToTables: () => void
}) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<"all" | BookingStatus>("all")
  const [page, setPage] = useState(0)

  const rows = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.bookings.filter((b) => {
      if (status !== "all" && b.status !== status) return false
      if (!q) return true
      // Buyer, phone, package, table and reference.
      return [b.customerName, b.customerPhone, b.packageName, b.tableLabel, b.reference].some((v) => (v ?? "").toLowerCase().includes(q))
    })
  }, [data, query, status])

  if (loadError && !data) {
    return (
      <EmptyState icon="triangle-exclamation" title="Couldn't load VVIP tabs" action={<button type="button" className={BTN_GHOST} onClick={onRetry}>Try again</button>}>
        {loadError}
      </EmptyState>
    )
  }
  if (!data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-stone-500/10" />)}
        </div>
        <div className="h-64 animate-pulse rounded-2xl bg-stone-500/10" />
      </div>
    )
  }

  if (data.bookings.length === 0) {
    return (
      <EmptyState
        icon="receipt"
        title="No tables sold yet"
        action={data.packages.length === 0 ? <button type="button" className={BTN_GHOST} onClick={onGoToTables}>Go to VVIP tables</button> : undefined}
      >
        {data.packages.length === 0
          ? "Create a package first, then book tables for your customers."
          : "Book a table for a customer and their bar tab will appear here."}
      </EmptyState>
    )
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const { summary } = data

  return (
    <div className="space-y-5">
      {loadError && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{loadError}</p>}

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Table buyers" value={String(summary.buyers)} />
        <Stat label="Tables sold" value={String(summary.tablesSold)} />
        <Stat label="Tab balance outstanding" value={formatMoney(summary.tabOutstanding, currency)} accent />
        <Stat label="Revenue collected" value={formatMoney(summary.revenue, currency)} />
      </dl>

      <section className={`${PANEL} overflow-hidden`} aria-labelledby="buyers-h">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-5 py-3.5">
          <h3 id="buyers-h" className="flex items-center gap-2 text-sm font-bold text-stone-900">
            Table buyers <Chip>{rows.length}</Chip>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="buyers-status">Filter by status</label>
            <select id="buyers-status" className={`${INPUT} !w-auto`} value={status} onChange={(e) => { setStatus(e.target.value as "all" | BookingStatus); setPage(0) }}>
              {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <label className="sr-only" htmlFor="buyers-search">Search buyers</label>
            <input
              id="buyers-search"
              type="search"
              className={`${INPUT} !w-64 max-w-full`}
              placeholder="Search buyer, phone, package, table…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0) }}
            />
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-stone-500">No buyers match{query.trim() ? " your search" : " that filter"}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs text-stone-500">
                  <th scope="col" className="px-5 py-2.5 font-medium">Buyer</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Package</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Table</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Paid</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Tab balance</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => (
                  <BuyerRow key={b.id} booking={b} tz={tz} currency={currency} onOpen={() => onOpen(b.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 border-t border-stone-200 px-5 py-3 text-xs text-stone-500">
            <span>
              {current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, rows.length)} of {rows.length}
            </span>
            <div className="flex gap-2">
              <button type="button" className={BTN_GHOST} disabled={current === 0} onClick={() => setPage(current - 1)}>
                <Icon name="chevron-left" /> Previous
              </button>
              <button type="button" className={BTN_GHOST} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Next <Icon name="chevron-right" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`${WELL} px-4 py-3`}>
      <dd className={`text-xl font-bold ${accent ? ACCENT_TEXT : "text-stone-900"}`}>{value}</dd>
      <dt className="mt-0.5 text-xs text-stone-500">{label}</dt>
    </div>
  )
}

function BuyerRow({ booking: b, currency, onOpen }: { booking: VvipBooking; tz: string; currency: string; onOpen: () => void }) {
  // How much of the credit that was issued has been used. A top-up can push the balance above the
  // credit, so the bar is clamped. Display only.
  const used = Math.max(0, Math.min(b.tabCreditIssued, b.tabCreditIssued - b.tabBalance))
  const name = b.customerName ?? "Unknown buyer"
  return (
    <tr className="cursor-pointer border-b border-stone-200/70 last:border-0 hover:bg-stone-500/5" onClick={onOpen}>
      <td className="px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_14%,transparent)] text-xs font-bold ${ACCENT_TEXT}`} aria-hidden="true">
            {initials(b.customerName)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-stone-900">{name}</span>
            <span className="block truncate text-xs text-stone-500">{b.customerPhone ?? "No phone on file"} · {b.reference}</span>
          </span>
        </div>
      </td>
      <td className="px-3 py-3 text-stone-700">{b.packageName}</td>
      <td className="px-3 py-3 text-stone-700">{b.tableLabel ?? "–"}</td>
      <td className="px-3 py-3 text-stone-700">{b.pricePaid === 0 ? "Free" : formatMoney(b.pricePaid, currency)}</td>
      <td className="px-3 py-3">
        <span className="block font-semibold text-stone-900">{formatMoney(b.tabBalance, currency)}</span>
        <span className="mt-1 block w-28">
          <ProgressBar value={used} max={b.tabCreditIssued} label={`${name} tab used`} />
        </span>
      </td>
      <td className="px-3 py-3">
        <Chip tone={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Chip>
      </td>
      <td className="px-5 py-3 text-right">
        <button
          type="button"
          className={`${BTN_GHOST} ${FOCUS}`}
          aria-label={`View ${name}, table ${b.tableLabel ?? "none"}`}
          onClick={(e) => {
            // The row is clickable too; don't open twice.
            e.stopPropagation()
            onOpen()
          }}
        >
          View
        </button>
      </td>
    </tr>
  )
}
