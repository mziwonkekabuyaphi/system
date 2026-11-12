// app/api/cron/expire-payments/route.ts
/**
 * Abandoned card checkouts — closes payment attempts nobody finished.
 *
 * WHY: every Passport top-up and ticket card payment is recorded BEFORE the customer pays. If they
 * never open the link, or close Yoco's page, that record stays 'pending' forever, and for top-ups the
 * wallet_topups row stays pending too. Nothing is lost (no money moved), but the shop's records fill up
 * with attempts that can never complete.
 *
 * WHAT: payments_expire_abandoned() (database function, service_role only) marks
 *   - 'creating' attempts older than 1 hour  (the customer never received a link), and
 *   - 'pending'  attempts older than 24 hours (the customer had a link and didn't pay)
 * as 'cancelled', and marks their top-up 'expired'. Ticket orders hold no stock while unpaid, so
 * nothing else needs releasing.
 *
 * LATE PAYMENTS ARE STILL SAFE: if someone pays an expired link, the signed webhook revives the top-up
 * (wallet_revive_topup) and credits it, or issues the tickets, exactly as for an on-time payment.
 *
 * SAFE TO RE-RUN: the database function only touches rows still in the old status.
 * TRIGGER: same as the other crons — `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it).
 */

import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

async function handle(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error("[expire-payments] CRON_SECRET is not configured; refusing to run")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 })

  const { data, error } = await supabase.rpc("payments_expire_abandoned").maybeSingle()
  if (error) {
    console.error("[expire-payments] failed", { error: error.message })
    return NextResponse.json({ error: "Expiry failed" }, { status: 500 })
  }
  const row = (data ?? {}) as { payments_expired?: number; topups_expired?: number }
  return NextResponse.json({ paymentsExpired: row.payments_expired ?? 0, topupsExpired: row.topups_expired ?? 0 })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
