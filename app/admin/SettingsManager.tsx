// app/admin/SettingsManager.tsx
"use client"

import { useState } from "react"

import type {
  AdminBookingSettings,
  AdminBranding,
  AdminBusinessHours,
  AdminDisplaySettings,
  AdminKioskSettings,
  AdminMessageSettings,
  AdminPlan,
  AdminQueueSettings,
  AdminTenantSettings,
} from "./types"
import { PrivateLabelPanel } from "./settings/BrandingPanels"
import { BusinessInfoPanel, OpeningHoursPanel } from "./settings/BusinessPanels"
import { DisplayPanel } from "./settings/DisplayPanels"
import { KioskPanel } from "./settings/KioskPanels"
import { BookingSettingsPanel, MessageSettingsPanel, QueueSettingsPanel } from "./settings/OperationsPanels"
import { SettingsPageHeader } from "./settings/ui"

type SubTab = "general" | "kiosk" | "display" | "private-label" | "booking" | "queue" | "messages"

// Settings are grouped by what the owner is thinking about, not by which
// part of the system they happen to touch. Labels avoid clashing with the
// main sidebar ("Queue" there is the live queue manager; here it's the rules).
const SETTINGS_NAV: Array<{
  group: string
  items: Array<{ id: SubTab; label: string; title: string; description: string }>
}> = [
  {
    group: "Business",
    items: [
      {
        id: "general",
        label: "Business info",
        title: "Business info",
        description: "Your contact details, timezone and opening hours.",
      },
      {
        id: "private-label",
        label: "Branding",
        title: "Branding (private label)",
        description: "Your name, logo and colours. Shown on the kiosk, the TV display and customer messages.",
      },
    ],
  },
  {
    group: "Customer screens",
    items: [
      {
        id: "kiosk",
        label: "Kiosk",
        title: "Self-service kiosk",
        description: "The touch screen customers use to check in, book or join the queue.",
      },
      {
        id: "display",
        label: "TV display",
        title: "TV display",
        description: "The screen in your waiting area showing the queue, bookings and menu.",
      },
    ],
  },
  {
    group: "Operations",
    items: [
      {
        id: "booking",
        label: "Booking rules",
        title: "Booking rules",
        description: "How far ahead customers can book, notice periods and cancellations.",
      },
      {
        id: "queue",
        label: "Queue rules",
        title: "Queue rules",
        description: "How the walk-in queue behaves: calling, limits, ticket numbers and wait estimates.",
      },
    ],
  },
  {
    group: "Messaging",
    items: [
      {
        id: "messages",
        label: "WhatsApp messages",
        title: "WhatsApp messages",
        description: "The messages customers receive for bookings and queue updates.",
      },
    ],
  },
]

const SETTINGS_PAGES = SETTINGS_NAV.flatMap((g) => g.items)

