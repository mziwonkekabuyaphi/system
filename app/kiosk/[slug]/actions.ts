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

import { getSupabaseServerClient } from "@/lib/supabase/server"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { buildDateOptions, getAvailableSlots, createBooking, BOOKING_SLOT_NO_LONGER_AVAILABLE, type BookingSlot } from "@/lib/services/booking"
import { joinQueue } from "@/lib/services/queue"
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

// ============================================================================
// READS
// ============================================================================

export async function fetchKioskServices(slug: string): Promise<KioskActionResult<CatalogService[]>> {
  try {
    const tenantId = await resolveActiveTenantId(slug)
    const services = await getBookableServices(tenantId)
    return { ok: true, data: services }
  } catch (error) {
    console.error("[kiosk] fetchKioskServices failed", { slug, error })
    return { ok: false, error: "Couldn't load services. Please try again." }
  }
}

export async function fetchKioskDateOptions(slug: string): Promise<KioskActionResult<Array<{ date: string; label: string }>>> {
  try {
    await resolveActiveTenantId(slug) // still gate on the tenant existing + being active
    return { ok: true, data: buildDateOptions() }
  } catch (error) {
    console.error("[kiosk] fetchKioskDateOptions failed", { slug, error })
    return { ok: false, error: "Something went wrong. Please try again." }
  }
}

export async function fetchKioskTimeSlots(
  slug: string,
  serviceId: string,
  dateISO: string,
): Promise<KioskActionResult<BookingSlot[]>> {
  try {
    const tenantId = await resolveActiveTenantId(slug)
    const services = await getBookableServices(tenantId)
    const service = services.find((s) => s.id === serviceId)
    if (!service) return { ok: false, error: "That service isn't available anymore." }

    const slots = await getAvailableSlots(tenantId, dateISO, service.durationMinutes)
    return { ok: true, data: slots }
  } catch (error) {
    console.error("[kiosk] fetchKioskTimeSlots failed", { slug, serviceId, dateISO, error })
    return { ok: false, error: "Couldn't load available times. Please try again." }
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
    const tenantId = await resolveActiveTenantId(slug)
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
    console.error("[kiosk] submitKioskBooking failed", { slug, error })
    return { ok: false, error: "Something went wrong. Please try again." }
  }
}

export interface KioskQueueInput {
  serviceId: string
  name: string
  phone: string
}

export interface KioskQueueTicket {
  kind: "queue"
  ticketNumber: string
  customerName: string
  serviceName: string
  position: number
  etaMinutes: number
}

export async function submitKioskQueueJoin(slug: string, input: KioskQueueInput): Promise<KioskActionResult<KioskQueueTicket>> {
  const name = input.name.trim()
  if (!name || name.length < 2) return { ok: false, error: "Please enter your name." }
  if (!isPlausiblePhoneNumber(input.phone)) return { ok: false, error: "Please enter a valid cellphone number." }

  try {
    const tenantId = await resolveActiveTenantId(slug)
    const services = await getBookableServices(tenantId)
    const service = services.find((s) => s.id === input.serviceId)
    if (!service) return { ok: false, error: "That service isn't available anymore." }

    const { position, etaMinutes } = await joinQueue(tenantId, { service, phone: input.phone })
    await updateCustomer(tenantId, input.phone, { name })

    const ticketNumber = `Q${String(position).padStart(3, "0")}`

    try {
      await sendWhatsAppTextMessage(
        tenantId,
        input.phone,
        `Hi ${name}! You're in the queue for ${service.name} — you're number ${position}, ` +
          `about ${etaMinutes} min wait. We'll see you soon!`,
      )
    } catch (sendError) {
      console.error("[kiosk] Queue confirmation WhatsApp send failed", { tenantId, error: sendError })
    }

    return {
      ok: true,
      data: { kind: "queue", ticketNumber, customerName: name, serviceName: service.name, position, etaMinutes },
    }
  } catch (error) {
    console.error("[kiosk] submitKioskQueueJoin failed", { slug, error })
    return { ok: false, error: "Something went wrong. Please try again." }
  }
}
