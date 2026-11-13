// app/scan/[slug]/actions.ts
"use server"

/**
 * Server Actions for the mobile gate scanner (/scan/[slug]).
 * ------------------------------------------------------------
 * - The tenant always comes from the slug and is looked up on the server (data.ts); the
 *   browser never supplies a tenant id.
 * - Every read is filtered by that tenant_id AND the event id.
 * - A check-in is never worked out here. It goes to the database function
 *   scanner_check_in_ticket / scanner_check_in_contact, which verify the event belongs to the
 *   tenant, lock the ticket row, count the entry and write the scan log in one transaction,
 *   exactly like the admin gate's event_check_in_ticket does.
 * - Those two functions can only be called with the service-role key, which only this server
 *   code has.
 *
 * NO LOGIN YET: see authorizeScan() in data.ts for where login goes later.
 */

import { authorizeScan, loadOpenEvents, type ScanLookup } from "./data"
import type { ActionResult, ScanEvent, ScanFeedRow, ScanOutcome, ScanResult, ScanSnapshot } from "./types"

type Fail = { ok: false; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GENERIC_ERROR = "Something went wrong. Please try again."
const RESULTS: ScanResult[] = ["valid", "invalid", "duplicate", "wrong_event", "cancelled", "event_closed"]

const fail = (error: string): Fail => ({ ok: false, error })
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Database messages raised on purpose are written for people; anything technical is hidden. */
function friendly(error: { message?: string } | null | undefined): string {
  const m = (error?.message ?? "").trim()
  if (!m) return GENERIC_ERROR
  if (m.length > 160 || /violates|duplicate key|syntax|relation |column |function |permission denied|row-level security|JWT/i.test(m)) {
    console.error("[scan] database error:", m)
    return GENERIC_ERROR
  }
  return m
}

type Scope = { ok: true; db: Extract<ScanLookup, { status: "ok" }>["db"]; tenantId: string } | Fail

async function scoped(slug: string): Promise<Scope> {
  const found = await authorizeScan(typeof slug === "string" ? slug : "")
  if (found.status === "not_found") return fail("This scanner link isn't valid.")
  if (found.status === "unavailable") return fail(found.message)
  return { ok: true, db: found.db, tenantId: found.tenantId }
}

// ============================================================================
// Events
// ============================================================================

export async function loadScanEvents(slug: string): Promise<ActionResult<ScanEvent[]>> {
  const c = await scoped(slug)
  if (!c.ok) return c
  return { ok: true, data: await loadOpenEvents(c.db, c.tenantId) }
}

// ============================================================================
// Live numbers + recent scans
// ============================================================================

export async function loadScanSnapshot(slug: string, eventId: string): Promise<ActionResult<ScanSnapshot>> {
  const c = await scoped(slug)
  if (!c.ok) return c
  if (!UUID_RE.test(eventId)) return fail("Event not found.")
  const { db, tenantId } = c

  const [scans, sold, admitted, refused] = await Promise.all([
    db
      .from("event_scans")
      .select("id,ticket_id,ticket_number,result,gate,scanned_at")
      .eq("event_id", eventId)
      .eq("tenant_id", tenantId)
      .order("scanned_at", { ascending: false })
      .limit(20),
    db
      .from("event_tickets")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("tenant_id", tenantId)
      .in("status", ["issued", "used"]),
    db
      .from("event_tickets")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("tenant_id", tenantId)
      .in("status", ["issued", "used"])
      .gt("entries_used", 0),
    db
      .from("event_scans")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("tenant_id", tenantId)
      .neq("result", "valid"),
  ])
  if (scans.error) return fail(friendly(scans.error))

  const rows = (scans.data ?? []) as Array<Record<string, unknown>>

  // Name each scan's ticket tier (two small lookups, only when there is something to show).
  const tierByTicket = new Map<string, string>()
  const ticketIds = [...new Set(rows.map((r) => r.ticket_id).filter((v): v is string => typeof v === "string"))]
  if (ticketIds.length > 0) {
    const { data: tickets } = await db
      .from("event_tickets")
      .select("id,ticket_type_id")
      .in("id", ticketIds)
      .eq("tenant_id", tenantId)
    const typeIds = [...new Set(((tickets ?? []) as Array<Record<string, unknown>>).map((t) => String(t.ticket_type_id)))]
    const names = new Map<string, string>()
    if (typeIds.length > 0) {
      const { data: types } = await db.from("event_ticket_types").select("id,name").in("id", typeIds).eq("tenant_id", tenantId)
      for (const t of (types ?? []) as Array<Record<string, unknown>>) names.set(String(t.id), String(t.name))
    }
    for (const t of (tickets ?? []) as Array<Record<string, unknown>>) {
      const name = names.get(String(t.ticket_type_id))
      if (name) tierByTicket.set(String(t.id), name)
    }
  }

  const recent: ScanFeedRow[] = rows.map((r) => ({
    id: String(r.id),
    ticketNumber: (r.ticket_number as string | null) ?? null,
    result: RESULTS.includes(r.result as ScanResult) ? (r.result as ScanResult) : "invalid",
    ticketType: typeof r.ticket_id === "string" ? tierByTicket.get(r.ticket_id) ?? null : null,
    gate: (r.gate as string | null) ?? null,
    scannedAt: String(r.scanned_at),
  }))

  return {
    ok: true,
    data: { sold: sold.count ?? 0, admitted: admitted.count ?? 0, refused: refused.count ?? 0, recent },
  }
}

// ============================================================================
// Check in
// ============================================================================

type Classified = { kind: "contact"; value: string } | { kind: "ticket"; value: string }

/** A phone number or email checks in everything that person holds; anything else is a ticket code. */
function classify(raw: string): Classified {
  const s = raw.trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: "contact", value: s }
  const phone = s.replace(/[\s\-().]/g, "")
  if (/^\+?\d{9,15}$/.test(phone)) return { kind: "contact", value: phone }
  return { kind: "ticket", value: extractTicketCode(s) }
}

