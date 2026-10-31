"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { getAnalytics } from "./actions"
import { BarChart, Donut, HBars, LineChart } from "./charts"
import {
  WEEKDAYS, formatCents, formatDuration, formatMoney, formatNum, formatPct, pctChange, pctOf,
  type AnalyticsData, type Preset,
} from "./model"

type TabId = "overview" | "bookings" | "queue" | "shisha" | "customers" | "services" | "staff" | "messaging" | "billing" | "payroll"

const PRESETS: { id: Preset; label: string }[] = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "custom", label: "Custom" },
]

// ------------------------------------------------------------------ primitives
function Card({ title, note, children, className = "" }: { title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-stone-200 bg-white p-4 ${className}`}>
      <h3 className="text-sm font-medium text-stone-900">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-stone-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Kpi({
  label, value, cur, prev, hint, lowerIsBetter = false, compare,
}: { label: string; value: string; cur?: number | null; prev?: number | null; hint?: string; lowerIsBetter?: boolean; compare: boolean }) {
  const change = compare ? pctChange(cur, prev) : null
  const good = change == null || change === 0 ? null : lowerIsBetter ? change < 0 : change > 0
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">{value}</p>
      {compare && (
        <p className={`mt-1 text-xs ${good == null ? "text-stone-500" : good ? "text-emerald-700" : "text-red-700"}`}>
          {change == null
            ? prev === 0 ? "No prior-period base" : "–"
            : `${change > 0 ? "▲" : change < 0 ? "▼" : "•"} ${Math.abs(change).toFixed(1)}% vs previous`}
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  )
}

function Grid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const c = cols === 2 ? "lg:grid-cols-2" : cols === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"
  return <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${c}`}>{children}</div>
}

