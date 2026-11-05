// lib/services/staff-bot.ts
/**
 * Staff area of the WhatsApp bot (multi-tenant, module-gated on "shifts").
 *
 * WHO IS A STAFF MEMBER: only a number that a staff member has opted in with AND
 * verified (replied YES to the verification message). The staff member is always
 * worked out from the sender's number by the database (wa_staff_from_phone); an
 * id typed or tapped in the chat is never trusted on its own: every database
 * function re-checks that the shift / request really belongs to that person.
 *
 * WHAT STAFF CAN DO
 *   - My shifts            (next shifts, published rotas only)
 *   - Ask for a swap       (pick shift -> colleague -> their shift -> note -> confirm)
 *   - Swaps for me         (accept / decline a colleague's request)
 *   - My requests          (status, and cancel an open one)
 *   - Approvals            (managers only: approve / decline a swap)
 *
 * The rules (published shifts only, minimum notice, colleague first, then manager)
 * live in the database functions in 04_staff_whatsapp_bot.sql, the same rules the
 * website uses.
 *
 * HOW IT FITS THE ROUTER: action-router.ts calls staffBotService.route() early
 * (step -1c). It returns null for anything that isn't a staff message, so customers
 * and everyone else are untouched. List rows carry what they need in their id
 * (e.g. "staff_c:<shiftId>:<colleagueId>"), so a step keeps working even if the
 * person scrolls back and taps an older list. Conversation state is only used
 * where the bot is waiting for a typed note or a button answer.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isModuleEnabled } from "@/lib/tenant/modules"
import type { ActionResult } from "@/lib/types/action"
import type { FollowUpMessage } from "@/lib/types/follow-up"
import type { ConversationState } from "@/lib/services/state"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"

// ============================================================================
// Identity
// ============================================================================

export interface StaffIdentity {
  staffId: string
  name: string
  firstName: string
  isManager: boolean
}

/**
 * The staff member behind this WhatsApp number, or null (not staff, number not
 * verified, Shifts switched off, or any lookup problem: it always fails closed).
 */
export async function getStaffForPhone(tenantId: string, phone: string): Promise<StaffIdentity | null> {
  try {
    if (!(await isModuleEnabled(tenantId, "shifts"))) return null
    const db = getSupabaseServerClient()
    if (!db) return null
    const { data, error } = await db.rpc("wa_staff_from_phone", { p_tenant_id: tenantId, p_phone: phone })
    if (error) {
      console.error("[staff-bot] wa_staff_from_phone failed", { tenantId, error: error.message })
      return null
    }
    if (!Array.isArray(data) || data.length !== 1) return null
    const row = data[0] as { staff_id: string; name: string; is_manager: boolean }
    return {
      staffId: row.staff_id,
      name: row.name,
      firstName: (row.name ?? "").trim().split(/\s+/)[0] || "there",
      isManager: row.is_manager === true,
    }
  } catch (error) {
    console.error("[staff-bot] identity lookup failed", { tenantId, error })
    return null
  }
}

// ============================================================================
// Ids, states, words
// ============================================================================

export const STAFF_ID_PREFIX = "staff_"
/** Menu-list ("main menu" -> "Staff area") row; the router sends the tap here. */
export const STAFF_MAIN_MENU_TAP = "staff_main"

const STATE_PICKING = "staff_picking"
const STATE_SWAP_NOTE = "staff_swap_note"
const STATE_SWAP_CONFIRM = "staff_swap_confirm"
const STATE_RESPOND = "staff_respond"
const STATE_CANCEL = "staff_cancel"
const STATE_REVIEW = "staff_review"

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const UUID_RE = new RegExp(`^${UUID}$`, "i")

/** Typed words that open the staff area when nothing else is going on. */
function typedStaffIntent(text: string): "shifts" | "swap" | "menu" | null {
  const t = text.trim().toLowerCase().replace(/[?!.]+$/g, "")
  if (!t || t.length > 40) return null
  if (/^(my )?(shifts?|rota|roster|schedule)$/.test(t) || /^(show|see|check) (me )?my (shifts?|rota|roster|schedule)$/.test(t)) {
    return "shifts"
  }
  if (/^(ask for a |request a |i want a |i need a )?(shift )?swap(s)?$/.test(t) || /^swap (a |my )?shift$/.test(t)) return "swap"
  if (/^staff( menu| area)?$/.test(t)) return "menu"
  return null
}

