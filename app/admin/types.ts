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
 *  and, as a backstop, by a DB trigger on the column itself. */
export interface AdminBranding {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  removePoweredBy: boolean
}
