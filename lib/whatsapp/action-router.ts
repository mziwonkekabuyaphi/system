// lib/whatsapp/action-router.ts
/**
 * QLess Action Router — booking / queue / status / cancel / profile, tenant-scoped.
 * -----------------------------------------------------------------------
 * Still a PURE DISPATCHER: it decides WHICH service handles a message and
 * hands off. No business logic lives here.
 *
 * CLOSED HOURS: when the shop is closed (business_hours, via is_tenant_open_now)
 * the greeting says so nicely, says when we open again, and that booking is
 * still open; the "Join Queue" row is left off that greeting's menu because
 * the walk-in queue only runs while the shop is open.
 *
 * FIRST CONTACT (new): a customer who says "hi" — or sends anything we
 * can't map to a real intent — gets TWO WhatsApp messages, the same pattern
 * the old Rands bot used:
 *   1. a short smart greeting + their first name + a line welcoming them to
 *      the shop + the shop's own web link (the main `reply`), then
 *   2. the six-row interactive menu (Book Now / Join Queue / Check Status /
 *      Reschedule / Cancel Now / My Profile), attached as `followUp`.
 * lib/whatsapp/send-action-result.ts is what actually delivers the follow-up.
 * An explicit "menu" / "start over" (or a bare "cancel" while a booking is
 * half-done) also shows the menu, with a shorter lead-in instead of the greeting.
 *
 * RESCHEDULE (new): a typed "reschedule" / "move my booking" request opens the
 * move-my-booking flow (lib/services/reschedule.ts) before anything else, and
 * the reschedule_* states are owned by that service.
 *
 * WAITLIST (new): the "See times" button on a waitlist alert ("wl_book:<id>")
 * is handled before anything else (step 0a below), by lib/services/waitlist-reply.ts.
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
import { RESCHEDULE_REQUEST_PATTERN, rescheduleService } from "@/lib/services/reschedule"
import { REMINDER_TAP_PATTERN, handleReminderTap } from "@/lib/services/reminder-reply"
import { WAITLIST_TAP_PATTERN, handleWaitlistTap } from "@/lib/services/waitlist-reply"
import { profileService } from "@/lib/services/profile"
import { shishaService } from "@/lib/services/shisha"
import { passportService } from "@/lib/services/passport"
import { eventTicketsService } from "@/lib/services/event-tickets"
import { getStaffForPhone, staffBotService, STAFF_ID_PREFIX, STAFF_MAIN_MENU_TAP } from "@/lib/services/staff-bot"
import { conciergeService } from "@/lib/ai/concierge"
import { detectShopFaq } from "@/lib/ai/shop-faq"

import { stateService, type ConversationState } from "@/lib/services/state"
import { getCustomer, type Customer } from "@/lib/services/tenant-customer"

import { getSmartGreeting } from "@/lib/whatsapp/greeting"
import { buildServicesListMessage, MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"
import { describeWebActions, getTenantWebLinkInfo, type TenantWebLinkInfo } from "@/lib/whatsapp/utils/tenant-web-link"
import { getOpenStatus } from "@/lib/whatsapp/utils/business-hours"
import { isAiEnabledForTenant } from "@/lib/ai/settings"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { getEnabledProducts } from "@/lib/services/plans"

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
// shishaService owns exactly the "shisha_*" states; it is only reachable for tenants
// with the module on (guard at the top of routeAction + a check inside the service).
const stateHandlers: StatefulService[] = [bookingService, queueService, cancelService, rescheduleService, shishaService]

const intentHandlers: Record<string, Handler> = {
  booking: bookingService.handleBooking.bind(bookingService),
  status: statusService.handleStatus,
  cancel: cancelService.handleCancel,
  // Stateless: one live read in, one message out (no state to own).
  profile: profileService.handleProfile,
  // Module-gated: never reached for a tenant without "shisha" (see routeAction step -1).
  shisha: shishaService.handle,
  // Module-gated ("wallet"): never reached for a tenant without it (see routeAction step -1a).
  // Stateless: one live read in, the Passport message + the menu out.
  wallet: passportReply,
  // Module-gated ("events"): never reached for a tenant without it (see routeAction step -1a2).
  // Stateless and read-only for now: the events on sale, or the customer's own tickets.
  events: eventTicketsService.handle,
}

/**
 * Menu row id -> handler. A tap on the menu is never ambiguous (we built the
 * menu), so it is routed deterministically here instead of through AI intent
 * classification. Row ids come from MENU_ROW_IDS in services-list.ts.
 */
