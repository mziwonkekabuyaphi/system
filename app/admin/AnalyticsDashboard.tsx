// app/admin/AnalyticsDashboard.tsx
//
// Kept from the old admin.js dashboard overlay, but the charts are
// hand-rolled CSS bars instead of Chart.js — the old panel loaded
// Chart.js from a CDN <script> tag, which isn't how this app pulls in
// dependencies (npm + bundler), and a KPI grid + two small bar charts
// don't justify adding chart.js/react-chartjs-2 as new npm dependencies
// for a prototype. Swap in a real charting library if this grows beyond
// "volume over the last week" and "who's talking to us most."
//
// Also cut from the old dashboard: the AI-performance chart and its
// underlying ai_requests table — this app's schema (as given) has no such
// table, so "needs human" here is read straight from conversation_states
// (state === 'handoff') instead. Everything shown below is backed by a
// real query in page.tsx's getInboxData.

import type { AdminInboxStats } from "./types"

function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-400">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-2xl text-stone-900">{value}</p>
    </div>
  )
}

function formatDayLabel(dateISO: string): string {
  return new Date(`${dateISO}T00:00:00Z`).toLocaleDateString([], { weekday: "short", timeZone: "UTC" })
}

function VolumeChart({ volumeByDay }: { volumeByDay: AdminInboxStats["volumeByDay"] }) {
  const max = Math.max(1, ...volumeByDay.map((d) => d.incoming + d.outgoing))

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4">
      <p className="mb-3 text-sm font-medium text-stone-700">Messages, last 7 days</p>
      <div className="flex items-end justify-between gap-2" style={{ height: 120 }}>
        {volumeByDay.map((d) => {
          const incomingHeight = (d.incoming / max) * 100
          const outgoingHeight = (d.outgoing / max) * 100
          return (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-24 w-full items-end justify-center gap-0.5">
                <div className="w-2.5 rounded-t bg-[#7A2E3A]" style={{ height: `${incomingHeight}%` }} />
                <div className="w-2.5 rounded-t bg-[#4B6B54]" style={{ height: `${outgoingHeight}%` }} />
              </div>
              <span className="text-[11px] text-stone-400">{formatDayLabel(d.date)}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-stone-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#7A2E3A]" /> Incoming
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#4B6B54]" /> Outgoing
        </span>
      </div>
    </div>
  )
}

function TopCustomers({ topCustomers }: { topCustomers: AdminInboxStats["topCustomers"] }) {
  if (topCustomers.length === 0) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <p className="text-sm font-medium text-stone-700">Most active customers</p>
        <p className="mt-2 text-sm text-stone-400">No messages in the recent sample yet.</p>
      </div>
    )
  }

  const max = topCustomers[0].messageCount

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4">
      <p className="mb-3 text-sm font-medium text-stone-700">Most active customers</p>
      <div className="space-y-2">
        {topCustomers.map((c) => (
          <div key={c.phone} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate text-sm text-stone-700">{c.name}</span>
            <div className="h-2 flex-1 rounded-full bg-stone-100">
              <div
                className="h-2 rounded-full bg-[#7A2E3A]"
                style={{ width: `${(c.messageCount / max) * 100}%` }}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-xs text-stone-400">{c.messageCount}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AnalyticsDashboard({ stats }: { stats: AdminInboxStats }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="Conversations" value={stats.totalConversations} />
        <MetricCard label="AI handling" value={stats.aiActiveCount} />
        <MetricCard label="Needs human" value={stats.needsHumanCount} />
      </div>
      <VolumeChart volumeByDay={stats.volumeByDay} />
      <TopCustomers topCustomers={stats.topCustomers} />
    </div>
  )
}
