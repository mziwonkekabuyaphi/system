"use client"

import { useState } from "react"

import { InboxManager } from "./InboxManager"
import { QueueManager } from "./QueueManager"
import { ServicesManager } from "./ServicesManager"
import { StaffManager } from "./StaffManager"
import { TodayBookings } from "./TodayBookings"
import type {
  AdminBooking,
  AdminConversationSummary,
  AdminInboxStats,
  AdminQueueEntry,
  AdminService,
  AdminStaff,
} from "./types"

type Tab = "today" | "queue" | "inbox" | "services" | "staff"

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "today", label: "Today" },
  { id: "queue", label: "Queue" },
  { id: "inbox", label: "Inbox" },
  { id: "services", label: "Services" },
  { id: "staff", label: "Staff" },
]

export function AdminView({
  initialBookings,
  initialQueue,
  initialServices,
  initialStaff,
  initialConversations,
  initialInboxStats,
}: {
  initialBookings: AdminBooking[]
  initialQueue: AdminQueueEntry[]
  initialServices: AdminService[]
  initialStaff: AdminStaff[]
  initialConversations: AdminConversationSummary[]
  initialInboxStats: AdminInboxStats
}) {
  const [tab, setTab] = useState<Tab>("today")

  return (
    <div className="min-h-screen bg-[#FAF7F2] pb-24 text-stone-900">
      <header className="px-5 pb-3 pt-6">
        <h1 className="font-[family-name:var(--font-admin-serif)] text-2xl tracking-tight text-stone-900">
          Shop admin
        </h1>
        <p className="mt-1 text-sm text-stone-500">Bookings, queue, inbox, services and staff</p>
      </header>

      <nav className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-stone-200 bg-[#FAF7F2]/95 px-3 py-2 backdrop-blur">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? "bg-[#7A2E3A] text-white" : "text-stone-600 hover:bg-stone-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="px-4 pt-4">
        {tab === "today" && <TodayBookings initialBookings={initialBookings} />}
        {tab === "queue" && <QueueManager initialQueue={initialQueue} />}
        {tab === "inbox" && (
          <InboxManager initialConversations={initialConversations} initialStats={initialInboxStats} />
        )}
        {tab === "services" && <ServicesManager initialServices={initialServices} />}
        {tab === "staff" && <StaffManager initialStaff={initialStaff} />}
      </main>
    </div>
  )
}
