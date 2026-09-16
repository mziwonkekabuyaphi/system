// app/api/cron/promote-bookings/route.ts
/**
 * Booking → Queue promotion — the real implementation of "Link bookings
 * to the queue" (booking_settings.unify_with_queue).
 *
 * WHY THIS FILE EXISTS: app/admin/settings-actions.ts's header comment
 * described a `promote_bookings_to_queue()` pg_cron job as already
 * running in Postgres "every minute." A repo-wide search across every
 * file made available for inspection —
 *   grep -rln "is_tenant_open_now" .
 *   grep -rln "business_hours" --include="*.sql" .
 *   grep -rln "promote_bookings_to_queue" .
 *   grep -rln "pg_cron\|cron.schedule" .
 * — found no such function, no migration defining one, and no scheduler
 * configuration referencing it (the only hit was the comment itself, in
 * app/admin/types.ts). So that comment described an intended design that
 * was never actually built. This route is the smallest real
 * implementation of that intent.
 *
 * WHY APPLICATION CODE, NOT A NEW SQL FUNCTION: with no existing
 * pg_cron/scheduler infrastructure to hook into, adding one would mean
 * introducing pg_cron itself (an extension + a new migration) purely to
 * run what is, at this scale, a simple per-tenant scan — exactly the
 * kind of new infrastructure the task asked NOT to introduce without
 * proof it's needed. A Route Handler reuses the same Supabase
 * service-role client and tenant-scoping conventions every other server
 * action in this repo already uses.
 *
 * WHAT IT DOES, once per invocation:
 *   1. Loads every tenant with booking_settings.unify_with_queue = true,
 *      and that tenant's own queue_lead_time_minutes.
 *   2. For each such tenant, finds confirmed bookings whose
 *      (start_time - queue_lead_time_minutes) has already passed —
 *      i.e. start_time <= now + queue_lead_time_minutes — bounded to a
 *      recent lookback window (LOOKBACK_HOURS) so a scheduler outage
 *      doesn't dredge up months of stale confirmed bookings once it
 *      resumes.
 *   3. Skips any booking that already has a queue_entries row
 *      (queue_entries.booking_id) — "at most one queue entry per
 *      booking," checked before inserting, not enforced by a DB unique
 *      constraint (none exists on this column today; see the
 *      Edge Cases section of the implementation report for the
 *      concurrency caveat this implies).
 *   4. Inserts one queue_entries row per remaining eligible booking,
 *      with source = 'booking' and booking_id set back to the booking —
 *      the exact shape the spec requires, and the same queue_entries
 *      shape queue.ts's joinQueue() already writes for walk-ins (just
 *      with source/booking_id set), so staff-facing queue code doesn't
 *      need to know which path a row came from.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch queue_settings
 * (allow_walkin_kiosk / allow_walkin_whatsapp) or change how ordinary
 * walk-ins are created — booking-to-queue promotion is fully separate
 * from whether walk-ins are allowed, per spec.
 *
 * HOW THIS GETS TRIGGERED: this is a plain Next.js Route Handler, not a
 * platform-specific cron primitive. No vercel.json or other
 * deployment-specific scheduler config was found among the files
 * available for inspection, so this deliberately does NOT assume
 * Vercel Cron. Something external needs to call this URL on a schedule
 * (roughly once a minute) — Vercel Cron, a Supabase scheduled Edge
 * Function, a GitHub Actions cron workflow, or literally any scheduler
 * that can make an HTTP request all work identically, since this is
 * just an authenticated endpoint. Wiring that up is a deployment-config
 * step outside this codebase — see the implementation report.
 *
 * AUTH: guarded by a shared secret (the CRON_SECRET env var), checked
 * against an `Authorization: Bearer <secret>` header. This mirrors the
 * shared-secret pattern this codebase already uses for other
 * non-interactive callers (the WhatsApp webhook verifies a token the
 * same way) rather than introducing a new auth mechanism. Requires
 * CRON_SECRET to be set in the deployment environment — see the
 * implementation report for what still needs configuring.
 */

import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

