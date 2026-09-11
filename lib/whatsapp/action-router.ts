/**
 * QLess WhatsApp Action Router (tenant-scoped)
 * -----------------------------------------
 * Routes intents (and in-progress conversation state) to the appropriate
 * service handlers, for the multi-tenant salon/barbershop deployment.
 *
 * STRIPPED DOWN from the original Rands single-tenant router by explicit
 * decision: walletService, passportService, eventsService, ticketsService,
 * ordersService, vvipService, shishaService, and supportService are all
 * removed. They're built around lib/services/customer.ts's
 * profiles/wallet identity system, not tenant_customers, and reply.ts's
 * own file header already flagged that wiring them into this pipeline
 * would break them. If any of those come back for a future QLess module,
 * they'll need their own tenant_id-aware rewrite first — this file no
 * longer imports or references them.
 *
 * TENANT-SCOPED: every function here now threads a `tenantId` parameter
 * through to state lookups/mutations and to each service — matching
 * reply.ts, tenant-customer.ts, and conversation_states, all of which are
 * keyed on (tenant_id, phone) rather than phone alone.
 *
 * This is still a PURE DISPATCHER — it does NOT contain business logic,
 * validation, or knowledge of any specific conversation state. All of
 * that lives inside the services themselves. The router's only job is to
 * decide *which* service gets first refusal at handling a given message,
 * then hand off.
 *
 * Dependency direction (never reversed):
 *   WhatsApp → Intent Router → Action Router → Services → Supabase
 *
 * ASSUMPTION (flagging, unverified): `queueService` is imported from
 * `@/lib/services/queue` and shaped like `bookingService` — a
 * `StatefulService` for its `queue_*` conversation states, plus an
 * `IntentService`-style `handleQueue(intent, message, tenantId)` for a
 * fresh "queue" intent. I don't have queue.ts's actual content in this
 * conversation (only registration.ts and this file's dependencies were
 * uploaded), so the export names/shape below are a best guess mirroring
 * bookingService's already-confirmed shape from the original router.
 * Please upload queue.ts to confirm/correct this import and the intent
 * key below.
 */

