// app/api/cron/sweep-stale-queue/route.ts
/**
 * Stale queue sweep — closes walk-in queue entries left over from a previous day.
 *
 * WHY: nothing else ever closes a 'waiting' or 'called' entry on its own. One
 * the shop forgot to call/complete stays in the live queue forever: it inflates
 * every wait estimate (getQueueSimulation counts all waiting/called rows) and,
 * through the block_duplicate_queue_entry trigger, can stop that customer
 * joining the queue again.
 *
 * WHAT: for each tenant, any entry still 'waiting' or 'called' whose joined_at
 * is before the start of the tenant's CURRENT local day (tenant_settings
 * timezone) is set to 'cancelled' — the same status cancel.ts uses, which is
 * never billed (billable_visits is only written for 'done').
 *
 * SAFE TO RE-RUN: every UPDATE is guarded by the expected current status, so a
 * second run, or an entry staff closed in the meantime, is simply skipped.
 *
 * TRIGGER: same as promote-bookings — an external scheduler calls this URL with
 * `Authorization: Bearer <CRON_SECRET>`. Hourly is plenty (a tenant's stale
 * entries are cleared on the first run after its local midnight).
 */

import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { startOfTenantDay } from "@/lib/services/shared/queue-day"

export const dynamic = "force-dynamic"

const UPDATE_CHUNK_SIZE = 200

interface LiveEntryRow {
  id: string
  tenant_id: string
  joined_at: string
}

interface SweepSummary {
  tenantsChecked: number
  cancelled: number
  errors: string[]
}

async function sweepStaleEntries(): Promise<SweepSummary> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return { tenantsChecked: 0, cancelled: 0, errors: ["Supabase is not configured"] }

  // Live queues are small (tens of rows per tenant), so read them all and
  // decide staleness per tenant in code — each tenant has its own timezone.
  const { data, error } = await supabase
    .from("queue_entries")
    .select("id, tenant_id, joined_at")
    .in("status", ["waiting", "called"])

  if (error) return { tenantsChecked: 0, cancelled: 0, errors: [error.message] }

  const byTenant = new Map<string, LiveEntryRow[]>()
  for (const row of (data ?? []) as LiveEntryRow[]) {
    const list = byTenant.get(row.tenant_id) ?? []
    list.push(row)
    byTenant.set(row.tenant_id, list)
  }

  const now = new Date()
  let cancelled = 0
  const errors: string[] = []

  for (const [tenantId, rows] of byTenant) {
    try {
      const timezone = await getTenantTimezone(supabase, tenantId)
      const cutoff = startOfTenantDay(timezone, now).getTime()
      const staleIds = rows.filter((r) => new Date(r.joined_at).getTime() < cutoff).map((r) => r.id)
      if (staleIds.length === 0) continue

      for (let i = 0; i < staleIds.length; i += UPDATE_CHUNK_SIZE) {
        const chunk = staleIds.slice(i, i + UPDATE_CHUNK_SIZE)
        const { data: updated, error: updateError } = await supabase
          .from("queue_entries")
          .update({ status: "cancelled" })
          .eq("tenant_id", tenantId)
          .in("id", chunk)
          .in("status", ["waiting", "called"])
          .select("id")

        if (updateError) {
          errors.push(`tenant ${tenantId}: ${updateError.message}`)
          continue
        }
        cancelled += updated?.length ?? 0
      }
    } catch (err) {
      errors.push(`tenant ${tenantId}: ${(err as Error).message}`)
    }
  }

  if (cancelled > 0 || errors.length > 0) {
    console.log("[sweep-stale-queue]", { tenantsChecked: byTenant.size, cancelled, errors })
  }
  return { tenantsChecked: byTenant.size, cancelled, errors }
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return request.headers.get("authorization") === `Bearer ${expected}`
}

async function handle(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET) {
    console.error("[sweep-stale-queue] CRON_SECRET is not configured; refusing to run")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await sweepStaleEntries())
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