// Bookings whose (start_time - lead time) passed more than this long ago
// are not promoted — bounds the query and means a scheduler gap doesn't
// cause a flood of very stale bookings suddenly appearing in the queue.
const LOOKBACK_HOURS = 6

interface UnifiedTenantRow {
  tenant_id: string
  queue_lead_time_minutes: number
}

interface EligibleBookingRow {
  id: string
  tenant_id: string
  customer_id: string
  service_id: string
}

interface PromotionSummary {
  tenantsChecked: number
  promoted: number
  alreadyQueued: number
  errors: string[]
}

async function promoteEligibleBookings(): Promise<PromotionSummary> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return { tenantsChecked: 0, promoted: 0, alreadyQueued: 0, errors: ["Supabase is not configured"] }
  }

  const { data: tenantRows, error: tenantsError } = await supabase
    .from("booking_settings")
    .select("tenant_id, queue_lead_time_minutes")
    .eq("unify_with_queue", true)

  if (tenantsError) {
    return { tenantsChecked: 0, promoted: 0, alreadyQueued: 0, errors: [tenantsError.message] }
  }

  const tenants = (tenantRows ?? []) as UnifiedTenantRow[]
  const now = Date.now()
  const lookbackCutoffISO = new Date(now - LOOKBACK_HOURS * 60 * 60_000).toISOString()

  let promoted = 0
  let alreadyQueued = 0
  const errors: string[] = []

  for (const tenant of tenants) {
    const eligibleBeforeISO = new Date(now + tenant.queue_lead_time_minutes * 60_000).toISOString()

    // Confirmed bookings for this tenant whose lead-time window has
    // opened (start_time <= now + lead time), not so old they're outside
    // the lookback bound.
    const { data: bookingRows, error: bookingsError } = await supabase
      .from("bookings")
      .select("id, tenant_id, customer_id, service_id")
      .eq("tenant_id", tenant.tenant_id)
      .eq("status", "confirmed")
      .gte("start_time", lookbackCutoffISO)
      .lte("start_time", eligibleBeforeISO)

    if (bookingsError) {
      errors.push(`tenant ${tenant.tenant_id}: ${bookingsError.message}`)
      continue
    }

    const candidates = (bookingRows ?? []) as EligibleBookingRow[]
    if (candidates.length === 0) continue

    // "At most one queue entry per booking" — checked here rather than
    // via a DB unique constraint (none exists on queue_entries.booking_id
    // today; see the report's Edge Cases section).
    const bookingIds = candidates.map((b) => b.id)
    const { data: existingEntries, error: existingError } = await supabase
      .from("queue_entries")
      .select("booking_id")
      .in("booking_id", bookingIds)

    if (existingError) {
      errors.push(`tenant ${tenant.tenant_id}: ${existingError.message}`)
      continue
    }

    const alreadyQueuedIds = new Set((existingEntries ?? []).map((e: { booking_id: string | null }) => e.booking_id))
    const toInsert = candidates.filter((b) => !alreadyQueuedIds.has(b.id))
    alreadyQueued += candidates.length - toInsert.length

    if (toInsert.length === 0) continue

    const { error: insertError } = await supabase.from("queue_entries").insert(
      toInsert.map((b) => ({
        tenant_id: b.tenant_id,
        customer_id: b.customer_id,
        service_id: b.service_id,
        booking_id: b.id,
        source: "booking",
        status: "waiting",
        joined_at: new Date().toISOString(),
      })),
    )

    if (insertError) {
      errors.push(`tenant ${tenant.tenant_id}: ${insertError.message}`)
      continue
    }

    promoted += toInsert.length
  }

  return { tenantsChecked: tenants.length, promoted, alreadyQueued, errors }
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return request.headers.get("authorization") === `Bearer ${expected}`
}

async function handle(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET) {
    console.error("[promote-bookings] CRON_SECRET is not configured; refusing to run")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const summary = await promoteEligibleBookings()
  return NextResponse.json(summary)
}

// Accepts both verbs since this deliberately doesn't assume a specific
// scheduler product — some (Vercel Cron) call GET, others are easiest to
// configure as POST.
export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
