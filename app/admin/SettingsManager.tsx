// app/admin/SettingsManager.tsx
"use client"

import { useState } from "react"

import type {
  AdminBranding,
  AdminBusinessHours,
  AdminClockSettings,
  AdminDisplaySettings,
  AdminKioskSettings,
  AdminPlan,
  AdminQueueSettings,
  AdminService,
  AdminTenantSettings,
} from "./types"
import { ServicesManager } from "./ServicesManager"
import { PrivateLabelPanel } from "./settings/BrandingPanels"
import { BusinessInfoPanel, OpeningHoursPanel } from "./settings/BusinessPanels"
import { EmployerDetailsPanel } from "./settings/EmployerPanels"
import { DisplayPanel } from "./settings/DisplayPanels"
import { KioskPanel } from "./settings/KioskPanels"
import { SettingsPageHeader } from "./settings/ui"

type SubTab = "general" | "services" | "kiosk" | "display" | "private-label"

// Settings are grouped by what the owner is thinking about, not by which
// part of the system they happen to touch. Labels avoid clashing with the
// main sidebar ("Queue" there is the live queue manager; here it's the rules).
const SETTINGS_NAV: Array<{
  group: string
  items: Array<{
    id: SubTab
    label: string
    title: string
    description: string
    /** Shown only when at least one of these products is switched on for the shop
     *  (tenant_modules). Omitted = shared by every shop. The save actions re-check
     *  this server-side; hiding here is only so owners aren't shown dead controls. */
    needs?: Array<"booking" | "queue">
  }>
}> = [
  {
    group: "Business Info",
    items: [
      {
        id: "general",
        label: "Shop details",
        title: "Shop details",
        description: "Your contact details, timezone and opening hours.",
      },
      {
        id: "private-label",
        label: "Branding",
        title: "Branding (private label)",
        description:
          "Your name, logo and colours. Shown on the kiosk, the public display, the staff clock-in and customer messages.",
      },
    ],
  },
  {
    group: "Customer Journey",
    items: [
      {
        id: "services",
        label: "Services",
        title: "Services",
        description: "What customers can book or queue for: names, prices and durations.",
        needs: ["booking", "queue"],
      },
      {
        id: "kiosk",
        label: "Kiosk",
        title: "Self-service kiosk",
        description: "The touch screen customers use to check in, book or join the queue.",
        needs: ["booking", "queue"],
      },
      {
        id: "display",
        label: "Public display",
        title: "Public display",
        description: "The screen in your waiting area showing the queue, bookings and menu.",
        needs: ["booking", "queue"], // a Booking-only shop gets a display too (bookings + menu)
      },
    ],
  },
]

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
  initialClockSettings,
  initialQueueSettings,
  initialBusinessHours,
  onQueueSettingsChange,
  bookingEnabled = true,
  queueEnabled = true,
  initialServices = [],
  servicesManage = true,
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
  initialClockSettings: AdminClockSettings
  initialQueueSettings: AdminQueueSettings
  initialBusinessHours: AdminBusinessHours
  /** Tells AdminView when Kiosk > Services saves queue settings, so Live Queue > Queue rules stays current. */
  onQueueSettingsChange?: (next: AdminQueueSettings) => void
  /** Which products this shop runs (tenant_modules, loaded once in page.tsx). Panels for a
   *  product that is off are hidden; a group left with no panels is hidden too. */
  bookingEnabled?: boolean
  queueEnabled?: boolean
  /** Services list (loaded in page.tsx, already [] for a caller without services.manage). */
  initialServices?: AdminService[]
  /** Whether the caller has services.manage. The Services page is hidden without it. */
  servicesManage?: boolean
}) {
  const [subTab, setSubTab] = useState<SubTab>("general")

  // Queue settings are edited from two places (Kiosk > Services and Queue
  // rules). Lifting them here keeps both in sync after a save, instead of
  // each re-opening with the stale server-rendered copy.
  const [queueSettings, setQueueSettings] = useState(initialQueueSettings)

  const enabled = { booking: bookingEnabled, queue: queueEnabled }
  const settingsNav = SETTINGS_NAV.map((g) => ({
    ...g,
    items: g.items
      .filter((i) => !i.needs || i.needs.some((k) => enabled[k]))
      // Services also needs its own permission (services.manage), like it did in the sidebar.
      .filter((i) => i.id !== "services" || servicesManage),
  })).filter((g) => g.items.length > 0)
  const settingsPages = settingsNav.flatMap((g) => g.items)

  const activePage = settingsPages.find((p) => p.id === subTab) ?? settingsPages[0]

  return (
    <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
      {/* Phone / small tablet: one scrolling row of pills */}
      <div className="mb-4 flex gap-1 overflow-x-auto md:hidden">
        {settingsPages.map((t) => (
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
          {settingsNav.map((group) => (
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

      {activePage.id === "general" && (
        <div className="space-y-3">
          <BusinessInfoPanel initial={initialSettings} />
          <EmployerDetailsPanel />
          <OpeningHoursPanel initial={initialBusinessHours} />
        </div>
      )}
      {activePage.id === "services" && <ServicesManager initialServices={initialServices} />}
      {activePage.id === "kiosk" && (
        <KioskPanel
          initialEnabled={initialKioskEnabled}
          includedInPlan={kioskIncludedInPlan}
          tenantSlug={tenantSlug}
          initialKioskSettings={initialKioskSettings}
          queueSettings={queueSettings}
          onQueueSettingsSaved={(next) => {
            setQueueSettings(next)
            onQueueSettingsChange?.(next)
          }}
        />
      )}
      {activePage.id === "display" && (
        <DisplayPanel
          tenantSlug={tenantSlug}
          initial={initialDisplaySettings}
          canCustomizeBranding={canCustomizeBranding ?? initialPlan === "business"}
          queueEnabled={queueEnabled}
        />
      )}
      {activePage.id === "private-label" && (
        <PrivateLabelPanel
          plan={initialPlan}
          canRemovePoweredBy={canRemovePoweredBy ?? initialPlan === "business"}
          canCustomizeBranding={canCustomizeBranding ?? initialPlan === "business"}
          initial={initialBranding}
          onBrandingChange={onBrandingChange}
        />
      )}
      </div>
    </div>
  )
}
