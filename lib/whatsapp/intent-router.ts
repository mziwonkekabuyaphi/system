import { generateObject } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"

/**
 * Intent router — the "brain" layer of the Rands WhatsApp Concierge.
 *
 * Phase 2 (hybrid AI routing): this module now uses Claude to classify an
 * inbound WhatsApp message into a high-level intent. Classification ONLY —
 * Claude is not asked to draft replies, call tools, or hold memory here. Its
 * single job is to improve message → intent accuracy.
 *
 * The result drives downstream services (wallet / tickets / events / support)
 * in later phases. This layer is intentionally lightweight: exactly one model
 * call, with a safe deterministic fallback if anything goes wrong.
 *
 * Architecture:
 *   webhook (thin layer)
 *     ↓
 *   reply.ts                        ← loads conversation context & state
 *     ↓
 *   intent-router (brain layer)     ← this file
 *     ↓
 *   action-router
 *     ↓
 *   services (wallet / tickets / events)
 *
 * This file performs NO database or memory lookups of its own. `reply.ts`
 * already loads conversation context and state before calling
 * {@link routeIntent}; if that context is useful for classification, it is
 * read directly from the supplied parameter — never fetched here.
 *
 * Routing Pipeline (in order):
 *   1. GREETINGS/THANKS - Global shortcuts that always mean the same thing
 *   2. CONTEXT CONTINUATION - Ambiguous replies inherit intent from the
 *      already-loaded conversation context (no I/O — read-only)
 *   3. INTENT FAST-PATH - Clear intent signals that don't need AI. Skipped
 *      entirely for continuation-style messages ("2", "card", "yes") so a
 *      confident fast-path rule never overrides context that just wasn't
 *      resolvable in step 2 (e.g. no context was supplied at all).
 *   4. CLAUDE CLASSIFICATION - Catch-all for complex/non-obvious messages.
 *      Claude's raw confidence is never trusted blindly: low-confidence
 *      results are reconciled against conversation context, and Claude
 *      failures (throws/timeouts) fall back to context before falling
 *      back to a generic "unknown" result.
 *
 * Decision-stability rules layered on top of the above (see inline
 * comments at each usage site for the exact thresholds):
 *   - Strong context override: an ambiguous/continuation message combined
 *     with a weak Claude result defers to conversation context outright.
 *   - Confidence gating: any Claude result below the trust threshold is
 *     reconciled against context (or downgraded) rather than propagated.
 *   - Low-confidence floor: any final result below 0.5 confidence is
 *     normalized to a single canonical "unknown" fallback shape, so
 *     downstream layers only ever have to handle one low-confidence case.
 */


