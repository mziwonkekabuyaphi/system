// app/admin/SettingsManager.tsx
"use client"

import { useState } from "react"
import type { ReactElement, ReactNode, SVGProps } from "react"

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

// Small line icons for the collapsed settings rail (same style as the main sidebar's).
function RailIcon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

const SETTINGS_ICONS: Record<SubTab, (props: SVGProps<SVGSVGElement>) => ReactElement> = {
  general: (p) => (
    <RailIcon {...p}>
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M3 9h18" />
      <path d="M4 9v11h16V9" />
      <path d="M9 20v-6h6v6" />
    </RailIcon>
  ),
  "private-label": (p) => (
    <RailIcon {...p}>
      <path d="M12 3a9 9 0 100 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H17a4 4 0 004-4c0-4.4-4-8.2-9-8.2z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7.5" r="1" />
      <circle cx="14.5" cy="7.5" r="1" />
    </RailIcon>
  ),
  services: (p) => (
    <RailIcon {...p}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="3.5" cy="6" r="1" />
      <circle cx="3.5" cy="12" r="1" />
      <circle cx="3.5" cy="18" r="1" />
    </RailIcon>
  ),
  kiosk: (p) => (
    <RailIcon {...p}>
      <rect x="6" y="2.5" width="12" height="19" rx="2" />
      <path d="M10 18.5h4" />
    </RailIcon>
  ),
  display: (p) => (
    <RailIcon {...p}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </RailIcon>
  ),
}

// Same widths and timing as the main admin sidebar (200ms width, labels fade in after 100ms).
const RAIL_COLLAPSED = "3.5rem"
const RAIL_EXPANDED = "14rem"
// The active item's accent is the shop's own colour (--sb-accent) when set, else the admin accent.

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
  const [railHovered, setRailHovered] = useState(false)
  const railExpanded = railHovered

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
    <div className="md:flex md:gap-6">
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
                ? "border-selected bg-selected text-on-color"
                : "border-stone-300 bg-card text-stone-600 hover:bg-stone-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Desktop: collapsible icon rail. Expands over the page on hover/focus (like the main sidebar),
          so the content never jumps. The 3.5rem box below just reserves the collapsed width. */}
      <div className="relative hidden w-14 shrink-0 md:block">
        <nav
          aria-label="Settings sections"
          onMouseEnter={() => setRailHovered(true)}
          onMouseLeave={() => setRailHovered(false)}
          onFocus={() => setRailHovered(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setRailHovered(false)
          }}
          style={{ width: railExpanded ? RAIL_EXPANDED : RAIL_COLLAPSED }}
          className={`sticky top-4 z-20 overflow-hidden rounded-xl border border-stone-200 bg-card py-2 transition-[width] duration-200 ease-out ${
            railExpanded ? "shadow-2xl" : ""
          }`}
        >
          {settingsNav.map((group, gi) => (
            <div key={group.group} className={gi > 0 ? "mt-2" : ""}>
              {/* Collapsed: a small dot. Expanded: the group name. */}
              <div className="relative h-6 px-3">
                <span
                  className={`absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-300 transition-opacity duration-150 ${
                    railExpanded ? "opacity-0" : "opacity-100"
                  }`}
                />
                <p
                  className={`whitespace-nowrap pl-3 text-xs font-semibold uppercase tracking-wider text-stone-400 transition-opacity duration-150 ${
                    railExpanded ? "opacity-100 delay-100" : "opacity-0"
                  }`}
                >
                  {group.group}
                </p>
              </div>
              <ul className="space-y-0.5 px-2">
                {group.items.map((item) => {
                  const active = subTab === item.id
                  const Icon = SETTINGS_ICONS[item.id]
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSubTab(item.id)}
                        aria-current={active ? "page" : undefined}
                        title={item.label}
                        className={`relative flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors ${
                          active
                            ? "border-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_25%,transparent)] bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_12%,transparent)] font-semibold text-[var(--sb-accent,var(--color-admin-accent))]"
                            : "border-transparent font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                        }`}
                      >
                        {active && (
                          <span
                            aria-hidden="true"
                            className="absolute bottom-[20%] left-0 top-[20%] w-0.5 rounded-full bg-[var(--sb-accent,var(--color-admin-accent))] shadow-[0_0_8px_var(--sb-accent,var(--color-admin-accent))]"
                          />
                        )}
                        <Icon className="h-5 w-5 shrink-0" />
                        <span
                          className={`whitespace-nowrap transition-opacity duration-150 ${
                            railExpanded ? "opacity-100 delay-100" : "opacity-0"
                          }`}
                        >
                          {item.label}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="min-w-0 flex-1 space-y-4">
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
