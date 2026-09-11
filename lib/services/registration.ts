// lib/services/registration.ts
/**
 * Registration Flow (shared "resume registration" entry point)
 * ---------------------------------------------------------------
 * This is the missing piece referenced by the TODOs in orders.ts, vvip.ts,
 * and wallet.ts:
 *
 *   // TODO(reply.ts): once a shared "resume registration" entry point
 *   // exists, route into it here with gate.progress.nextField instead of
 *   // dead-ending the conversation.
 *
 * Previously, any guarded action (order, VVIP booking, wallet top-up) that
 * hit `checkRegistrationGate()` and found the customer not fully registered
 * would just say "let's get that sorted first" and set `nextState: null`.
 * Nothing ever asked for name/surname/email, so the customer had no way to
 * actually finish registering — the conversation dead-ended.
 *
 * This service owns the `registration_*` conversation states, walks the
 * customer through `continueRegistration()` / `completeWhatsAppRegistration()`
 * (both implemented in customer.ts), and — critically — remembers what the
 * customer was originally trying to do, so once registration completes
 * they're dropped back into that flow instead of back at the main menu.
 *
 * Flow overview (as of the Passport Key rework):
 *   registration_awaiting_name
 *     -> registration_awaiting_surname
 *     -> registration_awaiting_email
 *     -> registration_awaiting_confirmation   (review before submit)
 *        -> [Confirm]  -> registration_awaiting_age_confirmation (last question — see below)
 *             -> [Yes, 21+]  -> completeWhatsAppRegistration() -> resume / main menu
 *             -> [No]        -> declined, no account created
 *        -> [Edit]     -> registration_awaiting_edit_choice
 *             -> registration_awaiting_{field} (editingField: true)
 *                -> back to registration_awaiting_confirmation
 *
 * AGE CONFIRMATION (added): Rands serves alcohol on-site, so registration
 * now ends with a one-time "are you 21+?" question — the last thing asked
 * before the account is created. This replaces the old per-order alcohol
 * age check that used to live in orders.ts (asked again on every alcoholic
 * item); customers now only see it once, here, at signup.
 *
 * CHANGED (Passport Key rework): there is no password step anymore.
 * WhatsApp registration ends the moment name + surname + email are
 * confirmed — completeWhatsAppRegistration() provisions the wallet
 * immediately, with no password required. Setting up a Passport Key (web
 * login) happens later, from the web app, via a WhatsApp OTP — see
 * lib/services/passport-key.ts. This file no longer touches that at all.
 *
 * name/surname/email are still persisted field-by-field via
 * continueRegistration() as before (so partial progress survives a dropped
 * conversation).
 *
 * Dependency direction: this file only imports from customer.ts, state.ts,
 * and its own message-copy module. It deliberately does NOT import
 * anything from orders.ts, vvip.ts, or wallet.ts (see StatefulService
 * contract in action-router.ts) — callers pass in everything needed to
 * resume as plain data (`PendingResumeAction`), not as a callback into
 * their own module.
 *
 * All customer-facing copy lives in lib/services/messages/registration.ts
 * — this file only owns state transitions and the smart multi-field
 * extraction logic.
 */

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import {
  checkRegistrationGate,
  continueRegistration,
  completeWhatsAppRegistration,
  type RegistrationGate,
  type CustomerField,
} from "@/lib/services/customer"
import type { StatefulService } from "@/lib/whatsapp/action-router"
import { generateObject } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"

import {
  CONFIRM_BUTTON,
  EDIT_BUTTON,
  AGE_CONFIRM_YES_BUTTON,
  AGE_CONFIRM_NO_BUTTON,
  EDIT_NAME_BUTTON,
  EDIT_SURNAME_BUTTON,
  EDIT_EMAIL_BUTTON,
  WELCOME_MENU_BUTTONS,
  DIDNT_CATCH_THAT,
  AGE_RESTRICTION_DECLINED,
  errorMessage,
  promptForField,
  firstPromptExtra,
  reRaskWithError,
  confirmationSummary,
  ageConfirmationPrompt,
  editChoicePromptMessage,
  editChoiceRetryMessage,
  ageConfirmedWithResumeMessage,
  welcomeMenuMessage,
} from "@/lib/services/messages/registration"

