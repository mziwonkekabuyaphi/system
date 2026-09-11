// app/api/webhook/route.ts
/**
 * Meta WhatsApp Cloud API webhook.
 * --------------------------------
 * This is the ONLY entry point Meta's servers talk to. Two responsibilities:
 *
 *   GET  — answers Meta's one-time webhook verification handshake
 *          (checks hub.verify_token, echoes back hub.challenge).
 *   POST — receives inbound message events, classifies intent, builds a
 *          reply, and sends it back via the WhatsApp Cloud API.
 *
 * Everything else — parsing, intent classification, routing, state,
 * business logic — lives in lib/whatsapp/* and lib/services/*. This file
 * is deliberately thin: parse -> classify -> reply -> send, wrapped in
 * defensive error handling so a single bad message can never take the
 * whole webhook down or cause Meta to see anything other than a 200.
 *
 * IMPORTANT: this always returns 200 to Meta, even when something inside
 * fails. Meta retries aggressively on non-200 responses, and a transient
 * bug here should not trigger a retry storm — errors are logged instead.
 *
 * HANDOVER: before routing to the AI, we check conversation_states for this
 * phone. If a human has taken over (via the admin panel) or a prior message
 * already escalated this conversation, we skip AI processing entirely and
 * just leave the stored inbound message for the agent to see in the panel.
 * processIncomingMessage does its own customer/state/routing work, but does
 * NOT gate on conversation_states itself — this check is the only place
 * that happens, so it's load-bearing, not a redundant safety net.
 */
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { parseIncomingMessages, type IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { processIncomingMessage } from "@/lib/whatsapp/reply"
import {
  sendWhatsAppTextMessage,
  sendWhatsAppButtonsMessage,
  sendWhatsAppImageMessage,
  sendWhatsAppListMessage,
} from "@/lib/whatsapp/send-message"
import { storeIncomingMessage, storeOutboundMessage } from "@/lib/whatsapp/store"
import { isAIEnabled, shouldEscalate, escalateToHumanAndNotify } from "@/lib/handover"

export const runtime = "nodejs"

// Service-role client for server-side reads/writes to conversation_states.
// If you already export a shared client elsewhere (e.g. lib/supabase.ts),
// swap this for that import instead of instantiating a second one.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// NOTE: this file previously also imported `routeIntent` and defined its
// own local `toIntentRouterMessage` adapter, left over from before
// `processIncomingMessage` existed. Neither was called anywhere in this
// file — classification already happens inside processIncomingMessage via
// reply.ts's own adapter. Removed as dead code: it silently reproduced the
// same caption-vs-buttonText mislabeling bug fixed in reply.ts, and would
// have been a landmine if anyone wired it back up later.

/**
 * Meta's one-time (and occasionally repeated) webhook verification check.
 * Must echo back `hub.challenge` as plain text when the mode/token match
 * what's configured in the Meta App Dashboard.
 */
export async function GET(request: Request): Promise<NextResponse | Response> {
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim()

  if (mode === "subscribe" && expectedToken && token === expectedToken && challenge) {
    console.log("[webhook] Verification succeeded")
    return new Response(challenge, { status: 200 })
  }

  console.error("[webhook] Verification failed", { mode, tokenMatches: token === expectedToken })
  return NextResponse.json({ error: "Verification failed" }, { status: 403 })
}

/**
 * Handles inbound WhatsApp events. Processes every message in the payload
 * (Meta can batch multiple messages into one webhook call), sending a
 * reply for each one that produces one.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown

  try {
    payload = await request.json()
  } catch (error) {
    console.error("[webhook] Failed to parse request body as JSON", error)
    // Still 200 — a malformed payload isn't something Meta should retry.
    return NextResponse.json({ received: true })
  }

  const messages = parseIncomingMessages(payload)

  for (const message of messages) {
    // Persist the inbound message first, independently of whether
    // processing succeeds below — we want a DB record that the message
    // arrived even if routing/AI logic later throws. A duplicate (Meta
    // retry) is reported via `duplicate: true`, not an error, so this is
    // safe to call on every delivery attempt.
    const stored = await storeIncomingMessage(message)
    if (!stored.ok) {
      console.error("[webhook] Failed to store incoming message", {
        waMessageId: message.waMessageId,
        from: message.from,
        error: stored.error,
      })
    }

    // ─── HANDOVER GATE ───
    // If a human owns this conversation (agent took over via the admin
    // panel, or a prior message already escalated it), skip AI processing
    // entirely. The message is already stored above, so it shows up in the
    // admin panel via realtime — the agent replies from there, not here.
    try {
      const aiEnabled = await isAIEnabled(supabase, message.from)
      if (!aiEnabled) {
        console.log("[webhook] Skipping AI — human owns this conversation", { from: message.from })
        continue
      }
    } catch (gateError) {
      // Fail open: if the gate check itself errors, don't strand the
      // customer with silence — fall through to normal AI processing.
      console.error("[webhook] Handover gate check failed, defaulting to AI ON", {
        from: message.from,
        error: gateError instanceof Error ? gateError.message : "Unknown error",
      })
    }

    try {
      // processIncomingMessage handles everything: customer check, state loading, routing
      const result = await processIncomingMessage(message)

      // ─── ESCALATION CHECK ───
      // Uses the real intent classification from reply.ts/intent-router.ts:
      // explicit human-request phrases in the raw message text, or a
      // genuinely low classification confidence (< 0.5, intent-router's
      // own LOW_CONFIDENCE_FLOOR) COMBINED with `result.unhandled` — i.e.
      // action-router.ts itself couldn't map the message to anything, not
      // just "the classifier wasn't fully sure" alongside an otherwise
      // good, deterministic reply. See handover.ts's shouldEscalate for
      // the full rationale; this used to fire on confidence alone, which
      // discarded good replies and re-armed the handoff timer on ordinary
      // low-confidence-but-handled-fine messages.
      const messageText = message.type === "text" ? message.text : message.contentSummary
      const escalate = shouldEscalate({
        userMessage: messageText ?? undefined,
        aiResponse: result.reply,
        intentConfidence: result.intentConfidence,
        unhandled: result.unhandled,
      })

      if (escalate) {
        console.log("[webhook] Escalating to human", {
          from: message.from,
          intent: result.intent,
          intentConfidence: result.intentConfidence,
          intentReasoning: result.intentReasoning,
          unhandled: result.unhandled,
        })
        const teamPhones = (process.env.TEAM_NOTIFICATION_PHONES ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)

        await escalateToHumanAndNotify(supabase, message.from, "ai_low_confidence_or_explicit_request", {
          teamPhones,
          sendWhatsAppTextMessage,
        })

        const handoffText = "I'm looping in a team member to help with this — they'll be with you shortly."
        await sendWhatsAppTextMessage(message.from, handoffText)

        if (stored.ok && stored.conversationId) {
          const handoffStore = await storeOutboundMessage(stored.conversationId, handoffText, null)
          if (!handoffStore.ok) {
            console.error("[webhook] Failed to store handoff message", {
              waMessageId: message.waMessageId,
              from: message.from,
              error: handoffStore.error,
            })
          }
        }

        // Skip the normal reply/media/follow-up send for this message —
        // a human is taking it from here.
        continue
      }

      // Send the reply based on whether we have buttons or not
      if (result.buttons && result.buttons.length > 0) {
        await sendWhatsAppButtonsMessage(
          message.from,
          result.reply,
          result.buttons
        )
      } else {
        await sendWhatsAppTextMessage(
          message.from,
          result.reply
        )
      }

      // Record the outbound reply so the conversation history is two-sided.
      // Best-effort: a failure here is logged but must never affect what
      // Meta sees for this webhook call.
      // NOTE: sendWhatsApp*Message's return shape isn't available in this
      // file — if it returns Meta's outbound message id, thread it through
      // here instead of `null` so storeOutboundMessage can de-dupe on it.
      if (stored.ok && stored.conversationId) {
        const outboundStore = await storeOutboundMessage(
          stored.conversationId,
          result.reply,
          null
        )
        if (!outboundStore.ok) {
          console.error("[webhook] Failed to store outbound message", {
            waMessageId: message.waMessageId,
            from: message.from,
            error: outboundStore.error,
          })
        }
      }

      // If this result carries images (e.g. ticket QR codes), send each one
      // as a follow-up message. Sent after the text/buttons reply so the
      // customer sees the confirmation copy first, then the QR codes right
      // below it. A multi-ticket purchase carries one entry per ticket, so
      // every attendee gets their own scannable QR. A failure on one image
      // is logged but doesn't stop the others, the text reply already sent,
      // or the rest of this message batch — the customer still has their
      // ticket IDs/references even if an image never arrives.
      if (result.media) {
        for (const media of result.media) {
          try {
            await sendWhatsAppImageMessage(message.from, media.url, media.caption)
          } catch (mediaError) {
            console.error("[webhook] Error sending media reply", {
              waMessageId: message.waMessageId,
              from: message.from,
              mediaUrl: media.url,
              error: mediaError instanceof Error ? mediaError.message : "Unknown error",
            })
          }
        }
      }

      // If this result carries follow-up text (e.g. the services menu sent
      // right after a personalized greeting — see buildUnknownIntentReply
      // in action-router.ts), send each as its own message, in order, after
      // the primary reply and any media. Same defensive pattern as the
      // media loop above: one follow-up failing to send is logged but must
      // never stop the rest of the batch, and the customer still has the
      // primary reply either way.
      if (result.followUp) {
        for (const followUp of result.followUp) {
          try {
            if (followUp.list) {
              await sendWhatsAppListMessage(
                message.from,
                followUp.reply,
                followUp.list.buttonText,
                followUp.list.sections
              )
            } else if (followUp.buttons && followUp.buttons.length > 0) {
              await sendWhatsAppButtonsMessage(message.from, followUp.reply, followUp.buttons)
            } else {
              await sendWhatsAppTextMessage(message.from, followUp.reply)
            }

            if (stored.ok && stored.conversationId) {
              const followUpStore = await storeOutboundMessage(
                stored.conversationId,
                followUp.reply,
                null
              )
              if (!followUpStore.ok) {
                console.error("[webhook] Failed to store follow-up outbound message", {
                  waMessageId: message.waMessageId,
                  from: message.from,
                  error: followUpStore.error,
                })
              }
            }
          } catch (followUpError) {
            console.error("[webhook] Error sending follow-up reply", {
              waMessageId: message.waMessageId,
              from: message.from,
              error: followUpError instanceof Error ? followUpError.message : "Unknown error",
            })
          }
        }
      }
    } catch (error) {
      // One message failing must never stop the others in this batch, or
      // affect what Meta sees for the webhook call as a whole.
      console.error("[webhook] Error processing message", {
        waMessageId: message.waMessageId,
        from: message.from,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    }
  }

  return NextResponse.json({ received: true })
}
