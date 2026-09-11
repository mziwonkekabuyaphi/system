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
 * Nothing ever asked for a name, so the customer had no way to actually
 * finish registering — the conversation dead-ended.
 *
 * This service owns the `registration_*` conversation states, walks the
 * customer through `continueRegistration()` / `completeWhatsAppRegistration()`
 * (both implemented in customer.ts), and — critically — remembers what the
 * customer was originally trying to do, so once registration completes
 * they're dropped back into that flow instead of back at the main menu.
 *
 * Flow overview:
 *   registration_awaiting_full_name
 *     -> registration_awaiting_confirmation   (review before submit)
 *        -> [Confirm] -> completeWhatsAppRegistration() -> resume / welcome menu
 *        -> [Edit]    -> back to registration_awaiting_full_name (editingField: true)
 *                          -> back to registration_awaiting_confirmation
 *
 * SIMPLIFIED (multi-tenant salon/barbershop pivot — no longer Rands-only):
 * this used to collect name + surname + email, then ask a one-time "are
 * you 21+?" question before creating the account (Rands served alcohol
 * on-site). None of that applies to a generic booking/queue platform for
 * salons and barbershops, so this file no longer:
 *   - asks for an email address at all
 *   - splits name into separate name/surname fields — tenant_customers
 *     now has a single full_name column (see app/admin/page.tsx's file
 *     header for the schema note), so registration just collects one
 *     "full name" answer
 *   - has an age-confirmation state/step of any kind
 *   - does AI-based "smart multi-field entry" extraction — that machinery
 *     existed purely to fill 3 fields from one free-text message; with a
 *     single field there's nothing left to shortcut, so it's been removed
 *     along with the `ai`/`@ai-sdk/openai`/`zod` dependencies it needed.
 *
 * ASSUMPTION: continueRegistration() is called with field id "name" (not
 * a new "fullName" id) so this change doesn't also require touching
 * customer.ts's CustomerField type — on the assumption that "name" is
 * (or will be) what writes to tenant_customers.full_name. If customer.ts
 * still treats "name" as just a first name / expects a separate surname,
 * it needs a matching update.
 *
 * UPDATED: customer.ts has now been rebuilt against tenant_customers, and
 * every one of its exports takes `tenantId` as its first argument —
 * tenant_customers has no unique-on-phone constraint, so (tenant_id,
 * phone) is the only safe identity key, same as conversation_states.
 *
 * CORRECTION: an earlier version of this file assumed `IncomingMessage`
 * carried a `tenantId` field and read `message.tenantId` directly. Checked
 * against the actual parser (lib/whatsapp/parse-webhook.ts) — it doesn't.
 * `IncomingMessage` only carries `phoneNumberId` (Meta's WhatsApp Business
 * number id), with its own doc comment saying that's deliberately the join
 * key back to `tenant_whatsapp_integrations.phone_number_id`, "used to
 * resolve which tenant owns this conversation before anything else runs."
 * In other words: tenant resolution is meant to happen ONCE, upstream of
 * this file (in reply.ts / action-router.ts), not be re-derived here from
 * the message itself.
 *
 * RESOLVED: confirmed against the actual action-router.ts and reply.ts —
 * `StatefulService.handleState()` now takes `(state, message, tenantId)`,
 * with `tenantId` resolved once in action-router.ts's `routeAction()` and
 * threaded down through `delegateState()`. action-router.ts and
 * bookingService/queueService are updated to match.
 *
 * ALSO CORRECTED: this file (and customer.ts) previously conflated two
 * separate identity systems. `lib/services/customer.ts` still owns the
 * Rands profiles/wallet/Passport Key system for orders.ts/vvip.ts/
 * wallet.ts — it was NOT rebuilt. The tenant_customers-backed rebuild
 * lives in a new, separate file, `lib/services/tenant-customer.ts` (see
 * its header), which is what this file now imports from. reply.ts (the
 * tenant-scoped entry point) only ever calls into tenant-customer.ts, and
 * this file matches that.
 *
 * Dependency direction: this file only imports from tenant-customer.ts,
 * state.ts, and its own message-copy module. It deliberately does NOT
 * import anything from orders.ts, vvip.ts, or wallet.ts (see StatefulService
 * contract in action-router.ts) — callers pass in everything needed to
 * resume as plain data (`PendingResumeAction`), not as a callback into
 * their own module.
 *
 * All customer-facing copy lives in lib/services/messages/registration.ts
 * — this file only owns state transitions.
 */

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import {
  checkRegistrationGate,
  continueRegistration,
  completeWhatsAppRegistration,
  type RegistrationGate,
} from "@/lib/services/tenant-customer"
import type { StatefulService } from "@/lib/whatsapp/action-router"

