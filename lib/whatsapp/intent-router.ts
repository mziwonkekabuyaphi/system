import { generateObject } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"

/**
 * Intent router — the "brain" layer of the QLess WhatsApp assistant for
 * salons and barbershops (multi-tenant appointment booking + walk-in queue).
 *
 * Hybrid AI routing: this module uses an AI model to classify an inbound
 * WhatsApp message into a high-level intent. Classification ONLY — the
 * model is not asked to draft replies, call tools, or hold memory here. Its
 * single job is to improve message → intent accuracy.
 *
 * The result drives downstream services (booking / queue / support). This
 * layer is intentionally lightweight: exactly one model call, with a safe
 * deterministic fallback if anything goes wrong.
 *
 * INTENT MODEL (QLess): six intents.
 *   - "booking": scheduling an appointment OR joining today's walk-in queue.
 *     Queue is deliberately not its own intent — booking.ts's handleBooking
 *     decides: a clearly typed "queue" goes straight to the queue flow, a
 *     clearly typed "book" straight to the booking flow, anything ambiguous
 *     gets the Queue-or-Book question.
 *   - "status": "check my booking", "where am I in the queue" -> status.ts.
 *   - "cancel": "cancel my appointment", "leave the queue" -> cancel.ts.
 *   - "profile": "my profile", "my visits" -> profile.ts (stateless overview
 *     of their booking, queue spot and visit history).
 *   - "support": everything that needs a human — complaints, rescheduling,
 *     running late, shop questions.
 *   - "unknown": greetings and chit-chat (shows the welcome + menu).
 * The five-row WhatsApp menu (Book Now / Join Queue / Check Status / Cancel
 * Now / My Profile) does NOT go through this file at all — action-router.ts routes menu
 * taps by row id.
 *
 * Architecture:
 *   webhook (thin layer)
 *     ↓
 *   reply.ts                        ← resolves tenant, loads context & state
 *     ↓
 *   intent-router (brain layer)     ← this file
 *     ↓
 *   action-router
 *     ↓
 *   services (booking / queue)
 *
 * This file performs NO database or memory lookups of its own, and knows
 * nothing about which tenant (shop) the message belongs to. `reply.ts`
 * already loads conversation context and state before calling
 * {@link routeIntent}; if that context is useful for classification, it is
 * read directly from the supplied parameter — never fetched here.
 *
 * Routing Pipeline (in order):
 *   1. GREETINGS/THANKS - Global shortcuts that always mean the same thing
 *   2. CONTEXT CONTINUATION - Ambiguous replies inherit intent from the
 *      already-loaded conversation context (no I/O — read-only)
 *   3. INTENT FAST-PATH - Clear intent signals that don't need AI. Skipped
 *      entirely for continuation-style messages ("2", "yes", "tomorrow") so
 *      a confident fast-path rule never overrides context that just wasn't
 *      resolvable in step 2 (e.g. no context was supplied at all).
 *   4. AI CLASSIFICATION - Catch-all for complex/non-obvious messages.
 *      The model's raw confidence is never trusted blindly: low-confidence
 *      results are reconciled against conversation context, and model
 *      failures (throws/timeouts) fall back to context before falling
 *      back to a generic "unknown" result.
 *
 * Decision-stability rules layered on top of the above (see inline
 * comments at each usage site for the exact thresholds):
 *   - Strong context override: an ambiguous/continuation message combined
 *     with a weak AI result defers to conversation context outright.
 *   - Confidence gating: any AI result below the trust threshold is
 *     reconciled against context (or downgraded) rather than propagated.
 *   - Low-confidence floor: any final result below 0.5 confidence is
 *     normalized to a single canonical "unknown" fallback shape, so
 *     downstream layers only ever have to handle one low-confidence case.
 */


/** The intent categories the assistant understands. */
const INTENTS = [
  "booking", // Book an appointment OR join today's walk-in queue. Both
             // start here: booking.ts asks "Queue or Book?" and hands off
             // to queue.ts itself, so there is no separate "queue" intent.
  "status",  // Check their own booking and/or place in the queue
  "cancel",  // Cancel their booking or leave the queue
  "profile", // Their own overview: upcoming booking, queue spot, visit history
  "support", // Needs a human: complaints, reschedule, running late, shop questions
  "unknown", // Greetings, chit-chat, or not enough information
] as const

