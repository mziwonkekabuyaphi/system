/**
 * QLess WhatsApp — Conversation & message persistence (tenant-scoped).
 * ---------------------------------------------------------------------
 * Tenant-scoped rewrite of the single-tenant original. Every function now
 * takes tenantId; `conversations` uniqueness moves from `phone` alone to
 * `(tenant_id, phone)`, and every `messages` row now carries `tenant_id`
 * directly (denormalized from its conversation) so tenant-scoped reads and
 * RLS policies on `messages` don't require a join back to `conversations`.
 *
 * Still server-only (service role client) — must only be imported from
 * server code (route handlers, server actions).
 */

import { getSupabaseServerClient } from "@/lib/supabase/server"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"

const SUPABASE_UNCONFIGURED_ERROR = "Supabase server client is not configured."

export type MessageDirection = "incoming" | "outgoing"

function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505"
}

export interface StoreResult {
  ok: boolean
  conversationId?: string
  duplicate?: boolean
  error?: string
}

/**
 * Finds an existing conversation for the given (tenant, phone), or creates
 * one. Upserts on the unique (tenant_id, phone) pair so concurrent webhook
 * deliveries from the same sender, to the same tenant, don't race into
 * duplicate rows.
 */
export async function upsertConversation(
  tenantId: string,
  phoneNumber: string,
  profileName: string | null,
  lastActivity: Date | null,
): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return { ok: false, error: SUPABASE_UNCONFIGURED_ERROR }
  }

  const activity = (lastActivity ?? new Date()).toISOString()

  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    phone: phoneNumber,
    last_activity: activity,
  }
  if (profileName) row.customer_name = profileName

  const { data, error } = await supabase
    .from("conversations")
    .upsert(row, { onConflict: "tenant_id,phone" })
    .select("id")
    .single()

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true, conversationId: data?.id as string | undefined }
}

/**
 * Persists a single inbound message and its conversation, both scoped to
 * tenantId. De-duplication (Meta retries) still works exactly as before —
 * `messages.meta_message_id` stays globally unique, not per-tenant, since
 * a given Meta message id can only ever belong to one real message.
 */
export async function storeIncomingMessage(tenantId: string, message: IncomingMessage): Promise<StoreResult> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return { ok: false, error: SUPABASE_UNCONFIGURED_ERROR }
  }

  const convo = await upsertConversation(tenantId, message.from, message.profileName, message.timestamp)
  if (!convo.ok || !convo.conversationId) {
    return { ok: false, error: convo.error ?? "Failed to resolve conversation." }
  }

  const { error } = await supabase.from("messages").insert({
    tenant_id: tenantId,
    conversation_id: convo.conversationId,
    meta_message_id: message.waMessageId,
    direction: "incoming",
    message_type: message.type,
    message_text: message.text,
    sender_phone: message.from,
    recipient_phone: null,
    raw_payload: message,
    created_at: message.timestamp ? message.timestamp.toISOString() : new Date().toISOString(),
  })

  if (error) {
    if (isUniqueViolation(error as { code?: string })) {
      return { ok: true, conversationId: convo.conversationId, duplicate: true }
    }
    return { ok: false, conversationId: convo.conversationId, error: error.message }
  }

  return { ok: true, conversationId: convo.conversationId, duplicate: false }
}

/**
 * Records an outbound message we sent back to the user. Best-effort:
 * failures are returned, not thrown. Requires tenantId directly (not
 * re-derived from conversationId) since the caller already has it from
 * resolving the inbound message, and a second lookup isn't worth avoiding
 * one extra parameter.
 */
export async function storeOutboundMessage(
  tenantId: string,
  conversationId: string,
  body: string,
  waMessageId: string | null,
): Promise<StoreResult> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return { ok: false, error: SUPABASE_UNCONFIGURED_ERROR }
  }

  const { error } = await supabase.from("messages").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    meta_message_id: waMessageId,
    direction: "outgoing",
    message_type: "text",
    message_text: body,
    recipient_phone: null,
    raw_payload: { body, waMessageId },
    created_at: new Date().toISOString(),
  })

  if (error) {
    if (isUniqueViolation(error as { code?: string })) {
      return { ok: true, conversationId, duplicate: true }
    }
    return { ok: false, conversationId, error: error.message }
  }

  return { ok: true, conversationId, duplicate: false }
}

export interface ConversationMessageRow {
  direction: MessageDirection
  message_text: string | null
  created_at: string
}

export interface GetConversationMessagesResult {
  ok: boolean
  messages?: ConversationMessageRow[]
  error?: string
}

/**
 * Fetches recent messages for AI short-term memory. conversationId alone
 * is sufficient here (it's already tenant-scoped by construction — a
 * conversation belongs to exactly one tenant), so no tenantId parameter is
 * needed for this read.
 */
export async function getConversationMessages(
  conversationId: string,
): Promise<GetConversationMessagesResult> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    return { ok: false, error: SUPABASE_UNCONFIGURED_ERROR }
  }

  const { data, error } = await supabase
    .from("messages")
    .select("direction, message_text, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(20)

  if (error) {
    return { ok: false, error: error.message }
  }

  const messages: ConversationMessageRow[] = (data ?? []).map((row) => ({
    direction: row.direction as MessageDirection,
    message_text: (row.message_text as string | null) ?? "",
    created_at: row.created_at as string,
  }))

  return { ok: true, messages }
}
