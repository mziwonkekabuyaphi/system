// lib/services/shisha.ts
/**
 * Shisha Lounge WhatsApp service (multi-tenant, module-gated).
 *
 * CONTRACT: implements BOTH interfaces from action-router.ts:
 *   IntentService   -> { intent: "shisha", handle(tenantId, intent, message) }
 *   StatefulService -> { handleState(tenantId, state, message) }
 * plus startShishaFlow(tenantId, phone) for the main-menu row tap.
 *
 * MODULE GATE: every entry point re-checks isModuleEnabled(tenantId, "shisha")
 * itself, in addition to the guard at the top of routeAction(). The router
 * guard hides the menu row and stops stale taps; this check means the service
 * stays safe even if it is ever wired into a different route. handleState
 * returns a polite "not available" (and the router clears the state) if the
 * shop switches the module off while a customer is mid-flow.
 *
 * What this file owns: coal refill, end session, issue report, session
 * tracking, the welcome menu and the state dispatcher. Starting a new session
 * lives in shisha-booking.ts. Shared helpers/types live in shisha-shared.ts.
 *
 * Customers are identified through tenant_customers (id + normalised phone),
 * not profiles/wallets, and every query is filtered by tenant_id — see the
 * TENANT SAFETY note in shisha-shared.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isModuleEnabled } from "@/lib/tenant/modules"
import * as messages from "@/lib/services/messages/shisha"
import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import {
  beginLocationStep,
  continueFlavourStep,
  continueLocationStep,
  continueSessionConfirmationStep,
  trySmartShishaEntry,
} from "@/lib/services/shisha-booking"
import {
  actionResult,
  blockIfPendingRequest,
  createShishaRequest,
  customerOrFilter,
  extractListSelection,
  logger,
  readStateData,
  resolveCustomerRef,
  SHISHA_STATE_AWAITING_FLAVOUR,
  SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION,
  SHISHA_STATE_AWAITING_ISSUE_SELECTION,
  SHISHA_STATE_AWAITING_LOCATION,
  SHISHA_STATE_AWAITING_SESSION_CONFIRMATION,
  SHISHA_STATE_MENU,
  SHISHA_STATE_NAMES,
  type ActiveShishaSession,
  type ShishaCustomerRef,
  type ShishaStateData,
  type ShishaStateName,
} from "@/lib/services/shisha-shared"

// Re-exported so other modules have one import path for the shisha state names.
export { SHISHA_STATE_NAMES } from "@/lib/services/shisha-shared"

// ============================================================================
// SESSION LOOKUP
// ============================================================================

/**
 * shisha_sessions.remaining_time_seconds is a SNAPSHOT taken at
 * last_refill_time (no trigger/cron decrements it), so the live value is
 * computed at read time. Frozen while paused.
 */
function computeLiveRemainingSeconds(stored: number, lastRefillTime: string | null, paused: boolean): number {
  if (paused || !lastRefillTime) return Math.max(0, stored)
  const elapsed = Math.floor((Date.now() - new Date(lastRefillTime).getTime()) / 1000)
  return Math.max(0, stored - elapsed)
}

/**
 * This customer's live session in THIS tenant. 'paused' is included (the
 * single-business version only matched active/refill, so a paused customer
 * was told they had no session — but shisha_refresh_device() already treats
 * 'paused' as in-use).
 */
