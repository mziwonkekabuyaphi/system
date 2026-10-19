// lib/whatsapp/reply.ts
/**
 * WhatsApp Reply Handler (tenant-scoped)
 * ----------------------------------------
 * Tenant-scoped rewrite of the single-tenant original. `processIncomingMessage`
 * now requires a resolved `tenantId` (see route.ts, which resolves it from
 * the webhook's phone_number_id BEFORE calling this) and threads it through
 * every state/customer call — including, now, `routeAction` itself. That
 * one call was the actual break in the chain: everything upstream of it
 * (ensureCustomer, stateService) was already tenant-scoped, but
 * `routeAction(intent, state, message)` had nowhere to put tenantId until
 * action-router.ts's signature was updated to accept it. See that file's
 * header for the corresponding fix.
 *
 * Uses lib/services/tenant-customer.ts, NOT lib/services/customer.ts — see
 * that file's header for why. This pipeline now only supports booking/queue
 * (action-router.ts's stateHandlers/intentHandlers were stripped down to
 * exactly those two — see that file's header for the scope decision).
 */

import { type RoutedIntent } from "@/lib/whatsapp/intent-router"
import { type IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { routeAction } from "@/lib/whatsapp/action-router"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import { stateService } from "@/lib/services/state"
import { ensureCustomer } from "@/lib/services/tenant-customer"
import { routeIntent } from "@/lib/whatsapp/intent-router"
import { MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"
import { REMINDER_TAP_PATTERN } from "@/lib/services/reminder-reply"
import { WAITLIST_TAP_PATTERN } from "@/lib/services/waitlist-reply"
import { isAiEnabledForTenant } from "@/lib/ai/settings"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

// ---------------------------------------------------------------------------
// AI cost guards
// ---------------------------------------------------------------------------
// routeAction() ignores the classified intent for taps, plain answers and
// state-owned replies, so paying for a classifier call there is pure waste.
const PLAIN_ANSWER = /^(\d{1,3}|y|n|yes|no|yeah|yep|nope|ok|okay|sure|ewe|yebo|ja|hayi|cha|nee)[.!]*$/
const MENU_IDS = new Set<string>(Object.values(MENU_ROW_IDS))
const SKIPPED: RoutedIntent = { intent: "unknown", confidence: 1, reasoning: "Skipped: routed by id/state" }
const MAX_INBOUND_PER_HOUR = 40 // tune

/** True when routeAction will route by id or state and never read the intent. */
function intentIsIrrelevant(message: IncomingMessage, state: ConversationState | null): boolean {
  const id = message.interactiveId
  if (id && (MENU_IDS.has(id) || REMINDER_TAP_PATTERN.test(id) || WAITLIST_TAP_PATTERN.test(id))) return true
  if (id && state) return true // a button/list tap during a flow answers the flow
  const text = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
  return Boolean(state && PLAIN_ANSWER.test(text))
}

/** Per-phone hourly cap, counted from stored inbound messages (works across serverless instances). */
async function aiBudgetExceeded(tenantId: string, phone: string): Promise<boolean> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return false
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("sender_phone", phone)
      .eq("direction", "incoming")
      .gte("created_at", since)
    return (count ?? 0) > MAX_INBOUND_PER_HOUR
  } catch (error) {
    console.error("[reply] AI budget check failed, allowing AI", error)
    return false
  }
}

const FALLBACK_REPLY: ActionResult = {
  reply: "Sorry, something went wrong on our end. Please try again in a moment.",
  buttons: [],
  nextState: null,
}

export interface ProcessedMessageResult extends ActionResult {
  intent?: RoutedIntent["intent"]
  intentConfidence?: number
  intentReasoning?: string
  unhandled?: boolean
}

/**
 * Adapts our normalized IncomingMessage into the shape routeIntent expects.
 * Unchanged from the single-tenant version — message-shape adaptation has
 * no tenant dependency.
 */