const YES_RE = /^(yes|y|yes please|confirm|confirmed)$/i
const RESET_RE = /^(menu|main menu|start over|restart|stop|cancel|back)$/i
const SKIP_RE = /^(skip|no|none|no note|-)$/i

function isYes(message: IncomingMessage, positiveButtonId = "btn_1"): boolean {
  if (message.interactiveId === positiveButtonId) return true
  const t = (message.text ?? "").trim().toLowerCase()
  return /^(yes|y|ok|okay|accept|approve|send|send it|confirm)$/.test(t)
}
function isNo(message: IncomingMessage, negativeButtonId = "btn_2"): boolean {
  if (message.interactiveId === negativeButtonId) return true
  const t = (message.text ?? "").trim().toLowerCase()
  return /^(no|n|decline|reject|cancel|keep it|keep)$/.test(t)
}

// ============================================================================
// Small helpers
// ============================================================================

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "2026-12-08" -> "Tue 8 Dec" (no timezone maths: shift dates are shop-local dates). */
function dayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  if (!y || !m || !d) return isoDate
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]}`
}
const hm = (t: string | null | undefined): string => (t ?? "").slice(0, 5)
function shiftLabel(date: string, start: string, end: string): string {
  return `${dayLabel(date)} ${hm(start)}-${hm(end)}`
}
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The database's "WA|..." messages are written for the staff member to read. */
function friendlyError(error: { message?: string } | null | undefined): string {
  const m = error?.message ?? ""
  const i = m.indexOf("WA|")
  if (i >= 0) return m.slice(i + 3).trim()
  console.error("[staff-bot] database error", m)
  return "Sorry, something went wrong. Please try again, or use the website."
}

function text(reply: string, nextState: ConversationState | null = null, buttons: string[] = []): ActionResult {
  return { reply, buttons, nextState }
}

function list(
  reply: string,
  body: string,
  buttonText: string,
  title: string,
  rows: Array<{ id: string; title: string; description?: string }>,
  nextState: ConversationState | null = { state: STATE_PICKING },
): ActionResult {
  return {
    reply,
    buttons: [],
    nextState,
    followUp: [{ reply: body, list: { buttonText, sections: [{ title, rows }] } }],
  }
}

type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message?: string } | null }>

function rpc(): Rpc | null {
  const db = getSupabaseServerClient()
  if (!db) return null
  return (async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args)
    return { data: data as never, error }
  }) as Rpc
}

// ============================================================================
// Staff menu
// ============================================================================

async function staffMenu(tenantId: string, who: StaffIdentity, lead: string): Promise<ActionResult> {
  const call = rpc()
  let forMe = 0
  let approvals = 0
  if (call) {
    const [a, b] = await Promise.all([
      call<unknown[]>("wa_swaps_for_me", { p_tenant_id: tenantId, p_staff_id: who.staffId }),
      who.isManager
        ? call<unknown[]>("wa_swaps_to_approve", { p_tenant_id: tenantId, p_staff_id: who.staffId })
        : Promise.resolve({ data: [] as unknown[], error: null }),
    ])
    forMe = Array.isArray(a.data) ? a.data.length : 0
    approvals = Array.isArray(b.data) ? b.data.length : 0
  }

  const rows = [
    { id: "staff_shifts", title: "📅 My shifts", description: "Your next shifts" },
    { id: "staff_swap", title: "🔁 Ask for a swap", description: "Swap or hand over one of your shifts" },
    {
      id: "staff_for_me",
      title: "📥 Swaps for me",
      description: forMe > 0 ? `${forMe} waiting for your answer` : "Requests from your colleagues",
    },
    { id: "staff_mine", title: "📤 My requests", description: "See or cancel your swap requests" },
    ...(who.isManager
      ? [
          {
            id: "staff_approvals",
            title: "✅ Approvals",
            description: approvals > 0 ? `${approvals} swap${approvals === 1 ? "" : "s"} waiting for you` : "Approve or decline swaps",
          },
        ]
      : []),
    { id: STAFF_MAIN_MENU_TAP, title: "↩️ Main menu", description: "Back to the shop menu" },
  ]
  const followUp: FollowUpMessage = {
    reply: "Tap below to choose 👇",
    list: { buttonText: "Staff options", sections: [{ title: "Staff area", rows }] },
  }
  return { reply: lead, buttons: [], nextState: null, followUp: [followUp] }
}

/** Used by the router for the main menu / a staff-only shop: greets a verified staff member. */
async function entry(tenantId: string, who: StaffIdentity): Promise<ActionResult> {
  return staffMenu(tenantId, who, `Hi ${who.firstName} 👋 What do you need?`)
}

async function withMenu(tenantId: string, who: StaffIdentity, reply: string): Promise<ActionResult> {
  return staffMenu(tenantId, who, reply)
}

// ============================================================================
// My shifts
// ============================================================================

interface ShiftRow {
  shift_id: string
  shift_date: string
  start_time: string
  end_time: string
  note: string | null
}

async function showMyShifts(tenantId: string, who: StaffIdentity): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<ShiftRow[]>("wa_my_shifts", { p_tenant_id: tenantId, p_staff_id: who.staffId, p_limit: 10 })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const shifts = data ?? []
  if (shifts.length === 0) {
    return withMenu(tenantId, who, "You have no upcoming shifts on a published rota. 🎉")
  }
  const lines = shifts.map((s) => `• ${shiftLabel(s.shift_date, s.start_time, s.end_time)}${s.note ? ` — ${clip(s.note, 40)}` : ""}`)
  return withMenu(tenantId, who, `📅 *Your next shifts*\n\n${lines.join("\n")}`)
}

// ============================================================================
// Ask for a swap
// ============================================================================

async function startSwap(tenantId: string, who: StaffIdentity): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<ShiftRow[]>("wa_my_shifts", { p_tenant_id: tenantId, p_staff_id: who.staffId, p_limit: 10 })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const shifts = data ?? []
  if (shifts.length === 0) return withMenu(tenantId, who, "You have no upcoming shifts to swap.")
  return list(
    "🔁 *Ask for a swap*\nWhich of your shifts would you like to swap?",
    "Choose a shift 👇",
    "My shifts",
    "Your shifts",
    shifts.map((s) => ({ id: `staff_s:${s.shift_id}`, title: shiftLabel(s.shift_date, s.start_time, s.end_time) })),
  )
}

interface CandidateRow {
  staff_id: string
  staff_name: string
  shift_id: string | null
  shift_date: string | null
  start_time: string | null
  end_time: string | null
}

async function candidates(tenantId: string, who: StaffIdentity, shiftId: string) {
  const call = rpc()
  if (!call) return { error: { message: "" }, rows: [] as CandidateRow[] }
  const { data, error } = await call<CandidateRow[]>("wa_swap_candidates", {
    p_tenant_id: tenantId,
    p_staff_id: who.staffId,
    p_shift_id: shiftId,
  })
  return { error, rows: data ?? [] }
}

async function pickColleague(tenantId: string, who: StaffIdentity, shiftId: string): Promise<ActionResult> {
  const { error, rows } = await candidates(tenantId, who, shiftId)
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const byStaff = new Map<string, { name: string; shifts: number }>()
  for (const r of rows) {
    const entry = byStaff.get(r.staff_id) ?? { name: r.staff_name, shifts: 0 }
    if (r.shift_id) entry.shifts += 1
    byStaff.set(r.staff_id, entry)
  }
  if (byStaff.size === 0) return withMenu(tenantId, who, "There are no colleagues available to swap with.")
  const rowsOut = [...byStaff.entries()].slice(0, 10).map(([id, v]) => ({
    id: `staff_c:${shiftId}:${id}`,
    title: clip(v.name, 24),
    description: v.shifts > 0 ? `${v.shifts} shift${v.shifts === 1 ? "" : "s"} you could swap with` : "No shift to swap back",
  }))
  return list("Who would you like to swap with?", "Choose a colleague 👇", "Colleagues", "Colleagues", rowsOut)
}

async function pickTheirShift(tenantId: string, who: StaffIdentity, shiftId: string, colId: string): Promise<ActionResult> {
  const { error, rows } = await candidates(tenantId, who, shiftId)
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const mine = rows.filter((r) => r.staff_id === colId)
  if (mine.length === 0) return withMenu(tenantId, who, "That colleague is not available.")
  const name = mine[0].staff_name
  const theirShifts = mine.filter((r) => r.shift_id && r.shift_date && r.start_time && r.end_time).slice(0, 9)
  const rowsOut = [
    ...theirShifts.map((r) => ({
      id: `staff_t:${shiftId}:${colId}:${r.shift_id}`,
      title: shiftLabel(r.shift_date as string, r.start_time as string, r.end_time as string),
      description: `Swap for ${clip(name, 30)}'s shift`,
    })),
    { id: `staff_t:${shiftId}:${colId}:none`, title: "Just cover my shift", description: "No shift back from them" },
  ]
  return list(
    `Swap with *${name}*. Which of their shifts would you take in return?`,
    "Choose one 👇",
    "Their shifts",
    "Their shifts",
    rowsOut,
  )
}

