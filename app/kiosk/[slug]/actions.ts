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
 *
 * MULTI-SERVICE: the booking and queue paths each accept optional
 * `extraServiceIds` (the 2nd, 3rd... services a customer ticked, the first
 * stays in `serviceId`). The ids are NEVER trusted: each one is re-resolved
 * against this tenant's own bookable catalog (resolveExtraServices below), so
 * a tampered request can't attach another shop's service or an inactive one.
 * The per-tenant limit (booking_settings.max_services_per_booking /
 * queue_settings.max_services_per_queue_entry) is enforced again inside
 * createBooking()/joinQueue(); the BOOKING_/QUEUE_TOO_MANY_SERVICES errors
 * they throw are turned into friendly messages here. Omitting extraServiceIds
 * behaves exactly as before.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import {
  buildDateOptions,
  getAvailableSlots,
  createBooking,
  getBookingServiceMode,
  getMaxServicesPerBooking,
  BOOKING_SLOT_NO_LONGER_AVAILABLE,
  BOOKING_ALREADY_HAS_UPCOMING,
  BOOKING_ALREADY_IN_QUEUE,
  BOOKING_SERVICE_REQUIRED,
  BOOKING_TOO_MANY_SERVICES,
  type BookingSlot,
} from "@/lib/services/booking"
import { joinQueue, formatQueueTicketNumber, QUEUE_TOO_MANY_SERVICES } from "@/lib/services/queue"
import { PLAN_VISIT_LIMIT_REACHED, isKioskEnabled, isProductNotEnabledError } from "@/lib/services/plans"
import { updateCustomer } from "@/lib/services/tenant-customer"
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"
import { isPlausiblePhoneNumber } from "@/lib/utils/phone"
import { detailsFieldsFrom, isValidEmail, type KioskDetailsFields } from "@/lib/kiosk/detailsFields"

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
// kiosk module AND the tenant must not have switched it off. Fails closed.
async function resolveKioskTenantId(slug: string): Promise<string> {
  const tenantId = await resolveActiveTenantId(slug)
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  if (!(await isKioskEnabled(supabase, tenantId))) throw new Error(KIOSK_UNAVAILABLE)
  return tenantId
}

function kioskErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message === KIOSK_UNAVAILABLE ? KIOSK_UNAVAILABLE_MESSAGE : fallback
}

// ---- Multi-service helpers ---------------------------------------------------

// Hard ceiling on how many ids a request may carry, matching the DB's 1-5
// CHECK. Only a guard against absurd payloads; the real per-tenant limit is
// enforced by createBooking()/joinQueue().
const MAX_SERVICES_PER_REQUEST = 5

const TOO_MANY_SERVICES_MESSAGE = "You've picked more services than this shop allows. Please remove one and try again."

type ExtraServicesResult = { ok: true; extras: CatalogService[] } | { ok: false; error: string }

/**
 * Turns the client's extra service ids into catalog entries from THIS
 * tenant's own bookable catalog. Ignores blanks, repeats and the primary
 * service itself. Any id that isn't in the catalog fails the whole request
 * (a service may have been switched off since the kiosk loaded).
 */
function resolveExtraServices(
  catalog: CatalogService[],
  primaryId: string,
  extraServiceIds: unknown,
): ExtraServicesResult {
  if (extraServiceIds === undefined || extraServiceIds === null) return { ok: true, extras: [] }
  if (!Array.isArray(extraServiceIds)) return { ok: false, error: "Something went wrong. Please try again." }
  if (extraServiceIds.length > MAX_SERVICES_PER_REQUEST) return { ok: false, error: TOO_MANY_SERVICES_MESSAGE }

  const seen = new Set<string>([primaryId])
  const extras: CatalogService[] = []
  for (const id of extraServiceIds) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const found = catalog.find((s) => s.id === id)
    if (!found) return { ok: false, error: "One of those services isn't available anymore." }
    extras.push(found)
  }
  return { ok: true, extras }
}

