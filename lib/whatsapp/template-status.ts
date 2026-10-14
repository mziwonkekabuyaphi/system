// lib/whatsapp/template-status.ts
/**
 * Applies a Meta "message_template_status_update" webhook event to whatsapp_templates.
 * Deliberately NOT a "use server" file: this is internal code for your webhook route, not something
 * a browser should be able to call.
 *
 * Call it from your existing WhatsApp webhook route handler (the one that receives inbound messages):
 *
 *   for (const entry of body.entry ?? []) {
 *     for (const change of entry.changes ?? []) {
 *       if (change.field === "message_template_status_update") {
 *         await applyTemplateStatusChange(entry.id, change.value)   // entry.id = the tenant's WABA id
 *       }
 *     }
 *   }
 *
 * Also tick the "message_template_status_update" field under Webhooks > WhatsApp Business Account
 * in the Meta app dashboard, or Meta won't send these events.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"

interface TemplateStatusEvent {
  event: string // APPROVED | REJECTED | PAUSED | DISABLED | PENDING | FLAGGED | REINSTATED ...
  message_template_id?: number | string
  message_template_name?: string
  reason?: string
}

function mapEvent(event: string): "approved" | "rejected" | "paused" | "disabled" | "pending" {
  switch (event.toUpperCase()) {
    case "APPROVED":
    case "REINSTATED":
      return "approved"
    case "REJECTED":
      return "rejected"
    case "PAUSED":
    case "FLAGGED":
      return "paused"
    case "DISABLED":
    case "PENDING_DELETION":
      return "disabled"
    default:
      return "pending"
  }
}

export async function applyTemplateStatusChange(wabaId: string, value: TemplateStatusEvent) {
  const supabase = getSupabaseServerClient()
  if (!supabase || !value?.message_template_name) return

  // The WABA id identifies the tenant, so a template name can never touch another tenant's row.
  const { data: integration } = await supabase
    .from("tenant_whatsapp_integrations")
    .select("tenant_id")
    .eq("business_account_id", wabaId)
    .maybeSingle()
  if (!integration) return

  const status = mapEvent(value.event)
  const { error } = await supabase
    .from("whatsapp_templates")
    .update({
      status,
      meta_template_id: value.message_template_id != null ? String(value.message_template_id) : undefined,
      rejection_reason: status === "rejected" && value.reason && value.reason !== "NONE" ? value.reason : null,
    })
    .eq("tenant_id", integration.tenant_id)
    .eq("meta_name", value.message_template_name)
    .neq("status", "draft")
  if (error) console.error("[whatsapp] template status update failed", { wabaId, error: error.message })
}
