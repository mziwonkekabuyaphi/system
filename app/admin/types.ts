// app/admin/types.ts
//
// Shared shapes for the shop-owner admin view. Kept separate from
// booking.ts's internal BookingServiceOffer/BookingSlot types since those
// are shaped for the WhatsApp conversation flow, not table display.

export interface AdminService {
  id: string
  name: string
  price: number
  durationMinutes: number
  active: boolean
}

export interface AdminStaff {
  id: string
  name: string
  active: boolean
}

/** UPDATED: `source` and the three queue-simulation fields let the admin
 *  UI tell a promoted booking apart from an ordinary walk-in, and show a
 *  staff-facing position/ETA that actually accounts for staff capacity
 *  (see lib/services/queue.ts's getQueueSimulation(), which page.tsx's
 *  getTodaysQueue() now calls to populate these). position/etaMinutes/
 *  runningLate are optional because a "called" entry (already being
 *  served) doesn't have a meaningful queue position — see
 *  getQueueSimulation()'s own doc comment for exactly what each means. */
export interface AdminQueueEntry {
  id: string
  status: "waiting" | "called"
  /** ISO timestamp */
  joinedAt: string
  serviceName: string
  customerName: string | null
  customerPhone: string
  /** 'booking' when this entry was created by the booking→queue
   *  promotion job (app/api/cron/promote-bookings/route.ts), 'walkin'
   *  for a kiosk/WhatsApp walk-in. Mirrors queue_entries.source. */
  source: "walkin" | "booking"
  /** 1-based position in line, accounting for active staff capacity.
   *  Undefined for a 'called' entry (already being served). */
  position?: number
  /** Minutes until this entry's simulated turn. Undefined for a
   *  'called' entry. */
  etaMinutes?: number
  /** Only ever true for a 'booking'-sourced entry in 'hybrid' queue
   *  priority mode: the simulated wait would run past the booking's
   *  actual appointment time. Always false/undefined otherwise — see
   *  booking_settings.queue_priority_mode. */
  runningLate?: boolean
}

export interface AdminBooking {
  id: string
  /** ISO timestamp */
  startTime: string
  /** ISO timestamp */
  endTime: string
  status: "confirmed" | "cancelled"
  bookingReference: string
  serviceName: string
  staffName: string
  /** null when the customer has never given a name (see booking.ts's
   *  BOOKING_STATE_AWAITING_NAME flow — booking without a name is valid). */
  customerName: string | null
  customerPhone: string
}

// ============================================================================
// INBOX (ported from the old whatsapp-admin.html/admin.js standalone panel —
// see InboxManager.tsx's file header for what was kept vs cut)
// ============================================================================

/** Bucketed from conversation_states.state — mirrors admin.js's
 *  AI_OFF_STATES/CLOSED_STATES grouping, collapsed to the 4 states the
 *  admin UI actually acts on. */
export type AdminAiState = "active" | "paused" | "handoff" | "resolved"

export interface AdminConversationSummary {
  id: string
  phone: string
  customerName: string | null
  lastMessagePreview: string | null
  /** ISO timestamp, null when there's no message yet. */
  lastMessageAt: string | null
  aiState: AdminAiState
  /** Count within the recent-message sample used to build the inbox (see
   *  page.tsx's getInboxConversations) — a floor, not an exact lifetime
   *  total, for any conversation older than that window. */
  messageCount: number
}

export interface AdminMessage {
  id: string
  direction: "incoming" | "outgoing"
  text: string | null
  /** ISO timestamp */
  createdAt: string
}

export interface AdminInboxStats {
  totalConversations: number
  aiActiveCount: number
  needsHumanCount: number
  /** Last 7 days, oldest first. */
  volumeByDay: Array<{ date: string; incoming: number; outgoing: number }>
  topCustomers: Array<{ name: string; phone: string; messageCount: number }>
}

// ============================================================================
// SETTINGS (General info / Kiosk / Private Label tab)
// ============================================================================

/** Mirrors tenants.plan. Manually flipped in Supabase until billing is wired
 *  up — see the migration comment on the column itself. Gates whether
 *  AdminBranding.removePoweredBy can be set to true. */
export type AdminPlan = "starter" | "business"

/** tenant_settings, one row per tenant. */
export interface AdminTenantSettings {
  timezone: string
  currency: string
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
}

