// app/admin/settings-actions.ts
"use server"

/**
 * Settings tab actions — General info / Kiosk / Private Label / Booking /
 * Queue / Messages / Business Hours.
 *
 * Same shape as actions.ts and inbox-actions.ts: requireTenantMember() is
 * the auth+membership gate (redirects to /login if there's no session or
 * no active membership — same call page.tsx's layout already makes, and
 * React's cache() means it's free here), then every query still filters by
 * .eq("tenant_id", tenantId) even though we're on the service-role client.
 * Belt and suspenders on purpose, same reasoning as page.tsx: this bypasses
 * RLS entirely, so the manual filter is the only thing standing between a
 * bug and cross-tenant writes.
 *
 * The one rule that matters most here: remove_powered_by can only be switched
 * ON when the tenant's plan includes the 'remove_powered_by' module (today:
 * Business, via plan_modules). That's checked below AND by a DB trigger on
 * tenant_branding (enforce_remove_powered_by_requires_business, which reads
 * the same plan_modules table), so even a direct SQL write or a future admin
 * tool can't bypass it. Plan contents live ONLY in plan_modules -- never
 * hardcode a plan key here.
 *
 * Logo upload writes to the 'branding' Storage bucket (public read, 2MB
 * limit, image/png|jpeg|webp|svg+xml only — enforced by the bucket itself,
 * checked again below so the UI gets a clean error instead of a raw storage
 * error) at a fixed key per tenant (branding/{tenantId}/logo) so re-uploads
 * overwrite in place rather than accumulating orphaned files.
 *
 * updateBookingSettings (UPDATED): now validates every numeric field
 * server-side before writing — mirroring updateKioskSettings' bounds
 * checks below — rather than relying only on the browser's <input min=…>
 * and the database's own CHECK constraints. The DB constraints
 * (queue_lead_time_minutes >= 0, min_notice_minutes >= 0,
 * max_advance_days >= 0, cancellation_window_minutes >= 0) are unchanged
 * and still the final backstop; this is defense in depth, not a
 * replacement for them. max_advance_days = 0 is a supported value
 * ("same-day booking only" — see MIN_MAX_ADVANCE_DAYS below), not an
 * edge case to reject. These five fields are also now genuinely
 * enforced by the booking flow itself — see
 * lib/services/shared/tenant-scheduling.ts, lib/services/booking.ts, and
 * app/admin/actions.ts's cancelBooking() — this action was already
 * correctly reading/writing the one `booking_settings` row per tenant;
 * it just had no validation of its own and nothing downstream read the
 * values back until now.
 *
 * updateBookingSettings' unifyWithQueue is the on/off switch for booking
 * → queue promotion. Previously described in this comment as being
 * driven by an existing `promote_bookings_to_queue()` pg_cron job — a
 * repo-wide search (is_tenant_open_now, promote_bookings_to_queue,
 * pg_cron, cron.schedule) across every file available for inspection
 * found no such job, migration, or scheduler config, so that was
 * evidently describing an intended design that was never built. The real
 * mechanism is now app/api/cron/promote-bookings/route.ts, a plain Route
 * Handler meant to be invoked on a ~1-minute schedule by whatever
 * external scheduler this deploys with (see that file's header for
 * details) — it reads this exact `booking_settings` row per tenant
 * (unify_with_queue, queue_lead_time_minutes), so flipping the toggle
 * here takes effect on its next invocation, no revalidation needed on
 * the Postgres side, only on the Next.js cache below.
 *
 * updateBusinessHours writes business_hours (one row per day, 0=Sunday..
 * 6=Saturday). These rows are read directly by
 * lib/services/shared/tenant-scheduling.ts's getBusinessHoursForDate(),
 * which lib/services/booking.ts now uses for every availability
 * calculation and booking-creation check — so this form is the real
 * control for what can be booked, not just a label. is_closed=true
 * requires open/close to be null; open<close is enforced by a DB check
 * constraint, validated here first so the error reads cleanly instead of
 * as a raw Postgres message.
 *
 * updateKioskSettings (tagline / idle-refresh / confirmation-refresh /
 * registration-type / screen wording) all live on tenant_branding too (see
 * migration_kiosk_settings.sql and migration_kiosk_wording.sql), read
 * straight back out by app/kiosk/[slug]/page.tsx and handed to KioskApp as
 * props. Bounds on the two timing fields are validated here to match the
 * DB check constraints (idle: 10-600s, confirmation: 3-120s) so a bad
 * value fails with a clean message instead of a raw Postgres constraint
 * error. registrationType is plan-agnostic — unlike remove_powered_by, any
 * tenant can lock their kiosk to booking-only or queue-only regardless of
 * plan.
 *
 * Screen wording (choiceTitle / bookingCardTitle / bookingCardSubtitle /
 * queueCardTitle / queueCardSubtitle / serviceScreenTitle) is the
 * multi-tenant customization layer for copy that used to be hardcoded in
 * components/kiosk/KioskApp.tsx — every tenant can now rename "Book a
 * time" / "Join the queue" / "What are you here for?" (and their
 * subtitles) to match their own business without a code change. Length-
 * capped, not content-validated: this is free-text a tenant controls for
 * their own kiosk, same trust level as tagline. An empty string is
 * normalized to null here so the kiosk route's fallback logic only has
 * one "unset" value to check.
 *
 * registrationType is typed as AdminKioskRegistrationType from ./types,
 * NOT re-imported from app/kiosk/[slug]/page.tsx — this file is
 * "use server" and shouldn't pull in a route's page module (even for a
 * type-only import) just to borrow a string union.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { tenantHasModule, MODULE_KEYS } from "@/lib/services/plans"
import type { AdminKioskRegistrationType, AdminQueuePriorityMode } from "./types"

type ActionResult = { success: true } | { success: false; error: string }
type LogoActionResult = { success: true; logoUrl: string } | { success: false; error: string }

const LOGO_BUCKET = "branding"
const MAX_LOGO_BYTES = 2 * 1024 * 1024 // keep in sync with the bucket's file_size_limit
const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

const MIN_IDLE_REFRESH_SECONDS = 10
const MAX_IDLE_REFRESH_SECONDS = 600
const MIN_CONFIRMATION_REFRESH_SECONDS = 3
const MAX_CONFIRMATION_REFRESH_SECONDS = 120

// Kiosk wording bounds — generous enough for translated copy (which often
// runs longer than English) while keeping the choice screen's two cards
// from overflowing a touch layout designed around ~1-2 short lines each.
const MAX_CHOICE_TITLE_LENGTH = 80
const MAX_CARD_TITLE_LENGTH = 40
const MAX_CARD_SUBTITLE_LENGTH = 100
const MAX_SERVICE_SCREEN_TITLE_LENGTH = 80
const VALID_REGISTRATION_TYPES: AdminKioskRegistrationType[] = ["booking", "queue", "both"]

// Mirrors booking_settings' own CHECK constraints — validated here too so
// a bad value fails with a clean message instead of a raw Postgres
// constraint error (same reasoning as the kiosk bounds above).
//
// MIN_MAX_ADVANCE_DAYS = 0, not 1: the DB constraint is
// `max_advance_days >= 0` (see booking_settings_max_advance_days_check),
// and 0 is a real, supported value — "same-day booking only", where the
// kiosk/booking flow skips the date picker and goes straight to today's
// available times. This constant previously said 1, silently rejecting
// that value here even though both the DB and the Settings UI (its
// min={0} input and "Set to 0 for same-day booking only" hint) already
// expected 0 to work.
const MIN_QUEUE_LEAD_TIME_MINUTES = 0
const MIN_NOTICE_MINUTES_FLOOR = 0
const MIN_MAX_ADVANCE_DAYS = 0
const MIN_CANCELLATION_WINDOW_MINUTES = 0
const VALID_QUEUE_PRIORITY_MODES: AdminQueuePriorityMode[] = ["fifo", "priority", "hybrid"]

// Mirrors queue_settings.ticket_number_prefix's own CHECK constraint
// (char_length BETWEEN 1 AND 4) — validated here too for a clean error
// message rather than a raw Postgres constraint violation.
const MIN_TICKET_NUMBER_PREFIX_LENGTH = 1
const MAX_TICKET_NUMBER_PREFIX_LENGTH = 4

// Mirrors tenant_branding's own display_* CHECK constraints — validated
// here too, same reasoning as every other bounds check in this file.
const MIN_DISPLAY_WELCOME_SECONDS = 2
const MAX_DISPLAY_WELCOME_SECONDS = 30
const MIN_DISPLAY_MENU_BOOKINGS_SECONDS = 3
const MAX_DISPLAY_MENU_BOOKINGS_SECONDS = 120
const MIN_DISPLAY_QUEUE_SECONDS = 3
const MAX_DISPLAY_QUEUE_SECONDS = 300
const MAX_DISPLAY_TITLE_LENGTH = 60
const MAX_DISPLAY_LABEL_LENGTH = 40
const MAX_DISPLAY_TAGLINE_LENGTH = 80

async function tenantContext() {
  const { tenantId, roleKey } = await requireTenantMember()
  // tenant_staff has no settings.manage permission; this file uses the
  // service-role client which bypasses RLS entirely, so this role check
  // is the only thing preventing tenant_staff from writing to settings
  // tables.
  if (roleKey !== "tenant_owner") {
    throw new Error("Not authorized")
  }
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId }
}

// ---------------------------------------------------------------------------
// General info — tenant_settings
// ---------------------------------------------------------------------------
export async function updateGeneralInfo(input: {
  timezone: string
  currency: string
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("tenant_settings")
      .update({
        timezone: input.timezone,
        currency: input.currency,
        contact_email: input.contactEmail,
        contact_phone: input.contactPhone,
        address: input.address,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Kiosk toggle — tenant_modules (module key: 'kiosk')
// ---------------------------------------------------------------------------
export async function setKioskEnabled(enabled: boolean): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { data: kioskModule, error: moduleLookupError } = await supabase
      .from("modules")
      .select("id")
      .eq("key", "kiosk")
      .single()

    if (moduleLookupError || !kioskModule) {
      return { success: false, error: "Kiosk module is not registered" }
    }

    // Turning the kiosk OFF is always allowed; turning it ON requires the
    // plan to include it. (The kiosk page and actions re-check this on
    // every request, so this is for a clear message, not the only gate.)
    if (enabled) {
      let allowed = false
      try {
        allowed = await tenantHasModule(supabase, tenantId, MODULE_KEYS.kiosk)
      } catch {
        return { success: false, error: "Could not verify plan" }
      }
      if (!allowed) {
        return { success: false, error: "The self-service kiosk isn't included in your current plan. Upgrade to enable it." }
      }
    }

    // upsert, not update: a tenant has no tenant_modules row for a module
    // until something creates one, and .update() on a missing row changes
    // nothing while still reporting success.
    const { error } = await supabase.from("tenant_modules").upsert(
      {
        tenant_id: tenantId,
        module_id: kioskModule.id,
        enabled,
        enabled_at: enabled ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,module_id" },
    )

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Branding + Private Label — tenant_branding
// ---------------------------------------------------------------------------
export async function updateBranding(input: {
  displayName: string | null
  primaryColor: string | null
  secondaryColor: string | null
  removePoweredBy: boolean
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    if (input.removePoweredBy) {
      let allowed = false
      try {
        allowed = await tenantHasModule(supabase, tenantId, MODULE_KEYS.removePoweredBy)
      } catch {
        return { success: false, error: "Could not verify plan" }
      }

      if (!allowed) {
        return {
          success: false,
          error: 'Removing "Powered by" requires the Business plan. Upgrade to enable this.',
        }
      }
    }

    // Custom brand colours (and the logo, see uploadLogo) need the
    // 'branding' module. Display name stays free on every plan. Without the
    // module, colours may be SAVED UNCHANGED (the form always re-sends the
    // current values) but not changed -- and we never write the colour
    // columns at all, so a tampered request can't slip a new colour through.
    let canCustomizeBranding = false
    try {
      canCustomizeBranding = await tenantHasModule(supabase, tenantId, MODULE_KEYS.branding)
    } catch {
      return { success: false, error: "Could not verify plan" }
    }

    const updates: Record<string, unknown> = {
      display_name: input.displayName,
      remove_powered_by: input.removePoweredBy,
      updated_at: new Date().toISOString(),
    }

    if (canCustomizeBranding) {
      updates.primary_color = input.primaryColor
      updates.secondary_color = input.secondaryColor
    } else {
      const { data: current } = await supabase
        .from("tenant_branding")
        .select("primary_color, secondary_color")
        .eq("tenant_id", tenantId)
        .maybeSingle()

      const norm = (v: string | null | undefined) => (v ?? "").toLowerCase()
      if (
        norm(input.primaryColor) !== norm(current?.primary_color) ||
        norm(input.secondaryColor) !== norm(current?.secondary_color)
      ) {
        return {
          success: false,
          error: "Custom brand colours aren't included in your current plan. Upgrade to change them.",
        }
      }
    }

    const { error } = await supabase.from("tenant_branding").update(updates).eq("tenant_id", tenantId)

    if (error) {
      if (error.message.includes("remove_powered_by can only be enabled")) {
        return {
          success: false,
          error: 'Removing "Powered by" requires the Business plan. Upgrade to enable this.',
        }
      }
      return { success: false, error: error.message }
    }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Kiosk behavior settings — tenant_branding
// ---------------------------------------------------------------------------
export async function updateKioskSettings(input: {
  tagline: string | null
  idleRefreshSeconds: number
  confirmationRefreshSeconds: number
  registrationType: AdminKioskRegistrationType
  // Screen wording — every field optional/nullable. Omitting a key (or
  // sending null/"") clears the override and the kiosk falls back to its
  // hardcoded default, same posture as tagline above.
  choiceTitle?: string | null
  bookingCardTitle?: string | null
  bookingCardSubtitle?: string | null
  queueCardTitle?: string | null
  queueCardSubtitle?: string | null
  /** Heading on the service-picker screen. Optional/nullable, same
   *  clear-to-default posture as the choice-screen wording above. */
  serviceScreenTitle?: string | null
}): Promise<ActionResult> {
  try {
    if (
      !Number.isFinite(input.idleRefreshSeconds) ||
      input.idleRefreshSeconds < MIN_IDLE_REFRESH_SECONDS ||
      input.idleRefreshSeconds > MAX_IDLE_REFRESH_SECONDS
    ) {
      return {
        success: false,
        error: `Idle refresh time must be between ${MIN_IDLE_REFRESH_SECONDS} and ${MAX_IDLE_REFRESH_SECONDS} seconds.`,
      }
    }

    if (
      !Number.isFinite(input.confirmationRefreshSeconds) ||
      input.confirmationRefreshSeconds < MIN_CONFIRMATION_REFRESH_SECONDS ||
      input.confirmationRefreshSeconds > MAX_CONFIRMATION_REFRESH_SECONDS
    ) {
      return {
        success: false,
        error: `Confirmation refresh time must be between ${MIN_CONFIRMATION_REFRESH_SECONDS} and ${MAX_CONFIRMATION_REFRESH_SECONDS} seconds.`,
      }
    }

    if (!VALID_REGISTRATION_TYPES.includes(input.registrationType)) {
      return { success: false, error: "Choose a valid registration type." }
    }

    const wordingFields: Array<{ label: string; value: string | null | undefined; max: number }> = [
      { label: "Choice screen title", value: input.choiceTitle, max: MAX_CHOICE_TITLE_LENGTH },
      { label: "Booking card title", value: input.bookingCardTitle, max: MAX_CARD_TITLE_LENGTH },
      { label: "Booking card subtitle", value: input.bookingCardSubtitle, max: MAX_CARD_SUBTITLE_LENGTH },
      { label: "Queue card title", value: input.queueCardTitle, max: MAX_CARD_TITLE_LENGTH },
      { label: "Queue card subtitle", value: input.queueCardSubtitle, max: MAX_CARD_SUBTITLE_LENGTH },
      { label: "Service screen title", value: input.serviceScreenTitle, max: MAX_SERVICE_SCREEN_TITLE_LENGTH },
    ]
    for (const field of wordingFields) {
      if (field.value && field.value.trim().length > field.max) {
        return { success: false, error: `${field.label} must be ${field.max} characters or fewer.` }
      }
    }

    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("tenant_branding")
      .update({
        tagline: input.tagline?.trim() || null,
        idle_refresh_seconds: input.idleRefreshSeconds,
        confirmation_refresh_seconds: input.confirmationRefreshSeconds,
        registration_type: input.registrationType,
        choice_title: input.choiceTitle?.trim() || null,
        booking_card_title: input.bookingCardTitle?.trim() || null,
        booking_card_subtitle: input.bookingCardSubtitle?.trim() || null,
        queue_card_title: input.queueCardTitle?.trim() || null,
        queue_card_subtitle: input.queueCardSubtitle?.trim() || null,
        service_screen_title: input.serviceScreenTitle?.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Logo — Storage ('branding' bucket) + tenant_branding.logo_url
// ---------------------------------------------------------------------------
function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png"
    case "image/jpeg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/svg+xml":
      return "svg"
    default:
      return "bin"
  }
}

export async function uploadLogo(formData: FormData): Promise<LogoActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    // Logo is part of the 'branding' module. removeLogo() below is
    // deliberately NOT gated: a tenant that downgrades must always be able
    // to take their logo down.
    let canCustomizeBranding = false
    try {
      canCustomizeBranding = await tenantHasModule(supabase, tenantId, MODULE_KEYS.branding)
    } catch {
      return { success: false, error: "Could not verify plan" }
    }
    if (!canCustomizeBranding) {
      return { success: false, error: "A custom logo isn't included in your current plan. Upgrade to add one." }
    }

    const file = formData.get("file")
    if (!(file instanceof File) || file.size === 0) {
      return { success: false, error: "No file provided" }
    }

    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      return { success: false, error: "Logo must be a PNG, JPEG, WebP, or SVG image" }
    }

    if (file.size > MAX_LOGO_BYTES) {
      return { success: false, error: "Logo must be 2MB or smaller" }
    }

    const path = `${tenantId}/logo.${extensionFor(file.type)}`

    const { error: uploadError } = await supabase.storage
      .from(LOGO_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: true })

    if (uploadError) return { success: false, error: uploadError.message }

    const { data: publicUrlData } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path)
    const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`

    const { error: updateError } = await supabase
      .from("tenant_branding")
      .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)

    if (updateError) return { success: false, error: updateError.message }

    revalidatePath("/admin")
    return { success: true, logoUrl }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function removeLogo(): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const paths = ALLOWED_LOGO_TYPES.map((type) => `${tenantId}/logo.${extensionFor(type)}`)
    const { error: removeError } = await supabase.storage.from(LOGO_BUCKET).remove(paths)
    if (removeError) return { success: false, error: removeError.message }

    const { error: updateError } = await supabase
      .from("tenant_branding")
      .update({ logo_url: null, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)

    if (updateError) return { success: false, error: updateError.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Booking settings — booking_settings
// ---------------------------------------------------------------------------
export async function updateBookingSettings(input: {
  unifyWithQueue: boolean
  queueLeadTimeMinutes: number
  minNoticeMinutes: number
  maxAdvanceDays: number
  cancellationWindowMinutes: number
  queuePriorityMode: AdminQueuePriorityMode
}): Promise<ActionResult> {
  try {
    if (!Number.isFinite(input.queueLeadTimeMinutes) || input.queueLeadTimeMinutes < MIN_QUEUE_LEAD_TIME_MINUTES) {
      return { success: false, error: "Queue lead time must be 0 or more minutes." }
    }

    if (!Number.isFinite(input.minNoticeMinutes) || input.minNoticeMinutes < MIN_NOTICE_MINUTES_FLOOR) {
      return { success: false, error: "Minimum notice must be 0 or more minutes." }
    }

    if (!Number.isFinite(input.maxAdvanceDays) || input.maxAdvanceDays < MIN_MAX_ADVANCE_DAYS) {
      return { success: false, error: "Advance booking window can't be negative." }
    }

    if (
      !Number.isFinite(input.cancellationWindowMinutes) ||
      input.cancellationWindowMinutes < MIN_CANCELLATION_WINDOW_MINUTES
    ) {
      return { success: false, error: "Cancellation window must be 0 or more minutes." }
    }

    if (!VALID_QUEUE_PRIORITY_MODES.includes(input.queuePriorityMode)) {
      return { success: false, error: "Choose a valid queue priority mode." }
    }

    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("booking_settings")
      .update({
        unify_with_queue: input.unifyWithQueue,
        queue_lead_time_minutes: input.queueLeadTimeMinutes,
        min_notice_minutes: input.minNoticeMinutes,
        max_advance_days: input.maxAdvanceDays,
        cancellation_window_minutes: input.cancellationWindowMinutes,
        queue_priority_mode: input.queuePriorityMode,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Queue settings — queue_settings
// ---------------------------------------------------------------------------
export async function updateQueueSettings(input: {
  autoCallNext: boolean
  maxQueueSize: number | null
  notifyBeforeTurnPosition: number
  allowWalkinWhatsapp: boolean
  allowWalkinKiosk: boolean
  requireServiceSelection: boolean
  defaultServiceDurationMinutes: number
  ticketNumberPrefix: string
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const ticketNumberPrefix = input.ticketNumberPrefix.trim().toUpperCase()
    if (
      ticketNumberPrefix.length < MIN_TICKET_NUMBER_PREFIX_LENGTH ||
      ticketNumberPrefix.length > MAX_TICKET_NUMBER_PREFIX_LENGTH
    ) {
      return { success: false, error: `Ticket prefix must be ${MIN_TICKET_NUMBER_PREFIX_LENGTH}-${MAX_TICKET_NUMBER_PREFIX_LENGTH} characters.` }
    }

    const { error } = await supabase
      .from("queue_settings")
      .update({
        auto_call_next: input.autoCallNext,
        max_queue_size: input.maxQueueSize,
        notify_before_turn_position: input.notifyBeforeTurnPosition,
        allow_walkin_whatsapp: input.allowWalkinWhatsapp,
        allow_walkin_kiosk: input.allowWalkinKiosk,
        require_service_selection: input.requireServiceSelection,
        default_service_duration_minutes: input.defaultServiceDurationMinutes,
        ticket_number_prefix: ticketNumberPrefix,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Display settings — tenant_branding's display_* columns (the ambient
// waiting-area TV at /display/[slug], separate from the kiosk's own
// tenant_branding columns above).
// ---------------------------------------------------------------------------
export async function updateDisplaySettings(input: {
  theme: "dark" | "light" | "custom"
  layout: "rotation" | "board"
  /** Hex (#RRGGBB), or null. Only meaningful when theme === "custom", but
   *  accepted regardless -- same "store whatever was sent, resolve at
   *  read-time" posture as the rest of this action. */
  backgroundColor: string | null
  /** Welcome-slide tagline. Separate column from the kiosk's own tagline
   *  -- see AdminDisplaySettings.tagline's comment in types.ts. */
  tagline?: string | null
  showServices: boolean
  showBookings: boolean
  showQueue: boolean
  welcomeSeconds: number
  menuBookingsSeconds: number
  queueSeconds: number
  menuTitle?: string | null
  bookingsTitle?: string | null
  queueTitle?: string | null
  nowServingLabel?: string | null
  // Per-field toggles for the queue slide specifically -- independent of
  // showQueue above. showQueuePhone is the one worth flagging: the
  // display route is public and unauthenticated, so app/display/[slug]/
  // actions.ts always masks the number before it ever leaves the server,
  // regardless of this flag -- this only controls whether that masked
  // string is sent at all.
  showQueueTicketNumber: boolean
  showQueueService: boolean
  showQueuePhone: boolean
  showQueueWaitEstimate: boolean
  showQueueDuration: boolean
  showQueueReference: boolean
}): Promise<ActionResult> {
  try {
    if (!["dark", "light", "custom"].includes(input.theme)) {
      return { success: false, error: "Invalid theme." }
    }
    if (!["rotation", "board"].includes(input.layout)) {
      return { success: false, error: "Invalid layout." }
    }
    if (input.backgroundColor !== null && !/^#[0-9A-Fa-f]{6}$/.test(input.backgroundColor)) {
      return { success: false, error: "Background colour must be a hex value like #15110D." }
    }
    if (input.tagline && input.tagline.trim().length > MAX_DISPLAY_TAGLINE_LENGTH) {
      return { success: false, error: `Tagline must be ${MAX_DISPLAY_TAGLINE_LENGTH} characters or fewer.` }
    }

    if (
      !Number.isFinite(input.welcomeSeconds) ||
      input.welcomeSeconds < MIN_DISPLAY_WELCOME_SECONDS ||
      input.welcomeSeconds > MAX_DISPLAY_WELCOME_SECONDS
    ) {
      return {
        success: false,
        error: `Welcome slide duration must be between ${MIN_DISPLAY_WELCOME_SECONDS} and ${MAX_DISPLAY_WELCOME_SECONDS} seconds.`,
      }
    }

    if (
      !Number.isFinite(input.menuBookingsSeconds) ||
      input.menuBookingsSeconds < MIN_DISPLAY_MENU_BOOKINGS_SECONDS ||
      input.menuBookingsSeconds > MAX_DISPLAY_MENU_BOOKINGS_SECONDS
    ) {
      return {
        success: false,
        error: `Menu / bookings duration must be between ${MIN_DISPLAY_MENU_BOOKINGS_SECONDS} and ${MAX_DISPLAY_MENU_BOOKINGS_SECONDS} seconds.`,
      }
    }

    if (
      !Number.isFinite(input.queueSeconds) ||
      input.queueSeconds < MIN_DISPLAY_QUEUE_SECONDS ||
      input.queueSeconds > MAX_DISPLAY_QUEUE_SECONDS
    ) {
      return {
        success: false,
        error: `Live queue duration must be between ${MIN_DISPLAY_QUEUE_SECONDS} and ${MAX_DISPLAY_QUEUE_SECONDS} seconds.`,
      }
    }

    const titleFields: Array<{ label: string; value: string | null | undefined }> = [
      { label: "Menu screen heading", value: input.menuTitle },
      { label: "Bookings screen heading", value: input.bookingsTitle },
      { label: "Queue screen heading", value: input.queueTitle },
    ]
    for (const field of titleFields) {
      if (field.value && field.value.trim().length > MAX_DISPLAY_TITLE_LENGTH) {
        return { success: false, error: `${field.label} must be ${MAX_DISPLAY_TITLE_LENGTH} characters or fewer.` }
      }
    }
    if (input.nowServingLabel && input.nowServingLabel.trim().length > MAX_DISPLAY_LABEL_LENGTH) {
      return { success: false, error: `"Now serving" label must be ${MAX_DISPLAY_LABEL_LENGTH} characters or fewer.` }
    }

    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("tenant_branding")
      .update({
        display_show_services: input.showServices,
        display_show_bookings: input.showBookings,
        display_show_queue: input.showQueue,
        display_welcome_seconds: input.welcomeSeconds,
        display_menu_bookings_seconds: input.menuBookingsSeconds,
        display_queue_seconds: input.queueSeconds,
        display_theme: input.theme,
        display_layout: input.layout,
        display_background_color: input.backgroundColor,
        display_tagline: input.tagline?.trim() || null,
        display_menu_title: input.menuTitle?.trim() || null,
        display_bookings_title: input.bookingsTitle?.trim() || null,
        display_queue_title: input.queueTitle?.trim() || null,
        display_now_serving_label: input.nowServingLabel?.trim() || null,
        display_queue_show_ticket_number: input.showQueueTicketNumber,
        display_queue_show_service: input.showQueueService,
        display_queue_show_phone: input.showQueuePhone,
        display_queue_show_wait_estimate: input.showQueueWaitEstimate,
        display_queue_show_duration: input.showQueueDuration,
        display_queue_show_reference: input.showQueueReference,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Message settings — message_settings
// ---------------------------------------------------------------------------
export async function updateMessageSettings(input: {
  aiEnabledDefault: boolean
  bookingConfirmationTemplate: string | null
  bookingReminderTemplate: string | null
  queueJoinedTemplate: string | null
  queueAlmostTurnTemplate: string | null
  queueCalledTemplate: string | null
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("message_settings")
      .update({
        ai_enabled_default: input.aiEnabledDefault,
        booking_confirmation_template: input.bookingConfirmationTemplate,
        booking_reminder_template: input.bookingReminderTemplate,
        queue_joined_template: input.queueJoinedTemplate,
        queue_almost_turn_template: input.queueAlmostTurnTemplate,
        queue_called_template: input.queueCalledTemplate,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Business hours — business_hours (one row per day_of_week, 0=Sunday..6=Saturday)
// ---------------------------------------------------------------------------
export async function updateBusinessHours(
  days: Array<{
    dayOfWeek: number
    isClosed: boolean
    openTime: string | null
    closeTime: string | null
  }>
): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    for (const day of days) {
      if (!day.isClosed) {
        if (!day.openTime || !day.closeTime) {
          return { success: false, error: "Enter both an open and close time for every open day." }
        }
        if (day.openTime >= day.closeTime) {
          return { success: false, error: "Open time must be before close time." }
        }
      }
    }

    const rows = days.map((day) => ({
      tenant_id: tenantId,
      day_of_week: day.dayOfWeek,
      is_closed: day.isClosed,
      open_time: day.isClosed ? null : day.openTime,
      close_time: day.isClosed ? null : day.closeTime,
      updated_at: new Date().toISOString(),
    }))

    const { error } = await supabase.from("business_hours").upsert(rows, { onConflict: "tenant_id,day_of_week" })

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
