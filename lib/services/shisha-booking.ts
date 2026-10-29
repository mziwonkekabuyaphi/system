// lib/services/shisha-booking.ts
/**
 * Shisha — NEW SESSION flow (multi-tenant): station -> flavour -> confirm ->
 * 'order_session' request for staff.
 *
 * Removed vs. the single-business version: the Passport wallet-balance gate,
 * the top-up-then-resume round trip, WALLET_STATE_TOPUP_AMOUNT,
 * fulfillShishaRequestAfterTopup and topupAttemptId. This platform has no
 * wallets; a confirmed session simply becomes a pending request and staff
 * handle payment when they approve it.
 *
 * Added: tenant_id on every query/insert, shisha_settings.require_station
 * (skip the station question when a tenant doesn't use stations), and the
 * smart one-shot extraction now respects the tenant's AI on/off switch.
 *
 * Imports ONLY from shisha-shared.ts (no circular import with shisha.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { generateObject } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"
import { getAiModelName } from "@/lib/ai/openai"
import { isAiEnabledForTenant } from "@/lib/ai/settings"
import * as messages from "@/lib/services/messages/shisha"
import type { ActionResult } from "@/lib/types/action"
import {
  actionResult,
  blockIfPendingRequest,
  createShishaRequest,
  extractListSelection,
  getActiveLocations,
  getAvailableFlavours,
  getFlavourPrice,
  getRequireStation,
  logger,
  SHISHA_STATE_AWAITING_FLAVOUR,
  SHISHA_STATE_AWAITING_LOCATION,
  SHISHA_STATE_AWAITING_SESSION_CONFIRMATION,
  type NamedRow,
  type ShishaCustomerRef,
  type ShishaStateData,
} from "@/lib/services/shisha-shared"

// ============================================================================
// PARSING HELPERS
// ============================================================================

function parseYesNo(rawMessage: string): "yes" | "no" | null {
  const text = rawMessage.trim().toLowerCase()
  if (["yes", "y", "yeah", "yep", "confirm", "✅ yes"].includes(text)) return "yes"
  if (["no", "n", "nope", "cancel", "❌ no"].includes(text)) return "no"
  return null
}

/** Longest-name-first substring match against real rows. Never guesses; null = no confident match. */
function resolveNamedRow(rawMessage: string, rows: NamedRow[]): NamedRow | null {
  const lower = rawMessage.toLowerCase()
  const longestFirst = [...rows].sort((a, b) => b.name.length - a.name.length)
  for (const row of longestFirst) {
    if (lower.includes(row.name.toLowerCase())) return row
  }
  return null
}

// ============================================================================
// FLOW STEPS
// ============================================================================

/**
 * Entry to the new-session flow. If the tenant doesn't require a station,
 * skip straight to the flavour list with selectedLocation = null.
 */
