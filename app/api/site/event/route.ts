// app/api/site/event/route.ts
//
// Counts a visit or a WhatsApp tap for a shop's website. Called by the small beacon on the public pages.
// Privacy: nothing about the visitor is stored (no cookie, no IP, no id): the database only adds 1 to a
// per-day counter. The shop comes from the HOSTNAME, so the beacon can't name a shop, and visits on our
// own hostnames (the owner's preview, /site/{slug}) are never counted.
// Abuse: bots are ignored, and each address is limited per minute (kept in memory only, never stored).

import { NextResponse, type NextRequest } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { slugForRequestHost } from "@/lib/site/host-slug"

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor/i
const LIMIT = 40
const WINDOW_MS = 60_000
const hits = new Map<string, { count: number; resetAt: number }>()

function allowed(key: string): boolean {
  const now = Date.now()
  if (hits.size > 5_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k)
  const h = hits.get(key)
  if (!h || h.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  h.count += 1
  return h.count <= LIMIT
}

const empty = (status = 204) => new NextResponse(null, { status, headers: { "cache-control": "no-store" } })

export async function POST(request: NextRequest) {
  if (BOT.test(request.headers.get("user-agent") ?? "")) return empty()

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown"
  if (!allowed(ip)) return empty(429)

  const body = (await request.json().catch(() => null)) as { kind?: unknown } | null
  const kind = body?.kind
  if (kind !== "view" && kind !== "whatsapp") return empty(400)

  const slug = await slugForRequestHost(request.headers.get("host"))
  if (!slug) return empty()

  const db = getSupabaseServerClient()
  if (!db) return empty()
  const { error } = await db.rpc("site_record_event", { p_slug: slug, p_kind: kind })
  if (error) console.error("[site-stats] record failed", error.message)
  return empty()
}