// ============================================================================
// TYPES
// ============================================================================

/**
 * Everything a guarded action needs to hand off before sending the customer
 * into registration, so registration.ts can hand them straight back to
 * exactly where they left off once they're done.
 *
 * `targetState` is the state (+ data) the caller would otherwise have set
 * as `nextState` had the gate allowed the action through.
 * `replyText`/`buttons` are the exact prompt the customer would have seen
 * for that state, so we can replay it verbatim without needing to know how
 * to reconstruct order/booking/top-up copy ourselves.
 */
export interface PendingResumeAction {
  targetState: ConversationState
  replyText: string
  buttons?: string[]
}

/**
 * Answers collected so far this registration session. All persisted via
 * continueRegistration() as they're collected — there's no longer a
 * password field held only in memory.
 *
 * Exported so lib/services/messages/registration.ts can type
 * confirmationSummary() without duplicating this shape.
 */
export interface RegistrationDraft {
  name?: string
  surname?: string
  email?: string
}

const REGISTRATION_STATE_PREFIX = "registration_awaiting_"

const FIELD_TO_STATE: Record<CustomerField, string> = {
  name: `${REGISTRATION_STATE_PREFIX}name`,
  surname: `${REGISTRATION_STATE_PREFIX}surname`,
  email: `${REGISTRATION_STATE_PREFIX}email`,
}

const STATE_TO_FIELD: Record<string, CustomerField> = Object.fromEntries(
  Object.entries(FIELD_TO_STATE).map(([field, state]) => [state, field as CustomerField]),
)

const CONFIRMATION_STATE = `${REGISTRATION_STATE_PREFIX}confirmation`
const EDIT_CHOICE_STATE = `${REGISTRATION_STATE_PREFIX}edit_choice`
// Asked once, right after the customer taps Confirm and before the account
// is actually created — the last question of registration, replacing the
// old per-order alcohol age check (that used to re-ask this on every order
// in orders.ts; removed there in favor of asking it here, once).
const AGE_CONFIRMATION_STATE = `${REGISTRATION_STATE_PREFIX}age_confirmation`

const EDIT_BUTTON_TO_FIELD: Record<string, CustomerField> = {
  [EDIT_NAME_BUTTON]: "name",
  [EDIT_SURNAME_BUTTON]: "surname",
  [EDIT_EMAIL_BUTTON]: "email",
}

function matchesButton(rawValue: string, button: string): boolean {
  return rawValue.trim().toLowerCase() === button.trim().toLowerCase()
}

function rawTextOf(message: IncomingMessage): string {
  return (message.text ?? message.contentSummary ?? "").trim()
}

function getDraft(state: ConversationState): RegistrationDraft {
  return (state.data?.draft ?? {}) as RegistrationDraft
}

function getResume(state: ConversationState): PendingResumeAction | null {
  return (state.data?.resume ?? null) as PendingResumeAction | null
}

// ============================================================================
// SMART MULTI-FIELD ENTRY — "John Smith john@doe.com" in one message
// ============================================================================
//
// Lets a customer front-load name + surname (+ email, if they include it)
// in a single reply instead of answering three separate questions.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const smartRegistrationSchema = z.object({
  name: z.string().nullable(),
  surname: z.string().nullable(),
  email: z.string().nullable(),
})

type SmartRegistrationEntry = z.infer<typeof smartRegistrationSchema>

/**
 * Extracts name/surname/email from a single free-text message. Same
 * timeout-race + fail-safe pattern used elsewhere (tickets.ts's smart
 * ticket entry, intent-router.ts's classification step): on timeout or any
 * error, returns null so the caller always has a safe fallback to the
 * normal one-field-at-a-time flow.
 */
