// lib/types/follow-up.ts
/**
 * A single extra WhatsApp message sent AFTER an ActionResult's main `reply`.
 * This is how the old Rands bot sent "greeting, then services menu": the
 * greeting is the main reply, the menu rides along as a follow-up.
 *
 * Exactly one of `buttons` / `list` is normally set; with neither, it is
 * sent as plain text. Kept in its own file so ActionResult (lib/types/action.ts)
 * can import it without importing anything from lib/whatsapp.
 */

export interface FollowUpListRow {
  id: string
  /** WhatsApp limit: 24 characters. */
  title: string
  /** WhatsApp limit: 72 characters. */
  description?: string
}

export interface FollowUpListSection {
  /** WhatsApp limit: 24 characters. */
  title?: string
  rows: FollowUpListRow[]
}

export interface FollowUpMessage {
  /**
   * An image to send (e.g. the booking ticket). When set, `reply` is used as
   * the image CAPTION (may be empty) and `buttons` / `list` are ignored.
   */
  image?: { url: string }
  /** Body text shown above the buttons / list button. */
  reply: string
  /** Up to 3 reply buttons (sent via sendWhatsAppButtonsMessage). */
  buttons?: string[]
  /** An interactive list (sent via sendWhatsAppListMessage). */
  list?: {
    /** The label on the button that opens the list. WhatsApp limit: 20 characters. */
    buttonText: string
    sections: FollowUpListSection[]
  }
}