/** The intent categories the concierge understands. */
const INTENTS = [
  "wallet",   // Passport balance/top-up/activity — an ACTION on the wallet
  "passport", // Passport OVERVIEW — "Passport" / "My Passport" on its own,
              // with no action word attached. See checkIntentFastPath and
              // the Claude system prompt below for how this is kept
              // distinct from "wallet".
  "ticket",
  "event",
  "order",
  "vvip",
  "booking",
  "shisha",
  "support",
  "checkin",
  "unknown",
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

/** Deterministic fallback used whenever Claude can't be consulted. */
const FALLBACK: RoutedIntent = {
  intent: "unknown",
  confidence: 0,
}

/** Sentinel value used to detect that the timeout race finished first. */
const TIMEOUT_SENTINEL = Symbol("intent-classification-timeout")

// ── Confidence & Stability Thresholds ────────────────────────────────
// These govern how much we trust a raw Claude result versus falling back
// to conversation context or a generic "unknown". Centralized here so the
// numbers are easy to find and tune without hunting through the pipeline.

/**
 * Below this, a Claude result combined with ambiguous/continuation text
 * ("2", "card", "yes") is considered weaker evidence than conversation
 * context, and context wins outright.
 */
const CONTEXT_OVERRIDE_CONFIDENCE_THRESHOLD = 0.7

/**
 * Below this, a raw Claude result is not trusted on its own regardless of
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
// Short, ambiguous replies ("2", "card", "yes") can't be classified in
// isolation — they only make sense in the context of the conversation.
// This runs BEFORE the intent fast-path so "card" during ticket purchase
// stays as "ticket", not "wallet".
//
// Unlike the old memory-lookup step, this performs NO I/O: the context is
// already loaded by reply.ts and handed in via the `context` parameter.

const CONTINUATION_KEYWORDS = new Set([
  "yes", "y", "no", "n", "yeah", "yep", "nope",
  "ok", "okay", "sure",
  "card", "wallet", "cash", "passport",
  "same", "that one", "this one",
  "continue", "next", "tomorrow", "today",
  "1", "2", "3", "4", "5",
])

function isContinuationText(rawText: string): boolean {
  const normalized = rawText.trim().toLowerCase()
  if (!normalized) return false
  if (CONTINUATION_KEYWORDS.has(normalized)) return true
  if (/^\d{1,3}$/.test(normalized)) return true
  if (/^r\s?\d+(\.\d{1,2})?$/i.test(normalized)) return true
  return false
}

/**
 * True when `value` is one of the concierge's known intents. Centralizes
 * the validity check so every context-based override (context
 * continuation, strong context override, Claude-failure hardening) agrees
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
// Example: "card" during ticket purchase → context says "ticket"
//           "card" as standalone → fast-path says "wallet"

const AFFIRMATIVE = new Set(["yes", "y", "yeah", "yep"])
const NEGATIVE = new Set(["no", "n", "nope"])
const MENU_SELECTION = new Set(["1", "2", "3", "4", "5", "next", "continue"])
// "wallet"/"card"/"cash" are payment-method words — a customer answering a
// payment-method prompt with one of these means "use this to pay," not
// "show me anything." "passport" USED to live in this same set (see git
// blame), but that made a bare "Passport" always resolve to the wallet
// balance screen — which is wrong now that "Passport" on its own means the
// aggregated overview (PASSPORT_OVERVIEW_PHRASES below), not a payment
// method. "wallet" stays here since a customer typing exactly "wallet"
// (not "passport") is presumed to still want the balance/top-up screen,
// preserving prior behavior for that word.
const PAYMENT_METHODS = new Set(["card", "wallet", "cash"])

// Bare "Passport" / "My Passport" / "Show my Passport" — i.e. the customer
// asked to SEE something, with no action word (balance/top up/activity)
// attached. Deliberately a short, exact-phrase allowlist rather than a
// substring match: "passport balance", "top up my passport" etc. must NOT
// match here, since those name a specific wallet action and belong to the
// existing "wallet" intent instead (see the Claude system prompt's
// "wallet" examples below, which are unchanged). Also deliberately
// disjoint from action-router.ts's PAYMENT_METHOD_REPLY_KEYWORDS check —
// that check guards mid-flow payment-method prompts (tickets/orders/vvip
// asking "how would you like to pay?") independently of what intent this
// function resolves "passport" to, so it keeps working unchanged either way.
const PASSPORT_OVERVIEW_PHRASES = new Set([
  "passport",
  "my passport",
  "show my passport",
  "show passport",
  "view passport",
  "view my passport",
  // Exact text of a known UI-generated button that means "open Passport"
  // but whose tap can't be routed deterministically by interactiveId —
  // plain WhatsApp buttons reuse ids like "btn_1" across many unrelated
  // screens (confirm/edit/etc.), unlike list rows, so the only reliable
  // thing to match on is the literal button text itself. This is
  // registration.ts's post-signup button specifically — services-list.ts's
  // row_1 has the same label but is routed by row id in action-router.ts
  // regardless of its text, so it doesn't depend on this entry. If
  // registration.ts's button text changes, this must change with it.
  "🪪 my rands passport",
])

function checkIntentFastPath(text: string): RoutedIntent | null {
  const normalized = text.trim().toLowerCase()

  // Passport overview → passport (checked before payment methods; the two
  // sets are disjoint so order doesn't matter for correctness, but this
  // reads top-to-bottom as "what is this message asking to see" before
  // "what is this message answering with").
  if (PASSPORT_OVERVIEW_PHRASES.has(normalized)) {
    return { intent: "passport", confidence: 0.95, reasoning: "Fast-path: passport overview" }
  }

  // Payment methods → wallet (clear intent)
  if (PAYMENT_METHODS.has(normalized)) {
    return { intent: "wallet", confidence: 0.95, reasoning: "Fast-path: payment method" }
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

// ── Step 4: Claude Classification ────────────────────────────────────
// Catch-all for complex messages that didn't match any deterministic rule.

/** Structured output we expect back from Claude. */
const intentSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

const SYSTEM_PROMPT = `
You are the Intent Classification Engine for the Rands AI Concierge.

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
ABOUT RANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Rands is a hospitality, nightlife and entertainment platform.

Customers interact with Rands through WhatsApp to:

• Check Passport balance
• Top up Passport
• Browse events
• Buy event tickets
• Check VVIP table availability
• Book VVIP tables
• Order drinks
• Order food
• Order shisha
• Track existing orders
• Contact support

The AI must understand Rands terminology.

"Passport" is the customer-facing name for the wallet.

Whenever a customer says:

Wallet
Balance
Money
Funds
Credit
Top up
Deposit
Recharge
Load money

these all refer to the Wallet business domain (intent: wallet).

IMPORTANT — "Passport" on its own is DIFFERENT from the words above:
when a customer says just "Passport" / "My Passport" / "Show my Passport",
with no balance/top-up/activity word attached, they are asking to see
their whole Rands account at a glance (balance + tickets + VVIP, in one
overview) — that is intent: passport, not intent: wallet. The moment an
action word is attached ("passport balance", "top up my passport",
"passport activity"), it goes back to being intent: wallet, since the
customer has told you exactly which wallet action they want.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE INTENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wallet
Customer wants a specific Passport/wallet ACTION.

Examples:

check passport

passport balance

wallet

deposit money

top up

payment

refund

transaction history

fund account

available balance

passport
Customer wants their whole Passport OVERVIEW — bare "Passport" with no
action word attached. Do not use this for anything that names balance,
top up, or activity; those stay "wallet" above.

Examples:

passport

my passport

show my passport

what's in my passport

view my passport

ticket
Customer wants tickets.

Examples:

buy ticket

my ticket

ticket

scan ticket

ticket transfer

ticket refund

event pass

event
Customer wants event information.

Examples:

what events are available

upcoming events

lineup

venue

date

festival

club tonight

weekend events

order
Customer wants to buy products.

Examples:

buy drinks

food

bottle

champagne

cocktails

whiskey

order status

cancel order

menu

vvip
Customer wants premium tables.

Examples:

VIP

VVIP

table

book table

reserve table

package

birthday package

table availability

booking
General reservations.

Examples:

book

reservation

reserve

appointment

booking

shisha
Anything hookah related.

Examples:

hookah

hubbly

shisha

coal

flavour

double apple

mint

support
Human assistance.

Examples:

talk to agent

manager

complaint

problem

issue

help

customer service

unknown
Greeting, casual conversation, or insufficient information.

Examples:

hello

hi

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
Bank payment receipt
→ wallet

[image message]
QR ticket
→ ticket

[image message]
Club flyer
→ event

[image message]
Bottle menu
→ order

[button reply]
Passport
→ wallet

[button reply]
Events
→ event

[button reply]
Order Drinks
→ order

[button reply]
VVIP
→ vvip

[location message]
Nightclub location
→ event

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLASSIFICATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Choose EXACTLY ONE intent.

Never return multiple intents.

Never invent missing information.

If uncertain, prefer the most specific business domain.

Examples:

"buy tickets and top up"

Primary customer objective:
ticket

"can I order champagne"

order

"book VIP"

vvip

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

You are a deterministic business intent classifier for the Rands platform. - "[image message]": often a screenshot or photo. A payment receipt, bank
  app screenshot, or QR/proof-of-payment image usually means "wallet". A
  photo of a ticket, barcode, or booking confirmation usually means "ticket".
  A flyer, poster, or lineup photo usually means "event". If the caption
  describes a problem (e.g. "this isn't working", "error"), prefer "support".
  With no caption, treat it as ambiguous and lean toward "support" only if
  there's no better signal — otherwise "unknown".
- "[video message]" / "[document message]" / "[audio message]": apply the
  same reasoning as images — infer from any caption or accompanying text.
  Audio messages with no transcribable text are commonly people explaining
  an issue or asking a question verbally; with no caption these usually lean
  "support" (a human wanting to talk through something) unless other context
  points elsewhere.
- "[button reply]": the user tapped a button from a previous menu. The
  button label is usually a strong, near-literal signal of intent — trust
  it directly (e.g. "🪪 Passport" or "Check Balance" → wallet, "My Tickets"
  → ticket, "Browse Events" → event, "Talk to Support" → support).
- "[location message]": the user shared a GPS location/place. This is
  almost always about finding or confirming a venue, so it should usually
  map to "event" — unless the shared place/name text clearly references
  account or payment issues, in which case prefer "support".
- "<type>: no user text available" (any other type with nothing else to go
  on): there is no real signal beyond the message type. Default to
  "unknown" with low confidence, unless the type itself is informative
  (e.g. a payment-related type), in which case use your best judgement.

When in doubt between two intents, prefer the one with more concrete,
specific evidence in the text over a generic catch-all. Only use "unknown"
when there genuinely isn't enough signal to choose another intent.

Return:
- intent: the single best-fitting category.
- confidence: 0..1 reflecting how certain you are.
- reasoning: one short sentence explaining the choice.
`;

/**
 * Builds the text we hand to Claude, in priority order:
 *   1. message.text       (plain text messages)
 *   2. message.caption    (image/video/document captions)
 *   3. message.buttonText (button / interactive replies)
 *   4. message.location   (shared GPS location — name/address if present)
 *   5. `[${type} message] no user text available` (last resort — still
 *      tells Claude what kind of message this was instead of sending
 *      nothing or an empty string)
 *
 * Returns null only when there's truly nothing to go on (no text, no
 * caption, no button text, no location, and no type), in which case the
 * caller skips the Claude call entirely and uses the deterministic fallback.
 *
 * Non-text message types are prefixed (e.g. "[image message] ...") so
 * Claude has the payload shape as context, which improves classification
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
 * Reconciles a raw Claude classification against conversation context so
 * a single weak or hallucinated result never propagates on its own.
 *
 * Applies, in order:
 *   1. Strong context override — ambiguous/continuation text plus a
 *      Claude result below {@link CONTEXT_OVERRIDE_CONFIDENCE_THRESHOLD}
 *      defers to context outright, since a one-word reply is exactly the
 *      case Claude is least equipped to classify correctly on its own.
 *   2. Confidence gating — any result below
 *      {@link CONFIDENCE_GATE_THRESHOLD} is reconciled against context
 *      (if any) or downgraded, regardless of message shape.
 *   3. Otherwise, the Claude result is trusted as-is.
 *
 * This function does not apply the final low-confidence floor — callers
 * are expected to pass every result through {@link applyLowConfidenceFloor}
 * before returning it.
 */
function reconcileClaudeResult(
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
        reasoning: "Low-confidence Claude result; preferring conversation context",
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
 * Builds a safe result when Claude cannot be consulted at all (it threw
 * or timed out). Prefers conversation context over a blind generic
 * fallback, since a known prior intent is still meaningfully better
 * evidence than nothing.
 */
function buildClaudeFailureResult(context: IntentRouterContext | undefined, reason: string): RoutedIntent {
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
 *   4. Claude Classification (complex/non-obvious messages)
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
  // Ambiguous replies ("2", "card", "yes") inherit intent from the
  // already-loaded conversation context. This runs BEFORE the intent
  // fast-path so "card" during ticket purchase stays as "ticket", not
  // "wallet". No I/O — reads only from the supplied `context` parameter.
  const contextResult = resolveFromContext(text, context)
  if (contextResult) {
    console.log("[IntentRouter]", contextResult.reasoning)
    return applyLowConfidenceFloor(contextResult)
  }

  // Computed once and reused by both the fast-path guard below and the
  // Claude reconciliation step, so both agree on what counts as ambiguous.
  const isContinuation = isContinuationText(text)

  // ── STEP 3: INTENT FAST-PATH ────────────────────────────────────────
  // Clear intent signals that don't need AI. Only reaches here if context
  // couldn't resolve the message — either none was supplied, or it wasn't
  // valid. Skipped entirely for continuation-style text ("2", "card",
  // "yes") so a confident fast-path rule never overrides what should
  // instead be handled as an unresolved continuation by Claude below —
  // e.g. a bare "card" reply with no known prior intent should be
  // reconciled with care, not stamped "wallet" on pattern-match alone.
  if (!isContinuation) {
    const fastPathResult = checkIntentFastPath(text)
    if (fastPathResult) {
      console.log("[IntentRouter]", fastPathResult.reasoning)
      return applyLowConfidenceFloor(fastPathResult)
    }
  }

  // ── STEP 4: CLAUDE CLASSIFICATION ───────────────────────────────────
  // Catch-all for complex, non-obvious messages.
  const CLASSIFICATION_TIMEOUT_MS = 3000

  try {
    console.log("[IntentRouter] Claude fallback used for:", text)

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
      const timeoutResult = buildClaudeFailureResult(context, "Claude classification timed out")
      console.log("[IntentRouter]", timeoutResult.reasoning)
      return applyLowConfidenceFloor(timeoutResult)
    }

    const { object } = result

    const reconciled = reconcileClaudeResult(object, context, isContinuation)
    console.log(
      "[IntentRouter] Claude classification succeeded:",
      object.intent,
      "→ reconciled:",
      reconciled.intent,
      reconciled.reasoning,
    )

    return applyLowConfidenceFloor(reconciled)
  } catch (error) {
    console.log("[IntentRouter] Claude failed:", error)
    const failureResult = buildClaudeFailureResult(context, "Claude classification failed")
    console.log("[IntentRouter]", failureResult.reasoning)
    return applyLowConfidenceFloor(failureResult)
  }
}