export type Intent = (typeof INTENTS)[number]

export interface RoutedIntent {
  intent: Intent
  confidence: number
  reasoning?: string
}

/**
 * Conversation context needed for intent classification, already loaded
 * upstream by `reply.ts` (via contextService / stateService) before the
 * intent router is invoked.
 *
 * The intent router only ever reads from this object — it never fetches,
 * refreshes, or mutates it, and it never calls another service to obtain
 * it. If a future classification step needs more conversation context,
 * extend this interface rather than reaching for an import.
 */
export interface IntentRouterContext {
  /** The most recently resolved intent for this conversation, if known. */
  lastIntent?: string | null
}

/** Deterministic fallback used whenever the AI model can't be consulted. */
const FALLBACK: RoutedIntent = {
  intent: "unknown",
  confidence: 0,
}

/** Sentinel value used to detect that the timeout race finished first. */
const TIMEOUT_SENTINEL = Symbol("intent-classification-timeout")

// ── Confidence & Stability Thresholds ────────────────────────────────
// These govern how much we trust a raw AI result versus falling back
// to conversation context or a generic "unknown". Centralized here so the
// numbers are easy to find and tune without hunting through the pipeline.

/**
 * Below this, an AI result combined with ambiguous/continuation text
 * ("2", "yes", "tomorrow") is considered weaker evidence than conversation
 * context, and context wins outright.
 */
const CONTEXT_OVERRIDE_CONFIDENCE_THRESHOLD = 0.7

/**
 * Below this, a raw AI result is not trusted on its own regardless of
 * message shape — it's reconciled against context if any exists, or
 * downgraded to a low-confidence "unknown" if not.
 */
const CONFIDENCE_GATE_THRESHOLD = 0.65

/**
 * Any final RoutedIntent below this confidence is normalized to a single
 * canonical low-confidence fallback shape before being returned, so
 * downstream layers only ever have to handle one "I'm not sure" case.
 */
const LOW_CONFIDENCE_FLOOR = 0.5

/** The canonical shape used whenever a result's confidence falls below {@link LOW_CONFIDENCE_FLOOR}. */
const LOW_CONFIDENCE_FALLBACK: RoutedIntent = {
  intent: "unknown",
  confidence: 0.4,
  reasoning: "Low confidence classification fallback",
}

// ── Step 1: Greetings & Thanks (Global Shortcuts) ────────────────────
// These are always the same regardless of context. "Hi" is always "hi".
// "Thanks" is always gratitude. These run FIRST because they're universal.

const GREETINGS = new Set([
  "hi", "hello", "hey", "howzit",
  "good morning", "good afternoon", "good evening",
])
const THANKS = new Set(["thanks", "thank you", "thx", "thank"])

function checkGreetingOrThanks(text: string): RoutedIntent | null {
  const normalized = text.trim().toLowerCase()

  if (GREETINGS.has(normalized)) {
    return { intent: "unknown", confidence: 1, reasoning: "Global: greeting" }
  }

  if (THANKS.has(normalized)) {
    return { intent: "support", confidence: 1, reasoning: "Global: thanks" }
  }

  return null
}

// ── Step 2: Context Continuation ─────────────────────────────────────
// Short, ambiguous replies ("2", "yes", "tomorrow") can't be classified in
// isolation — they only make sense in the context of the conversation.
// This runs BEFORE the intent fast-path so "yes" during a booking
// confirmation stays as "booking", not "support".
//
// Unlike the old memory-lookup step, this performs NO I/O: the context is
// already loaded by reply.ts and handed in via the `context` parameter.

const CONTINUATION_KEYWORDS = new Set([
  "yes", "y", "no", "n", "yeah", "yep", "nope",
  "ok", "okay", "sure",
  "same", "that one", "this one",
  "continue", "next", "tomorrow", "today",
  "1", "2", "3", "4", "5",
])
// NOTE: "book" / "queue" are deliberately NOT continuation keywords. They are
// clear fast-path signals (see BOOKING_PHRASES below), and anything in this
// set skips the fast-path entirely.

