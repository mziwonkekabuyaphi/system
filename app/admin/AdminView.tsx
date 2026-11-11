"use client"

import { useEffect, useState } from "react"
import type { SVGProps } from "react"

import { LogoutButton } from "@/components/admin/LogoutButton"
import { BillingPanel } from "@/components/admin/BillingPanel"
import { AnalyticsDashboard } from "./analytics/AnalyticsDashboard"
import { InboxManager } from "./InboxManager"
import { PassportManager, type PassportSection } from "./passport/PassportManager"
import { QueueManager } from "./queue/QueueManager"
import { ShishaManager, type ShishaSection } from "./shisha/ShishaManager"
import { EventsManager } from "./events/EventsManager"
import type { EventsPermissions, EventsSection } from "./events/types"
import { SettingsManager } from "./SettingsManager"
import type { ModuleFlags } from "@/lib/tenant/effective-modules"
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
  | "shishaCounter"
  | "shishaRequests"
  | "shishaSessions"
  | "shishaFlavours"
  | "shishaHookahs"
  | "shishaStations"
  | "passportOverview"
  | "passportAccounts"
  | "passportRefunds"
  | "eventsList"
  | "eventsBoxOffice"
  | "eventsGate"
  | "inbox"
  | "staff"
  | "analytics"
  | "billing"
  | "settings"

/** Sidebar entry -> the Shisha page it opens. */
const SHISHA_TAB_SECTION: Partial<Record<Tab, ShishaSection>> = {
  shishaCounter: "counter",
  shishaRequests: "requests",
  shishaSessions: "sessions",
  shishaFlavours: "flavours",
  shishaHookahs: "devices",
  shishaStations: "stations",
}
const SECTION_SHISHA_TAB: Record<ShishaSection, Tab> = {
  counter: "shishaCounter",
  requests: "shishaRequests",
  sessions: "shishaSessions",
  flavours: "shishaFlavours",
  devices: "shishaHookahs",
  stations: "shishaStations",
}

/** Sidebar entry -> the Passport page it opens. */
const PASSPORT_TAB_SECTION: Partial<Record<Tab, PassportSection>> = {
  passportOverview: "overview",
  passportAccounts: "accounts",
  passportRefunds: "refunds",
}
const SECTION_PASSPORT_TAB: Record<PassportSection, Tab> = {
  overview: "passportOverview",
  accounts: "passportAccounts",
  refunds: "passportRefunds",
}

/** Sidebar entry -> the Events page it opens. */
const EVENTS_TAB_SECTION: Partial<Record<Tab, EventsSection>> = {
  eventsList: "events",
  eventsBoxOffice: "boxoffice",
  eventsGate: "gate",
}
const SECTION_EVENTS_TAB: Record<EventsSection, Tab> = {
  events: "eventsList",
  boxoffice: "eventsBoxOffice",
  gate: "eventsGate",
}

const SIDEBAR_COLLAPSED = 65 // px
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

// The Inbox is the WhatsApp inbox, so it uses Font Awesome's own WhatsApp icon (the same one the
// Rands dashboard uses). Font Awesome's stylesheet is loaded in app/admin/layout.tsx.
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <span className={`flex items-center justify-center ${className ?? ""}`} aria-hidden="true">
      <i className="fa-brands fa-whatsapp text-[1.35rem] leading-none" />
    </span>
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

function ShishaCounterIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="3.5" width="16" height="6" rx="1.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M9.5 14h5" />
    </svg>
  )
}

function ShishaRequestsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  )
}

function ShishaSessionsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function ShishaFlavoursIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 19c0-8 5-14 14-14 0 9-6 14-14 14z" />
      <path d="M5 19c3-4 6-6.5 9-8" />
    </svg>
  )
}

function ShishaStationsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z" />
      <circle cx="12" cy="10" r="2.3" />
    </svg>
  )
}

function PassportOverviewIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v1.5" />
      <path d="M4 7.5V17a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H6.5A2.5 2.5 0 0 1 4 7.5Z" />
      <circle cx="16" cy="13.5" r="1.1" />
    </svg>
  )
}

function PassportAccountsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
      <circle cx="12" cy="10" r="2.6" />
      <path d="M8 16.5c.6-1.7 2.1-2.6 4-2.6s3.4.9 4 2.6" />
    </svg>
  )
}

function PassportRefundsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 4.5v4h4" />
      <path d="M12 8.5v3.8l2.4 1.4" />
    </svg>
  )
}

function EventsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      <path d="m12 12.2.9 1.9 2.1.3-1.5 1.5.35 2.1L12 17l-1.85 1 .35-2.1L9 14.4l2.1-.3z" />
    </svg>
  )
}

function BoxOfficeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3.5 9.5 5 4.5h14l1.5 5" />
      <path d="M3.5 9.5a2.8 2.8 0 0 0 5.5 0 2.8 2.8 0 0 0 6 0 2.8 2.8 0 0 0 5.5 0" />
      <path d="M5 12.5V20h14v-7.5" />
      <path d="M10 20v-4.5h4V20" />
    </svg>
  )
}

function GateIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M8 12h8" />
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
  { id: "shishaCounter", label: "Counter", icon: ShishaCounterIcon },
  { id: "shishaRequests", label: "Requests", icon: ShishaRequestsIcon },
  { id: "shishaSessions", label: "Sessions", icon: ShishaSessionsIcon },
  { id: "shishaFlavours", label: "Flavours", icon: ShishaFlavoursIcon },
  { id: "shishaHookahs", label: "Hookahs", icon: HookahIcon },
  { id: "shishaStations", label: "Stations", icon: ShishaStationsIcon },
  { id: "passportOverview", label: "Overview", icon: PassportOverviewIcon },
  { id: "passportAccounts", label: "Accounts", icon: PassportAccountsIcon },
  { id: "passportRefunds", label: "Refunds", icon: PassportRefundsIcon },
  { id: "eventsList", label: "Events", icon: EventsIcon },
  { id: "eventsBoxOffice", label: "Box office", icon: BoxOfficeIcon },
  { id: "eventsGate", label: "Gate", icon: GateIcon },
  { id: "inbox", label: "Inbox", icon: WhatsAppIcon },
  { id: "staff", label: "Staff", icon: UsersIcon },
  { id: "analytics", label: "Analytics", icon: ChartIcon },
  { id: "billing", label: "Billing & Plans", icon: CreditCardIcon },
  { id: "settings", label: "Settings", icon: GearIcon },
]

