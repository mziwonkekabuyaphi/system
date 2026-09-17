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

/** Base staff profile — everything gated behind staff.view. Deliberately
 *  excludes hourlyRate: compensation data is payroll.view territory (see
 *  AdminStaffPermissions / the `permissions.key` rows added by the
 *  staff_payroll_activity_log_and_granular_permissions migration), so a
 *  staff.view-only caller must never receive it, not even as `null`. */
export interface AdminStaff {
  id: string
  name: string
  active: boolean
  jobTitle: string | null
  phone: string | null
  email: string | null
  /** Current PIN, shown back in the edit form (this is an admin-only
   *  screen, same posture as showing any other tenant setting). Staff use
   *  this PIN to clock in/out at the public /clock/[slug] pad. */
  clockInPin: string | null
  /** Present ONLY when the caller has payroll.view — app/admin/page.tsx's
   *  getAllStaff() adds this key conditionally rather than always
   *  including it as null, so the key's mere presence is meaningful.
   *  Check with `"hourlyRate" in member`, not `member.hourlyRate != null`
   *  (a real rate can legitimately be null — "not yet set"). */
  hourlyRate?: number | null
}

/** Payload shape for addStaff()/updateStaff() in actions.ts. clockInPin as
 *  an empty string means "no PIN" on create and "leave unchanged" on
 *  update — see updateStaff's implementation.
 *
 *  hourlyRate is optional and permission-gated independently of the rest
 *  of this input: setting it (to a number OR to null) always requires
 *  payroll.manage in addition to staff.manage, checked server-side in
 *  actions.ts. Omit the key entirely (don't include `hourlyRate:
 *  undefined` in the object you send) when the signed-in user doesn't
 *  have payroll.manage — updateStaff() then leaves hourly_rate untouched,
 *  and addStaff() defaults it to null. StaffManager.tsx only renders the
 *  rate field at all when the `payrollManage` permission flag is true. */
export interface AdminStaffInput {
  name: string
  jobTitle: string
  phone: string
  email: string
  clockInPin: string
  hourlyRate?: number | null
}

/** Permission flags resolved once per request in app/admin/page.tsx (see
 *  getTenantPermissions() in lib/tenant/require-tenant-permission.ts) and
 *  threaded down through AdminView into every staff/payroll/activity-log
 *  component. These gate which tabs, fields, and action buttons render —
 *  the actual enforcement lives server-side in actions.ts and RLS; this
 *  is purely "don't show controls the server will reject anyway". */
export interface AdminStaffPermissions {
  staffView: boolean
  staffManage: boolean
  payrollView: boolean
  payrollManage: boolean
}

/** A currently-open row in staff_shifts, joined with the staff member's
 *  name for display in StaffManager.tsx's "Currently clocked in" panel. */
export interface AdminStaffShift {
  id: string
  staffId: string
  staffName: string
  /** ISO timestamp */
  loginTime: string
}

export interface AdminQueueEntry {
  id: string
  status: "waiting" | "called"
  /** ISO timestamp */
  joinedAt: string
  serviceName: string
  customerName: string | null
  customerPhone: string
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

  // -- Screen wording (multi-tenant copy customization) --------------------
  // Every field below is null/empty-safe: an unset value falls back to the
  // same English copy the kiosk always used to hardcode, resolved in
  // app/kiosk/[slug]/page.tsx (DEFAULT_CHOICE_TITLE etc.) the same way
  // tagline/colors already fall back. Only rendered on the kiosk when
  // registrationType === "both" shows the choice screen at all, but a
  // tenant can still set them ahead of switching registrationType later.