/** "Fade + Beard trim" — what goes on the ticket and in the WhatsApp text. */
function joinServiceNames(services: CatalogService[]): string {
  return services.map((s) => s.name).join(" + ")
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

// ---- Details-screen fields ----------------------------------------------------
//
// Which fields the shop asks for (Settings > Kiosk > Details screen) is read from the
// database on every submit: the client's idea of what was asked is never trusted, so a
// shop that requires an email can't be bypassed by a direct call that leaves it out.

const MAX_EMAIL_LENGTH = 254
const MAX_CUSTOM_ANSWER_LENGTH = 120

async function resolveDetailsFields(tenantId: string): Promise<KioskDetailsFields> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data, error } = await supabase
    .from("tenant_branding")
    .select(
      "kiosk_show_name, kiosk_show_surname, kiosk_show_phone, kiosk_show_email, kiosk_email_required, kiosk_show_custom, kiosk_custom_label, kiosk_custom_required",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle()

  // On a failed lookup fall back to the defaults (name + cellphone): those are the ones the
  // rest of this file already insists on, so nothing gets through that used to be refused.
  if (error) console.error("[kiosk] details fields lookup failed", { tenantId, error })

  return detailsFieldsFrom({
    showName: data?.kiosk_show_name,
    showSurname: data?.kiosk_show_surname,
    showPhone: true,
    showEmail: data?.kiosk_show_email,
    emailRequired: data?.kiosk_email_required,
    showCustom: data?.kiosk_show_custom,
    customLabel: data?.kiosk_custom_label?.trim(),
    customRequired: data?.kiosk_custom_required,
  })
}

type SubmittedDetails =
  | { ok: true; name: string; email: string; customLabel: string; customAnswer: string }
  | { ok: false; error: string }

/** Checks what the customer typed against the fields this shop switched on. */
async function checkSubmittedDetails(
  tenantId: string,
  input: { name: string; email?: string; customAnswer?: string },
): Promise<SubmittedDetails> {
  const fields = await resolveDetailsFields(tenantId)

  const asksForName = fields.showName || fields.showSurname
  const name = asksForName ? String(input.name ?? "").trim() : ""
  if (asksForName && name.length < 2) return { ok: false, error: "Please enter your name." }
  // First name and surname arrive joined together, so a surname means at least two words.
  if (fields.showName && fields.showSurname && name.split(/\s+/).length < 2) {
    return { ok: false, error: "Please enter your name and surname." }
  }

  const email = fields.showEmail ? String(input.email ?? "").trim() : ""
  if (fields.showEmail && fields.emailRequired && !email) return { ok: false, error: "Please enter your email address." }
  if (email && (email.length > MAX_EMAIL_LENGTH || !isValidEmail(email))) {
    return { ok: false, error: "Please enter a valid email address." }
  }

  // The question comes from the shop's own setting, never from the request.
  const customLabel = fields.showCustom ? fields.customLabel.trim() : ""
  const customAnswer = fields.showCustom ? String(input.customAnswer ?? "").trim() : ""
  if (fields.showCustom && fields.customRequired && !customAnswer) {
    return { ok: false, error: `Please fill in: ${customLabel}.` }
  }
  if (customAnswer.length > MAX_CUSTOM_ANSWER_LENGTH) {
    return { ok: false, error: `Your answer must be ${MAX_CUSTOM_ANSWER_LENGTH} characters or fewer.` }
  }

  return { ok: true, name, email, customLabel, customAnswer }
}

/**
 * Settings > Kiosk > "Ask about WhatsApp updates". When a shop turns it off it does not want kiosk
 * customers messaged, so the instant confirmation texts below are skipped too. Defaults to on, and to
 * on if the lookup fails, so existing shops behave exactly as before.
 */
async function kioskWhatsAppAllowed(tenantId: string): Promise<boolean> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return true
    const { data } = await supabase
      .from("tenant_branding")
      .select("kiosk_show_whatsapp_optin")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    return data?.kiosk_show_whatsapp_optin !== false
  } catch {
    return true
  }
}

/**
 * Keeps the email / custom answer with the ticket it belongs to (table kiosk_checkin_details,
 * sql/migration_kiosk_details_fields.sql). Best-effort like the WhatsApp confirmation: the booking or
 * queue entry already exists, so a failure here is only logged and never stops the ticket showing.
 */