interface SwapDraft {
  shiftId: string
  colId: string
  theirId: string | null
  mineLabel: string
  colName: string
  theirLabel: string | null
  note?: string | null
}

async function askNote(tenantId: string, who: StaffIdentity, shiftId: string, colId: string, theirIdRaw: string): Promise<ActionResult> {
  const theirId = theirIdRaw === "none" ? null : theirIdRaw
  const [{ error, rows }, mineRes] = await Promise.all([
    candidates(tenantId, who, shiftId),
    (async () => {
      const call = rpc()
      return call ? call<ShiftRow[]>("wa_my_shifts", { p_tenant_id: tenantId, p_staff_id: who.staffId, p_limit: 10 }) : { data: [], error: null }
    })(),
  ])
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const mineShift = (mineRes.data ?? []).find((s) => s.shift_id === shiftId)
  const col = rows.filter((r) => r.staff_id === colId)
  if (!mineShift || col.length === 0) return withMenu(tenantId, who, "That shift or colleague is no longer available. Please start again.")
  const their = theirId ? col.find((r) => r.shift_id === theirId) : null
  if (theirId && !their) return withMenu(tenantId, who, "That shift is no longer available. Please start again.")
  const draft: SwapDraft = {
    shiftId,
    colId,
    theirId,
    mineLabel: shiftLabel(mineShift.shift_date, mineShift.start_time, mineShift.end_time),
    colName: col[0].staff_name,
    theirLabel: their && their.shift_date && their.start_time && their.end_time ? shiftLabel(their.shift_date, their.start_time, their.end_time) : null,
  }
  return {
    reply: `Add a short note for ${draft.colName}, or tap *Skip note*.`,
    buttons: ["Skip note"],
    nextState: { state: STATE_SWAP_NOTE, data: { draft } },
  }
}

