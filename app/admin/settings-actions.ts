// app/admin/settings-actions.ts
"use server"

/**
 * Settings tab actions — General info / Kiosk toggle / Private Label /
 * Booking / Queue / Messages.
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
 * updateBookingSettings' unifyWithQueue is the on/off switch for the
 * promote_bookings_to_queue() pg_cron job — no server-side gating on plan
 * here, any tenant can turn it on. The job itself just reads this row
 * straight out of booking_settings, so flipping the toggle takes effect on
 * its next run (within a minute), no revalidation needed on the Postgres
 * side, only on the Next.js cache below.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"

type ActionResult = { success: true } | { success: false; error: string }
type LogoActionResult = { success: true; logoUrl: string } | { success: false; error: string }

const LOGO_BUCKET = "branding"
const MAX_LOGO_BYTES = 2 * 1024 * 1024 // keep in sync with the bucket's file_size_limit
const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

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
// (logo_url is NOT settable here — it's only ever written by uploadLogo /
// removeLogo below, since it has to stay in sync with what's actually in
// Storage.)
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

    // Belt-and-suspenders: if the DB trigger is what actually catches this
    // (e.g. plan changed between our check above and this write), turn its
    // raw Postgres exception into the same clean message.
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

    // Fixed key per tenant (no per-upload filename) so re-uploading a logo
    // overwrites in place instead of leaving old versions behind in Storage.
    const path = `${tenantId}/logo.${extensionFor(file.type)}`

    const { error: uploadError } = await supabase.storage
      .from(LOGO_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: true })

    if (uploadError) return { success: false, error: uploadError.message }

    const { data: publicUrlData } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path)
    // Cache-bust: the path (and therefore the public URL) is the same
    // across re-uploads, so without this the browser/CDN would keep
    // serving the old cached image after a change.
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

    // Extensions are the only thing that varies at this fixed key, so
    // clear out whichever one is actually there.
    const paths = ALLOWED_LOGO_TYPES.map((type) => `${tenantId}/logo.${extensionFor(type)}`)
    const { error: removeError } = await supabase.storage.from(LOGO_BUCKET).remove(paths)
    // Storage returns success even for paths that don't exist, so this
    // isn't a false negative — a real removeError here means something
    // else went wrong (bucket misconfigured, network, etc).
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
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("booking_settings")
      .update({
        unify_with_queue: input.unifyWithQueue,
        queue_lead_time_minutes: input.queueLeadTimeMinutes,
        min_notice_minutes: input.minNoticeMinutes,
        max_advance_days: input.maxAdvanceDays,
        cancellation_window_minutes: input.cancellationWindowMinutes,
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
