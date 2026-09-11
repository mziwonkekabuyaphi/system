// lib/whatsapp/reply.ts
/**
 * WhatsApp Reply Handler
 * ----------------------
 * The main entry point for processing incoming WhatsApp messages.
 * 
 * RESPONSIBILITIES:
 * 1. Ensure the customer exists in our system (create if not)
 * 2. Load the current conversation state for the user
 * 3. Route the message to the appropriate handler via action-router
 * 4. Save any new state after processing
 * 5. Handle errors gracefully with a fallback reply
 * 
 * This file is the bridge between the raw WhatsApp webhook and our
 * business logic. It doesn't know about specific intents or actions -
 * that's handled by action-router.ts.
 */

import { type RoutedIntent } from "@/lib/whatsapp/intent-router"
import { type IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { routeAction } from "@/lib/whatsapp/action-router"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import { stateService } from "@/lib/services/state"
import { ensureCustomer } from "@/lib/services/customer"
import { routeIntent } from "@/lib/whatsapp/intent-router"

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * FALLBACK_REPLY
 * --------------
 * The default reply sent when something goes wrong during processing.
 * This ensures users always get a response, even if we hit an error.
 */
const FALLBACK_REPLY: ActionResult = {
  reply: "Siyaxolisa, something went wrong on our end. Please try again in a moment.",
  buttons: [],
  nextState: null,
}

/**
 * ActionResult plus the raw intent classification that produced it.
 * Surfaced so the webhook route can make an informed handover/escalation
 * decision using the actual RoutedIntent + confidence, instead of
 * re-guessing from the reply text with a regex.
 *
 * CAVEAT: `intent === "support"` is NOT by itself a "customer wants a
 * human" signal. checkGreetingOrThanks() in intent-router.ts also maps a
 * plain "thanks" to `support` at confidence 1, since "support" is the
 * general assistance bucket, not a dedicated "escalate to human" bucket.
 * Use `intentReasoning` or, better, have action-router's support handler
 * make the final escalation call itself (it already sees the raw message
 * text and can distinguish "thanks" from "let me talk to a manager").
 *
 * `unhandled` mirrors ActionResult.unhandled (see action-router.ts):
 * true only for the two genuine "we don't know what to do with this"
 * replies (UNKNOWN_STATE_REPLY, buildUnknownIntentReply). Every other
 * ActionResult — including ones produced alongside a low intent-router
 * confidence score, which is common and does NOT mean the reply was
 * bad — leaves this undefined/false. The webhook route uses this,
 * combined with confidence, to avoid discarding a perfectly good
 * deterministic reply just because classification alongside it was
 * unsure of itself.
 */
export interface ProcessedMessageResult extends ActionResult {
  intent?: RoutedIntent["intent"]
  intentConfidence?: number
  intentReasoning?: string
  unhandled?: boolean
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Adapts our normalized IncomingMessage into the shape routeIntent expects.
 *
 * IMPORTANT: "button" and "interactive" WhatsApp types are NOT media
 * captions. They must be routed through `buttonText`, not `caption` —
 * intent-router.ts hardcodes the `[button reply]` prefix (the one format
 * SYSTEM_PROMPT's MESSAGE TYPES section actually teaches the model) only
 * for `buttonText`. Anything sent through `caption` instead gets labeled
 * with the raw Meta `type` verbatim (e.g. "[interactive message]" or
 * "[button message]"), which the model was never taught to recognize —
 * so a tapped menu button lost its distinctive prefix and, combined with
 * the unrecognized envelope, reliably classified as low-confidence
 * "unknown" even when the label itself (e.g. "🪪 Rands Passport") was an
 * unambiguous signal.
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

// ============================================================================
// MAIN EXPORTED FUNCTION
// ============================================================================

/**
 * processIncomingMessage
 * ----------------------
 * The main entry point for processing any incoming WhatsApp message.
 * 
 * This function is called by the webhook route whenever a new message
 * arrives from WhatsApp.
 * 
 * @param message - The parsed incoming message from WhatsApp
 * @returns Promise<ActionResult> - The reply to send back to the user
 * 
 * FLOW:
 * 1. ensureCustomer() - Makes sure we have a customer record for this user
 * 2. stateService.getState() - Loads the user's current conversation state
 * 3. routeIntent() - Classifies the user's intent from the message
 * 4. routeAction() - Routes the message to the appropriate handler
 * 5. stateService.setState() - Save the new state if one is provided
 * 6. Return the result - Send the reply back to the user
 */
export async function processIncomingMessage(message: IncomingMessage): Promise<ProcessedMessageResult> {
  try {
    // STEP 1: Ensure the customer exists in our system
    await ensureCustomer(message.from)

    // STEP 2: Load the user's current conversation state
    const state = await stateService.getState(message.from)

    // STEP 3: Classify the user's intent from the message
    const intent = await routeIntent(toIntentRouterMessage(message))

    // STEP 4: Route the message to the appropriate handler
    // ✅ FIX: routeAction expects (intent, state, message) - note the order!
    const result = await routeAction(intent, state, message)

    // STEP 5: Save the new state if there is one — and just as
    // importantly, CLEAR it when there isn't. A null nextState means the
    // owning service has decided the flow is over (booking confirmed,
    // tab balance shown, an error bailed out, etc.) — it does not mean
    // "leave whatever was there before." Previously this only handled the
    // truthy branch, so every flow that legitimately ends with
    // nextState: null left the customer's PREVIOUS state (e.g.
    // "vvip_awaiting_final_confirmation") stuck in Supabase indefinitely.
    // The next unrelated message would then be misread as still being
    // mid-flow, with no guard in action-router.ts recognizing it (since
    // the guards are keyed to specific states/replies), and get routed as
    // a "genuinely new intent" — which is how a "Check My Tab" tap after
    // a completed booking could end up handled by walletService instead
    // of vvipService.
    if (result.nextState) {
      await stateService.setState(message.from, result.nextState)
    } else {
      await stateService.clearState(message.from)
    }

    // STEP 6: Return the result, with the intent classification attached
    // so the webhook route can make an informed handover decision (see
    // ProcessedMessageResult's caveat above about "support" != "escalate").
    return {
      ...result,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      intentReasoning: intent.reasoning,
    }

  } catch (error) {
    // STEP 7: Handle errors gracefully
    console.error("[reply] Error processing message:", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      messageFrom: message.from,
      messageContent: message.text || message.contentSummary,
    })

    return FALLBACK_REPLY
  }
}

// ============================================================================
// ADDITIONAL EXPORTS (Optional helpers)
// ============================================================================

/**
 * processWithState
 * -----------------
 * A utility function that processes a message with a known intent and state.
 * Useful when you already have the intent and state loaded and want to avoid
 * fetching them again.
 * 
 * @param message - The incoming message
 * @param intent - The pre-classified intent
 * @param state - The current conversation state (or null)
 * @returns Promise<ActionResult>
 */
export async function processWithState(
  message: IncomingMessage,
  intent: RoutedIntent,
  state: ConversationState | null
): Promise<ActionResult> {
  try {
    // Ensure customer exists
    await ensureCustomer(message.from)

    // Route the action using the provided intent and state
    // ✅ FIX: routeAction expects (intent, state, message)
    const result = await routeAction(intent, state, message)

    // Save the new state if there is one — clear it otherwise (see the
    // matching comment in processIncomingMessage above for why this can't
    // just skip the null case).
    if (result.nextState) {
      await stateService.setState(message.from, result.nextState)
    } else {
      await stateService.clearState(message.from)
    }

    return result
  } catch (error) {
    console.error("[reply] Error processing message with state:", {
      error: error instanceof Error ? error.message : "Unknown error",
      messageFrom: message.from,
    })
    return FALLBACK_REPLY
  }
}

/**
 * clearUserState
 * ---------------
 * Utility function to clear a user's conversation state.
 * Useful for:
 * - Resetting a conversation when the user says "start over"
 * - Cleaning up after a completed transaction
 * - Admin tools to reset problematic states
 * 
 * @param userId - The user's phone number or ID
 * @returns Promise<void>
 */
export async function clearUserState(userId: string): Promise<void> {
  try {
    await stateService.clearState(userId)
    console.log("[reply] Cleared state for user:", userId)
  } catch (error) {
    console.error("[reply] Error clearing state:", {
      userId,
      error: error instanceof Error ? error.message : "Unknown error",
    })
    throw error
  }
}

// ============================================================================
// END OF FILE
// ============================================================================