async function extractSmartRegistrationEntry(rawText: string): Promise<SmartRegistrationEntry | null> {
  if (!rawText.trim()) return null

  const EXTRACTION_TIMEOUT_MS = 3000
  const TIMEOUT_SENTINEL = Symbol("smart-registration-timeout")

  try {
    const extractionPromise = generateObject({
      model: openai("gpt-4o-mini"),
      schema: smartRegistrationSchema,
      system:
        "Extract registration details from a WhatsApp message where a customer is signing up for an account.\n" +
        "- name: their first name, or null if not stated.\n" +
        "- surname: their last/family name, or null if not stated.\n" +
        "- email: their email address, or null if not stated.\n" +
        "Never guess or invent a value — use null for anything not clearly and explicitly present in the message. " +
        "Never treat a password, PIN, or anything that looks like a credential as any of these fields.",
      prompt: rawText,
    })

    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SENTINEL), EXTRACTION_TIMEOUT_MS)
    })

    const result = await Promise.race([extractionPromise, timeoutPromise])

    if (result === TIMEOUT_SENTINEL) {
      console.log("[registration][smart-entry] Extraction timed out")
      return null
    }

    return result.object
  } catch (error) {
    console.error("[registration][smart-entry] Extraction failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return null
  }
}

/**
 * Tries to fill more than one of {name, surname, email} from a single
 * message. Returns null (never throws) for anything not confidently
 * resolvable, so the caller always falls back to the ordinary
 * one-question-at-a-time behavior — this can only shortcut the flow, never
 * break it.
 */
async function trySmartRegistrationEntry(
  phone: string,
  rawValue: string,
  draft: RegistrationDraft,
  resume: PendingResumeAction | null,
): Promise<ActionResult | null> {
  // Cheap gate: a single-word reply ("John") to "what's your first name?"
  // is exactly what the normal flow already handles well — only worth the
  // extra LLM call when the message plausibly carries more than one field.
  const looksMultiField = /@/.test(rawValue) || rawValue.trim().split(/\s+/).length >= 2
  if (!looksMultiField) return null

  const extracted = await extractSmartRegistrationEntry(rawValue)
  if (!extracted) return null

  // Only ever fill fields we don't already have — never overwrite
  // something already collected/persisted earlier this session.
  const newValues: Partial<Record<"name" | "surname" | "email", string>> = {}
  if (!draft.name && extracted.name?.trim()) newValues.name = extracted.name.trim()
  if (!draft.surname && extracted.surname?.trim()) newValues.surname = extracted.surname.trim()
  if (!draft.email && extracted.email?.trim() && EMAIL_PATTERN.test(extracted.email.trim())) {
    newValues.email = extracted.email.trim()
  }

  // Resolving just one field is exactly what the normal single-question
  // flow already does — only worth taking this path when it actually
  // shortcuts more than one question.
  if (Object.keys(newValues).length < 2) return null

  const newDraft: RegistrationDraft = { ...draft, ...newValues }

  // Persist each newly-resolved field the same way the single-field path
  // does, in a fixed order. continueRegistration() can fail on any one of
  // these (e.g. email already registered to another account) — if it does,
  // whatever succeeded before that point is already saved/in newDraft, so
  // the customer is only re-asked for the field that actually failed, not
  // sent back to the start.
  for (const field of ["name", "surname", "email"] as const) {
    if (!newValues[field]) continue
    try {
      await continueRegistration(phone, field, newValues[field]!)
    } catch (err) {
      return {
        reply: reRaskWithError(field, errorMessage(err)),
        buttons: [],
        nextState: { state: FIELD_TO_STATE[field], data: { resume, draft: newDraft } },
      }
    }
  }

  const stillMissing = (["name", "surname", "email"] as const).find((field) => !newDraft[field])
  if (stillMissing) {
    return {
      reply: promptForField(stillMissing),
      buttons: [],
      nextState: { state: FIELD_TO_STATE[stillMissing], data: { resume, draft: newDraft } },
    }
  }

  // All three fields resolved in one shot — go straight to confirmation.
  return toConfirmation(newDraft, resume)
}

// ============================================================================
// ENTRY POINT — called by orders.ts / vvip.ts / wallet.ts (and any future
// guarded action) when checkRegistrationGate() returns `allowed: false`.
// ============================================================================

