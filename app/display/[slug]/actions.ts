"use server"

// app/display/[slug]/actions.ts
/**
 * Public data loader backing the /display/[slug] TV screen.
 *
 * SECURITY: same posture as app/kiosk/[slug]/actions.ts and
 * app/clock/[slug] — resolves tenantId fresh from (slug, status='active')
 * on every call, never trusts a client-supplied id. This route has no
 * writes at all (it's a read-only ambient display), but the resolve step
 * still matters: it's what stops /display/some-other-slug from serving
 * a suspended/inactive tenant's branding.
 *
 * POLLING, NOT PUSH: a TV in a waiting room stays on the same tab for
 * days or weeks — it never naturally reloads to pick up a branding /
 * service / booking / queue change an admin (or a customer via WhatsApp
 * or the kiosk) makes. DisplayScreen.tsx calls this same action again
 * every few minutes client-side so the screen catches up without anyone
 * touching the TV. Cheap enough: four small reads, no writes, same shape
 * whether it's the initial server render or a later client poll.
 *
 * SLIDES: welcome (branding, shown once) -> services (menu) -> bookings
 * (next upcoming confirmed appointments) -> queue (who's waiting / being
 * served right now). Hours and the kiosk QR code were dropped from this
 * screen on purpose — see DisplayScreen.tsx. Which of services/bookings/
 * queue are included, how long each shows, and their headings/labels are
 * now admin-configurable (Settings -> Display in the dashboard) and come
 * back from this action as `settings` -- see DisplaySettings below and
 * migration_display_settings.sql. The welcome slide's own on-screen time
 * (welcomeSeconds) is also configurable, but it's a one-time slide shown
 * when the TV tab first loads, not part of the repeating rotation --
 * DisplayScreen.tsx enforces that split, not this file.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { formatQueueTicketNumber } from "@/lib/services/queue"

export interface DisplayBranding {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  tagline: string | null
}

// Admin-configurable Display TV behavior -- see migration_display_settings.sql
// and app/admin/settings-actions.ts' updateDisplaySettings(). Every *Title/
// *Label field is nullable: null/empty means "use the hardcoded default",
// same clear-to-default posture as the kiosk's wording fields.
export interface DisplaySettings {
  showServices: boolean
  showBookings: boolean
  showQueue: boolean
  /** How long the one-time welcome slide shows before the rotation starts. */
  welcomeSeconds: number
  /** Shared rotation duration for the services (menu) and bookings slides. */
  menuBookingsSeconds: number
  /** Rotation duration for the live queue slide -- usually longer, since
   *  there's more to read than a menu or booking row. */
  queueSeconds: number
  menuTitle: string | null
  bookingsTitle: string | null
  queueTitle: string | null
  nowServingLabel: string | null
  /** "dark" / "light" are built-in looks; "custom" uses backgroundColor. */
  theme: DisplayTheme
  /** Hex (#RRGGBB). Only used when theme === "custom". */
  backgroundColor: string | null
  /** Queue slide fields -- see DisplayScreen.tsx. phone/reference/wait are
   *  only populated on DisplayQueueEntry when their toggle is on. */
  showQueueTicketNumber: boolean
  showQueueService: boolean
  showQueuePhone: boolean
  showQueueWaitEstimate: boolean
  showQueueDuration: boolean
  showQueueReference: boolean
}

export type DisplayTheme = "dark" | "light" | "custom"

// Fallbacks when a tenant_branding row hasn't been created yet (brand-new
// tenant, row insert lagging the trigger) -- mirrors the DB column
// defaults in migration_display_settings.sql so behavior is identical
// either way.
const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  showServices: true,
  showBookings: true,
  showQueue: true,
  welcomeSeconds: 6,
  menuBookingsSeconds: 9,
  queueSeconds: 20,
  menuTitle: null,
  bookingsTitle: null,
  queueTitle: null,
  nowServingLabel: null,
  theme: "dark",
  backgroundColor: null,
  showQueueTicketNumber: true,
  showQueueService: true,
  showQueuePhone: false,
  showQueueWaitEstimate: true,
  showQueueDuration: false,
  showQueueReference: true,
}

