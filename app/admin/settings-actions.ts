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
 * The one rule that matters most here: remove_powered_by can only be set to
 * true when tenants.plan = 'business'. That's checked below AND by a DB
 * trigger on tenant_branding (added in the same migration as the columns),
 * so even a direct SQL write or a future admin tool can't bypass it.
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
 * max_advance_days > 0, cancellation_window_minutes >= 0) are unchanged
 * and still the final backstop; this is defense in depth, not a
 * replacement for them. These five fields are also now genuinely
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
const MIN_QUEUE_LEAD_TIME_MINUTES = 0
const MIN_NOTICE_MINUTES_FLOOR = 0
const MIN_MAX_ADVANCE_DAYS = 1
const MIN_CANCELLATION_WINDOW_MINUTES = 0
const VALID_QUEUE_PRIORITY_MODES: AdminQueuePriorityMode[] = ["fifo", "priority", "hybrid"]

async function tenantContext() {
  const { tenantId } = await requireTenantMember()
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

    const { error } = await supabase
      .from("tenant_modules")
      .update({
        enabled,
        enabled_at: enabled ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("module_id", kioskModule.id)

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
      const { data: tenant, error: planError } = await supabase
        .from("tenants")
        .select("plan")
        .eq("id", tenantId)
        .single()

      if (planError || !tenant) return { success: false, error: "Could not verify plan" }

      if (tenant.plan !== "business") {
        return {
          success: false,
          error: 'Removing "Powered by" requires the Business plan. Upgrade to enable this.',
        }
      }
    }

    const { error } = await supabase
      .from("tenant_branding")
      .update({
        display_name: input.displayName,
        primary_color: input.primaryColor,
        secondary_color: input.secondaryColor,
        remove_powered_by: input.removePoweredBy,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

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
      return { success: false, error: "Advance booking window must be at least 1 day." }
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
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("queue_settings")
      .update({
        auto_call_next: input.autoCallNext,
        max_queue_size: input.maxQueueSize,
        notify_before_turn_position: input.notifyBeforeTurnPosition,
        allow_walkin_whatsapp: input.allowWalkinWhatsapp,
        allow_walkin_kiosk: input.allowWalkinKiosk,
        require_service_selection: input.requireServiceSelection,
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
