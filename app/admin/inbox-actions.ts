"use server"

/**
 * Server Actions for the admin Inbox tab.
 *
 * Access protection: same as actions.ts — requireTenantMember() first,
 * tenantId stamped on every insert and used to scope every
 * read/update, so one tenant's admin can't read or act on another
 * tenant's conversations/messages even by guessing a UUID or a phone
 * number that happens to collide across tenants.
 *
 * NOTE: requireTenantMember() is always called BEFORE the try/catch in
 * each action below, never inside it. It redirects (via Next's
 * redirect(), which throws internally) when there's no session or no
 * active membership — if that throw happened inside a try/catch here,
 * the catch would swallow it and return a generic error instead of
 * actually redirecting to /login.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"

import type { AdminMessage } from "./types"

type ActionResult = { success: true } | { success: false; error: string }
type ThreadResult = { success: true; messages: AdminMessage[] } | { success: false; error: string }

function client() {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase is not configured (missing env vars)")
  return supabase
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export async function getConversationThread(conversationId: string): Promise<ThreadResult> {
  const { tenantId } = await requireTenantMember()

  try {
    const supabase = client()
    const { data, error } = await supabase
      .from("messages")
      .select("id, direction, message_text, created_at")
      .eq("conversation_id", conversationId)
      .eq("tenant_id", tenantId) // can't read another tenant's thread by guessing a conversationId
      .order("created_at", { ascending: true })
      .limit(200)

    if (error) throw new Error(error.message)

    const messages: AdminMessage[] = (data ?? []).map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.message_text,
      createdAt: m.created_at,
    }))

    return { success: true, messages }
  } catch (error) {
    console.error("[admin] Failed to load conversation thread", { conversationId, error })
    return { success: false, error: errorMessage(error, "Failed to load messages") }
  }
}

/**
 * Sends a message as the human agent: out over WhatsApp, then stored so
 * the thread shows both sides. sendWhatsAppTextMessage resolves this
 * tenant's own phone_number_id + access token via
 * get_tenant_whatsapp_credentials() — see lib/whatsapp/send-message.ts.
 */
export async function sendAgentMessage(conversationId: string, phone: string, body: string): Promise<ActionResult> {
  const { tenantId } = await requireTenantMember()

  const text = body.trim()
  if (!text) return { success: false, error: "Message can't be empty" }

  try {
    await sendWhatsAppTextMessage(tenantId, phone, text)

    const supabase = client()
    const { error } = await supabase.from("messages").insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      meta_message_id: null,
      direction: "outgoing",
      message_type: "text",
      message_text: text,
      recipient_phone: phone,
      raw_payload: { body: text, sentBy: "admin" },
      created_at: new Date().toISOString(),
    })
    if (error) throw new Error(error.message)

    const { error: convError } = await supabase
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("tenant_id", tenantId) // can't touch another tenant's conversation via a guessed id

    if (convError) throw new Error(convError.message)

    revalidatePath("/admin")
    return { success: true }
  } catch (error) {
    console.error("[admin] Failed to send agent message", { conversationId, phone, error })
    return { success: false, error: errorMessage(error, "Failed to send message") }
  }
}

const AI_STATE_BY_ACTION: Record<"pause" | "resume" | "resolve", string> = {
  pause: "paused",
  resume: "active",
  resolve: "resolved",
}

/**
 * conversation_states is uniquely keyed on (tenant_id, phone), not phone
 * alone — the same phone number can belong to different customers at
 * different tenants, so the upsert's onConflict target has to be the
 * composite key, and tenant_id has to be part of the row itself, or this
 * would silently flip another tenant's conversation state for a
 * customer who happens to share a phone number.
 */
export async function setConversationAiState(phone: string, action: "pause" | "resume" | "resolve"): Promise<ActionResult> {
  const { tenantId } = await requireTenantMember()

  try {
    const supabase = client()
    const { error } = await supabase.from("conversation_states").upsert(
      { tenant_id: tenantId, phone, state: AI_STATE_BY_ACTION[action], updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,phone" },
    )

    if (error) throw new Error(error.message)

    revalidatePath("/admin")
    return { success: true }
  } catch (error) {
    console.error("[admin] Failed to set conversation AI state", { phone, action, error })
    return { success: false, error: errorMessage(error, "Failed to update conversation") }
  }
}
