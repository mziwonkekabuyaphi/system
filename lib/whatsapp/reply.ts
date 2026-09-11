// lib/whatsapp/reply.ts
/**
 * WhatsApp Reply Handler (tenant-scoped)
 * ----------------------------------------
 * Tenant-scoped rewrite of the single-tenant original. `processIncomingMessage`
 * now requires a resolved `tenantId` (see route.ts, which resolves it from
 * the webhook's phone_number_id BEFORE calling this) and threads it through
 * every state/customer call.
 *
 * Uses lib/services/tenant-customer.ts, NOT lib/services/customer.ts — see
 * that file's header for why.
 *
 * RESOLVED: action-router.ts has been stripped down to only registration,
 * booking, and queue — wallet/passport/events/tickets/orders/vvip/shisha/
 * support are no longer wired into its stateHandlers/intentHandlers for
 * this deployment, so the identity-system mismatch flagged here
 * previously no longer applies. routeAction() now also takes `tenantId`
 * as an explicit fourth argument, threaded through from here.
 */

import { type RoutedIntent } from "@/lib/whatsapp/intent-router"
import { type IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { routeAction } from "@/lib/whatsapp/action-router"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import { stateService } from "@/lib/services/state"
import { ensureCustomer } from "@/lib/services/tenant-customer"
import { routeIntent } from "@/lib/whatsapp/intent-router"

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
 * Main entry point for processing an incoming WhatsApp message, now
 * requiring a resolved tenantId as the caller's responsibility (route.ts
 * resolves it once per message, before this is called, so a resolution
 * failure never gets this far).
 *
 * FLOW:
 * 1. ensureCustomer(tenantId, phone) - tenant_customers row for this sender
 * 2. stateService.getState(tenantId, phone) - this tenant's conversation state
 * 3. routeIntent() - classify the message (tenant-agnostic)
 * 4. routeAction() - route to the appropriate handler
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
    const intent = await routeIntent(toIntentRouterMessage(message))

    // STEP 4: Route the message to the appropriate handler.
    const result = await routeAction(intent, state, message, tenantId)

    // STEP 5: Save or clear the new state — see the single-tenant version's
    // comment for why the null-nextState branch matters (a completed flow
    // must clear state, not leave the previous in-flight state stuck).
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
 * Same as the single-tenant version, now tenant-scoped. Useful when the
 * caller already has intent/state loaded and wants to avoid re-fetching.
 */
export async function processWithState(
  tenantId: string,
  message: IncomingMessage,
  intent: RoutedIntent,
  state: ConversationState | null,
): Promise<ActionResult> {
  try {
    await ensureCustomer(tenantId, message.from)

    const result = await routeAction(intent, state, message, tenantId)

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
