"use client"

import { useState } from "react"
import type { SVGProps } from "react"

import { InboxManager } from "./InboxManager"
import { QueueManager } from "./QueueManager"
import { ServicesManager } from "./ServicesManager"
import { SettingsManager } from "./SettingsManager"
import { StaffManager } from "./StaffManager"
import { TodayBookings } from "./TodayBookings"
import type {
  AdminBooking,
  AdminBookingSettings,
  AdminBranding,
  AdminConversationSummary,
  AdminInboxStats,
  AdminMessageSettings,
  AdminPlan,
  AdminQueueEntry,
  AdminQueueSettings,
  AdminService,
  AdminStaff,
  AdminTenantSettings,
} from "./types"

type Tab = "today" | "queue" | "inbox" | "services" | "staff" | "settings"

const SIDEBAR_COLLAPSED = 72 // px
const SIDEBAR_EXPANDED = 240 // px

// ============================================================================
// ICONS — small monoline set, kept local so the sidebar has no icon-library
// dependency. Purely decorative; visual fidelity to any particular icon set
// isn't the point.
// ============================================================================

function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v4M16 3v4" />
    </svg>
  )
}

function TicketIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 8.2A1.8 1.8 0 0 1 5.8 6.4h12.4A1.8 1.8 0 0 1 20 8.2v1.9a1.9 1.9 0 0 0 0 3.8v1.9a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 15.8v-1.9a1.9 1.9 0 0 0 0-3.8Z" />
      <path d="M12 7.3v1.1M12 11.5v1M12 15.6v1.1" />
    </svg>
  )
}

function ChatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20.5 11.5a8 8 0 0 1-11.9 6.98L4 19.5l1.1-3.9A8 8 0 1 1 20.5 11.5Z" />
    </svg>
  )
}

function TagIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12.4 3H5.8A1.8 1.8 0 0 0 4 4.8v6.6c0 .48.19.93.53 1.27l8.4 8.4a1.8 1.8 0 0 0 2.54 0l6.6-6.6a1.8 1.8 0 0 0 0-2.54l-8.4-8.4A1.8 1.8 0 0 0 12.4 3Z" />
      <circle cx="8.4" cy="8.4" r="1.3" />
    </svg>
  )
}

function UsersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="8.2" r="3.1" />
      <path d="M3.3 20c0-3.4 2.6-6.1 5.7-6.1s5.7 2.7 5.7 6.1" />
      <circle cx="17.2" cy="8.4" r="2.5" />
      <path d="M15.6 14.3c2.4.5 4.2 2.9 4.2 5.7" />
    </svg>
  )
}

function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" {...props}>
      <circle cx="12" cy="12" r="3.2" />
      {[0, 60, 120, 180, 240, 300].map((deg) => (
        <line key={deg} x1="12" y1="4.3" x2="12" y2="7" transform={`rotate(${deg} 12 12)`} />
      ))}
    </svg>
  )
}

function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

const TABS: Array<{ id: Tab; label: string; icon: (props: SVGProps<SVGSVGElement>) => JSX.Element }> = [
  { id: "today", label: "Today", icon: CalendarIcon },
  { id: "queue", label: "Queue", icon: TicketIcon },
  { id: "inbox", label: "Inbox", icon: ChatIcon },
  { id: "services", label: "Services", icon: TagIcon },
  { id: "staff", label: "Staff", icon: UsersIcon },
  { id: "settings", label: "Settings", icon: GearIcon },
]