/**
 * Kicks off (or resumes) the registration conversation.
 *
 * @param gate    The result of checkRegistrationGate() — tells us which
 *                field to ask for first.
 * @param resume  What the customer was trying to do when they got gated,
 *                so we can hand them back to it once registration
 *                completes. Pass `null` if there's nothing to resume (e.g.
 *                a customer proactively starting registration with no
 *                pending purchase).
 */
export function beginRegistration(
  gate: RegistrationGate,
  resume: PendingResumeAction | null,
): ActionResult {
  const nextField = gate.progress.nextField ?? "name"

  return {
    reply: promptForField(nextField) + firstPromptExtra(nextField),
    // Web mention is only surfaced here, alongside the very first prompt of
    // the session — not repeated on every subsequent field. No button: it's
    // a plain URL in the text now, see firstPromptExtra().
    buttons: [],
    nextState: {
      state: FIELD_TO_STATE[nextField],
      data: { resume, draft: {} },
    },
  }
}

// ============================================================================
// helpers for building the "go to confirmation" / "go to a field" results
// ============================================================================

function toConfirmation(draft: RegistrationDraft, resume: PendingResumeAction | null): ActionResult {
  return {
    reply: confirmationSummary(draft),
    buttons: [CONFIRM_BUTTON, EDIT_BUTTON],
    nextState: { state: CONFIRMATION_STATE, data: { resume, draft } },
  }
}

// ============================================================================
// STATE HANDLERS
// ============================================================================