async function saveCheckinDetails(
  tenantId: string,
  entry: { kind: "booking" | "queue"; ticketRef: string; phone: string },
  details: { email: string; customLabel: string; customAnswer: string },
): Promise<void> {
  if (!details.email && !details.customAnswer) return
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return
    const { error } = await supabase.from("kiosk_checkin_details").insert({
      tenant_id: tenantId,
      kind: entry.kind,
      ticket_ref: entry.ticketRef,
      customer_phone: entry.phone,
      email: details.email || null,
      custom_label: details.customAnswer ? details.customLabel || null : null,
      custom_answer: details.customAnswer || null,
    })
    if (error) console.error("[kiosk] saving check-in details failed", { tenantId, error })
  } catch (error) {
    console.error("[kiosk] saving check-in details failed", { tenantId, error })
  }
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
  // Null = no service chosen: only accepted while the shop has "require a service to book" off.
  serviceId: string | null,
  dateISO: string,
  // Optional 2nd, 3rd... services (multi-service bookings). Omitted = one
  // service, exactly as before.
  extraServiceIds?: string[],
): Promise<KioskActionResult<BookingSlot[]>> {
  try {
    const tenantId = await resolveKioskTenantId(slug)

    // No service: the booking is the shop's default appointment length. The setting is read
    // here every time, never taken from the client, so a shop that still requires a service
    // can't be tricked into offering times without one.
    if (!serviceId) {
      const mode = await getBookingServiceMode(tenantId)
      if (mode.requireService) return { ok: false, error: "Please choose a service." }
      return { ok: true, data: await getAvailableSlots(tenantId, dateISO, mode.defaultDurationMinutes) }
    }

    const services = await getBookableServices(tenantId)
    const service = services.find((s) => s.id === serviceId)
    if (!service) return { ok: false, error: "That service isn't available anymore." }

    const resolved = resolveExtraServices(services, service.id, extraServiceIds)
    if (!resolved.ok) return { ok: false, error: resolved.error }

    // The booking is as long as every chosen service added together, so the
    // times offered must have room for the whole thing.
    if (resolved.extras.length > 0 && 1 + resolved.extras.length > (await getMaxServicesPerBooking(tenantId))) {
      return { ok: false, error: TOO_MANY_SERVICES_MESSAGE }
    }
    const totalMinutes = service.durationMinutes + resolved.extras.reduce((sum, s) => sum + s.durationMinutes, 0)

    const slots = await getAvailableSlots(tenantId, dateISO, totalMinutes)
    return { ok: true, data: slots }
  } catch (error) {
    console.error("[kiosk] fetchKioskTimeSlots failed", { slug, serviceId, extraServiceIds, dateISO, error })
    return { ok: false, error: kioskErrorMessage(error, "Couldn't load available times. Please try again.") }
  }
}

// ============================================================================
// WRITES
// ============================================================================

export interface KioskBookingInput {
  /** Null when the shop has "require a service to book" off and the customer was never
   *  shown the service screen. Re-checked server-side (createBooking). */
  serviceId: string | null
  /** 2nd, 3rd... services. Optional: omitted = a single-service booking. Ignored when serviceId is null. */
  extraServiceIds?: string[]
  dateISO: string
  dateLabel: string
  slot: BookingSlot
  /** First name and surname joined ("Mziwonke Dlamini"). May be empty when the shop doesn't ask for a name. */
  name: string
  phone: string
  /** Only used when the shop asks for them (Settings > Kiosk > Details screen); re-checked server-side. */
  email?: string
  customAnswer?: string
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
  if (!isPlausiblePhoneNumber(input.phone)) return { ok: false, error: "Please enter a valid cellphone number." }

