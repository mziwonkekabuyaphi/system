"use server"

// app/kiosk/[slug]/actions.ts
/**
 * Public Server Actions backing the /kiosk/[slug] touch flow.
 *
 * SECURITY: every action here takes `slug` (from the URL the kiosk is
 * physically sitting at) and re-resolves `tenantId` from
 * (slug, status = 'active') itself, on every single call — it never
 * accepts or trusts a `tenantId` the client might hand back from an
 * earlier response. A kiosk is a public, unauthenticated URL; nothing
 * stops a tampered request from claiming a different tenantId. Because
 * every write below goes through resolveActiveTenantId(slug) first,
 * that's a closed door regardless of what a request claims — the only
 * thing that decides which shop's data gets touched is the slug in the
 * URL, verified fresh each time.
 *
 * DATA LAYER: bookings go through booking.ts's createBooking(), queue
 * joins go through queue.ts's joinQueue() — the exact same functions the
 * WhatsApp handlers call. No booking/queue logic is duplicated here.
 *
 * WHATSAPP CONFIRMATION (new): the kiosk ticket screen tells the
 * customer "we'll text you." This is the file that makes that true —
 * after a successful booking or queue join, sends a confirmation via
 * sendWhatsAppTextMessage() using the tenant's own WhatsApp credentials
 * (resolved per-tenant inside send-message.ts). Deliberately best-effort:
 * wrapped in its own try/catch that only logs on failure. A WhatsApp send
 * failing (tenant has no WhatsApp integration configured yet, Meta
 * hiccup, etc.) must never stop the kiosk from showing the ticket — the
 * ticket number on screen is the source of truth for the customer
 * standing at the kiosk; the text is a bonus, not a dependency. Note this
 * only applies to kiosk-originated actions: WhatsApp-originated bookings
 * already get their confirmation as the natural chat reply, so
 * createBooking()/joinQueue() themselves stay message-agnostic to avoid
 * double-sending to WhatsApp customers.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { buildDateOptions, getAvailableSlots, createBooking, BOOKING_SLOT_NO_LONGER_AVAILABLE, type BookingSlot } from "@/lib/services/booking"
import { joinQueue, formatQueueTicketNumber } from "@/lib/services/queue"
import { PLAN_VISIT_LIMIT_REACHED, isTenantModuleEnabled, MODULE_KEYS } from "@/lib/services/plans"
import { updateCustomer } from "@/lib/services/tenant-customer"
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"
import { isPlausiblePhoneNumber } from "@/lib/utils/phone"

export type KioskActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function resolveActiveTenantId(slug: string): Promise<string> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle()

  if (error) throw new Error(`Failed to resolve tenant for slug "${slug}": ${error.message}`)
  if (!data) throw new Error("KIOSK_TENANT_NOT_FOUND")

  return data.id as string
}

const KIOSK_UNAVAILABLE = "KIOSK_UNAVAILABLE"
const KIOSK_UNAVAILABLE_MESSAGE = "This kiosk isn't available right now. Please check in at the counter."

// SERVER-SIDE KIOSK GATE. page.tsx already shows "unavailable" when the
// kiosk is off, but these actions are public and callable directly with
// just a slug, so the page's check protects nothing on its own. Every
// action resolves its tenant through here: the plan must include the
// kiosk module AND the tenant's own switch must be on. Fails closed.
async function resolveKioskTenantId(slug: string): Promise<string> {
  const tenantId = await resolveActiveTenantId(slug)
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  if (!(await isTenantModuleEnabled(supabase, tenantId, MODULE_KEYS.kiosk))) throw new Error(KIOSK_UNAVAILABLE)
  return tenantId
}

function kioskErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message === KIOSK_UNAVAILABLE ? KIOSK_UNAVAILABLE_MESSAGE : fallback
}

// Same fail-closed posture as app/kiosk/[slug]/page.tsx's queueBehavior
// lookup: a missing row or query error means "require a service", not
// "silently let it through". This is the SERVER-side gate — the kiosk UI
// (KioskApp.tsx) already skips ServiceScreen when this is off, but this
// action can be called directly, so the client's choice to omit serviceId
// is never trusted on its own.
async function resolveRequireServiceSelection(tenantId: string): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data, error } = await supabase
    .from("queue_settings")
    .select("require_service_selection")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) {
    console.error("[kiosk] queue_settings lookup failed", { tenantId, error })
    return true
  }

  return data?.require_service_selection ?? true
}

// ============================================================================
// READS
// ============================================================================

export async function fetchKioskServices(slug: string): Promise<KioskActionResult<CatalogService[]>> {
  try {
    const tenantId = await resolveKioskTenantId(slug)
    const services = await getBookableServices(tenantId)
    return { ok: true, data: services }
  } catch (error) {
    console.error("[kiosk] fetchKioskServices failed", { slug, error })
    return { ok: false, error: kioskErrorMessage(error, "Couldn't load services. Please try again.") }
  }
}

export async function fetchKioskDateOptions(slug: string): Promise<KioskActionResult<Array<{ date: string; label: string }>>> {
  try {
    const tenantId = await resolveKioskTenantId(slug)
    return { ok: true, data: await buildDateOptions(tenantId) }
  } catch (error) {
    console.error("[kiosk] fetchKioskDateOptions failed", { slug, error })
    return { ok: false, error: kioskErrorMessage(error, "Something went wrong. Please try again.") }
  }
}

export async function fetchKioskTimeSlots(
  slug: string,
  serviceId: string,
  dateISO: string,
): Promise<KioskActionResult<BookingSlot[]>> {
  try {
    const tenantId = await resolveKioskTenantId(slug)
    const services = await getBookableServices(tenantId)
    const service = services.find((s) => s.id === serviceId)
    if (!service) return { ok: false, error: "That service isn't available anymore." }

    const slots = await getAvailableSlots(tenantId, dateISO, service.durationMinutes)
    return { ok: true, data: slots }
  } catch (error) {
    console.error("[kiosk] fetchKioskTimeSlots failed", { slug, serviceId, dateISO, error })
    return { ok: false, error: kioskErrorMessage(error, "Couldn't load available times. Please try again.") }
  }
}

// ============================================================================
// WRITES
// ============================================================================

export interface KioskBookingInput {
  serviceId: string
  dateISO: string
  dateLabel: string
  slot: BookingSlot
  name: string
  phone: string
}

export interface KioskBookingTicket {
  kind: "booking"
  ticketNumber: string
  customerName: string
  serviceName: string
  dateLabel: string
  slotLabel: string
}

export async function submitKioskBooking(slug: string, input: KioskBookingInput): Promise<KioskActionResult<KioskBookingTicket>> {
  const name = input.name.trim()
  if (!name || name.length < 2) return { ok: false, error: "Please enter your name." }
  if (!isPlausiblePhoneNumber(input.phone)) return { ok: false, error: "Please enter a valid cellphone number." }

  try {
    const tenantId = await resolveKioskTenantId(slug)
    const services = await getBookableServices(tenantId)
    const service = services.find((s) => s.id === input.serviceId)
    if (!service) return { ok: false, error: "That service isn't available anymore." }

    const result = await createBooking(tenantId, {
      service,
      dateISO: input.dateISO,
      slot: input.slot,
      phone: input.phone,
    })

    // WhatsApp asks for the name AFTER confirming, since the phone is
    // already known when someone messages in. The kiosk collects it up
    // front instead, so save it right away via the same updateCustomer()
    // both channels already use — one write path either way.
    await updateCustomer(tenantId, input.phone, { name })

    const ticket: KioskBookingTicket = {
      kind: "booking",
      ticketNumber: result.bookingReference,
      customerName: name,
      serviceName: service.name,
      dateLabel: input.dateLabel,
      slotLabel: input.slot.label,
    }

    try {
      await sendWhatsAppTextMessage(
        tenantId,
        input.phone,
        `Hi ${name}! You're booked for ${service.name} on ${input.dateLabel} at ${input.slot.label}. ` +
          `Your reference is ${result.bookingReference}. See you soon!`,
      )
    } catch (sendError) {
      console.error("[kiosk] Booking confirmation WhatsApp send failed", { tenantId, error: sendError })
    }

    return { ok: true, data: ticket }
  } catch (error) {
    if (error instanceof Error && error.message === BOOKING_SLOT_NO_LONGER_AVAILABLE) {
      return { ok: false, error: "That time was just taken. Please pick another." }
    }
    // Mirrors booking.ts's own PLAN_VISIT_LIMIT_REACHED message
    // (handleServiceSelection's catch block) — a plan-capped tenant gets
    // the same wording whether the booking came from WhatsApp or the
    // kiosk, and "Something went wrong, please try again" would be
    // actively misleading here since retrying can't ever succeed this
    // month.
    if (error instanceof Error && error.message === PLAN_VISIT_LIMIT_REACHED) {
      return {
        ok: false,
        error: "Sorry, this shop has reached its booking limit for this month. Please check in with staff.",
      }
    }
    console.error("[kiosk] submitKioskBooking failed", { slug, error })
    return { ok: false, error: kioskErrorMessage(error, "Something went wrong. Please try again.") }
  }
}

export interface KioskQueueInput {
  // Null when the tenant has require_service_selection off and the
  // customer never saw ServiceScreen — see KioskApp.tsx's enterQueueFlow.
  serviceId: string | null
  name: string
  phone: string
}

export interface KioskQueueTicket {
  kind: "queue"
  ticketNumber: string
  customerName: string
  // Null when this queue entry has no service attached — TicketScreen
  // should omit the service line rather than show "Unknown service".
  serviceName: string | null
  position: number
  etaMinutes: number
}

export async function submitKioskQueueJoin(slug: string, input: KioskQueueInput): Promise<KioskActionResult<KioskQueueTicket>> {
  const name = input.name.trim()
  if (!name || name.length < 2) return { ok: false, error: "Please enter your name." }
  if (!isPlausiblePhoneNumber(input.phone)) return { ok: false, error: "Please enter a valid cellphone number." }

  try {
    const tenantId = await resolveKioskTenantId(slug)
    const requireServiceSelection = await resolveRequireServiceSelection(tenantId)

    if (requireServiceSelection && !input.serviceId) {
      return { ok: false, error: "Please choose a service." }
    }

    let service: CatalogService | null = null
    if (input.serviceId) {
      const services = await getBookableServices(tenantId)
      service = services.find((s) => s.id === input.serviceId) ?? null
      if (!service) return { ok: false, error: "That service isn't available anymore." }
    }

    const { position, etaMinutes, ticketNumber, ticketPrefix } = await joinQueue(tenantId, { service, phone: input.phone })
    await updateCustomer(tenantId, input.phone, { name })

    // formatQueueTicketNumber() is the single source of truth for the
    // display format — printed slip, WhatsApp text, and (once built) any
    // "Now Serving" display all go through it, so they can never disagree.
    // ticketPrefix is this tenant's own queue_settings.ticket_number_prefix
    // (e.g. "Q", "T", a shop's initials) — never hardcoded here.
    // ticketNumber itself is permanent (queue_entries.ticket_number) —
    // unlike `position`, which reshuffles live as the queue moves, this
    // is safe to put on a piece of paper.
    const formattedTicketNumber = formatQueueTicketNumber(ticketNumber, ticketPrefix)

    try {
      const serviceClause = service ? ` for ${service.name}` : ""
      await sendWhatsAppTextMessage(
        tenantId,
        input.phone,
        `Hi ${name}! You're in the queue${serviceClause} — your ticket is ${formattedTicketNumber}, ` +
          `about ${etaMinutes} min wait. We'll see you soon!`,
      )
    } catch (sendError) {
      console.error("[kiosk] Queue confirmation WhatsApp send failed", { tenantId, error: sendError })
    }

    return {
      ok: true,
      data: {
        kind: "queue",
        ticketNumber: formattedTicketNumber,
        customerName: name,
        serviceName: service?.name ?? null,
        position,
        etaMinutes,
      },
    }
  } catch (error) {
    // Mirrors queue.ts's own PLAN_VISIT_LIMIT_REACHED message
    // (handleServiceSelection's catch block) — same reasoning as
    // submitKioskBooking's version of this above.
    if (error instanceof Error && error.message === PLAN_VISIT_LIMIT_REACHED) {
      return {
        ok: false,
        error: "Sorry, this shop has reached its queue limit for this month. Please check in with staff.",
      }
    }
    console.error("[kiosk] submitKioskQueueJoin failed", { slug, error })
    return { ok: false, error: kioskErrorMessage(error, "Something went wrong. Please try again.") }
  }
}