export function SettingsManager({
  initialPlan,
  tenantSlug,
  initialSettings,
  initialBranding,
  onBrandingChange,
  initialKioskEnabled,
  kioskIncludedInPlan = true,
  canRemovePoweredBy,
  canCustomizeBranding,
  initialKioskSettings,
  initialDisplaySettings,
  initialBookingSettings,
  initialQueueSettings,
  initialMessageSettings,
  initialBusinessHours,
}: {
  initialPlan: AdminPlan
  tenantSlug: string
  initialSettings: AdminTenantSettings
  initialBranding: AdminBranding
  // Notifies AdminView (sidebar badge + header) the moment the name or
  // logo save succeeds, so it doesn't have to wait for a page reload to
  // pick up initialBranding again.
  onBrandingChange?: (patch: Partial<{ displayName: string | null; logoUrl: string | null }>) => void
  initialKioskEnabled: boolean
  /** Whether the tenant's plan includes the kiosk module (plan_modules).
   *  Computed server-side with tenantHasModule(). Defaults to true so an
   *  un-updated parent keeps today's behavior; the server still enforces. */
  kioskIncludedInPlan?: boolean
  /** Whether the plan includes remove_powered_by. Computed server-side with
   *  tenantHasModule(). Falls back to the old plan === "business" check if
   *  the parent doesn't pass it yet. */
  canRemovePoweredBy?: boolean
  /** Whether the plan includes the 'branding' module (custom logo + colours).
   *  Computed server-side with tenantHasModule(). Falls back to the old
   *  plan === "business" check if the parent doesn't pass it yet. */
  canCustomizeBranding?: boolean
  initialKioskSettings: AdminKioskSettings
  initialDisplaySettings: AdminDisplaySettings
  initialBookingSettings: AdminBookingSettings
  initialQueueSettings: AdminQueueSettings
  initialMessageSettings: AdminMessageSettings
  initialBusinessHours: AdminBusinessHours
}) {
  const [subTab, setSubTab] = useState<SubTab>("general")

  // Queue settings are edited from two places (Kiosk > Services and Queue
  // rules). Lifting them here keeps both in sync after a save, instead of
  // each re-opening with the stale server-rendered copy.
  const [queueSettings, setQueueSettings] = useState(initialQueueSettings)

  const activePage = SETTINGS_PAGES.find((p) => p.id === subTab) ?? SETTINGS_PAGES[0]

  return (
    <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
      {/* Phone / small tablet: one scrolling row of pills */}
      <div className="mb-4 flex gap-1 overflow-x-auto md:hidden">
        {SETTINGS_PAGES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            aria-current={subTab === t.id ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium ${
              subTab === t.id
                ? "border-stone-800 bg-stone-800 text-white"
                : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Desktop: grouped menu, so it's always clear which area you're in */}
      <nav aria-label="Settings sections" className="hidden md:block">
        <div className="sticky top-4 space-y-5">
          {SETTINGS_NAV.map((group) => (
            <div key={group.group}>
              <p className="px-3 text-xs font-semibold uppercase tracking-wider text-stone-400">{group.group}</p>
              <ul className="mt-1 space-y-0.5">
                {group.items.map((item) => {
                  const active = subTab === item.id
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSubTab(item.id)}
                        aria-current={active ? "page" : undefined}
                        className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          active
                            ? "bg-stone-800 font-semibold text-white"
                            : "font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                        }`}
                      >
                        {item.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="min-w-0 space-y-4">
        <SettingsPageHeader title={activePage.title} description={activePage.description} />

      {subTab === "general" && (
        <div className="space-y-3">
          <BusinessInfoPanel initial={initialSettings} />
          <OpeningHoursPanel initial={initialBusinessHours} />
        </div>
      )}
      {subTab === "kiosk" && (
        <KioskPanel
          initialEnabled={initialKioskEnabled}
          includedInPlan={kioskIncludedInPlan}
          tenantSlug={tenantSlug}
          initialKioskSettings={initialKioskSettings}
          queueSettings={queueSettings}
          onQueueSettingsSaved={setQueueSettings}
        />
      )}
      {subTab === "display" && (
        <DisplayPanel
          tenantSlug={tenantSlug}
          initial={initialDisplaySettings}
          canCustomizeBranding={canCustomizeBranding ?? initialPlan === "business"}
        />
      )}
      {subTab === "private-label" && (
        <PrivateLabelPanel
          plan={initialPlan}
          canRemovePoweredBy={canRemovePoweredBy ?? initialPlan === "business"}
          canCustomizeBranding={canCustomizeBranding ?? initialPlan === "business"}
          initial={initialBranding}
          onBrandingChange={onBrandingChange}
        />
      )}
      {subTab === "booking" && <BookingSettingsPanel initial={initialBookingSettings} />}
      {subTab === "queue" && <QueueSettingsPanel initial={queueSettings} onSaved={setQueueSettings} />}
      {subTab === "messages" && <MessageSettingsPanel initial={initialMessageSettings} />}
      </div>
    </div>
  )
}
