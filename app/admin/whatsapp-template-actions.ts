"use server"

// app/admin/whatsapp-template-actions.ts
/**
 * Owner-only actions for the tenant's Meta WhatsApp templates.
 *
 * Templates live in the TENANT'S OWN WhatsApp Business Account (WABA), so every call here uses
 * that tenant's business_account_id + access token from tenant_whatsapp_integrations. Nothing is
 * shared between tenants. Rows are in public.whatsapp_templates (see migration_whatsapp_templates.sql).
 *
 * Flow: seed defaults -> tenant edits wording -> submitTemplate() sends it to Meta ->
 * Meta approves/rejects (usually minutes) -> status arrives by webhook
 * (lib/whatsapp/template-status.ts) or by pressing "Refresh status" (syncTemplateStatuses()).
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"

const GRAPH_VERSION = "v23.0"
const MAX_BODY_LENGTH = 1024 // Meta's limit for a template body

export type WhatsAppTemplateStatus = "draft" | "pending" | "approved" | "rejected" | "paused" | "disabled"

export interface WhatsAppTemplateDto {
  key: string
  metaName: string
  body: string
  variables: string[]
  exampleValues: string[]
  status: WhatsAppTemplateStatus
  rejectionReason: string | null
}

type Result<T = object> = ({ success: true } & T) | { success: false; error: string }

async function tenantContext() {
  const { tenantId, roleKey } = await requireTenantMember()
  if (roleKey !== "tenant_owner") throw new Error("Not authorized")
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId }
}
type Supabase = Awaited<ReturnType<typeof tenantContext>>["supabase"]

async function getIntegration(supabase: Supabase, tenantId: string) {
  const { data } = await supabase
    .from("tenant_whatsapp_integrations")
    .select("business_account_id, access_token_secret_id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle()
  if (!data?.business_account_id || !data.access_token_secret_id) return null
  const { data: token } = await supabase.rpc("get_secret_by_id", { p_secret_id: data.access_token_secret_id })
  if (!token) return null
  return { wabaId: data.business_account_id as string, token: token as string }
}

function mapMetaStatus(s: string | undefined): WhatsAppTemplateStatus {
  switch ((s ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved"
    case "REJECTED":
      return "rejected"
    case "PAUSED":
      return "paused"
    case "DISABLED":
    case "DELETED":
    case "PENDING_DELETION":
      return "disabled"
    default:
      return "pending" // PENDING, IN_APPEAL, anything new
  }
}

function toDto(row: Record<string, any>): WhatsAppTemplateDto {
  return {
    key: row.key,
    metaName: row.meta_name,
    body: row.body,
    variables: row.variables,
    exampleValues: row.example_values,
    status: row.status,
    rejectionReason: row.rejection_reason ?? null,
  }
}

/** Meta's content rules we can check up front, so the tenant gets a clear message instead of a rejection. */
function validateBody(body: string, variableCount: number): string | null {
  const text = body.trim()
  if (!text) return "The message can't be empty."
  if (text.length > MAX_BODY_LENGTH) return `The message must be ${MAX_BODY_LENGTH} characters or fewer.`
  const used = [...new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  if (used.length === 0) return "Include at least one placeholder such as {{1}}."
  if (used.some((n, i) => n !== i + 1)) return "Placeholders must run in order with no gaps: {{1}}, {{2}}, {{3}}…"
  if (used.length > variableCount) return `This message only has ${variableCount} placeholders available.`
  if (/^\{\{\d+\}\}/.test(text) || /\{\{\d+\}\}$/.test(text)) {
    return "Don't start or end the message with a placeholder: Meta tends to reject that."
  }
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) return "Put some words between placeholders."
  return null
}

