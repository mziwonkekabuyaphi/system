"use client"

// app/admin/events/AnalyticsPanel.tsx
//
// The Rands "Event Analytics" overlay: KPIs, revenue trend, sales by tier,
// attendance vs capacity, top events and alerts. Drawn with plain CSS bars so
// the page needs no chart library. Sales figures need tickets.view; without it
// the panel still shows tickets and capacity (those come from the tier counters).

import { useEffect, useMemo, useState } from "react"
import { loadRevenueTrend } from "./actions"
import { formatEventDate, formatMoney, formatShortDate } from "./format"
import type { EventSummary, RevenuePoint } from "./types"
import { ACCENT_TEXT, Chip, Icon, PANEL, ProgressBar, WELL } from "./ui"

export function AnalyticsPanel({
  events,
  timezone,
  currency,
  canSeeSales,
  onClose,
}: {
  events: EventSummary[]
  timezone: string
  currency: string
  canSeeSales: boolean
  onClose: () => void
}) {
  const [trend, setTrend] = useState<RevenuePoint[] | null>(null)
  const [trendError, setTrendError] = useState<string | null>(null)

  useEffect(() => {
    if (!canSeeSales) return
    let cancelled = false
    void loadRevenueTrend(timezone, 14).then((res) => {
      if (cancelled) return
      if (res.ok) setTrend(res.data)
      else setTrendError(res.error)
    })
    return () => { cancelled = true }
  }, [timezone, canSeeSales])

  const m = useMemo(() => {
    const counted = events.filter((e) => e.status !== "draft")
    const gross = counted.reduce((n, e) => n + e.stats.gross, 0)
    const refunded = counted.reduce((n, e) => n + e.stats.refunded, 0)
    const sold = events.reduce((n, e) => n + e.ticketTypes.reduce((s, t) => s + t.sold, 0), 0)
    const admitted = events.reduce((n, e) => n + e.stats.ticketsAdmitted, 0)
    const live = events.filter((e) => e.status === "active").length

    const tiers = new Map<string, { sold: number; capacity: number }>()
    for (const e of events) {
      for (const t of e.ticketTypes) {
        const key = t.name.trim()
        const cur = tiers.get(key) ?? { sold: 0, capacity: 0 }
        cur.sold += t.sold
        cur.capacity += t.capacity
        tiers.set(key, cur)
      }
    }

    const alerts: Array<{ tone: "bad" | "warn"; text: string }> = []
    const now = Date.now()
    for (const e of events.filter((x) => x.status === "active")) {
      for (const t of e.ticketTypes.filter((x) => x.isActive && x.capacity > 0)) {
        const leftPct = (t.capacity - t.sold) / t.capacity
        if (t.sold >= t.capacity) alerts.push({ tone: "warn", text: `${e.name}: ${t.name} is sold out.` })
        else if (leftPct <= 0.15) alerts.push({ tone: "warn", text: `${e.name}: only ${t.capacity - t.sold} ${t.name} left.` })
      }
      const total = e.ticketTypes.reduce((n, t) => n + t.sold, 0)
      const hoursAway = (Date.parse(e.startTime) - now) / 3_600_000
      if (total === 0 && hoursAway > 0 && hoursAway < 48) alerts.push({ tone: "bad", text: `${e.name} starts within 48 hours and has no sales.` })
      if (e.stats.failedScans >= 5) alerts.push({ tone: "bad", text: `${e.name}: ${e.stats.failedScans} tickets were refused at the gate.` })
    }

    return {
      gross,
      refunded,
      sold,
      admitted,
      live,
      tiers: [...tiers.entries()].sort((a, b) => b[1].sold - a[1].sold),
      top: [...events].sort((a, b) => b.stats.gross - b.stats.refunded - (a.stats.gross - a.stats.refunded)).slice(0, 5),
      attendance: events.filter((e) => e.status === "active" || e.status === "ended").slice(0, 6),
      alerts,
    }
  }, [events])

  const maxDay = Math.max(1, ...(trend ?? []).map((p) => p.gross))
  const trendSummary = (trend ?? []).map((p) => `${formatShortDate(p.date + "T12:00:00Z", timezone)} ${formatMoney(p.gross, currency)}`).join(", ")

  return (
    <section className={`${PANEL} p-5`} aria-label="Event analytics">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold text-stone-900">
          <Icon name="chart-pie" className={ACCENT_TEXT} /> Event analytics
        </h2>
        <button type="button" onClick={onClose} aria-label="Close analytics" className="rounded-full p-1.5 text-stone-500 hover:bg-stone-500/10">
          <Icon name="xmark" />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {canSeeSales && <Kpi label="Gross sales" value={formatMoney(m.gross, currency)} />}
        {canSeeSales && <Kpi label="After refunds" value={formatMoney(m.gross - m.refunded, currency)} />}
        <Kpi label="Tickets sold" value={String(m.sold)} />
        <Kpi label="Check-in rate" value={m.sold > 0 ? `${Math.round((m.admitted / m.sold) * 100)}%` : "–"} />
        <Kpi label="Events on sale" value={String(m.live)} />
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {canSeeSales && (
          <div>
            <h3 className="mb-3 text-xs font-bold text-stone-700">Sales, last 14 days</h3>
            {trendError ? (
              <p role="alert" className="text-sm text-red-600">{trendError}</p>
            ) : !trend ? (
              <div className="h-32 animate-pulse rounded-xl bg-stone-500/10" aria-busy="true" />
            ) : (
              <div role="img" aria-label={`Sales per day: ${trendSummary}`}>
                <div className="flex h-32 items-end gap-1">
                  {trend.map((p) => (
                    <div key={p.date} className="flex h-full flex-1 items-end" title={`${formatShortDate(p.date + "T12:00:00Z", timezone)}: ${formatMoney(p.gross, currency)}`}>
                      <div
                        className="w-full rounded-t bg-[var(--sb-accent,var(--color-admin-accent))]"
                        style={{ height: `${Math.max(p.gross > 0 ? 4 : 1, (p.gross / maxDay) * 100)}%`, opacity: p.gross > 0 ? 1 : 0.25 }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[0.65rem] text-stone-500">
                  <span>{formatShortDate(trend[0].date + "T12:00:00Z", timezone)}</span>
                  <span>{formatShortDate(trend[trend.length - 1].date + "T12:00:00Z", timezone)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Sales by ticket tier</h3>
          {m.tiers.length === 0 ? (
            <p className="text-sm text-stone-500">No tiers yet.</p>
          ) : (
            <ul className="space-y-3">
              {m.tiers.map(([name, v]) => (
                <li key={name}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-medium text-stone-800">{name}</span>
                    <span className="text-stone-500">{v.sold} of {v.capacity}</span>
                  </div>
                  <ProgressBar value={v.sold} max={v.capacity} label={`${name} sold`} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-3 text-xs font-bold text-stone-700">Attendance vs tickets sold</h3>
          {m.attendance.length === 0 ? (
            <p className="text-sm text-stone-500">Attendance appears once an event is on sale.</p>
          ) : (
            <ul className="space-y-3">
              {m.attendance.map((e) => {
                const sold = e.ticketTypes.reduce((n, t) => n + t.sold, 0)
                return (
                  <li key={e.id}>
                    <div className="mb-1 flex justify-between gap-2 text-xs">
                      <span className="truncate font-medium text-stone-800">{e.name}</span>
                      <span className="shrink-0 text-stone-500">{e.stats.ticketsAdmitted} in of {sold}</span>
                    </div>
                    <ProgressBar value={e.stats.ticketsAdmitted} max={sold} label={`${e.name} checked in`} />
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {canSeeSales && (
          <div>
            <h3 className="mb-3 text-xs font-bold text-stone-700">Top events by sales</h3>
            {m.top.length === 0 ? (
              <p className="text-sm text-stone-500">No events yet.</p>
            ) : (
              <ol className="space-y-2">
                {m.top.map((e) => (
                  <li key={e.id} className={`${WELL} flex items-center justify-between gap-3 px-3 py-2 text-sm`}>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-stone-900">{e.name}</span>
                      <span className="block text-xs text-stone-500">{formatEventDate(e.startTime, timezone)}</span>
                    </span>
                    <span className={`shrink-0 font-bold ${ACCENT_TEXT}`}>{formatMoney(e.stats.gross - e.stats.refunded, currency)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      <div className="mt-6">
        <h3 className="mb-3 text-xs font-bold text-stone-700">Alerts</h3>
        {m.alerts.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing needs attention.</p>
        ) : (
          <ul className="space-y-2">
            {m.alerts.map((a, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-stone-700">
                <Chip tone={a.tone}>{a.tone === "bad" ? "Check" : "Heads up"}</Chip> {a.text}
              </li>
            ))}
          </ul>
        )}
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