/** tenant_branding, one row per tenant. removePoweredBy can only be true
 *  when the tenant's plan is 'business' — enforced in settings-actions.ts
 *  and, as a backstop, by a DB trigger on the column itself.
 *
 *  This is the single source of truth for how the shop is branded across
 *  every customer-facing surface (kiosk, booking/queue confirmations,
 *  WhatsApp). It's edited in exactly one place in the admin UI — the
 *  Private Label tab (see PrivateLabelPanel / BrandingFields in
 *  SettingsManager.tsx) — via updateBranding()/uploadLogo()/removeLogo().
 *  Other tabs (Kiosk) read this data but must never render their own copy
 *  of these controls. */
export interface AdminBranding {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  removePoweredBy: boolean
}

/** Which paths the public kiosk offers. Mirrors
 *  tenant_branding.registration_type (migration_kiosk_settings.sql) and
 *  app/kiosk/[slug]/page.tsx's KioskRegistrationType — kept as its own
 *  named type here (rather than admin code importing the kiosk route's
 *  type directly) so nothing outside app/kiosk/[slug]/ ever has to import
 *  from that route's page.tsx. Cross-importing from a Next.js page/layout
 *  file into unrelated server code (e.g. a "use server" actions file) is
 *  fragile — it pulls that file into a module graph it doesn't belong to
 *  — so admin code (settings-actions.ts, SettingsManager.tsx) should
 *  import this type from here instead. */
export type AdminKioskRegistrationType = "booking" | "queue" | "both"

/** tenant_branding's kiosk-behavior columns, one row per tenant. Separate
 *  from AdminBranding (and saved by its own action, updateKioskSettings)
 *  because these fields are plan-agnostic kiosk mechanics, not brand
 *  identity — see the Kiosk tab in SettingsManager.tsx. */
export interface AdminKioskSettings {
  /** null/empty falls back to "Tap anywhere to check in" — see
   *  app/kiosk/[slug]/page.tsx's DEFAULT_TAGLINE. */
  tagline: string | null
  /** Seconds of inactivity before the kiosk resets to welcome. 10–600. */
  idleRefreshSeconds: number
  /** Seconds the ticket confirmation screen stays up before auto-returning
   *  to welcome. 3–120. */
  confirmationRefreshSeconds: number
  registrationType: AdminKioskRegistrationType
}

// ============================================================================
// SETTINGS (Booking / Queue / Messages tab)
// ============================================================================

/** Mirrors booking_settings.queue_priority_mode (added by
 *  supabase/migrations/20260915_add_queue_priority_mode.sql). Kept as its
 *  own named type here rather than importing from
 *  lib/services/shared/tenant-scheduling.ts's QueuePriorityMode — same
 *  cross-boundary-import reasoning as AdminKioskRegistrationType above:
 *  "use server" admin code shouldn't reach into lib/services just to
 *  borrow a string union, so the two are intentionally kept in sync by
 *  hand rather than shared by import. See lib/services/queue.ts's
 *  getQueueSimulation() for exactly what each value does. */
export type AdminQueuePriorityMode = "fifo" | "priority" | "hybrid"

/** booking_settings, one row per tenant.
 *
 *  unifyWithQueue is the flagship toggle for the "unified platform" work:
 *  when true, app/api/cron/promote-bookings/route.ts (invoked on a
 *  schedule) starts inserting this tenant's confirmed bookings into
 *  queue_entries once they enter queueLeadTimeMinutes of start_time, with
 *  queue_entries.source = 'booking' and booking_id set back to this row.
 *  When false, bookings and the walk-in queue stay fully separate.
 *
 *  queuePriorityMode only matters once a booking has actually been
 *  promoted (i.e. only has any effect when unifyWithQueue is true) — see
 *  lib/services/queue.ts's getQueueSimulation(). */
export interface AdminBookingSettings {
  unifyWithQueue: boolean
  queueLeadTimeMinutes: number
  minNoticeMinutes: number
  maxAdvanceDays: number
  cancellationWindowMinutes: number
  queuePriorityMode: AdminQueuePriorityMode
}

/** queue_settings, one row per tenant. */
export interface AdminQueueSettings {
  autoCallNext: boolean
  /** null = no cap. */
  maxQueueSize: number | null
  notifyBeforeTurnPosition: number
  allowWalkinWhatsapp: boolean
  allowWalkinKiosk: boolean
}

/** message_settings, one row per tenant. WhatsApp copy used by the booking
 *  and queue notify flows (incl. notify_queue_entry() in Postgres); a null
 *  template means the sending code falls back to its hardcoded default. */
export interface AdminMessageSettings {
  aiEnabledDefault: boolean
  bookingConfirmationTemplate: string | null
  bookingReminderTemplate: string | null
  queueJoinedTemplate: string | null
  queueAlmostTurnTemplate: string | null
  queueCalledTemplate: string | null
}