function summaryText(d: SwapDraft): string {
  return (
    `🔁 *Swap request*\n\n` +
    `You give: ${d.mineLabel}\n` +
    `${d.theirLabel ? `You take: ${d.theirLabel}` : "You take: nothing (they cover your shift)"}\n` +
    `With: ${d.colName}` +
    `${d.note ? `\nNote: ${d.note}` : ""}\n\nSend this request?`
  )
}

async function sendSwap(tenantId: string, who: StaffIdentity, d: SwapDraft): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { error } = await call<string>("wa_request_swap", {
    p_tenant_id: tenantId,
    p_staff_id: who.staffId,
    p_shift_id: d.shiftId,
    p_target_staff_id: d.colId,
    p_target_shift_id: d.theirId,
    p_note: d.note ?? null,
  })
  if (error) return withMenu(tenantId, who, `❌ ${friendlyError(error)}`)
  return withMenu(tenantId, who, `✅ Request sent to ${d.colName}. I'll message you when they answer.`)
}

// ============================================================================
// Swaps for me (colleague answers)
// ============================================================================

interface ForMeRow {
  request_id: string
  requester_name: string
  shift_date: string
  start_time: string
  end_time: string
  their_date: string | null
  their_start: string | null
  their_end: string | null
  note: string | null
}

async function showSwapsForMe(tenantId: string, who: StaffIdentity): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<ForMeRow[]>("wa_swaps_for_me", { p_tenant_id: tenantId, p_staff_id: who.staffId })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const rows = data ?? []
  if (rows.length === 0) return withMenu(tenantId, who, "Nobody is waiting for an answer from you. 👍")
  return list(
    `📥 *Swaps for you*\n${rows.length} request${rows.length === 1 ? "" : "s"} waiting for your answer.`,
    "Choose one 👇",
    "Requests",
    "Waiting for you",
    rows.map((r) => ({
      id: `staff_r:${r.request_id}`,
      title: clip(`${r.requester_name.split(/\s+/)[0]} · ${dayLabel(r.shift_date)}`, 24),
      description: `${hm(r.start_time)}-${hm(r.end_time)}${r.their_date ? ` · you'd give ${dayLabel(r.their_date)}` : " · you'd cover it"}`,
    })),
  )
}

