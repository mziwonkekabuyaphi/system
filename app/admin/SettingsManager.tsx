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
  AdminMessageSettings,
  AdminPlan,
  AdminQueueSettings,
  AdminService,
  AdminTenantSettings,
} from "./types"
import { ServicesManager } from "./ServicesManager"
import { PrivateLabelPanel } from "./settings/BrandingPanels"
import { BusinessInfoPanel, OpeningHoursPanel, todayIndex } from "./settings/BusinessPanels"
import { ClockPanel } from "./settings/ClockPanels"
import { EmployerDetailsPanel } from "./settings/EmployerPanels"
import { DisplayPanel } from "./settings/DisplayPanels"
import { KioskPanel } from "./settings/KioskPanels"
import { PaymentsPanel } from "./payments/PaymentsPanel"
import { PassportSettingsPanel } from "./settings/PassportSettingsPanel"
import { ShishaSettingsPanel } from "./settings/ShishaSettingsPanel"
import { WhatsAppSettingsPanels } from "./settings/WhatsAppSettingsPanels"
import { SettingsPageHeader, SettingsStatTile } from "./settings/ui"
import type { ModuleFlags } from "@/lib/tenant/effective-modules"

type SubTab = "general" | "services" | "kiosk" | "display" | "private-label" | "staff" | "payments" | "shisha" | "passport" | "whatsapp"

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
  staff: (p) => (
    <RailIcon {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c.4-3.4 3-5.5 6-5.5s5.6 2.1 6 5.5" />
      <path d="M17 4.5a3 3 0 010 5.8M18.5 14.8c1.6.7 2.6 2.4 2.9 4.7" />
    </RailIcon>
  ),
  payments: (p) => (
    <RailIcon {...p}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h4" />
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
  shisha: (p) => (
    <RailIcon {...p}>
      <path d="M9.5 3.5h5l-.8 3.2h-3.4z" />
      <path d="M12 6.7V12" />
      <path d="M8.2 12h7.6l1.3 7.3a1 1 0 0 1-1 1.2H7.9a1 1 0 0 1-1-1.2z" />
      <path d="M15.8 14c2.4.2 3.7 1.3 3.7 3" />
    </RailIcon>
  ),
  whatsapp: (p) => (
    <RailIcon {...p}>
      <path d="M20 11.5a8 8 0 0 1-11.9 7L4 20l1.5-4A8 8 0 1 1 20 11.5Z" />
      <path d="M9 9.2c.3 2.4 2.4 4.5 4.8 4.8l1.2-1.2-1.7-.9-.8.6c-.9-.4-1.6-1.1-2-2l.6-.8-.9-1.7Z" />
    </RailIcon>
  ),
  passport: (p) => (
    <RailIcon {...p}>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v1.5" />
      <path d="M4 7.5V17a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H6.5A2.5 2.5 0 0 1 4 7.5Z" />
      <circle cx="16" cy="13.5" r="1.1" />
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
    /** Owner-switchable feature (kiosk, display): shown when the modules it NEEDS are on
     *  (public.module_requires), even if the owner switched the feature itself off, because
     *  the on/off toggle lives inside this page. Value = modules.key. */
    module?: string
    /** Shown when at least one of these modules is effective (own switch on AND parents on).
     *  Omitted (with no `module`) = shared by every shop. The save actions re-check this
     *  server-side; hiding here is only so owners aren't shown dead controls. */
    anyOf?: string[]
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
        title: "Branding (Private Label)",
        description:
          "Your name, logo and colours. Shown on the kiosk, the public display, the staff clock-in and customer messages.",
      },
      {
        // Every module has staff, so this page is shared by every shop (no `module` / `anyOf`).
        id: "staff",
        label: "Staff settings",
        title: "Staff settings",
        description: "The clock-in pad your team uses to clock in and out: link, colours and wording.",
      },
      {
        // Card payments (the shop's own Yoco account) are used by Passport top-ups and event tickets.
        id: "payments",
        label: "Payments",
        title: "Payments",
        description: "Connect your own Yoco account so customers can pay by card. The money goes straight to you.",
        anyOf: ["wallet", "events"],
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
        anyOf: ["booking", "queue"],
      },
      {
        id: "kiosk",
        label: "Kiosk",
        title: "Self-service kiosk",
        description: "The touch screen customers use to check in, book or join the queue.",
        module: "kiosk", // needs Booking or Queue (module_requires)
      },
      {
        id: "display",
        label: "Public display",
        title: "Public display",
        description: "The screen in your waiting area showing the queue, bookings and menu.",
        module: "display", // needs Booking or Queue (module_requires); a Booking-only shop gets a display too
      },
      {
        // Moved from the Inbox drawer. Appears only while the `whatsapp` module is effective (its own
        // switch on AND Booking, Queue, Shisha or Shifts on, per module_requires), like Shisha/Passport.
        id: "whatsapp",
        label: "WhatsApp Settings",
        title: "WhatsApp Settings",
        description: "Your number, approved templates, and what customers are sent.",
        anyOf: ["whatsapp"],
      },
      {
        id: "shisha",
        label: "Shisha settings",
        title: "Shisha settings",
        description: "Session length, refill warning and whether a station is required.",
        anyOf: ["shisha"],
      },
      {
        id: "passport",
        label: "Passport settings",
        title: "Passport settings",
        description: "Top-up limits and whether customers can top up their own Passport.",
        anyOf: ["wallet"],
      },
    ],
  },
]

