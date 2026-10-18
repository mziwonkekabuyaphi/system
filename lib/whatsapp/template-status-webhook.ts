// lib/whatsapp/template-status-webhook.ts
/**
 * Handles Meta's "message_template_status_update" webhook events.
 *
 * Meta tells us when a template we submitted is approved, rejected, paused...
 * This file turns those events into updates on whatsapp_templates, through the
 * database function whatsapp_apply_template_status (service_role only), which:
 *   - finds the tenant by the WABA id (a template can never touch another tenant),
 *   - matches by Meta's template id (or by name if our row has no id yet),
 *   - never touches rows still in "draft".
 *
 * It NEVER throws: a problem here must not stop message handling or make the
 * webhook answer anything but 200. It does not touch message parsing at all.
 * Server only; not a "use server" file.
 *
 * It replaces the older lib/whatsapp/template-status.ts, which was never wired
 * in and fails when one WABA has two integration rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export type TemplateStatus = "pending" | "approved" | "rejected" | "paused" | "disabled"

export interface TemplateStatusEvent {
  wabaId: string
  metaTemplateId: string | null
  metaName: string | null
  status: TemplateStatus
  reason: string | null
  /** Meta's own event name, for logs. */
  rawEvent: string
}

/** Meta event name -> our status. Unknown events return null and are ignored (never guessed). */
export function mapTemplateEvent(event: string): TemplateStatus | null {
  switch (event.trim().toUpperCase()) {
    case "APPROVED":
    case "REINSTATED":
      return "approved"
    case "REJECTED":
      return "rejected"
    case "PENDING":
    case "IN_APPEAL":
      return "pending"
    case "PAUSED":
    case "LOCKED":
    case "FLAGGED":
      return "paused"
    case "DISABLED":
    case "DELETED":
    case "PENDING_DELETION":
      return "disabled"
    default:
      return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "string" && value.trim()) return value.trim()
  return null
}

/** Pulls every template status event out of a webhook payload. Pure; never throws. */
export function extractTemplateStatusEvents(payload: unknown): TemplateStatusEvent[] {
  const events: TemplateStatusEvent[] = []
  const entries = asRecord(payload)?.entry
  if (!Array.isArray(entries)) return events

  for (const entry of entries) {
    const entryRecord = asRecord(entry)
    const wabaId = asId(entryRecord?.id)
    const changes = entryRecord?.changes
    if (!wabaId || !Array.isArray(changes)) continue

    for (const change of changes) {
      const changeRecord = asRecord(change)
      if (changeRecord?.field !== "message_template_status_update") continue
      const value = asRecord(changeRecord.value)
      if (!value || typeof value.event !== "string") continue

      const status = mapTemplateEvent(value.event)
      if (!status) {
        console.warn("[webhook] Ignoring unknown template event", { event: value.event.slice(0, 40) })
        continue
      }

      const metaTemplateId = asId(value.message_template_id)
      const metaName = typeof value.message_template_name === "string" && value.message_template_name ? value.message_template_name : null
      if (!metaTemplateId && !metaName) continue

      const reason = typeof value.reason === "string" && value.reason && value.reason.toUpperCase() !== "NONE" ? value.reason : null
      events.push({ wabaId, metaTemplateId, metaName, status, reason, rawEvent: value.event })
    }
  }
  return events
}

/** Applies each event. Returns how many template rows changed. Never throws. */
export async function applyTemplateStatusEvents(supabase: SupabaseClient, events: TemplateStatusEvent[]): Promise<number> {
  let changed = 0
  for (const event of events) {
    try {
      const { data, error } = await supabase.rpc("whatsapp_apply_template_status", {
        p_waba_id: event.wabaId,
        p_meta_template_id: event.metaTemplateId,
        p_meta_name: event.metaName,
        p_status: event.status,
        p_reason: event.reason,
      })
      if (error) {
        console.error("[webhook] Template status update failed", { wabaId: event.wabaId, event: event.rawEvent, error: error.message })
        continue
      }
      const count = typeof data === "number" ? data : 0
      changed += count
      console.log("[webhook] Template status applied", { wabaId: event.wabaId, event: event.rawEvent, status: event.status, rows: count })
    } catch (error) {
      console.error("[webhook] Template status update threw", { wabaId: event.wabaId, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  return changed
}

/** Convenience for the webhook route: extract + apply, swallowing every error. */
export async function handleTemplateStatusUpdates(supabase: SupabaseClient, payload: unknown): Promise<void> {
  try {
    const events = extractTemplateStatusEvents(payload)
    if (events.length > 0) await applyTemplateStatusEvents(supabase, events)
  } catch (error) {
    console.error("[webhook] Template status handling failed", { error: error instanceof Error ? error.message : "unknown" })
  }
}
