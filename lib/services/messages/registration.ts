// lib/services/messages/registration.ts
/**
 * Customer-facing copy for the registration flow.
 * ---------------------------------------------------
 * Split out of registration.ts so prompt/button copy can be edited
 * without touching registration state logic. registration.ts imports
 * everything it needs from here; nothing in this file talks to
 * customer.ts or holds any state.
 */

import type { CustomerField } from "@/lib/services/customer"
import type { RegistrationDraft } from "@/lib/services/registration"

// ============================================================================
// BUTTONS
// ============================================================================

export const WEB_REGISTER_URL = "https://mzonke-six.vercel.app/register.html"

export const CONFIRM_BUTTON = "✅ Confirm"
export const EDIT_BUTTON = "✏️ Edit something"

export const AGE_CONFIRM_YES_BUTTON = "✅ Yes, I'm 21+"
export const AGE_CONFIRM_NO_BUTTON = "❌ No"

export const ALCOHOL_MINIMUM_AGE = 21 // mirrors messages/orders.ts's ALCOHOL_MINIMUM_AGE — keep in sync

export const EDIT_NAME_BUTTON = "✏️ Name"
export const EDIT_SURNAME_BUTTON = "✏️ Surname"
export const EDIT_EMAIL_BUTTON = "✏️ Email"

export const WELCOME_MENU_BUTTONS = ["🪪 My Rands Passport", "🎟️ Buy Tickets", "🍾 Order Menu"]

// ============================================================================
// GENERIC COPY
// ============================================================================

export const DIDNT_CATCH_THAT = "Sorry, I didn't catch that. "

export const AGE_RESTRICTION_DECLINED =
  "Sorry, we're not able to open a Rands Passport for anyone under 21 — it's a legal requirement, since alcohol is served on-site. Come back and register once you turn 21!"

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return "Something went wrong with that, please try again."
}

// ============================================================================
// PROMPTS
// ============================================================================

export function promptForField(field: CustomerField): string {
  switch (field) {
    case "name":
      return "Let's get you set up 🙌 First, what's your first name?"
    case "surname":
      return "And your *surname*?"
    case "email":
      return "What's your *email address*? We'll use this for receipts and account recovery — and later, if you want to log in on the web app, we'll send a code to this WhatsApp number to set up your Passport Key."
    default:
      return "Let's finish setting up your account."
  }
}

/**
 * Appended only to the very first prompt of a registration session (see
 * registration.ts's beginRegistration) — not repeated on every subsequent
 * field, edit, or error re-ask. Shows the customer they don't have to
 * answer one question at a time and that the web app is an option.
 */
export function firstPromptExtra(field: CustomerField): string {
  const webMention = `Rather do this on your phone browser or install Rands Web App? ${WEB_REGISTER_URL}`
  if (field !== "name") return `\n\n${webMention}`
  return (
    `\n\nBtw, no need to go one at a time — you can just fire it all off in one message, ` +
    `e,g Mziwonke KaBuyaphi mzo@gmail.com and I'll pull it apart myself.\n\n` +
    webMention
  )
}

export function reRaskWithError(field: CustomerField, errorText: string): string {
  return `⚠️ ${errorText}\n\n${promptForField(field)}`
}

export function confirmationSummary(draft: RegistrationDraft): string {
  return (
    `Please double-check your details before we submit:\n\n` +
    `*Name:* ${draft.name ?? "—"}\n` +
    `*Surname:* ${draft.surname ?? "—"}\n` +
    `*Email:* ${draft.email ?? "—"}\n\n` +
    `Look good? Your passport will be created as soon as you confirm — no passport key needed. ` +
    `You can set up web login (a Passport Key) any time from the Rands Vibe web app.`
  )
}

/** The last question of registration — see registration.ts's AGE_CONFIRMATION_STATE. */
export function ageConfirmationPrompt(): string {
  return (
    `One last thing — Rands serves alcohol on-site, so by law we can only open a Passport for customers ` +
    `${ALCOHOL_MINIMUM_AGE} or older.\n\n` +
    `Are you ${ALCOHOL_MINIMUM_AGE} or older?`
  )
}

export function editChoicePromptMessage(): string {
  return "Sure — what would you like to fix?"
}

export function editChoiceRetryMessage(): string {
  return "What would you like to fix?"
}

export function ageConfirmedWithResumeMessage(resumeReplyText: string): string {
  return `🎉 You're all set — Enkosi for choosing Rands Cape Town! Let's finish that up:\n\n${resumeReplyText}`
}

export function welcomeMenuMessage(): string {
  return (
    "🎉 You're all set — welcome to Rands Cape Town! Your Passport is ready to go. " +
    "Want to log in on the web app too? Just head to the login page and enter your WhatsApp number or email — " +
    "we'll text you a code here to set up your Passport Key. Enkosi for choosing Rands\n\nWhat would you like to do?"
  )
}