export async function beginLocationStep(db: SupabaseClient, tenantId: string): Promise<ActionResult> {
  if (!(await getRequireStation(db, tenantId))) {
    return beginFlavourStep(db, tenantId, null)
  }

  const locations = await getActiveLocations(db, tenantId)
  if (locations.length === 0) {
    return actionResult(messages.NO_LOCATIONS, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }

  const list = locations.map((l, i) => `${i + 1}️⃣ ${l.name}`).join("\n")
  return actionResult(`${messages.LOCATION_REQUEST}\n\n${list}`, {
    state: SHISHA_STATE_AWAITING_LOCATION,
    data: { pendingLocations: locations },
  })
}

async function beginFlavourStep(
  db: SupabaseClient,
  tenantId: string,
  selectedLocation: string | null,
): Promise<ActionResult> {
  const flavours = await getAvailableFlavours(db, tenantId)
  if (flavours.length === 0) {
    return actionResult(messages.NO_FLAVOURS, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }

  const list = flavours.map((f, i) => `${i + 1}️⃣ ${f.name}`).join("\n")
  return actionResult(`${messages.FLAVOUR_REQUEST}\n\n${list}`, {
    state: SHISHA_STATE_AWAITING_FLAVOUR,
    data: { selectedLocation, pendingFlavours: flavours },
  })
}

function beginSessionConfirmation(
  selectedLocation: string | null,
  selectedFlavour: string,
  price: number,
): ActionResult {
  return actionResult(
    messages.sessionConfirmation(selectedLocation, selectedFlavour, price),
    { state: SHISHA_STATE_AWAITING_SESSION_CONFIRMATION, data: { selectedLocation, selectedFlavour } },
    messages.SESSION_CONFIRM_BUTTONS,
  )
}

// ============================================================================
// SMART ONE-SHOT ENTRY ("I need a shisha at Rooftop with Mint")
// ============================================================================

export const smartShishaEntrySchema = z.object({
  locationName: z.string().nullable(),
  flavourName: z.string().nullable(),
})

export type SmartShishaEntry = z.infer<typeof smartShishaEntrySchema>

export async function extractSmartShishaEntry(rawText: string): Promise<SmartShishaEntry | null> {
  if (!rawText.trim()) return null

  // A real abort (not Promise.race), so a timed-out request is cancelled, not billed in the background.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)

  try {
    const { object } = await generateObject({
      model: openai(process.env.OPENAI_CLASSIFIER_MODEL?.trim() || getAiModelName()),
      schema: smartShishaEntrySchema,
      system:
        "Extract a shisha lounge request from a WhatsApp message sent to a venue's concierge.\n" +
        "- locationName: the specific area/lounge/section requested (e.g. 'rooftop', 'garden', 'vip lounge'), " +
        "or null if no location is mentioned.\n" +
        "- flavourName: the specific shisha flavour requested (e.g. 'mint', 'double apple', 'blueberry'), or " +
        "null if no flavour is mentioned.\n" +
        "Never guess or infer a name that wasn't stated — use null for anything not clearly and explicitly " +
        "stated. Ignore generic words like 'shisha', 'hookah', or 'session' themselves.",
      prompt: rawText,
      temperature: 0,
      abortSignal: controller.signal,
    })
    return object
  } catch (error) {
    logger.error("[shisha][smart-entry] extractSmartShishaEntry failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Two-pass resolution, same contract as before: (1) free deterministic match
 * against the tenant's real stations/flavours, (2) only if something is still
 * unresolved AND this tenant has AI on, one extraction call, re-matched against
 * real rows. Only skips a step when unambiguous. Returns null to fall back to
 * the ordinary numbered flow.
 */
export async function trySmartShishaEntry(
  db: SupabaseClient,
  tenantId: string,
  rawMessage: string,
): Promise<ActionResult | null> {
  const requireStation = await getRequireStation(db, tenantId)
  const [locations, flavours] = await Promise.all([
    requireStation ? getActiveLocations(db, tenantId) : Promise.resolve<NamedRow[]>([]),
    getAvailableFlavours(db, tenantId),
  ])
  if (flavours.length === 0 || (requireStation && locations.length === 0)) return null

  let matchedLocation: NamedRow | null = requireStation
    ? (resolveNamedRow(rawMessage, locations) ?? (locations.length === 1 ? locations[0] : null))
    : null
  let matchedFlavour = resolveNamedRow(rawMessage, flavours) ?? (flavours.length === 1 ? flavours[0] : null)

  const needsExtraction = (requireStation && !matchedLocation) || !matchedFlavour
  const messageHasMoreToOffer = rawMessage.trim().split(/\s+/).length > 2

  if (needsExtraction && messageHasMoreToOffer && (await isAiEnabledForTenant(tenantId))) {
    const extracted = await extractSmartShishaEntry(rawMessage)
    if (extracted) {
      if (requireStation && !matchedLocation && extracted.locationName) {
        matchedLocation = resolveNamedRow(extracted.locationName, locations)
      }
      if (!matchedFlavour && extracted.flavourName) {
        matchedFlavour = resolveNamedRow(extracted.flavourName, flavours)
      }
    }
  }

  if (requireStation && !matchedLocation) return null // can't safely skip the station question

  const locationName = requireStation ? (matchedLocation as NamedRow).name : null
  if (!matchedFlavour) return beginFlavourStep(db, tenantId, locationName)

  const price = await getFlavourPrice(db, tenantId, matchedFlavour.name)
  if (price === null) return actionResult(messages.PRICE_UNAVAILABLE, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  return beginSessionConfirmation(locationName, matchedFlavour.name, price)
}

// ============================================================================
// SENDING THE REQUEST
// ============================================================================

async function finalizeSessionRequest(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
  location: string | null,
  flavour: string,
): Promise<ActionResult> {
  // Safety net: a pending request may have appeared (dashboard, retried
  // webhook) in the turns since the flow-entry gate.
  const blocked = await blockIfPendingRequest(db, tenantId, who)
  if (blocked) return blocked

  try {
    const price = await getFlavourPrice(db, tenantId, flavour)
    if (price === null) return actionResult(messages.PRICE_UNAVAILABLE, null, messages.SHISHA_NEXT_STEPS_BUTTONS)

    await createShishaRequest(db, {
      type: "order_session",
      tenantId,
      who,
      locationName: location,
      flavourName: flavour,
      amount: price,
    })
    return actionResult(messages.sessionRequestSent(price), null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  } catch (err) {
    logger.error("[shisha] failed to create order_session request", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    })
    return actionResult(messages.UNEXPECTED_ERROR, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
}

// ============================================================================
// STATE CONTINUATION
// ============================================================================

export async function continueLocationStep(
  db: SupabaseClient,
  tenantId: string,
  stateData: ShishaStateData,
  rawMessage: string,
): Promise<ActionResult> {
  const selection = extractListSelection(rawMessage)
  const locations = stateData.pendingLocations ?? []
  if (selection === null || !locations[selection - 1]) {
    return actionResult(messages.invalidLocation(locations.length), {
      state: SHISHA_STATE_AWAITING_LOCATION,
      data: stateData,
    })
  }
  return beginFlavourStep(db, tenantId, locations[selection - 1].name)
}

export async function continueFlavourStep(
  db: SupabaseClient,
  tenantId: string,
  stateData: ShishaStateData,
  rawMessage: string,
): Promise<ActionResult> {
  const selection = extractListSelection(rawMessage)
  const flavours = stateData.pendingFlavours ?? []
  if (selection === null || !flavours[selection - 1]) {
    return actionResult(messages.invalidFlavour(flavours.length), {
      state: SHISHA_STATE_AWAITING_FLAVOUR,
      data: stateData,
    })
  }
  if (stateData.selectedLocation === undefined) {
    // Defensive: state lost its station somehow — restart cleanly.
    return beginLocationStep(db, tenantId)
  }
  const chosenFlavour = flavours[selection - 1].name
  const price = await getFlavourPrice(db, tenantId, chosenFlavour)
  if (price === null) return actionResult(messages.PRICE_UNAVAILABLE, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  return beginSessionConfirmation(stateData.selectedLocation, chosenFlavour, price)
}

export async function continueSessionConfirmationStep(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
  stateData: ShishaStateData,
  rawMessage: string,
): Promise<ActionResult> {
  const answer = parseYesNo(rawMessage)
  if (answer === "yes") {
    if (stateData.selectedLocation === undefined || !stateData.selectedFlavour) {
      return beginLocationStep(db, tenantId)
    }
    return finalizeSessionRequest(db, tenantId, who, stateData.selectedLocation, stateData.selectedFlavour)
  }
  if (answer === "no") {
    return actionResult(messages.SESSION_REQUEST_CANCELLED, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
  return actionResult(
    messages.SESSION_CONFIRMATION_INVALID,
    { state: SHISHA_STATE_AWAITING_SESSION_CONFIRMATION, data: stateData },
    messages.SESSION_CONFIRM_BUTTONS,
  )
}
