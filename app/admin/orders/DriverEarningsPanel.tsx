"use client"

// app/admin/orders/DriverEarningsPanel.tsx
//
// Trips, fees and cash per driver for a period, what is still unpaid, and "Settle up".
//   fees      = the driver's pay for completed deliveries (worked out when each delivery completed and saved on the order)
//   cash held = money the driver took at the door for orders paid on delivery (they owe it to the shop)
//   net       = fees - cash held. Positive: the shop pays the driver. Negative: the driver hands money in.
// Settling marks every unpaid delivery (up to the moment these numbers were loaded) as paid and keeps a payout record.

import { useCallback, useEffect, useState } from "react"

import { getDriverEarnings, listDriverPayouts, settleDriver } from "./actions"
import { EmptyState, Field, btn, cardCls, cx, inputCls, money, useNotice } from "./ui"
import type { DriverEarningsReport, DriverEarningsRow, DriverPayout, EarningsPeriod } from "./types"

const PERIODS: Array<{ id: EarningsPeriod; label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "last30", label: "Last 30 days" },
  { id: "custom", label: "Custom" },
]

function netText(net: number, currency: string): string {
  if (net > 0) return `Pay driver ${money(net, currency)}`
  if (net < 0) return `Driver hands in ${money(-net, currency)}`
  return "Nothing to pay"
}