async function handleField(
  field: CustomerField,
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult> {
  const phone = message.from
  const resume = getResume(state)
  const draft = getDraft(state)
  const editingField = Boolean(state.data?.editingField)
  const rawValue = rawTextOf(message)

  if (!rawValue) {
    return {
      reply: DIDNT_CATCH_THAT + promptForField(field),
      buttons: [],
      nextState: state,
    }
  }

  // Smart multi-field entry: "John Smith john@doe.com" answering just
  // "what's your first name?" can fill name+surname(+email) together.
  // Skipped while editing a single field from the confirmation screen —
  // an edit is a deliberate fix to exactly one field, so multi-field
  // parsing there would be surprising. Also skipped whenever fewer than
  // two of {name, surname, email} are still missing, since resolving a
  // single field is already exactly what the normal flow below does.
  if (!editingField) {
    const stillMissingCount = (["name", "surname", "email"] as const).filter((f) => !draft[f]).length
    if (stillMissingCount > 1) {
      const smart = await trySmartRegistrationEntry(phone, rawValue, draft, resume)
      if (smart) return smart
    }
  }

  // ---- name / surname / email ----
  let progress
  try {
    progress = await continueRegistration(phone, field, rawValue)
  } catch (err) {
    return {
      reply: reRaskWithError(field, errorMessage(err)),
      buttons: [],
      nextState: state,
    }
  }

  const newDraft: RegistrationDraft = { ...draft, [field]: rawValue }

  // If we got here via "Edit" from the confirmation screen, go straight
  // back to confirmation instead of advancing through the normal sequence.
  if (editingField) {
    return toConfirmation(newDraft, resume)
  }

  // No more fields left (email was the last one) → go to confirmation.
  if (!progress.nextField) {
    return toConfirmation(newDraft, resume)
  }

  return {
    reply: promptForField(progress.nextField),
    buttons: [],
    nextState: {
      state: FIELD_TO_STATE[progress.nextField],
      data: { resume, draft: newDraft },
    },
  }
}

async function handleConfirmation(
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult> {
  const resume = getResume(state)
  const draft = getDraft(state)
  const rawValue = rawTextOf(message)

  if (matchesButton(rawValue, CONFIRM_BUTTON)) {
    // Guard against a corrupted/partial draft (shouldn't happen in normal
    // flow, but don't let it crash completeWhatsAppRegistration).
    const missingField = (["name", "surname", "email"] as CustomerField[]).find(
      (f) => !draft[f],
    )
    if (missingField) {
      return {
        reply: promptForField(missingField),
        buttons: [],
        nextState: { state: FIELD_TO_STATE[missingField], data: { resume, draft } },
      }
    }

    return {
      reply: ageConfirmationPrompt(),
      buttons: [AGE_CONFIRM_YES_BUTTON, AGE_CONFIRM_NO_BUTTON],
      nextState: { state: AGE_CONFIRMATION_STATE, data: { resume, draft } },
    }
  }

  if (matchesButton(rawValue, EDIT_BUTTON)) {
    return {
      reply: editChoicePromptMessage(),
      buttons: [EDIT_NAME_BUTTON, EDIT_SURNAME_BUTTON, EDIT_EMAIL_BUTTON],
      nextState: { state: EDIT_CHOICE_STATE, data: { resume, draft } },
    }
  }

  return {
    reply: DIDNT_CATCH_THAT + confirmationSummary(draft),
    buttons: [CONFIRM_BUTTON, EDIT_BUTTON],
    nextState: state,
  }
}

/**
 * Handles the reply to ageConfirmationPrompt() — the last question of
 * registration. "Yes" is exactly the old CONFIRM_BUTTON success path
 * (create the account, then resume or show the welcome menu); "No" declines
 * without creating an account.
 */
async function handleAgeConfirmation(
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult> {
  const resume = getResume(state)
  const draft = getDraft(state)
  const rawValue = rawTextOf(message)

  if (matchesButton(rawValue, AGE_CONFIRM_YES_BUTTON)) {
    try {
      await completeWhatsAppRegistration(message.from)
    } catch (err) {
      return {
        reply: `⚠️ ${errorMessage(err)}\n\n${ageConfirmationPrompt()}`,
        buttons: [AGE_CONFIRM_YES_BUTTON, AGE_CONFIRM_NO_BUTTON],
        nextState: state,
      }
    }

    if (resume) {
      return {
        reply: ageConfirmedWithResumeMessage(resume.replyText),
        buttons: resume.buttons ?? [],
        nextState: resume.targetState,
      }
    }

    return {
      reply: welcomeMenuMessage(),
      buttons: WELCOME_MENU_BUTTONS,
      nextState: null,
    }
  }

  if (matchesButton(rawValue, AGE_CONFIRM_NO_BUTTON)) {
    return {
      reply: AGE_RESTRICTION_DECLINED,
      buttons: [],
      nextState: null,
    }
  }

  return {
    reply: DIDNT_CATCH_THAT + ageConfirmationPrompt(),
    buttons: [AGE_CONFIRM_YES_BUTTON, AGE_CONFIRM_NO_BUTTON],
    nextState: { state: AGE_CONFIRMATION_STATE, data: { resume, draft } },
  }
}

async function handleEditChoice(
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult> {
  const resume = getResume(state)
  const draft = getDraft(state)
  const rawValue = rawTextOf(message)

  const field = Object.entries(EDIT_BUTTON_TO_FIELD).find(([button]) =>
    matchesButton(rawValue, button),
  )?.[1]

  if (!field) {
    return {
      reply: DIDNT_CATCH_THAT + editChoiceRetryMessage(),
      buttons: [EDIT_NAME_BUTTON, EDIT_SURNAME_BUTTON, EDIT_EMAIL_BUTTON],
      nextState: state,
    }
  }

  return {
    reply: promptForField(field),
    buttons: [],
    nextState: { state: FIELD_TO_STATE[field], data: { resume, draft, editingField: true } },
  }
}

async function handleState(
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult | null> {
  if (state.state === CONFIRMATION_STATE) {
    return handleConfirmation(state, message)
  }
  if (state.state === AGE_CONFIRMATION_STATE) {
    return handleAgeConfirmation(state, message)
  }
  if (state.state === EDIT_CHOICE_STATE) {
    return handleEditChoice(state, message)
  }

  const field = STATE_TO_FIELD[state.state]
  if (!field) return null // Not a registration state — defer to the next service.

  return handleField(field, state, message)
}

export const registrationService: StatefulService = {
  handleState,
}

// Convenience re-export so callers only need one import for both the gate
// check and the hand-off, e.g.:
//   const gate = await checkRegistrationGate(phone)
//   if (!gate.allowed) return beginRegistration(gate, { ...resume })
export { checkRegistrationGate }
