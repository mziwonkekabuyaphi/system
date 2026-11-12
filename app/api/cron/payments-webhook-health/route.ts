// app/api/cron/payments-webhook-health/route.ts
/**
 * Daily check that every connected shop's Yoco webhook still exists, and re-register it when it doesn't.
 * See lib/payments/webhook-health.ts for what it checks and its one limit.
 *
 * TRIGGER: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it), like the other crons.
 * SAFE TO RE-RUN: it only changes things that are actually broken.
 */

import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { runWebhookHealthCheck } from "@/lib/payments/webhook-health"

export const dynamic = "force-dynamic"
export const maxDuration = 60

async function handle(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error("[payments-webhook-health] CRON_SECRET is not configured; refusing to run")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 })

  try {
    return NextResponse.json(await runWebhookHealthCheck(supabase))
  } catch (error) {
    console.error("[payments-webhook-health] failed", { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "Health check failed" }, { status: 500 })
  }
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
