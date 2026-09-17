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
 * SLIDES: welcome (branding) -> services (menu) -> bookings (next
 * upcoming confirmed appointments) -> queue (who's waiting / being
 * served right now). Hours and the kiosk QR code were dropped from this
 * screen on purpose — see DisplayScreen.tsx.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"

export interface DisplayBranding {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  tagline: string | null
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
}

export interface DisplayData {
  branding: DisplayBranding
  services: CatalogService[]
  bookings: DisplayBooking[]
  queue: DisplayQueueEntry[]
}

export type DisplayResult = { ok: true; data: DisplayData } | { ok: false; error: string }

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

    const [brandingResult, bookingsResult, queueResult, services] = await Promise.all([
      supabase
        .from("tenant_branding")
        .select("display_name, logo_url, primary_color, secondary_color, tagline")
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
          "id, status, joined_at, called_at, customer:tenant_customers(full_name), service:services(name)",
        )
        .eq("tenant_id", tenantId)
        .in("status", ["waiting", "called"])
        .order("joined_at", { ascending: true })
        .limit(QUEUE_LIMIT),
      getBookableServices(tenantId),
    ])

    if (brandingResult.error) throw new Error(`Failed to load branding: ${brandingResult.error.message}`)
    if (bookingsResult.error) throw new Error(`Failed to load bookings: ${bookingsResult.error.message}`)
    if (queueResult.error) throw new Error(`Failed to load queue: ${queueResult.error.message}`)

    const branding: DisplayBranding = {
      displayName: brandingResult.data?.display_name ?? null,
      logoUrl: brandingResult.data?.logo_url ?? null,
      primaryColor: brandingResult.data?.primary_color ?? null,
      secondaryColor: brandingResult.data?.secondary_color ?? null,
      tagline: brandingResult.data?.tagline ?? null,
    }

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
    let waitingPosition = 0
    const queue: DisplayQueueEntry[] = (queueResult.data ?? []).map((row) => {
      const customer = unwrapJoin<{ full_name: string | null }>(row.customer as never)
      const service = unwrapJoin<{ name: string | null }>(row.service as never)
      const status = row.status as "waiting" | "called"
      if (status === "waiting") waitingPosition += 1
      return {
        id: row.id as string,
        status,
        joinedAt: row.joined_at as string,
        calledAt: (row.called_at as string | null) ?? null,
        customerName: customer?.full_name ?? null,
        serviceName: service?.name ?? null,
        position: status === "waiting" ? waitingPosition : 0,
      }
    })

    return { ok: true, data: { branding, services, bookings, queue } }
  } catch (error) {
    console.error("[display] fetchDisplayData failed", { slug, error })
    return { ok: false, error: "Couldn't load display data." }
  }
}