function Table({ cols, rows, empty = "Nothing to show for this period." }: {
  cols: { h: string; align?: "right" }[]; rows: ReactNode[][]; empty?: string
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-stone-500">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-xs text-stone-500">
            {cols.map((c) => <th key={c.h} scope="col" className={`py-2 pr-4 font-medium ${c.align === "right" ? "text-right" : ""}`}>{c.h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-stone-100 last:border-0">
              {r.map((cell, j) => <td key={j} className={`py-2 pr-4 tabular-nums ${cols[j].align === "right" ? "text-right" : ""}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">{children}</p>
)

function Skeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading analytics">
      <Grid>{Array.from({ length: 8 }, (_, i) => <div key={i} className="h-24 rounded-xl bg-stone-200/70" />)}</Grid>
      <div className="h-64 rounded-xl bg-stone-200/70" />
    </div>
  )
}

// ------------------------------------------------------------------ dashboard
export function AnalyticsDashboard() {
  const [preset, setPreset] = useState<Preset>("30d")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [compare, setCompare] = useState(true)
  const [tab, setTab] = useState<TabId>("overview")
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    if (preset === "custom" && !(from && to)) { setLoading(false); return }
    const id = ++reqId.current // ignore stale responses when filters change quickly
    setLoading(true)
    const res = await getAnalytics({ preset, from, to, compare }).catch(() => null)
    if (id !== reqId.current) return
    if (!res || !res.ok) {
      setError(res && !res.ok ? res.error : "Couldn't reach the server. Check your connection and retry.")
    } else {
      const { ok: _ok, ...rest } = res
      setData(rest); setError(null)
    }
    setLoading(false)
  }, [preset, from, to, compare])

  useEffect(() => { void load() }, [load])

  // Tabs follow the modules switched on for the shop (same idea as Billing):
  // Bookings needs Booking, Queue needs Queue, Shisha needs Shisha, and the
  // customer-facing tabs (Customers, Services, Messaging) need Booking or Queue.
  const pr = data?.products
  const runsBookingQueue = !!pr && (pr.booking || pr.queue)
  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    ...(pr?.booking ? [{ id: "bookings" as const, label: "Bookings" }] : []),
    ...(pr?.queue ? [{ id: "queue" as const, label: "Queue" }] : []),
    ...(pr?.shisha && data?.shisha ? [{ id: "shisha" as const, label: "Shisha" }] : []),
    ...(runsBookingQueue
      ? [{ id: "customers" as const, label: "Customers" }, { id: "services" as const, label: "Services" }]
      : []),
    { id: "staff", label: "Staff" },
    ...(runsBookingQueue ? [{ id: "messaging" as const, label: "Messaging" }] : []),
    ...(data?.billing ? [{ id: "billing" as const, label: "Invoices" }] : []),
    ...(data?.payroll ? [{ id: "payroll" as const, label: "Payroll" }] : []),
  ]
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "overview"

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Reporting period" className="inline-flex overflow-hidden rounded-lg border border-stone-200 bg-white">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => setPreset(p.id)} aria-pressed={preset === p.id}
              className={`px-3 py-2 text-sm transition-colors ${preset === p.id ? "bg-admin-accent text-admin-on-accent" : "text-stone-700 hover:bg-stone-50"}`}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <>
            <label className="text-xs text-stone-500">From
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900" />
            </label>
            <label className="text-xs text-stone-500">To (inclusive)
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
                className="mt-1 block rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900" />
            </label>
          </>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm text-stone-700">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          Compare with previous period
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="mb-0.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50">
          Refresh
        </button>
      </div>

      {data && (
        <p className="text-xs text-stone-500">
          {data.range.start} to {lastDay(data.range.end)} ({data.timezone})
          {data.prevRange && ` · compared with ${data.prevRange.start} to ${lastDay(data.prevRange.end)}`}
        </p>
      )}

      {preset === "custom" && !(from && to) && <Note>Choose a start and end date to load a custom period.</Note>}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="rounded-md border border-red-300 bg-white px-3 py-1 text-red-800 hover:bg-red-100">Retry</button>
        </div>
      )}
      {data?.warnings.map((w) => <Note key={w}>{w}</Note>)}

      {!data && loading && <Skeleton />}

      {data && (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
          <div role="tablist" aria-label="Analytics sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-stone-200">
            {tabs.map((t) => (
              <button key={t.id} role="tab" type="button" aria-selected={activeTab === t.id} onClick={() => setTab(t.id)}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${activeTab === t.id ? "border-admin-accent font-medium text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="space-y-4">
            <Section tab={activeTab} d={data} compare={compare && !!data.previous} />
          </div>
        </div>
      )}
    </div>
  )
}

/** end is exclusive; show the last included day */
function lastDay(endExclusive: string): string {
  const d = new Date(`${endExclusive}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// ------------------------------------------------------------------ sections
function Section({ tab, d, compare }: { tab: TabId; d: AnalyticsData; compare: boolean }) {
  const c = d.current, p = d.previous
  const dates = c.daily.map((r) => r.date)
  const daily = (k: keyof (typeof c.daily)[number]) => c.daily.map((r) => Number(r[k]))
  const hours = (rows: { hour: number; count: number }[]) => rows.map((r) => ({ label: String(r.hour), value: r.count }))
  const days = (rows: { dow: number; count: number }[]) => rows.map((r) => ({ label: WEEKDAYS[r.dow], value: r.count }))
  const K = (label: string, cur: number | null, prev: number | null | undefined, extra?: { hint?: string; lowerIsBetter?: boolean; fmt?: string }) => (
    <Kpi label={label} value={extra?.fmt ?? formatNum(cur)} cur={cur} prev={prev} compare={compare} hint={extra?.hint} lowerIsBetter={extra?.lowerIsBetter} />
  )

  // Which modules this shop runs. Everything below only draws figures for modules that are on.
  const { booking, queue, shisha } = d.products
  const bq = booking || queue
  const sh = d.shisha
  const shp = d.shishaPrevious
  const money = (v: number) => formatMoney(v, d.currency)
  // Shisha KPI: same as K, but compared against the previous Shisha window.
  const KS = (label: string, cur: number | null, prev: number | null | undefined, extra?: { hint?: string; fmt?: string }) => (
    <Kpi label={label} value={extra?.fmt ?? formatNum(cur)} cur={cur} prev={prev} compare={compare && !!shp} hint={extra?.hint} />
  )

  if (tab === "overview") {
    const outstanding = d.billing?.outstanding_all_time ?? []
    const activitySeries = [
      ...(booking ? [{ name: "Appointments scheduled", values: daily("appointments_scheduled") }] : []),
      ...(queue ? [{ name: "Walk-ins", values: daily("walk_ins") }] : []),
      ...(bq ? [{ name: "Completed visits", values: daily("completed_visits") }] : []),
    ]
    return (
      <>
        {!bq && !sh && (
          <Note>No Booking, Queue or Shisha module is switched on for your shop yet, so there are no activity figures to show.</Note>
        )}
        <Grid>
          {booking && K("Bookings created", c.bookings.created, p?.bookings.created, { hint: "By creation date" })}
          {booking && K("Appointments scheduled", c.bookings.scheduled, p?.bookings.scheduled, { hint: "By appointment date, excl. cancelled" })}
          {bq && K("Completed visits", c.customers.completed_visits, p?.customers.completed_visits, { hint: "Done queue entries + completed bookings, no double count" })}
          {booking && K("Cancelled (of created)", c.bookings.created_cancelled, p?.bookings.created_cancelled, { lowerIsBetter: true, hint: "Bookings created in period, now cancelled" })}
          {queue && K("Walk-in queue entries", c.queue.walk_in, p?.queue.walk_in)}
          {queue && K("Queue entries done", c.queue.done, p?.queue.done, { hint: "Joined in period, now done" })}
          {bq && K("Unique customers served", c.customers.served, p?.customers.served, { hint: "Distinct customers with a completed visit" })}
          {sh && KS("Shisha sessions", sh.sessions_started, shp?.sessions_started, { hint: "Started in period" })}
          {sh && KS("Shisha refills", sh.refills, shp?.refills)}
          {sh && KS("Shisha revenue", sh.revenue, shp?.revenue, { fmt: money(sh.revenue), hint: "Completed sessions, incl. refills" })}
          {K("Active staff", c.staff.active_count, null, { hint: "Current snapshot" })}
          {bq && K("Conversations created", c.messaging.conversations_created, p?.messaging.conversations_created)}
          {bq && K("Incoming messages", c.messaging.incoming, p?.messaging.incoming)}
          {bq && K("Outgoing messages", c.messaging.outgoing, p?.messaging.outgoing, { hint: "Sent, not confirmed delivered" })}
          {d.billing && (
            <div className="rounded-xl border border-stone-200 bg-white p-4">
              <p className="text-xs text-stone-500">Outstanding invoices</p>
              {outstanding.length === 0
                ? <p className="mt-1 text-2xl font-semibold text-stone-900">None</p>
                : outstanding.map((o) => (
                    <p key={o.currency} className="mt-1 text-lg font-semibold tabular-nums text-stone-900">
                      {formatCents(o.amount_cents, o.currency)}
                      <span className="ml-1 text-xs font-normal text-stone-500">{o.count} issued/overdue</span>
                    </p>
                  ))}
              <p className="mt-1 text-xs text-stone-500">All time, excl. void</p>
            </div>
          )}
          {d.payroll && (
            <Kpi label="Payroll (final pay)" value={formatMoney(d.payroll.final, d.payroll.currency ?? d.currency)} compare={false}
              hint="Periods inside the range" />
          )}
        </Grid>
        <Grid cols={2}>
          {bq && (
            <Card title="Activity per day" note="Appointments by appointment date; walk-ins and completed visits by event time.">
              <LineChart label="Activity per day" labels={dates} series={activitySeries} />
            </Card>
          )}
          {bq && (
            <Card title="Messages per day">
              <LineChart label="Messages per day" labels={dates} series={[
                { name: "Incoming", values: daily("messages_in") }, { name: "Outgoing", values: daily("messages_out") },
              ]} />
            </Card>
          )}
          {booking && (
            <Card title="Booking status" note="Bookings created in this period, by current status.">
              <Donut label="Booking status" data={[
                { label: "Confirmed", value: c.bookings.created_confirmed },
                { label: "Completed", value: c.bookings.created_completed },
                { label: "Cancelled", value: c.bookings.created_cancelled },
              ]} />
            </Card>
          )}
          {bq && (
            <Card title="Top services" note="Appointments + walk-ins, excl. cancelled.">
              <HBars data={c.services.items.slice(0, 6).map((s) => ({ label: s.name, value: (booking ? s.bookings : 0) + (queue ? s.walk_ins : 0) }))} />
            </Card>
          )}
          {sh && (
            <Card title="Shisha sessions per day" note="Sessions and refills, by the day the session started.">
              <LineChart label="Shisha sessions per day" labels={sh.by_day.map((r) => r.date)} series={[
                { name: "Sessions", values: sh.by_day.map((r) => r.sessions) },
                { name: "Refills", values: sh.by_day.map((r) => r.refills) },
              ]} />
            </Card>
          )}
        </Grid>
      </>
    )
  }

  if (tab === "bookings") {
    const b = c.bookings
    return (
      <>
        <Grid>
          {K("Created", b.created, p?.bookings.created)}
          {K("Confirmed", b.created_confirmed, p?.bookings.created_confirmed, { hint: "Of created in period" })}
          {K("Completed", b.created_completed, p?.bookings.created_completed, { hint: "Of created in period" })}
          {K("Cancelled", b.created_cancelled, p?.bookings.created_cancelled, { lowerIsBetter: true, hint: "Of created in period" })}
          {K("Appointments scheduled", b.scheduled, p?.bookings.scheduled, { hint: "Excl. cancelled" })}
          {K("Scheduled, completed", b.scheduled_completed, p?.bookings.scheduled_completed, { hint: "Incl. bookings completed via the queue" })}
          {K("Cancellation rate", pctOf(b.created_cancelled, b.created), p ? pctOf(p.bookings.created_cancelled, p.bookings.created) : null,
            { lowerIsBetter: true, fmt: formatPct(pctOf(b.created_cancelled, b.created)), hint: "Created in period that are now cancelled ÷ created in period" })}
          {K("Average lead time", b.avg_lead_hours, p?.bookings.avg_lead_hours, { fmt: b.avg_lead_hours == null ? "–" : `${b.avg_lead_hours} h`, hint: "Created to appointment start" })}
        </Grid>
        <Grid cols={2}>
          <Card title="Created vs scheduled per day"><LineChart label="Created vs scheduled" labels={dates} series={[
            { name: "Created", values: daily("bookings_created") }, { name: "Scheduled", values: daily("appointments_scheduled") }]} /></Card>
          <Card title="Appointments by staff member">
            <Table cols={[{ h: "Staff" }, { h: "Scheduled", align: "right" }, { h: "Completed", align: "right" }]}
              rows={b.by_staff.map((s) => [s.name + (s.active ? "" : " (inactive)"), s.scheduled, s.completed])} />
          </Card>
          <Card title="Busiest hours" note={`Appointment start, ${d.timezone}`}><BarChart label="Appointments by hour" data={hours(b.by_hour)} /></Card>
          <Card title="Busiest days"><BarChart label="Appointments by weekday" data={days(b.by_weekday)} /></Card>
        </Grid>
        <Note>No-show rate isn't shown: the schema has no no-show status. Cancellations are reported for the creation cohort; the date a booking was cancelled isn't stored, so "cancelled during the period" needs a status-history table.</Note>
      </>
    )
  }

  if (tab === "queue") {
    const q = c.queue
    return (
      <>
        <Grid>
          {K("Queue entries", q.entries, p?.queue.entries, { hint: "Joined in period, incl. cancelled" })}
          {K("Done", q.done, p?.queue.done)}
          {K("Cancelled", q.cancelled, p?.queue.cancelled, { lowerIsBetter: true })}
          {K("Still waiting / called", q.waiting + q.called, null, { hint: "Joined in period, not yet finished" })}
          {K("Average wait", q.avg_wait_seconds, p?.queue.avg_wait_seconds, { lowerIsBetter: true, fmt: formatDuration(q.avg_wait_seconds), hint: `called − joined · ${q.wait_sample} entries` })}
          {K("Average service time", q.avg_service_seconds, p?.queue.avg_service_seconds, { fmt: formatDuration(q.avg_service_seconds), hint: `done − called · ${q.service_sample} entries` })}
          {K("Waiting right now", q.current_waiting, null, { hint: "Live snapshot, not period-bound" })}
          {K("Being served right now", q.current_called, null, { hint: "Live snapshot" })}
        </Grid>
        <Grid cols={2}>
          <Card title="Walk-in vs booking-originated" note="Booking-originated entries were promoted from a confirmed booking.">
            <Donut label="Queue source" data={[{ label: "Walk-in", value: q.walk_in }, { label: "From booking", value: q.from_booking }]} />
          </Card>
          <Card title="Walk-ins per day"><LineChart label="Walk-ins per day" labels={dates} series={[{ name: "Walk-ins", values: daily("walk_ins") }]} /></Card>
          <Card title="Joins by hour" note={d.timezone}><BarChart label="Queue joins by hour" data={hours(q.by_hour)} /></Card>
          <Card title="Joins by weekday"><BarChart label="Queue joins by weekday" data={days(q.by_weekday)} /></Card>
        </Grid>
        <Note>Averages skip entries missing the timestamps they need. Promoted bookings join the queue shortly before their appointment, so their wait starts from that promotion time.</Note>
      </>
    )
  }

  if (tab === "shisha" && sh) {
    const paymentLabel = (m: string) => (m === "tab" ? "On account" : m === "not recorded" ? "Not recorded" : m.charAt(0).toUpperCase() + m.slice(1))
    return (
      <>
        <Grid>
          {KS("Sessions started", sh.sessions_started, shp?.sessions_started, { hint: "Started in period" })}
          {KS("Completed", sh.sessions_completed, shp?.sessions_completed)}
          <Kpi label="Still open" value={formatNum(sh.sessions_open)} compare={false} hint="Started in period, not yet ended" />
          {KS("Refills", sh.refills, shp?.refills)}
          {KS("Revenue", sh.revenue, shp?.revenue, { fmt: money(sh.revenue), hint: "Completed sessions, refills included" })}
          {KS("Refill revenue", sh.refill_revenue, shp?.refill_revenue, { fmt: money(sh.refill_revenue), hint: "Part of revenue" })}
          {KS("Average per session", sh.avg_session_value, shp?.avg_session_value, { fmt: sh.avg_session_value == null ? "–" : money(sh.avg_session_value), hint: "Completed sessions" })}
        </Grid>
        <Grid cols={2}>
          <Card title="Sessions and refills per day" note="By the day the session started.">
            <LineChart label="Sessions and refills per day" labels={sh.by_day.map((r) => r.date)} series={[
              { name: "Sessions", values: sh.by_day.map((r) => r.sessions) },
              { name: "Refills", values: sh.by_day.map((r) => r.refills) },
            ]} />
          </Card>
          <Card title="Top flavours" note="Completed sessions.">
            <HBars data={sh.by_product.slice(0, 6).map((x) => ({ label: x.name, value: x.sessions }))} />
          </Card>
          <Card title="Busiest hours" note={`Session start, ${d.timezone}`}><BarChart label="Shisha sessions by hour" data={hours(sh.by_hour)} /></Card>
          <Card title="Busiest days"><BarChart label="Shisha sessions by weekday" data={days(sh.by_weekday)} /></Card>
        </Grid>
        <Card title="Payment methods" note="Completed sessions.">
          <Table cols={[{ h: "Method" }, { h: "Sessions", align: "right" }, { h: "Amount", align: "right" }]}
            rows={sh.by_payment.map((x) => [paymentLabel(x.method), x.count, money(x.amount)])} empty="No completed sessions in this period." />
        </Card>
        <Note>Sessions are counted by the day they started. Revenue is the total on completed sessions and already includes refill charges. It is sales taken at your venue, not what you owe the platform.</Note>
      </>
    )
  }

  if (tab === "customers") {
    const u = c.customers
    let running = u.registered_before_window
    const growth = c.daily.map((r) => (running += r.new_customers))
    return (
      <>
        <Grid>
          {K("Registered customers", u.total_registered, null, { hint: "All time" })}
          {K("New registrations", u.new_registrations, p?.customers.new_registrations, { hint: "By registration date" })}
          {K("Customers served", u.served, p?.customers.served)}
          {K("First-time", u.first_time, p?.customers.first_time, { hint: "No completed visit before the period" })}
          {K("Returning", u.returning, p?.customers.returning, { hint: "Had a completed visit before the period" })}
          {K("Repeat in period", u.repeat_in_period, p?.customers.repeat_in_period, { hint: "2+ completed visits in the period" })}
          {K("Returning share", pctOf(u.returning, u.served), p ? pctOf(p.customers.returning, p.customers.served) : null, { fmt: formatPct(pctOf(u.returning, u.served)) })}
          {K("Completed visits", u.completed_visits, p?.customers.completed_visits)}
        </Grid>
        <Grid cols={2}>
          <Card title="Customer growth" note="Cumulative registered customers"><LineChart label="Customer growth" labels={dates} series={[{ name: "Registered", values: growth }]} /></Card>
          <Card title="First-time vs returning"><Donut label="First-time vs returning" data={[{ label: "First-time", value: u.first_time }, { label: "Returning", value: u.returning }]} /></Card>
        </Grid>
        <Note>A visit is a queue entry marked done or a booking marked completed; a booking promoted into the queue counts once. Only counts appear here, never phone numbers or emails.</Note>
      </>
    )
  }

  if (tab === "services") {
    const s = c.services
    return (
      <>
        <Grid cols={3}>
          <Kpi label="Active services" value={formatNum(s.active_count)} compare={false} />
          <Kpi label="Inactive services" value={formatNum(s.inactive_count)} compare={false} />
          <Kpi label="No service selected" value={formatNum((booking ? s.no_service.bookings : 0) + (queue ? s.no_service.walk_ins : 0))} compare={false}
            hint={booking && queue ? "Bookings + walk-ins without a service" : booking ? "Bookings without a service" : "Walk-ins without a service"} />
        </Grid>
        <Card title="Demand by service" note="Excl. cancelled. Prices are the configured list price, not money collected.">
          <Table
            cols={[
              { h: "Service" }, { h: "Status" }, { h: "Configured price", align: "right" }, { h: "Duration", align: "right" },
              ...(booking ? [{ h: "Bookings", align: "right" as const }] : []),
              ...(queue ? [{ h: "Walk-ins", align: "right" as const }, { h: "All queue entries", align: "right" as const }] : []),
            ]}
            rows={s.items.map((i) => [
              i.name, i.active ? "Active" : "Inactive", formatMoney(i.configured_price, d.currency), `${i.duration_minutes} min`,
              ...(booking ? [i.bookings] : []),
              ...(queue ? [i.walk_ins, i.queue_entries] : []),
            ])} />
        </Card>
        <Card title="Demand per day" note={`${booking && queue ? "Appointments + walk-ins" : booking ? "Appointments" : "Walk-ins"}. Per-service daily trends are not broken out.`}>
          <LineChart label="Demand per day" labels={dates} series={[
            ...(booking ? [{ name: "Appointments scheduled", values: daily("appointments_scheduled") }] : []),
            ...(queue ? [{ name: "Walk-ins", values: daily("walk_ins") }] : []),
          ]} />
        </Card>
      </>
    )
  }

  if (tab === "staff") {
    const s = c.staff
    const perf = new Map(c.bookings.by_staff.map((x) => [x.staff_id, x]))
    // Admin activity from a module that is off is left out ("bookings" / "queue" areas).
    const areaVisible = (category: string) => !((category === "bookings" && !booking) || (category === "queue" && !queue))
    const activity = s.activity_by_category.filter((a) => areaVisible(a.category))
    return (
      <>
        <Grid>
          <Kpi label="Active staff" value={formatNum(s.active_count)} compare={false} />
          <Kpi label="Clocked in now" value={formatNum(s.clocked_in_now)} compare={false} hint="Live snapshot" />
          {K("Completed shifts", s.completed_shifts, p?.staff.completed_shifts, { hint: "Started in period" })}
          {K("Shift hours", s.shift_hours, p?.staff.shift_hours, { fmt: String(s.shift_hours) })}
          <Kpi label="Average shift" value={s.avg_shift_hours == null ? "–" : `${s.avg_shift_hours} h`} compare={false} />
        </Grid>
        <Card title={booking ? "Staff hours and appointments" : "Staff hours"} note="Hours use logout − login on completed shifts.">
          <Table
            cols={[
              { h: "Staff" }, { h: "Shifts", align: "right" }, { h: "Hours", align: "right" },
              ...(booking ? [{ h: "Appointments", align: "right" as const }, { h: "Completed", align: "right" as const }] : []),
            ]}
            rows={s.hours_by_staff.map((h) => [
              h.name, h.shifts, h.hours,
              ...(booking ? [perf.get(h.staff_id)?.scheduled ?? 0, perf.get(h.staff_id)?.completed ?? 0] : []),
            ])} />
        </Card>
        <Grid cols={2}>
          <Card title="Admin activity by area"><HBars data={activity.map((a) => ({ label: a.category, value: a.count }))} /></Card>
          <Card title="Recent activity">
            <Table cols={[{ h: "When" }, { h: "Area" }, { h: "Action" }]}
              rows={s.recent_activity.filter((a) => areaVisible(a.category)).map((a) => [new Date(a.at).toLocaleString(undefined, { timeZone: d.timezone }), a.category, a.action])} />
          </Card>
        </Grid>
        {s.shifts_using_fallback_hours > 0 && <Note>{s.shifts_using_fallback_hours} shift(s) had no valid logout time, so their stored hours_worked value was used.</Note>}
        {booking && <Note>Appointment counts come from bookings only: walk-in queue entries don't record which staff member served them.</Note>}
      </>
    )
  }

  if (tab === "messaging") {
    const m = c.messaging
    return (
      <>
        <Grid>
          {K("Conversations created", m.conversations_created, p?.messaging.conversations_created)}
          {K("Conversations with activity", m.conversations_active_in_period, p?.messaging.conversations_active_in_period)}
          {K("Incoming messages", m.incoming, p?.messaging.incoming)}
          {K("Outgoing messages", m.outgoing, p?.messaging.outgoing, { hint: "Sent, not confirmed delivered" })}
          <Kpi label="AI-enabled conversations" value={formatNum(m.ai_enabled)} compare={false} hint={`${m.ai_disabled} with AI off · all conversations`} />
          <Kpi label="Needs a person" value={formatNum(m.by_handling.handoff)} compare={false} hint="Handed off · current" />
          <Kpi label="Last conversation activity" value={m.last_activity ? new Date(m.last_activity).toLocaleDateString(undefined, { timeZone: d.timezone }) : "–"} compare={false} />
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <p className="text-xs text-stone-500">WhatsApp integration</p>
            {m.integrations.length === 0 ? <p className="mt-1 text-lg font-semibold text-stone-900">Not connected</p>
              : m.integrations.map((i, k) => <p key={k} className="mt-1 text-lg font-semibold capitalize text-stone-900">{i.status.replace(/_/g, " ")}</p>)}
          </div>
        </Grid>
        <Grid cols={2}>
          <Card title="Messages per day"><LineChart label="Messages per day" labels={dates} series={[{ name: "Incoming", values: daily("messages_in") }, { name: "Outgoing", values: daily("messages_out") }]} /></Card>
          <Card title="Message types"><Donut label="Message types" data={m.by_type.map((t) => ({ label: t.type, value: t.count }))} /></Card>
          <Card title="Conversation handling" note="Current state of each conversation.">
            <Donut label="Conversation handling" data={[
              { label: "AI active", value: m.by_handling.active }, { label: "Needs a person", value: m.by_handling.handoff },
              { label: "Paused", value: m.by_handling.paused }, { label: "Resolved", value: m.by_handling.resolved }]} />
          </Card>
          <Card title="Conversation status" note="Raw status values currently in use."><HBars data={m.by_status.map((s) => ({ label: s.status, value: s.count }))} /></Card>
        </Grid>
        <Note>Delivery and read rates, and response times, aren't shown: message delivery status isn't recorded and no status history exists. Message content is never included here.</Note>
      </>
    )
  }

  if (tab === "billing" && d.billing) {
    const b = d.billing
    const paid = b.by_status.filter((x) => x.status === "paid")
    return (
      <>
        <Grid cols={3}>
          {bq && b.plan && (
            <Card title="Current plan">
              <p className="text-lg font-semibold text-stone-900">{b.plan.name}</p>
              <p className="text-xs text-stone-500">
                Base {formatCents(b.plan.price_cents, b.plan.currency)}/month
                {b.plan.visit_limit != null && ` · ${b.plan.visit_limit} visits ${b.plan.visit_limit_period}`}
                {b.plan.price_per_visit_cents != null && ` · ${formatCents(b.plan.price_per_visit_cents, b.plan.currency)} per extra visit`}
              </p>
            </Card>
          )}
          {bq && <Kpi label="Billable visits in period" value={formatNum(b.visits.total)} compare={false} hint="Billing ledger, by visit date" />}
          <Kpi label="Paid invoice amount" value={paid.length ? paid.map((x) => formatCents(x.amount_cents, x.currency)).join(" · ") : "–"} compare={false} hint="Invoices for billing periods in range" />
        </Grid>
        <Card title="Invoices by status" note="Billing periods starting in range. Void invoices are never counted as owed.">
          <Table cols={[{ h: "Currency" }, { h: "Status" }, { h: "Invoices", align: "right" }, { h: "Amount", align: "right" }]}
            rows={b.by_status.map((x) => [x.currency, x.status, x.count, formatCents(x.amount_cents, x.currency)])} empty="No invoices for billing periods in this range." />
        </Card>
        <Card title="Billing periods">
          <Table cols={[{ h: "Period" }, { h: "Plan" }, { h: "Status" }, { h: "Visits", align: "right" }, { h: "Overage", align: "right" }, { h: "Amount", align: "right" }]}
            rows={b.trend.map((t) => [`${t.period_start} to ${t.period_end}`, t.plan_key, t.status, t.visit_count, t.overage_visits, formatCents(t.amount_cents, t.currency)])} empty="No invoices for billing periods in this range." />
        </Card>
        <Note>These are what your business owes the platform. "Paid" reflects the invoice status, which is set manually until payment collection is connected; it isn't a verified payment record.</Note>
      </>
    )
  }

  if (tab === "payroll" && d.payroll) {
    const r = d.payroll, cur = r.currency ?? d.currency
    const m = (v: number) => formatMoney(v, cur)
    return (
      <>
        <Grid>
          <Kpi label="Gross pay" value={m(r.gross)} compare={false} />
          <Kpi label="PAYE" value={m(r.paye)} compare={false} hint="Calculated estimate" />
          <Kpi label="UIF" value={m(r.uif)} compare={false} hint="Calculated estimate" />
          <Kpi label="Total deductions" value={m(r.deductions)} compare={false} />
          <Kpi label="Final pay" value={m(r.final)} compare={false} />
          <Kpi label="Paid" value={m(r.paid_final)} compare={false} hint={`${r.paid_count} payslips`} />
          <Kpi label="Pending" value={m(r.pending_final)} compare={false} hint={`${r.pending_count} payslips`} />
          <Kpi label="Hours paid for" value={formatNum(r.hours)} compare={false} />
        </Grid>
        <Card title="Payroll by period" note="Only payroll periods that fall entirely inside the selected range.">
          <Table cols={[{ h: "Period" }, { h: "Gross", align: "right" }, { h: "PAYE", align: "right" }, { h: "UIF", align: "right" }, { h: "Final", align: "right" }, { h: "Pending", align: "right" }]}
            rows={r.by_period.map((x) => [`${x.period_start} to ${x.period_end}`, m(x.gross), m(x.paye), m(x.uif), m(x.final), m(x.pending_final)])} empty="No payroll recorded for periods in this range." />
        </Card>
        <Card title="Staff cost">
          <Table cols={[{ h: "Staff" }, { h: "Hours", align: "right" }, { h: "Gross", align: "right" }, { h: "Final", align: "right" }]}
            rows={r.by_staff.map((x) => [x.name, x.hours, m(x.gross), m(x.final)])} empty="No payroll recorded for periods in this range." />
        </Card>
        <Note>Amounts come from recorded payroll rows, not hourly rate × hours. PAYE and UIF are the system's estimates.</Note>
      </>
    )
  }
  return null
}
