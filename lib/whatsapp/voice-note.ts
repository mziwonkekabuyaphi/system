// lib/whatsapp/voice-note.ts
/**
 * Turns an incoming voice note into a normal text message, so everything downstream (intent routing, the
 * booking / orders / events parsers, escalation) works unchanged.
 * ----------------------------------------------------------------------------
 * Called by the webhook route AFTER the duplicate check and the handover gate and BEFORE
 * processIncomingMessage. It never throws and never escalates: every problem becomes a friendly "please type"
 * reply, because the message is already stored (a crash here would otherwise lose it when Meta retries).
 *
 * What comes back:
 *   { kind: "proceed", message, echo }  -> process `message` as if the customer had typed it, after sending `echo`
 *                                          ("🎙️ I heard: ...") so they can catch a mis-hearing.
 *   { kind: "reply", text }             -> send `text` and stop; do not process the message.
 *
 * Safety rules:
 *   - The transcript becomes text / contentSummary ONLY. interactiveId is always cleared, so a spoken word can
 *     never count as a button tap.
 *   - If the customer is in a confirm / payment / top-up / cancel step, the voice note is NOT acted on: we repeat
 *     what we heard and ask them to tap the button or type it. (See RISKY_STATE; adjust to your state names.)
 *   - Limits: one clip max MAX_SECONDS long, MAX_PER_HOUR voice notes per customer, 3 MB file cap.
 *   - The audio file itself is NOT kept in phase 1, only the transcript (shown in the inbox), which keeps
 *     personal data to a minimum. Replay + retention arrive with phase 2.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { downloadWhatsAppAudio } from "@/lib/whatsapp/media"
import { resolveVoiceAccess, transcribeAudio } from "@/lib/ai/voice-transcription"
import { stateService } from "@/lib/services/state"

const MAX_SECONDS = 90
const MAX_PER_HOUR = 20
const MAX_TRANSCRIPT_CHARS = 1000
const OVERALL_TIMEOUT_MS = 35_000

/** Conversation steps where a spoken "yes" must never confirm anything. Matched against the state name. */
const RISKY_STATE = /confirm|payment|pay_|topup|top_up|cancel/i

const MSG = {
  off: "🎙️ I can't listen to voice notes here yet. Please type your message, or tap *menu*.",
  unclear: "🎙️ I couldn't make that out. Please type your message, or tap *menu*.",
  tooLong: "🎙️ That voice note is a bit long for me. Please keep it under a minute and a half, or type your message.",
  tooMany: "🎙️ I've had a lot of voice notes from you in the last hour. Please type your message, or tap *menu*.",
} as const

export type PreparedVoiceNote =
  | { kind: "proceed"; message: IncomingMessage; echo: string }
  | { kind: "reply"; text: string }

function mediaIdOf(message: IncomingMessage): unknown {
  return (message as unknown as { raw?: { audio?: { id?: unknown } } }).raw?.audio?.id
}

async function prepare(supabase: SupabaseClient, tenantId: string, message: IncomingMessage, conversationId: string | null): Promise<PreparedVoiceNote> {
  // 1. Is this shop allowed to use voice notes at all? (cheap checks first, before any download)
  const access = await resolveVoiceAccess(supabase, tenantId)
  if (!access.ok) return { kind: "reply", text: access.reason === "budget" ? MSG.unclear : MSG.off }

  // 2. Per-customer hourly cap (counted from stored messages, so it works across serverless instances).
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("sender_phone", message.from)
    .eq("direction", "incoming")
    .eq("message_type", "audio")
    .gte("created_at", since)
  if ((count ?? 0) > MAX_PER_HOUR) return { kind: "reply", text: MSG.tooMany }

  // 3. Download.
  const audio = await downloadWhatsAppAudio(tenantId, mediaIdOf(message))
  if (!audio.ok) return { kind: "reply", text: audio.reason === "too_large" ? MSG.tooLong : MSG.unclear }
  if (audio.durationSeconds > MAX_SECONDS) return { kind: "reply", text: MSG.tooLong }

  // 4. Transcribe (and record the cost).
  const result = await transcribeAudio({
    supabase, tenantId, access, bytes: audio.bytes, mimeType: audio.mimeType, seconds: audio.durationSeconds, conversationId,
  })
  if (!result.ok) return { kind: "reply", text: MSG.unclear }
  const transcript = result.text.slice(0, MAX_TRANSCRIPT_CHARS)

  // 5. Show the transcript in the inbox (best effort).
  void supabase
    .from("messages")
    .update({ message_text: transcript })
    .eq("tenant_id", tenantId)
    .eq("meta_message_id", message.waMessageId)
    .then(({ error }) => error && console.error("[voice] could not save transcript", { tenantId, error: error.message }))

  const heard = `🎙️ I heard: “${transcript}”`

  // 6. Never let a spoken word confirm money or a cancellation.
  const state = await stateService.getState(tenantId, message.from).catch(() => null)
  if (state && RISKY_STATE.test(state.state)) {
    return { kind: "reply", text: `${heard}\n\nFor your safety, please confirm by tapping a button or typing your answer.` }
  }

  // 7. Hand it on as an ordinary typed message. interactiveId is cleared on purpose.
  const asText = {
    ...message,
    type: "text",
    text: transcript,
    contentSummary: transcript,
    interactiveId: null,
    viaVoice: true,
  } as unknown as IncomingMessage

  return { kind: "proceed", message: asText, echo: heard }
}

export async function prepareVoiceNote(args: {
  supabase: SupabaseClient
  tenantId: string
  message: IncomingMessage
  conversationId: string | null
}): Promise<PreparedVoiceNote> {
  const { supabase, tenantId, message, conversationId } = args
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<PreparedVoiceNote>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "reply", text: MSG.unclear }), OVERALL_TIMEOUT_MS)
    })
    return await Promise.race([prepare(supabase, tenantId, message, conversationId), timeout])
  } catch (error) {
    console.error("[voice] could not prepare voice note", { tenantId, waMessageId: message.waMessageId, error: error instanceof Error ? error.message : "unknown" })
    return { kind: "reply", text: MSG.unclear }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
