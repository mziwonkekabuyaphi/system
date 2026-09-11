// app/admin/AdminView.tsx
"use client"

import { useState } from "react"
import { TodayBookings } from "./TodayBookings"
import { ServicesManager } from "./ServicesManager"
import { StaffManager } from "./StaffManager"
import type { AdminBooking, AdminService, AdminStaff } from "./types"

type Tab = "today" | "services" | "staff"

const TABS: { id: Tab; label: string; heading: string }[] = [
  { id: "today", label: "Today", heading: "Today's book" },
  { id: "services", label: "Services", heading: "Services" },
  { id: "staff", label: "Staff", heading: "Staff" },
]

export function AdminView({
  initialBookings,
  initialServices,
  initialStaff,
}: {
  initialBookings: AdminBooking[]
  initialServices: AdminService[]
  initialStaff: AdminStaff[]
}) {
  const [tab, setTab] = useState<Tab>("today")
  const active = TABS.find((t) => t.id === tab)!

  return (
    <div className="mx-auto max-w-2xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-8">
        <p className="text-sm text-[#8A8375]">Shop admin</p>
        <h1 className="mt-1 text-[2rem] leading-tight text-[#1C1A17] [font-family:var(--font-fraunces)]">
          {active.heading}
        </h1>
      </header>

      <nav className="mb-8 flex gap-6 border-b border-[#D9D3C3]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 pb-3 text-[0.95rem] transition-colors ${
              tab === t.id
                ? "border-[#7A2E2E] text-[#1C1A17]"
                : "border-transparent text-[#8A8375] hover:text-[#1C1A17]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "today" && <TodayBookings bookings={initialBookings} />}
      {tab === "services" && <ServicesManager services={initialServices} />}
      {tab === "staff" && <StaffManager staff={initialStaff} />}
    </div>
  )
}
