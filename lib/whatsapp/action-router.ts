// lib/whatsapp/action-router.ts
/**
 * QLess Action Router — booking / queue / status / cancel / profile, tenant-scoped.
 * -----------------------------------------------------------------------
 * Still a PURE DISPATCHER: it decides WHICH service handles a message and
 * hands off. No business logic lives here.
 *
 * FIRST CONTACT (new): a customer who says "hi" — or sends anything we
 * can't map to a real intent — gets TWO WhatsApp messages, the same pattern
 * the old Rands bot used:
 *   1. a short smart greeting + their first name + a line welcoming them to
 *      the shop + the shop's own web link (the main `reply`), then
 *   2. the five-row interactive menu (Book Now / Join Queue / Check Status /
 *      Cancel Now / My Profile), attached as `followUp`.
 * lib/whatsapp/send-action-result.ts is what actually delivers the follow-up.
 * An explicit "menu" / "start over" (or a bare "cancel" while a booking is
 * half-done) also shows the menu, with a shorter lead-in instead of the greeting.
 *
 * ROUTING ORDER inside routeAction (order matters — it fixes the "cancel"
 * trap):
 *   1. MENU ROW TAP (by row id) — a deliberate, unambiguous choice. Wins over
 *      conversation state, global interrupts and AI classification, and
 *      doubles as an implicit cancel of whatever the customer was doing
 *      (state is cleared first). Never reaches the AI.
 *   2. If the customer is mid-conversation:
 *        a. a typed cancel REQUEST ("cancel my booking", "leave the queue" —
 *           the "cancel" intent) opens the Cancel Now flow instead of just
 *           resetting. Not applied inside the cancel flow itself.
 *        b. global interrupt words ("menu", "start over", "stop", and "cancel")
 *           reset to the menu. INSIDE the cancel flow only the reset words
 *           apply — otherwise the "Yes, cancel it" button would match
 *           "cancel" and throw the customer out of the flow.
 *        c. a genuinely new intent (e.g. "check my booking" mid-booking)
 *           switches flows; button taps and plain answers ("2", "yes") never do.
 *        d. otherwise the service that owns the current state handles it.
 *   3. No state: route by intent; anything unrecognised -> greeting + menu.
 *
 * Dependency direction (unchanged): WhatsApp → Intent Router → Action
 * Router → Services → Supabase.
 *
 * White-label: the shop's name comes from tenant_branding.display_name,
 * falling back to tenants.name. The shop's web link is built from
 * tenants.slug and only shown when their web page is switched on
 * (see utils/tenant-web-link.ts). No brand is hardcoded.
 */