/** Four quick facts at the top of Shop details. */
function ShopSummaryTiles({ info, hours }: { info: AdminTenantSettings; hours: AdminBusinessHours }) {
  const openDays = hours.filter((d) => !d.isClosed).length
  const today = hours.find((d) => d.dayOfWeek === todayIndex(info.timezone))
  const todayLine = !today ? "Not set" : today.isClosed ? "Closed" : `${today.openTime ?? "?"} – ${today.closeTime ?? "?"}`
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <SettingsStatTile label="Timezone" value={info.timezone ? (info.timezone.split("/").pop() ?? info.timezone).replace(/_/g, " ") : "Not set"} hint={info.timezone || "Times shown to customers"} icon={<RailIcon className="h-[18px] w-[18px]"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></RailIcon>} />
      <SettingsStatTile label="Currency" value={info.currency || "Not set"} hint="Prices and invoices" icon={<RailIcon className="h-[18px] w-[18px]"><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5c-.5-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.8s1 1.5 2.5 1.9 2.5.8 2.5 2-1.1 1.8-2.5 1.8c-1.1 0-2-.4-2.5-1.2M12 6.5v1.8M12 15.9v1.6" /></RailIcon>} />
      <SettingsStatTile label="Open days" value={`${openDays} / 7`} hint="Days customers can book or queue" icon={<RailIcon className="h-[18px] w-[18px]"><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></RailIcon>} />
      <SettingsStatTile label="Today" value={todayLine} hint="Opening hours" icon={<RailIcon className="h-[18px] w-[18px]"><path d="M3 9l1.5-5h15L21 9M4 9v11h16V9" /></RailIcon>} />
    </div>
  )
}

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
  initialMessageSettings,
  onQueueSettingsChange,
  modules,
  bookingEnabled = true,
  queueEnabled = true,
  shishaEnabled = false,
  shishaManage = false,
  passportEnabled = false,
  passportManage = false,
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
  /** message_settings row for Settings > WhatsApp Settings > Messages (owner-only, like all of Settings). */
  initialMessageSettings?: AdminMessageSettings
  /** Tells AdminView when Kiosk > Services saves queue settings, so Live Queue > Queue rules stays current. */
  onQueueSettingsChange?: (next: AdminQueueSettings) => void
  /** Module state from the database resolver (page.tsx -> getEffectiveModules().flags()). Decides which
   *  pages appear. Optional: without it the old booking/queue/shisha/passport props below are used. */
  modules?: ModuleFlags
  /** Which products this shop runs (tenant_modules, loaded once in page.tsx). Panels for a
   *  product that is off are hidden; a group left with no panels is hidden too. */
  bookingEnabled?: boolean
  queueEnabled?: boolean
  /** Shisha switched on for this shop. Shows Settings > Shisha settings. */
  shishaEnabled?: boolean
  /** Caller has shisha.manage (can save Shisha settings). */
  shishaManage?: boolean
  /** Passport (customer wallet) switched on for this shop and the caller has wallet.view. Shows Settings > Passport settings. */
  passportEnabled?: boolean
  /** Caller has wallet.manage (can save Passport settings). */
  passportManage?: boolean
  /** Services list (loaded in page.tsx, already [] for a caller without services.manage). */
  initialServices?: AdminService[]
  /** Whether the caller has services.manage. The Services page is hidden without it. */
  servicesManage?: boolean
}) {
  const [subTab, setSubTab] = useState<SubTab>("general")
  // Kept here (not only inside the panels) so the summary tiles on Shop details follow a save.
  const [shopInfo, setShopInfo] = useState(initialSettings)
  const [shopHours, setShopHours] = useState(initialBusinessHours)
  const [railHovered, setRailHovered] = useState(false)
  const railExpanded = railHovered

  // Queue settings are edited from two places (Kiosk > Services and Queue
  // rules). Lifting them here keeps both in sync after a save, instead of
  // each re-opening with the stale server-rendered copy.
  const [queueSettings, setQueueSettings] = useState(initialQueueSettings)

  // Which pages exist comes from the database (modules + module_requires). Fallback for a parent that
  // doesn't pass `modules` yet: the same rules as before, built from the old props.
  const flags: ModuleFlags = modules ?? {
    on: { booking: bookingEnabled, queue: queueEnabled, shisha: shishaEnabled, wallet: passportEnabled },
    available: { kiosk: bookingEnabled || queueEnabled, display: bookingEnabled || queueEnabled },
  }
  const settingsNav = SETTINGS_NAV.map((g) => ({
    ...g,
    items: g.items
      .filter((i) => {
        if (i.module) return flags.available[i.module] === true
        if (i.anyOf) return i.anyOf.some((k) => flags.on[k] === true)
        return true
      })
      // Permissions still apply on top of the module state: shisha.view, wallet.view, services.manage.
      .filter((i) => i.id !== "shisha" || shishaEnabled)
      .filter((i) => i.id !== "passport" || passportEnabled)
      .filter((i) => i.id !== "whatsapp" || initialMessageSettings !== undefined)
      .filter((i) => i.id !== "services" || servicesManage),
  })).filter((g) => g.items.length > 0)
  const settingsPages = settingsNav.flatMap((g) => g.items)

  const activePage = settingsPages.find((p) => p.id === subTab) ?? settingsPages[0]
  const ActiveIcon = SETTINGS_ICONS[activePage.id]

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
        <SettingsPageHeader title={activePage.title} description={activePage.description} icon={<ActiveIcon className="h-5 w-5" />} />

      {activePage.id === "general" && (
        <div className="space-y-4">
          <ShopSummaryTiles info={shopInfo} hours={shopHours} />
          <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
            <div className="space-y-4">
              <BusinessInfoPanel initial={initialSettings} onSaved={setShopInfo} />
              <EmployerDetailsPanel />
            </div>
            <OpeningHoursPanel initial={initialBusinessHours} timezone={shopInfo.timezone} onSaved={setShopHours} />
          </div>
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
      {activePage.id === "staff" && (
        <ClockPanel
          tenantSlug={tenantSlug}
          initial={initialClockSettings}
          canCustomizeBranding={canCustomizeBranding ?? initialPlan === "business"}
        />
      )}
      {activePage.id === "payments" && <PaymentsPanel />}
      {activePage.id === "whatsapp" && initialMessageSettings && (
        <WhatsAppSettingsPanels messageSettings={initialMessageSettings} />
      )}
      {activePage.id === "shisha" && <ShishaSettingsPanel canManage={shishaManage} />}
      {activePage.id === "passport" && <PassportSettingsPanel canManage={passportManage} />}
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
