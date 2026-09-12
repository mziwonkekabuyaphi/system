// lib/whatsapp/action-router.ts
/**
 * QLess Action Router — booking/queue only, tenant-scoped.
 * -----------------------------------------------------------
 * Stripped down from Rands Cape Town's original ten-service concierge
 * router (wallet, passport, events, tickets, orders, vvip, shisha,
 * support, registration, booking) to the two services QLess actually
 * ships: bookingService and queueService. That decision — QLess is
 * booking/queue only, Rands' nightclub concierge features are NOT part
 * of this product — was explicit, not inferred; see the conversation
 * this file's rewrite came out of if that scope ever needs revisiting.
 *
 * Still a PURE DISPATCHER — no business logic here, same rule as the
 * original. What changed structurally:
 *   1. Every function now takes `tenantId` as its first argument and
 *      threads it to state/customer/service calls (this file previously
 *      had NO tenant awareness at all — see the multi-tenant summary
 *      this rewrite came out of).
 *   2. queueService is now registered in `stateHandlers`. It wasn't
 *      before — queue.ts exports a conforming `handleState`, but nothing
 *      ever called it, so a customer mid-queue-selection whose reply
 *      didn't match anything else would fall through to
 *      UNKNOWN_STATE_REPLY instead of reaching queueService. Adding it
 *      here fixes that; it was never a multi-tenancy issue on its own.
 *   3. All Rands-only logic is gone: the services-menu row maps
 *      (SERVICE_ROW_INTENTS/PASSPORT_ROW_INTENTS/PASSPORT_ROW_DIRECT_
 *      HANDLERS), venue-hours gating (ON_PREMISE_ONLY_INTENTS), and every
 *      flow-specific "is this reply answering THIS prompt, not switching
 *      intents" guard (payment-method/ticket-menu/shisha/vvip prompts).
 *      None of it has an equivalent in booking/queue — there's exactly
 *      one real intent ("booking") and two state prefixes
 *      ("booking_"/"queue_"), so the "is this a genuinely new intent"
 *      check below is far simpler than the original's.
 *
 * Dependency direction (unchanged): WhatsApp → Intent Router → Action
 * Router → Services → Supabase.
 */

