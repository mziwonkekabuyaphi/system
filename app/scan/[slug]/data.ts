// app/scan/[slug]/data.ts
//
// Server-only helpers for the gate scanner: find the tenant from the URL slug, build its
// branding, and list the events open for check-in. Used by page.tsx and actions.ts.
//
// NO LOGIN YET (on purpose): the tenant comes from the slug in the URL, so anyone who has the
// link can use the scanner for that tenant. When scanner login is added, this is the single
// place to plug it in: see authorizeScan() below.

import { cache } from "react"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { buildBrandVars } from "./branding"
import type { ScanEvent, ScanTenant } from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

export type ScanLookup =
  | { status: "ok"; db: ServerClient; tenantId: string; tenant: ScanTenant }
  | { status: "not_found" }
  | { status: "unavailable"; tenant: ScanTenant | null; message: string }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const DEFAULT_TIMEZONE = "Africa/Johannesburg"

function safeTimezone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat("en-ZA", { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_TIMEZONE
  }
}

/** One lookup per request (page + metadata + viewport share it). */
export const resolveScanTenant = cache(async (slug: string): Promise<ScanLookup> => {
  if (!SLUG_RE.test(slug)) return { status: "not_found" }

  const db = getSupabaseServerClient()
  if (!db) return { status: "unavailable", tenant: null, message: "The scanner isn't set up on the server yet." }

  const { data: row, error } = await db.from("tenants").select("id,name,slug,status").eq("slug", slug).maybeSingle()
  if (error) {
    console.error("[scan] tenant lookup failed:", error.message)
    return { status: "unavailable", tenant: null, message: "Couldn't reach the server. Try again in a moment." }
  }
  if (!row) return { status: "not_found" }

  const tenantId = String(row.id)
  const [branding, settings] = await Promise.all([
    db
      .from("tenant_branding")
      .select("display_name,logo_url,primary_color,secondary_color,remove_powered_by")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    db.from("tenant_settings").select("timezone,brand_name").eq("tenant_id", tenantId).maybeSingle(),
  ])

  const b = (branding.data ?? {}) as Record<string, unknown>
  const s = (settings.data ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const logo = text(b.logo_url)

  const tenant: ScanTenant = {
    slug,
    name: text(b.display_name) ?? text(s.brand_name) ?? String(row.name),
    // The logo is rendered in an <img>; only https (or same-origin) URLs are accepted.
    logoUrl: logo && /^https:\/\//i.test(logo) ? logo : null,
    timezone: safeTimezone(s.timezone),
    showPoweredBy: b.remove_powered_by !== true,
    brandVars: buildBrandVars(text(b.primary_color), text(b.secondary_color)),
  }

  if (row.status !== "active") {
    return { status: "unavailable", tenant, message: "This venue isn't active right now." }
  }
  if (!(await isModuleEnabled(tenantId, "events"))) {
    return { status: "unavailable", tenant, message: "Events isn't switched on for this venue." }
  }
  return { status: "ok", db, tenantId, tenant }
})

/**
 * The one door every scanner request goes through.
 *
 * TODO(auth): when scanner login is added, check the signed-in person here, e.g.
 *   const check = await requireTenantPermission("tickets.scan")
 *   if (!check.ok || check.member.tenantId !== found.tenantId) return a refusal
 * and switch the check-in calls in actions.ts to the session-based event_check_in_ticket().
 */
export async function authorizeScan(slug: string): Promise<ScanLookup> {
  return resolveScanTenant(slug)
}

/** Events the gate can check people into: status = active, soonest first. */
export async function loadOpenEvents(db: ServerClient, tenantId: string): Promise<ScanEvent[]> {
  const { data, error } = await db
    .from("events")
    .select("id,name,location,start_time,end_time")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("start_time", { ascending: true })
    .limit(50)
  if (error) {
    console.error("[scan] loadOpenEvents failed:", error.message)
    return []
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((e) => ({
    id: String(e.id),
    name: String(e.name),
    location: (e.location as string | null) ?? null,
    startTime: String(e.start_time),
    endTime: (e.end_time as string | null) ?? null,
  }))
}
