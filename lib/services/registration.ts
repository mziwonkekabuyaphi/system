// lib/services/messages/registration.ts
/**
 * Customer-facing copy for the registration flow.
 * ---------------------------------------------------
 * Split out of registration.ts so prompt/button copy can be edited
 * without touching registration state logic.
 *
 * SIMPLIFIED for the multi-tenant salon/barbershop pivot (no longer
 * Rands-only): registration now only collects a full name. Phone number
 * is already known from WhatsApp (message.from), so there's nothing else
 * to ask — no email, and no alcohol age-gate (that was Rands-specific;
 * salons/barbershops don't serve alcohol on-site). See registration.ts's
 * file header for what was removed and why.
 */

import type { RegistrationDraft } from "@/lib/services/registration"

// ============================================================================
// BUTTONS
// ============================================================================

export const CONFIRM_BUTTON = "✅ Confirm"
export const EDIT_BUTTON = "✏️ Edit"

// Generic post-registration menu — booking + queue are the only two
// customer-facing flows this app has (see booking.ts / queue.ts). Update
// this if/when more customer intents are added.
export const WELCOME_MENU_BUTTONS = ["📅 Book an appointment", "🚶 Join the queue"]

// ============================================================================
// GENERIC COPY
// ============================================================================

export const DIDNT_CATCH_THAT = "Sorry, I didn't catch that. "

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return "Something went wrong with that, please try again."
}

// ============================================================================
// PROMPTS
// ============================================================================

export function promptForFullName(): string {
  return "Let's get you set up 🙌 What's your full name?"
}

export function reRaskWithError(errorText: string): string {
  return `⚠️ ${errorText}\n\n${promptForFullName()}`
}

export function confirmationSummary(draft: RegistrationDraft): string {
  return (
    `Please double-check your details before we submit:\n\n` +
    `*Full name:* ${draft.name ?? "—"}\n\n` +
    `Look good?`
  )
}

export function registrationCompleteWithResumeMessage(resumeReplyText: string): string {
  return `🎉 You're all set! Let's finish that up:\n\n${resumeReplyText}`
}

export function welcomeMenuMessage(): string {
  return "🎉 You're all set! What would you like to do?"
}