import type { RoutedIntent, Intent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { bookingService } from "@/lib/services/booking"
import { queueService } from "@/lib/services/queue"

import { stateService, type ConversationState } from "@/lib/services/state"
import { getCustomer, type TenantCustomer } from "@/lib/services/tenant-customer"

/**
 * Contract each service must implement to participate in stateful
 * conversations. Same shape as before, with `tenantId` added — a service
 * inspects `state.state` and either returns an ActionResult (it owns this
 * state) or null (defer to the next service in `stateHandlers`).
 */
export interface StatefulService {
  handleState(
    tenantId: string,
    state: ConversationState,
    message: IncomingMessage,
  ): ActionResult | null | Promise<ActionResult | null>
}

export interface IntentService {
  intent: string
  handle(tenantId: string, intent: RoutedIntent, message: IncomingMessage): ActionResult | Promise<ActionResult>
}

// queueService is listed AFTER bookingService: a customer only ever
// enters a queue_* state via booking.ts's handleEntryChoice, so booking
// gets first refusal on every state name, same "try each service in
// order" contract as before.
const stateHandlers: StatefulService[] = [bookingService, queueService]

const intentHandlers: Record<string, IntentService["handle"]> = {
  booking: bookingService.handleBooking.bind(bookingService),
}

// `unhandled: true` marks this as a genuine "we don't know what to do"
// reply — handover.ts's shouldEscalate() uses this flag, not raw intent
// confidence alone, before treating low confidence as a reason to
// escalate to a human.
const UNKNOWN_STATE_REPLY: ActionResult = {
  reply: "I couldn't continue your previous request, so let's start again. How can I help you today?",
  buttons: [],
  nextState: null,
  unhandled: true,
}

/**
 * Words/phrases that always break out of an in-progress flow, regardless
 * of which service owns the current state. Matched with `.includes()`
 * against the raw trimmed/lowercased text — unchanged from the original.
 */
const GLOBAL_INTERRUPT_KEYWORDS = ["cancel", "menu", "main menu", "start over", "restart", "stop"]

/**
 * Maps a state name to the intent that owns it. With only one real
 * intent left ("booking"), this only needs to recognize the two prefixes
 * booking.ts and queue.ts actually use — both belong to the same
 * customer-facing flow, so both resolve to "booking".
 */
function resolveOwningIntent(stateName: string): Intent | null {
  if (stateName.startsWith("booking_")) return "booking" as Intent
  if (stateName.startsWith("queue_")) return "booking" as Intent
  return null
}

/**
 * First name for greeting purposes. tenant_customers.full_name is one
 * field (not profiles' separate name/surname), so this is just "take the
 * first word" — falls back to "there" for a brand-new or nameless
 * customer, same as the original's intent.
 */
function firstNameFromCustomer(customer: TenantCustomer | null): string {
  if (!customer?.name) return "there"
  return customer.name.trim().split(/\s+/)[0] || "there"
}

/**
 * Fires on a fresh conversation, an explicit cancel, or any message the
 * intent classifier can't map to "booking" — which, since booking is the
 * only thing this bot does, all collapse into the same good answer:
 * greet them (personalized if we know their name) and hand straight to
 * bookingService's own entry-choice prompt ("book a time" vs "join the
 * queue"), rather than maintaining a separate services-menu reply the
 * way the ten-service Rands router needed to.
 */
async function buildEntryReply(tenantId: string, message: IncomingMessage, greet: boolean): Promise<ActionResult> {
  const entry = await bookingService.handleBooking(
    tenantId,
    { intent: "booking", confidence: 1 } as RoutedIntent,
    message,
  )

  if (!greet) return entry

  let customer: TenantCustomer | null = null
  try {
    customer = await getCustomer(tenantId, message.from)
  } catch (error) {
    // Best-effort personalization only — getCustomer throwing (a genuine
    // DB error, not "not found," which returns null) must never break
    // the greeting itself.
    console.error("[action-router] getCustomer lookup failed for greeting:", error)
  }

  const firstName = firstNameFromCustomer(customer)
  return {
    ...entry,
    reply: `Hey ${firstName}! 👋\n\n${entry.reply}`,
  }
}

/**
 * Asks each registered service, in order, whether it owns the given
 * conversation state. First non-null response wins. If nobody claims it,
 * the state is stale/corrupt — clear it and restart politely.
 */
async function delegateState(
  tenantId: string,
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult> {
  for (const service of stateHandlers) {
    const result = await service.handleState(tenantId, state, message)
    if (result) return result
  }

  await stateService.clearState(tenantId, message.from)
  return UNKNOWN_STATE_REPLY
}

export async function routeAction(
  tenantId: string,
  intent: RoutedIntent,
  state: ConversationState | null,
  message: IncomingMessage,
): Promise<ActionResult> {
  // ── GLOBAL INTERRUPTS (checked before state routing) ───────────────
  if (state) {
    const text = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
    const isExplicitCancel = GLOBAL_INTERRUPT_KEYWORDS.some((keyword) => text.includes(keyword))

    if (isExplicitCancel) {
      await stateService.clearState(tenantId, message.from)
      return buildEntryReply(tenantId, message, false)
    }

    // A button tap is always answering whatever prompt the active flow
    // just showed — never let raw classification override that.
    const isButtonReply = Boolean(message.interactiveId)

    const owningIntent = resolveOwningIntent(state.state)
    const isGenuinelyNewIntent =
      !isButtonReply &&
      !!intent?.intent &&
      !!intentHandlers[intent.intent] &&
      owningIntent !== null &&
      intent.intent !== owningIntent

    if (isGenuinelyNewIntent) {
      await stateService.clearState(tenantId, message.from)
      return intentHandlers[intent.intent](tenantId, intent, message)
    }

    return delegateState(tenantId, state, message)
  }

  // ── INTENT ROUTING ────────────────────────────────────────────────
  const handler = intent?.intent ? intentHandlers[intent.intent] : undefined
  if (!handler) return buildEntryReply(tenantId, message, true)

  return handler(tenantId, intent, message)
}
