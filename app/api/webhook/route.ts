// app/api/webhook/route.ts
/**
 * Meta WhatsApp Cloud API webhook (multi-tenant).
 * ---------------------------------------------------
 * Tenant-scoped rewrite of the single-tenant original. The critical new
 * step is TENANT RESOLUTION: every inbound message carries Meta's
 * `phone_number_id` (which WhatsApp Business number it arrived on, parsed
 * by parse-webhook.ts into `message.phoneNumberId`). Before any other
 * processing happens, that's resolved to a tenant via the live
 * `whatsapp_resolve_tenant_id(p_phone_number_id)` Postgres function
 * already deployed on this project (see phase1_whatsapp_tenant_resolution_
 * function migration) — NOT reimplemented here, to avoid two sources of
 * truth for tenant resolution logic.
 *
 * A message that can't be resolved to a tenant (unknown/inactive
 * phone_number_id) is logged and skipped entirely — it is NOT stored,
 * since messages.tenant_id is NOT NULL and there's nothing valid to put
 * there. Still always returns 200 to Meta regardless.
 *
 * ⚠️ NOT YET DONE: sendWhatsAppTextMessage/ButtonsMessage/etc (imported
 * from send-message.ts below) still use ONE GLOBAL WHATSAPP_ACCESS_TOKEN /
 * WHATSAPP_PHONE_NUMBER_ID env var pair, not the resolved tenant's own
 * credentials from tenant_whatsapp_integrations (token lives in Supabase
 * Vault, referenced via access_token_secret_id). Tenant resolution now
 * correctly identifies WHICH shop a message belongs to and scopes all
 * reads/writes/state to it — but every outbound send still goes out
 * through whichever single WhatsApp number the env vars point at,
 * regardless of tenant. This works fine for developing against ONE tenant
 * (e.g. the seeded "Test Venue"), but is not yet correct for two tenants
 * live at once. send-message.ts needs a per-tenant credential lookup next.
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

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
 * Resolves a Meta phone_number_id to an active tenant_id via the platform's
 * own whatsapp_resolve_tenant_id() function. Returns null (never throws)
 * on missing phoneNumberId, an RPC error, or no matching active tenant —
 * every case the caller should treat identically: skip this message.
 */