  try {
    const tenantId = await resolveKioskTenantId(slug)
    const details = await checkSubmittedDetails(tenantId, input)
    if (!details.ok) return { ok: false, error: details.error }
    const name = details.name

    // Null serviceId = booked without a service. Only legal while the shop has that switched
    // on: createBooking re-reads the setting and throws BOOKING_SERVICE_REQUIRED otherwise.
    let service: CatalogService | null = null
    let extraServices: CatalogService[] = []
    if (input.serviceId) {
      const services = await getBookableServices(tenantId)
      service = services.find((s) => s.id === input.serviceId) ?? null
      if (!service) return { ok: false, error: "That service isn't available anymore." }

      const resolved = resolveExtraServices(services, service.id, input.extraServiceIds)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      extraServices = resolved.extras
    }
    const chosenServices = service ? [service, ...extraServices] : []
    // "" when there is no service: the ticket then hides its Service row.
    const serviceNames = joinServiceNames(chosenServices)

    const result = await createBooking(tenantId, {
      service,
      extraServices,
      dateISO: input.dateISO,
      slot: input.slot,
      phone: input.phone,
    })

    // WhatsApp asks for the name AFTER confirming, since the phone is
    // already known when someone messages in. The kiosk collects it up
    // front instead, so save it right away via the same updateCustomer()
    // both channels already use — one write path either way.
    if (name) await updateCustomer(tenantId, input.phone, { name })

    await saveCheckinDetails(tenantId, { kind: "booking", ticketRef: result.bookingReference, phone: input.phone }, details)

    const ticket: KioskBookingTicket = {
      kind: "booking",
      // Shown big on the slip: the running ticket (B0001) when there is one, else the reference.
      ticketNumber: result.ticketLabel ?? result.bookingReference,
      customerName: name,
      serviceName: serviceNames,
      dateLabel: input.dateLabel,
      slotLabel: input.slot.label,
    }

    try {
      if (await kioskWhatsAppAllowed(tenantId)) await sendWhatsAppTextMessage(
        tenantId,
        input.phone,
        `Hi${name ? ` ${name}` : ""}! You're booked${serviceNames ? ` for ${serviceNames}` : ""} on ${input.dateLabel} at ${input.slot.label}. ` +
          (result.ticketLabel ? `Your ticket is ${result.ticketLabel}. ` : "") +
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
    if (error instanceof Error && error.message === BOOKING_TOO_MANY_SERVICES) {
      return { ok: false, error: TOO_MANY_SERVICES_MESSAGE }
    }
    // Expected business-rule refusal (DB trigger): not logged as an error.
    if (error instanceof Error && error.message === BOOKING_ALREADY_HAS_UPCOMING) {
      return {
        ok: false,
        error: "This number already has an upcoming booking. Please speak to staff if you need to change it.",
      }
    }
    if (error instanceof Error && error.message === BOOKING_SERVICE_REQUIRED) {
      return { ok: false, error: "Please choose a service." }
    }
    // Still in the walk-in line (including a booking already moved into it): the database
    // refuses a second booking. Without this the customer only saw "Something went wrong".
    if (error instanceof Error && error.message === BOOKING_ALREADY_IN_QUEUE) {
      return { ok: false, error: "This number is already in the queue. Please check in with staff." }
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
    // Booking switched off for this shop (stale kiosk screen, or a direct call).
    if (isProductNotEnabledError(error)) {
      return { ok: false, error: "Sorry, this shop doesn't take bookings here. Please check in with staff." }
    }
    console.error("[kiosk] submitKioskBooking failed", { slug, error })
    return { ok: false, error: kioskErrorMessage(error, "Something went wrong. Please try again.") }
  }
}

export interface KioskQueueInput {
  // Null when the tenant has require_service_selection off and the
  // customer never saw ServiceScreen — see KioskApp.tsx's enterQueueFlow.
  serviceId: string | null
  /** 2nd, 3rd... services. Optional, and ignored when serviceId is null. */
  extraServiceIds?: string[]
  /** First name and surname joined. May be empty when the shop doesn't ask for a name. */
  name: string
  phone: string
  /** Only used when the shop asks for them; re-checked server-side. */
  email?: string
  customAnswer?: string
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
  if (!isPlausiblePhoneNumber(input.phone)) return { ok: false, error: "Please enter a valid cellphone number." }

  try {
    const tenantId = await resolveKioskTenantId(slug)
    const details = await checkSubmittedDetails(tenantId, input)
    if (!details.ok) return { ok: false, error: details.error }
    const name = details.name
    const requireServiceSetting = await resolveRequireServiceSelection(tenantId)
    const catalog = await getBookableServices(tenantId)
    const services = Array.isArray(catalog) ? catalog : []

    // A shop with no services can't require one: there would be nothing to
    // choose, and the walk-in would be stuck. KioskPage applies the same
    // rule to the UI, so the screen and this server check always agree.
    const requireServiceSelection = requireServiceSetting && services.length > 0

    if (requireServiceSelection && !input.serviceId) {
      return { ok: false, error: "Please choose a service." }
    }

    let service: CatalogService | null = null
    if (input.serviceId) {
      service = services.find((s) => s.id === input.serviceId) ?? null
      if (!service) return { ok: false, error: "That service isn't available anymore." }
    }

    // Extra services only make sense on top of a first one.
    let extraServices: CatalogService[] = []
    if (service) {
      const resolved = resolveExtraServices(services, service.id, input.extraServiceIds)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      extraServices = resolved.extras
    }
    const chosenServices = service ? [service, ...extraServices] : []
    const serviceNames = chosenServices.length > 0 ? joinServiceNames(chosenServices) : null

    const { position, etaMinutes, ticketNumber, ticketPrefix } = await joinQueue(tenantId, {
      service,
      extraServices,
      phone: input.phone,
    })
    if (name) await updateCustomer(tenantId, input.phone, { name })

    // formatQueueTicketNumber() is the single source of truth for the
    // display format — printed slip, WhatsApp text, and (once built) any
    // "Now Serving" display all go through it, so they can never disagree.
    // ticketPrefix is this tenant's own queue_settings.ticket_number_prefix
    // (e.g. "Q", "T", a shop's initials) — never hardcoded here.
    // ticketNumber itself is permanent (queue_entries.ticket_number) —
    // unlike `position`, which reshuffles live as the queue moves, this
    // is safe to put on a piece of paper.
    const formattedTicketNumber = formatQueueTicketNumber(ticketNumber, ticketPrefix)

    await saveCheckinDetails(tenantId, { kind: "queue", ticketRef: formattedTicketNumber, phone: input.phone }, details)

    try {
      const serviceClause = serviceNames ? ` for ${serviceNames}` : ""
      if (await kioskWhatsAppAllowed(tenantId)) await sendWhatsAppTextMessage(
        tenantId,
        input.phone,
        `Hi${name ? ` ${name}` : ""}! You're in the queue${serviceClause} — your ticket is ${formattedTicketNumber}, ` +
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
        serviceName: serviceNames,
        position,
        etaMinutes,
      },
    }
  } catch (error) {
    if (error instanceof Error && error.message === QUEUE_TOO_MANY_SERVICES) {
      return { ok: false, error: TOO_MANY_SERVICES_MESSAGE }
    }
    // Mirrors queue.ts's own PLAN_VISIT_LIMIT_REACHED message
    // (handleServiceSelection's catch block) — same reasoning as
    // submitKioskBooking's version of this above.
    if (error instanceof Error && error.message === PLAN_VISIT_LIMIT_REACHED) {
      return {
        ok: false,
        error: "Sorry, this shop has reached its queue limit for this month. Please check in with staff.",
      }
    }
    // Queue switched off for this shop (stale kiosk screen, or a direct call).
    if (isProductNotEnabledError(error)) {
      return { ok: false, error: "Sorry, this shop doesn't use a queue here. Please check in with staff." }
    }
    // The database refuses a walk-in join in three expected situations
    // (same triggers queue.ts handles for WhatsApp). Friendly message each,
    // and no error log — these are normal outcomes, not failures.
    const dbMessage = error instanceof Error ? error.message : ""
    if (dbMessage.includes("currently closed")) {
      return { ok: false, error: "Sorry, we're closed right now. Please check our opening hours." }
    }
    if (dbMessage.includes("already in the queue")) {
      return { ok: false, error: "This number is already in the queue. Please check your ticket or ask staff." }
    }
    if (dbMessage.includes("already have an upcoming booking")) {
      return { ok: false, error: "This number already has an upcoming booking. Please check in with staff." }
    }
    console.error("[kiosk] submitKioskQueueJoin failed", { slug, error })
    return { ok: false, error: kioskErrorMessage(error, "Something went wrong. Please try again.") }
  }
}