import type { RoutedIntent, Intent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { bookingService } from "@/lib/services/booking"
import { queueService } from "@/lib/services/queue" // ASSUMPTION — see file header
import { registrationService } from "@/lib/services/registration"

import {
  stateService,
  type ConversationState,
} from "@/lib/services/state"

import { getCustomer, type Customer } from "@/lib/services/tenant-customer"
import { getSmartGreeting } from "@/lib/whatsapp/utils/greeting"
import { getBusinessHoursNote } from "@/lib/whatsapp/utils/business-hours"

/**
 * Contract each service must implement to participate in stateful
 * conversations. A service inspects `state.state` and either:
 *   - returns an ActionResult if it recognizes and handles the state, or
 *   - returns null (sync or async) to defer to the next service in line.
 *
 * CHANGED: now takes `tenantId` as a third argument, resolved once by
 * routeAction() below and threaded through delegateState() — services
 * need it for every tenant_customers / booking / queue lookup they make.
 */
export interface StatefulService {
  handleState(
    state: ConversationState,
    message: IncomingMessage,
    tenantId: string,
  ): ActionResult | null | Promise<ActionResult | null>
}

export interface IntentService {
  intent: string
  handle(
    intent: RoutedIntent,
    message: IncomingMessage,
    tenantId: string,
  ): ActionResult | Promise<ActionResult>
}

/**
 * Central registry of services.
 *
 * Open/Closed Principle: adding a new service means adding one entry
 * here — nothing else in this file changes. `stateHandlers` are tried in
 * order for in-progress conversations; `intentHandlers` are looked up by
 * intent name for fresh requests.
 */
const stateHandlers: StatefulService[] = [
  // registrationService goes first: while a customer is mid-registration
  // (state name "registration_awaiting_*"), no other service owns that
  // state name, so it must get first refusal to avoid an unmapped state
  // ever accidentally falling through to UNKNOWN_STATE_REPLY.
  registrationService,
  queueService,
  bookingService,
]

const intentHandlers: Record<string, IntentService["handle"]> = {
  queue: queueService.handleQueue.bind(queueService), // ASSUMPTION — see file header
  booking: bookingService.handleBooking.bind(bookingService),
}

// `unhandled: true` marks this as a genuine "we don't know what to do"
// reply — see handover.ts's shouldEscalate(), which requires this flag
// (not raw intent confidence alone) before treating low confidence as a
// reason to escalate.
const UNKNOWN_STATE_REPLY: ActionResult = {
  reply: "I couldn't continue your previous request, so let's start again. How can I help you today?",
  buttons: [],
  nextState: null,
  unhandled: true,
}

/**
 * Shown when someone explicitly cancels an in-progress flow ("cancel",
 * "menu", etc). Distinct from UNKNOWN_STATE_REPLY (fires when state is
 * stale/corrupt) and from the fresh-conversation greeting (fires with no
 * state at all), so the copy can say the right thing in each case.
 */
function buildCancelledReply(): ActionResult {
  return {
    reply: "No problem. I've cancelled that request. What would you like to do next — book an appointment or join the queue?",
    buttons: [],
    nextState: null,
  }
}

/**
 * Words/phrases that should always be able to break out of an
 * in-progress flow, regardless of which service owns the current state.
 * Matched with `.includes()` against the raw trimmed/lowercased message
 * text, since button taps can carry emoji/decoration.
 */
const GLOBAL_INTERRUPT_KEYWORDS = ["cancel", "menu", "main menu", "start over", "restart", "stop"]

/**
 * Maps a conversation state name to the intent that owns it, purely from
 * naming convention — no service file needs to change for this to work.
 *
 * This exists ONLY to answer one question in `routeAction`: is the intent
 * this message just resolved to actually DIFFERENT from the flow the user
 * is already in? A null result means "don't know" -> routeAction treats
 * that as "not confidently different," so it falls through to normal
 * state delegation rather than risk a wrong guess.
 *
 * ASSUMPTION: "queue_" prefix mirrors "booking_", matching the naming
 * convention `registration_awaiting_*` and `booking_*` already use.
 * Confirm against queue.ts's actual state names once uploaded.
 */
function resolveOwningIntent(stateName: string): Intent | null {
  if (stateName.startsWith("booking_")) return "booking"
  if (stateName.startsWith("queue_")) return "queue" // ASSUMPTION — see above
  return null
}

/**
 * First name for greeting purposes. Falls back to "there" for an
 * unregistered number, an incomplete record (name not collected yet —
 * registration is incremental, see tenant-customer.ts's file header), or
 * a lookup failure — "Hey there," reads naturally mid-sentence; "Hey
 * Guest," doesn't.
 */
function firstNameFromCustomer(customer: Customer | null): string {
  if (!customer?.name) return "there"
  return customer.name.split(" ")[0]
}

/**
 * Used whenever the intent router can't map a message to a real intent —
 * which includes greetings and small talk. Personalization is
 * best-effort: getCustomer is safe to call from a downstream service like
 * this router (unlike ensureCustomer, which is reply.ts's job alone), but
 * it DOES throw on a genuine DB error (only returns null for "no match"),
 * so that's caught here explicitly rather than letting a lookup failure
 * break the whole greeting.
 *
 * SIMPLIFIED from the Rands version: dropped the venue-specific branding
 * copy, the vercel web-app link, and the Rands services-list followUp
 * (buildServicesListMessage was built around Rands' 5-row menu — order,
 * shisha, vvip, tickets, passport — none of which apply here). This just
 * greets and asks what the customer needs; a QLess-appropriate "book or
 * queue" menu builder can replace this once that's designed.
 */
async function buildUnknownIntentReply(message: IncomingMessage, tenantId: string): Promise<ActionResult> {
  let customer: Customer | null = null
  try {
    customer = await getCustomer(tenantId, message.from)
  } catch (error) {
    console.error("[action-router] getCustomer lookup failed for greeting:", error)
  }

  const firstName = firstNameFromCustomer(customer)
  const greeting = getSmartGreeting()
  const hoursNote = getBusinessHoursNote()

  return {
    reply:
      `${greeting} ${firstName}! 👋\n\n` +
      "Would you like to book an appointment, or join the queue?" +
      (hoursNote ? `\n\n${hoursNote}` : ""),
    buttons: [],
    nextState: null,
    // NOT unhandled — this fires on ordinary first-contact and ambiguous
    // messages, a huge share of normal traffic. See UNKNOWN_STATE_REPLY's
    // comment for why only a stale/corrupt state marks itself unhandled.
  }
}

/**
 * Asks each registered service, in order, whether it owns the given
 * conversation state. The first non-null response wins. If nobody claims
 * it, the state is stale or corrupt, so we clear it and restart politely.
 */
async function delegateState(
  state: ConversationState,
  message: IncomingMessage,
  tenantId: string,
): Promise<ActionResult> {
  for (const service of stateHandlers) {
    const result = await service.handleState(state, message, tenantId)
    if (result) return result
  }

  await stateService.clearState(tenantId, message.from)

  return UNKNOWN_STATE_REPLY
}

export async function routeAction(
  intent: RoutedIntent,
  state: ConversationState | null,
  message: IncomingMessage,
  tenantId: string,
): Promise<ActionResult> {
  // ── GLOBAL INTERRUPTS (checked before state routing) ───────────────
  // A user mid-flow (e.g. picking a booking slot) normally continues that
  // same flow — a plain reply must reach the service that asked the
  // question, not generic intent classification. BUT that can't be
  // unconditional, or the user gets trapped forever: an explicit "cancel"
  // or a message that classifies as a genuinely different, real intent
  // (booking vs queue) must be able to break out of whatever flow they
  // were in.
  if (state) {
    const text = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
    const isExplicitCancel = GLOBAL_INTERRUPT_KEYWORDS.some(keyword => text.includes(keyword))

    if (isExplicitCancel) {
      await stateService.clearState(tenantId, message.from)
      return buildCancelledReply()
    }

    // A button tap can only ever be answering whatever prompt the
    // currently active flow just showed, so the raw classifier result
    // must never override that, no matter what it guessed from the
    // button's bare title text. Free-text replies are NOT covered by
    // this — someone typing their way out of a flow into a genuinely
    // different request must still be able to, via the check below.
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
      return intentHandlers[intent.intent](intent, message, tenantId)
    }

    return delegateState(state, message, tenantId)
  }

  // ── INTENT ROUTING ────────────────────────────────────────────────
  const handler = intent?.intent ? intentHandlers[intent.intent] : undefined
  if (!handler) return buildUnknownIntentReply(message, tenantId)

  return handler(intent, message, tenantId)
}
