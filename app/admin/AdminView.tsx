"use client"

import { useState } from "react"
import type { SVGProps } from "react"

import { LogoutButton } from "@/components/admin/LogoutButton"
import { BillingPanel } from "@/components/admin/BillingPanel"
import { AnalyticsDashboard } from "./analytics/AnalyticsDashboard"
import { CustomersManager } from "./CustomersManager"
import { InboxManager } from "./InboxManager"
import { QueueManager } from "./queue/QueueManager"
import { ShishaManager } from "./shisha/ShishaManager"
import { SettingsManager } from "./SettingsManager"
import { sidebarStyleVars } from "./sidebar-theme"
import { StaffManager } from "./staff/StaffManager"
import { TodayBookings } from "./booking/TodayBookings"
import type {
  AdminBooking,
  AdminBookingSettings,
  AdminBranding,
  AdminBusinessHours,
  AdminClockSettings,
  AdminConversationSummary,
  AdminDisplaySettings,
  AdminInboxStats,
  AdminKioskSettings,
  AdminMessageSettings,
  AdminPlan,
  AdminQueueEntry,
  AdminQueueSettings,
  AdminService,
  AdminStaff,
  AdminStaffPermissions,
  AdminStaffShift,
  AdminTenantSettings,
} from "./types"

type Tab =
  | "today"
  | "queue"
  | "shisha"
  | "customers"
  | "inbox"
  | "staff"
  | "analytics"
  | "billing"
  | "settings"

const SIDEBAR_COLLAPSED = 50 // px
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

function ContactsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <circle cx="9" cy="10.5" r="2.2" />
      <path d="M5.5 16.2c.6-1.6 1.9-2.5 3.5-2.5s2.9.9 3.5 2.5" />
      <path d="M15 9.5h3M15 12.5h3" />
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

function CreditCardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M6.5 14.5h4" />
    </svg>
  )
}

function ChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  )
}

function HookahIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9.5 3.5h5l-.8 3.2h-3.4z" />
      <path d="M12 6.7V12" />
      <path d="M8.2 12h7.6l1.3 7.3a1 1 0 0 1-1 1.2H7.9a1 1 0 0 1-1-1.2z" />
      <path d="M15.8 14c2.4.2 3.7 1.3 3.7 3" />
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
  { id: "today", label: "Appointments", icon: CalendarIcon },
  { id: "queue", label: "Live Queue", icon: TicketIcon },
  { id: "shisha", label: "Shisha", icon: HookahIcon },
  { id: "inbox", label: "Inbox", icon: ChatIcon },
  { id: "customers", label: "Customers", icon: ContactsIcon },
  { id: "staff", label: "Staff", icon: UsersIcon },
  { id: "analytics", label: "Analytics", icon: ChartIcon },
  { id: "billing", label: "Billing & Plans", icon: CreditCardIcon },
  { id: "settings", label: "Settings", icon: GearIcon },
]