async function resolveTenantId(phoneNumberId: string | null): Promise<string | null> {
  if (!phoneNumberId) {
    console.error("[webhook] Message carried no phone_number_id, cannot resolve tenant")
    return null
  }

  const { data, error } = await supabase.rpc("whatsapp_resolve_tenant_id", {
    p_phone_number_id: phoneNumberId,
  })

  if (error) {
    console.error("[webhook] whatsapp_resolve_tenant_id RPC failed", { phoneNumberId, error: error.message })
    return null
  }

  if (!data) {
    console.error("[webhook] No active tenant found for phone_number_id", { phoneNumberId })
    return null
  }

  return data as string
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown

  try {
    payload = await request.json()
  } catch (error) {
    console.error("[webhook] Failed to parse request body as JSON", error)
    return NextResponse.json({ received: true })
  }

  const messages = parseIncomingMessages(payload)

  for (const message of messages) {
    // ─── TENANT RESOLUTION ───
    // Must happen before anything else — every subsequent step (storage,
    // handover gate, state, reply, escalation) is scoped to this tenant.
    const tenantId = await resolveTenantId(message.phoneNumberId)
    if (!tenantId) {
      // Cannot store, cannot process, cannot reply — there is nothing
      // valid to scope any of that to. Skip entirely; still 200 to Meta.
      continue
    }

    const stored = await storeIncomingMessage(tenantId, message)
    if (!stored.ok) {
      console.error("[webhook] Failed to store incoming message", {
        tenantId,
        waMessageId: message.waMessageId,
        from: message.from,
        error: stored.error,
      })
    }

    // ─── HANDOVER GATE ───
    try {
      const aiEnabled = await isAIEnabled(supabase, tenantId, message.from)
      if (!aiEnabled) {
        console.log("[webhook] Skipping AI — human owns this conversation", { tenantId, from: message.from })
        continue
      }
    } catch (gateError) {
      console.error("[webhook] Handover gate check failed, defaulting to AI ON", {
        tenantId,
        from: message.from,
        error: gateError instanceof Error ? gateError.message : "Unknown error",
      })
    }

    try {
      const result = await processIncomingMessage(tenantId, message)

      const messageText = message.type === "text" ? message.text : message.contentSummary
      const escalate = shouldEscalate({
        userMessage: messageText ?? undefined,
        aiResponse: result.reply,
        intentConfidence: result.intentConfidence,
        unhandled: result.unhandled,
      })

      if (escalate) {
        console.log("[webhook] Escalating to human", {
          tenantId,
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

        await escalateToHumanAndNotify(supabase, tenantId, message.from, "ai_low_confidence_or_explicit_request", {
          teamPhones,
          sendWhatsAppTextMessage,
        })

        const handoffText = "I'm looping in a team member to help with this — they'll be with you shortly."
        await sendWhatsAppTextMessage(message.from, handoffText)

        if (stored.ok && stored.conversationId) {
          const handoffStore = await storeOutboundMessage(tenantId, stored.conversationId, handoffText, null)
          if (!handoffStore.ok) {
            console.error("[webhook] Failed to store handoff message", {
              tenantId,
              waMessageId: message.waMessageId,
              from: message.from,
              error: handoffStore.error,
            })
          }
        }

        continue
      }

      if (result.buttons && result.buttons.length > 0) {
        await sendWhatsAppButtonsMessage(message.from, result.reply, result.buttons)
      } else {
        await sendWhatsAppTextMessage(message.from, result.reply)
      }

      if (stored.ok && stored.conversationId) {
        const outboundStore = await storeOutboundMessage(tenantId, stored.conversationId, result.reply, null)
        if (!outboundStore.ok) {
          console.error("[webhook] Failed to store outbound message", {
            tenantId,
            waMessageId: message.waMessageId,
            from: message.from,
            error: outboundStore.error,
          })
        }
      }

      if (result.media) {
        for (const media of result.media) {
          try {
            await sendWhatsAppImageMessage(message.from, media.url, media.caption)
          } catch (mediaError) {
            console.error("[webhook] Error sending media reply", {
              tenantId,
              waMessageId: message.waMessageId,
              from: message.from,
              mediaUrl: media.url,
              error: mediaError instanceof Error ? mediaError.message : "Unknown error",
            })
          }
        }
      }

      if (result.followUp) {
        for (const followUp of result.followUp) {
          try {
            if (followUp.list) {
              await sendWhatsAppListMessage(message.from, followUp.reply, followUp.list.buttonText, followUp.list.sections)
            } else if (followUp.buttons && followUp.buttons.length > 0) {
              await sendWhatsAppButtonsMessage(message.from, followUp.reply, followUp.buttons)
            } else {
              await sendWhatsAppTextMessage(message.from, followUp.reply)
            }

            if (stored.ok && stored.conversationId) {
              const followUpStore = await storeOutboundMessage(tenantId, stored.conversationId, followUp.reply, null)
              if (!followUpStore.ok) {
                console.error("[webhook] Failed to store follow-up outbound message", {
                  tenantId,
                  waMessageId: message.waMessageId,
                  from: message.from,
                  error: followUpStore.error,
                })
              }
            }
          } catch (followUpError) {
            console.error("[webhook] Error sending follow-up reply", {
              tenantId,
              waMessageId: message.waMessageId,
              from: message.from,
              error: followUpError instanceof Error ? followUpError.message : "Unknown error",
            })
          }
        }
      }
    } catch (error) {
      console.error("[webhook] Error processing message", {
        tenantId,
        waMessageId: message.waMessageId,
        from: message.from,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    }
  }

  return NextResponse.json({ received: true })
}