async function openForMe(tenantId: string, who: StaffIdentity, requestId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<ForMeRow[]>("wa_swaps_for_me", { p_tenant_id: tenantId, p_staff_id: who.staffId })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const r = (data ?? []).find((x) => x.request_id === requestId)
  if (!r) return withMenu(tenantId, who, "That request is no longer waiting for your answer.")
  const body =
    `📥 *${r.requester_name}* would like to swap with you.\n\n` +
    `You'd work: ${shiftLabel(r.shift_date, r.start_time, r.end_time)}\n` +
    `${r.their_date && r.their_start && r.their_end ? `You'd hand over: ${shiftLabel(r.their_date, r.their_start, r.their_end)}` : "You'd hand over: nothing (you just cover it)"}` +
    `${r.note ? `\nNote: ${r.note}` : ""}\n\nAfter you accept, a manager still has to approve it.`
  return { reply: body, buttons: ["Accept", "Decline"], nextState: { state: STATE_RESPOND, data: { requestId } } }
}

async function answerSwap(tenantId: string, who: StaffIdentity, requestId: string, accept: boolean): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { error } = await call<string>("wa_respond_swap", {
    p_tenant_id: tenantId,
    p_staff_id: who.staffId,
    p_request_id: requestId,
    p_accept: accept,
  })
  if (error) return withMenu(tenantId, who, `❌ ${friendlyError(error)}`)
  return withMenu(
    tenantId,
    who,
    accept ? "✅ Accepted. It now goes to a manager for approval, and I'll tell you the outcome." : "Okay, I've declined it and let them know.",
  )
}

// ============================================================================
// My requests
// ============================================================================

interface MineRow {
  request_id: string
  status: string
  shift_date: string
  start_time: string
  end_time: string
  colleague_name: string
}

const STATUS_TEXT: Record<string, string> = {
  pending_colleague: "waiting for {name}",
  pending_admin: "waiting for manager approval",
  approved: "✅ approved",
  rejected: "❌ declined by the manager",
  declined: "❌ declined by {name}",
  cancelled: "cancelled",
}

async function showMine(tenantId: string, who: StaffIdentity): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<MineRow[]>("wa_my_swaps", { p_tenant_id: tenantId, p_staff_id: who.staffId })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const rows = data ?? []
  if (rows.length === 0) return withMenu(tenantId, who, "You have no swap requests right now.")
  const lines = rows.map(
    (r) => `• ${shiftLabel(r.shift_date, r.start_time, r.end_time)}: ${(STATUS_TEXT[r.status] ?? r.status).replace("{name}", r.colleague_name.split(/\s+/)[0])}`,
  )
  const open = rows.filter((r) => r.status === "pending_colleague" || r.status === "pending_admin")
  if (open.length === 0) return withMenu(tenantId, who, `📤 *Your swap requests*\n\n${lines.join("\n")}`)
  return list(
    `📤 *Your swap requests*\n\n${lines.join("\n")}\n\nTo cancel an open one, choose it below.`,
    "Open requests 👇",
    "Cancel one",
    "Open requests",
    open.map((r) => ({
      id: `staff_m:${r.request_id}`,
      title: clip(shiftLabel(r.shift_date, r.start_time, r.end_time), 24),
      description: `With ${r.colleague_name}`,
    })),
  )
}

async function openMine(tenantId: string, who: StaffIdentity, requestId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<MineRow[]>("wa_my_swaps", { p_tenant_id: tenantId, p_staff_id: who.staffId })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const r = (data ?? []).find((x) => x.request_id === requestId && (x.status === "pending_colleague" || x.status === "pending_admin"))
  if (!r) return withMenu(tenantId, who, "That request is no longer open.")
  return {
    reply: `Cancel your swap request for ${shiftLabel(r.shift_date, r.start_time, r.end_time)} with ${r.colleague_name}?`,
    buttons: ["Cancel request", "Keep it"],
    nextState: { state: STATE_CANCEL, data: { requestId } },
  }
}

