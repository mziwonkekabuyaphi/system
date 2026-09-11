"use server"

/**
 * Server Actions for the admin Inbox tab.
 *
 * Ported from the old standalone whatsapp-admin.html/admin.js panel, which
 * ran as a separate static page (hosted at mzonke-six.vercel.app) talking
 * to this app over two things:
 *   1. A direct Supabase client in the browser (anon key) for reads.
 *   2. A cross-origin fetch to /api/admin/handover (with an x-admin-secret
 *      header) for the one write conversation_states' service-role-only
 *      RLS policy required.
 *
 * Now that the admin view lives inside this same Next.js app, both
 * collapse into ordinary Server Actions — no anon key, no CORS headers,
 * no shared secret. getConversationThread is a *read*, but it's still a
 * Server Action (not a query in page.tsx) because it's fetched on demand
 * when the owner taps a conversation, not up front with the rest of the
 * page.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/server"
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
  try {
    const supabase = client()
    const { data, error } = await supabase
      .from("messages")
      .select("id, direction, message_text, created_at")
      .eq("conversation_id", conversationId)
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
 * the thread shows both sides. Mirrors store.ts's storeOutboundMessage —
 * waMessageId is always null here (sendWhatsAppTextMessage doesn't parse
 * Meta's response for one), same as every other outbound send in this
 * app; meta_message_id's uniqueness constraint only matters for inbound
 * de-duplication, so multiple NULLs here are fine.
 */
export async function sendAgentMessage(conversationId: string, phone: string, body: string): Promise<ActionResult> {
  const text = body.trim()
  if (!text) return { success: false, error: "Message can't be empty" }

  try {
    await sendWhatsAppTextMessage(phone, text)

    const supabase = client()
    const { error } = await supabase.from("messages").insert({
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

    await supabase
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId)

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
 * Replaces the old /api/admin/handover route: same three actions
 * (pause/resume/resolve), same conversation_states upsert, just called
 * directly instead of over a cross-origin fetch with a shared secret.
 */
export async function setConversationAiState(phone: string, action: "pause" | "resume" | "resolve"): Promise<ActionResult> {
  try {
    const supabase = client()
    const { error } = await supabase
      .from("conversation_states")
      .upsert({ phone, state: AI_STATE_BY_ACTION[action], updated_at: new Date().toISOString() }, { onConflict: "phone" })

    if (error) throw new Error(error.message)

    revalidatePath("/admin")
    return { success: true }
  } catch (error) {
    console.error("[admin] Failed to set conversation AI state", { phone, action, error })
    return { success: false, error: errorMessage(error, "Failed to update conversation") }
  }
}