/** QR codes may carry the bare token, a JSON object, or a link containing the token. */
function extractTicketCode(text: string): string {
  const pick = (o: Record<string, unknown>): string | null => {
    for (const key of ["qr_token", "qrToken", "ticket_number", "ticketNumber", "ticket_id", "ticketId", "token", "id"]) {
      const v = o[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    return null
  }
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object") return pick(parsed as Record<string, unknown>) ?? text
    } catch {
      /* not JSON: fall through */
    }
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      for (const key of ["token", "t", "qr", "qr_token", "code", "ticket", "ticket_number"]) {
        const v = url.searchParams.get(key)
        if (v && v.trim()) return v.trim()
      }
      const last = url.pathname.split("/").filter(Boolean).pop()
      if (last) return decodeURIComponent(last)
    } catch {
      /* not a URL: fall through */
    }
  }
  return text
}

export async function submitScan(slug: string, eventId: string, raw: string, gate: string): Promise<ActionResult<ScanOutcome>> {
  const c = await scoped(slug)
  if (!c.ok) return c
  if (!UUID_RE.test(eventId)) return fail("Choose an event first.")

  const input = (typeof raw === "string" ? raw : "").trim().slice(0, 500)
  if (!input) return fail("Scan or type a ticket first.")
  const gateName = (typeof gate === "string" ? gate : "").trim().slice(0, 40) || null

  const what = classify(input)
  const { data, error } =
    what.kind === "contact"
      ? await c.db.rpc("scanner_check_in_contact", {
          p_tenant_id: c.tenantId,
          p_event_id: eventId,
          p_contact: what.value,
          p_gate: gateName,
        })
      : await c.db.rpc("scanner_check_in_ticket", {
          p_tenant_id: c.tenantId,
          p_event_id: eventId,
          p_code: what.value,
          p_gate: gateName,
        })
  if (error) return fail(friendly(error))

  const r = (data ?? {}) as Record<string, unknown>
  const result = RESULTS.includes(r.result as ScanResult) ? (r.result as ScanResult) : "invalid"
  return {
    ok: true,
    data: {
      success: r.success === true,
      result,
      message: String(r.message ?? ""),
      ticketNumber: (r.ticket_number as string | undefined) ?? undefined,
      ticketType: (r.ticket_type as string | null | undefined) ?? undefined,
      holder: (r.holder as string | null | undefined) ?? undefined,
      entriesUsed: r.entries_used === undefined ? undefined : num(r.entries_used),
      entriesAllowed: r.entries_allowed === undefined ? undefined : num(r.entries_allowed),
      lastScannedAt: (r.last_scanned_at as string | null | undefined) ?? undefined,
      ticketCount: r.ticket_count === undefined ? undefined : num(r.ticket_count),
    },
  }
}