const MENU_ROW_HANDLERS: Record<string, Handler> = {
  // Passing the phone lets a returning customer see the one-tap "Same again?" offer
  // before the services list (booking.ts's offerSameAgain; null = normal flow).
  [MENU_ROW_IDS.book]: (tenantId, _intent, message) =>
    bookingService.startBookingFlow(tenantId, undefined, message.from),
  // Phone passed so a shop with "No services" on joins the line in one step.
  [MENU_ROW_IDS.queue]: (tenantId, _intent, message) => queueService.startQueueFlow(tenantId, message.from),
  [MENU_ROW_IDS.status]: statusService.handleStatus,
  [MENU_ROW_IDS.reschedule]: rescheduleService.handleReschedule,
  [MENU_ROW_IDS.cancel]: cancelService.handleCancel,
  [MENU_ROW_IDS.profile]: profileService.handleProfile,
  [MENU_ROW_IDS.shisha]: (tenantId, _intent, message) => shishaService.startShishaFlow(tenantId, message.from),
  [MENU_ROW_IDS.wallet]: passportReply,
  [MENU_ROW_IDS.events]: eventTicketsService.handle,
}

// `unhandled: true` marks a genuine "we don't know what to do" reply —
// handover.ts's shouldEscalate() uses this flag, not raw intent confidence.
// A function, not a constant: the menu it carries depends on which modules the tenant has on.
async function unknownStateReply(tenantId: string, phone?: string): Promise<ActionResult> {
  const [shisha, wallet, events, products, staffIdentity] = await Promise.all([
    isModuleEnabled(tenantId, "shisha"),
    isModuleEnabled(tenantId, "wallet"),
    isModuleEnabled(tenantId, "events"),
    getWhatsAppProducts(tenantId),
    phone ? getStaffForPhone(tenantId, phone) : Promise.resolve(null),
  ])
  const staff = staffIdentity !== null
  return {
    reply: "I couldn't continue your previous request, so let's start again. How can I help you today?",
    buttons: [],
    nextState: null,
    unhandled: true,
    followUp: [
      withoutRows(buildServicesListMessage("Tap below to choose what you'd like to do 👇", { shisha, staff, wallet, events }), hiddenMenuRows(products)),
    ],
  }
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
const PLAIN_ANSWER_PATTERN = /^(\d{1,2}|y|n|yes|no|yeah|yep|nope|ok|okay|sure|ewe|yebo|ja|hayi|cha|nee)[.!]*$/

/**
 * Maps a state name to the intent that owns it (by naming convention).
 * Used only to answer "is this message a genuinely DIFFERENT intent from the
 * flow the customer is already in?". null = unknown -> don't switch.
 */
function resolveOwningIntent(stateName: string): Intent | null {
  if (stateName.startsWith("booking_")) return "booking"
  if (stateName.startsWith("queue_")) return "booking"
  // Moving a booking is part of the booking family: another intent (status,
  // cancel...) can still take over, a plain answer never does.
  if (stateName.startsWith("reschedule_")) return "booking"
  if (stateName.startsWith(CANCEL_STATE_PREFIX)) return "cancel"
  if (stateName.startsWith("shisha_")) return "shisha"
  return null
}

/**
 * A shop question worth sending to the AI answerer: multi-word or an explicit
 * question. Keeps one-word noise ("thanks", "next") from costing an AI call.
 */
function looksLikeShopQuestion(text: string): boolean {
  // A one-word "prices" / "hours" / "address" is answered from shop data for free.
  return text.includes("?") || text.split(/\s+/).filter(Boolean).length >= 2 || detectShopFaq(text) !== null
}

/**
 * "thanks" / "thank you" / "baie dankie" are classified as "support" by the
 * intent router's global shortcut (reasoning "Global: thanks"). They are never
 * a shop question, so skip the concierge: it would only answer HANDOFF and
 * cost an AI call for nothing. The flow then falls through exactly as it did
 * after a HANDOFF (mid-flow: the state's owner; no flow: greeting + menu).
 */
function isThanksIntent(intent: RoutedIntent | null | undefined): boolean {
  return intent?.reasoning === "Global: thanks"
}

/** First name for the greeting, or "there" for a nameless/unknown customer. */
function firstNameFromCustomer(customer: Customer | null): string {
  if (!customer?.name) return "there"
  return customer.name.trim().split(/\s+/)[0] || "there"
}

const MENU_PROMPT = "Tap below to choose what you'd like to do 👇"

/**
 * The text above the menu. When the shop's AI is on it also tells customers
 * they can skip the menu and just write what they want, in their own
 * language. With AI off (or if that can't be checked) it is the plain prompt,
 * so we never promise something the bot won't do.
 */
async function menuPromptFor(tenantId: string): Promise<string> {
  try {
    if (!(await isAiEnabledForTenant(tenantId))) return MENU_PROMPT
  } catch {
    return MENU_PROMPT
  }
  return `${MENU_PROMPT}\n\nOr just type what you need in your own words and I'll take care of it.`
}

type ServicesMenu = ReturnType<typeof buildServicesListMessage>

/** Which of the shop's WhatsApp products are switched on (tenant_modules). Fails closed. */
async function getWhatsAppProducts(tenantId: string): Promise<{ booking: boolean; queue: boolean }> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return { booking: false, queue: false }
  const products = await getEnabledProducts(supabase, tenantId)
  return { booking: products.booking, queue: products.queue }
}