async function cancelMine(tenantId: string, who: StaffIdentity, requestId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { error } = await call<null>("wa_cancel_swap", { p_tenant_id: tenantId, p_staff_id: who.staffId, p_request_id: requestId })
  if (error) return withMenu(tenantId, who, `❌ ${friendlyError(error)}`)
  return withMenu(tenantId, who, "Done, your swap request is cancelled.")
}

// ============================================================================
// Manager approvals
// ============================================================================

interface ApproveRow {
  request_id: string
  requester_name: string
  colleague_name: string
  shift_date: string
  start_time: string
  end_time: string
  their_date: string | null
  their_start: string | null
  their_end: string | null
  note: string | null
}

async function showApprovals(tenantId: string, who: StaffIdentity): Promise<ActionResult> {
  if (!who.isManager) return withMenu(tenantId, who, "Only a manager can approve swaps.")
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<ApproveRow[]>("wa_swaps_to_approve", { p_tenant_id: tenantId, p_staff_id: who.staffId })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const rows = data ?? []
  if (rows.length === 0) return withMenu(tenantId, who, "No swaps are waiting for approval. ✅")
  return list(
    `✅ *Swap approvals*\n${rows.length} swap${rows.length === 1 ? "" : "s"} waiting for you.`,
    "Choose one 👇",
    "Approvals",
    "Waiting for approval",
    rows.map((r) => ({
      id: `staff_a:${r.request_id}`,
      title: clip(`${r.requester_name.split(/\s+/)[0]} ⇄ ${r.colleague_name.split(/\s+/)[0]}`, 24),
      description: dayLabel(r.shift_date),
    })),
  )
}

async function openApproval(tenantId: string, who: StaffIdentity, requestId: string): Promise<ActionResult> {
  if (!who.isManager) return withMenu(tenantId, who, "Only a manager can approve swaps.")
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { data, error } = await call<ApproveRow[]>("wa_swaps_to_approve", { p_tenant_id: tenantId, p_staff_id: who.staffId })
  if (error) return withMenu(tenantId, who, friendlyError(error))
  const r = (data ?? []).find((x) => x.request_id === requestId)
  if (!r) return withMenu(tenantId, who, "That swap is no longer waiting for approval.")
  const body =
    `✅ *Swap for approval*\n\n` +
    `${r.requester_name} gives: ${shiftLabel(r.shift_date, r.start_time, r.end_time)}\n` +
    `${r.colleague_name} gives: ${r.their_date && r.their_start && r.their_end ? shiftLabel(r.their_date, r.their_start, r.their_end) : "nothing (just covers)"}` +
    `${r.note ? `\nNote: ${r.note}` : ""}\n\n${r.colleague_name.split(/\s+/)[0]} has agreed. Approve it?`
  return { reply: body, buttons: ["Approve", "Decline"], nextState: { state: STATE_REVIEW, data: { requestId } } }
}

async function reviewSwap(tenantId: string, who: StaffIdentity, requestId: string, approve: boolean): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, I can't reach the shift system right now.")
  const { error } = await call<string>("wa_review_swap", {
    p_tenant_id: tenantId,
    p_staff_id: who.staffId,
    p_request_id: requestId,
    p_approve: approve,
    p_note: null,
  })
  if (error) return withMenu(tenantId, who, `❌ ${friendlyError(error)}`)
  return withMenu(
    tenantId,
    who,
    approve ? "✅ Approved. The shifts are updated and both staff will be told." : "Declined. Both staff will be told.",
  )
}

// ============================================================================
// Number confirmation ("YES" reply to the verification message)
// ============================================================================

/**
 * A staff member replying YES to "confirm this number". The database also does this
 * from a trigger on the messages table; doing it here too means the reply below is
 * right whichever happens first. Returns null when this isn't a pending verification.
 */
async function confirmVerification(tenantId: string, message: IncomingMessage): Promise<ActionResult | null> {
  try {
    const db = getSupabaseServerClient()
    if (!db) return null
    const { data, error } = await db.rpc("confirm_staff_whatsapp_by_phone", { p_tenant_id: tenantId, p_phone: message.from })
    if (error || !data) return null
    const { data: row } = await db.from("staff").select("name").eq("id", data as string).eq("tenant_id", tenantId).maybeSingle()
    const first = ((row as { name?: string } | null)?.name ?? "").trim().split(/\s+/)[0]
    return text(`Thanks${first ? ` ${first}` : ""}! ✅ Your number is confirmed. You'll get your shift, swap and pay updates here.`)
  } catch (error) {
    console.error("[staff-bot] confirmVerification failed", { tenantId, error })
    return null
  }
}