export interface DisplayBooking {
  id: string
  startTime: string // ISO timestamptz
  customerName: string | null
  serviceName: string | null
  staffName: string | null
}

export interface DisplayQueueEntry {
  id: string
  status: "waiting" | "called"
  joinedAt: string // ISO timestamptz
  calledAt: string | null
  customerName: string | null
  serviceName: string | null
  /** 1-based position among *waiting* entries, in joined_at order. 0 for a "called" entry. */
  position: number
  /** Formatted via the same formatQueueTicketNumber() the kiosk's printed
   *  slip uses (e.g. "Q003") -- this is the PERMANENT number for this
   *  entry, unlike `position` above, which is just this row's rank among
   *  currently-waiting entries and shifts as the queue moves. Null for
   *  any entry with no ticket_number on the row -- rows inserted before
   *  that column existed, or (currently) any promoted-booking entry from
   *  the unify-with-queue pg_cron job, which doesn't assign one yet. */
  ticketNumber: string | null
  /** Masked (e.g. "071 *** **34"). Null unless showQueuePhone is on -- the
   *  raw number is never sent to this public screen. */
  phoneMasked: string | null
  /** From the linked booking. Null for walk-ins or when showQueueReference is off. */
  bookingReference: string | null
  /** Rough minutes until this *waiting* entry is called. Null for "called"
   *  entries or when showQueueWaitEstimate is off. */
  estimatedWaitMinutes: number | null
}

export interface DisplayData {
  branding: DisplayBranding
  settings: DisplaySettings
  services: CatalogService[]
  bookings: DisplayBooking[]
  queue: DisplayQueueEntry[]
}

export type DisplayResult = { ok: true; data: DisplayData } | { ok: false; error: string }

function resolveTheme(value: unknown): DisplayTheme {
  return value === "light" || value === "custom" ? value : "dark"
}

async function resolveActiveTenantId(slug: string): Promise<string> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle()

  if (error) throw new Error(`Failed to resolve tenant for slug "${slug}": ${error.message}`)
  if (!data) throw new Error("DISPLAY_TENANT_NOT_FOUND")

  return data.id as string
}

// A joined foreign row can come back as an object or a one-element array
// depending on how PostgREST resolves the relationship's cardinality --
// normalize both shapes to "the object, or null" so callers don't care.
function unwrapJoin<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** "0711234567" -> "071 *** **67". Keeps 3 leading + 2 trailing digits only. */
function maskPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "")
  if (digits.length < 7) return null
  return `${digits.slice(0, 3)} *** **${digits.slice(-2)}`
}

// Simple serial estimate: everyone ahead in line takes their service's
// duration (or the tenant default), minus time already spent on anyone
// currently being served. It does NOT know how many staff are working in
// parallel, so it overestimates for multi-chair shops. If you already have
// an estimator in lib/services/queue.ts, call it here instead -- this is
// the only place the display computes one.
function estimateWaitMinutes(
  aheadDurations: number[],
  inServiceRemaining: number[],
): number {
  const total = [...aheadDurations, ...inServiceRemaining].reduce((a, b) => a + b, 0)
  return Math.max(0, Math.round(total))
}

// How far ahead of "now" to pull confirmed bookings for the slide.
// Keeps a slow-moving TV screen from showing next week's appointments
// alongside today's, without needing tenant-timezone-aware day math.
const BOOKINGS_WINDOW_HOURS = 12
const BOOKINGS_LIMIT = 8
const QUEUE_LIMIT = 12