/** Removes the given rows from the menu (by MENU_ROW_IDS value). */
function withoutRows(menu: ServicesMenu, hidden: Set<string>): ServicesMenu {
  if (!menu.list || hidden.size === 0) return menu
  return {
    ...menu,
    list: {
      ...menu.list,
      sections: menu.list.sections
        .map((section) => ({ ...section, rows: section.rows.filter((row) => !hidden.has(row.id)) }))
        .filter((section) => section.rows.length > 0),
    },
  }
}

/** Rows a shop must NOT see: products that are off, plus Join Queue while closed. */
function hiddenMenuRows(products: { booking: boolean; queue: boolean }, queueClosedNow = false): Set<string> {
  const hidden = new Set<string>()
  if (!products.booking) {
    hidden.add(MENU_ROW_IDS.book)
    hidden.add(MENU_ROW_IDS.reschedule)
  }
  if (!products.queue || queueClosedNow) hidden.add(MENU_ROW_IDS.queue)
  // Status / Cancel only mean something when the shop takes bookings or queue entries.
  if (!products.booking && !products.queue) {
    hidden.add(MENU_ROW_IDS.status)
    hidden.add(MENU_ROW_IDS.cancel)
  }
  return hidden
}

/** Typed words that mean "the walk-in queue" (same words booking.ts treats as a queue request). */
const QUEUE_WORDS = /\b(queue|walk[\s-]?in|walkin)\b/