async function getActiveSession(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
): Promise<ActiveShishaSession | null> {
  const { data, error } = await db
    .from("shisha_sessions")
    .select(
      `
      id, total_amount, status, remaining_time_seconds, refill_count,
      last_refill_time, paused,
      shisha_devices ( device_code ),
      shisha_products ( name, price ),
      shisha_locations ( name )
    `,
    )
    .eq("tenant_id", tenantId)
    .or(customerOrFilter(who))
    .in("status", ["active", "refill", "paused"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string
      total_amount: number
      status: string
      remaining_time_seconds: number | null
      refill_count: number | null
      last_refill_time: string | null
      paused: boolean | null
      shisha_devices: { device_code: string | null } | null
      shisha_products: { name: string | null; price: number | null } | null
      shisha_locations: { name: string | null } | null
    }>()

  if (error) {
    logger.error("[shisha] failed to fetch active session", { tenantId, error: error.message })
    return null
  }
  if (!data) return null

  return {
    id: data.id,
    deviceCode: data.shisha_devices?.device_code ?? null,
    locationName: data.shisha_locations?.name ?? null,
    flavourName: data.shisha_products?.name ?? null,
    flavourPrice: data.shisha_products?.price != null ? Number(data.shisha_products.price) : null,
    amount: Number(data.total_amount),
    status: data.status,
    remainingTimeSeconds: computeLiveRemainingSeconds(
      data.remaining_time_seconds ?? 0,
      data.last_refill_time,
      data.paused ?? data.status === "paused",
    ),
    refillCount: data.refill_count ?? 0,
  }
}

/** Lightweight yes/no check (throws on a real error) for e.g. a future profile/overview line. */
export async function checkActiveShishaSession(tenantId: string, rawPhone: string): Promise<boolean> {
  const db = getSupabaseServerClient()
  if (!db) throw new Error("Supabase client unavailable")
  const who = await resolveCustomerRef(db, tenantId, rawPhone)
  const { data, error } = await db
    .from("shisha_sessions")
    .select("id")
    .eq("tenant_id", tenantId)
    .or(customerOrFilter(who))
    .in("status", ["active", "refill", "paused"])
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (error) throw error
  return data !== null
}

// ============================================================================
// MENU PARSING
// ============================================================================

type MenuChoice = "new_session" | "coal_refill" | "end_session" | "report_issue" | "track_session" | null

function parseMenuChoice(rawMessage: string): MenuChoice {
  const text = rawMessage.trim().toLowerCase()

  // A pick from the numbered menu: a bare number ("2", "number 2", "option 2").
  // Deliberately NOT "any digit anywhere" — "I need 2 hookahs" is not option 2.
  const pick = text.match(/^(?:number|no\.?|option)?\s*(\d{1,2})$/)
  const selection = pick ? parseInt(pick[1], 10) : null
  if (selection === 1) return "new_session"
  if (selection === 2) return "coal_refill"
  if (selection === 3) return "end_session"
  if (selection === 4) return "report_issue"
  if (selection === 5) return "track_session"

  // Specific actions first, so "I want to end my shisha session" is an
  // end-session request and not a new-session one just because it has "want".
  if (/refill|coal/.test(text)) return "coal_refill"
  if (/end session|end my|close/.test(text)) return "end_session"
  if (/issue|report|problem/.test(text)) return "report_issue"
  if (/track|my session|session status/.test(text)) return "track_session"

  // New session: explicit phrasing, or a request verb paired with shisha/hookah/hubbly
  // anywhere in the message ("book a shisha", "can I get a mint hookah", "I need shisha").
  const namesShisha = /\b(?:shisha|hookah|hubbly)s?\b/.test(text)
  const wantsOne = /\b(book|reserve|order|buy|start|get|want|need|like|bring|give|have|try)\b/.test(text)
  if (/new session|start.*session|smoke/.test(text) || (namesShisha && wantsOne)) return "new_session"

  // A bare mention of "hookah" (e.g. the "Track My Hookah" button) means tracking.
  if (/hookah/.test(text)) return "track_session"
  return null
}

// ============================================================================
// SESSION ACTIONS
// ============================================================================

async function beginMenu(): Promise<ActionResult> {
  return actionResult(messages.WELCOME_MENU, { state: SHISHA_STATE_MENU })
}

async function handleCoalRefillRequest(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
): Promise<ActionResult> {
  const session = await getActiveSession(db, tenantId, who)
  if (!session) return actionResult(messages.NO_ACTIVE_SESSION, null, messages.SHISHA_NEXT_STEPS_BUTTONS)

  const blocked = await blockIfPendingRequest(db, tenantId, who)
  if (blocked) return blocked

  try {
    await createShishaRequest(db, {
      type: "maintenance",
      tenantId,
      who,
      sessionId: session.id,
      locationName: session.locationName,
      flavourName: session.flavourName,
      deviceCode: session.deviceCode,
      // The single-business version hardcoded R250. Per-tenant now: the
      // flavour's own price (its comment said refills cost the session
      // price). null if unknown — staff set the amount on approval.
      amount: session.flavourPrice,
    })
    return actionResult(messages.COAL_REFILL_SENT, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  } catch (err) {
    logger.error("[shisha] failed to create maintenance request", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    })
    return actionResult(messages.UNEXPECTED_ERROR, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
}

async function trackSession(db: SupabaseClient, tenantId: string, who: ShishaCustomerRef): Promise<ActionResult> {
  const session = await getActiveSession(db, tenantId, who)
  if (!session) return actionResult(messages.NO_SESSION_TO_TRACK, null, messages.SHISHA_NEXT_STEPS_BUTTONS)

  return actionResult(
    messages.sessionStatusMessage({
      locationName: session.locationName,
      flavourName: session.flavourName ?? "Unknown",
      deviceCode: session.deviceCode,
      remainingTimeSeconds: session.remainingTimeSeconds,
      refillCount: session.refillCount,
      status: session.status as messages.ActiveSessionSummary["status"],
    }),
    null,
    messages.SHISHA_NEXT_STEPS_BUTTONS,
  )
}

async function handleEndSessionRequest(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
): Promise<ActionResult> {
  const session = await getActiveSession(db, tenantId, who)
  if (!session) return actionResult(messages.NO_ACTIVE_SESSION, null, messages.SHISHA_NEXT_STEPS_BUTTONS)

  const blocked = await blockIfPendingRequest(db, tenantId, who)
  if (blocked) return blocked

  try {
    await createShishaRequest(db, {
      type: "end_session",
      tenantId,
      who,
      sessionId: session.id,
      locationName: session.locationName,
      flavourName: session.flavourName,
      deviceCode: session.deviceCode,
      amount: session.amount,
    })
    return actionResult(messages.END_SESSION_SENT, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  } catch (err) {
    logger.error("[shisha] failed to create end_session request", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    })
    return actionResult(messages.UNEXPECTED_ERROR, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
}

async function beginIssueSelection(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
): Promise<ActionResult> {
  const session = await getActiveSession(db, tenantId, who)
  if (!session) return actionResult(messages.NO_ACTIVE_SESSION, null, messages.SHISHA_NEXT_STEPS_BUTTONS)

  const blocked = await blockIfPendingRequest(db, tenantId, who)
  if (blocked) return blocked

  return actionResult(messages.issueMenu(), {
    state: SHISHA_STATE_AWAITING_ISSUE_SELECTION,
    data: { activeSession: session },
  })
}

async function finalizeIssueReport(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
  session: ActiveShishaSession | undefined,
  issueKey: string,
  issueLabel: string,
): Promise<ActionResult> {
  const blocked = await blockIfPendingRequest(db, tenantId, who)
  if (blocked) return blocked

  try {
    await createShishaRequest(db, {
      type: "issue_report",
      tenantId,
      who,
      sessionId: session?.id ?? null,
      locationName: session?.locationName ?? null,
      flavourName: session?.flavourName ?? null,
      deviceCode: session?.deviceCode ?? null,
      issueKey,
      issueLabel,
    })
    return actionResult(messages.issueReportSent(issueLabel), null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  } catch (err) {
    logger.error("[shisha] failed to create issue_report request", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    })
    return actionResult(messages.UNEXPECTED_ERROR, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
}

// ============================================================================
// STATE DISPATCHER
// ============================================================================

async function continueShishaFlow(
  db: SupabaseClient,
  tenantId: string,
  who: ShishaCustomerRef,
  stateName: ShishaStateName,
  stateData: ShishaStateData,
  rawMessage: string,
): Promise<ActionResult> {
  switch (stateName) {
    case SHISHA_STATE_MENU: {
      const choice = parseMenuChoice(rawMessage)
      if (!choice) return actionResult(messages.MENU_CHOICE_INVALID, { state: SHISHA_STATE_MENU })
      if (choice !== "track_session") {
        const blocked = await blockIfPendingRequest(db, tenantId, who)
        if (blocked) return blocked
      }
      switch (choice) {
        case "new_session":
          return beginLocationStep(db, tenantId)
        case "coal_refill":
          return handleCoalRefillRequest(db, tenantId, who)
        case "end_session":
          return handleEndSessionRequest(db, tenantId, who)
        case "report_issue":
          return beginIssueSelection(db, tenantId, who)
        case "track_session":
          return trackSession(db, tenantId, who)
      }
    }

    case SHISHA_STATE_AWAITING_LOCATION:
      return continueLocationStep(db, tenantId, stateData, rawMessage)

    case SHISHA_STATE_AWAITING_FLAVOUR:
      return continueFlavourStep(db, tenantId, stateData, rawMessage)

    case SHISHA_STATE_AWAITING_SESSION_CONFIRMATION:
      return continueSessionConfirmationStep(db, tenantId, who, stateData, rawMessage)

    case SHISHA_STATE_AWAITING_ISSUE_SELECTION: {
      const selection = extractListSelection(rawMessage)
      const issue = selection !== null ? messages.ISSUE_TYPES[selection - 1] : undefined
      if (!issue) {
        return actionResult(messages.ISSUE_SELECTION_INVALID, {
          state: SHISHA_STATE_AWAITING_ISSUE_SELECTION,
          data: stateData,
        })
      }
      if (issue.key === "other") {
        return actionResult(messages.ISSUE_OTHER_REQUEST, {
          state: SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION,
          data: stateData,
        })
      }
      return finalizeIssueReport(db, tenantId, who, stateData.activeSession, issue.key, issue.label)
    }

    case SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION: {
      const description = rawMessage.trim()
      if (!description) {
        return actionResult(messages.ISSUE_OTHER_REQUEST, {
          state: SHISHA_STATE_AWAITING_ISSUE_DESCRIPTION,
          data: stateData,
        })
      }
      return finalizeIssueReport(db, tenantId, who, stateData.activeSession, "other", description)
    }

    default:
      return beginMenu()
  }
}

// ============================================================================
// PUBLIC SURFACE
// ============================================================================

const UNAVAILABLE: ActionResult = { reply: messages.SHISHA_UNAVAILABLE, buttons: [], nextState: null }

/** Main-menu row tap: open the numbered Shisha menu (no text parsing needed). */
async function startShishaFlow(tenantId: string, _phone: string): Promise<ActionResult> {
  if (!(await isModuleEnabled(tenantId, "shisha"))) return UNAVAILABLE
  return beginMenu()
}

/** Fresh "shisha" intent with no conversation open. */
async function handle(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  if (!(await isModuleEnabled(tenantId, "shisha"))) return UNAVAILABLE

  const db = getSupabaseServerClient()
  if (!db) {
    logger.error("[shisha] failed to get Supabase client", { tenantId })
    return actionResult(messages.TECHNICAL_DIFFICULTY, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }

  try {
    const who = await resolveCustomerRef(db, tenantId, message.from)
    const rawMessage = message.contentSummary ?? message.text ?? ""
    const choice = parseMenuChoice(rawMessage)

    // One request at a time: gate every choice that would end in a new row.
    if (choice && choice !== "track_session") {
      const blocked = await blockIfPendingRequest(db, tenantId, who)
      if (blocked) return blocked
    }

    switch (choice) {
      case "new_session":
        return (await trySmartShishaEntry(db, tenantId, rawMessage)) ?? (await beginLocationStep(db, tenantId))
      case "coal_refill":
        return await handleCoalRefillRequest(db, tenantId, who)
      case "end_session":
        return await handleEndSessionRequest(db, tenantId, who)
      case "report_issue":
        return await beginIssueSelection(db, tenantId, who)
      case "track_session":
        return await trackSession(db, tenantId, who)
      default:
        return await beginMenu()
    }
  } catch (unexpectedError) {
    logger.error("[shisha] unexpected error in handle", {
      tenantId,
      error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
    })
    return actionResult(messages.UNEXPECTED_ERROR, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
}

/** In-progress "shisha_*" conversation. Returns null for states this service doesn't own. */
async function handleState(
  tenantId: string,
  state: ConversationState,
  message: IncomingMessage,
): Promise<ActionResult | null> {
  if (!SHISHA_STATE_NAMES.has(state.state)) return null

  // Module switched off mid-conversation: end the flow politely (nextState: null clears it).
  if (!(await isModuleEnabled(tenantId, "shisha"))) return UNAVAILABLE

  const db = getSupabaseServerClient()
  if (!db) {
    logger.error("[shisha] failed to get Supabase client", { tenantId })
    return actionResult(messages.TECHNICAL_DIFFICULTY, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }

  try {
    const who = await resolveCustomerRef(db, tenantId, message.from)
    const rawMessage = message.contentSummary ?? message.text ?? ""
    return await continueShishaFlow(db, tenantId, who, state.state as ShishaStateName, readStateData(state), rawMessage)
  } catch (unexpectedError) {
    logger.error("[shisha] unexpected error in handleState", {
      tenantId,
      state: state.state,
      error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
    })
    return actionResult(messages.UNEXPECTED_ERROR, null, messages.SHISHA_NEXT_STEPS_BUTTONS)
  }
}

export const shishaService = {
  intent: "shisha" as const,
  handle,
  handleState,
  startShishaFlow,
}