export async function fetchDisplayData(slug: string): Promise<DisplayResult> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) throw new Error("Supabase server client is unavailable")

    const tenantId = await resolveActiveTenantId(slug)
    const now = new Date()
    const bookingsWindowEnd = new Date(now.getTime() + BOOKINGS_WINDOW_HOURS * 60 * 60 * 1000)

    const [brandingResult, bookingsResult, queueResult, queueSettingsResult, services] = await Promise.all([
      supabase
        .from("tenant_branding")
        .select(
          "display_name, logo_url, primary_color, secondary_color, " +
            "display_show_services, display_show_bookings, display_show_queue, " +
            "display_welcome_seconds, display_menu_bookings_seconds, display_queue_seconds, " +
            "display_menu_title, display_bookings_title, display_queue_title, display_now_serving_label, " +
            "display_theme, display_background_color, display_tagline, " +
            "display_queue_show_ticket_number, display_queue_show_service, display_queue_show_phone, " +
            "display_queue_show_wait_estimate, display_queue_show_duration, display_queue_show_reference",
        )
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      supabase
        .from("bookings")
        .select(
          "id, start_time, customer:tenant_customers(full_name), service:services(name), staff:staff(name)",
        )
        .eq("tenant_id", tenantId)
        .eq("status", "confirmed")
        .gte("start_time", now.toISOString())
        .lte("start_time", bookingsWindowEnd.toISOString())
        .order("start_time", { ascending: true })
        .limit(BOOKINGS_LIMIT),
      supabase
        .from("queue_entries")
        .select(
          "id, status, joined_at, called_at, ticket_number, customer:tenant_customers(full_name, phone), " +
            "service:services(name, duration_minutes), booking:bookings(booking_reference)",
        )
        .eq("tenant_id", tenantId)
        .in("status", ["waiting", "called"])
        .order("joined_at", { ascending: true })
        .limit(QUEUE_LIMIT),
      // Same table the kiosk's own ticket formatting reads from
      // (lib/services/queue.ts's getTicketNumberPrefix) -- kept as its
      // own small query rather than folded into the queue_entries one
      // above since it's a different table (queue_settings, not
      // queue_entries) and this tenant-wide value doesn't repeat per row.
      supabase.from("queue_settings").select("ticket_number_prefix, default_service_duration_minutes").eq("tenant_id", tenantId).maybeSingle(),
      getBookableServices(tenantId),
    ])

    if (brandingResult.error) throw new Error(`Failed to load branding: ${brandingResult.error.message}`)
    if (bookingsResult.error) throw new Error(`Failed to load bookings: ${bookingsResult.error.message}`)
    if (queueResult.error) throw new Error(`Failed to load queue: ${queueResult.error.message}`)
    if (queueSettingsResult.error) {
      // Non-fatal -- same "fall back rather than fail the whole screen"
      // posture as everything else here. Worst case a ticket number is
      // missing its prefix's fallback ("Q"), never a broken TV.
      console.error("[display] queue_settings lookup failed", { slug, error: queueSettingsResult.error })
    }
    const ticketNumberPrefix = queueSettingsResult.data?.ticket_number_prefix ?? "Q"
    const defaultServiceMinutes = queueSettingsResult.data?.default_service_duration_minutes ?? 15

    const branding: DisplayBranding = {
      displayName: brandingResult.data?.display_name ?? null,
      logoUrl: brandingResult.data?.logo_url ?? null,
      primaryColor: brandingResult.data?.primary_color ?? null,
      secondaryColor: brandingResult.data?.secondary_color ?? null,
      // Display has its own tagline. It used to read tenant_branding.tagline,
      // which is the KIOSK's welcome text ("Tap anywhere to check in") --
      // wrong wording for a screen nobody can tap.
      tagline: brandingResult.data?.display_tagline?.trim() || null,
    }

    const settings: DisplaySettings = brandingResult.data
      ? {
          showServices: brandingResult.data.display_show_services ?? DEFAULT_DISPLAY_SETTINGS.showServices,
          showBookings: brandingResult.data.display_show_bookings ?? DEFAULT_DISPLAY_SETTINGS.showBookings,
          showQueue: brandingResult.data.display_show_queue ?? DEFAULT_DISPLAY_SETTINGS.showQueue,
          welcomeSeconds: brandingResult.data.display_welcome_seconds ?? DEFAULT_DISPLAY_SETTINGS.welcomeSeconds,
          menuBookingsSeconds:
            brandingResult.data.display_menu_bookings_seconds ?? DEFAULT_DISPLAY_SETTINGS.menuBookingsSeconds,
          queueSeconds: brandingResult.data.display_queue_seconds ?? DEFAULT_DISPLAY_SETTINGS.queueSeconds,
          menuTitle: brandingResult.data.display_menu_title ?? null,
          bookingsTitle: brandingResult.data.display_bookings_title ?? null,
          queueTitle: brandingResult.data.display_queue_title ?? null,
          nowServingLabel: brandingResult.data.display_now_serving_label ?? null,
          theme: resolveTheme(brandingResult.data.display_theme),
          backgroundColor: brandingResult.data.display_background_color ?? null,
          showQueueTicketNumber:
            brandingResult.data.display_queue_show_ticket_number ?? DEFAULT_DISPLAY_SETTINGS.showQueueTicketNumber,
          showQueueService:
            brandingResult.data.display_queue_show_service ?? DEFAULT_DISPLAY_SETTINGS.showQueueService,
          showQueuePhone: brandingResult.data.display_queue_show_phone ?? DEFAULT_DISPLAY_SETTINGS.showQueuePhone,
          showQueueWaitEstimate:
            brandingResult.data.display_queue_show_wait_estimate ?? DEFAULT_DISPLAY_SETTINGS.showQueueWaitEstimate,
          showQueueDuration:
            brandingResult.data.display_queue_show_duration ?? DEFAULT_DISPLAY_SETTINGS.showQueueDuration,
          showQueueReference:
            brandingResult.data.display_queue_show_reference ?? DEFAULT_DISPLAY_SETTINGS.showQueueReference,
        }
      : DEFAULT_DISPLAY_SETTINGS

    const bookings: DisplayBooking[] = (bookingsResult.data ?? []).map((row) => {
      const customer = unwrapJoin<{ full_name: string | null }>(row.customer as never)
      const service = unwrapJoin<{ name: string | null }>(row.service as never)
      const staff = unwrapJoin<{ name: string | null }>(row.staff as never)
      return {
        id: row.id as string,
        startTime: row.start_time as string,
        customerName: customer?.full_name ?? null,
        serviceName: service?.name ?? null,
        staffName: staff?.name ?? null,
      }
    })

    // "called" entries (being served right now) surface separately in the
    // UI, so only "waiting" entries get a queue position number.
    const queueRows = queueResult.data ?? []
    const durationOf = (row: (typeof queueRows)[number]) => {
      const svc = unwrapJoin<{ duration_minutes: number | null }>(row.service as never)
      return svc?.duration_minutes ?? defaultServiceMinutes
    }
    const nowMs = now.getTime()
    // Minutes still left on whoever is being served right now.
    const inServiceRemaining = queueRows
      .filter((row) => row.status === "called")
      .map((row) => {
        const calledAt = row.called_at ? new Date(row.called_at as string).getTime() : nowMs
        return Math.max(0, durationOf(row) - (nowMs - calledAt) / 60000)
      })
    const aheadDurations: number[] = []

    let waitingPosition = 0
    const queue: DisplayQueueEntry[] = queueRows.map((row) => {
      const customer = unwrapJoin<{ full_name: string | null; phone: string | null }>(row.customer as never)
      const service = unwrapJoin<{ name: string | null }>(row.service as never)
      const booking = unwrapJoin<{ booking_reference: string | null }>(row.booking as never)
      const status = row.status as "waiting" | "called"
      if (status === "waiting") waitingPosition += 1
      const rawTicketNumber = row.ticket_number as number | null

      let estimatedWaitMinutes: number | null = null
      if (status === "waiting" && settings.showQueueWaitEstimate) {
        estimatedWaitMinutes = estimateWaitMinutes(aheadDurations, inServiceRemaining)
      }
      if (status === "waiting") aheadDurations.push(durationOf(row))

      return {
        id: row.id as string,
        status,
        joinedAt: row.joined_at as string,
        calledAt: (row.called_at as string | null) ?? null,
        customerName: customer?.full_name ?? null,
        serviceName: service?.name ?? null,
        position: status === "waiting" ? waitingPosition : 0,
        ticketNumber: rawTicketNumber != null ? formatQueueTicketNumber(rawTicketNumber, ticketNumberPrefix) : null,
        phoneMasked: settings.showQueuePhone ? maskPhone(customer?.phone) : null,
        bookingReference: settings.showQueueReference ? (booking?.booking_reference ?? null) : null,
        estimatedWaitMinutes,
      }
    })

    return { ok: true, data: { branding, settings, services, bookings, queue } }
  } catch (error) {
    console.error("[display] fetchDisplayData failed", { slug, error })
    return { ok: false, error: "Couldn't load display data." }
  }
}
