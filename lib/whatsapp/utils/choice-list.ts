// lib/whatsapp/utils/choice-list.ts
/**
 * Builds a tap-only WhatsApp list message for a purchase step (events, tiers, ...),
 * as a FollowUpMessage that send-action-result.ts delivers with sendWhatsAppListMessage.
 *
 * `body` becomes the list's message text (WhatsApp allows up to 1024 characters), so a step
 * can put its whole header in the list and return an EMPTY ActionResult.reply:
 * send-action-result.ts skips an empty main reply, which makes the step ONE message.
 *
 * WhatsApp limits enforced here (same as services-list.ts): button label 20, section title 24,
 * row title 24, row description 72, 10 rows in total across all sections.
 */

import type { FollowUpMessage } from "@/lib/types/follow-up"

export interface ChoiceRow {
  id: string
  title: string
  description?: string
}

export interface ChoiceSection {
  title: string
  rows: ChoiceRow[]
}

/** Keeps text inside a WhatsApp limit, ending with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function buildChoiceList(body: string, buttonText: string, sections: ChoiceSection[]): FollowUpMessage {
  let rowsLeft = 10
  const safeSections = sections
    .map((section) => {
      const rows = section.rows.slice(0, rowsLeft).map((row) => ({
        id: row.id,
        title: clip(row.title, 24),
        ...(row.description ? { description: clip(row.description, 72) } : {}),
      }))
      rowsLeft -= rows.length
      return { title: clip(section.title, 24), rows }
    })
    .filter((section) => section.rows.length > 0)

  return { reply: body, list: { buttonText: clip(buttonText, 20), sections: safeSections } }
}