export function DriverEarningsPanel({ currency, timezone }: { currency: string; timezone: string }) {
  const { show, node } = useNotice()
  const [period, setPeriod] = useState<EarningsPeriod>("week")
  const [custom, setCustom] = useState({ from: "", to: "" })
  const [report, setReport] = useState<DriverEarningsReport | null>(null)
  const [payouts, setPayouts] = useState<DriverPayout[]>([])
  const [loading, setLoading] = useState(true)
  const [settling, setSettling] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (period === "custom" && (!custom.from || !custom.to)) return
    setLoading(true)
    const [r, p] = await Promise.all([getDriverEarnings(period, period === "custom" ? custom : undefined), listDriverPayouts(15)])
    setLoading(false)
    if (!r.ok) return show(r.error, true)
    setReport(r.data)
    if (p.ok) setPayouts(p.data)
  }, [period, custom, show])

  useEffect(() => {
    void load()
  }, [load])

  async function settle(row: DriverEarningsRow) {
    if (!report) return
    setBusy(true)
    const res = await settleDriver(row.driverId, report.loadedAt, note)
    setBusy(false)
    if (!res.ok) {
      show(res.error, true)
      void load()
      return
    }
    setSettling(null)
    setNote("")
    show(`${row.name} settled: ${res.data.trips} trip${res.data.trips === 1 ? "" : "s"}. ${netText(res.data.net, currency)}.`)
    void load()
  }

  const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-ZA", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
  const totals = (report?.drivers ?? []).reduce(
    (t, d) => ({ trips: t.trips + d.trips, fees: t.fees + d.fees, cash: t.cash + d.cash }),
    { trips: 0, fees: 0, cash: 0 },
  )

  return (
    <section className={cx(cardCls, "space-y-4 p-5")}>
      <header className="space-y-1">
        <h2 className="text-base font-medium text-admin-text">Driver earnings</h2>
        <p className="text-sm text-admin-text/60">
          Completed deliveries per driver. Fees are saved when each delivery completes, so changing a pay rule never changes past trips.
          Orders paid in cash show the cash the driver collected; hand it in when you settle up.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        {PERIODS.map((p) => (
          <button key={p.id} type="button" className={period === p.id ? btn.primary : btn.ghost} onClick={() => setPeriod(p.id)}>
            {p.label}
          </button>
        ))}
        {period === "custom" && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From">
              <input type="date" className={inputCls} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <input type="date" className={inputCls} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </div>
        )}
      </div>

      {loading && !report ? (
        <p className="text-sm text-admin-text/60">Loading…</p>
      ) : !report || report.drivers.length === 0 ? (
        <EmptyState title="No drivers yet">Add drivers above and their completed deliveries will show here.</EmptyState>
      ) : (
        <div className={cx("overflow-x-auto rounded-lg border border-admin-text/10", loading && "opacity-60")}>
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="bg-admin-text/5 text-xs uppercase tracking-wide text-admin-text/60">
              <tr>
                <th className="p-3 font-medium">Driver</th>
                <th className="p-3 text-right font-medium">Trips</th>
                <th className="p-3 text-right font-medium">Fees</th>
                <th className="p-3 text-right font-medium">Cash held</th>
                <th className="p-3 text-right font-medium">Avg time</th>
                <th className="p-3 font-medium">Not settled yet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-text/10">
              {report.drivers.map((d) => {
                const net = d.unpaidFees - d.unpaidCash
                return (
                  <tr key={d.driverId} className="align-top">
                    <td className="p-3 font-medium text-admin-text">
                      {d.name}
                      {!d.isActive && <span className="ml-2 text-xs font-normal text-admin-text/50">switched off</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">{d.trips}</td>
                    <td className="p-3 text-right tabular-nums">{money(d.fees, currency)}</td>
                    <td className="p-3 text-right tabular-nums">{money(d.cash, currency)}</td>
                    <td className="p-3 text-right tabular-nums">{d.avgMinutes == null ? "–" : `${Math.round(d.avgMinutes)} min`}</td>
                    <td className="space-y-2 p-3">
                      {d.unpaidTrips === 0 ? (
                        <span className="text-admin-text/50">All settled</span>
                      ) : settling === d.driverId ? (
                        <div className="space-y-2">
                          <p className="text-xs text-admin-text/70">
                            {d.unpaidTrips} trip{d.unpaidTrips === 1 ? "" : "s"} · fees {money(d.unpaidFees, currency)} − cash {money(d.unpaidCash, currency)} ={" "}
                            <span className="font-medium">{netText(net, currency)}</span>
                          </p>
                          <input className={inputCls} placeholder="Note (optional), e.g. paid by EFT" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                          <div className="flex gap-2">
                            <button type="button" className={btn.primary} disabled={busy} onClick={() => settle(d)}>
                              {busy ? "Saving…" : "Confirm settled"}
                            </button>
                            <button type="button" className={btn.ghost} disabled={busy} onClick={() => setSettling(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="tabular-nums">
                            {d.unpaidTrips} trip{d.unpaidTrips === 1 ? "" : "s"} · {money(d.unpaidFees, currency)}
                            {d.unpaidCash > 0 && <span className="text-admin-text/60"> · cash {money(d.unpaidCash, currency)}</span>}
                          </p>
                          <p className="text-xs text-admin-text/60">{netText(net, currency)}</p>
                          <button type="button" className={btn.ghost} onClick={() => { setSettling(d.driverId); setNote("") }}>
                            Settle up
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot className="bg-admin-text/5 text-sm font-medium">
              <tr>
                <td className="p-3">All drivers</td>
                <td className="p-3 text-right tabular-nums">{totals.trips}</td>
                <td className="p-3 text-right tabular-nums">{money(totals.fees, currency)}</td>
                <td className="p-3 text-right tabular-nums">{money(totals.cash, currency)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {payouts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-admin-text">Recent settlements</h3>
          <ul className="divide-y divide-admin-text/10 rounded-lg border border-admin-text/10 text-sm">
            {payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 p-3">
                <span>
                  <span className="font-medium text-admin-text">{p.driverName}</span>
                  <span className="text-admin-text/60"> · {p.trips} trip{p.trips === 1 ? "" : "s"} · {netText(p.net, currency)}</span>
                  {p.note && <span className="text-admin-text/60"> · {p.note}</span>}
                </span>
                <span className="text-xs text-admin-text/50">{fmtDate(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {node}
    </section>
  )
}
