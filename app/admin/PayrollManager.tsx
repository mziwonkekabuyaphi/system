// app/admin/PayrollManager.tsx
"use client"

/**
 * Payroll tab. Only ever rendered when the caller has staffPermissions.payrollView
 * (checked by whoever renders this — AdminView/AdminTabs, not this file
 * itself, same as StaffManager.tsx trusts its caller for the Staff tab).
 * "Mark as paid" controls additionally check staffPermissions.payrollManage —
 * both flags are UI-only conveniences; the real enforcement is server-side
 * in actions.ts (payroll.view/payroll.manage) and RLS.
 */

import { useMemo, useState, useTransition } from "react"
import {
  calculatePayroll,
  getPayrollForPeriod,
  markAllPayrollPaid,
  markPayrollPaid,
} from "./actions"
import type { AdminPayPeriodPreset, AdminPayrollRecord, AdminStaffPermissions } from "./types"
import type { PayslipBranding } from "@/lib/payroll/payslip-pdf"

function fmtR(value: number): string {
  return `R${(value || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function firstOfMonthISO(): string {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

/** Weekly/biweekly/monthly presets resolve to a concrete [start, end]
 *  range ending today — "custom" leaves whatever's already in the date
 *  inputs alone. */
function resolvePreset(preset: AdminPayPeriodPreset): { start: string; end: string } | null {
  const end = todayISO()
  if (preset === "weekly") return { start: isoDaysAgo(6), end }
  if (preset === "biweekly") return { start: isoDaysAgo(13), end }
  if (preset === "monthly") return { start: firstOfMonthISO(), end }
  return null
}

export function PayrollManager({
  initialRecords,
  permissions,
  branding,
}: {
  initialRecords: AdminPayrollRecord[]
  permissions: AdminStaffPermissions
  branding: PayslipBranding
}) {
  const [records, setRecords] = useState<AdminPayrollRecord[]>(initialRecords)
  const [preset, setPreset] = useState<AdminPayPeriodPreset>(initialRecords.length ? "custom" : "monthly")
  const [periodStart, setPeriodStart] = useState(initialRecords[0]?.periodStart ?? firstOfMonthISO())
  const [periodEnd, setPeriodEnd] = useState(initialRecords[0]?.periodEnd ?? todayISO())
  const [isLoading, startLoad] = useTransition()
  const [isCalculating, startCalculate] = useTransition()
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [isMarking, startMark] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const totals = useMemo(
    () => ({
      gross: records.reduce((sum, r) => sum + r.grossPay, 0),
      deductions: records.reduce((sum, r) => sum + r.deductions, 0),
      net: records.reduce((sum, r) => sum + r.finalPay, 0),
      pendingCount: records.filter((r) => r.paymentStatus === "pending").length,
    }),
    [records],
  )

  function applyPreset(next: AdminPayPeriodPreset) {
    setPreset(next)
    const resolved = resolvePreset(next)
    if (resolved) {
      setPeriodStart(resolved.start)
      setPeriodEnd(resolved.end)
    }
  }

  function loadPeriod() {
    setError(null)
    startLoad(async () => {
      const result = await getPayrollForPeriod(periodStart, periodEnd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setRecords(result.records)
    })
  }

  function calculate() {
    if (!permissions.payrollManage) return
    setError(null)
    startCalculate(async () => {
      const result = await calculatePayroll(periodStart, periodEnd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      loadPeriod()
    })
  }

  function markPaid(id: string) {
    if (!permissions.payrollManage) return
    setMarkingId(id)
    startMark(async () => {
      const result = await markPayrollPaid(id)
      if (!result.ok) {
        window.alert(`Couldn't mark as paid: ${result.error}`)
      } else {
        setRecords((prev) =>
          prev.map((r) => (r.id === id ? { ...r, paymentStatus: "paid", paidAt: new Date().toISOString() } : r)),
        )
      }
      setMarkingId(null)
    })
  }

  function markAllPaid() {
    if (!permissions.payrollManage || totals.pendingCount === 0) return
    const confirmed = window.confirm(`Mark all ${totals.pendingCount} pending payslip(s) as paid?`)
    if (!confirmed) return
    startMark(async () => {
      const result = await markAllPayrollPaid(periodStart, periodEnd)
      if (!result.ok) {
        window.alert(`Couldn't mark all as paid: ${result.error}`)
        return
      }
      setRecords((prev) =>
        prev.map((r) => (r.paymentStatus === "pending" ? { ...r, paymentStatus: "paid", paidAt: new Date().toISOString() } : r)),
      )
    })
  }

  async function downloadPayslip(record: AdminPayrollRecord) {
    setDownloadingId(record.id)
    try {
      const { downloadPayslipPDF } = await import("@/lib/payroll/payslip-pdf")
      await downloadPayslipPDF(record, branding)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Couldn't generate the payslip PDF.")
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* ================= Period picker ================= */}
      <section className="flex flex-wrap items-end gap-4 border-b border-[#E6E1D4] pb-6">
        <div className="flex gap-2">
          {(["weekly", "biweekly", "monthly"] as const).map((p) => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={`rounded px-3 py-1.5 text-sm capitalize ${
                preset === p ? "bg-[#1C1A17] text-[#FAF6EE]" : "bg-[#F1ECDF] text-[#1C1A17]"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <div>
          <label className="block text-xs text-[#8A8375]">Start</label>
          <input
            type="date"
            value={periodStart}
            onChange={(e) => {
              setPreset("custom")
              setPeriodStart(e.target.value)
            }}
            className="mt-1 border-b border-[#D9D3C3] bg-transparent pb-1 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>
        <div>
          <label className="block text-xs text-[#8A8375]">End</label>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => {
              setPreset("custom")
              setPeriodEnd(e.target.value)
            }}
            className="mt-1 border-b border-[#D9D3C3] bg-transparent pb-1 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>

        <button
          onClick={loadPeriod}
          disabled={isLoading}
          className="rounded border border-[#D9D3C3] px-4 py-2 text-sm text-[#1C1A17] disabled:opacity-50"
        >
          {isLoading ? "Loading…" : "View period"}
        </button>

        {permissions.payrollManage && (
          <button
            onClick={calculate}
            disabled={isCalculating}
            className="rounded bg-[#1C1A17] px-4 py-2 text-sm text-[#FAF6EE] disabled:opacity-50"
          >
            {isCalculating ? "Calculating…" : "Calculate payroll"}
          </button>
        )}

        {permissions.payrollManage && totals.pendingCount > 0 && (
          <button
            onClick={markAllPaid}
            disabled={isMarking}
            className="ml-auto rounded border border-[#7A2E2E] px-4 py-2 text-sm text-[#7A2E2E] disabled:opacity-50"
          >
            Mark all {totals.pendingCount} paid
          </button>
        )}
      </section>

      {error && <p className="text-sm text-[#7A2E2E]">{error}</p>}

      {/* ================= Totals ================= */}
      {records.length > 0 && (
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-[#8A8375]">Gross</p>
            <p className="text-lg text-[#1C1A17]">{fmtR(totals.gross)}</p>
          </div>
          <div>
            <p className="text-[#8A8375]">Deductions (PAYE + UIF)</p>
            <p className="text-lg text-[#1C1A17]">{fmtR(totals.deductions)}</p>
          </div>
          <div>
            <p className="text-[#8A8375]">Net</p>
            <p className="text-lg text-[#1C1A17]">{fmtR(totals.net)}</p>
          </div>
        </div>
      )}

      {/* ================= Table ================= */}
      {records.length === 0 ? (
        <p className="text-sm text-[#8A8375]">
          No payroll records for this period yet
          {permissions.payrollManage ? " — pick a range and click Calculate payroll." : "."}
        </p>
      ) : (
        <ul className="divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4]">
          {records.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-[#1C1A17]">{r.staffName}</p>
                <p className="text-xs text-[#8A8375]">
                  {r.hoursWorked.toFixed(1)} hrs @ {fmtR(r.hourlyRate)}/hr · Gross {fmtR(r.grossPay)} · Net{" "}
                  {fmtR(r.finalPay)}
                </p>
                {r.paymentStatus === "paid" && r.paidByName && (
                  <p className="text-xs text-[#8A8375]">
                    Paid {r.paidAt ? new Date(r.paidAt).toLocaleDateString() : ""} by {r.paidByName}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span
                  className={`text-xs ${r.paymentStatus === "paid" ? "text-[#3F6B4F]" : "text-[#8A8375]"}`}
                >
                  {r.paymentStatus === "paid" ? "Paid" : "Pending"}
                </span>
                <button
                  onClick={() => downloadPayslip(r)}
                  disabled={downloadingId === r.id}
                  className="text-sm text-[#8A8375] disabled:opacity-50"
                >
                  {downloadingId === r.id ? "Generating…" : "Payslip PDF"}
                </button>
                {permissions.payrollManage && r.paymentStatus === "pending" && (
                  <button
                    onClick={() => markPaid(r.id)}
                    disabled={isMarking && markingId === r.id}
                    className="text-sm text-[#7A2E2E] disabled:opacity-50"
                  >
                    {isMarking && markingId === r.id ? "Marking…" : "Mark paid"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
