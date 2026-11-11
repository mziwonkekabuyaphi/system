"use client"

// app/admin/vvip/VvipAnalyticsPanel.tsx
//
// The Rands "VVIP Analytics" overlay: KPIs, table availability per package, package sales, booking
// status breakdown, last 14 days of revenue, tab credit utilisation and top customers by spend.
// Drawn with plain CSS bars (no chart library), like events/AnalyticsPanel.tsx.
//
// Everything is real data. The package, booking and revenue figures come from the loaded
// VvipData (read page by page, so they are complete). Spend and top-ups come from the tab ledger via
// loadTabFlow. The old page's "Top Customers" list was a mock; this one is computed from the ledger.

import { useEffect, useMemo, useState } from "react"
import { dateKey, formatMoney, formatShortDate } from "../events/format"
import { ACCENT_TEXT, Chip, Icon, PANEL, ProgressBar, WELL } from "../events/ui"
import { loadTabFlow } from "./actions"
import { BOOKING_STATUS_LABEL, isLiveStatus, type BookingStatus, type VvipData, type VvipTabFlow } from "./types"

const DAYS = 14
const DAY_MS = 86_400_000
const STATUSES: BookingStatus[] = ["confirmed", "checked_in", "seated", "completed", "cancelled", "no_show"]

export function VvipAnalyticsPanel({
  data,
  timezone,
  currency,
  onClose,
}: {
  data: VvipData
  timezone: string
  currency: string
  onClose: () => void
}) {
  const [flow, setFlow] = useState<VvipTabFlow[] | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)

  // Spend and top-ups live in the ledger. Reloaded whenever the page's data is (after an action).
  useEffect(() => {
    let cancelled = false
    void loadTabFlow().then((res) => {
      if (cancelled) return
      if (res.ok) {
        setFlow(res.data)
        setFlowError(null)
      } else {
        setFlowError(res.error)
      }
    })
    return () => { cancelled = true }
  }, [data])

  const m = useMemo(() => {
    const live = data.bookings.filter((b) => isLiveStatus(b.status))
    const liveIds = new Set(live.map((b) => b.id))

    const availability = data.packages
      .filter((p) => p.status !== "archived")
      .map((p) => ({ id: p.id, name: p.name, booked: p.bookedCount, total: p.tables.length }))

    const sales = data.packages
      .filter((p) => p.revenue > 0 || p.bookedCount > 0)
      .map((p) => ({ id: p.id, name: p.name, revenue: p.revenue, tables: p.bookedCount }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6)

    const statusCounts = STATUSES.map((s) => ({ status: s, count: data.bookings.filter((b) => b.status === s).length }))

    // Last 14 days, in the shop's timezone, with empty days filled in. Each booking's net amount
    // (paid minus refunded) is attributed to the day it was made. Cancelled bookings are excluded.
    const days = new Map<string, number>()
    for (let i = DAYS - 1; i >= 0; i -= 1) days.set(dateKey(new Date(Date.now() - i * DAY_MS), timezone), 0)
    for (const b of data.bookings) {
      if (b.status === "cancelled") continue
      const key = dateKey(b.createdAt, timezone)
      if (days.has(key)) days.set(key, (days.get(key) ?? 0) + b.pricePaid - b.refundedAmount)
    }

    const issued = live.reduce((n, b) => n + b.tabCreditIssued, 0)
    const customerOf = new Map(data.bookings.map((b) => [b.id, { id: b.customerId, name: b.customerName }]))

    let spent = 0
    let toppedUp = 0
    const byCustomer = new Map<string, { name: string | null; spent: number }>()
    for (const f of flow ?? []) {
      // Utilisation counts live tabs only: a cancelled tab's credit was removed.
      if (liveIds.has(f.bookingId)) {
        spent += f.spent
        toppedUp += f.toppedUp
      }
      const who = customerOf.get(f.bookingId)
      if (!who || f.spent <= 0) continue
      const cur = byCustomer.get(who.id) ?? { name: who.name, spent: 0 }
      cur.spent += f.spent
      byCustomer.set(who.id, cur)
    }

    return {
      packages: data.packages.filter((p) => p.status !== "archived").length,
      availability,
      sales,
      statusCounts,
      trend: [...days.entries()].map(([date, amount]) => ({ date, amount })),
      issued,
      funded: issued + toppedUp,
      spent,
      top: [...byCustomer.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.spent - a.spent).slice(0, 5),
    }
  }, [data, flow, timezone])

  const maxDay = Math.max(1, ...m.trend.map((p) => p.amount))
  const maxSale = Math.max(1, ...m.sales.map((s) => s.revenue))
  const maxStatus = Math.max(1, ...m.statusCounts.map((s) => s.count))
  const utilPct = m.funded > 0 ? Math.round((m.spent / m.funded) * 100) : 0
  const trendSummary = m.trend.map((p) => `${formatShortDate(`${p.date}T12:00:00Z`, timezone)} ${formatMoney(p.amount, currency)}`).join(", ")

  return (
    <section className={`${PANEL} p-5`} aria-label="VVIP analytics">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold text-stone-900">
          <Icon name="chart-pie" className={ACCENT_TEXT} /> VVIP analytics
        </h2>
        <button type="button" onClick={onClose} aria-label="Close analytics" className="rounded-full p-1.5 text-stone-500 hover:bg-stone-500/10">
          <Icon name="xmark" />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Packages" value={String(m.packages)} />
        <Kpi label="Tables sold" value={String(data.summary.tablesSold)} />
        <Kpi label="Revenue" value={formatMoney(data.summary.revenue, currency)} />
        <Kpi label="Tab outstanding" value={formatMoney(data.summary.tabOutstanding, currency)} />
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Table availability</h3>
          {m.availability.length === 0 ? (
            <p className="text-sm text-stone-500">No packages yet.</p>
          ) : (
            <ul className="space-y-3">
              {m.availability.map((p) => (
                <li key={p.id}>
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="truncate font-medium text-stone-800">{p.name}</span>
                    <span className="shrink-0 text-stone-500">{p.booked} booked · {Math.max(p.total - p.booked, 0)} free</span>
                  </div>
                  <ProgressBar value={p.booked} max={p.total} label={`${p.name} tables booked`} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Package sales</h3>
          {m.sales.length === 0 ? (
            <p className="text-sm text-stone-500">No sales yet.</p>
          ) : (
            <ul className="space-y-3">
              {m.sales.map((s) => (
                <li key={s.id}>
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="truncate font-medium text-stone-800">{s.name}</span>
                    <span className="shrink-0 text-stone-500">{s.tables} {s.tables === 1 ? "table" : "tables"} · {formatMoney(s.revenue, currency)}</span>
                  </div>
                  <ProgressBar value={s.revenue} max={maxSale} label={`${s.name} revenue`} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Booking status</h3>
          <ul className="space-y-3">
            {m.statusCounts.map((s) => (
              <li key={s.status}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="font-medium text-stone-800">{BOOKING_STATUS_LABEL[s.status]}</span>
                  <span className="text-stone-500">{s.count}</span>
                </div>
                <ProgressBar value={s.count} max={maxStatus} label={`${BOOKING_STATUS_LABEL[s.status]} bookings`} />
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Revenue, last {DAYS} days</h3>
          <div role="img" aria-label={`Revenue per day: ${trendSummary}`}>
            <div className="flex h-32 items-end gap-1">
              {m.trend.map((p) => (
                <div key={p.date} className="flex h-full flex-1 items-end" title={`${formatShortDate(`${p.date}T12:00:00Z`, timezone)}: ${formatMoney(p.amount, currency)}`}>
                  <div
                    className="w-full rounded-t bg-[var(--sb-accent,var(--color-admin-accent))]"
                    style={{ height: `${Math.max(p.amount > 0 ? 4 : 1, (Math.max(p.amount, 0) / maxDay) * 100)}%`, opacity: p.amount > 0 ? 1 : 0.25 }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[0.65rem] text-stone-500">
              <span>{formatShortDate(`${m.trend[0].date}T12:00:00Z`, timezone)}</span>
              <span>{formatShortDate(`${m.trend[m.trend.length - 1].date}T12:00:00Z`, timezone)}</span>
            </div>
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Tab credit utilisation</h3>
          {flowError ? (
            <p role="alert" className="text-sm text-red-600">{flowError}</p>
          ) : !flow ? (
            <div className="h-16 animate-pulse rounded-xl bg-stone-500/10" aria-busy="true" />
          ) : (
            <div>
              <div className="mb-1 flex justify-between gap-2 text-xs">
                <span className="font-medium text-stone-800">{formatMoney(m.spent, currency)} spent</span>
                <span className="text-stone-500">of {formatMoney(m.funded, currency)} on live tabs</span>
              </div>
              <ProgressBar value={m.spent} max={m.funded} label="Tab credit spent" />
              <p className="mt-1.5 text-xs text-stone-500">
                {utilPct}% used. Credit issued {formatMoney(m.issued, currency)}{m.funded > m.issued ? ` plus ${formatMoney(m.funded - m.issued, currency)} in top-ups` : ""}.
              </p>
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Top customers by spend</h3>
          {flowError ? (
            <p className="text-sm text-stone-500">Unavailable right now.</p>
          ) : !flow ? (
            <div className="h-16 animate-pulse rounded-xl bg-stone-500/10" aria-busy="true" />
          ) : m.top.length === 0 ? (
            <p className="text-sm text-stone-500">No tab spend yet.</p>
          ) : (
            <ol className="space-y-2">
              {m.top.map((c, i) => (
                <li key={c.id} className={`${WELL} flex items-center justify-between gap-3 px-3 py-2 text-sm`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Chip tone="neutral">{i + 1}</Chip>
                    <span className="truncate font-medium text-stone-900">{c.name ?? "Unknown buyer"}</span>
                  </span>
                  <span className={`shrink-0 font-bold ${ACCENT_TEXT}`}>{formatMoney(c.spent, currency)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${WELL} px-4 py-3`}>
      <dd className="text-xl font-bold text-stone-900">{value}</dd>
      <dt className="mt-0.5 text-xs text-stone-500">{label}</dt>
    </div>
  )
}