function isContinuationText(rawText: string): boolean {
  const normalized = rawText.trim().toLowerCase()
  if (!normalized) return false
  if (CONTINUATION_KEYWORDS.has(normalized)) return true
  if (/^\d{1,3}$/.test(normalized)) return true
  return false
}

/**
 * True when `value` is one of the concierge's known intents. Centralizes
 * the validity check so every context-based override (context
 * continuation, strong context override, AI-failure hardening) agrees
 * on what counts as a usable `context.lastIntent`.
 */
function isValidIntent(value: string | null | undefined): value is Intent {
  if (!value) return false
  return (INTENTS as readonly string[]).includes(value)
}

/**
 * Resolves an ambiguous message using the already-loaded conversation
 * context. Returns a RoutedIntent if the supplied context makes the
 * message unambiguous, or null if not applicable.
 *
 * Context is only ever allowed to resolve short/ambiguous "continuation"
 * text (isContinuationText === true) — a long, full-sentence message is
 * never overridden by stale context, even if one is supplied.
 *
 * This function is synchronous and side-effect free — it never fetches
 * context itself, it only reads the `context` parameter it was given.
 */
function resolveFromContext(text: string, context?: IntentRouterContext): RoutedIntent | null {
  if (!isValidIntent(context?.lastIntent)) return null
  if (!isContinuationText(text)) return null

  return {
    intent: context!.lastIntent as Intent,
    confidence: 0.95,
    reasoning: "Resolved using supplied conversation context.",
  }
}

// ── Step 3: Intent Fast-Path ──────────────────────────────────────────
// Clear intent signals that don't need AI OR context to interpret.
// These run AFTER context resolution so ambiguous replies get context first.
// Example: "yes" during booking confirmation → context says "booking"
//           "yes" as standalone → fast-path says "support"

const AFFIRMATIVE = new Set(["yes", "y", "yeah", "yep"])
const NEGATIVE = new Set(["no", "n", "nope"])
const MENU_SELECTION = new Set(["1", "2", "3", "4", "5", "next", "continue"])

// Short, exact-phrase allowlist for messages that unambiguously mean "I want
// an appointment" or "I want to join the walk-in queue". Both map to the
// "booking" intent — booking.ts then asks the customer which one they want
// (see its handleEntryChoice), so we never need to guess queue-vs-book here.
// Exact match rather than substring on purpose: "book" inside a longer
// sentence ("can I book for my son and his friend tomorrow at 3") is better
// left to the AI classifier, which also sees surrounding words like
// "cancel" that would flip the meaning.
const BOOKING_PHRASES = new Set([
  "book",
  "booking",
  "book now",
  "book appointment",
  "book an appointment",
  "make a booking",
  "make an appointment",
  "appointment",
  "appointments",
  "reserve",
  "reservation",
  "queue",
  "join queue",
  "join the queue",
  "join the line",
  "walk in",
  "walk-in",
  "walkin",
])

// Exact-phrase allowlist for "show me my profile". Compared AFTER
// normalizeForFastPath, so "👤 My Profile" (the menu label) and
// "[button reply] My Profile" both arrive here as plain "my profile".
const PROFILE_PHRASES = new Set([
  "profile",
  "my profile",
  "view profile",
  "view my profile",
  "show profile",
  "show my profile",
  "my account",
  "account",
  "my details",
  "my visits",
  "my visit history",
  "visit history",
])

/**
 * Lowercases and strips punctuation/emoji so "Cancel!", "❌ Cancel Now" and
 * "[button reply] Check Status" all compare as plain words. A leading
 * "[button reply]" / "[interactive reply]" tag (added by
 * buildClassificationText) is removed first — before this, a tapped button
 * could never match a fast-path phrase because of that prefix.
 * Hyphens and apostrophes are kept ("walk-in", "what's").
 */
