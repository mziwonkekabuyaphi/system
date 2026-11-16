"use client"

// components/kiosk/KioskApp.tsx
/**
 * The kiosk touch flow itself: welcome -> book/queue choice -> service ->
 * (booking only: date -> time) -> name/phone -> submit -> a literal
 * ticket-style confirmation. One decision per full-bleed screen, ≥96px
 * tap targets throughout, and an admin-configurable idle timer that
 * resets everything back to welcome — so one customer's name, phone, and
 * in-progress selections never bleed into the next walk-in who taps the
 * same tablet.
 *
 * Talks to the tenant only via Server Actions in ./actions.ts, which
 * re-resolve tenantId from `slug` on every call — this component never
 * holds or sends a tenantId itself.
 *
 * KIOSK CONFIG (new): `branding.tagline`, `branding.idleRefreshSeconds`,
 * `branding.confirmationRefreshSeconds`, and `branding.registrationType`
 * are all admin-set from Settings > Kiosk (app/admin/SettingsManager.tsx
 * -> updateKioskSettings() in app/admin/settings-actions.ts) and resolved
 * with defaults in app/kiosk/[slug]/page.tsx the same way
 * primaryColor/secondaryColor already are — this component just renders
 * whatever page.tsx resolved, it never re-derives or re-validates these.
 *   - idleRefreshSeconds replaces what used to be a hardcoded 75s.
 *   - confirmationRefreshSeconds auto-returns the kiosk to welcome after
 *     the ticket screen has been up that long, independent of (and
 *     shorter than) the general idle timer — a walk-in who reads their
 *     ticket and walks off shouldn't hold the kiosk for a full idle cycle.
 *   - registrationType controls whether the book/queue choice screen
 *     shows at all: "both" behaves exactly as before; "booking" or
 *     "queue" skip straight from welcome into that single path.
 *   - choiceTitle / bookingCardTitle / bookingCardSubtitle /
 *     queueCardTitle / queueCardSubtitle are the wording on that choice
 *     screen (ChoiceScreen, below) — fully tenant-configurable from
 *     Settings > Kiosk now instead of hardcoded English strings, since
 *     this is multi-tenant and "Book a time" / "Join the queue" won't fit
 *     every business (a barbershop vs a clinic vs a car wash all want
 *     different copy). ChoiceScreen just renders whatever page.tsx
 *     resolved, same as every other branding.* field.
 *   - serviceScreenTitle is the same idea for the very next screen,
 *     ServiceScreen's "What are you here for?" heading — shown on EVERY
 *     registrationType (booking-only, queue-only, or both), since every
 *     path passes through picking a service.
 *   - ChoiceScreen's two cards are solid, filled buttons (accent /
 *     secondary gradient, icon, shadow) rather than plain white
 *     bordered tiles — the darker gradient stop each card uses is
 *     derived from branding.primaryColor/secondaryColor via darkenHex()
 *     below, so a tenant only ever has to pick their one brand color.
 *     Text/icon color on each card is NOT hardcoded white: this is
 *     multi-tenant, so a tenant's primaryColor/secondaryColor could be
 *     anything, including something light or white itself — hardcoding
 *     white text produced invisible white-on-white cards for exactly
 *     that case. tileContrastTokens() below computes each color's
 *     perceived brightness and picks white or dark-ink text/icon/overlay
 *     tokens accordingly, so every tenant's card stays legible regardless
 *     of which color they set.
 *
 * WEB MODE (new): the same component also powers the customer-facing link
 * the WhatsApp bot sends (/web/[slug]). It detects that from the URL (no
 * extra props, so app/kiosk/[slug]/page.tsx is untouched). On /web/ the
 * customer is on their OWN phone, so: the idle reset and the ticket
 * auto-return are switched off (nobody else is about to use their screen,
 * and it must not wipe a half-finished booking), no ticket printing is
 * attempted, and the default "Tap anywhere to check in" tagline is swapped
 * for a phone-friendly line. /kiosk/[slug] behaves exactly as before.
 *
 * FOOTER: `branding.removePoweredBy` is the same flag the admin Private
 * Label / Kiosk panels write via updateBranding() in
 * app/admin/settings-actions.ts, gated there on `tenants.plan ===
 * 'business'` (enforced by both the Server Action and a DB trigger).
 * This component doesn't re-check the plan — it just renders whatever
 * `page.tsx` resolved that flag to be, the same way it already trusts
 * `branding.primaryColor`/`secondaryColor`. The footer is `position:
 * fixed` with `pointer-events: none` rather than a normal flex child, so
 * it never steals a tap from the ≥96px targets underneath it and never
 * has to be threaded through every Screen's layout individually.
 *
 * MULTI-SERVICE (new): `maxServicesBooking` / `maxServicesQueue` come from
 * booking_settings.max_services_per_booking and
 * queue_settings.max_services_per_queue_entry (resolved in page.tsx, 1-5,
 * one per path because a shop may allow combos on bookings but keep walk-ins
 * to one service, or the reverse). At 1 the service screen behaves exactly as
 * it always did: one tap picks the service and moves on. Above 1 it becomes a
 * tick-several screen with a running total and a Continue button. The first
 * service picked is the primary one; the rest travel as `extraServiceIds`.
 * Booking times are looked up for the COMBINED duration, so the slot grid only
 * offers times where everything fits. Both props are optional and default to
 * 1, so /web/[slug] keeps its one-service flow until it passes them.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { usePathname } from "next/navigation"

import type { KioskBranding } from "@/app/kiosk/[slug]/page"
import type { CatalogService } from "@/lib/services/shared/services-catalog"
import type { BookingSlot } from "@/lib/services/booking"
import {
  fetchKioskDateOptions,
  fetchKioskTimeSlots,
  submitKioskBooking,
  submitKioskQueueJoin,
  checkKioskBookingPayment,
  cancelKioskBookingPayment,
  type KioskBookingPayment,
  type KioskBookingTicket,
  type KioskQueueTicket,
} from "@/app/kiosk/[slug]/actions"
import { isWhatsAppAvailable, recordWhatsAppOptIn } from "@/app/kiosk/[slug]/consent-actions"
import { printKioskTicket } from "@/lib/kiosk/printTicket"
import { detailsComplete, detailsFieldsFrom, type KioskDetailsFields } from "@/lib/kiosk/detailsFields"

// Parses "#rgb" or "#rrggbb" into 0-255 channels. Returns null for
// anything else (bad/legacy value in tenant_branding) so callers can fall
// back safely instead of producing garbage CSS.
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const value = hex.trim()

  const short = /^#([0-9a-fA-F]{3})$/.exec(value)
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => parseInt(c + c, 16))
    return { r, g, b }
  }

  const long = /^#([0-9a-fA-F]{6})$/.exec(value)
  if (long) {
    const num = parseInt(long[1], 16)
    return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff }
  }

  return null
}

// Darkens a hex color by `amount` (0-1) for the choice screen's button
// gradients — tenants only ever configure ONE flat color each for
// primary/secondary (branding.primaryColor / secondaryColor), so the
// second, darker stop needed for a convincing gradient is derived here
// rather than asking every tenant to also pick a matching dark shade.
// Falls back to the original color unchanged if it can't be parsed.
function darkenHex(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const channel = (value: number) => Math.max(0, Math.round(value * (1 - amount)))
  const r = channel(rgb.r)
  const g = channel(rgb.g)
  const b = channel(rgb.b)
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

// BUG FIX: the choice screen's cards used to hardcode white text/icons on
// top of whatever solid color a tenant picked. That's invisible the
// moment a tenant's brand color IS white, or close to it (light gray,
// pale pastel, etc.) — exactly what happened here. Since this is
// multi-tenant and any shop can set primaryColor/secondaryColor to
// anything, "assume it's dark enough for white text" isn't safe.
//
// This computes standard YIQ perceived brightness
// (https://24ways.org/2010/calculating-color-contrast) for a color and
// picks readable ink-dark or white text/overlay tokens accordingly, so a
// tenant's card stays legible no matter which color they choose — no
// admin-side "pick a readable color" burden, no silent white-on-white.
function tileContrastTokens(hex: string) {
  const rgb = parseHex(hex)
  // Unparseable value: keep the original (dark-brand) assumption rather
  // than guessing, since every shipped default color is dark.
  if (!rgb) {
    return {
      on: "#ffffff",
      onMuted: "rgba(255, 255, 255, 0.85)",
      overlay: "rgba(255, 255, 255, 0.2)",
    }
  }
  const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000
  const isLight = brightness > 150
  return isLight
    ? {
        on: "#171412",
        onMuted: "rgba(23, 20, 18, 0.7)",
        overlay: "rgba(23, 20, 18, 0.1)",
      }
    : {
        on: "#ffffff",
        onMuted: "rgba(255, 255, 255, 0.85)",
        overlay: "rgba(255, 255, 255, 0.2)",
      }
}

// idle | printing | success | failed — drives the small status line and
// retry button on TicketScreen. Never gates showing the ticket itself;
// the on-screen number is always the source of truth, the paper ticket
// is a bonus (same posture as the WhatsApp confirmation send).
type PrintStatus = "idle" | "printing" | "success" | "failed"

type Step =
  | "welcome"
  | "choice"
  | "service"
  | "date"
  | "time"
  | "details"
  | "pay"
  | "ticket"

type Path = "booking" | "queue"

interface DateOption {
  date: string
  label: string
}

type Ticket = KioskBookingTicket | KioskQueueTicket

interface KioskAppProps {
  slug: string
  branding: KioskBranding
  initialServices: CatalogService[]
  // From queue_settings.require_service_selection (resolved server-side in
  // app/kiosk/[slug]/page.tsx). Only affects the queue path — a booking
  // always needs a service to look up availability/duration against, so
  // ServiceScreen is never skippable there. When false, a walk-in on the
  // queue path drops straight from welcome/choice into DetailsScreen with
  // no service attached (queue_entries.service_id will be null).
  requireServiceSelection: boolean
  // Most services a customer may tick on the booking path / the queue path.
  // 1-5; anything else (or omitted) behaves as 1. The server re-checks the
  // real limit on every submit, this only decides what the screen offers.
  maxServicesBooking?: number
  maxServicesQueue?: number
  // From booking_settings.require_service_selection (resolved in page.tsx). False = the
  // booking path skips ServiceScreen and goes straight to the date, with no service
  // attached (bookings.service_id is stored null; the length is the shop's default
  // appointment length). Separate from requireServiceSelection above, which is the
  // queue's own flag. Omitted = true, the old behaviour.
  requireServiceBooking?: boolean
  // Per-path "print a slip" switches (Booking rules / Queue rules). Omitted = print, the old behaviour.
  printBooking?: boolean
  printQueue?: boolean
}

function clampMaxServices(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5 ? (value as number) : 1
}

// ----------------------------------------------------------------------------
// Idle reset — timeout length is admin-configurable (branding.idleRefreshSeconds)
// ----------------------------------------------------------------------------

function useIdleReset(onIdle: () => void, active: boolean, timeoutMs: number) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!active) return
    timerRef.current = setTimeout(onIdle, timeoutMs)
  }, [onIdle, active, timeoutMs])

  useEffect(() => {
    resetTimer()
    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"]
    events.forEach((event) => window.addEventListener(event, resetTimer))
    return () => {
      events.forEach((event) => window.removeEventListener(event, resetTimer))
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [resetTimer])
}

// ----------------------------------------------------------------------------
// Confirmation-screen auto-redirect — independent of the idle timer above.
// A customer reading their ticket and walking away shouldn't tie up the
// kiosk for a full idle cycle, so this is its own (shorter) timer that
// only runs while step === "ticket", and is cleared if the customer taps
// "Done" (or anything else) before it fires.
// ----------------------------------------------------------------------------

function useConfirmationAutoReset(active: boolean, timeoutMs: number, onExpire: () => void) {
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(onExpire, timeoutMs)
    return () => clearTimeout(timer)
  }, [active, timeoutMs, onExpire])
}

// ----------------------------------------------------------------------------
// "Powered by" footer — hidden entirely when branding.removePoweredBy is
// true, not just styled away, so a Business-plan tenant's kiosk has zero
// trace of it in the DOM.
// ----------------------------------------------------------------------------

function PoweredByFooter() {
  return (
    <div className="poweredBy">
      <span>Powered by ZozoQueue</span>

      <style jsx>{`
        .poweredBy {
          position: fixed;
          left: 0;
          right: 0;
          bottom: calc(var(--u) * 8);
          display: flex;
          justify-content: center;
          pointer-events: none;
          z-index: 1;
        }
        .poweredBy span {
          font-size: calc(var(--u) * 11);
          font-weight: 600;
          color: var(--muted);
          opacity: 0.7;
          letter-spacing: 0.02em;
        }
      `}</style>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Main component
// ----------------------------------------------------------------------------

export function KioskApp({
  slug,
  branding,
  initialServices,
  requireServiceSelection,
  maxServicesBooking,
  maxServicesQueue,
  requireServiceBooking = true,
  printBooking = true,
  printQueue = true,
}: KioskAppProps) {
  // Web mode = opened from the WhatsApp link (/web/[slug]) on the customer's
  // own phone, as opposed to the shop's walk-in tablet (/kiosk/[slug]).
  const pathname = usePathname()
  const isWeb = pathname?.startsWith("/web/") ?? false

  const [step, setStep] = useState<Step>("welcome")
  const [path, setPath] = useState<Path | null>(null)

  // HOTFIX: initialServices was seeded directly with no fallback, so if
  // getBookableServices() (lib/services/shared/services-catalog.ts) ever
  // returns something other than a plain array, this crashed the kiosk
  // immediately on load with "e.map is not a function". Falling back to
  // [] here is a stopgap — the real fix is finding why that function's
  // return value isn't reliably an array.
  const [services] = useState<CatalogService[]>(Array.isArray(initialServices) ? initialServices : [])
  // In the order picked: the first one is the primary service (what the
  // booking/queue row's service_id stores), the rest are the extras.
  const [selectedServices, setSelectedServices] = useState<CatalogService[]>([])

  const [dateOptions, setDateOptions] = useState<DateOption[]>([])
  const [selectedDate, setSelectedDate] = useState<DateOption | null>(null)

  const [slots, setSlots] = useState<BookingSlot[]>([])
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null)

  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [surname, setSurname] = useState("")
  const [email, setEmail] = useState("")
  const [customAnswer, setCustomAnswer] = useState("")
  // "Send me WhatsApp updates": only offered when the shop has WhatsApp connected, never pre-ticked.
  const [whatsappAvailable, setWhatsappAvailable] = useState(false)
  const [whatsappOptIn, setWhatsappOptIn] = useState(false)

  const [ticket, setTicket] = useState<Ticket | null>(null)
  // Set while a booking is held and waiting for the customer's card payment (shops that require payment).
  const [payment, setPayment] = useState<KioskBookingPayment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Screen scale. 1 unit = 1px of a 900 x 600 design on a PC monitor. A touch screen (iPad, tablet) is held
  // closer and is smaller, so it gets a bigger unit and a lower floor. Worked out here, not in CSS, so it
  // works in every browser and follows a rotation.
  const [unit, setUnit] = useState(1.2)
  useEffect(() => {
    const update = () => {
      const touch = window.matchMedia("(pointer: coarse)").matches
      const w = window.innerWidth
      const h = window.innerHeight
      const raw = Math.min(w / (touch ? 680 : 900), h / (touch ? 460 : 600))
      setUnit(Math.round(Math.min(2.4, Math.max(touch ? 1.2 : 1, raw)) * 100) / 100)
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
    }
  }, [])
  const [printStatus, setPrintStatus] = useState<PrintStatus>("idle")

  const resetAll = useCallback(() => {
    setStep("welcome")
    setPath(null)
    setSelectedServices([])
    setDateOptions([])
    setSelectedDate(null)
    setSlots([])
    setSelectedSlot(null)
    setName("")
    setPhone("")
    setSurname("")
    setEmail("")
    setCustomAnswer("")
    setWhatsappOptIn(false)
    setTicket(null)
    setPayment(null)
    setError(null)
    setBusy(false)
    setPrintStatus("idle")
  }, [])

  // Fire-and-track: never awaited by submit() itself, so a slow/offline
  // printer can't delay the customer seeing their on-screen ticket.
  const attemptPrint = useCallback(
    async (t: Ticket) => {
      // A customer's own phone has no ticket printer.
      if (isWeb) return
      // The shop switched printing off for this path (Booking rules / Queue rules).
      if (!(t.kind === "booking" ? printBooking : printQueue)) return
      setPrintStatus("printing")
      const ok = await printKioskTicket(t, branding.displayName)
      setPrintStatus(ok ? "success" : "failed")
    },
    [branding.displayName, isWeb, printBooking, printQueue],
  )

  // Both timers exist to protect the NEXT walk-in on a shared tablet, so
  // they only run on the kiosk, never on a customer's own phone.
  // Not while paying: the customer is busy on their phone, and the held time already runs out by itself.
  useIdleReset(resetAll, step !== "welcome" && step !== "pay" && !isWeb, branding.idleRefreshSeconds * 1000)
  useConfirmationAutoReset(step === "ticket" && !isWeb, branding.confirmationRefreshSeconds * 1000, resetAll)

  // Customers on /web/ got here by messaging the shop on WhatsApp, so their chat is already open: no checkbox.
  useEffect(() => {
    if (isWeb) return
    let cancelled = false
    isWhatsAppAvailable(slug)
      .then((ok) => {
        if (!cancelled) setWhatsappAvailable(ok)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [slug, isWeb])

  // ---- navigation ----------------------------------------------------

  // Queue-only tenants with requireServiceSelection off have nothing to
  // pick between and no service screen to show — drop straight to
  // DetailsScreen with no service attached. This flag is the QUEUE's only:
  // the booking path has its own (requireServiceBooking, see
  // enterBookingFlow below).
  const enterQueueFlow = () => {
    setPath("queue")
    if (!requireServiceSelection) {
      setSelectedServices([])
      setStep("details")
      return
    }
    setStep("service")
  }

  // Booking with "require a service to book" OFF: nothing to pick, so go straight to
  // the date. The date screen is shown first (it has its own "Loading…" and error
  // line) because the welcome and choice screens have nowhere to show either.
  const enterBookingFlowWithoutService = async () => {
    setPath("booking")
    setSelectedServices([])
    setError(null)
    setStep("date")
    setBusy(true)
    const result = await fetchKioskDateOptions(slug)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const options = Array.isArray(result.data) ? result.data : []
    setDateOptions(options)
    // Same one-day shortcut as chooseServices(): nothing to choose, go to the times.
    if (options.length === 1) await chooseDate(options[0], [])
  }

  const enterBookingFlow = () => {
    if (!requireServiceBooking) {
      void enterBookingFlowWithoutService()
      return
    }
    setPath("booking")
    setStep("service")
  }

  // "both" shows the normal book-vs-queue choice screen. A registration
  // type locked to a single path skips that screen entirely and drops
  // the customer straight into service selection for that path — there's
  // nothing to choose between, so don't make them tap through a screen
  // with only one live option.
  const goToChoice = () => {
    if (branding.registrationType === "booking") {
      enterBookingFlow()
      return
    }
    if (branding.registrationType === "queue") {
      enterQueueFlow()
      return
    }
    setStep("choice")
  }

  const choosePath = (p: Path) => {
    if (p === "queue") {
      enterQueueFlow()
      return
    }
    enterBookingFlow()
  }

  // How many services this path lets the customer tick (1 = single tap).
  const maxServices = clampMaxServices(path === "queue" ? maxServicesQueue : maxServicesBooking)

  const chooseServices = async (chosen: CatalogService[]) => {
    if (chosen.length === 0) return
    setSelectedServices(chosen)
    setError(null)

    if (path === "queue") {
      setStep("details")
      return
    }

    setBusy(true)
    const result = await fetchKioskDateOptions(slug)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const options = Array.isArray(result.data) ? result.data : []
    setDateOptions(options)

    // maxAdvanceDays = 0 ("same-day booking only") makes buildDateOptions
    // return exactly one option — today. Showing a date screen with a
    // single button to tap is a wasted step, so go straight to the time
    // grid for it instead. This also naturally covers any other tenant
    // config that happens to leave only one day bookable, not just the
    // maxAdvanceDays = 0 case specifically.
    if (options.length === 1) {
      await chooseDate(options[0], chosen)
      return
    }

    setStep("date")
  }

  const chooseDate = async (option: DateOption, servicesOverride?: CatalogService[]) => {
    const chosen = servicesOverride ?? selectedServices
    // No services is only valid when the shop doesn't require one for bookings.
    if (chosen.length === 0 && requireServiceBooking) return
    setSelectedDate(option)
    setError(null)
    setBusy(true)
    // Primary service id as before; the extras make the server look up times
    // for the combined duration, so only slots where everything fits are shown.
    const result = await fetchKioskTimeSlots(
      slug,
      chosen[0]?.id ?? null,
      option.date,
      chosen.slice(1).map((s) => s.id),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSlots(Array.isArray(result.data) ? result.data : [])
    setStep("time")
  }

  const chooseSlot = (slot: BookingSlot) => {
    setSelectedSlot(slot)
    setStep("details")
  }

  // The details-screen fields this shop turned on (Settings > Kiosk > Details screen).
  const fields = useMemo(() => detailsFieldsFrom(branding), [branding])
  // The shop can hide the WhatsApp tick box in Settings > Kiosk. Missing counts as shown.
  const showOptInBox = branding.showWhatsAppOptIn !== false
  const optInLabel = branding.whatsAppOptInLabel?.trim() || "Send me WhatsApp updates about my visit"

  const submit = async () => {
    // Booking always needs a service (date/time availability is looked up
    // per-service). Queue only needs one when requireServiceSelection is
    // on — when it's off, selectedServices is empty by construction
    // (enterQueueFlow never lets the customer reach ServiceScreen), so
    // this guard would otherwise silently block every queue submission.
    if (path === "booking" && requireServiceBooking && selectedServices.length === 0) return
    if (path === "queue" && requireServiceSelection && selectedServices.length === 0) return
    setError(null)
    setBusy(true)

    // What the server gets: first name and surname travel together as the customer's name, and
    // anything the shop switched off is sent empty.
    const fullName = [name, fields.showSurname ? surname : ""].map((s) => s.trim()).filter(Boolean).join(" ")
    const details = {
      name: fullName,
      phone: fields.showPhone ? phone : "",
      email: fields.showEmail ? email.trim() : "",
      customAnswer: fields.showCustom ? customAnswer.trim() : "",
    }

    // Consent has to be on file BEFORE the queue insert: the insert fires the "joined" WhatsApp message
    // straight away. A failure here must never block a check-in.
    if (fields.showPhone && whatsappAvailable && showOptInBox && whatsappOptIn) {
      try {
        await recordWhatsAppOptIn(slug, phone)
      } catch {
        /* ignore: they just won't get proactive WhatsApp updates */
      }
    }

    if (path === "booking") {
      if (!selectedDate || !selectedSlot || (requireServiceBooking && selectedServices.length === 0)) {
        setBusy(false)
        return
      }
      const result = await submitKioskBooking(slug, {
        serviceId: selectedServices[0]?.id ?? null,
        extraServiceIds: selectedServices.slice(1).map((s) => s.id),
        dateISO: selectedDate.date,
        dateLabel: selectedDate.label,
        slot: selectedSlot,
        ...details,
      })
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // The shop takes payment first: show the pay screen. The ticket (and the print) comes once it is paid.
      if (result.data.kind === "booking_payment") {
        setPayment(result.data)
        setStep("pay")
        return
      }
      setTicket(result.data)
      setStep("ticket")
      void attemptPrint(result.data)
      return
    }

    const result = await submitKioskQueueJoin(slug, {
      serviceId: selectedServices[0]?.id ?? null,
      extraServiceIds: selectedServices.slice(1).map((s) => s.id),
      ...details,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setTicket(result.data)
    setStep("ticket")
    void attemptPrint(result.data)
  }

  // Confirm only lights up once every field the shop switched on is filled in. The cellphone
  // number counts digits only (10 needed), so spaces, dashes and a "+" don't count.
  const canSubmit = detailsComplete(fields, { name, surname, phone, email, custom: customAnswer })

  // ---- layout chrome: step label, summary card and "Back" ----------------

  const hasChoice = branding.registrationType !== "booking" && branding.registrationType !== "queue"

  const leaveFlow = () => {
    if (hasChoice) setStep("choice")
    else resetAll()
  }

  const goBack = () => {
    setError(null)
    if (step === "service") {
      leaveFlow()
    } else if (step === "date") {
      if (requireServiceBooking) setStep("service")
      else leaveFlow()
    } else if (step === "time") {
      if (dateOptions.length !== 1) setStep("date")
      else if (requireServiceBooking) setStep("service")
      else leaveFlow()
    } else if (step === "details") {
      if (path === "booking") setStep("time")
      else if (requireServiceSelection) setStep("service")
      else leaveFlow()
    }
  }

  const flowSteps: Step[] =
    path === "queue"
      ? [...(requireServiceSelection ? (["service"] as Step[]) : []), "details"]
      : [
          ...(requireServiceBooking ? (["service"] as Step[]) : []),
          ...(dateOptions.length === 1 && step !== "date" ? [] : (["date"] as Step[])),
          "time",
          "details",
        ]
  const stepWords: Partial<Record<Step, string>> = {
    service: "Pick a service",
    date: "Pick a day",
    time: "Pick a time",
    details: "Your details",
  }
  const stepIndex = flowSteps.indexOf(step)
  const stepLabel =
    step === "choice"
      ? "Welcome"
      : step === "pay"
        ? "Waiting for payment"
        : step === "ticket"
          ? ticket?.kind === "booking"
            ? "You're booked"
            : "You're in the queue"
          : stepIndex >= 0
            ? `Step ${stepIndex + 1} of ${flowSteps.length} · ${stepWords[step] ?? ""}`
            : (stepWords[step] ?? "")

  const summary: KioskSummary = {
    path,
    serviceName: selectedServices.length ? selectedServices.map((s) => s.name).join(" + ") : null,
    minutes: selectedServices.reduce((sum, s) => sum + s.durationMinutes, 0),
    price: selectedServices.reduce((sum, s) => sum + s.price, 0),
    when: selectedDate ? (selectedSlot ? `${selectedDate.label}, ${selectedSlot.label}` : selectedDate.label) : null,
  }

  const chrome: KioskChrome = {
    displayName: branding.displayName,
    logoUrl: branding.logoUrl || null,
    stepLabel,
    summary,
    onBack: step === "service" || step === "date" || step === "time" || step === "details" ? goBack : null,
    onStartOver: resetAll,
  }

  const cssVars = useMemo(() => {
    const accentTokens = tileContrastTokens(branding.primaryColor)
    const amberTokens = tileContrastTokens(branding.secondaryColor)
    const queueTheme = path === "queue"
    return {
      "--u": `${unit}px`,
      "--theme": queueTheme ? branding.secondaryColor : branding.primaryColor,
      "--theme-deep": darkenHex(queueTheme ? branding.secondaryColor : branding.primaryColor, 0.22),
      "--theme-on": queueTheme ? amberTokens.on : accentTokens.on,
      "--ink": "#171412",
      "--paper": "#FAF8F5",
      "--accent": branding.primaryColor,
      "--accent-deep": darkenHex(branding.primaryColor, 0.22),
      "--accent-on": accentTokens.on,
      "--accent-on-muted": accentTokens.onMuted,
      "--accent-overlay": accentTokens.overlay,
      "--amber": branding.secondaryColor,
      "--amber-deep": darkenHex(branding.secondaryColor, 0.22),
      "--amber-on": amberTokens.on,
      "--amber-on-muted": amberTokens.onMuted,
      "--amber-overlay": amberTokens.overlay,
      "--line": "#E4DED4",
      "--muted": "#6B655C",
    } as React.CSSProperties
  }, [branding.primaryColor, branding.secondaryColor, path, unit])

  return (
    <KioskChromeContext.Provider value={chrome}>
    <div className="kiosk" style={cssVars}>
      {step === "welcome" && (
        <WelcomeScreen
          branding={branding}
          tagline={
            isWeb && branding.tagline.trim().toLowerCase().startsWith("tap anywhere")
              ? "Tap to book or join the queue"
              : branding.tagline
          }
          onTap={goToChoice}
        />
      )}

      {step === "choice" && <ChoiceScreen branding={branding} onChoose={choosePath} />}

      {step === "service" && (
        <ServiceScreen
          title={branding.serviceScreenTitle}
          services={services}
          maxSelectable={maxServices}
          initial={selectedServices}
          nextLabel={path === "queue" ? "Next: your details" : "Next: pick a day"}
          hint={branding.serviceHint?.trim() || DEFAULT_SERVICE_HINT}
          onConfirm={chooseServices}
          busy={busy}
          error={error}
        />
      )}

      {step === "date" && (
        <DateScreen
          title={branding.dateScreenTitle}
          options={dateOptions}
          initial={selectedDate}
          onSelect={chooseDate}
          busy={busy}
          error={error}
        />
      )}

      {step === "time" && (
        <TimeScreen
          titlePrefix={branding.timeScreenTitle}
          slots={slots}
          dateLabel={selectedDate?.label ?? ""}
          initial={selectedSlot}
          onSelect={chooseSlot}
          busy={busy}
          error={error}
        />
      )}

      {step === "details" && (
        <DetailsScreen
          title={branding.detailsScreenTitle}
          name={name}
          phone={phone}
          surname={surname}
          email={email}
          customAnswer={customAnswer}
          fields={fields}
          onNameChange={setName}
          onPhoneChange={setPhone}
          onSurnameChange={setSurname}
          onEmailChange={setEmail}
          onCustomChange={setCustomAnswer}
          showWhatsAppOptIn={whatsappAvailable && !isWeb && fields.showPhone && showOptInBox}
          whatsAppOptInLabel={optInLabel}
          whatsAppOptIn={whatsappOptIn}
          onWhatsAppOptInChange={setWhatsappOptIn}
          ctaLabel={path === "queue" ? "Join the queue" : "Confirm booking"}
          onSubmit={submit}
          canSubmit={canSubmit}
          busy={busy}
          error={error}
        />
      )}

      {step === "pay" && payment && (
        <PayScreen
          slug={slug}
          payment={payment}
          isWeb={isWeb}
          onPaid={() => {
            setTicket(payment.ticket)
            setPayment(null)
            setStep("ticket")
            void attemptPrint(payment.ticket)
          }}
          onCancel={resetAll}
        />
      )}

      {step === "ticket" && ticket && (
        <TicketScreen
          ticket={ticket}
          bookingEyebrow={branding.ticketBookingEyebrow}
          queueEyebrow={branding.ticketQueueEyebrow}
          onDone={resetAll}
          showTextNote={fields.showPhone}
          printStatus={printStatus}
          onRetryPrint={() => attemptPrint(ticket)}
        />
      )}

      {!branding.removePoweredBy && <PoweredByFooter />}

      <style jsx global>{`
        html,
        body {
          margin: 0;
          padding: 0;
          height: 100%;
          background: #faf8f5;
          -webkit-tap-highlight-color: transparent;
          overscroll-behavior: none;
        }
      `}</style>

      <style jsx>{`
        .kiosk {
          position: relative;
          min-height: 100vh;
          min-height: 100dvh;
          -webkit-text-size-adjust: 100%;
          touch-action: manipulation;
          width: 100%;
          background: var(--paper);
          color: var(--ink);
          display: flex;
          flex-direction: column;
          overflow-x: hidden;
          /* 1u = 1px of the 900 x 600 design. The real value is set from the screen size in the component (cssVars). */
          --u: 1.2px;
        }
      `}</style>
    </div>
    </KioskChromeContext.Provider>
  )
}

