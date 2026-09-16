// app/api/cron/generate-invoices/route.ts
/**
 * Monthly billing job for Growth/Business (metered) tenants.
 *
 * WIRING THIS UP: add to vercel.json —
 *   {
 *     "crons": [{ "path": "/api/cron/generate-invoices", "schedule": "0 3 1 * *" }]
 *   }
 * That's "03:00 UTC on the 1st of every month" — after midnight in every
 * SA timezone, so "last month" is unambiguously over everywhere.
 *
 * SECURITY: Vercel Cron calls this with an `Authorization: Bearer
 * $CRON_SECRET` header automatically once CRON_SECRET is set as an env
 * var — this route just checks it matches. Without that check, this
 * would be a public, unauthenticated "generate invoices" endpoint.
 * Generate a random secret (e.g. `openssl rand -hex 32`) and set it in
 * both Vercel's env vars and CRON_SECRET.
 *
 * Idempotent: generateMonthlyInvoices() skips tenants already invoiced
 * for the period, so a retried or manually-triggered run never
 * double-bills.
 */

import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { generateMonthlyInvoices } from "@/lib/services/plans"

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return NextResponse.json({ error: "Supabase isn't configured." }, { status: 500 })
  }

  try {
    const invoices = await generateMonthlyInvoices(supabase)
    console.log("[cron] generate-invoices completed", {
      count: invoices.length,
      totalCents: invoices.reduce((sum, inv) => sum + inv.amountCents, 0),
    })
    return NextResponse.json({ ok: true, generated: invoices.length, invoices })
  } catch (error) {
    console.error("[cron] generate-invoices failed", error)
    return NextResponse.json({ ok: false, error: "Invoice generation failed." }, { status: 500 })
  }
}