function toIntentRouterMessage(message: IncomingMessage) {
  const isButtonType = message.type === "button" || message.type === "interactive"
  return {
    text: message.type === "text" ? message.text : null,
    caption: message.type !== "text" && !isButtonType ? message.contentSummary : null,
    buttonText: isButtonType ? message.contentSummary : null,
    type: message.type,
  }
}

/**
 * processIncomingMessage
 * ----------------------
 * Main entry point for processing an incoming WhatsApp message, requiring
 * a resolved tenantId as the caller's responsibility (route.ts resolves it
 * once per message, before this is called, so a resolution failure never
 * gets this far).
 *
 * FLOW:
 * 1. ensureCustomer(tenantId, phone) - tenant_customers row for this sender
 * 2. stateService.getState(tenantId, phone) - this tenant's conversation state
 * 3. routeIntent() - classify the message (tenant-agnostic)
 * 4. routeAction(tenantId, ...) - route to the appropriate handler
 * 5. stateService.setState/clearState(tenantId, phone, ...) - persist result
 * 6. Return the result
 */
export async function processIncomingMessage(
  tenantId: string,
  message: IncomingMessage,
): Promise<ProcessedMessageResult> {
  try {
    // STEP 1: Ensure a tenant_customers row exists for this sender.
    await ensureCustomer(tenantId, message.from)

    // STEP 2: Load this tenant's conversation state for this phone.
    const state = await stateService.getState(tenantId, message.from)

    // STEP 3: Classify the user's intent from the message.
    // Skip the model entirely when the result would be ignored, when the shop
    // has AI off, while the customer is typing their name, or over the hourly cap.
    const skip = intentIsIrrelevant(message, state)
    const inNameStep = state?.state === "booking_awaiting_name" && !(message.text ?? "").includes("?")
    const allowAi =
      !skip &&
      !inNameStep &&
      (await isAiEnabledForTenant(tenantId)) &&
      !(await aiBudgetExceeded(tenantId, message.from))

    const intent = skip
      ? SKIPPED
      : await routeIntent(toIntentRouterMessage(message), undefined, { allowAi })

    // STEP 4: Route the message to the appropriate handler.
    const result = await routeAction(tenantId, intent, state, message)

    // STEP 5: Save or clear the new state — a completed flow must clear
    // state, not leave the previous in-flight state stuck.
    if (result.nextState) {
      await stateService.setState(tenantId, message.from, result.nextState)
    } else {
      await stateService.clearState(tenantId, message.from)
    }

    return {
      ...result,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      intentReasoning: intent.reasoning,
    }
  } catch (error) {
    console.error("[reply] Error processing message:", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      tenantId,
      messageFrom: message.from,
      messageContent: message.text || message.contentSummary,
    })

    return FALLBACK_REPLY
  }
}

/**
 * processWithState
 * -----------------
 * Same as processIncomingMessage, for a caller that already has
 * intent/state loaded and wants to avoid re-fetching.
 */
export async function processWithState(
  tenantId: string,
  message: IncomingMessage,
  intent: RoutedIntent,
  state: ConversationState | null,
): Promise<ActionResult> {
  try {
    await ensureCustomer(tenantId, message.from)

    const result = await routeAction(tenantId, intent, state, message)

    if (result.nextState) {
      await stateService.setState(tenantId, message.from, result.nextState)
    } else {
      await stateService.clearState(tenantId, message.from)
    }

    return result
  } catch (error) {
    console.error("[reply] Error processing message with state:", {
      error: error instanceof Error ? error.message : "Unknown error",
      tenantId,
      messageFrom: message.from,
    })
    return FALLBACK_REPLY
  }
}

/**
 * clearUserState
 * ---------------
 * Utility to clear a (tenant, phone) pair's conversation state — e.g. for
 * an admin "reset this conversation" action.
 */
export async function clearUserState(tenantId: string, phone: string): Promise<void> {
  try {
    await stateService.clearState(tenantId, phone)
    console.log("[reply] Cleared state for user:", { tenantId, phone })
  } catch (error) {
    console.error("[reply] Error clearing state:", {
      tenantId,
      phone,
      error: error instanceof Error ? error.message : "Unknown error",
    })
    throw error
  }
}
