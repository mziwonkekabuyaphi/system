// app/admin/PayrollManager.tsx
"use client"

// The Payroll tab. Rendered by AdminView only when permissions.payrollView is
// true; every server action it calls re-checks payroll.view / payroll.manage
// itself, so the gating here (and on the buttons) is only convenience.
//
// Pay periods are calendar days in the SHOP's timezone (tenant_settings.timezone,
// passed in as `timezone`), via the helpers in ./tz, not the browser's.

import { useCallback, useEffect, useRef, useState } from "react"

import { calculatePayroll, getPayrollForPeriod, getPayrollPeriodWarnings, markAllPayrollPaid, markPayrollPaid } from "./actions"
import { ConfirmDialog, NoticeModal, type Notice } from "./AdminModals"
import { addDaysKey, dateKeyInTz, formatTime, startOfWeekKey } from "./tz"
import type { AdminPayPeriodPreset, AdminPayrollRecord, AdminStaffPermissions } from "./types"
import type { AdminPayrollOpenShift } from "./payroll-types"

const PRESETS: Array<{ id: AdminPayPeriodPreset; label: string }> = [
  { id: "weekly", label: "Weekly" },
  { id: "biweekly", label: "Fortnightly" },
  { id: "monthly", label: "Monthly" },
  { id: "custom", label: "Custom" },
]

/** The most recent FULL period of this kind, ending before today (shop timezone). */
function presetRange(preset: Exclude<AdminPayPeriodPreset, "custom">, timezone: string): { start: string; end: string } {
  const today = dateKeyInTz(new Date(), timezone)
  if (preset === "monthly") {
    const firstOfThisMonth = `${today.slice(0, 8)}01`
    const end = addDaysKey(firstOfThisMonth, -1)
    return { start: `${end.slice(0, 8)}01`, end }
  }
  const thisMonday = startOfWeekKey(today)
  return { start: addDaysKey(thisMonday, preset === "weekly" ? -7 : -14), end: addDaysKey(thisMonday, -1) }
}

const rand = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" })
const num = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "2026-09-30" -> "30 Sept 2026" (SA format, no timezone shift). */
function fmtDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number)
  if (!y || !m || !d) return key
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

type Banner = { tone: "info" | "error"; text: string }
type Confirm = { kind: "one"; record: AdminPayrollRecord } | { kind: "all" } | null

const btnPrimary =
  "rounded-lg bg-[#1C1A17] px-4 py-2 text-sm text-[#FAF6EE] transition-colors hover:bg-[#33302A] disabled:cursor-not-allowed disabled:opacity-50"
const btnSecondary =
  "rounded-lg border border-[#D9D3C3] px-3 py-2 text-sm text-[#1C1A17] transition-colors hover:bg-[#F1ECDF] disabled:cursor-not-allowed disabled:opacity-50"

