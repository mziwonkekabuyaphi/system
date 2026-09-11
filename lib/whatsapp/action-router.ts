/**
 * Rands WhatsApp Concierge — Action Router
 * -----------------------------------------
 * Routes intents (and in-progress conversation state) to the appropriate
 * service handlers.
 *
 * This is a PURE DISPATCHER — it does NOT contain business logic, validation,
 * or knowledge of any specific conversation state. All of that lives inside
 * the services themselves. The router's only job is to decide *which*
 * service gets first refusal at handling a given message, then hand off.
 *
 * Dependency direction (never reversed):
 *   WhatsApp → Intent Router → Action Router → Services → Supabase
 */

import type { RoutedIntent, Intent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { walletService } from "@/lib/services/wallet"
import { passportService } from "@/lib/services/passport"
import { eventsService } from "@/lib/services/events"
import { ticketsService } from "@/lib/services/tickets"
import { ordersService } from "@/lib/services/orders"
import { vvipService } from "@/lib/services/vvip"
import { shishaService } from "@/lib/services/shisha"
import { supportService } from "@/lib/services/support"
import { bookingService } from "@/lib/services/booking"
import { registrationService } from "@/lib/services/registration"

import {
  stateService,
  type ConversationState,
} from "@/lib/services/state"

import { getCustomer, type Customer } from "@/lib/services/customer"
import { getSmartGreeting } from "@/lib/whatsapp/utils/greeting"
import { buildServicesListMessage } from "@/lib/whatsapp/utils/services-list"
import { isVenueOpenNow, getBusinessHoursNote } from "@/lib/whatsapp/utils/business-hours"
/**
 * Contract each service must implement to participate in stateful
 * conversations. A service inspects `state.state` and either:
 *   - returns an ActionResult if it recognizes and handles the state, or
 *   - returns null (sync or async) to defer to the next service in line.
 *
 * This is what lets the router stay ignorant of state names like
 * "awaiting_ticket_quantity" — that knowledge now lives only inside the
 * service that owns it.
 */
export interface StatefulService {
  handleState(
    state: ConversationState,
    message: IncomingMessage
  ): ActionResult | null | Promise<ActionResult | null>
}

export interface IntentService {
  intent: string
  handle(intent: RoutedIntent, message: IncomingMessage): ActionResult | Promise<ActionResult>
}

/**
 * Central registry of services.
 *
 * Open/Closed Principle: adding a new service (e.g. a future "loyalty"
 * service) means adding one entry here — nothing else in this file changes.
 * `stateHandlers` are tried in order for in-progress conversations;
 * `intentHandlers` are looked up by intent name for fresh requests.
 */
const stateHandlers: StatefulService[] = [
  // registrationService goes first: while a customer is mid-registration
  // (state name "registration_awaiting_*"), no other service owns that
  // state name, so it must get first refusal to avoid an unmapped state
  // ever accidentally falling through to UNKNOWN_STATE_REPLY.
  registrationService,
  walletService,
  // passportService owns exactly one state name (PASSPORT_STATE_RESUME) —
  // used only so an unregistered customer who said "Passport" lands back
  // on the overview once registration completes, the same resume pattern
  // walletService already uses for top-up. Passport otherwise never sets
  // conversation state; every other turn is one message in, one message
  // (+ list) out. See lib/services/passport.ts's file header.
  passportService,
  eventsService,
 ticketsService,
  ordersService,
  vvipService,
  shishaService,
  supportService,
  bookingService,
]

const intentHandlers: Record<string, IntentService["handle"]> = {
  wallet: walletService.handleWallet.bind(walletService),
  passport: passportService.handlePassport.bind(passportService),
  event: eventsService.handleEvent.bind(eventsService),
  ticket: ticketsService.handleTicket.bind(ticketsService),
  order: ordersService.handleOrder.bind(ordersService),
  vvip: vvipService.handleVVIP.bind(vvipService),
  shisha: shishaService.handleShisha.bind(shishaService),
  support: supportService.handleSupport.bind(supportService),
  booking: bookingService.handleBooking.bind(bookingService),
}

/**
 * Maps a services-menu row id (see buildServicesListMessage) straight to
 * the intent it represents. A tap on this menu is never ambiguous — we
 * built the menu, so we already know exactly what each row means — so
 * routing on `message.interactiveId` here skips AI intent classification
 * entirely for this one, common case.
 *
 * This exists because relying on the classifier to re-derive intent from
 * the row's *title* text was the root cause of a real bug: tapping
 * "🍾 Rands Smart Counter" (row_4) got read as a product-search query
 * instead of "open the order flow," because the title alone doesn't
 * contain an obvious order/menu keyword. Routing on the id sidesteps that
 * class of misclassification for every row, not just this one.
 */
const SERVICE_ROW_INTENTS: Record<string, Intent> = {
  row_1: "passport",
  row_2: "ticket",
  row_3: "vvip",
  row_4: "order",
  row_5: "shisha",
}

/**
 * Same idea as SERVICE_ROW_INTENTS, for the five Passport overview rows
 * that map onto a real intent (see lib/messages/passport.ts's row ids). A
 * tap here is just as unambiguous as a tap on the main services list — we
 * built this list too — so it's routed the same deterministic way rather
 * than re-running classification on the row's title text. Kept as a
 * separate map (rather than merged into SERVICE_ROW_INTENTS) so each
 * menu's ids can be read/maintained next to the file that renders that menu.
 *
 * The Passport overview's sixth row ("🌐 Rands Experience") is
 * deliberately NOT in this map — there is no Intent value for it, since
 * it isn't a service, just the existing services list. It's handled as
 * its own case in routeAction below (PASSPORT_EXPERIENCE_ROW_ID), the same
 * way wallet.ts's own "🌐 Rands Experience" button returns the list
 * directly instead of round-tripping through an intent.
 */
const PASSPORT_ROW_INTENTS: Record<string, Intent> = {
  passport_balance: "wallet",
  passport_tickets: "ticket",
  passport_vvip: "vvip",
  passport_orders: "order",
  passport_shisha: "shisha",
}

const PASSPORT_EXPERIENCE_ROW_ID = "passport_experience"

// Same idea as PASSPORT_EXPERIENCE_ROW_ID's bypass below: these four rows
// tap into a live "what do I already have" read in passport.ts, instead of
// intentHandlers[rowIntent] — which is built for "start something new"
// (buy a ticket, book a table, place an order, start a session) and was
// why tapping e.g. "My Tickets" opened the ticket-buying flow instead of
// showing the customer's own tickets. Each passport.ts handler already
// falls back to the real service entry point on its own when there's
// nothing to show, so this map is a pure bypass — no duplicated fallback
// logic here.
const PASSPORT_ROW_DIRECT_HANDLERS: Partial<Record<string, IntentService["handle"]>> = {
  passport_tickets: passportService.handlePassportTickets.bind(passportService),
  passport_vvip: passportService.handlePassportVvip.bind(passportService),
  passport_orders: passportService.handlePassportOrders.bind(passportService),
  passport_shisha: passportService.handlePassportShisha.bind(passportService),
}

/**
 * The Passport overview's "🌐 Rands Experience" row — returns the existing
 * services list directly, exactly mirroring wallet.ts's handleTopupChoice
 * handling of the same button/row elsewhere in the app. No new menu, no
 * new copy pattern.
 */
function buildPassportExperienceReply(): ActionResult {
  return {
    reply: "Here's everything Rands has to offer 👇",
    buttons: [],
    nextState: null,
    followUp: [
      buildServicesListMessage(
        "Tap below to browse, or just type your question and I'll do my best to help.",
      ),
    ],
  }
}

// `unhandled: true` marks this as a genuine "we don't know what to do"
// reply — see handover.ts's shouldEscalate(), which now requires this
// flag (not raw intent confidence alone) before treating low confidence
// as a reason to escalate. Every other ActionResult in this file leaves
// it unset, since a deterministic reply is still a good reply even if
// the classification that ran alongside it happened to be unsure.
const UNKNOWN_STATE_REPLY: ActionResult = {
  reply: "I couldn't continue your previous request, so let's start again. How can I help you today?",
  buttons: [],
  nextState: null,
  unhandled: true,
}

/**
 * Intents that only make sense while the venue is physically open —
 * you can't hand someone a plate of food or a shisha pipe outside
 * operating hours. Everything else (tickets, vvip, support,
 * registration, wallet) stays available any time: those are all
 * either "book ahead" or account-management actions that don't
 * require the venue to be open right now.
 *
 * Deliberately a short, explicit allowlist-by-exclusion rather than
 * inferred from anything structural, so adding a new on-premise-only
 * service later (e.g. a future "kitchen" service) is a one-line change
 * here and nowhere else.
 */
const ON_PREMISE_ONLY_INTENTS = new Set<Intent>(["order", "shisha"])

/**
 * Shown when someone tries to start an order/shisha flow while the venue
 * is closed. Redirects toward the things that ARE available any time
 * (tickets, vvip, support) instead of just saying "no".
 */
function buildVenueClosedReply(): ActionResult {
  return {
    reply:
      "Food, drinks, and shisha orders are only available on-site while we're open " +
      "(Thursday to Sunday, 11am to 11pm). We're closed right now.\n\n" +
      "You're welcome to book a VVIP table, grab event tickets, or reach support any time though!",
    buttons: [],
    nextState: null,
    followUp: [buildServicesListMessage("Here's what else I can help you with:")],
  }
}

/**
 * SERVICE_ROW_INTENTS below maps buildServicesListMessage()'s row ids back
 * to intents for deterministic routing — see services-list.ts's file-level
 * comment for why the builder itself lives there, not here.
 */

/**
 * Shown when the user explicitly cancels an in-progress flow ("cancel",
 * "menu", etc). Distinct from UNKNOWN_STATE_REPLY (which fires when state
 * is stale/corrupt) and from UNKNOWN_INTENT_REPLY (which fires on a fresh
 * conversation) so the copy can say the right thing in each case.
 *
 * Uses the same "View Services" list as the first-contact greeting
 * (buildUnknownIntentReply) rather than a separate 3-button reply, so
 * cancelling anywhere always drops the customer into one consistent menu
 * instead of a second, narrower surface.
 */
function buildCancelledReply(): ActionResult {
  return {
    reply: "No problem. I've cancelled that request. What would you like to do next?",
    buttons: [],
    nextState: null,
    followUp: [buildServicesListMessage("Here's what I can help you with today — tap below to browse.")],
  }
}

/**
 * Words/phrases that should always be able to break out of an in-progress
 * flow, regardless of which service owns the current state. Matched with
 * `.includes()` against the raw trimmed/lowercased message text (not exact
 * equality), since button taps carry emoji/decoration (e.g. "❌ Cancel")
 * that would never equal the plain word "cancel". Kept intentionally small
 * and unambiguous since it's a substring check, not full intent
 * classification.
 */
const GLOBAL_INTERRUPT_KEYWORDS = ["cancel", "menu", "main menu", "start over", "restart", "stop"]

/**
 * Maps a conversation state name to the intent that owns it, purely from
 * naming convention — no service file needs to change for this to work.
 *
 * This exists ONLY to answer one question in `routeAction`: is the intent
 * this message just resolved to actually DIFFERENT from the flow the user
 * is already in? Without this, "same topic, mid-flow" (e.g. typing an
 * amount while topping up wallet, which correctly resolves to the
 * "wallet" intent via context) was indistinguishable from "genuinely
 * switching topics," and every single reply in every flow was wiping state
 * and restarting from the entry point. That was the regression.
 *
 * Returns null for any state name that isn't recognized. A null result
 * means "don't know" -> routeAction treats that as "not confidently
 * different," so it falls through to normal state delegation rather than
 * risk a wrong guess.
 */
  function resolveOwningIntent(stateName: string): Intent | null {
  // Passport / Wallet
 if (stateName.startsWith("wallet_")) return "wallet"

  // Orders
  if (stateName.startsWith("order_")) return "order"

  // VVIP
  if (stateName.startsWith("vvip_")) return "vvip"

  // Shisha Lounge
  if (stateName.startsWith("shisha_")) return "shisha"

  // Booking (salon/barbershop appointments)
  if (stateName.startsWith("booking_")) return "booking"

  // Kept in sync with the TicketStateName union in tickets.ts. Previously
  // this was missing "awaiting_delivery_choice" and "awaiting_topup_or_card"
  // (real states tickets.ts uses) and included a phantom
  // "awaiting_wallet_confirmation" that doesn't exist anywhere — meaning
  // resolveOwningIntent() returned null for those two real states, silently
  // disabling the "genuinely new intent" interrupt check while in them.
  const TICKET_OWNED_STATES = new Set([
    "ticket_menu",
    "ticket_awaiting_event_selection",
    "awaiting_ticket_type_selection",
    "awaiting_ticket_quantity",
    "awaiting_contact_name",
    "awaiting_delivery_choice",
    "awaiting_contact_phone",
    "awaiting_payment_method",
    "awaiting_topup_or_card",
    "awaiting_payment_confirmation",
    "purchase_complete",
    "awaiting_ticket_validation",
  ])

  if (TICKET_OWNED_STATES.has(stateName)) {
    return "ticket"
  }

  // Support. Kept as an explicit set (like TICKET_OWNED_STATES) rather than
  // a prefix check because support.ts's two real states — "support_menu"
  // and "awaiting_support_details" — don't share a common prefix. Both
  // were previously unrecognized here entirely, which meant owningIntent
  // was always null while a customer was in either support state. Since
  // isGenuinelyNewIntent below requires `owningIntent !== null`, that
  // silently disabled the "a genuinely new intent can interrupt this flow"
  // check for the whole support flow — a customer mid-support-conversation
  // could never be handed off to a different service by a real topic
  // switch, only by an explicit "cancel"/"menu" interrupt. Kept in sync
  // with the SupportStateName union in support.ts.
  const SUPPORT_OWNED_STATES = new Set([
    "support_menu",
    "awaiting_support_details",
  ])

  if (SUPPORT_OWNED_STATES.has(stateName)) {
    return "support"
  }

  return null
}

/**
 * "Passport" is the customer-facing name for the wallet payment option
 * (see ticketsService's PAYMENT_METHOD_BUTTONS), so when a flow is
 * specifically waiting on a payment-method choice, that word is an
 * answer to the current question — not a request to jump into the
 * standalone Passport/wallet intent. Without this, replying "Passport"
 * (or "wallet"/"cash"/"card"/"vvip") here gets misclassified as switching
 * topics via `resolveOwningIntent` and abandons the purchase before the
 * owning service ever sees the answer.
 *
 * Covers every flow that asks this question under its own state name —
 * tickets ("awaiting_payment_method"), orders
 * ("order_awaiting_payment_method"), and vvip
 * ("vvip_awaiting_payment_method"). Originally this only listed the
 * tickets state name, which meant the same guard silently did nothing for
 * orders or vvip: replying "wallet"/"cash"/"card"/"passport" while one of
 * those states was active got read as a genuine topic switch and routed
 * straight into walletService instead of back to the owning service
 * (ordersService / vvipService) — killing the booking mid-payment.
 * Deliberately narrow otherwise: only fires for these known payment-prompt
 * states, matched against the same button words the owning services
 * themselves listen for.
 */
const PAYMENT_METHOD_PROMPT_STATES = new Set([
  "awaiting_payment_method",         // tickets
  "order_awaiting_payment_method",   // orders
  "vvip_awaiting_payment_method",    // vvip
])
const PAYMENT_METHOD_REPLY_KEYWORDS = ["passport", "wallet", "card", "cash", "vvip"]

function isAnsweringPaymentMethodPrompt(stateName: string, text: string): boolean {
  return (
    PAYMENT_METHOD_PROMPT_STATES.has(stateName) &&
    PAYMENT_METHOD_REPLY_KEYWORDS.some(keyword => text.includes(keyword))
  )
}

/**
 * vvip_awaiting_final_confirmation is the "Confirm & Pay" step
 * (vvipService's handleFinalConfirm). Unlike the payment-method prompt
 * above, this one can't be guarded with a fixed keyword list: the
 * classifier reads words like "pay" or "confirm" as a plausible standalone
 * wallet/payment intent on their own, with no flow context, and there's no
 * safe subset of confirm/decline wording to whitelist. But vvipService's
 * own handleFinalConfirm already treats ANY non-affirmative reply as "the
 * customer is declining/cancelling this booking" (see
 * FINAL_CONFIRM_AFFIRMATIVE in vvip.ts) rather than as an error — so this
 * state is open-ended by design, the same way
 * shisha_awaiting_issue_description is treated as always-answering above.
 * Without this guard, tapping "Confirm & Pay" gets misread as a fresh
 * wallet intent, wipes the booking state, and hands the customer to
 * walletService instead of completing (or even cleanly cancelling) the
 * booking.
 */
const VVIP_FINAL_CONFIRM_STATE = "vvip_awaiting_final_confirmation"

function isAnsweringVvipFinalConfirmPrompt(stateName: string): boolean {
  return stateName === VVIP_FINAL_CONFIRM_STATE
}

/**
 * vvip_post_booking is the "Check My Tab" / "Main Menu" prompt shown right
 * after a booking is confirmed (see vvip.ts's handlePostBookingChoice).
 * "Main Menu" never actually reaches this guard — it's already caught by
 * GLOBAL_INTERRUPT_KEYWORDS above, since that check runs first — so in
 * practice this only ever needs to protect "Check My Tab". That phrase
 * reads to the classifier exactly like a standalone wallet-balance check
 * ("check my tab" ~ "check my balance"), the same ambiguity
 * isAnsweringPaymentMethodPrompt exists to solve for "passport"/"wallet" —
 * so, same fix: any reply at this state is treated as answering vvipService
 * rather than switching intents. Open-ended (no keyword list) for the same
 * reason as isAnsweringVvipFinalConfirmPrompt: handlePostBookingChoice
 * already treats any input as "show the tab," so there's no wrong answer
 * to misroute here.
 */
const VVIP_POST_BOOKING_STATE = "vvip_post_booking"

function isAnsweringVvipPostBookingPrompt(stateName: string): boolean {
  return stateName === VVIP_POST_BOOKING_STATE
}

/**
 * The ticket menu itself offers "Buy" / "Check" / "Events" as its reply
 * options (see ticketsService's TICKET_MENU_BUTTONS / MENU_KEYWORDS). Those
 * single words are genuinely ambiguous out of context — a bare "Buy" reads
 * just as easily as "buy drinks" (→ order intent) to the classifier as it
 * does "buy ticket" — but here they're answers to the menu ticketsService
 * just displayed, not a request to switch topics. Without this, a plain
 * "Buy" tap can get classified as "order", clear the ticket state, and
 * hand off to a service that has no idea what "Buy" means on its own —
 * this mirrors the payment-method-prompt case above, just one step
 * earlier in the same flow.
 */
const TICKET_MENU_PROMPT_STATE = "ticket_menu"
const TICKET_MENU_REPLY_KEYWORDS = ["buy", "check", "events"]

function isAnsweringTicketMenuPrompt(stateName: string, text: string): boolean {
  return (
    stateName === TICKET_MENU_PROMPT_STATE &&
    TICKET_MENU_REPLY_KEYWORDS.some(keyword => text.includes(keyword))
  )
}

/**
 * "event" and "ticket" are adjacent domains from the classifier's point of
 * view, not just a fixed set of ambiguous keywords: event names, venues,
 * and dates are exactly the vocabulary a message answering "which event
 * would you like tickets for?" is made of, so Claude frequently reads a
 * plain event-name reply (e.g. tapping an event button during
 * ticket_awaiting_event_selection) as a request to browse events rather
 * than an answer to the ticket flow's own question.
 *
 * The same problem shows up one step later for ticket TYPE names: a tier
 * called something like "VVIP Experience" is exactly the vocabulary the
 * classifier associates with the standalone VVIP intent (bottle service /
 * table booking), so picking that ticket type during
 * awaiting_ticket_type_selection was getting misread as "switch to VVIP" —
 * wiping the in-progress ticket purchase and handing the customer off to
 * vvipService mid-flow. Same root cause as the event case, just a
 * different intent, so both are covered by one noise set here.
 *
 * Unlike the keyword guards above, this can't be solved with a fixed word
 * list since event/ticket-type names are dynamic — so instead, ANY
 * reclassification to one of these "adjacent" intents while already
 * inside the ticket flow is treated as noise, not a genuine topic switch.
 * Someone who actually wants to bail and go do something else can still
 * use an explicit interrupt ("menu", "cancel"), handled earlier.
 */
const TICKET_FLOW_NOISE_INTENTS = new Set<Intent>(["event", "vvip"])

function isEventIntentNoiseDuringTicketFlow(owningIntent: Intent | null, intent: RoutedIntent): boolean {
  return owningIntent === "ticket" && TICKET_FLOW_NOISE_INTENTS.has(intent.intent)
}

/**
 * Shisha Lounge replies are almost all short menu/number answers ("1",
 * "refill", "yes") or, for issue reports, a free-text description — and
 * several of those words (e.g. "issue", "report") are themselves plausible
 * matches for other real intents. This is the same class of bug fixed
 * above for order_awaiting_payment_method: without a guard, answering a
 * shisha_* prompt can get reclassified as "switching topics" and hand the
 * customer off to a different service mid-flow. `shisha_awaiting_issue_description`
 * is treated as always-answering (any text) since that prompt is
 * open-ended by design, the same way a ticket event-name reply is treated
 * as flow noise above rather than matched against a fixed keyword list.
 */
const SHISHA_FLOW_PROMPT_STATES = new Set([
  "shisha_menu",
  "shisha_awaiting_location",
  "shisha_awaiting_flavour",
  "shisha_awaiting_session_confirmation",
  "shisha_awaiting_issue_selection",
  "shisha_awaiting_issue_description",
])
const SHISHA_FLOW_REPLY_KEYWORDS = [
  "1", "2", "3", "4", "5", "6",
  "new session", "smoke", "refill", "coal",
  "end session", "end", "close",
  "report", "issue", "problem",
  "yes", "no",
]

function isAnsweringShishaPrompt(stateName: string, text: string): boolean {
  if (!SHISHA_FLOW_PROMPT_STATES.has(stateName)) return false
  if (stateName === "shisha_awaiting_issue_description") return true
  return SHISHA_FLOW_REPLY_KEYWORDS.some(keyword => text.includes(keyword))
}

/**
 * First name for greeting purposes, mirroring home.html's derivation
 * (name + surname joined). Falls back to "there" for an unregistered
 * number, an incomplete profile (name not collected yet — registration is
 * incremental, see customer.ts's file-level comment), or a lookup failure —
 * "Hey there," reads naturally mid-sentence; "Hey Guest," doesn't.
 */
function firstNameFromCustomer(customer: Customer | null): string {
  if (!customer) return "there"
  const fullName = [customer.name, customer.surname].filter(Boolean).join(" ")
  if (!fullName) return "there"
  return fullName.split(" ")[0]
}

/**
 * Used whenever the intent router can't map a message to one of the real
 * intents (wallet/ticket/event/support) — which includes greetings and
 * small talk, since those are also classified as "unknown" by design (see
 * intent-router.ts's checkGreetingOrThanks). Written as a warm welcome
 * rather than an apology, since "hi" hitting this path is the common case,
 * not the exception.
 *
 * Sent as TWO messages (mirrors the two jobs the old single wall of text
 * was doing at once):
 *   1. A short, personalized greeting — name + a time-aware phrase pulled
 *      from the same pool home.html uses for the web app, so the two
 *      surfaces feel like one concierge rather than two different bots.
 *   2. The services menu, unchanged in content from before.
 *
 * Personalization is best-effort: unlike ensureCustomer, getCustomer is
 * safe to call from a downstream service like this router (see customer.ts's
 * architecture rule), but it DOES throw on a genuine DB error (it only
 * returns null for "no match") — so that's caught here explicitly, rather
 * than letting a lookup failure break the whole greeting.
 */
async function buildUnknownIntentReply(message: IncomingMessage): Promise<ActionResult> {
  let customer: Customer | null = null
  try {
    customer = await getCustomer(message.from)
  } catch (error) {
    console.error("[action-router] getCustomer lookup failed for greeting:", error)
  }

  const firstName = firstNameFromCustomer(customer)
  const greeting = getSmartGreeting()
  const hoursNote = getBusinessHoursNote()

  return {
    reply:
      `${greeting} ${firstName}! 👋\n\n` +
      "Welcome to *Rands Cape Town* — I'm your personal *Rands Concierge*, here to take care of everything you need for your visit.\n\n" +
      (hoursNote ? `${hoursNote}\n\n` : "") +
      "Prefer an app? You can also use https://mzonke-six.vercel.app",
    buttons: [],
    nextState: null,
    // NOT unhandled. Unlike UNKNOWN_STATE_REPLY (a stale/corrupt state
    // nobody claims), this reply fires on ordinary first-contact and
    // ambiguous messages — a huge share of normal traffic, since Claude's
    // low-confidence floor (0.4) kicks in any time it can't confidently
    // pick a business intent. That combination (low confidence + this
    // reply) used to satisfy shouldEscalate()'s
    // `confidence < 0.5 && unhandled === true` check, which meant nearly
    // any unrecognized message — "Main menu" typed as text, a first
    // registration message, a typo — escalated to a human instead of
    // just showing the welcome + services menu, which IS a good, complete
    // answer. Leave this unset so low confidence alone never escalates
    // here; only UNKNOWN_STATE_REPLY still marks itself unhandled.
    followUp: [
      buildServicesListMessage(
        "Here's what I can help you with today — tap below to browse, or just type your question and I'll do my best to help.",
      ),
    ],
  }
}
/**
 * Asks each registered service, in order, whether it owns the given
 * conversation state. The first non-null response wins. If nobody claims
 * it, the state is stale or corrupt, so we clear it and restart politely.
 */
async function delegateState(
  state: ConversationState,
  message: IncomingMessage
): Promise<ActionResult> {
  for (const service of stateHandlers) {
    const result = await service.handleState(state, message)
    if (result) return result
  }

  await stateService.clearState(message.from)

  return UNKNOWN_STATE_REPLY
}
 
export async function routeAction(
  intent: RoutedIntent,
  state: ConversationState | null,
  message: IncomingMessage
): Promise<ActionResult> {
  // ── SERVICES MENU (checked before everything else) ─────────────────
  // A tap on the services list (row_1..row_5) is a deliberate, unambiguous
  // choice — it should win over both an in-progress flow's state AND
  // whatever the intent classifier made of the row's title text. This
  // also means tapping the menu always doubles as an implicit cancel of
  // whatever the customer was previously doing, same as a typed "menu".
  //
  // The Passport overview's own rows (passport_balance/tickets/vvip/
  // experience) get exactly the same treatment, for the same reason — a
  // tap there is just as unambiguous as a tap on the main services list.
  if (message.interactiveId === PASSPORT_EXPERIENCE_ROW_ID) {
    await stateService.clearState(message.from)
    return buildPassportExperienceReply()
  }

  const rowIntent = message.interactiveId
    ? SERVICE_ROW_INTENTS[message.interactiveId] ?? PASSPORT_ROW_INTENTS[message.interactiveId]
    : undefined
  if (rowIntent) {
    if (ON_PREMISE_ONLY_INTENTS.has(rowIntent) && !isVenueOpenNow()) {
      return buildVenueClosedReply()
    }
    await stateService.clearState(message.from)

    // The four Passport rows above get a direct "show me what I already
    // have" read instead of the owning service's generic fresh-intent
    // entry point. Everything else (row_1..row_5 on the main services
    // menu, and any Passport row not in this map) is unaffected.
    const directHandler = message.interactiveId
      ? PASSPORT_ROW_DIRECT_HANDLERS[message.interactiveId]
      : undefined
    if (directHandler) {
      return directHandler(intent, message)
    }

    return intentHandlers[rowIntent](intent, message)
  }

  // ── GLOBAL INTERRUPTS (checked before state routing) ───────────────
  // A user mid-flow (e.g. picking a ticket quantity) normally continues
  // that same flow — "2" or "yes" must reach the service that asked the
  // question, not generic intent classification. BUT that can't be
  // unconditional, or the user gets trapped forever: an explicit "cancel"
  // or a message that classifies as a genuinely different, real intent
  // (wallet/ticket/event/support) must be able to break out of whatever
  // flow they were in. Without this check, state always won and new
  // intents were silently discarded — that was the bug.
  if (state) {
    const text = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
    const isExplicitCancel = GLOBAL_INTERRUPT_KEYWORDS.some(keyword => text.includes(keyword))

    if (isExplicitCancel) {
      await stateService.clearState(message.from)
      return buildCancelledReply()
    }

    // A button tap can only ever be answering whatever prompt the currently
    // active flow just showed — a tap meant to switch services (the main
    // services list, row_1..row_5, or a Passport overview row) is already
    // intercepted above, before state is even consulted. So if we get here
    // WITH an interactiveId, the button was generated by the owning flow
    // itself, and the raw classifier result must never be allowed to
    // override that, no matter what it guessed from the button's bare
    // title text.
    //
    // This is what protects states like order_awaiting_schedule_choice
    // ("Collect Now" / "Schedule Later") and order_awaiting_topup_or_card
    // ("Card" / "Top up Passport") — both read, out of context, as
    // plausible "wallet" intent to the classifier (no per-turn state is
    // ever included in its prompt), and neither had a bespoke keyword
    // guard like isAnsweringPaymentMethodPrompt. Without this, a
    // misclassified button tap silently cleared the in-progress order/cart
    // state and handed the customer to a different service mid-checkout.
    // Free-text replies are NOT covered by this — someone typing their way
    // out of a flow into a genuinely different request must still be able
    // to, via the checks below.
    const isButtonReply = Boolean(message.interactiveId)

    const owningIntent = resolveOwningIntent(state.state)
    const isGenuinelyNewIntent =
      !isButtonReply &&
      !!intent?.intent &&
      !!intentHandlers[intent.intent] &&
      owningIntent !== null &&
      intent.intent !== owningIntent &&
      !isAnsweringPaymentMethodPrompt(state.state, text) &&
      !isAnsweringTicketMenuPrompt(state.state, text) &&
      !isEventIntentNoiseDuringTicketFlow(owningIntent, intent) &&
      !isAnsweringShishaPrompt(state.state, text) &&
      !isAnsweringVvipFinalConfirmPrompt(state.state) &&
      !isAnsweringVvipPostBookingPrompt(state.state)

    if (isGenuinelyNewIntent) {
      if (ON_PREMISE_ONLY_INTENTS.has(intent.intent) && !isVenueOpenNow()) {
        return buildVenueClosedReply()
      }
      await stateService.clearState(message.from)
      return intentHandlers[intent.intent](intent, message)
    }

    return delegateState(state, message)
  }

  // ── INTENT ROUTING ────────────────────────────────────────────────
  const handler = intent?.intent ? intentHandlers[intent.intent] : undefined
  if (!handler) return buildUnknownIntentReply(message)

  if (intent.intent && ON_PREMISE_ONLY_INTENTS.has(intent.intent) && !isVenueOpenNow()) {
    return buildVenueClosedReply()
  }

  return handler(intent, message)
}
