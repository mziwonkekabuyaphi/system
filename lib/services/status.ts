// lib/services/status.ts
/**
 * Check Status — tenant-scoped, one message in, one reply out (no state).
 * ------------------------------------------------------------------------
 * Reached two ways: tapping the "Check Status" menu row (routed by row id in
 * action-router.ts) or typing something like "check my booking" / "where am
 * I in the queue" (the "status" intent in intent-router.ts).
 *
 * Looks up THIS customer (by the WhatsApp number the message came from) for
 * THIS tenant and replies with:
 *   - their upcoming confirmed booking(s): service, date/time, reference
 *   - their active queue entry: formatted ticket (formatQueueTicketNumber),
 *     live position and ETA (getQueueSimulation — the same numbers the
 *     admin dashboard shows)
 * If they have neither, it says so and offers the menu again.
 *
 * Read-only: this file never writes to the database. Customer-facing copy
 * lives in lib/services/messages/status.ts.
 */

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { getCustomer } from "@/lib/services/tenant-customer"
import { getQueueSimulation, type QueueSimulationEntry } from "@/lib/services/queue"
import { loadCustomerActivity } from "@/lib/services/shared/customer-activity"
import { buildServicesListMessage, MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"

import {
  statusErrorMessage,
  statusMenuPromptMessage,
  statusNothingMessage,
  statusSummaryMessage,
} from "@/lib/services/messages/status"

/**
 * The menu shown under a status summary (the customer HAS a booking or queue
 * spot): only My Profile and Cancel Now. Check Status is what they just did,
 * and Book Now / Join Queue don't apply while they already have one. Filtered
 * from the shared menu by row id, so titles and ids stay defined in one place.
 * (The "nothing to show" reply below keeps the full menu.)
 */
function buildSummaryFollowUp() {
  const menu = buildServicesListMessage(statusMenuPromptMessage())
  const keep: string[] = [MENU_ROW_IDS.profile, MENU_ROW_IDS.cancel]
  if (!menu.list) return menu
  return {
    ...menu,
    list: {
      ...menu.list,
      sections: menu.list.sections.map((section) => ({
        ...section,
        rows: section.rows.filter((row) => keep.includes(row.id)),
      })),
    },
  }
}

async function handleStatus(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  try {
    const customer = await getCustomer(tenantId, message.from)

    const activity = customer ? await loadCustomerActivity(tenantId, customer.id) : null
    const hasAnything = !!activity && (activity.bookings.length > 0 || activity.walkIns.length > 0)

    if (!activity || !hasAnything) {
      return {
        reply: statusNothingMessage(),
        buttons: [],
        nextState: null,
        followUp: [buildServicesListMessage(statusMenuPromptMessage())],
      }
    }

    // Live position/ETA only matters if they are in the queue. A failure
    // here must not hide their booking details — fall back to no position.
    const inQueue = activity.walkIns.length > 0 || activity.bookings.some((b) => b.queueEntry)
    let simulation: Map<string, QueueSimulationEntry> | null = null
    if (inQueue) {
      try {
        simulation = await getQueueSimulation(tenantId)
      } catch (error) {
        console.error("[status] Queue simulation failed, showing status without position", { tenantId, error })
      }
    }

    return {
      reply: statusSummaryMessage(activity, simulation),
      buttons: [],
      nextState: null,
      followUp: [buildSummaryFollowUp()],
    }
  } catch (error) {
    console.error("[status] Error checking status", { tenantId, error })
    return { reply: statusErrorMessage(), buttons: [], nextState: null }
  }
}

export const statusService = {
  handleStatus,
}