export function PayrollManager({
  timezone,
  permissions,
}: {
  timezone: string
  permissions: AdminStaffPermissions
}) {
  const initial = presetRange("monthly", timezone)
  const [preset, setPreset] = useState<AdminPayPeriodPreset>("monthly")
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)

  const [records, setRecords] = useState<AdminPayrollRecord[] | null>(null)
  const [openShifts, setOpenShifts] = useState<AdminPayrollOpenShift[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)

  const [busy, setBusy] = useState<null | "calculate" | "pay">(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [includeBank, setIncludeBank] = useState(false)

  // Ignore a response if the period changed (or a newer load started) meanwhile.
  const requestId = useRef(0)

  const rangeValid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && end >= start

  const load = useCallback(async () => {
    if (!rangeValid) {
      setRecords(null)
      setOpenShifts([])
      setLoading(false)
      setLoadError(end < start ? "The end date must be on or after the start date." : null)
      return
    }
    const id = ++requestId.current
    setLoading(true)
    setLoadError(null)
    const [payroll, warnings] = await Promise.all([getPayrollForPeriod(start, end), getPayrollPeriodWarnings(start, end)])
    if (id !== requestId.current) return
    setLoading(false)
    if (!payroll.ok) {
      setRecords(null)
      setLoadError(payroll.error)
      return
    }
    setRecords(payroll.records as AdminPayrollRecord[])
    // A failed warnings lookup must not hide the table; just skip the warning.
    setOpenShifts(warnings.ok ? warnings.openShifts : [])
  }, [start, end, rangeValid])

  useEffect(() => {
    setBanner(null)
    void load()
  }, [load])

  function choosePreset(next: AdminPayPeriodPreset) {
    setPreset(next)
    if (next !== "custom") {
      const range = presetRange(next, timezone)
      setStart(range.start)
      setEnd(range.end)
    }
  }

  async function handleCalculate() {
    setBusy("calculate")
    setBanner(null)
    const result = await calculatePayroll(start, end)
    setBusy(null)
    if (!result.ok) {
      // e.g. "No completed shifts found in that period." is a normal outcome, not a crash.
      setBanner({ tone: result.error.startsWith("No completed shifts") ? "info" : "error", text: result.error })
    }
    await load()
  }

  async function handleConfirm() {
    if (!confirm) return
    setBusy("pay")
    const result = confirm.kind === "one" ? await markPayrollPaid(confirm.record.id) : await markAllPayrollPaid(start, end)
    setBusy(null)
    setConfirm(null)
    if (!result.ok) setNotice({ title: "Couldn't mark as paid", message: result.error })
    await load()
  }

  // Fetched (rather than a plain link) so a 403/404 shows a message instead of
  // downloading a JSON error file as if it were a payslip.
  async function download(key: string, url: string) {
    setDownloading(key)
    try {
      const res = await fetch(url, { credentials: "same-origin" })
      if (!res.ok) {
        let message = "Couldn't download the payslip."
        try {
          const body = await res.json()
          if (body?.error) message = body.error
        } catch {
          /* non-JSON error body: keep the generic message */
        }
        setNotice({ title: "Download failed", message })
        return
      }
      const disposition = res.headers.get("Content-Disposition") ?? ""
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "payslip.pdf"
      const objectUrl = URL.createObjectURL(await res.blob())
      const a = document.createElement("a")
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      setNotice({ title: "Download failed", message: "Couldn't reach the server. Check your connection and try again." })
    } finally {
      setDownloading(null)
    }
  }

  const bankQuery = includeBank ? "bank=1" : ""
  const rows = records ?? []
  const pending = rows.filter((r) => r.paymentStatus === "pending")
  const totals = rows.reduce(
    (t, r) => ({
      hours: t.hours + r.hoursWorked,
      gross: t.gross + r.grossPay,
      paye: t.paye + r.paye,
      uif: t.uif + r.uif,
      deductions: t.deductions + r.deductions,
      net: t.net + r.finalPay,
    }),
    { hours: 0, gross: 0, paye: 0, uif: 0, deductions: 0, net: 0 },
  )

  return (
    <div className="space-y-5">
      {/* ---- Period ---- */}
      <section className="rounded-xl border border-[#E6E1D4] bg-[#FAF6EE] p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-sm text-[#8A8375]">Pay period</p>
            <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Pay period">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choosePreset(p.id)}
                  aria-pressed={preset === p.id}
                  className={`rounded-full border px-3 py-1.5 text-sm ${
                    preset === p.id
                      ? "border-[#1C1A17] bg-[#1C1A17] text-[#FAF6EE]"
                      : "border-[#D9D3C3] text-[#1C1A17] hover:bg-[#F1ECDF]"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <label className="text-sm text-[#8A8375]">
            From
            <input
              type="date"
              value={start}
              onChange={(e) => {
                setPreset("custom")
                setStart(e.target.value)
              }}
              className="mt-1 block border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </label>
          <label className="text-sm text-[#8A8375]">
            To
            <input
              type="date"
              value={end}
              onChange={(e) => {
                setPreset("custom")
                setEnd(e.target.value)
              }}
              className="mt-1 block border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </label>

          {permissions.payrollManage && (
            <button type="button" onClick={handleCalculate} disabled={!rangeValid || busy !== null} className={btnPrimary}>
              {busy === "calculate" ? "Calculating…" : rows.length > 0 ? "Recalculate payroll" : "Calculate payroll"}
            </button>
          )}
        </div>
        <p className="mt-3 text-xs text-[#8A8375]">
          {rangeValid ? `${fmtDay(start)} to ${fmtDay(end)}` : "Choose a valid start and end date."} Hours are counted from
          completed shifts whose clock-in falls in this period (shop time). Recalculating replaces unpaid rows; rows already
          marked paid are kept.
        </p>
      </section>

      {/* ---- Warnings / messages ---- */}
      {openShifts.length > 0 && (
        <div role="alert" className="rounded-lg border border-[#E3C98A] bg-[#FBF3DC] p-4 text-sm text-[#5C4A12]">
          <p className="font-semibold">
            {openShifts.length === 1 ? "1 shift is still open" : `${openShifts.length} shifts are still open`} in this period
          </p>
          <p className="mt-1">
            Open shifts are left out of pay until they&apos;re clocked out.{" "}
            {openShifts
              .map((s) => `${s.staffName} (in since ${fmtDay(dateKeyInTz(s.loginTime, timezone))} ${formatTime(s.loginTime, timezone)})`)
              .join(", ")}
            . Clock them out on the Staff tab, then recalculate.
          </p>
        </div>
      )}

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`rounded-lg border p-4 text-sm ${
            banner.tone === "error" ? "border-[#E0B4AD] bg-[#F3E3E0] text-[#7A2E2E]" : "border-[#D9D3C3] bg-[#F1ECDF] text-[#1C1A17]"
          }`}
        >
          {banner.text}
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-[#E0B4AD] bg-[#F3E3E0] p-4 text-sm text-[#7A2E2E]">
          <span>{loadError}</span>
          {rangeValid && (
            <button type="button" onClick={() => void load()} className={btnSecondary}>
              Try again
            </button>
          )}
        </div>
      )}

      {/* ---- Table ---- */}
      {loading && records === null && !loadError && <p className="text-sm text-[#8A8375]">Loading payroll…</p>}

      {!loading && !loadError && rangeValid && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#D9D3C3] p-8 text-center">
          <p className="text-[#1C1A17]">No payroll calculated for this period yet.</p>
          <p className="mt-1 text-sm text-[#8A8375]">
            {permissions.payrollManage
              ? "Choose “Calculate payroll” to work it out from completed shifts. If nobody has a completed shift in these dates, you'll be told."
              : "Someone with payroll management access needs to calculate it first."}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <label className="flex items-center gap-2 text-sm text-[#8A8375]">
              <input type="checkbox" checked={includeBank} onChange={(e) => setIncludeBank(e.target.checked)} />
              Show bank details on unpaid payslips (last 4 digits only; paid payslips always include them)
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => download("all", `/admin/payroll/payslips?start=${start}&end=${end}${bankQuery ? `&${bankQuery}` : ""}`)}
                disabled={downloading !== null}
                className={btnSecondary}
              >
                {downloading === "all" ? "Preparing…" : "Download all payslips"}
              </button>
              {permissions.payrollManage && (
                <button
                  type="button"
                  onClick={() => setConfirm({ kind: "all" })}
                  disabled={pending.length === 0 || busy !== null}
                  className={btnPrimary}
                >
                  Mark all paid{pending.length > 0 ? ` (${pending.length})` : ""}
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-[#E6E1D4]">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-[#F1ECDF] text-left text-xs uppercase tracking-wide text-[#8A8375]">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Staff</th>
                  <th className="px-3 py-2.5 text-right font-medium">Hours</th>
                  <th className="px-3 py-2.5 text-right font-medium">Rate</th>
                  <th className="px-3 py-2.5 text-right font-medium">Gross</th>
                  <th className="px-3 py-2.5 text-right font-medium">PAYE*</th>
                  <th className="px-3 py-2.5 text-right font-medium">UIF*</th>
                  <th className="px-3 py-2.5 text-right font-medium">Deductions</th>
                  <th className="px-3 py-2.5 text-right font-medium">Net pay</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Payslip</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6E1D4] bg-white/50">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5">
                      <p className="text-[#1C1A17]">{r.staffName}</p>
                      {r.jobTitle && <p className="text-xs text-[#8A8375]">{r.jobTitle}</p>}
                      {r.hourlyRate === 0 && <p className="text-xs text-[#7A2E2E]">No hourly rate set</p>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{num.format(r.hoursWorked)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(r.hourlyRate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(r.grossPay)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(r.paye)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(r.uif)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(r.deductions)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{rand.format(r.finalPay)}</td>
                    <td className="px-3 py-2.5">
                      {r.paymentStatus === "paid" ? (
                        <span className="inline-block rounded-full bg-[#E1EDE0] px-2 py-0.5 text-xs text-[#2F5D2E]">
                          Paid{r.paidAt ? ` ${fmtDay(dateKeyInTz(r.paidAt, timezone))}` : ""}
                        </span>
                      ) : (
                        <span className="inline-block rounded-full bg-[#FBF3DC] px-2 py-0.5 text-xs text-[#5C4A12]">Pending</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-2">
                        {permissions.payrollManage && r.paymentStatus === "pending" && (
                          <button type="button" onClick={() => setConfirm({ kind: "one", record: r })} disabled={busy !== null} className={btnSecondary}>
                            Mark paid
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => download(r.id, `/admin/payroll/payslip/${r.id}${bankQuery ? `?${bankQuery}` : ""}`)}
                          disabled={downloading !== null}
                          className={btnSecondary}
                        >
                          {downloading === r.id ? "Preparing…" : "Download PDF"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-[#F1ECDF] font-semibold">
                <tr>
                  <td className="px-3 py-2.5">Total</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num.format(totals.hours)}</td>
                  <td />
                  <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(totals.gross)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(totals.paye)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(totals.uif)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(totals.deductions)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rand.format(totals.net)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-xs text-[#8A8375]">
            * PAYE and UIF are estimates (SARS tables, annualised method, single taxpayer under 65, no medical-aid or retirement
            deductions), not official SARS figures. Confirm with your accountant before relying on them.
          </p>
        </section>
      )}

      <ConfirmDialog
        open={confirm !== null}
        tone="neutral"
        title={confirm?.kind === "all" ? "Mark all as paid?" : "Mark as paid?"}
        message={
          confirm?.kind === "all"
            ? `This marks ${pending.length} pending payslip${pending.length === 1 ? "" : "s"} for ${fmtDay(start)} to ${fmtDay(end)} as paid today. It doesn't send any money.`
            : confirm?.kind === "one"
              ? `This marks ${confirm.record.staffName}'s payslip (${rand.format(confirm.record.finalPay)}) as paid today. It doesn't send any money.`
              : ""
        }
        confirmLabel="Mark as paid"
        busyLabel="Saving…"
        isBusy={busy === "pay"}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