/** True when this staff member verified their number moments ago (the trigger got there first). */
async function justVerified(tenantId: string, staffId: string): Promise<boolean> {
  try {
    const db = getSupabaseServerClient()
    if (!db) return false
    const { data } = await db.from("staff").select("whatsapp_verified_at").eq("id", staffId).eq("tenant_id", tenantId).maybeSingle()
    const at = (data as { whatsapp_verified_at?: string | null } | null)?.whatsapp_verified_at
    return !!at && Date.now() - new Date(at).getTime() < 3 * 60_000
  } catch {
    return false
  }
}

// ============================================================================
// Routing
// ============================================================================

const NOT_LINKED =
  "I can't find a staff profile for this number. Ask your manager to send you the WhatsApp verification, then reply YES to it."

function stateData<T>(state: ConversationState | null): T | null {
  return (state?.data as T | undefined) ?? null
}

/** Parses "staff_x:a:b" into ["staff_x", "a", "b"] and checks every part after the first is an id (or "none"). */
function parseTap(id: string): { kind: string; parts: string[] } | null {
  const [kind, ...parts] = id.split(":")
  if (!kind) return null
  if (!parts.every((p) => UUID_RE.test(p) || p === "none")) return null
  return { kind, parts }
}

export const staffBotService = {
  /** Greeting + staff menu for a verified staff member (router: main menu / staff-only shops). */
  entry,

  /**
   * Handles a message if it belongs to the staff area, else returns null so the
   * normal customer flow carries on. Cheap when it isn't a staff message (no
   * database call): it only looks anyone up for a staff tap, an open staff
   * conversation, a staff keyword, or a bare "yes".
   */
  async route(tenantId: string, state: ConversationState | null, message: IncomingMessage): Promise<ActionResult | null> {
    const id = message.interactiveId
    const typed = (message.text ?? "").trim()
    const lower = typed.toLowerCase()
    const inStaffState = !!state?.state.startsWith(STAFF_ID_PREFIX)
    const isStaffTap = !!id && (id.startsWith(STAFF_ID_PREFIX) || id === MENU_ROW_IDS.staff)
    const keyword = !id && !state ? typedStaffIntent(typed) : null
    const yesLike = !id && !state && YES_RE.test(typed)

    if (!inStaffState && !isStaffTap && !keyword && !yesLike) return null

    const who = await getStaffForPhone(tenantId, message.from)

    if (!who) {
      // A staff member answering YES to the verification message (works even without Shifts).
      if (yesLike) return confirmVerification(tenantId, message)
      if (inStaffState || isStaffTap) return text(NOT_LINKED)
      return null
    }

    if (yesLike) {
      // Already verified and said YES moments ago: the trigger beat us to it. Confirm it nicely.
      if (await justVerified(tenantId, who.staffId)) {
        return staffMenu(tenantId, who, `Thanks ${who.firstName}! ✅ Your number is confirmed. You'll get your shift, swap and pay updates here.`)
      }
      return null
    }

    // ---- Taps on list rows (they carry their ids, so they work with no open conversation) ----
    if (id && (id.startsWith(STAFF_ID_PREFIX) || id === MENU_ROW_IDS.staff)) {
      if (id === MENU_ROW_IDS.staff) return staffMenu(tenantId, who, `Hi ${who.firstName} 👋 What do you need?`)
      switch (id) {
        case "staff_shifts":
          return showMyShifts(tenantId, who)
        case "staff_swap":
          return startSwap(tenantId, who)
        case "staff_for_me":
          return showSwapsForMe(tenantId, who)
        case "staff_mine":
          return showMine(tenantId, who)
        case "staff_approvals":
          return showApprovals(tenantId, who)
      }
      const tap = parseTap(id)
      if (!tap) return withMenu(tenantId, who, "That option has expired. Please choose again.")
      switch (tap.kind) {
        case "staff_s":
          return tap.parts.length === 1 ? pickColleague(tenantId, who, tap.parts[0]) : withMenu(tenantId, who, "Please choose again.")
        case "staff_c":
          return tap.parts.length === 2 ? pickTheirShift(tenantId, who, tap.parts[0], tap.parts[1]) : withMenu(tenantId, who, "Please choose again.")
        case "staff_t":
          return tap.parts.length === 3 ? askNote(tenantId, who, tap.parts[0], tap.parts[1], tap.parts[2]) : withMenu(tenantId, who, "Please choose again.")
        case "staff_r":
          return tap.parts.length === 1 ? openForMe(tenantId, who, tap.parts[0]) : withMenu(tenantId, who, "Please choose again.")
        case "staff_m":
          return tap.parts.length === 1 ? openMine(tenantId, who, tap.parts[0]) : withMenu(tenantId, who, "Please choose again.")
        case "staff_a":
          return tap.parts.length === 1 ? openApproval(tenantId, who, tap.parts[0]) : withMenu(tenantId, who, "Please choose again.")
        default:
          return withMenu(tenantId, who, "That option has expired. Please choose again.")
      }
    }

    // ---- Typed keywords with no conversation open ----
    if (keyword) {
      if (keyword === "shifts") return showMyShifts(tenantId, who)
      if (keyword === "swap") return startSwap(tenantId, who)
      return staffMenu(tenantId, who, `Hi ${who.firstName} 👋 What do you need?`)
    }

    // ---- Inside a staff conversation: a typed answer or a button tap ----
    if (!state) return null
    const reset = !id && RESET_RE.test(lower)
    if (reset) return staffMenu(tenantId, who, "No problem. Back to the staff menu.")

    switch (state.state) {
      case STATE_SWAP_NOTE: {
        const d = stateData<{ draft?: SwapDraft }>(state)?.draft
        if (!d) return staffMenu(tenantId, who, "Let's start again.")
        if (id && id !== "btn_1") return text("Please type a short note, or tap *Skip note*.", state, ["Skip note"])
        const note = id === "btn_1" || SKIP_RE.test(typed) ? null : clip(typed, 200)
        if (!id && !typed) return text("Please type a short note, or tap *Skip note*.", state, ["Skip note"])
        const next: SwapDraft = { ...d, note }
        return { reply: summaryText(next), buttons: ["Send request", "Cancel"], nextState: { state: STATE_SWAP_CONFIRM, data: { draft: next } } }
      }
      case STATE_SWAP_CONFIRM: {
        const d = stateData<{ draft?: SwapDraft }>(state)?.draft
        if (!d) return staffMenu(tenantId, who, "Let's start again.")
        if (isYes(message)) return sendSwap(tenantId, who, d)
        if (isNo(message)) return staffMenu(tenantId, who, "Okay, I haven't sent anything.")
        return text("Tap *Send request* to send it, or *Cancel*.", state, ["Send request", "Cancel"])
      }
      case STATE_RESPOND: {
        const rid = stateData<{ requestId?: string }>(state)?.requestId
        if (!rid || !UUID_RE.test(rid)) return staffMenu(tenantId, who, "Let's start again.")
        if (isYes(message)) return answerSwap(tenantId, who, rid, true)
        if (isNo(message)) return answerSwap(tenantId, who, rid, false)
        return text("Tap *Accept* or *Decline*.", state, ["Accept", "Decline"])
      }
      case STATE_CANCEL: {
        const rid = stateData<{ requestId?: string }>(state)?.requestId
        if (!rid || !UUID_RE.test(rid)) return staffMenu(tenantId, who, "Let's start again.")
        if (isYes(message)) return cancelMine(tenantId, who, rid)
        if (isNo(message)) return staffMenu(tenantId, who, "Okay, I've kept your request.")
        return text("Tap *Cancel request* or *Keep it*.", state, ["Cancel request", "Keep it"])
      }
      case STATE_REVIEW: {
        const rid = stateData<{ requestId?: string }>(state)?.requestId
        if (!rid || !UUID_RE.test(rid)) return staffMenu(tenantId, who, "Let's start again.")
        if (isYes(message)) return reviewSwap(tenantId, who, rid, true)
        if (isNo(message)) return reviewSwap(tenantId, who, rid, false)
        return text("Tap *Approve* or *Decline*.", state, ["Approve", "Decline"])
      }
      default:
        // STATE_PICKING (waiting for a list tap) or anything unexpected.
        return text("Please choose from the list I sent, or type *menu* to go back.", state)
    }
  },
}