export function AdminView({
  initialBookings,
  initialQueue,
  initialServices,
  initialStaff,
  initialConversations,
  initialInboxStats,
  initialPlan,
  initialTenantSettings,
  initialBranding,
  initialKioskEnabled,
  initialBookingSettings,
  initialQueueSettings,
  initialMessageSettings,
}: {
  initialBookings: AdminBooking[]
  initialQueue: AdminQueueEntry[]
  initialServices: AdminService[]
  initialStaff: AdminStaff[]
  initialConversations: AdminConversationSummary[]
  initialInboxStats: AdminInboxStats
  initialPlan: AdminPlan
  initialTenantSettings: AdminTenantSettings
  initialBranding: AdminBranding
  initialKioskEnabled: boolean
  initialBookingSettings: AdminBookingSettings
  initialQueueSettings: AdminQueueSettings
  initialMessageSettings: AdminMessageSettings
}) {
  const [tab, setTab] = useState<Tab>("today")
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const expanded = hovered || pinned

  const brandName = initialBranding.displayName?.trim() || "Shop admin"
  const brandInitial = brandName.charAt(0).toUpperCase() || "S"

  return (
    <div className="min-h-screen bg-[#FAF7F2] text-stone-900">
      {/* ================= SIDEBAR ================= */}
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false)
        }}
        style={{ width: expanded ? SIDEBAR_EXPANDED : SIDEBAR_COLLAPSED }}
        className={`fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden bg-[#241318] transition-[width] duration-200 ease-out ${
          expanded ? "shadow-2xl" : ""
        }`}
      >
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#7A2E3A] font-[family-name:var(--font-admin-serif)] text-base text-[#FAF7F2]">
            {brandInitial}
          </span>
          <span
            className={`truncate font-[family-name:var(--font-admin-serif)] text-base text-[#FAF7F2] transition-opacity duration-150 ${
              expanded ? "opacity-100 delay-100" : "opacity-0"
            }`}
          >
            {brandName}
          </span>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? "page" : undefined}
                title={t.label}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  active ? "bg-[#7A2E3A] text-[#FAF7F2]" : "text-[#C9B9BC] hover:bg-white/[0.07] hover:text-[#FAF7F2]"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span
                  className={`whitespace-nowrap transition-opacity duration-150 ${
                    expanded ? "opacity-100 delay-100" : "opacity-0"
                  }`}
                >
                  {t.label}
                </span>
              </button>
            )
          })}
        </nav>

        {/* Pin toggle — lets touch users (no hover) keep it open, and keyboard/mouse users lock it */}
        <div className="border-t border-white/10 px-3 py-3">
          <button
            type="button"
            onClick={() => setPinned((p) => !p)}
            aria-pressed={pinned}
            aria-label={pinned ? "Collapse sidebar" : "Keep sidebar expanded"}
            title={pinned ? "Collapse sidebar" : "Keep sidebar expanded"}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[#C9B9BC] transition-colors hover:bg-white/[0.07] hover:text-[#FAF7F2]"
          >
            <ChevronIcon className={`h-5 w-5 shrink-0 transition-transform duration-200 ${pinned ? "rotate-180" : ""}`} />
            <span
              className={`whitespace-nowrap text-sm transition-opacity duration-150 ${
                expanded ? "opacity-100 delay-100" : "opacity-0"
              }`}
            >
              {pinned ? "Collapse" : "Keep open"}
            </span>
          </button>
        </div>
      </aside>

      {/* ================= CONTENT ================= */}
      <div style={{ paddingLeft: SIDEBAR_COLLAPSED }}>
        <header className="px-6 pb-3 pt-6">
          <h1 className="font-[family-name:var(--font-admin-serif)] text-2xl tracking-tight text-stone-900">
            {brandName}
          </h1>
          <p className="mt-1 text-sm text-stone-500">Bookings, queue, inbox, services and staff</p>
        </header>

        <main className="px-6 pb-24 pt-2">
          {tab === "today" && <TodayBookings initialBookings={initialBookings} />}
          {tab === "queue" && <QueueManager initialQueue={initialQueue} />}
          {tab === "inbox" && (
            <InboxManager initialConversations={initialConversations} initialStats={initialInboxStats} />
          )}
          {tab === "services" && <ServicesManager initialServices={initialServices} />}
          {tab === "staff" && <StaffManager initialStaff={initialStaff} />}
          {tab === "settings" && (
            <SettingsManager
              initialPlan={initialPlan}
              initialSettings={initialTenantSettings}
              initialBranding={initialBranding}
              initialKioskEnabled={initialKioskEnabled}
              initialBookingSettings={initialBookingSettings}
              initialQueueSettings={initialQueueSettings}
              initialMessageSettings={initialMessageSettings}
            />
          )}
        </main>
      </div>
    </div>
  )
}