// Sidebar sections, in the same spirit as Rands: day-to-day work, then analytics on its own, then system.
const NAV_GROUPS: Array<{ label: string; ids: Tab[] }> = [
  { label: "Control Centre", ids: ["today", "queue", "inbox", "staff"] },
  // Shown only while Shisha is switched on. Each entry is one page of the Shisha area.
  { label: "Shisha", ids: ["shishaCounter", "shishaRequests", "shishaSessions", "shishaFlavours", "shishaHookahs", "shishaStations"] },
  // Shown only while Passport (the customer wallet) is switched on and the caller can view it.
  { label: "Passport", ids: ["passportOverview", "passportAccounts", "passportRefunds"] },
  // Shown only while Events is switched on and the caller holds the matching permissions.
  { label: "Events", ids: ["eventsList", "eventsBoxOffice", "eventsGate"] },
  { label: "Analytics", ids: ["analytics"] },
  { label: "System", ids: ["billing", "settings"] },
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
  eventsEnabled,
  eventsPermissions,
  whatsappEnabled,
  staffEnabled,
  settingsModules,
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
  /** The Events module is switched on for the shop (tenant_modules). page.tsx also zeroes
   *  eventsPermissions when it is off, so both are safe to trust for showing tabs. */
  eventsEnabled: boolean
  eventsPermissions: EventsPermissions
  whatsappEnabled: boolean
  /** Staff Management is its own product. Shown when it is switched on, or when the shop runs
   *  Booking, Queue, Shisha, Shifts or Payroll (those include staff). Computed in page.tsx. */
  staffEnabled: boolean
  /** Module state from the database resolver (page.tsx). Drives which Settings pages appear. */
  settingsModules?: ModuleFlags
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
  // products; Inbox only means something when at least one of them is on.
  // Staff, Analytics, Billing and Settings stay available.
  // (Services now lives in Settings > Customer Journey, next to Kiosk and Display.
  //  Customers now lives on the Inbox page, next to Analytics and WhatsApp settings.)
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
      case "shishaSessions":
      case "shishaFlavours":
      case "shishaHookahs":
      case "shishaStations":
        return shishaEnabled && staffPermissions.shishaView
      // The counter and the customer request queue are for staff who run sessions.
      case "shishaCounter":
      case "shishaRequests":
        return shishaEnabled && staffPermissions.shishaView && staffPermissions.shishaOperate
      // Events: module on + the permission for that page. Every action re-checks both server-side.
      case "eventsList":
        return eventsEnabled && eventsPermissions.eventsView
      case "eventsBoxOffice":
        return eventsEnabled && eventsPermissions.eventsView && eventsPermissions.ticketsIssue
      case "eventsGate":
        return eventsEnabled && eventsPermissions.eventsView && eventsPermissions.ticketsScan
      // Passport: module switched on + wallet.view (page.tsx zeroes the permissions when it is off).
      // The actions re-check both server-side.
      case "passportOverview":
      case "passportAccounts":
      case "passportRefunds":
        return staffPermissions.walletView
      // Analytics has its own permission key (analytics.view). The server
      // action in app/admin/analytics/actions.ts re-checks it.
      case "analytics":
        return staffPermissions.analyticsView
      // Billing is owner-only (settings.manage is the closest owner-only key).
      case "billing":
        return staffPermissions.settingsManage
      // Inbox (WhatsApp, with Customers inside) holds phone numbers: owner-only,
      // and only for shops running Booking or Queue.
      case "inbox":
        return staffPermissions.settingsManage && hasBookingOrQueue
      case "staff":
        return staffEnabled
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
  const shishaSection = SHISHA_TAB_SECTION[tab] ?? null
  const passportSection = PASSPORT_TAB_SECTION[tab] ?? null
  const eventsSection = EVENTS_TAB_SECTION[tab] ?? null
  // A shop with no Booking/Queue has little else, so its Shisha pages go at the top of the sidebar.
  const navGroups = hasBookingOrQueue ? NAV_GROUPS : [NAV_GROUPS[1], NAV_GROUPS[0], ...NAV_GROUPS.slice(2)]

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
    adminTheme: (initialBranding.adminTheme === "dark" ? "dark" : "cream") as "cream" | "dark",
  })

  // Pop-ups (drawers, dialogs) can render outside this component's tree, so the dark look is also
  // flagged on <body>. The server layout sets it on first paint; this keeps it in step after a Save.
  useEffect(() => {
    if (branding.adminTheme === "dark") document.body.setAttribute("data-admin-theme", "dark")
    else document.body.removeAttribute("data-admin-theme")
    return () => document.body.removeAttribute("data-admin-theme")
  }, [branding.adminTheme])

  function handleBrandingChange(
    patch: Partial<{
      displayName: string | null
      logoUrl: string | null
      sidebarColor: string | null
      sidebarTextColor: string | null
      accentColor: string | null
      adminTheme: "cream" | "dark"
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
        // Matches the Rands admin sidebar: see-through tint, thin border, accent-coloured text + icon,
        // and a small glowing bar on the left edge (not a solid fill).
        navActive:
          "relative border-[color-mix(in_srgb,var(--sb-accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--sb-accent)_12%,transparent)] text-[color-mix(in_srgb,var(--sb-accent)_75%,white)] before:absolute before:left-0 before:top-[20%] before:bottom-[20%] before:w-0.5 before:rounded-full before:bg-[var(--sb-accent)] before:shadow-[0_0_8px_var(--sb-accent)]",
        navActiveIcon: "",
        navIdle:
          "text-[color:var(--sb-text-muted)] hover:bg-[var(--sb-hover)] hover:text-[color:var(--sb-text)]",
      }
    : {
        bg: "bg-admin-sidebar",
        line: "border-admin-on-sidebar/10",
        text: "text-admin-on-sidebar",
        badge: "bg-admin-accent text-admin-on-accent",
        // Matches the Rands admin sidebar: see-through tint, thin border, red text + icon,
        // and a small glowing bar on the left edge (not a solid fill).
        navActive:
          "relative border-admin-accent/25 bg-admin-accent/[0.12] text-[#ff3344] before:absolute before:left-0 before:top-[20%] before:bottom-[20%] before:w-0.5 before:rounded-full before:bg-admin-accent before:shadow-[0_0_8px_var(--color-admin-accent)]",
        navActiveIcon: "",
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
      data-admin-theme={branding.adminTheme === "dark" ? "dark" : "cream"}
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
        {/* Dark theme only: the thin glowing line down the sidebar's left edge (as in Rands).
            Fades in while the sidebar is open, in the shop's accent colour when one is set. */}
        {branding.adminTheme === "dark" && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute bottom-[20%] left-0 top-[20%] w-0.5 bg-[linear-gradient(180deg,transparent,var(--sb-accent,var(--color-admin-accent))_50%,transparent)] transition-opacity duration-200 ease-out ${
              expanded ? "opacity-100" : "opacity-0"
            }`}
          />
        )}

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
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
          {navGroups.map((group, gi) => {
            const items = group.ids
              .map((id) => visibleTabs.find((t) => t.id === id))
              .filter((t): t is (typeof TABS)[number] => !!t)
            if (items.length === 0) return null
            return (
              <div key={group.label} className="flex flex-col gap-1">
                {gi > 0 && <div className={`mx-1 my-2 border-t ${SB.line}`} />}
                {/* Collapsed: a small dot over the icons. Expanded: the section name. */}
                <div className="relative h-5 px-3">
                  <span
                    aria-hidden="true"
                    className={`absolute left-[22px] top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-30 transition-opacity duration-150 ${SB.text} ${
                      expanded ? "!opacity-0" : ""
                    }`}
                  />
                  <p
                    className={`whitespace-nowrap text-[0.65rem] font-bold uppercase tracking-[0.1em] opacity-0 transition-opacity duration-150 ${SB.text} ${
                      expanded ? "!opacity-50 delay-100" : ""
                    }`}
                  >
                    {group.label}
                  </p>
                </div>
                {items.map((t) => {
                  const Icon = t.icon
                  const active = tab === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      aria-current={active ? "page" : undefined}
                      title={t.label}
                      className={`flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm transition-colors ${
                        active ? SB.navActive : SB.navIdle
                      }`}
                    >
                      <Icon className={`h-5 w-5 shrink-0 ${active ? SB.navActiveIcon : ""}`} />
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
              </div>
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
              className="h-10 w-10 shrink-0 rounded-lg border border-stone-200 object-contain bg-card"
            />
          )}
          <div>
            <h1 className="font-[family-name:var(--font-admin-serif)] text-2xl tracking-tight text-stone-900">
              {brandName}
            </h1>
            <p className="mt-1 text-sm text-stone-500">
              {shishaSection ? "Shisha · " : passportSection ? "Passport · " : eventsSection ? "Events · " : ""}
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
          {/* One Shisha page for all six sidebar entries, so moving between them keeps the live data
              (no reload). The sidebar entry decides which page it shows. */}
          {shishaSection && isTabVisible(tab) && (
            <ShishaManager
              timezone={timezone}
              canOperate={staffPermissions.shishaOperate}
              canManage={staffPermissions.shishaManage}
              section={shishaSection}
              onSectionChange={(next) => setTab(SECTION_SHISHA_TAB[next])}
            />
          )}
          {/* One Passport page for the three sidebar entries, same idea as Shisha above. */}
          {passportSection && isTabVisible(tab) && (
            <PassportManager
              timezone={timezone}
              canOperate={staffPermissions.walletOperate || staffPermissions.walletManage}
              canManage={staffPermissions.walletManage}
              section={passportSection}
              onSectionChange={(next) => setTab(SECTION_PASSPORT_TAB[next])}
            />
          )}
          {/* One Events page for the three sidebar entries, so the event list stays loaded
              while moving between Events, Box office and Gate (same idea as Shisha/Passport). */}
          {eventsSection && isTabVisible(tab) && (
            <EventsManager
              section={eventsSection}
              onSectionChange={(next) => setTab(SECTION_EVENTS_TAB[next])}
              permissions={eventsPermissions}
              timezone={timezone}
              currency={initialTenantSettings?.currency ?? "ZAR"}
              // Passport pays for tickets only when it is on (page.tsx zeroes walletView when off)
              // and this person is allowed to charge one.
              canChargePassport={
                staffPermissions.walletView && (staffPermissions.walletOperate || staffPermissions.walletManage)
              }
            />
          )}
          {tab === "inbox" && isTabVisible("inbox") && (
            <InboxManager
              initialConversations={initialConversations}
              initialStats={initialInboxStats}
              initialMessageSettings={initialMessageSettings!}
              timezone={timezone}
            />
          )}
          {tab === "staff" && staffEnabled && (
            <StaffManager
              initialStaff={initialStaff}
              initialActiveShifts={initialActiveShifts}
              permissions={staffPermissions}
              tenantSlug={tenantSlug}
              timezone={timezone}
              clockSettings={initialClockSettings}
              canCustomizeBranding={initialPlan === "business"}
              shiftsEnabled={shiftsEnabled}
              whatsappEnabled={whatsappEnabled}
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
              modules={settingsModules}
              bookingEnabled={bookingEnabled}
              queueEnabled={queueEnabled}
              shishaEnabled={shishaEnabled && staffPermissions.shishaView}
              shishaManage={staffPermissions.shishaManage}
              passportEnabled={staffPermissions.walletView}
              passportManage={staffPermissions.walletManage}
              initialServices={initialServices}
              servicesManage={staffPermissions.servicesManage}
            />
          )}
        </main>
      </div>
    </div>
  )
}