// ----------------------------------------------------------------------------
// Welcome — the entire screen is the tap target
// ----------------------------------------------------------------------------

// Tenant logo in a rounded tile with a slowly rotating ring + orbiting dot.
// The ring, dot and glow all use var(--accent), i.e. the tenant's primary
// colour, so every tenant gets their own colour automatically. Sized by one
// number (`size`, px) so the same component serves the big Welcome screen and
// the small header logo. Uses <span>s, not <div>s: the Welcome screen is a
// <button>. Custom logos only reach here on plans with the branding module
// (page.tsx blanks logoUrl otherwise).
type LogoLength = number | string

// A plain number means px (the small header logo); a string is used as-is, so the welcome
// screen can pass calc(var(--u) * N) and scale with the screen.
const logoLength = (value: LogoLength) => (typeof value === "number" ? `${value}px` : value)

function BrandLogo({ url, size, ringWidth, dotSize }: { url: string; size: LogoLength; ringWidth: LogoLength; dotSize: LogoLength }) {
  return (
    <span
      className="logoWrap"
      aria-hidden="true"
      style={{ "--s": logoLength(size), "--bw": logoLength(ringWidth), "--dot": logoLength(dotSize) } as React.CSSProperties}
    >
      <span className="logoTile">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="logo" />
      </span>
      <span className="ring" />

      <style jsx>{`
        .logoWrap {
          position: relative;
          display: block;
          flex: none;
          width: var(--s);
          height: var(--s);
        }
        .logoTile {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          padding: calc(var(--s) * 0.107);
          box-sizing: border-box;
          background: #ffffff; /* keeps transparent / dark logos readable */
          border-radius: calc(var(--s) * 0.238);
          overflow: hidden;
          box-shadow: 0 6px 24px rgba(23, 20, 18, 0.12);
          animation: logoPulse 2.4s ease-in-out infinite;
        }
        .logo {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .ring {
          position: absolute;
          inset: calc(var(--s) * -0.095);
          border-radius: calc(var(--s) * 0.333);
          border: var(--bw) solid rgba(23, 20, 18, 0.12);
          border: var(--bw) solid color-mix(in srgb, var(--accent) 35%, transparent);
          animation: ringRotate 3s linear infinite;
        }
        .ring::before {
          content: "";
          position: absolute;
          top: calc(var(--bw) * -0.5 - var(--dot) * 0.5);
          left: 50%;
          width: var(--dot);
          height: var(--dot);
          margin-left: calc(var(--dot) * -0.5);
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 calc(var(--dot) * 1) var(--accent);
        }
        @keyframes ringRotate {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes logoPulse {
          0%,
          100% {
            box-shadow: 0 6px 24px rgba(23, 20, 18, 0.12), 0 0 calc(var(--s) * 0.17) color-mix(in srgb, var(--accent) 22%, transparent);
          }
          50% {
            box-shadow: 0 6px 24px rgba(23, 20, 18, 0.12), 0 0 calc(var(--s) * 0.33) color-mix(in srgb, var(--accent) 42%, transparent);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ring,
          .logoTile {
            animation: none;
          }
        }
      `}</style>
    </span>
  )
}

