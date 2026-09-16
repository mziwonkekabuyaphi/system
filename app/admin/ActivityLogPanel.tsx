// app/admin/ActivityLogPanel.tsx
"use client"

/**
 * "Who did what, when" — staff, clock in/out, bookings, queue, services,
 * and (payroll.view only) payroll actions. initialEntries already
 * excludes category='payroll' unless the server-rendering caller had
 * payroll.view (see getRecentActivityLog() in page.tsx) — this component
 * doesn't re-filter, it trusts what it was given, same posture as
 * StaffManager.tsx trusting initialStaff.
 */

import { useState, useTransition } from "react"
import { getActivityLog, getPayrollActivityLog } from "./actions"
import type { AdminActivityCategory, AdminActivityLogEntry, AdminStaffPermissions } from "./types"

const CATEGORY_LABELS: Record<AdminActivityCategory, string> = {
  staff: "Staff",
  clock: "Clock in/out",
  bookings: "Bookings",
  queue: "Queue",
  services: "Services",
  payroll: "Payroll",
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ActivityLogPanel({
  initialEntries,
  permissions,
}: {
  initialEntries: AdminActivityLogEntry[]
  permissions: AdminStaffPermissions
}) {
  const [entries, setEntries] = useState(initialEntries)
  const [filter, setFilter] = useState<AdminActivityCategory | "all">("all")
  const [isRefreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const categories: (AdminActivityCategory | "all")[] = [
    "all",
    "staff",
    "clock",
    "bookings",
    "queue",
    "services",
    ...(permissions.payrollView ? (["payroll"] as const) : []),
  ]

  function refresh() {
    setError(null)
    startRefresh(async () => {
      const [staffResult, payrollResult] = await Promise.all([
        getActivityLog(),
        permissions.payrollView ? getPayrollActivityLog() : Promise.resolve({ ok: true as const, entries: [] }),
      ])
      if (!staffResult.ok) {
        setError(staffResult.error)
        return
      }
      if (!payrollResult.ok) {
        setError(payrollResult.error)
        return
      }
      const merged = [...staffResult.entries, ...payrollResult.entries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      setEntries(merged)
    })
  }

  const visible = filter === "all" ? entries : entries.filter((e) => e.category === filter)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`rounded px-3 py-1 text-xs capitalize ${
              filter === c ? "bg-[#1C1A17] text-[#FAF6EE]" : "bg-[#F1ECDF] text-[#1C1A17]"
            }`}
          >
            {c === "all" ? "All" : CATEGORY_LABELS[c]}
          </button>
        ))}
        <button
          onClick={refresh}
          disabled={isRefreshing}
          className="ml-auto text-xs text-[#8A8375] disabled:opacity-50"
        >
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="text-sm text-[#7A2E2E]">{error}</p>}

      {visible.length === 0 ? (
        <p className="text-sm text-[#8A8375]">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4]">
          {visible.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm text-[#1C1A17]">
                  {e.action}
                  {e.staffName && <span className="text-[#8A8375]"> · {e.staffName}</span>}
                </p>
                <p className="text-xs text-[#8A8375]">
                  {CATEGORY_LABELS[e.category]} · {e.actorName ?? "Unknown"} · {timeAgo(e.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