export function AdminView({
  initialBookings,
  initialQueue,
  timezone,
  initialServices,
  initialStaff,
  initialActiveShifts,
  staffPermissions,
  bookingEnabled,
  queueEnabled,
  shishaEnabled,
  shiftsEnabled,
  initialConversations,
  initialInboxStats,
  initialPlan,
  tenantSlug,
  tenantName,
  initialTenantSettings,
  initialBranding,
  initialKioskEnabled,
  initialKioskSettings,
  initialDisplaySettings,
  initialClockSettings,
  initialBookingSettings,
  initialQueueSettings,
  initialMessageSettings,
  initialBusinessHours,
}: {
  initialBookings: AdminBooking[]
  initialQueue: AdminQueueEntry[]
  timezone: string
  initialServices: AdminService[]
  initialStaff: AdminStaff[]
  initialActiveShifts: AdminStaffShift[]
  staffPermissions: AdminStaffPermissions
  /** Shisha is switched on for the tenant AND the caller has shisha.view (computed in page.tsx). */
  /** Booking / Queue / Shisha / Shifts are per-shop switches (tenant_modules). page.tsx
   *  fails closed and also skips the data load for a product that's off. */
  bookingEnabled: boolean
  queueEnabled: boolean
  shishaEnabled: boolean
  /** Shifts module on the tenant's plan AND the caller has shifts.view (computed in page.tsx). */
  shiftsEnabled: boolean
  initialConversations: AdminConversationSummary[]
  initialInboxStats: AdminInboxStats
  initialPlan: AdminPlan
  tenantSlug: string
  /** tenants.name — shown in the header/sidebar until a display name is set in Private Label. */
  tenantName: string
  initialTenantSettings: AdminTenantSettings | null
  initialBranding: AdminBranding
  initialKioskEnabled: boolean
  initialKioskSettings: AdminKioskSettings | null
  initialDisplaySettings: AdminDisplaySettings | null
  initialClockSettings: AdminClockSettings | null
  initialBookingSettings: AdminBookingSettings | null
  initialQueueSettings: AdminQueueSettings | null
  initialMessageSettings: AdminMessageSettings | null
  initialBusinessHours: AdminBusinessHours | null
}) {
  // Which tabs this shop + caller can see. Booking and Queue are optional
  // products; Customers and Inbox only mean something when at least one of
  // them is on. Staff, Analytics, Billing and Settings stay available.
  // (Services now lives in Settings > Customer Journey, next to Kiosk and Display.)
  const hasBookingOrQueue = bookingEnabled || queueEnabled
  const isTabVisible = (id: Tab): boolean => {
    switch (id) {
      case "today":
        return bookingEnabled
      case "queue":
        return queueEnabled
      case "settings":
        return staffPermissions.settingsManage
      // Module switched on + shisha.view. The actions re-check both server-side.
      case "shisha":
        return shishaEnabled && staffPermissions.shishaView
      // Analytics has its own permission key (analytics.view). The server
      // action in app/admin/analytics/actions.ts re-checks it.
      case "analytics":
        return staffPermissions.analyticsView
      // Billing is owner-only (settings.manage is the closest owner-only key).
      case "billing":
        return staffPermissions.settingsManage
      // Inbox (WhatsApp) and Customers hold phone numbers: owner-only, and only
      // for shops running Booking or Queue.
      case "inbox":
      case "customers":
        return staffPermissions.settingsManage && hasBookingOrQueue
      default:
        return true
    }
  }
  // Land on the first tab the shop actually has (a shisha-only shop has no Appointments).
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => isTabVisible(t.id))?.id ?? "staff")

  // Queue settings are edited from two places (Live Queue > Queue rules, and
  // Settings > Kiosk > Services). Held here so each always opens with what the
  // other last saved. Null unless the caller has settings.manage.
  const [queueSettings, setQueueSettings] = useState(initialQueueSettings)

  // Booking rules live on the Appointments tab now (Booking rules overlay).
  // Null unless the caller has settings.manage.
  const [bookingSettings, setBookingSettings] = useState(initialBookingSettings)
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const expanded = hovered || pinned

  // Services/Settings tabs are hidden from a caller without the matching
  // permission — this mirrors, but does not replace, the data-layer fix
  // in page.tsx: initialServices is already [] and the settings fields
  // are already null for such a caller, so this only controls whether
  // the (now-empty/inapplicable) tab is shown at all.
  const visibleTabs = TABS.filter((t) => isTabVisible(t.id))

  // Branding is lifted into state (seeded from the server-fetched
  // initialBranding) so the sidebar badge and header logo update the
  // moment SettingsManager's Private Label panel saves a new name or
  // logo — not just after a full page reload. SettingsManager calls
  // onBrandingChange with a partial patch after each successful save.
  const [branding, setBranding] = useState({
    displayName: initialBranding.displayName,
    logoUrl: initialBranding.logoUrl,
    sidebarColor: initialBranding.sidebarColor ?? null,
    sidebarTextColor: initialBranding.sidebarTextColor ?? null,
    accentColor: initialBranding.accentColor ?? null,
  })

  function handleBrandingChange(
    patch: Partial<{
      displayName: string | null
      logoUrl: string | null
      sidebarColor: string | null
      sidebarTextColor: string | null
      accentColor: string | null
    }>,
  ) {
    setBranding((prev) => ({ ...prev, ...patch }))
  }

  // Tenant's own sidebar colours, or null for the built-in look. When null every
  // class below is the original admin-* token class, so nothing changes visually.
  const sidebarVars = sidebarStyleVars(branding)
  const custom = sidebarVars !== null
  const SB = custom
    ? {
        bg: "bg-[var(--sb-bg)]",
        line: "border-[color:var(--sb-line)]",
        text: "text-[color:var(--sb-text)]",
        badge: "bg-[var(--sb-accent)] text-[color:var(--sb-on-accent)]",
        navActive: "bg-[var(--sb-accent)] text-[color:var(--sb-on-accent)]",
        navIdle:
          "text-[color:var(--sb-text-muted)] hover:bg-[var(--sb-hover)] hover:text-[color:var(--sb-text)]",
      }
    : {
        bg: "bg-admin-sidebar",
        line: "border-admin-on-sidebar/10",
        text: "text-admin-on-sidebar",
        badge: "bg-admin-accent text-admin-on-accent",
        navActive: "bg-admin-accent text-admin-on-accent",
        navIdle: "text-admin-on-sidebar/60 hover:bg-admin-on-sidebar/[0.07] hover:text-admin-on-sidebar",
      }

  // Display name from Private Label wins; otherwise the shop's own name.
  const brandName = branding.displayName?.trim() || tenantName?.trim() || "Shop admin"
  const brandInitial = brandName.charAt(0).toUpperCase() || "S"

  // The shop's dashboard colours are set on the whole page (not only the sidebar) so settings
  // buttons, toggles and highlights can use them too. Everything that reads var(--sb-bg, ...) falls
  // back to the standard maroon when no custom colours are switched on.
  return (
    <div
      style={{ ...(sidebarVars ?? {}) }}
      // Lets components/admin/brand.ts switch to the tenant's own colours.
      data-brand={custom ? "custom" : "default"}
      className="group/admin min-h-screen bg-admin-body text-admin-text"
    >
      {/* ================= SIDEBAR ================= */}
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false)
        }}
        style={{ width: expanded ? SIDEBAR_EXPANDED : SIDEBAR_COLLAPSED, ...(sidebarVars ?? {}) }}
        className={`fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden ${SB.bg} transition-[width] duration-200 ease-out ${
          expanded ? "shadow-2xl" : ""
        }`}
      >
        {/* Brand */}
        <div className={`flex h-16 shrink-0 items-center gap-3 border-b ${SB.line} px-4`}>
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external Storage URL, not a static/local asset
            <img
              src={branding.logoUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded-full border border-white/10 object-cover"
            />
          ) : (
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${SB.badge} font-[family-name:var(--font-admin-serif)] text-base`}>
              {brandInitial}
            </span>
          )}
          <span
            className={`truncate font-[family-name:var(--font-admin-serif)] text-base ${SB.text} transition-opacity duration-150 ${
              expanded ? "opacity-100 delay-100" : "opacity-0"
            }`}
          >
            {brandName}
          </span>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {visibleTabs.map((t) => {
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
                  active ? SB.navActive : SB.navIdle
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

        {/* Account section — sign out */}
        <div className={`border-t ${SB.line} px-3 py-3`}>
          <LogoutButton expanded={expanded} />
        </div>

        {/* Pin toggle — lets touch users (no hover) keep it open, and keyboard/mouse users lock it */}
        <div className={`border-t ${SB.line} px-3 py-3`}>
          <button
            type="button"
            onClick={() => setPinned((p) => !p)}
            aria-pressed={pinned}
            aria-label={pinned ? "Collapse sidebar" : "Keep sidebar expanded"}
            title={pinned ? "Collapse sidebar" : "Keep sidebar expanded"}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 transition-colors ${SB.navIdle}`}
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
        <header className="flex items-center gap-3 px-6 pb-3 pt-6">
          {branding.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- external Storage URL, not a static/local asset
            <img
              src={branding.logoUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-lg border border-stone-200 object-contain bg-white"
            />
          )}
          <div>
            <h1 className="font-[family-name:var(--font-admin-serif)] text-2xl tracking-tight text-stone-900">
              {brandName}
            </h1>
            <p className="mt-1 text-sm text-stone-500">
              {TABS.find((t) => t.id === tab)?.label ?? ""}
            </p>
          </div>
        </header>

        <main className="px-6 pb-24 pt-2">
          {tab === "today" && bookingEnabled && (
            <TodayBookings
              initialBookings={initialBookings}
              timezone={timezone}
              bookingSettings={staffPermissions.settingsManage ? bookingSettings : null}
              onBookingSettingsSaved={setBookingSettings}
              queueEnabled={queueEnabled}
            />
          )}
          {tab === "queue" && queueEnabled && (
            <QueueManager
              initialQueue={initialQueue}
              timezone={timezone}
              queueSettings={staffPermissions.settingsManage ? queueSettings : null}
              onQueueSettingsSaved={setQueueSettings}
            />
          )}
          {tab === "shisha" && shishaEnabled && staffPermissions.shishaView && (
            <ShishaManager
              timezone={timezone}
              canOperate={staffPermissions.shishaOperate}
              canManage={staffPermissions.shishaManage}
            />
          )}
          {tab === "customers" && isTabVisible("customers") && <CustomersManager timezone={timezone} />}
          {tab === "inbox" && isTabVisible("inbox") && (
            <InboxManager
              initialConversations={initialConversations}
              initialStats={initialInboxStats}
              initialMessageSettings={initialMessageSettings!}
            />
          )}
          {tab === "staff" && (
            <StaffManager
              initialStaff={initialStaff}
              initialActiveShifts={initialActiveShifts}
              permissions={staffPermissions}
              tenantSlug={tenantSlug}
              timezone={timezone}
              clockSettings={initialClockSettings}
              canCustomizeBranding={initialPlan === "business"}
              shiftsEnabled={shiftsEnabled}
            />
          )}
          {tab === "analytics" && staffPermissions.analyticsView && <AnalyticsDashboard />}
          {tab === "billing" && staffPermissions.settingsManage && <BillingPanel />}
          {/* initialTenantSettings/initialKioskSettings/initialDisplaySettings/
              initialBookingSettings/initialQueueSettings/initialMessageSettings/
              initialBusinessHours are guaranteed non-null exactly when
              staffPermissions.settingsManage is true — page.tsx's
              permissions.settingsManage ternary (getSettingsData vs.
              getTenantIdentity) is the single source of that invariant, so
              the assertions below are safe. */}
          {tab === "settings" && staffPermissions.settingsManage && (
            <SettingsManager
              initialPlan={initialPlan}
              tenantSlug={tenantSlug}
              initialSettings={initialTenantSettings!}
              initialBranding={initialBranding}
              onBrandingChange={handleBrandingChange}
              initialKioskEnabled={initialKioskEnabled}
              initialKioskSettings={initialKioskSettings!}
              initialDisplaySettings={initialDisplaySettings!}
              initialClockSettings={initialClockSettings!}
              initialQueueSettings={queueSettings!}
              onQueueSettingsChange={setQueueSettings}
              initialBusinessHours={initialBusinessHours!}
              bookingEnabled={bookingEnabled}
              queueEnabled={queueEnabled}
              initialServices={initialServices}
              servicesManage={staffPermissions.servicesManage}
            />
          )}
        </main>
      </div>
    </div>
  )
}