// Sized from the SHORT side of the screen (not the width x height ratio the other screens use), so
// turning the tablet between portrait and landscape never changes the sizes: the short side is the
// same either way. Applied inline as plain px so the logo and the text always move together. The logo
// is also capped at 16% of the short side so it can never take over the page.
function WelcomeScreen({ branding, tagline, onTap }: { branding: KioskBranding; tagline: string; onTap: () => void }) {
  const [short, setShort] = useState(768)
  useEffect(() => {
    const update = () => setShort(Math.min(window.innerWidth, window.innerHeight))
    update()
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
    }
  }, [])

  // 768px short side (iPad) = 1.2, the size that looks right in portrait; grows on bigger screens.
  const scale = Math.round(Math.min(2.2, Math.max(1.2, short / 640)) * 100) / 100
  const px = (n: number) => Math.round(n * scale)

  return (
    <button
      className="welcome"
      onClick={onTap}
      type="button"
      aria-label="Tap to begin"
      style={{ gap: px(22), padding: `${px(32)}px ${px(32)}px ${px(56)}px` }}
    >
      {branding.logoUrl && (
        <span className="logoSlot" style={{ marginBottom: px(22) }}>
          <BrandLogo url={branding.logoUrl} size={`min(${px(80)}px, 16vmin)`} ringWidth={Math.max(2, px(2))} dotSize={px(7)} />
        </span>
      )}
      <h1 style={{ fontSize: px(60) }}>{branding.displayName}</h1>
      <p className="tap" style={{ fontSize: px(28) }}>
        {tagline}
      </p>

      <style jsx>{`
        .welcome {
          /* The whole screen is the tap target: pinned to the viewport instead of relying on flex growth. */
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 0;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: var(--paper);
          border: none;
          cursor: pointer;
          text-align: center;
        }
        .logoSlot {
          display: block; /* the ring and its dot sit outside the tile; the margin keeps them clear of the shop name */
        }
        h1,
        .tap {
          width: 100%;
          max-width: 18em;
          margin: 0;
          text-wrap: balance; /* even lines instead of one long line and a lone word */
          overflow-wrap: break-word;
        }
        h1 {
          font-weight: 800;
          color: var(--ink);
          line-height: 1.1;
        }
        .tap {
          font-weight: 700;
          color: var(--accent);
          line-height: 1.25;
        }
      `}</style>
    </button>
  )
}