import {
  CONFIRM_BUTTON,
  EDIT_BUTTON,
  WELCOME_MENU_BUTTONS,
  DIDNT_CATCH_THAT,
  errorMessage,
  promptForFullName,
  reRaskWithError,
  confirmationSummary,
  registrationCompleteWithResumeMessage,
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
 * Answer collected so far this registration session. Persisted via
 * continueRegistration() as soon as it's given, so partial progress
 * survives a dropped conversation.
 *
 * Exported so lib/services/messages/registration.ts can type
 * confirmationSummary() without duplicating this shape.
 */
export interface RegistrationDraft {
  name?: string
}

const REGISTRATION_STATE_PREFIX = "registration_awaiting_"
const FULL_NAME_STATE = `${REGISTRATION_STATE_PREFIX}full_name`
const CONFIRMATION_STATE = `${REGISTRATION_STATE_PREFIX}confirmation`

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
// ENTRY POINT — called by orders.ts / vvip.ts / wallet.ts / booking.ts (and
// any future guarded action) when checkRegistrationGate() returns
// `allowed: false`.
// ============================================================================

/**
 * Kicks off (or resumes) the registration conversation. There's only one
 * field to collect now, so unlike the old multi-field version this always
 * starts at the full-name prompt — `gate` is accepted purely to keep the
 * call site (`checkRegistrationGate()` -> `beginRegistration()`) unchanged
 * for callers.
 *
 * @param resume  What the customer was trying to do when they got gated,
 *                so we can hand them back to it once registration
 *                completes. Pass `null` if there's nothing to resume (e.g.
 *                a customer proactively starting registration with no
 *                pending purchase).
 */
export function beginRegistration(
  _gate: RegistrationGate,
  resume: PendingResumeAction | null,
): ActionResult {
  return {
    reply: promptForFullName(),
    buttons: [],
    nextState: {
      state: FULL_NAME_STATE,
      data: { resume, draft: {} },
    },
  }
}

// ============================================================================
// helpers for building the "go to confirmation" result
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

async function handleFullName(
  state: ConversationState,
  message: IncomingMessage,
  tenantId: string,
): Promise<ActionResult> {
  const resume = getResume(state)
  const rawValue = rawTextOf(message)

  if (!rawValue) {
    return {
      reply: DIDNT_CATCH_THAT + promptForFullName(),
      buttons: [],
      nextState: state,
    }
  }

  try {
    // See file-header ASSUMPTION: "name" is the field id that persists to
    // tenant_customers.full_name. `tenantId` is passed in by the caller
    // (resolved upstream from message.phoneNumberId) rather than read off
    // the message itself — see file-header CORRECTION.
    await continueRegistration(tenantId, message.from, "name", rawValue)
  } catch (err) {
    return {
      reply: reRaskWithError(errorMessage(err)),
      buttons: [],
      nextState: state,
    }
  }

  return toConfirmation({ name: rawValue }, resume)
}

async function handleConfirmation(
  state: ConversationState,
  message: IncomingMessage,
  tenantId: string,
): Promise<ActionResult> {
  const resume = getResume(state)
  const draft = getDraft(state)
  const rawValue = rawTextOf(message)

  if (matchesButton(rawValue, CONFIRM_BUTTON)) {
    // Guard against a corrupted/partial draft (shouldn't happen in normal
    // flow, but don't let it crash completeWhatsAppRegistration).
    if (!draft.name) {
      return {
        reply: promptForFullName(),
        buttons: [],
        nextState: { state: FULL_NAME_STATE, data: { resume } },
      }
    }

    try {
      await completeWhatsAppRegistration(tenantId, message.from)
    } catch (err) {
      return {
        reply: `⚠️ ${errorMessage(err)}\n\n${confirmationSummary(draft)}`,
        buttons: [CONFIRM_BUTTON, EDIT_BUTTON],
        nextState: state,
      }
    }

    if (resume) {
      return {
        reply: registrationCompleteWithResumeMessage(resume.replyText),
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

  if (matchesButton(rawValue, EDIT_BUTTON)) {
    return {
      reply: promptForFullName(),
      buttons: [],
      nextState: { state: FULL_NAME_STATE, data: { resume, draft, editingField: true } },
    }
  }

  return {
    reply: DIDNT_CATCH_THAT + confirmationSummary(draft),
    buttons: [CONFIRM_BUTTON, EDIT_BUTTON],
    nextState: state,
  }
}

async function handleState(
  state: ConversationState,
  message: IncomingMessage,
  tenantId: string,
): Promise<ActionResult | null> {
  if (state.state === CONFIRMATION_STATE) {
    return handleConfirmation(state, message, tenantId)
  }
  if (state.state === FULL_NAME_STATE) {
    return handleFullName(state, message, tenantId)
  }

  return null // Not a registration state — defer to the next service.
}

export const registrationService: StatefulService = {
  handleState,
}

// Convenience re-export so callers only need one import for both the gate
// check and the hand-off, e.g.:
//   const gate = await checkRegistrationGate(tenantId, phone)
//   if (!gate.allowed) return beginRegistration(gate, { ...resume })
export { checkRegistrationGate }
