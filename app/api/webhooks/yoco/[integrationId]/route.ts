// app/api/cron/expire-shisha-payments/route.ts
/**
 * Closes shisha requests whose payment link was not paid within 10 minutes, and tells the customer.
 *
 * WHY A SEPARATE JOB: the general expire-payments job waits 24 hours, which is far too long for shisha.
 * This one must run EVERY MINUTE to be accurate (see vercel.json / the note in the setup steps).
 *
 * A late payment is still safe: the payment webhook sees the closed request and refunds the customer.
 * Safe to re-run: the database function only touches requests that are still awaiting payment.
 * TRIGGER: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it), same as the other crons.
 */

import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import * as messages from "@/lib/services/messages/shisha"
import { notifyShishaCustomer } from "@/lib/services/shisha-notify"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/** How long a customer has to pay after staff approve. Keep in step with the wording in messages/shisha.ts. */
const PAYMENT_WINDOW = "10 minutes"

interface ExpiredRow {
  out_tenant_id: string
  out_request_id: string
  out_phone: string | null
}

async function handle(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error("[expire-shisha-payments] CRON_SECRET is not configured; refusing to run")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 })

  const { data, error } = await supabase.rpc("shisha_expire_unpaid_requests", { p_after: PAYMENT_WINDOW })
  if (error) {
    console.error("[expire-shisha-payments] failed", { error: error.message })
    return NextResponse.json({ error: "Expiry failed" }, { status: 500 })
  }

  const rows = (data ?? []) as ExpiredRow[]
  // The requests are already closed; a failed WhatsApp send only gets logged by notifyShishaCustomer.
  for (const row of rows) {
    await notifyShishaCustomer(row.out_tenant_id, row.out_phone, messages.PAYMENT_LINK_EXPIRED)
  }

  return NextResponse.json({ expired: rows.length })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