  /** Heading on the book-vs-queue choice screen. Defaults to
   *  "How can we help you today?". */
  choiceTitle: string | null
  /** Title on the "book a time" card. Defaults to "Book a time". */
  bookingCardTitle: string | null
  /** Subtitle on the "book a time" card. Defaults to "Pick a date and
   *  time that works for you". */
  bookingCardSubtitle: string | null
  /** Title on the "join the queue" card. Defaults to "Join the queue". */
  queueCardTitle: string | null
  /** Subtitle on the "join the queue" card. Defaults to "Walk in now and
   *  we'll call you". */
  queueCardSubtitle: string | null
  /** Heading on the service-picker screen (the screen right after the
   *  choice screen, or right after welcome on a booking-only/queue-only
   *  kiosk). Defaults to "What are you here for?". */
  serviceScreenTitle: string | null
  /** Heading on the date-picker screen (booking path only, right after
   *  the service picker). Defaults to "Which day works for you?". */
  dateScreenTitle: string | null
  /** Heading prefix on the time-picker screen (booking path only, right
   *  after the date picker — or right after the service picker on a
   *  same-day-only kiosk, since that path skips the date screen). The
   *  kiosk appends " — {date label}" itself (e.g. "Pick a time — Today"
   *  or "Pick a time — Fri 19 Sep"), so this field is just the prefix.
   *  Defaults to "Pick a time". */
  timeScreenTitle: string | null
  /** Heading on the name/phone screen — the last input screen before
   *  submitting, for both the booking and queue paths. Defaults to
   *  "Almost done — who are we booking for?". */
  detailsScreenTitle: string | null
  /** Small label above the ticket number on the final confirmation
   *  screen, booking path. Defaults to "Your booking". */
  ticketBookingEyebrow: string | null
  /** Small label above the ticket number on the final confirmation
   *  screen, queue path. Defaults to "Your place in line". */
  ticketQueueEyebrow: string | null
}

// ============================================================================
// SETTINGS (Booking / Queue / Messages tab)
// ============================================================================

/** booking_settings, one row per tenant.
 *
 *  unifyWithQueue is the flagship toggle for the "unified platform" work:
 *  when true, the promote_bookings_to_queue() pg_cron job (runs every
 *  minute) starts inserting this tenant's confirmed bookings into
 *  queue_entries once they enter queueLeadTimeMinutes of start_time, with
 *  queue_entries.source = 'booking' and booking_id set back to this row.
 *  When false, bookings and the walk-in queue stay fully separate, same as
 *  before this feature existed. */
export interface AdminBookingSettings {
  unifyWithQueue: boolean
  queueLeadTimeMinutes: number
  minNoticeMinutes: number
  maxAdvanceDays: number
  cancellationWindowMinutes: number
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

// ============================================================================
// PAYROLL (staff_payroll — gated behind payroll.view / payroll.manage)
// ============================================================================

export type AdminPayrollStatus = "pending" | "paid"

/** One calculated payroll row for one staff member over one period. Only
 *  ever sent to a caller with payroll.view — see getPayrollForPeriod() /
 *  calculatePayroll() in actions.ts, both of which require it. */
export interface AdminPayrollRecord {
  id: string
  staffId: string
  staffName: string
  jobTitle: string | null
  /** ISO date (YYYY-MM-DD), inclusive. */
  periodStart: string
  /** ISO date (YYYY-MM-DD), inclusive. */
  periodEnd: string
  hoursWorked: number
  hourlyRate: number
  grossPay: number
  /** Estimated SARS PAYE for the period — see lib/payroll/paye.ts. */
  paye: number
  /** Estimated employee UIF (1%, capped) for the period. */
  uif: number
  /** paye + uif, kept as its own column for quick display/CSV export. */
  deductions: number
  finalPay: number
  paymentStatus: AdminPayrollStatus
  /** ISO timestamp, set when payment_status flips to 'paid'. */
  paidAt: string | null
  /** Display name of whoever marked it paid, resolved server-side —
   *  never a raw profile id. Null while pending. */
  paidByName: string | null
}

/** Pay period preset shown in the calculator UI; 'custom' means the user
 *  picked their own start/end dates rather than one of the presets. */
export type AdminPayPeriodPreset = "weekly" | "biweekly" | "monthly" | "custom"

// ============================================================================
// ACTIVITY LOG (staff_activity_logs — category='payroll' rows additionally
// gated behind payroll.view; every other category needs only staff.view)
// ============================================================================

export type AdminActivityCategory = "staff" | "clock" | "bookings" | "queue" | "services" | "payroll"

export interface AdminActivityLogEntry {
  id: string
  category: AdminActivityCategory
  /** Human-readable description, e.g. "Force clocked out after 2h 14m" —
   *  deliberately never contains raw rand amounts or other figures that
   *  would need their own permission check independent of the category. */
  action: string
  /** Null for actions that aren't about a specific staff member (e.g. a
   *  booking cancellation). */
  staffId: string | null
  staffName: string | null
  /** Display name of the admin who performed the action, resolved
   *  server-side. Null if the actor's profile has since been removed. */
  actorName: string | null
  /** ISO timestamp. */
  createdAt: string
}