import type { RoutedIntent, Intent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { bookingService } from "@/lib/services/booking"
import { queueService } from "@/lib/services/queue"
import { statusService } from "@/lib/services/status"
import { cancelService } from "@/lib/services/cancel"
import { profileService } from "@/lib/services/profile"

import { stateService, type ConversationState } from "@/lib/services/state"
import { getCustomer, type Customer } from "@/lib/services/tenant-customer"

import { getSmartGreeting } from "@/lib/whatsapp/greeting"
import { buildServicesListMessage, MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"
import { getTenantWebLink } from "@/lib/whatsapp/utils/tenant-web-link"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"

/**
 * Contract each service must implement to participate in stateful
 * conversations: inspect `state.state` and either return an ActionResult
 * (it owns this state) or null (defer to the next service).
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

type Handler = IntentService["handle"]

// bookingService first: a customer only ever enters a queue_* state via
// booking.ts's handleEntryChoice (or the "Join Queue" row, which sets a
// queue_* state itself), so booking gets first refusal on every state name.
// cancelService owns exactly the "cancel_*" states.
const stateHandlers: StatefulService[] = [bookingService, queueService, cancelService]

const intentHandlers: Record<string, Handler> = {
  booking: bookingService.handleBooking.bind(bookingService),
  status: statusService.handleStatus,
  cancel: cancelService.handleCancel,
  // Stateless: one live read in, one message out (no state to own).
  profile: profileService.handleProfile,
}

/**
 * Menu row id -> handler. A tap on the menu is never ambiguous (we built the
 * menu), so it is routed deterministically here instead of through AI intent
 * classification. Row ids come from MENU_ROW_IDS in services-list.ts.
 */
const MENU_ROW_HANDLERS: Record<string, Handler> = {
  [MENU_ROW_IDS.book]: (tenantId) => bookingService.startBookingFlow(tenantId),
  [MENU_ROW_IDS.queue]: (tenantId) => queueService.startQueueFlow(tenantId),
  [MENU_ROW_IDS.status]: statusService.handleStatus,
  [MENU_ROW_IDS.cancel]: cancelService.handleCancel,
  [MENU_ROW_IDS.profile]: profileService.handleProfile,
}

// `unhandled: true` marks a genuine "we don't know what to do" reply —
// handover.ts's shouldEscalate() uses this flag, not raw intent confidence.
const UNKNOWN_STATE_REPLY: ActionResult = {
  reply: "I couldn't continue your previous request, so let's start again. How can I help you today?",
  buttons: [],
  nextState: null,
  unhandled: true,
  followUp: [buildServicesListMessage("Tap below to choose what you'd like to do 👇")],
}

/** Words that reset the conversation to the menu from anywhere. */
const RESET_KEYWORDS = ["menu", "main menu", "start over", "restart", "stop"]

/**
 * Outside the cancel flow a bare "cancel" (or the word "cancel" in a button)
 * also resets — that is what it always did. Inside the cancel flow it must
 * NOT, because "Yes, cancel it" contains the word.
 */
const GLOBAL_INTERRUPT_KEYWORDS = [...RESET_KEYWORDS, "cancel"]

const CANCEL_STATE_PREFIX = "cancel_"

/** Short answers like "2" or "yes" are answering a prompt, never switching topic. */
const PLAIN_ANSWER_PATTERN = /^(\d{1,2}|y|n|yes|no|yeah|yep|nope|ok|okay|sure)[.!]*$/

/**
 * Maps a state name to the intent that owns it (by naming convention).
 * Used only to answer "is this message a genuinely DIFFERENT intent from the
 * flow the customer is already in?". null = unknown -> don't switch.
 */
function resolveOwningIntent(stateName: string): Intent | null {
  if (stateName.startsWith("booking_")) return "booking"
  if (stateName.startsWith("queue_")) return "booking"
  if (stateName.startsWith(CANCEL_STATE_PREFIX)) return "cancel"
  return null
}

/** First name for the greeting, or "there" for a nameless/unknown customer. */
function firstNameFromCustomer(customer: Customer | null): string {
  if (!customer?.name) return "there"
  return customer.name.trim().split(/\s+/)[0] || "there"
}

/**
 * Greeting + menu. Used for a fresh conversation, an unrecognised message
 * (greet = true), and for an explicit reset like "menu" (greet = false,
 * which skips the greeting and just says "no problem" before the menu).
 *
 * Personalisation is best-effort: if the customer, timezone, shop-name or
 * web-link lookup fails, the greeting still goes out with sensible fallbacks
 * (the web link line is simply left out).
 */
async function buildEntryReply(tenantId: string, message: IncomingMessage, greet: boolean): Promise<ActionResult> {
  const menu = buildServicesListMessage("Tap below to choose what you'd like to do 👇")

  if (!greet) {
    return {
      reply: "No problem — let's start fresh. What would you like to do?",
      buttons: [],
      nextState: null,
      followUp: [menu],
    }
  }

  let customer: Customer | null = null
  try {
    customer = await getCustomer(tenantId, message.from)
  } catch (error) {
    console.error("[action-router] getCustomer lookup failed for greeting:", error)
  }

  const firstName = firstNameFromCustomer(customer)
  const isReturning = Boolean(customer?.name)

  // Shop-local time of day, the shop's own name and its web link
  // (all white-label safe: nothing hardcoded).
  let timeZone: string | undefined
  let shopName: string | null = null
  let webLink: string | null = null
  try {
    const supabase = getSupabaseServerClient()
    if (supabase) {
      const [tz, tenantRow, brandingRow, link] = await Promise.all([
        getTenantTimezone(supabase, tenantId),
        supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
        supabase.from("tenant_branding").select("display_name").eq("tenant_id", tenantId).maybeSingle(),
        getTenantWebLink(tenantId),
      ])
      timeZone = tz
      // The Display name owners set under Settings > Branding wins; fall back
      // to the tenant's own name.
      shopName = brandingRow.data?.display_name?.trim() || tenantRow.data?.name || null
      // Each tenant's own link (null when their web page is not available).
      webLink = link
    }
  } catch (error) {
    console.error("[action-router] greeting context lookup failed:", error)
  }

  const greeting = getSmartGreeting({ timeZone, isReturning })
  const welcomeLine = shopName
    ? `Welcome to *${shopName}*. I can help you book an appointment or join the walk-in queue.`
    : "Welcome! I can help you book an appointment or join the walk-in queue."
  const webLine = webLink ? `\n\nPrefer to do it online? You can also use ${webLink}` : ""

  return {
    reply: `${greeting} ${firstName}! 👋\n\n${welcomeLine}${webLine}`,
    buttons: [],
    nextState: null,
    followUp: [menu],
  }
}

/**
 * Asks each registered service, in order, whether it owns the given
 * conversation state. First non-null response wins. If nobody claims it the
 * state is stale/corrupt — clear it and restart politely.
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
  // ── 1. MENU ROW TAP (checked before everything else) ───────────────
  const rowHandler = message.interactiveId ? MENU_ROW_HANDLERS[message.interactiveId] : undefined
  if (rowHandler) {
    // Always clear first: tapping the menu is an implicit cancel of whatever
    // the customer was doing. (reply.ts saves the new nextState afterwards.)
    await stateService.clearState(tenantId, message.from)
    return rowHandler(tenantId, intent, message)
  }

  // ── 2. MID-CONVERSATION ────────────────────────────────────────────
  if (state) {
    const text = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
    const isButtonReply = Boolean(message.interactiveId)
    const inCancelFlow = state.state.startsWith(CANCEL_STATE_PREFIX)

    // 2a. A typed cancel REQUEST opens Cancel Now (instead of just resetting).
    if (!inCancelFlow && !isButtonReply && intent?.intent === "cancel") {
      await stateService.clearState(tenantId, message.from)
      return intentHandlers.cancel(tenantId, intent, message)
    }

    // 2b. Reset words. Inside the cancel flow, "cancel" is NOT one of them.
    const resetWords = inCancelFlow ? RESET_KEYWORDS : GLOBAL_INTERRUPT_KEYWORDS
    if (resetWords.some((keyword) => text.includes(keyword))) {
      await stateService.clearState(tenantId, message.from)
      return buildEntryReply(tenantId, message, false)
    }

    // 2c. A button tap is always answering the prompt the active flow just
    // showed — never let raw classification override that. Plain answers
    // ("2", "yes") likewise never switch topic.
    const owningIntent = resolveOwningIntent(state.state)
    const isGenuinelyNewIntent =
      !isButtonReply &&
      !PLAIN_ANSWER_PATTERN.test(text) &&
      !!intent?.intent &&
      !!intentHandlers[intent.intent] &&
      owningIntent !== null &&
      intent.intent !== owningIntent

    if (isGenuinelyNewIntent) {
      await stateService.clearState(tenantId, message.from)
      return intentHandlers[intent.intent](tenantId, intent, message)
    }

    // 2d. The service that owns this state handles it.
    return delegateState(tenantId, state, message)
  }

  // ── 3. INTENT ROUTING (no conversation in progress) ────────────────
  const handler = intent?.intent ? intentHandlers[intent.intent] : undefined
  if (!handler) return buildEntryReply(tenantId, message, true)

  return handler(tenantId, intent, message)
}