function normalizeForFastPath(text: string): string {
  return text
    .replace(/^\[(?:button|interactive) reply\]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Words that mean "change or complain about my booking" — a human's job.
// Their presence blocks the cancel/status fast paths so "reschedule my
// booking" or "I'm running late" still reach support via the AI step.
const MANAGE_BLOCKERS = /\b(reschedul\w*|change|move|postpone|late|wrong|complain\w*|problem|issue|refund)\b/

const CANCEL_TARGETS = /\b(booking|bookings|appointment|appointments|queue|line|spot|place|slot|reservation|turn)\b/

const STATUS_EXACT = new Set([
  "status",
  "check status",
  "my status",
  "check my status",
  "booking status",
  "queue status",
  "my booking",
  "my bookings",
  "check booking",
  "check my booking",
  "my appointment",
  "my appointments",
  "check my appointment",
  "my position",
  "my turn",
  "my place in the queue",
  "where am i",
  "where am i in the queue",
  "where am i in line",
])

const STATUS_PATTERNS: RegExp[] = [
  /\b(where|what)\b.*\b(am i|is my|s my)\b.*\b(queue|line|position|turn|place)\b/,
  /\bhow many (people|customers|clients)\b.*\b(in front of me|ahead of me|before me)\b/,
  /\bhow long\b.*\bmy\b.*\b(wait|turn)\b/,
  /\b(check|view|see|show|confirm)\b.*\b(my|the)\b.*\b(booking|bookings|appointment|appointments|queue|position|status|ticket)\b/,
  /\bwhen is my\b.*\b(booking|appointment|turn)\b/,
  /\bam i (still )?(in|on)\b.*\b(queue|line|list)\b/,
]

/**
 * Typed Check Status / Cancel Now requests. Conservative on purpose: only
 * short messages (<= 8 words) that clearly say what they mean. Longer or
 * subtler wording ("cancel my 3pm") is left to the AI step, whose prompt
 * knows about these two intents.
 */
function checkCancelOrStatusFastPath(normalized: string): RoutedIntent | null {
  if (!normalized) return null
  const wordCount = normalized.split(" ").length
  if (wordCount > 8) return null
  if (MANAGE_BLOCKERS.test(normalized)) return null

  // Cancel: "cancel", "cancel now", "cancel my booking", "leave the queue"
  if (/\bcancel\b/.test(normalized) && (wordCount <= 3 || CANCEL_TARGETS.test(normalized))) {
    return { intent: "cancel", confidence: 0.95, reasoning: "Fast-path: cancel request" }
  }
  if (/\b(leave|exit|quit)\b.*\b(queue|line)\b/.test(normalized) || /\b(remove me from|drop out of)\b.*\b(queue|line)\b/.test(normalized)) {
    return { intent: "cancel", confidence: 0.95, reasoning: "Fast-path: leave the queue" }
  }

  // Status: "check my booking", "where am I in the queue"
  if (STATUS_EXACT.has(normalized) || STATUS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { intent: "status", confidence: 0.95, reasoning: "Fast-path: status request" }
  }

  return null
}

function checkIntentFastPath(text: string): RoutedIntent | null {
  const normalized = normalizeForFastPath(text)

  // Cancel / status first: "cancel my appointment" contains a booking word,
  // and must NOT be read as a request for a new booking.
  const manageResult = checkCancelOrStatusFastPath(normalized)
  if (manageResult) return manageResult

  // Profile overview (clear intent)
  if (PROFILE_PHRASES.has(normalized)) {
    return { intent: "profile", confidence: 0.95, reasoning: "Fast-path: profile request" }
  }

  // Appointment / walk-in queue → booking (clear intent)
  if (BOOKING_PHRASES.has(normalized)) {
    return { intent: "booking", confidence: 0.95, reasoning: "Fast-path: booking or queue request" }
  }

  // Affirmative/Negative → support (ambiguous without context, but if we got here
  // it means context couldn't resolve them, so treat as general support)
  if (AFFIRMATIVE.has(normalized) || NEGATIVE.has(normalized)) {
    return { intent: "support", confidence: 0.8, reasoning: "Fast-path: confirmation" }
  }

  // Menu selections → support (likely navigating a menu)
  if (MENU_SELECTION.has(normalized)) {
    return { intent: "support", confidence: 0.9, reasoning: "Fast-path: menu selection" }
  }

  return null
}

// ── Step 4: AI Classification ────────────────────────────────────
// Catch-all for complex messages that didn't match any deterministic rule.

/** Structured output we expect back from the AI classifier. */
const intentSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

const SYSTEM_PROMPT = `
You are the Intent Classification Engine for QLess, a WhatsApp assistant used by salons and barbershops.

ROLE
Your only responsibility is to classify an incoming WhatsApp message into ONE business intent.

You are NOT a chatbot.
You are NOT customer support.
You do NOT answer questions.
You do NOT generate replies.
You do NOT explain your reasoning to customers.
You do NOT invent information.
You do NOT perform business actions.

Your output is consumed by backend services which will execute the correct workflow.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT QLESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

QLess lets customers of a salon or barbershop use WhatsApp to:

• Book an appointment (choose a service, a date, and a time slot)
• Join today's walk-in queue instead of booking a time
• Check their own booking or their place in the queue
• Cancel their booking or leave the queue
• Talk to the shop when they need a person

Each shop has its own services, staff and opening hours. You do not know
which shop a message is for, and you do not need to.

Typical services customers mention: haircut, fade, taper, line-up, trim,
beard trim, shave, braids, cornrows, locs, wash, blow-dry, colour, highlights,
relaxer, treatment, manicure, pedicure, nails, kids cut.

Local phrasing is common. "Howzit" is a greeting. "Is there space" and
"can I come now" are asking for a slot or a place in the queue.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE INTENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

booking
Customer wants an appointment OR wants to join the walk-in queue. Both are
"booking": the booking service itself asks the customer whether they want to
queue or book a time, so never try to split them.

Examples:

book

book an appointment

I need a haircut

can I get a fade tomorrow

any space today

can I come now

join the queue

walk-in

how long is the wait

what services do you offer

appointment for Saturday

reserve a slot

status
Customer wants to CHECK something they already have: their upcoming
appointment, or their own place in the walk-in queue.

Examples:

check my booking

my appointment

when is my appointment

where am I in the queue

what's my position

how many people are in front of me

how long is my wait

am I still in the queue

status

cancel
Customer wants to CANCEL an appointment they already have, or LEAVE the
walk-in queue. (Rescheduling or changing a booking is NOT cancel — that is
support.)

Examples:

cancel

cancel my booking

cancel my appointment

cancel my 3pm

I can't make it, please cancel

leave the queue

remove me from the queue

I don't want to wait anymore, cancel my spot

profile
Customer wants an OVERVIEW of themselves at this shop: their profile, account
details, or visit history, all in one place. (Checking one specific upcoming
appointment or their place in the queue is "status", not "profile".)

Examples:

my profile

show my profile

my account

my details

my visit history

how many times have I been here

support
Customer needs a human, or wants something the booking, queue, status and
cancel flows cannot do on their own.

Examples:

talk to someone

speak to the manager

complaint

problem

issue

help

customer service

reschedule my booking

change my booking time

I'm running late

what time do you open

where are you located

do you take card

the booking message I got was wrong

unknown
Greeting, casual conversation, or insufficient information.

Examples:

hello

hi

howzit

good morning

thanks

ok

lol

😂

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MESSAGE TYPES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The message may not be plain text.

Possible payloads include:

[text]

[image message]

[video message]

[audio message]

[document message]

[button reply]

[interactive reply]

[location message]

Use BOTH the payload type and the accompanying text.

Examples:

[image message]
Haircut I want
→ booking

[image message]
Hairstyle inspiration photo, no other text
→ booking

[image message]
This isn't working
→ support

[button reply]
Book Appointment
→ booking

[button reply]
Join Queue
→ booking

[button reply]
Talk to Support
→ support

[button reply]
Check Status
→ status

[button reply]
Cancel Now
→ cancel

[button reply]
My Profile
→ profile

[location message]
Shop location or directions
→ support

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLASSIFICATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Choose EXACTLY ONE intent.

Never return multiple intents.

Never invent missing information.

If a message is about an appointment or queue spot the customer ALREADY has,
it is never "booking" (they are not asking for a new one):
- cancelling it or leaving the queue → "cancel"
- checking it, or asking where they are in the queue → "status"
- rescheduling, changing, running late, or complaining about it → "support"

If uncertain between booking and support, prefer booking when the customer
is clearly asking for a service, a slot, or a place in the queue.

Examples:

"book a haircut and tell me the price"

Primary customer objective:
booking

"cancel my 3pm"

cancel

"can I move my 3pm to 4pm"

support

"I need help"

support

Only return unknown if there is genuinely insufficient evidence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONFIDENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Confidence should represent certainty.

1.00
Absolutely obvious.

0.90
Very likely.

0.75
Reasonably confident.

0.60
Weak signal.

Below 0.50
Use unknown.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY:

intent
confidence
reasoning

Never return markdown.

Never answer the customer.

Never explain policies.

Never generate conversation.

You are a deterministic business intent classifier for the QLess platform.

Handling non-text payloads:

- "[image message]": often a photo or screenshot. A hairstyle reference photo
  or a picture of the style the customer wants usually means "booking". A
  screenshot of an error, or a caption describing a problem (e.g. "this isn't
  working", "error"), means "support". With no caption and no other signal,
  treat it as ambiguous: lean "support" only if there's no better signal,
  otherwise "unknown".
- "[video message]" / "[document message]" / "[audio message]": apply the
  same reasoning as images — infer from any caption or accompanying text.
  Audio messages with no transcribable text are commonly people explaining
  something verbally or asking a question; with no caption these usually
  lean "support" (a human wanting to talk through something) unless other
  context points elsewhere.
- "[button reply]": the user tapped a button from a previous menu. The
  button label is usually a strong, near-literal signal of intent — trust
  it directly (e.g. "Book Appointment" or "Join Queue" → booking, "Check
  Status" → status, "Cancel Now" → cancel, "Talk to Support" → support).
- "[location message]": the user shared a GPS location/place. Customers
  usually do this to ask where the shop is or to share where they are, which
  needs a person to answer, so it should usually map to "support" — unless
  the shared place/name text clearly relates to booking a service.
- "<type>: no user text available" (any other type with nothing else to go
  on): there is no real signal beyond the message type. Default to
  "unknown" with low confidence.

When in doubt between two intents, prefer the one with more concrete,
specific evidence in the text over a generic catch-all. Only use "unknown"
when there genuinely isn't enough signal to choose another intent.

Return:
- intent: the single best-fitting category.
- confidence: 0..1 reflecting how certain you are.
- reasoning: one short sentence explaining the choice.
`;

/**
 * Builds the text we hand to the AI classifier, in priority order:
 *   1. message.text       (plain text messages)
 *   2. message.caption    (image/video/document captions)
 *   3. message.buttonText (button / interactive replies)
 *   4. message.location   (shared GPS location — name/address if present)
 *   5. `[${type} message] no user text available` (last resort — still
 *      tells the classifier what kind of message this was instead of sending
 *      nothing or an empty string)
 *
 * Returns null only when there's truly nothing to go on (no text, no
 * caption, no button text, no location, and no type), in which case the
 * caller skips the AI call entirely and uses the deterministic fallback.
 *
 * Non-text message types are prefixed (e.g. "[image message] ...") so
 * the classifier has the payload shape as context, which improves classification
 * accuracy for media/button/location messages over sending the caption
 * (or nothing) alone. The prefix format is consistent across every branch
 * — including the final fallback — so the system prompt can pattern-match
 * on "[type message] ..." reliably.
 */
function buildClassificationText(message: {
  text?: string | null
  caption?: string | null
  buttonText?: string | null
  type?: string | null
  location?: {
    name?: string | null
    address?: string | null
  } | null
}): string | null {
  const type = message.type?.trim() || null

  const text = message.text?.trim()
  if (text) return text

  const caption = message.caption?.trim()
  if (caption) {
    return type && type !== "text" ? `[${type} message] ${caption}` : caption
  }

  const buttonText = message.buttonText?.trim()
  if (buttonText) return `[button reply] ${buttonText}`

  const locationName = message.location?.name?.trim()
  const locationAddress = message.location?.address?.trim()
  if (locationName || locationAddress) {
    const details = [locationName, locationAddress].filter(Boolean).join(", ")
    return `[location message] shared location: ${details}`
  }
  // Location shared with no name/address still carries signal via its type.
  if (type === "location") {
    return `[location message] no user text available`
  }

  if (type) return `[${type} message] no user text available`

  return null
}

/**
 * Reconciles a raw AI classification against conversation context so
 * a single weak or hallucinated result never propagates on its own.
 *
 * Applies, in order:
 *   1. Strong context override — ambiguous/continuation text plus a
 *      the AI result below {@link CONTEXT_OVERRIDE_CONFIDENCE_THRESHOLD}
 *      defers to context outright, since a one-word reply is exactly the
 *      case the AI classifier is least equipped to classify correctly on its own.
 *   2. Confidence gating — any result below
 *      {@link CONFIDENCE_GATE_THRESHOLD} is reconciled against context
 *      (if any) or downgraded, regardless of message shape.
 *   3. Otherwise, the AI result is trusted as-is.
 *
 * This function does not apply the final low-confidence floor — callers
 * are expected to pass every result through {@link applyLowConfidenceFloor}
 * before returning it.
 */
function reconcileAiResult(
  object: { intent: Intent; confidence: number; reasoning: string },
  context: IntentRouterContext | undefined,
  isContinuation: boolean,
): RoutedIntent {
  const contextIntent = isValidIntent(context?.lastIntent) ? (context!.lastIntent as Intent) : null

  if (contextIntent && isContinuation && object.confidence < CONTEXT_OVERRIDE_CONFIDENCE_THRESHOLD) {
    return {
      intent: contextIntent,
      confidence: 0.85,
      reasoning: "Resolved using strong conversation context override",
    }
  }

  if (object.confidence < CONFIDENCE_GATE_THRESHOLD) {
    if (contextIntent) {
      return {
        intent: contextIntent,
        confidence: 0.65,
        reasoning: "Low-confidence AI result; preferring conversation context",
      }
    }
    return {
      intent: "unknown",
      confidence: 0.4,
      reasoning: "Low-confidence classification with no context available",
    }
  }

  return {
    intent: object.intent,
    confidence: object.confidence,
    reasoning: object.reasoning,
  }
}

/**
 * Builds a safe result when the AI model cannot be consulted at all (it threw
 * or timed out). Prefers conversation context over a blind generic
 * fallback, since a known prior intent is still meaningfully better
 * evidence than nothing.
 */
function buildAiFailureResult(context: IntentRouterContext | undefined, reason: string): RoutedIntent {
  const contextIntent = isValidIntent(context?.lastIntent) ? (context!.lastIntent as Intent) : null

  if (contextIntent) {
    return {
      intent: contextIntent,
      confidence: 0.6,
      reasoning: `${reason}; used conversation context`,
    }
  }

  return {
    intent: "unknown",
    confidence: 0.2,
    reasoning: reason,
  }
}

/**
 * Normalizes any result below {@link LOW_CONFIDENCE_FLOOR} to a single
 * canonical low-confidence shape. Applied as the last step on every
 * return path in {@link routeIntent}, so downstream layers only ever need
 * to special-case one "I'm not sure" result instead of several
 * differently-worded low-confidence variants.
 */
function applyLowConfidenceFloor(result: RoutedIntent): RoutedIntent {
  return result.confidence < LOW_CONFIDENCE_FLOOR ? LOW_CONFIDENCE_FALLBACK : result
}

/**
 * Classifies an inbound message into an intent using the pipeline:
 *   1. Greetings/Thanks (global shortcuts)
 *   2. Context Continuation (uses the supplied, already-loaded conversation
 *      context — no fetching, no I/O)
 *   3. Intent Fast-Path (clear signals without AI)
 *   4. AI Classification (complex/non-obvious messages)
 *
 * This function has exactly one responsibility: given a message and an
 * optional, already-loaded context, return a {@link RoutedIntent}. It
 * never performs a database or memory lookup — `reply.ts` is responsible
 * for loading conversation context and state before calling this function.
 *
 * @param message The normalized inbound WhatsApp message.
 * @param context Optional conversation context already loaded by reply.ts.
 * @returns A {@link RoutedIntent}. On any failure, returns the safe fallback.
 */
export async function routeIntent(
  message: {
    text?: string | null
    caption?: string | null
    buttonText?: string | null
    type?: string | null
    location?: {
      name?: string | null
      address?: string | null
    } | null
  },
  context?: IntentRouterContext,
): Promise<RoutedIntent> {
  const text = buildClassificationText(message)

  // No usable text to classify → don't waste an API call.
  if (!text) {
    console.log("[IntentRouter] No usable text, returning fallback")
    return applyLowConfidenceFloor(FALLBACK)
  }

  // ── STEP 1: GREETINGS & THANKS (Global Shortcuts) ──────────────────
  // These are universal and always mean the same thing regardless of context.
  // "Hi" is always "hi". "Thanks" is always gratitude.
  const greetingOrThanks = checkGreetingOrThanks(text)
  if (greetingOrThanks) {
    console.log("[IntentRouter]", greetingOrThanks.reasoning)
    return applyLowConfidenceFloor(greetingOrThanks)
  }

  // ── STEP 2: CONTEXT CONTINUATION ─────────────────────────────────────
  // Ambiguous replies ("2", "yes", "tomorrow") inherit intent from the
  // already-loaded conversation context. This runs BEFORE the intent
  // fast-path so "yes" during a booking confirmation stays as "booking",
  // not "support". No I/O — reads only from the supplied `context` parameter.
  const contextResult = resolveFromContext(text, context)
  if (contextResult) {
    console.log("[IntentRouter]", contextResult.reasoning)
    return applyLowConfidenceFloor(contextResult)
  }

  // Computed once and reused by both the fast-path guard below and the
  // the AI reconciliation step, so both agree on what counts as ambiguous.
  const isContinuation = isContinuationText(text)

  // ── STEP 3: INTENT FAST-PATH ────────────────────────────────────────
  // Clear intent signals that don't need AI. Only reaches here if context
  // couldn't resolve the message — either none was supplied, or it wasn't
  // valid. Skipped entirely for continuation-style text ("2", "yes",
  // "tomorrow") so a confident fast-path rule never overrides what should
  // instead be handled as an unresolved continuation by the AI classifier below —
  // e.g. a bare "yes" reply with no known prior intent should be
  // reconciled with care, not stamped on pattern-match alone.
  if (!isContinuation) {
    const fastPathResult = checkIntentFastPath(text)
    if (fastPathResult) {
      console.log("[IntentRouter]", fastPathResult.reasoning)
      return applyLowConfidenceFloor(fastPathResult)
    }
  }

  // ── STEP 4: AI CLASSIFICATION ───────────────────────────────────
  // Catch-all for complex, non-obvious messages.
  const CLASSIFICATION_TIMEOUT_MS = 3000

  try {
    console.log("[IntentRouter] AI fallback used for:", text)

    let timeoutId: ReturnType<typeof setTimeout>

    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), CLASSIFICATION_TIMEOUT_MS)
    })

    const classificationPromise = generateObject({
      model: openai("gpt-4o-mini"),
      schema: intentSchema,
      system: SYSTEM_PROMPT,
      prompt: text,
    })

    const result = await Promise.race([classificationPromise, timeoutPromise])

    clearTimeout(timeoutId!)

    if (result === TIMEOUT_SENTINEL) {
      const timeoutResult = buildAiFailureResult(context, "AI classification timed out")
      console.log("[IntentRouter]", timeoutResult.reasoning)
      return applyLowConfidenceFloor(timeoutResult)
    }

    const { object } = result

    const reconciled = reconcileAiResult(object, context, isContinuation)
    console.log(
      "[IntentRouter] AI classification succeeded:",
      object.intent,
      "→ reconciled:",
      reconciled.intent,
      reconciled.reasoning,
    )

    return applyLowConfidenceFloor(reconciled)
  } catch (error) {
    console.log("[IntentRouter] AI classification failed:", error)
    const failureResult = buildAiFailureResult(context, "AI classification failed")
    console.log("[IntentRouter]", failureResult.reasoning)
    return applyLowConfidenceFloor(failureResult)
  }
}