// ----------------------------------------------------------------------------
// Shared layout — dark header bar, a main column and (on the booking steps) a
// "Your booking" summary card with the one action for the step. Sizes use
// var(--u), the kiosk's own scale unit (set on .kiosk): 1u = 1px at a 900 x 600
// screen, growing on a big PC monitor and never dropping below 1px on a tablet.
// ----------------------------------------------------------------------------

/** Shown under the service heading when the shop lets customers pick several. The shop can reword it in Settings > Kiosk. */
const DEFAULT_SERVICE_HINT = "Pick one, or up to {max} to combine."

interface KioskSummary {
  path: Path | null
  serviceName: string | null
  minutes: number
  price: number
  when: string | null
}

interface KioskChrome {
  displayName: string
  logoUrl: string | null
  stepLabel: string
  summary: KioskSummary
  /** null on screens that have nowhere to go back to. */
  onBack: (() => void) | null
  onStartOver: () => void
}

const KioskChromeContext = createContext<KioskChrome | null>(null)

function Screen({
  title,
  children,
  error,
  busy,
  action,
  preview,
  centered,
  hideStartOver,
}: {
  title?: string
  children: React.ReactNode
  error?: string | null
  busy?: boolean
  /** The step's one forward action. Shown in the summary card on the right (below it on a narrow screen). */
  action?: { label: string; onClick: () => void; disabled?: boolean }
  /** What the customer has picked on THIS screen but not confirmed yet, so the card can show it already. */
  preview?: Partial<KioskSummary>
  /** One centred column, no summary card (choice, payment, ticket). */
  centered?: boolean
  hideStartOver?: boolean
}) {
  const chrome = useContext(KioskChromeContext)
  const s: KioskSummary = { ...(chrome?.summary ?? { path: null, serviceName: null, minutes: 0, price: 0, when: null }), ...(preview ?? {}) }
  const onBack = chrome?.onBack ?? null
  const showCard = !centered && !!action

  return (
    <div className="screen">
      <header className="bar">
        <div className="brand">
          {chrome?.logoUrl && <BrandLogo url={chrome.logoUrl} size="calc(var(--u) * 30)" ringWidth="calc(var(--u) * 1.7)" dotSize="calc(var(--u) * 5)" />}
          <span className="shopName">{chrome?.displayName}</span>
        </div>
        <div className="barRight">
          {chrome?.stepLabel && <span className="stepLabel">{chrome.stepLabel}</span>}
          {!hideStartOver && chrome && (
            <button className="startOver" type="button" onClick={chrome.onStartOver}>
              Start over
            </button>
          )}
        </div>
      </header>

      <div className={centered ? "body centered" : "body"}>
        <div className="main">
          {title && <h2>{title}</h2>}
          {busy && <p className="status">Loading…</p>}
          {error && <p className="status errorText">{error}</p>}
          {children}
          {!showCard && !centered && onBack && (
            <button className="backLink" type="button" onClick={onBack}>
              Back
            </button>
          )}
        </div>

        {showCard && action && (
          <aside className="card">
            <p className="cardLabel">{s.path === "queue" ? "Your visit" : "Your booking"}</p>
            <p className={s.serviceName ? "cardTitle" : "cardTitle cardEmpty"}>{s.serviceName ?? "Nothing chosen yet"}</p>
            <p className="cardLines">
              {s.when && <span>{s.when}</span>}
              {s.minutes > 0 && <span>{s.minutes} min</span>}
              {s.path === "queue" && <span>Walk-in queue</span>}
            </p>
            {s.price > 0 && (
              <div className="total">
                <span>Total</span>
                <b>R{s.price.toFixed(0)}</b>
              </div>
            )}
            <button className="cta" type="button" onClick={action.onClick} disabled={action.disabled}>
              {action.label}
            </button>
            {onBack && (
              <button className="back" type="button" onClick={onBack}>
                Back
              </button>
            )}
          </aside>
        )}
      </div>

      <style jsx>{`
        .screen {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: calc(var(--u) * 16);
          padding: calc(var(--u) * 20) calc(var(--u) * 32);
          background: var(--theme);
          color: var(--theme-on);
        }
        .brand {
          display: flex;
          align-items: center;
          gap: calc(var(--u) * 12);
          min-width: 0;
        }
        .shopName {
          font-size: calc(var(--u) * 20);
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .barRight {
          display: flex;
          align-items: center;
          gap: calc(var(--u) * 16);
          flex-shrink: 0;
        }
        .stepLabel {
          font-size: calc(var(--u) * 14);
          color: color-mix(in srgb, var(--theme-on) 78%, transparent);
        }
        .startOver {
          min-height: 44px;
          padding: 0 calc(var(--u) * 14);
          border-radius: calc(var(--u) * 10);
          border: 1px solid color-mix(in srgb, var(--theme-on) 40%, transparent);
          background: transparent;
          color: var(--theme-on);
          font-family: inherit;
          font-size: calc(var(--u) * 14);
          font-weight: 600;
          cursor: pointer;
        }
        .startOver:active {
          opacity: 0.6;
        }
        .body {
          flex: 1;
          display: flex;
          gap: calc(var(--u) * 28);
          padding: calc(var(--u) * 24) calc(var(--u) * 32);
          min-height: 0;
        }
        .body.centered {
          justify-content: center;
          align-items: center;
        }
        .main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 16);
        }
        .centered .main {
          flex: 0 1 auto;
          align-items: center;
          text-align: center;
          width: 100%;
          max-width: calc(var(--u) * 760);
        }
        h2 {
          margin: 0;
          font-size: calc(var(--u) * 14);
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .centered h2 {
          font-size: calc(var(--u) * 30);
          font-weight: 700;
          letter-spacing: 0;
          text-transform: none;
          color: var(--ink);
        }
        .status {
          margin: 0;
          font-size: calc(var(--u) * 16);
          font-weight: 600;
          color: var(--muted);
        }
        .errorText {
          color: #b3261e;
        }
        .backLink {
          align-self: flex-start;
          min-height: 48px;
          padding: 0 calc(var(--u) * 6);
          border: none;
          background: transparent;
          color: var(--muted);
          font-family: inherit;
          font-size: calc(var(--u) * 15);
          font-weight: 600;
          cursor: pointer;
        }
        .card {
          /* Details side = 40% of the screen (never narrower than 300u), the pick/write side gets the other ~60%. */
          flex: 0 0 40%;
          width: 40%;
          min-width: calc(var(--u) * 300);
          align-self: flex-start;
          box-sizing: border-box;
          background: #fff;
          border: 1px solid var(--line);
          border-radius: calc(var(--u) * 16);
          padding: calc(var(--u) * 22);
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 12);
        }
        .cardLabel {
          margin: 0;
          font-size: calc(var(--u) * 13);
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .cardTitle {
          margin: 0;
          font-size: calc(var(--u) * 24);
          font-weight: 700;
          color: var(--ink);
          overflow-wrap: anywhere;
        }
        .cardEmpty {
          font-weight: 500;
          color: var(--muted);
        }
        .cardLines {
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 2);
          font-size: calc(var(--u) * 17);
          line-height: 1.5;
          color: var(--ink);
        }
        .total {
          display: flex;
          justify-content: space-between;
          padding-top: calc(var(--u) * 12);
          border-top: 1px solid var(--line);
          font-size: calc(var(--u) * 19);
          color: var(--ink);
        }
        .cta {
          min-height: 64px;
          margin-top: calc(var(--u) * 8);
          border: none;
          border-radius: calc(var(--u) * 12);
          background: var(--theme);
          color: var(--theme-on);
          font-family: inherit;
          font-size: calc(var(--u) * 19);
          font-weight: 700;
          cursor: pointer;
        }
        .cta:active:not(:disabled) {
          background: var(--theme-deep);
        }
        .cta:disabled {
          opacity: 0.4;
          cursor: default;
        }
        .back {
          min-height: 48px;
          border: none;
          background: transparent;
          color: var(--muted);
          font-family: inherit;
          font-size: calc(var(--u) * 14);
          font-weight: 600;
          cursor: pointer;
        }
        @media (max-width: 820px) {
          .bar {
            padding: calc(var(--u) * 16) calc(var(--u) * 20);
          }
          .stepLabel {
            display: none;
          }
          .body {
            flex-direction: column;
            padding: calc(var(--u) * 20);
          }
          .card {
            flex: none;
            width: 100%;
            min-width: 0;
            align-self: stretch;
          }
        }
      `}</style>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Choice — book a time vs join the queue (booking = primary colour, queue = secondary)
// ----------------------------------------------------------------------------

function ChoiceScreen({ branding, onChoose }: { branding: KioskBranding; onChoose: (path: Path) => void }) {
  return (
    <Screen title={branding.choiceTitle} centered>
      <div className={`tiles layout-${branding.choiceLayout ?? "cards"}`}>
        <button className="tile tileBooking" onClick={() => onChoose("booking")} type="button">
          <span className="tileIcon" aria-hidden="true">
            <CalendarIcon />
          </span>
          <span className="tileText">
            <span className="tileTitle">{branding.bookingCardTitle}</span>
            <span className="tileSub">{branding.bookingCardSubtitle}</span>
          </span>
          <span className="tileArrow" aria-hidden="true">
            <ArrowIcon />
          </span>
        </button>
        <button className="tile tileQueue" onClick={() => onChoose("queue")} type="button">
          <span className="tileIcon" aria-hidden="true">
            <QueueIcon />
          </span>
          <span className="tileText">
            <span className="tileTitle">{branding.queueCardTitle}</span>
            <span className="tileSub">{branding.queueCardSubtitle}</span>
          </span>
          <span className="tileArrow" aria-hidden="true">
            <ArrowIcon />
          </span>
        </button>
      </div>

      <style jsx>{`
        .tiles {
          display: flex;
          gap: calc(var(--u) * 20);
          width: 100%;
        }
        .tile {
          flex: 1;
          min-height: calc(var(--u) * 200);
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          align-items: flex-start;
          gap: calc(var(--u) * 14);
          padding: calc(var(--u) * 24);
          border: none;
          border-radius: calc(var(--u) * 20);
          text-align: left;
          font-family: inherit;
          cursor: pointer;
          position: relative;
        }
        .tile:active {
          transform: scale(0.985);
        }
        .tileBooking {
          background: linear-gradient(155deg, var(--accent), var(--accent-deep));
          color: var(--accent-on);
        }
        .tileQueue {
          background: linear-gradient(155deg, var(--amber), var(--amber-deep));
          color: var(--amber-on);
        }
        .tileIcon {
          display: inline-flex;
          width: calc(var(--u) * 52);
          height: calc(var(--u) * 52);
          align-items: center;
          justify-content: center;
          border-radius: calc(var(--u) * 14);
        }
        .tileBooking .tileIcon {
          background: var(--accent-overlay);
        }
        .tileQueue .tileIcon {
          background: var(--amber-overlay);
        }
        .tileText {
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 6);
        }
        .tileTitle {
          font-size: calc(var(--u) * 28);
          font-weight: 700;
        }
        .tileSub {
          font-size: calc(var(--u) * 15);
        }
        .tileBooking .tileSub {
          color: var(--accent-on-muted);
        }
        .tileQueue .tileSub {
          color: var(--amber-on-muted);
        }
        .tileArrow {
          position: absolute;
          top: calc(var(--u) * 22);
          right: calc(var(--u) * 22);
          opacity: 0.8;
        }
        .layout-rows {
          flex-direction: column;
        }
        .layout-rows .tile {
          min-height: calc(var(--u) * 110);
          flex-direction: row;
          align-items: center;
          justify-content: flex-start;
        }
        .layout-split .tile {
          min-height: calc(var(--u) * 300);
        }
        @media (max-width: 640px) {
          .tiles {
            flex-direction: column;
          }
          .tile {
            min-height: calc(var(--u) * 130);
          }
        }
      `}</style>
    </Screen>
  )
}

function CalendarIcon() {
  return (
    <svg style={{ width: "calc(var(--u) * 27)", height: "calc(var(--u) * 27)" }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 9.5H21" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 3V6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 3V6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="13.5" r="1.3" fill="currentColor" />
      <circle cx="12" cy="13.5" r="1.3" fill="currentColor" />
      <circle cx="16" cy="13.5" r="1.3" fill="currentColor" />
    </svg>
  )
}

function QueueIcon() {
  return (
    <svg style={{ width: "calc(var(--u) * 27)", height: "calc(var(--u) * 27)" }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M2.5 20c0-3.6 2.9-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 20c0-2.6 1.9-4.6 4-4.6s4 2 4 4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg style={{ width: "calc(var(--u) * 15)", height: "calc(var(--u) * 15)" }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M13 6L19 12L13 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ----------------------------------------------------------------------------
// Service picker
// ----------------------------------------------------------------------------

function ServiceScreen({
  title,
  services,
  maxSelectable,
  initial,
  nextLabel,
  hint,
  onConfirm,
  busy,
  error,
}: {
  title: string
  services: CatalogService[]
  /** Most services the customer may tick on this path. 1 = pick one. */
  maxSelectable: number
  /** What was picked before, so "Back" from the next step shows it ticked. */
  initial: CatalogService[]
  nextLabel: string
  /** The shop's own wording under the heading when more than one service can be picked. "{max}" becomes the limit. */
  hint: string
  onConfirm: (chosen: CatalogService[]) => void
  busy: boolean
  error: string | null
}) {
  // In the order ticked, so the first one is the primary service.
  const [picked, setPicked] = useState<CatalogService[]>(initial)

  if (services.length === 0) {
    return (
      <Screen title={title}>
        <p className="empty">No services are available right now. Please ask a member of staff.</p>
        <style jsx>{`
          .empty {
            margin: 0;
            font-size: calc(var(--u) * 20);
            color: var(--muted);
          }
        `}</style>
      </Screen>
    )
  }

  // Nothing to combine with one service on offer, so a limit above the number of services behaves like a single pick.
  const limit = Math.min(Math.max(1, maxSelectable), services.length)
  const multi = limit > 1
  const isPicked = (service: CatalogService) => picked.some((p) => p.id === service.id)
  const atLimit = picked.length >= limit

  const toggle = (service: CatalogService) => {
    if (!multi) {
      setPicked([service])
      return
    }
    setPicked((current) =>
      current.some((p) => p.id === service.id)
        ? current.filter((p) => p.id !== service.id)
        : current.length >= limit
          ? current
          : [...current, service],
    )
  }

  const preview = {
    serviceName: picked.length ? picked.map((s) => s.name).join(" + ") : null,
    minutes: picked.reduce((sum, s) => sum + s.durationMinutes, 0),
    price: picked.reduce((sum, s) => sum + s.price, 0),
  }

  return (
    <Screen
      title={title}
      error={error}
      busy={busy}
      preview={preview}
      action={{ label: nextLabel, onClick: () => onConfirm(picked), disabled: busy || picked.length === 0 }}
    >
      {multi && hint.trim() && <p className="hint">{hint.replace(/\{max\}/gi, String(limit))}</p>}

      <div className="list">
        {services.map((service) => {
          const on = isPicked(service)
          return (
            <button
              key={service.id}
              className={on ? "row rowOn" : "row"}
              onClick={() => toggle(service)}
              type="button"
              // A ticked row stays tappable at the limit so it can be removed; only the unticked ones lock.
              disabled={busy || (multi && atLimit && !on)}
              aria-pressed={on}
            >
              <span className="left">
                <span className={on ? "dot dotOn" : "dot"} aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                <span className="name">{service.name}</span>
                <span className="meta">{service.durationMinutes} min</span>
              </span>
              <span className="price">R{service.price.toFixed(0)}</span>
            </button>
          )
        })}
      </div>

      <style jsx>{`
        .hint {
          margin: 0;
          font-size: calc(var(--u) * 14);
          color: var(--muted);
        }
        .list {
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 12);
        }
        .row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: calc(var(--u) * 12);
          width: 100%;
          min-height: max(calc(var(--u) * 64), 56px);
          padding: 0 calc(var(--u) * 18);
          background: #fff;
          border: 1px solid #cfc9bc;
          border-radius: calc(var(--u) * 12);
          color: var(--ink);
          font-family: inherit;
          font-size: calc(var(--u) * 17);
          text-align: left;
          cursor: pointer;
        }
        .rowOn {
          border: 2px solid var(--theme);
          background: color-mix(in srgb, var(--theme) 12%, #fff);
        }
        .row:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .left {
          display: flex;
          align-items: center;
          gap: calc(var(--u) * 12);
          min-width: 0;
        }
        .dot {
          width: calc(var(--u) * 22);
          height: calc(var(--u) * 22);
          flex-shrink: 0;
          box-sizing: border-box;
          border-radius: 50%;
          border: 2px solid #cfc9bc;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: calc(var(--u) * 14);
          font-weight: 700;
        }
        .dotOn {
          border-color: var(--theme);
          background: var(--theme);
          color: var(--theme-on);
        }
        .name {
          font-weight: 700;
        }
        .meta {
          font-size: calc(var(--u) * 14);
          color: var(--muted);
        }
        .price {
          font-weight: 700;
          white-space: nowrap;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Day picker
// ----------------------------------------------------------------------------

function DateScreen({
  title,
  options,
  initial,
  onSelect,
  busy,
  error,
}: {
  title: string
  options: DateOption[]
  initial: DateOption | null
  onSelect: (option: DateOption) => void
  busy: boolean
  error: string | null
}) {
  const [picked, setPicked] = useState<DateOption | null>(initial)

  return (
    <Screen
      title={title}
      error={error}
      busy={busy}
      preview={picked ? { when: picked.label } : { when: null }}
      action={{ label: "Next: pick a time", onClick: () => picked && onSelect(picked), disabled: busy || !picked }}
    >
      <div className="grid">
        {options.map((option) => (
          <button
            key={option.date}
            className={picked?.date === option.date ? "tile tileOn" : "tile"}
            onClick={() => setPicked(option)}
            type="button"
            disabled={busy}
            aria-pressed={picked?.date === option.date}
          >
            {option.label}
          </button>
        ))}
      </div>

      <style jsx>{`
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(calc(var(--u) * 118), 1fr));
          gap: calc(var(--u) * 12);
        }
        .tile {
          min-height: max(calc(var(--u) * 84), 64px);
          padding: calc(var(--u) * 8);
          background: #fff;
          border: 1px solid #cfc9bc;
          border-radius: calc(var(--u) * 14);
          color: var(--ink);
          font-family: inherit;
          font-size: calc(var(--u) * 17);
          font-weight: 700;
          line-height: 1.3;
          cursor: pointer;
        }
        .tileOn {
          border: 2px solid var(--theme);
          background: var(--theme);
          color: var(--theme-on);
        }
        .tile:disabled {
          opacity: 0.5;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Time picker — grouped Morning / Afternoon / Evening
// ----------------------------------------------------------------------------

function slotHour(label: string): number {
  const hour = Number(label.slice(0, 2))
  return Number.isFinite(hour) ? hour : 0
}

function TimeScreen({
  titlePrefix,
  slots,
  dateLabel,
  initial,
  onSelect,
  busy,
  error,
}: {
  titlePrefix: string
  slots: BookingSlot[]
  dateLabel: string
  initial: BookingSlot | null
  onSelect: (slot: BookingSlot) => void
  busy: boolean
  error: string | null
}) {
  const [picked, setPicked] = useState<BookingSlot | null>(initial && slots.some((s) => s.start === initial.start) ? initial : null)

  if (!busy && slots.length === 0) {
    return (
      <Screen title={`No times left on ${dateLabel}`} error={error}>
        <p className="empty">Please go back and choose a different day.</p>
        <style jsx>{`
          .empty {
            margin: 0;
            font-size: calc(var(--u) * 20);
            color: var(--muted);
          }
        `}</style>
      </Screen>
    )
  }

  const groups = [
    { title: "Morning", items: slots.filter((s) => slotHour(s.label) < 12) },
    { title: "Afternoon", items: slots.filter((s) => slotHour(s.label) >= 12 && slotHour(s.label) < 17) },
    { title: "Evening", items: slots.filter((s) => slotHour(s.label) >= 17) },
  ].filter((g) => g.items.length > 0)

  return (
    <Screen
      title={`${titlePrefix} — ${dateLabel}`}
      error={error}
      busy={busy}
      preview={{ when: picked ? `${dateLabel}, ${picked.label}` : dateLabel }}
      action={{ label: "Next: your details", onClick: () => picked && onSelect(picked), disabled: busy || !picked }}
    >
      {groups.map((group) => (
        <section key={group.title} className="group">
          <p className="groupTitle">{group.title}</p>
          <div className="grid">
            {group.items.map((slot) => (
              <button
                key={slot.start}
                className={picked?.start === slot.start ? "slot slotOn" : "slot"}
                onClick={() => setPicked(slot)}
                type="button"
                disabled={busy}
                aria-pressed={picked?.start === slot.start}
              >
                {slot.label}
              </button>
            ))}
          </div>
        </section>
      ))}

      <style jsx>{`
        .group {
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 10);
        }
        .groupTitle {
          margin: 0;
          font-size: calc(var(--u) * 13);
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(calc(var(--u) * 92), 1fr));
          gap: calc(var(--u) * 10);
        }
        .slot {
          min-height: max(calc(var(--u) * 48), 52px);
          background: #fff;
          border: 1px solid #cfc9bc;
          border-radius: calc(var(--u) * 10);
          color: var(--ink);
          font-family: inherit;
          font-size: calc(var(--u) * 16);
          font-weight: 600;
          cursor: pointer;
        }
        .slotOn {
          border: 2px solid var(--theme);
          background: var(--theme);
          color: var(--theme-on);
          font-weight: 700;
        }
        .slot:disabled {
          opacity: 0.5;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Details
// ----------------------------------------------------------------------------

function DetailsScreen({
  title,
  name,
  phone,
  surname,
  email,
  customAnswer,
  fields,
  onNameChange,
  onPhoneChange,
  onSurnameChange,
  onEmailChange,
  onCustomChange,
  showWhatsAppOptIn,
  whatsAppOptInLabel,
  whatsAppOptIn,
  onWhatsAppOptInChange,
  ctaLabel,
  onSubmit,
  canSubmit,
  busy,
  error,
}: {
  title: string
  name: string
  phone: string
  surname: string
  email: string
  customAnswer: string
  fields: KioskDetailsFields
  onNameChange: (v: string) => void
  onPhoneChange: (v: string) => void
  onSurnameChange: (v: string) => void
  onEmailChange: (v: string) => void
  onCustomChange: (v: string) => void
  showWhatsAppOptIn: boolean
  whatsAppOptInLabel: string
  whatsAppOptIn: boolean
  onWhatsAppOptInChange: (v: boolean) => void
  ctaLabel: string
  onSubmit: () => void
  canSubmit: boolean
  busy: boolean
  error: string | null
}) {
  return (
    <Screen
      title={title}
      error={error}
      busy={busy}
      action={{ label: busy ? "One moment…" : ctaLabel, onClick: onSubmit, disabled: !canSubmit || busy }}
    >
      <div className="form">
        {fields.showName && (
          <label>
            <span>{fields.showSurname ? "First name" : "Your name"}</span>
            <input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="e.g. Mziwonke"
              autoComplete="off"
              inputMode="text"
            />
          </label>
        )}
        {fields.showSurname && (
          <label>
            <span>Surname</span>
            <input
              value={surname}
              onChange={(e) => onSurnameChange(e.target.value)}
              placeholder="e.g. Dlamini"
              autoComplete="off"
              inputMode="text"
            />
          </label>
        )}
        {fields.showPhone && (
          <label>
            <span>Cellphone number</span>
            <input
              value={phone}
              onChange={(e) => onPhoneChange(e.target.value)}
              placeholder="082 123 4567"
              autoComplete="off"
              inputMode="tel"
              type="tel"
            />
          </label>
        )}
        {fields.showEmail && (
          <label>
            <span>{fields.emailRequired ? "Email address" : "Email address (optional)"}</span>
            <input
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="name@example.com"
              autoComplete="off"
              inputMode="email"
              type="email"
            />
          </label>
        )}
        {fields.showCustom && (
          <label>
            <span>{fields.customRequired ? fields.customLabel : `${fields.customLabel} (optional)`}</span>
            <input
              value={customAnswer}
              onChange={(e) => onCustomChange(e.target.value)}
              autoComplete="off"
              inputMode="text"
              maxLength={120}
            />
          </label>
        )}
      </div>

      {showWhatsAppOptIn && (
        <label className="optin">
          <input type="checkbox" checked={whatsAppOptIn} onChange={(e) => onWhatsAppOptInChange(e.target.checked)} />
          <span>{whatsAppOptInLabel}</span>
        </label>
      )}

      <style jsx>{`
        .form {
          display: grid;
          grid-template-columns: 1fr;
          gap: calc(var(--u) * 16);
        }
        label {
          display: flex;
          flex-direction: column;
          gap: calc(var(--u) * 6);
          font-size: calc(var(--u) * 13);
          font-weight: 600;
          color: var(--muted);
        }
        input[type="text"],
        input[type="tel"],
        input[type="email"],
        input:not([type]) {
          box-sizing: border-box;
          width: 100%;
          min-height: max(calc(var(--u) * 54), 52px);
          padding: 0 calc(var(--u) * 14);
          background: #fff;
          border: 1px solid #cfc9bc;
          border-radius: calc(var(--u) * 10);
          color: var(--ink);
          font-family: inherit;
          font-size: max(calc(var(--u) * 18), 16px);
        }
        input:focus {
          outline: none;
          border-color: var(--theme);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme) 25%, transparent);
        }
        .optin {
          flex-direction: row;
          align-items: center;
          gap: calc(var(--u) * 12);
          font-size: calc(var(--u) * 15);
          font-weight: 500;
          color: var(--ink);
          cursor: pointer;
        }
        .optin input {
          width: calc(var(--u) * 26);
          height: calc(var(--u) * 26);
          min-width: 22px;
          min-height: 22px;
          accent-color: var(--theme);
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Payment — shown while a booking is held for the customer's card payment
// ----------------------------------------------------------------------------

function PayScreen({
  slug,
  payment,
  isWeb,
  onPaid,
  onCancel,
}: {
  slug: string
  payment: KioskBookingPayment
  /** On a customer's own phone there is no second device to scan with: show a Pay button instead of the QR code. */
  isWeb: boolean
  onPaid: () => void
  onCancel: () => void
}) {
  const [secondsLeft, setSecondsLeft] = useState(payment.holdMinutes * 60)
  const [expired, setExpired] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const endsAt = useRef(Date.now() + payment.holdMinutes * 60_000)
  const done = useRef(false)

  // The confirmation only ever comes from the server (the payment provider's signed webhook): this just asks.
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      const result = await checkKioskBookingPayment(slug, payment.bookingId)
      if (stopped || done.current || !result.ok) return
      if (result.data.state === "paid") {
        done.current = true
        onPaid()
      } else if (result.data.state === "expired") {
        done.current = true
        setExpired(true)
      }
    }
    const pollTimer = setInterval(poll, 3000)
    const clockTimer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((endsAt.current - Date.now()) / 1000)))
    }, 1000)
    return () => {
      stopped = true
      clearInterval(pollTimer)
      clearInterval(clockTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one poller per payment screen
  }, [slug, payment.bookingId])

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = String(secondsLeft % 60).padStart(2, "0")

  const cancel = async () => {
    setLeaving(true)
    done.current = true
    await cancelKioskBookingPayment(slug, payment.bookingId)
    onCancel()
  }

  return (
    <Screen title={expired ? "Time ran out" : `Pay ${payment.amountLabel} to confirm`} centered>
      {expired ? (
        <>
          <p className="payNote">Your time wasn't held because the payment wasn't completed. Please start again.</p>
          <button className="payBtn" type="button" onClick={onCancel}>
            Start again
          </button>
        </>
      ) : (
        <>
          {isWeb ? (
            <a className="payBtn" href={payment.paymentUrl} target="_blank" rel="noopener noreferrer">
              Pay {payment.amountLabel}
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL generated on the server
            <img className="qr" src={payment.qrDataUrl} alt="Scan to pay" width={300} height={300} />
          )}
          <p className="payNote">
            {isWeb ? "Pay on the secure page, then come back here." : "Scan with your phone's camera to pay. We also sent the link to your WhatsApp."}
          </p>
          <p className="timer">
            Holding your time for {minutes}:{seconds}
          </p>
          <button className="payCancel" type="button" onClick={cancel} disabled={leaving}>
            Cancel booking
          </button>
        </>
      )}
      <style jsx>{`
        .qr {
          width: calc(var(--u) * 220);
          height: calc(var(--u) * 220);
          background: #fff;
          padding: calc(var(--u) * 12);
          box-sizing: content-box;
          border-radius: calc(var(--u) * 16);
          border: 2px solid var(--line);
        }
        .payNote {
          margin: 0;
          max-width: calc(var(--u) * 520);
          font-size: calc(var(--u) * 16);
          color: var(--muted);
        }
        .timer {
          margin: 0;
          padding: calc(var(--u) * 10) calc(var(--u) * 20);
          border-radius: 999px;
          background: color-mix(in srgb, var(--theme) 14%, #fff);
          font-size: calc(var(--u) * 16);
          font-weight: 600;
          color: var(--ink);
          font-variant-numeric: tabular-nums;
        }
        .payBtn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 56px;
          padding: 0 calc(var(--u) * 32);
          background: var(--theme);
          color: var(--theme-on);
          border: none;
          border-radius: calc(var(--u) * 12);
          font-size: calc(var(--u) * 18);
          font-weight: 700;
          font-family: inherit;
          text-decoration: none;
          cursor: pointer;
        }
        .payCancel {
          min-height: 48px;
          padding: 0 calc(var(--u) * 24);
          background: #fff;
          color: var(--muted);
          border: 1px solid #cfc9bc;
          border-radius: calc(var(--u) * 12);
          font-size: calc(var(--u) * 15);
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
        }
        .payCancel:disabled {
          opacity: 0.5;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Ticket — the confirmation is a literal ticket, not a decorated banner
// ----------------------------------------------------------------------------

function TicketScreen({
  ticket,
  bookingEyebrow,
  queueEyebrow,
  onDone,
  showTextNote,
  printStatus,
  onRetryPrint,
}: {
  ticket: Ticket
  bookingEyebrow: string
  queueEyebrow: string
  onDone: () => void
  /** False when the shop doesn't ask for a cellphone number, so there's nothing to text. */
  showTextNote: boolean
  printStatus: "idle" | "printing" | "success" | "failed"
  onRetryPrint: () => void
}) {
  const isBooking = ticket.kind === "booking"

  return (
    <Screen centered hideStartOver>
      <div className="stub">
        <div className="top">
          <p className="eyebrow">{isBooking ? bookingEyebrow : queueEyebrow}</p>
          <p className="number">{ticket.ticketNumber}</p>
        </div>

        <div className="perf" aria-hidden="true" />

        <div className="bottom">
          {ticket.customerName ? <Row label="Name" value={ticket.customerName} /> : null}
          {ticket.serviceName && <Row label="Service" value={ticket.serviceName} />}
          {isBooking ? (
            <>
              <Row label="Date" value={(ticket as KioskBookingTicket).dateLabel} />
              <Row label="Time" value={(ticket as KioskBookingTicket).slotLabel} />
            </>
          ) : (
            <>
              <Row label="Position" value={String((ticket as KioskQueueTicket).position)} />
              <Row label="Est. wait" value={`${(ticket as KioskQueueTicket).etaMinutes} min`} />
            </>
          )}
        </div>
      </div>

      {showTextNote && <p className="sms">We'll text you a confirmation shortly.</p>}

      {/* Never blocks "Done" or hides the ticket number above — printing
          is a bonus, the screen is the source of truth either way. */}
      {printStatus === "printing" && <p className="printStatus">Printing your ticket…</p>}
      {printStatus === "failed" && (
        <div className="printFailed">
          <p className="printStatus printStatusError">Couldn't print — please note your number above.</p>
          <button className="retry" onClick={onRetryPrint} type="button">
            Try printing again
          </button>
        </div>
      )}

      <button className="done" onClick={onDone} type="button">
        Done
      </button>

      <style jsx>{`
        .stub {
          width: calc(var(--u) * 380);
          max-width: 100%;
          background: #fff;
          border: 1px solid var(--line);
          border-radius: calc(var(--u) * 20);
          overflow: hidden;
          text-align: left;
        }
        .top {
          padding: calc(var(--u) * 22);
          text-align: center;
          background: var(--theme);
          color: var(--theme-on);
        }
        .eyebrow {
          margin: 0;
          font-size: calc(var(--u) * 13);
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          opacity: 0.9;
        }
        .number {
          margin: calc(var(--u) * 4) 0 0;
          font-size: calc(var(--u) * 64);
          font-weight: 700;
          line-height: 1.1;
        }
        .perf {
          border-top: 2px dashed #cfc9bc;
        }
        .bottom {
          padding: calc(var(--u) * 10) calc(var(--u) * 26);
          display: flex;
          flex-direction: column;
        }
        .sms {
          margin: 0;
          font-size: calc(var(--u) * 14);
          color: var(--muted);
        }
        .printStatus {
          margin: 0;
          font-size: calc(var(--u) * 15);
          font-weight: 600;
          color: var(--muted);
        }
        .printStatusError {
          color: #b3261e;
        }
        .printFailed {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: calc(var(--u) * 12);
        }
        .retry {
          min-height: 52px;
          padding: 0 calc(var(--u) * 24);
          background: #fff;
          border: 1px solid #cfc9bc;
          border-radius: calc(var(--u) * 12);
          color: var(--ink);
          font-family: inherit;
          font-size: calc(var(--u) * 15);
          font-weight: 600;
          cursor: pointer;
        }
        .done {
          min-height: 56px;
          padding: 0 calc(var(--u) * 56);
          background: var(--ink);
          color: var(--paper);
          border: none;
          border-radius: calc(var(--u) * 12);
          font-size: calc(var(--u) * 17);
          font-weight: 700;
          font-family: inherit;
          cursor: pointer;
        }
      `}</style>
    </Screen>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <style jsx>{`
        .row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: calc(var(--u) * 16);
          padding: calc(var(--u) * 10) 0;
        }
        .label {
          font-size: calc(var(--u) * 16);
          color: var(--muted);
        }
        .value {
          font-size: calc(var(--u) * 17);
          font-weight: 700;
          color: var(--ink);
          text-align: right;
        }
      `}</style>
    </div>
  )
}