export async function loadWhatsAppTemplates(): Promise<Result<{ templates: WhatsAppTemplateDto[]; connected: boolean }>> {
  try {
    const { supabase, tenantId } = await tenantContext()
    const [{ data, error }, integration] = await Promise.all([
      supabase.from("whatsapp_templates").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: true }),
      supabase
        .from("tenant_whatsapp_integrations")
        .select("business_account_id, status")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
        .maybeSingle(),
    ])
    if (error) return { success: false, error: error.message }
    return { success: true, templates: (data ?? []).map(toDto), connected: !!integration.data?.business_account_id }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function seedWhatsAppTemplates(): Promise<Result> {
  try {
    const { supabase, tenantId } = await tenantContext()
    const { error } = await supabase.rpc("seed_whatsapp_templates", { p_tenant_id: tenantId })
    if (error) return { success: false, error: error.message }
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/** Saves the tenant's wording. If this template was already sent to Meta, the edit becomes a NEW version
 *  (name ..._v2) because Meta limits how often an approved template can be edited. Until the new version is
 *  approved, out-of-window sends for it are skipped (they're logged in whatsapp_send_log). */
export async function saveWhatsAppTemplateBody(key: string, body: string): Promise<Result<{ template: WhatsAppTemplateDto }>> {
  try {
    const { supabase, tenantId } = await tenantContext()
    const { data: row, error } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("key", key)
      .maybeSingle()
    if (error) return { success: false, error: error.message }
    if (!row) return { success: false, error: "Template not found." }
    if (row.status === "pending") return { success: false, error: "This template is being reviewed by Meta. Wait for the result before editing." }

    const problem = validateBody(body, row.variables.length)
    if (problem) return { success: false, error: problem }

    const text = body.trim()
    if (text === row.body) return { success: true, template: toDto(row) }

    const everSubmitted = row.status !== "draft"
    const version = Number(/_v(\d+)$/.exec(row.meta_name)?.[1] ?? 1)
    const metaName = everSubmitted ? row.meta_name.replace(/_v\d+$/, "") + `_v${version + 1}` : row.meta_name

    const { data: updated, error: updateError } = await supabase
      .from("whatsapp_templates")
      .update({ body: text, status: "draft", meta_name: metaName, meta_template_id: null, rejection_reason: null })
      .eq("tenant_id", tenantId)
      .eq("key", key)
      .select("*")
      .single()
    if (updateError) return { success: false, error: updateError.message }
    return { success: true, template: toDto(updated) }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function submitWhatsAppTemplate(key: string): Promise<Result<{ template: WhatsAppTemplateDto }>> {
  try {
    const { supabase, tenantId } = await tenantContext()
    const integration = await getIntegration(supabase, tenantId)
    if (!integration) return { success: false, error: "WhatsApp isn't connected for this shop yet." }

    const { data: row } = await supabase.from("whatsapp_templates").select("*").eq("tenant_id", tenantId).eq("key", key).maybeSingle()
    if (!row) return { success: false, error: "Template not found." }
    if (row.status !== "draft" && row.status !== "rejected") return { success: false, error: `This template is already ${row.status}.` }

    const problem = validateBody(row.body, row.variables.length)
    if (problem) return { success: false, error: problem }

    const used = new Set([...row.body.matchAll(/\{\{(\d+)\}\}/g)].map((m: RegExpMatchArray) => Number(m[1]))).size
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${integration.wabaId}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: row.meta_name,
        language: row.language,
        category: "UTILITY",
        components: [{ type: "BODY", text: row.body, example: { body_text: [row.example_values.slice(0, used)] } }],
      }),
    })
    const result = await resp.json().catch(() => null)
    if (!resp.ok) {
      const e = result?.error
      return { success: false, error: e?.error_user_msg || e?.message || `Meta rejected the request (${resp.status}).` }
    }

    const { data: updated, error } = await supabase
      .from("whatsapp_templates")
      .update({
        status: mapMetaStatus(result?.status),
        category: result?.category ?? "UTILITY", // Meta may re-categorise as MARKETING
        meta_template_id: result?.id ?? null,
        submitted_at: new Date().toISOString(),
        rejection_reason: null,
      })
      .eq("tenant_id", tenantId)
      .eq("key", key)
      .select("*")
      .single()
    if (error) return { success: false, error: error.message }
    return { success: true, template: toDto(updated) }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/** Pulls the current review status of every template from Meta (fallback if the webhook isn't set up). */
export async function syncWhatsAppTemplateStatuses(): Promise<Result<{ templates: WhatsAppTemplateDto[] }>> {
  try {
    const { supabase, tenantId } = await tenantContext()
    const integration = await getIntegration(supabase, tenantId)
    if (!integration) return { success: false, error: "WhatsApp isn't connected for this shop yet." }

    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${integration.wabaId}/message_templates?fields=name,status,id,category,rejected_reason&limit=100`,
      { headers: { Authorization: `Bearer ${integration.token}` } },
    )
    const result = await resp.json().catch(() => null)
    if (!resp.ok) return { success: false, error: result?.error?.message ?? `Couldn't reach Meta (${resp.status}).` }

    for (const t of result?.data ?? []) {
      const status = mapMetaStatus(t.status)
      await supabase
        .from("whatsapp_templates")
        .update({
          status,
          category: t.category ?? "UTILITY",
          meta_template_id: t.id,
          rejection_reason: status === "rejected" && t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        })
        .eq("tenant_id", tenantId)
        .eq("meta_name", t.name)
        .neq("status", "draft") // never overwrite wording the tenant is still editing
    }

    const { data } = await supabase.from("whatsapp_templates").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: true })
    return { success: true, templates: (data ?? []).map(toDto) }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
