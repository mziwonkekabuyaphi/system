// lib/services/driver-bot.ts
/**
 * Driver area of the WhatsApp bot (multi-tenant, module-gated on "orders").
 *
 * WHO IS A DRIVER: a number the shop added under Orders > Drivers. The driver is always worked out from the SENDER's
 * number by the database (driver_from_phone); an order id in a tap is never trusted on its own: every database
 * function re-checks that the job is open to / held by that driver.
 *
 * WHAT A DRIVER CAN DO
 *   "on duty" / "off duty"   only on-duty drivers are offered new jobs
 *   "jobs"                   my jobs + open jobs (+ duty switch)
 *   Take job                 first come, first served (shops in "first come" mode)
 *   Picked up                order -> out for delivery (customer is told)
 *   Delivered                order -> completed (customer is told; cash due is marked paid)
 *   Can't take it            hand a job back before pickup
 *
 * HOW IT FITS THE ROUTER: action-router.ts calls driverBotService.route() right after the staff area. It returns null
 * for anything that isn't a driver message, so customers are untouched. Typed words only trigger a lookup when nothing
 * else is going on; list taps carry what they need in the row id ("drv_take:<orderId>"), so no conversation state is used.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isModuleEnabled } from "@/lib/tenant/modules"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import { formatCurrency } from "@/lib/services/messages/orders"
import { notifyOrderStatusChange } from "@/lib/services/orders/orders.status-notify"
import {
  DRIVER_ID_PREFIX,
  DRV_DONE,
  DRV_DROP,
  DRV_DUTY,
  DRV_JOB,
  DRV_OUT,
  DRV_TAKE,
  dispatchReadyDelivery,
  jobActionRows,
  jobDetailText,
  type DriverJob,
  type OpenJob,
} from "@/lib/services/orders/orders.drivers"

export { DRIVER_ID_PREFIX }

export interface DriverIdentity {
  driverId: string
  name: string
  firstName: string
  onDuty: boolean
}

/** The driver behind this WhatsApp number, or null (not a driver, inactive, Orders off, or any lookup problem: fails closed). */
export async function getDriverForPhone(tenantId: string, phone: string): Promise<DriverIdentity | null> {
  try {
    const db = getSupabaseServerClient()
    if (!db) return null
    const { data, error } = await db.rpc("driver_from_phone", { p_tenant: tenantId, p_phone: phone })
    if (error) {
      console.error("[driver-bot] driver_from_phone failed", { tenantId, error: error.message })
      return null
    }
    if (!Array.isArray(data) || data.length !== 1) return null
    const row = data[0] as { driver_id: string; name: string; on_duty: boolean }
    return {
      driverId: row.driver_id,
      name: row.name,
      firstName: (row.name ?? "").trim().split(/\s+/)[0] || "there",
      onDuty: row.on_duty === true,
    }
  } catch (error) {
    console.error("[driver-bot] identity lookup failed", { tenantId, error })
    return null
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

type TypedIntent = "jobs" | "on" | "off"

function typedDriverIntent(raw: string): TypedIntent | null {
  const t = raw.trim().toLowerCase().replace(/[?!.]+$/g, "")
  if (!t || t.length > 30) return null
  if (/^(go )?(on ?duty|online|on shift)$/.test(t) || /^start (my )?shift$/.test(t)) return "on"
  if (/^(go )?(off ?duty|offline|off shift)$/.test(t) || /^(end|stop) (my )?shift$/.test(t)) return "off"
  if (/^(my )?(jobs?|deliver(y|ies)|driver( menu)?|open jobs)$/.test(t)) return "jobs"
  return null
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

const NOT_DRIVER = "Sorry, this number isn't set up as a driver for this shop. Ask the shop to add it under Orders > Drivers."
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function text(reply: string): ActionResult {
  return { reply, buttons: [], nextState: null }
}

function withJobActions(lead: string, job: DriverJob): ActionResult {
  return {
    reply: `${lead}${lead ? "\n\n" : ""}${jobDetailText(job)}`,
    buttons: [],
    nextState: null,
    followUp: [
      {
        reply: job.status === "out_for_delivery" ? "Tap *Delivered* once it's handed over 👇" : "Tap *Picked up* when you have the order 👇",
        list: { buttonText: "Update job", sections: [{ title: "This job", rows: jobActionRows(job) }] },
      },
    ],
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

const STATUS_WORD: Record<string, string> = { ready: "ready for pickup", out_for_delivery: "on the way" }

async function home(tenantId: string, who: DriverIdentity, lead = ""): Promise<ActionResult> {
  const call = rpc()
  let mine: DriverJob[] = []
  let open: OpenJob[] = []
  if (call) {
    const [a, b] = await Promise.all([
      call<DriverJob[]>("driver_my_jobs", { p_tenant: tenantId, p_driver: who.driverId }),
      call<OpenJob[]>("driver_open_jobs", { p_tenant: tenantId, p_driver: who.driverId }),
    ])
    mine = Array.isArray(a.data) ? a.data : []
    open = Array.isArray(b.data) ? b.data : []
  }

  const sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> = []
  if (mine.length) {
    sections.push({
      title: "My jobs",
      rows: mine.slice(0, 4).map((j) => ({
        id: `${DRV_JOB}${j.id}`,
        title: `#${j.order_number}`,
        description: clip(`${STATUS_WORD[j.status] ?? j.status}${j.area ? ` · ${j.area}` : ""}`, 72),
      })),
    })
  }
  if (open.length) {
    sections.push({
      title: "Open jobs",
      rows: open.slice(0, 5).map((j) => ({
        id: `${DRV_TAKE}${j.id}`,
        title: `Take #${j.order_number}`,
        description: clip(`${j.area ?? "Delivery"} · fee ${formatCurrency(j.fee)}${j.cash_due > 0 ? ` · cash ${formatCurrency(j.cash_due)}` : ""}`, 72),
      })),
    })
  }
  sections.push({
    title: "Duty",
    rows: [
      who.onDuty
        ? { id: `${DRV_DUTY}off`, title: "Go off duty", description: "Stop getting new job offers" }
        : { id: `${DRV_DUTY}on`, title: "Go on duty", description: "Start getting new job offers" },
    ],
  })

  const status = who.onDuty ? "You're *on duty* ✅" : "You're *off duty*. Tap *Go on duty* to get job offers."
  const summary = `${status}\nMy jobs: ${mine.length}${open.length ? ` · Open jobs: ${open.length}` : ""}`
  return {
    reply: `${lead}${lead ? "\n\n" : ""}Hi ${who.firstName} 👋\n${summary}`,
    buttons: [],
    nextState: null,
    followUp: [{ reply: "What would you like to do?", list: { buttonText: "Driver menu", sections } }],
  }
}

function idAfter(prefix: string, id: string): string | null {
  const rest = id.slice(prefix.length)
  return /^[0-9a-f-]{36}$/i.test(rest) ? rest : null
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function setDuty(tenantId: string, who: DriverIdentity, on: boolean): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, something went wrong. Please try again.")
  const { error } = await call("driver_set_duty", { p_tenant: tenantId, p_driver: who.driverId, p_on: on })
  if (error) return text("Sorry, something went wrong. Please try again.")
  return home(tenantId, { ...who, onDuty: on }, on ? "✅ You're on duty. New jobs will be offered to you here." : "You're off duty. You won't get new job offers.")
}

async function take(tenantId: string, who: DriverIdentity, orderId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, something went wrong. Please try again.")
  const { data, error } = await call<{ outcome: string; job?: DriverJob }>("driver_claim_order", { p_tenant: tenantId, p_driver: who.driverId, p_order: orderId })
  if (error || !data) return text("Sorry, something went wrong. Please try again.")
  switch (data.outcome) {
    case "ok":
      return withJobActions("✅ It's yours!", data.job as DriverJob)
    case "taken":
      return home(tenantId, who, "Sorry, another driver already took that one.")
    case "not_allowed":
      return text("Right now the shop hands out deliveries itself. You'll get a message here when one is given to you.")
    case "not_driver":
      return text(NOT_DRIVER)
    default:
      return home(tenantId, who, "That job isn't available any more.")
  }
}

async function showJob(tenantId: string, who: DriverIdentity, orderId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, something went wrong. Please try again.")
  const { data } = await call<DriverJob[]>("driver_my_jobs", { p_tenant: tenantId, p_driver: who.driverId })
  const job = (Array.isArray(data) ? data : []).find((j) => j.id === orderId)
  return job ? withJobActions("", job) : home(tenantId, who, "That job isn't yours any more.")
}

async function pickedUp(tenantId: string, who: DriverIdentity, orderId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, something went wrong. Please try again.")
  const { data, error } = await call<{ outcome: string; job?: DriverJob; status?: string; order_number?: string }>("driver_mark_out", {
    p_tenant: tenantId,
    p_driver: who.driverId,
    p_order: orderId,
  })
  if (error || !data) return text("Sorry, something went wrong. Please try again.")
  switch (data.outcome) {
    case "ok": {
      const job = data.job as DriverJob
      await notifyOrderStatusChange({ tenantId, phone: job.customer_phone, orderNumber: job.order_number, fulfilment: "delivery", toStatus: "out_for_delivery" })
      return withJobActions("🚚 Marked as picked up. Drive safe!", job)
    }
    case "already":
      return withJobActions("", data.job as DriverJob)
    case "not_yours":
      return home(tenantId, who, "That job isn't yours.")
    default:
      return home(tenantId, who, `Order #${data.order_number ?? ""} can't be marked as picked up right now (it is ${data.status ?? "not ready"}).`)
  }
}

async function delivered(tenantId: string, who: DriverIdentity, orderId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, something went wrong. Please try again.")
  const { data, error } = await call<{ outcome: string; order_number?: string; customer_phone?: string; cash_collected?: number; status?: string }>(
    "driver_mark_delivered",
    { p_tenant: tenantId, p_driver: who.driverId, p_order: orderId },
  )
  if (error || !data) return text("Sorry, something went wrong. Please try again.")
  switch (data.outcome) {
    case "ok": {
      await notifyOrderStatusChange({ tenantId, phone: data.customer_phone, orderNumber: data.order_number ?? "", fulfilment: "delivery", toStatus: "completed" })
      const cash = Number(data.cash_collected ?? 0)
      return home(
        tenantId,
        who,
        `✅ Order #${data.order_number} delivered. Nice work!${cash > 0 ? `\n💵 You collected ${formatCurrency(cash)} cash: please hand it to the shop.` : ""}`,
      )
    }
    case "already":
      return home(tenantId, who, `Order #${data.order_number} is already marked as delivered.`)
    case "not_picked_up":
      return home(tenantId, who, `Tap *Picked up* on order #${data.order_number} first, then *Delivered*.`)
    case "not_yours":
      return home(tenantId, who, "That job isn't yours.")
    default:
      return home(tenantId, who, `Order #${data.order_number ?? ""} can't be marked as delivered right now.`)
  }
}

async function drop(tenantId: string, who: DriverIdentity, orderId: string): Promise<ActionResult> {
  const call = rpc()
  if (!call) return text("Sorry, something went wrong. Please try again.")
  const { data, error } = await call<{ outcome: string; order_number?: string }>("driver_release_order", { p_tenant: tenantId, p_driver: who.driverId, p_order: orderId })
  if (error || !data) return text("Sorry, something went wrong. Please try again.")
  switch (data.outcome) {
    case "ok":
      // First-come shops: offer it to the other drivers straight away. Dispatcher shops: it shows as unassigned on the board.
      await dispatchReadyDelivery(tenantId, orderId, { excludeDriverId: who.driverId })
      return home(tenantId, who, `Okay, order #${data.order_number} is back with the shop.`)
    case "too_late":
      return home(tenantId, who, `You've already picked up order #${data.order_number}, so it can't be handed back here. Please call the shop.`)
    default:
      return home(tenantId, who, "That job isn't yours.")
  }
}

// ---------------------------------------------------------------------------
// Router entry
// ---------------------------------------------------------------------------

export const driverBotService = {
  /** Greeting + driver menu for a known driver. */
  home,

  /**
   * Handles a message if it belongs to the driver area, else returns null so the normal flow carries on.
   * Cheap when it isn't a driver message: it only looks anyone up for a driver tap or a driver keyword typed when
   * nothing else is going on.
   */
  async route(tenantId: string, state: ConversationState | null, message: IncomingMessage): Promise<ActionResult | null> {
    const id = message.interactiveId
    const isTap = !!id && id.startsWith(DRIVER_ID_PREFIX)
    const keyword = !id && !state ? typedDriverIntent(message.text ?? "") : null
    if (!isTap && !keyword) return null

    const who = await getDriverForPhone(tenantId, message.from)
    if (!who) {
      if (!isTap) return null // an ordinary customer who typed "jobs": not our business
      if (!(await isModuleEnabled(tenantId, "orders"))) return text("Sorry, that service isn't available right now.")
      return text(NOT_DRIVER)
    }

    if (keyword === "on") return setDuty(tenantId, who, true)
    if (keyword === "off") return setDuty(tenantId, who, false)
    if (keyword === "jobs") return home(tenantId, who)

    const tap = id as string
    if (tap.startsWith(DRV_DUTY)) return setDuty(tenantId, who, tap.slice(DRV_DUTY.length) === "on")
    const handlers: Array<[string, (t: string, w: DriverIdentity, o: string) => Promise<ActionResult>]> = [
      [DRV_TAKE, take],
      [DRV_JOB, showJob],
      [DRV_OUT, pickedUp],
      [DRV_DONE, delivered],
      [DRV_DROP, drop],
    ]
    for (const [prefix, handler] of handlers) {
      if (tap.startsWith(prefix)) {
        const orderId = idAfter(prefix, tap)
        return orderId ? handler(tenantId, who, orderId) : home(tenantId, who)
      }
    }
    return home(tenantId, who)
  },
}
