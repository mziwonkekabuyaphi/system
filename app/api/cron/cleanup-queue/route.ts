// app/api/cron/cleanup-queue/route.ts
/**
 * Nightly queue clean-up.
 *
 * WHY: a walk-in queue is a same-day thing, but nothing closes an entry whose
 * customer never showed up or whose staff forgot to mark it done. Those entries
 * stay "waiting"/"called" for days and every later customer's position and
 * wait estimate (getQueueSimulation) counts them — a new joiner can be told a
 * 4-hour wait because of tickets from two days ago.
 *
 * WHAT IT DOES, once per invocation, for every tenant that has open entries:
 *   - works out the start of the shop's OWN calendar day (tenant_settings.timezone)
 *   - cancels queue entries still 'waiting' or 'called' that joined BEFORE it
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - never marks anything 'done': that would create billable visits (the
 *     billing trigger fires on status = 'done'), charging the shop for visits
 *     nobody confirmed. 'cancelled' is never billed.
 *   - never touches today's entries, so a customer queuing right now is safe
 *     whatever time this runs.
 *   - never touches bookings. Past 'confirmed' bookings are only COUNTED in the
 *     response (staleConfirmedBookings) so staff can complete or cancel them.
 *
 * NOTIFICATIONS: cancelling a waiting entry makes the database tell waiting
 * customers behind it (same service, joined later) their position changed. All
 * stale entries for a tenant are cancelled in ONE statement, so by the time
 * those notifications are worked out the other stale entries are already
 * cancelled and receive nothing. Only a customer who is genuinely waiting
 * today could be told they moved up, which is true.
 *
 * AUTH / SCHEDULING: same as app/api/cron/promote-bookings — a shared secret
 * (CRON_SECRET) in `Authorization: Bearer <secret>`. Vercel Cron sends that
 * header by itself when CRON_SECRET is set. See the vercel.json snippet that
 * came with this file.
 *
 * DRY RUN: add ?dryRun=1 to see what WOULD be cancelled without changing anything.
 */

import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

// Hard cap on how many open entries one run looks at when finding tenants.
// Far above any real queue; only protects against a runaway table scan.
const MAX_OPEN_ROWS_SCANNED = 20_000

interface TenantResult {
  tenantId: string
  cutoff: string
  waiting: number
  called: number
}

interface CleanupSummary {
  dryRun: boolean
  tenantsChecked: number
  cancelled: number
  staleConfirmedBookings: number
  perTenant: TenantResult[]
  errors: string[]
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(tz: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((x) => [x.type, x.value]),
  )
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000
}

/** 00:00 at the start of the shop's current local day, as a UTC instant. */
function startOfLocalDayUtc(tz: string, now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  const [y, m, d] = ymd.split("-").map(Number)
  let guess = Date.UTC(y, m - 1, d)
  guess -= tzOffsetMs(tz, new Date(guess))
  guess = Date.UTC(y, m - 1, d) - tzOffsetMs(tz, new Date(guess)) // re-check across DST changes
  return new Date(guess)
}

async function tenantTimezone(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, tenantId: string): Promise<string> {
  const { data } = await supabase.from("tenant_settings").select("timezone").eq("tenant_id", tenantId).maybeSingle()
  return (data?.timezone as string | null) || "Africa/Johannesburg"
}

async function cleanup(dryRun: boolean): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    dryRun,
    tenantsChecked: 0,
    cancelled: 0,
    staleConfirmedBookings: 0,
    perTenant: [],
    errors: [],
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) {
    summary.errors.push("Supabase is not configured")
    return summary
  }

  const { data: openRows, error: openError } = await supabase
    .from("queue_entries")
    .select("tenant_id")
    .in("status", ["waiting", "called"])
    .limit(MAX_OPEN_ROWS_SCANNED)

  if (openError) {
    summary.errors.push(openError.message)
    return summary
  }

  const tenantIds = [...new Set((openRows ?? []).map((r: { tenant_id: string }) => r.tenant_id))]
  summary.tenantsChecked = tenantIds.length

  for (const tenantId of tenantIds) {
    try {
      // Midnight at the START of the shop's current local day, as a UTC instant.
      const timezone = await tenantTimezone(supabase, tenantId)
      const cutoffISO = startOfLocalDayUtc(timezone).toISOString()

      const { data: stale, error: staleError } = await supabase
        .from("queue_entries")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .in("status", ["waiting", "called"])
        .lt("joined_at", cutoffISO)

      if (staleError) throw new Error(staleError.message)
      const rows = (stale ?? []) as Array<{ id: string; status: "waiting" | "called" }>
      if (rows.length === 0) continue

      if (!dryRun) {
        // ONE statement for the whole tenant (see NOTIFICATIONS above). Scoped
        // by tenant, the cutoff and the open statuses again, so an entry that
        // was finished between the select and now is never touched.
        const { error: updateError } = await supabase
          .from("queue_entries")
          .update({ status: "cancelled" })
          .eq("tenant_id", tenantId)
          .in("status", ["waiting", "called"])
          .lt("joined_at", cutoffISO)
        if (updateError) throw new Error(updateError.message)
      }

      summary.cancelled += rows.length
      summary.perTenant.push({
        tenantId,
        cutoff: cutoffISO,
        waiting: rows.filter((r) => r.status === "waiting").length,
        called: rows.filter((r) => r.status === "called").length,
      })
    } catch (error) {
      summary.errors.push(`tenant ${tenantId}: ${(error as Error).message}`)
    }
  }

  // Information only: bookings still 'confirmed' although their time passed
  // more than 12 hours ago (never completed or cancelled by staff).
  try {
    const { count, error } = await supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("status", "confirmed")
      .lt("end_time", new Date(Date.now() - 12 * 60 * 60_000).toISOString())
    if (error) throw new Error(error.message)
    summary.staleConfirmedBookings = count ?? 0
  } catch (error) {
    summary.errors.push(`stale bookings count: ${(error as Error).message}`)
  }

  return summary
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return request.headers.get("authorization") === `Bearer ${expected}`
}

async function handle(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET) {
    console.error("[cleanup-queue] CRON_SECRET is not configured; refusing to run")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1"
  const summary = await cleanup(dryRun)
  if (summary.errors.length > 0) console.error("[cleanup-queue] finished with errors", summary.errors)
  return NextResponse.json(summary)
}

// Vercel Cron calls GET; other schedulers are easiest as POST.
export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
