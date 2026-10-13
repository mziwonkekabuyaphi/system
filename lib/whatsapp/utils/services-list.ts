// lib/whatsapp/utils/services-list.ts
/**
 * The QLess main menu — an interactive WhatsApp LIST with four rows:
 * Book Now, Join Queue, Check Status, Cancel Now.
 *
 * Same idea as the old Rands "services list": the menu is sent as a
 * `followUp` message after a short greeting, and every row has a fixed id.
 * action-router.ts routes a tap on one of these ids FIRST (before global
 * interrupts and before conversation state), straight to the right service,
 * without any AI intent classification.
 *
 * This file lives in utils/ (not in action-router.ts) so any service can send
 * the same menu without importing from the router, keeping the one-way
 * dependency: WhatsApp -> Intent Router -> Action Router -> Services.
 * If a row id changes here, MENU_ROW_HANDLERS in action-router.ts must change
 * with it — both use MENU_ROW_IDS, so that is a one-line change.
 *
 * WhatsApp limits (Meta truncates silently past these):
 *   - list button label: 20 characters
 *   - section title:     24 characters
 *   - row title:         24 characters
 *   - row description:   72 characters
 *   - rows in total:     10
 *
 * White-label: no shop or brand name appears in the menu.
 */

import type { FollowUpMessage } from "@/lib/types/follow-up"

export const MENU_ROW_IDS = {
  book: "menu_book",
  queue: "menu_queue",
  status: "menu_status",
  cancel: "menu_cancel",
} as const

export type MenuRowId = (typeof MENU_ROW_IDS)[keyof typeof MENU_ROW_IDS]

export function isMenuRowId(id: string | null | undefined): id is MenuRowId {
  return !!id && (Object.values(MENU_ROW_IDS) as string[]).includes(id)
}

/**
 * Builds the menu as a follow-up message.
 * @param bodyText The text shown above the "View Options" button.
 */
export function buildServicesListMessage(bodyText: string): FollowUpMessage {
  return {
    reply: bodyText,
    list: {
      buttonText: "View Options", // 12 chars
      sections: [
        {
          title: "What can I do for you?", // 21 chars
          rows: [
            {
              id: MENU_ROW_IDS.book,
              title: "📅 Book Now",
              description: "Pick a service, a day and a time",
            },
            {
              id: MENU_ROW_IDS.queue,
              title: "🚶 Join Queue",
              description: "Walk-in? Get a ticket and wait your turn",
            },
            {
              id: MENU_ROW_IDS.status,
              title: "🔎 Check Status",
              description: "See your booking or your place in the queue",
            },
            {
              id: MENU_ROW_IDS.cancel,
              title: "❌ Cancel Now",
              description: "Cancel your booking or leave the queue",
            },
          ],
        },
      ],
    },
  }
}