const BOOKING_OFF_REPLY = "Sorry, this shop doesn't take bookings here."
const QUEUE_OFF_REPLY = "Sorry, this shop doesn't use a walk-in queue here."
const NOTHING_ON_REPLY = "Sorry, this shop doesn't take bookings or queue entries on WhatsApp."

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
  const [shishaOn, walletOn, eventsOn, products, staffIdentity] = await Promise.all([
    isModuleEnabled(tenantId, "shisha"),
    isModuleEnabled(tenantId, "wallet"),
    isModuleEnabled(tenantId, "events"),
    getWhatsAppProducts(tenantId),
    getStaffForPhone(tenantId, message.from),
  ])
  const baseMenu = buildServicesListMessage(await menuPromptFor(tenantId), {
    shisha: shishaOn,
    wallet: walletOn,
    events: eventsOn,
    staff: staffIdentity !== null,
  })
  // Only offer what this shop actually runs (a Booking-only shop never sees Join Queue, and so on).
  const menu = withoutRows(baseMenu, hiddenMenuRows(products))

  // Neither Booking nor Queue (e.g. a shisha-only venue): nothing to book or queue for here.
  // A shop with only the Passport on still has something to offer (balance), so it is not a dead end.
  if (!products.booking && !products.queue && !shishaOn && !walletOn && !eventsOn) {
    // A verified staff member of a staff-only shop gets the staff menu instead of a dead end.
    if (staffIdentity) return staffBotService.entry(tenantId, staffIdentity)
    return { reply: NOTHING_ON_REPLY, buttons: [], nextState: null }
  }

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
  let webLink: TenantWebLinkInfo | null = null
  try {
    const supabase = getSupabaseServerClient()
    if (supabase) {
      const [tz, tenantRow, brandingRow, link] = await Promise.all([
        getTenantTimezone(supabase, tenantId),
        supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
        supabase.from("tenant_branding").select("display_name").eq("tenant_id", tenantId).maybeSingle(),
        getTenantWebLinkInfo(tenantId),
      ])
      timeZone = tz
      // The Display name owners set under Settings > Branding wins; fall back
      // to the tenant's own name.
      shopName = brandingRow.data?.display_name?.trim() || tenantRow.data?.name || null
      // Each tenant's own link (null when their web page is not available, e.g. shisha-only).
      webLink = link
    }
  } catch (error) {
    console.error("[action-router] greeting context lookup failed:", error)
  }

  const openStatus = await getOpenStatus(tenantId)

  const greeting = getSmartGreeting({ timeZone, isReturning })
  // What this shop can do for the customer, built from the products it runs, so
  // every mix reads naturally (Booking only, Queue + Shisha, Shisha only, ...).
  // Closed: no mention of joining the queue; the note below explains it instead.
  const can: string[] = []
  if (products.booking) can.push("book an appointment")
  if (products.queue && !openStatus.isClosed) can.push("join the walk-in queue")
  if (shishaOn) can.push("start a shisha session")
  if (walletOn) can.push("check your Passport balance")
  if (eventsOn) can.push("see upcoming events and your tickets")
  const orList = (items: string[]) =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`
  const helpLine = can.length > 0 ? `I can help you ${orList(can)}.` : ""
  const queueClosedOnly = products.queue && !products.booking && openStatus.isClosed
  const canDo = queueClosedOnly ? `The walk-in queue is closed right now.${helpLine ? ` ${helpLine}` : ""}` : helpLine
  const welcomeLine = shopName ? `Welcome to *${shopName}*. ${canDo}` : `Welcome! ${canDo}`
  const closedLine = openStatus.isClosed && (products.booking || products.queue) ? `\n\n${openStatus.note}` : ""
  // Only for shops whose web page works, worded for what that page offers.
  const webLine = webLink ? `\n\nPrefer to ${describeWebActions(webLink)} online? You can also use ${webLink.link}` : ""

  return {
    reply: `${greeting} ${firstName}! 👋\n\n${welcomeLine}${closedLine}${webLine}`,
    buttons: [],
    nextState: null,
    followUp: [openStatus.isClosed ? withoutRows(menu, new Set([MENU_ROW_IDS.queue])) : menu],
  }
}

/**
 * Passport answer + the same menu the greeting shows (filtered to what the shop runs),
 * so the customer is never left at a dead end after reading their balance. A function
 * declaration on purpose: intentHandlers / MENU_ROW_HANDLERS above reference it.
 */
async function passportReply(tenantId: string, intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  const result = await passportService.handle(tenantId, intent, message)
  try {
    const menu = await buildEntryReply(tenantId, message, false)
    return menu.followUp?.length ? { ...result, followUp: menu.followUp } : result
  } catch (error) {
    console.error("[action-router] passport follow-up menu failed:", error)
    return result
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
  return unknownStateReply(tenantId, message.from)
}

export async function routeAction(
  tenantId: string,
  intent: RoutedIntent,
  state: ConversationState | null,
  message: IncomingMessage,
): Promise<ActionResult> {
  // ── -2. STAFF AREA (module "shifts") ──────────────────────────────
  // Staff taps, staff keywords, open staff conversations and the YES that verifies a
  // staff number are handled by lib/services/staff-bot.ts, which answers null for
  // everything else (customers are never affected). Old menus stay in the chat, so
  // when the Shifts module is off a stale staff tap / staff state is cleared and the
  // person gets a fresh menu instead of a dead end.
  {
    const tapId = message.interactiveId ?? ""
    const staffTap = tapId.startsWith(STAFF_ID_PREFIX) || tapId === MENU_ROW_IDS.staff
    const staffState = Boolean(state?.state.startsWith(STAFF_ID_PREFIX))
    if (tapId === STAFF_MAIN_MENU_TAP) {
      await stateService.clearState(tenantId, message.from)
      return buildEntryReply(tenantId, message, false)
    }
    if ((staffTap || staffState) && !(await isModuleEnabled(tenantId, "shifts"))) {
      await stateService.clearState(tenantId, message.from)
      const fresh = await buildEntryReply(tenantId, message, false)
      return { ...fresh, reply: "Sorry, that service isn't available right now. What would you like to do instead?" }
    }
    if (staffTap) await stateService.clearState(tenantId, message.from)
    const staffResult = await staffBotService.route(tenantId, state, message)
    if (staffResult) return staffResult
  }

  // ── -1. MODULE GATE (shisha) ───────────────────────────────────────
  // Hiding the menu row is not enough: WhatsApp list messages stay in the
  // chat, so a customer can scroll up and tap an OLD menu that still has the
  // Shisha row; or the shop can switch the module off while the customer is
  // mid-flow. Either way: clear state, say it's unavailable, show a fresh
  // menu (which no longer has the row). A typed "shisha" intent is downgraded
  // to "support" so the concierge/greeting handles it like any other question.
  if (!(await isModuleEnabled(tenantId, "shisha"))) {
    const staleTap = message.interactiveId === MENU_ROW_IDS.shisha
    const midFlow = Boolean(state?.state.startsWith("shisha_"))
    if (staleTap || midFlow) {
      await stateService.clearState(tenantId, message.from)
      const fresh = await buildEntryReply(tenantId, message, false)
      return { ...fresh, reply: "Sorry, that service isn't available right now. What would you like to do instead?" }
    }
    if (intent?.intent === "shisha") {
      intent = { ...intent, intent: "support" }
    }
  }

  // ── -1a. MODULE GATE (wallet / Passport) ───────────────────────────
  // Same idea as the shisha gate. Passport has no conversation states (it is one read in,
  // one message out), so only two things can arrive for a shop that has it off: a tap on an
  // OLD menu that still has the My Passport row, or a typed "balance" classified as the
  // wallet intent. The switch is only read when one of those two happens, so every other
  // message pays nothing for this gate.
  if (
    (message.interactiveId === MENU_ROW_IDS.wallet || intent?.intent === "wallet") &&
    !(await isModuleEnabled(tenantId, "wallet"))
  ) {
    if (message.interactiveId === MENU_ROW_IDS.wallet) {
      await stateService.clearState(tenantId, message.from)
      const fresh = await buildEntryReply(tenantId, message, false)
      return { ...fresh, reply: "Sorry, that service isn't available right now. What would you like to do instead?" }
    }
    // A typed request is handled like any other question (concierge / greeting + menu).
    intent = { ...intent, intent: "support" }
  }

  // ── -1a2. MODULE GATE (events) ─────────────────────────────────────
  // Same shape as the Passport gate above. Events is stateless for now, so only a tap on an
  // OLD menu with the Events row, or a typed "my tickets" / "events" classified as the events
  // intent, can reach a shop that has it off. Read the switch only in those two cases.
  if (
    (message.interactiveId === MENU_ROW_IDS.events || intent?.intent === "events") &&
    !(await isModuleEnabled(tenantId, "events"))
  ) {
    if (message.interactiveId === MENU_ROW_IDS.events) {
      await stateService.clearState(tenantId, message.from)
      const fresh = await buildEntryReply(tenantId, message, false)
      return { ...fresh, reply: "Sorry, that service isn't available right now. What would you like to do instead?" }
    }
    intent = { ...intent, intent: "support" }
  }

  // ── -1b. MODULE GATE (booking / queue) ─────────────────────────────
  // Same idea as the shisha gate above, for the two other products. The menu no
  // longer offers a switched-off product, but old menus stay in the chat and a
  // shop can flip a switch while a customer is mid-flow. Stale tap, typed request
  // or in-flight state for a product that is off -> clear state, say so in one
  // friendly line, and show a fresh menu with only what the shop runs.
  {
    const products = await getWhatsAppProducts(tenantId)
    if (!products.booking || !products.queue) {
      const tapId = message.interactiveId
      const stateName = state?.state ?? ""
      const typed = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
      const bookingBlocked =
        !products.booking &&
        (tapId === MENU_ROW_IDS.book ||
          tapId === MENU_ROW_IDS.reschedule ||
          stateName.startsWith("booking_") ||
          stateName.startsWith("reschedule_") ||
          (!state && intent?.intent === "booking" && !(products.queue && QUEUE_WORDS.test(typed))) ||
          (!tapId && Boolean(typed) && RESCHEDULE_REQUEST_PATTERN.test(typed)))
      // A typed queue request ("join the queue") arrives as the "booking" intent, so a
      // queue-only shop must send it to the queue instead of refusing it as a booking.
      if (!products.booking && products.queue && !state && !tapId && intent?.intent === "booking" && QUEUE_WORDS.test(typed)) {
        return queueService.startQueueFlow(tenantId, message.from)
      }
      const queueBlocked = !products.queue && (tapId === MENU_ROW_IDS.queue || stateName.startsWith("queue_"))

      if (bookingBlocked || queueBlocked) {
        await stateService.clearState(tenantId, message.from)
        const fresh = await buildEntryReply(tenantId, message, false)
        // A queue-only shop's typed "I want a haircut" is a booking request it can't take.
        const lead = bookingBlocked ? BOOKING_OFF_REPLY : QUEUE_OFF_REPLY
        return fresh.followUp?.length ? { ...fresh, reply: `${lead} What would you like to do instead?` } : fresh
      }
    }
  }

  // ── 0. REMINDER BUTTON TAP ("Confirm" / "Can't make it") ───────────
  // Carries the booking id in the button id, so it works with no conversation
  // open (the reminder was sent by the system, not as part of a flow) and must
  // never be mistaken for a reply to whatever flow the customer last left open.
  if (message.interactiveId && REMINDER_TAP_PATTERN.test(message.interactiveId)) {
    await stateService.clearState(tenantId, message.from)
    return handleReminderTap(tenantId, message)
  }

  // ── 0a. WAITLIST "SEE TIMES" TAP ───────────────────────────────────
  // Sent by the waitlist-notify edge function when a booked time frees up.
  // Carries the waitlist entry id in the button id, so like the reminder taps
  // it works with no conversation open. An expired offer gets a polite
  // "sorry, that offer has expired"; a live one jumps into the normal booking
  // flow at the time-picking step (lib/services/waitlist-reply.ts).
  if (message.interactiveId && WAITLIST_TAP_PATTERN.test(message.interactiveId)) {
    await stateService.clearState(tenantId, message.from)
    return handleWaitlistTap(tenantId, message)
  }

  // ── 0b. TYPED RESCHEDULE REQUEST ("reschedule", "move my booking") ──
  // Deterministic, like the menu taps: it never goes through AI classification
  // (which used to hand it to a human as "support"). Works with or without a
  // conversation open; whatever the customer was doing is cleared first.
  if (!message.interactiveId) {
    const typed = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
    if (typed && RESCHEDULE_REQUEST_PATTERN.test(typed)) {
      await stateService.clearState(tenantId, message.from)
      return rescheduleService.handleReschedule(tenantId, intent, message)
    }
  }

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

    // 2c-0. A shop question mid-flow ("what time do you close?") gets an
    // answer from the shop's own data and the customer's booking/queue/cancel
    // state is left exactly where it was. Only for typed, multi-word text the
    // classifier called "support"; if the AI can't answer, falls through.
    if (
      intent?.intent === "support" &&
      !isThanksIntent(intent) &&
      !isButtonReply &&
      !PLAIN_ANSWER_PATTERN.test(text) &&
      looksLikeShopQuestion(text)
    ) {
      const answered = await conciergeService.answerShopQuestion(tenantId, message, state)
      if (answered) return answered
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
  // "support" with a shop question in it: answer from the shop's data, in the
  // customer's language. null (AI off / failed / not in the data) means the
  // behaviour is exactly what it was before: greeting + menu.
  if (intent?.intent === "support" && !isThanksIntent(intent) && !message.interactiveId) {
    const text = (message.contentSummary ?? message.text ?? "").trim()
    if (looksLikeShopQuestion(text)) {
      const answered = await conciergeService.answerShopQuestion(tenantId, message, null)
      if (answered) return answered
    }
  }

  const handler = intent?.intent ? intentHandlers[intent.intent] : undefined
  if (!handler) return buildEntryReply(tenantId, message, true)

  return handler(tenantId, intent, message)
}
