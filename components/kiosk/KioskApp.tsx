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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname } from "next/navigation"

import type { KioskBranding } from "@/app/kiosk/[slug]/page"
import type { CatalogService } from "@/lib/services/shared/services-catalog"
import type { BookingSlot } from "@/lib/services/booking"
import {
  fetchKioskDateOptions,
  fetchKioskTimeSlots,
  submitKioskBooking,
  submitKioskQueueJoin,
  type KioskBookingTicket,
  type KioskQueueTicket,
} from "@/app/kiosk/[slug]/actions"
import { isWhatsAppAvailable, recordWhatsAppOptIn } from "@/app/kiosk/[slug]/consent-actions"
import { printKioskTicket } from "@/lib/kiosk/printTicket"

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
          bottom: 10px;
          display: flex;
          justify-content: center;
          pointer-events: none;
          z-index: 1;
        }
        .poweredBy span {
          font-size: 13px;
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
  // "Send me WhatsApp updates": only offered when the shop has WhatsApp connected, never pre-ticked.
  const [whatsappAvailable, setWhatsappAvailable] = useState(false)
  const [whatsappOptIn, setWhatsappOptIn] = useState(false)

  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
    setWhatsappOptIn(false)
    setTicket(null)
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
      setPrintStatus("printing")
      const ok = await printKioskTicket(t, branding.displayName)
      setPrintStatus(ok ? "success" : "failed")
    },
    [branding.displayName, isWeb],
  )

  // Both timers exist to protect the NEXT walk-in on a shared tablet, so
  // they only run on the kiosk, never on a customer's own phone.
  useIdleReset(resetAll, step !== "welcome" && !isWeb, branding.idleRefreshSeconds * 1000)
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

    // Consent has to be on file BEFORE the queue insert: the insert fires the "joined" WhatsApp message
    // straight away. A failure here must never block a check-in.
    if (whatsappAvailable && whatsappOptIn) {
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
        name,
        phone,
      })
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
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
      name,
      phone,
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

  const canSubmit = name.trim().length >= 2 && phone.trim().length >= 9

  const cssVars = useMemo(() => {
    const accentTokens = tileContrastTokens(branding.primaryColor)
    const amberTokens = tileContrastTokens(branding.secondaryColor)
    return {
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
  }, [branding.primaryColor, branding.secondaryColor])

  return (
    <div className="kiosk" style={cssVars}>
      {step !== "welcome" && step !== "ticket" && (
        <button className="startOver" onClick={resetAll} type="button">
          Start over
        </button>
      )}

      {branding.logoUrl && step !== "welcome" && (
        // Small logo + ring centred at the top of every screen after Welcome.
        // On the ticket screen it only shows on tall displays, where it can't
        // collide with the centred ticket stub.
        <div className={step === "ticket" ? "headerLogo ticketOnly" : "headerLogo"}>
          <BrandLogo url={branding.logoUrl} size={52} ringWidth={2} dotSize={8} />
        </div>
      )}

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
          onConfirm={chooseServices}
          busy={busy}
          error={error}
        />
      )}

      {step === "date" && (
        <DateScreen title={branding.dateScreenTitle} options={dateOptions} onSelect={chooseDate} busy={busy} error={error} />
      )}

      {step === "time" && (
        <TimeScreen
          titlePrefix={branding.timeScreenTitle}
          slots={slots}
          dateLabel={selectedDate?.label ?? ""}
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
          onNameChange={setName}
          onPhoneChange={setPhone}
          showWhatsAppOptIn={whatsappAvailable && !isWeb}
          whatsAppOptIn={whatsappOptIn}
          onWhatsAppOptInChange={setWhatsappOptIn}
          onSubmit={submit}
          canSubmit={canSubmit}
          busy={busy}
          error={error}
        />
      )}

      {step === "ticket" && ticket && (
        <TicketScreen
          ticket={ticket}
          bookingEyebrow={branding.ticketBookingEyebrow}
          queueEyebrow={branding.ticketQueueEyebrow}
          onDone={resetAll}
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
          width: 100%;
          background: var(--paper);
          color: var(--ink);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .startOver {
          position: absolute;
          top: 28px;
          left: 28px;
          z-index: 10;
          background: transparent;
          border: none;
          color: var(--muted);
          font-family: inherit;
          font-size: 20px;
          font-weight: 600;
          padding: 16px 20px;
          min-height: 56px;
          cursor: pointer;
        }

        .startOver:active {
          opacity: 0.6;
        }

        .headerLogo {
          position: absolute;
          top: 30px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 5;
          pointer-events: none;
        }

        .headerLogo.ticketOnly {
          display: none;
        }

        @media (min-height: 900px) {
          .headerLogo.ticketOnly {
            display: block;
          }
        }
      `}</style>
    </div>
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
function BrandLogo({ url, size, ringWidth, dotSize }: { url: string; size: number; ringWidth: number; dotSize: number }) {
  return (
    <span
      className="logoWrap"
      aria-hidden="true"
      style={{ "--s": `${size}px`, "--bw": `${ringWidth}px`, "--dot": `${dotSize}px` } as React.CSSProperties}
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

function WelcomeScreen({ branding, tagline, onTap }: { branding: KioskBranding; tagline: string; onTap: () => void }) {
  return (
    <button className="welcome" onClick={onTap} type="button" aria-label="Tap to begin">
      {branding.logoUrl && (
        <span className="logoSlot">
          <BrandLogo url={branding.logoUrl} size={168} ringWidth={3} dotSize={12} />
        </span>
      )}
      <h1>{branding.displayName}</h1>
      <p className="tap">{tagline}</p>

      <style jsx>{`
        .welcome {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 28px;
          background: var(--paper);
          border: none;
          cursor: pointer;
          padding: 40px;
          text-align: center;
        }
        .logoSlot {
          display: block;
          margin-bottom: 12px; /* the ring sits outside the tile, give it room */
        }
        h1 {
          font-size: 64px;
          font-weight: 800;
          margin: 0;
          color: var(--ink);
          line-height: 1.1;
        }
        .tap {
          font-size: 28px;
          font-weight: 600;
          color: var(--accent);
          margin: 0;
        }
      `}</style>
    </button>
  )
}

// ----------------------------------------------------------------------------
// Choice — book vs queue
// ----------------------------------------------------------------------------

// Booking gets --accent, queue gets --amber — the same two brand colors
// every other tenant-facing surface (ticket header, welcome tagline)
// already uses, so a shop's two colors are the only thing that changes
// this screen's look between tenants; the wording is the other axis of
// customization, resolved from branding below.
function ChoiceScreen({ branding, onChoose }: { branding: KioskBranding; onChoose: (path: Path) => void }) {
  return (
    <Screen title={branding.choiceTitle}>
      <div className="tiles">
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
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          width: 100%;
          max-width: 900px;
        }
        .tile {
          min-height: 220px;
          border: none;
          border-radius: 24px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: flex-start;
          gap: 20px;
          padding: 36px;
          text-align: left;
          cursor: pointer;
          font-family: inherit;
          color: #fff;
          box-shadow: 0 14px 30px rgba(23, 20, 18, 0.18);
          transition: transform 120ms ease, box-shadow 120ms ease;
        }
        .tileBooking {
          background: linear-gradient(155deg, var(--accent), var(--accent-deep));
          color: var(--accent-on);
        }
        .tileQueue {
          background: linear-gradient(155deg, var(--amber), var(--amber-deep));
          color: var(--amber-on);
        }
        .tile:active {
          transform: scale(0.97);
          box-shadow: 0 6px 16px rgba(23, 20, 18, 0.16);
        }
        .tileIcon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 64px;
          height: 64px;
          border-radius: 16px;
        }
        .tileBooking .tileIcon,
        .tileBooking .tileArrow {
          background: var(--accent-overlay);
        }
        .tileQueue .tileIcon,
        .tileQueue .tileArrow {
          background: var(--amber-overlay);
        }
        .tileText {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .tileTitle {
          font-size: 30px;
          font-weight: 800;
          color: inherit;
          line-height: 1.15;
        }
        .tileSub {
          font-size: 18px;
          font-weight: 500;
        }
        .tileBooking .tileSub {
          color: var(--accent-on-muted);
        }
        .tileQueue .tileSub {
          color: var(--amber-on-muted);
        }
        .tileArrow {
          margin-top: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          align-self: flex-end;
          color: inherit;
        }
        @media (max-width: 720px) {
          .tiles {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </Screen>
  )
}

function CalendarIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M2.5 20c0-3.6 2.9-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 20c0-2.6 1.9-4.6 4-4.6s4 2 4 4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
  onConfirm,
  busy,
  error,
}: {
  title: string
  services: CatalogService[]
  /** Most services the customer may tick on this path. 1 = tap one and go. */
  maxSelectable: number
  onConfirm: (chosen: CatalogService[]) => void
  busy: boolean
  error: string | null
}) {
  // In the order ticked, so the first one is the primary service.
  const [picked, setPicked] = useState<CatalogService[]>([])

  if (services.length === 0) {
    return (
      <Screen title={title}>
        <p className="empty">No services are available right now. Please ask a member of staff.</p>
        <style jsx>{`
          .empty {
            font-size: 22px;
            color: var(--muted);
            text-align: center;
          }
        `}</style>
      </Screen>
    )
  }

  // Nothing to combine with one service on offer, so a limit above the number
  // of services behaves like the plain single-tap screen.
  const limit = Math.min(Math.max(1, maxSelectable), services.length)
  const multi = limit > 1

  const isPicked = (service: CatalogService) => picked.some((p) => p.id === service.id)
  const atLimit = picked.length >= limit

  const toggle = (service: CatalogService) => {
    setPicked((current) =>
      current.some((p) => p.id === service.id)
        ? current.filter((p) => p.id !== service.id)
        : current.length >= limit
          ? current
          : [...current, service],
    )
  }

  const totalMinutes = picked.reduce((sum, s) => sum + s.durationMinutes, 0)
  const totalPrice = picked.reduce((sum, s) => sum + s.price, 0)

  return (
    <Screen title={title} error={error} busy={busy}>
      {multi && <p className="hint">Choose up to {limit}. Tap again to remove one.</p>}

      <div className="grid">
        {services.map((service) => {
          const on = multi && isPicked(service)
          return (
            <button
              key={service.id}
              className={`tile${on ? " tileOn" : ""}`}
              onClick={() => (multi ? toggle(service) : onConfirm([service]))}
              type="button"
              // A ticked tile stays tappable at the limit so it can be removed;
              // only the unticked ones lock.
              disabled={busy || (multi && atLimit && !on)}
              aria-pressed={multi ? on : undefined}
            >
              <span className="name">
                {on && (
                  <span className="check" aria-hidden="true">
                    ✓
                  </span>
                )}
                {service.name}
              </span>
              <span className="meta">
                {service.durationMinutes} min · R{service.price.toFixed(0)}
              </span>
            </button>
          )
        })}
      </div>

      {multi && (
        <div className="bar">
          <p className="total">
            {picked.length === 0
              ? "Nothing chosen yet"
              : `${picked.length} chosen · ${totalMinutes} min · R${totalPrice.toFixed(0)}`}
          </p>
          <button
            className="continue"
            onClick={() => onConfirm(picked)}
            type="button"
            disabled={busy || picked.length === 0}
          >
            Continue
          </button>
        </div>
      )}

      <style jsx>{`
        .hint {
          margin: -12px 0 0;
          font-size: 19px;
          font-weight: 600;
          color: var(--muted);
          text-align: center;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 20px;
          width: 100%;
          max-width: 1000px;
        }
        .tile {
          min-height: 120px;
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 18px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 8px;
          padding: 24px;
          text-align: left;
          cursor: pointer;
          font-family: inherit;
        }
        .tile:active {
          border-color: var(--accent);
          background: var(--paper);
        }
        .tile:disabled {
          opacity: 0.5;
        }
        .tileOn,
        .tileOn:disabled {
          border-color: var(--accent);
          background: var(--paper);
          opacity: 1;
        }
        .name {
          font-size: 22px;
          font-weight: 700;
          color: var(--ink);
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .check {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 30px;
          height: 30px;
          border-radius: 50%;
          background: var(--accent);
          color: var(--accent-on);
          font-size: 18px;
          font-weight: 800;
        }
        .meta {
          font-size: 17px;
          font-weight: 500;
          color: var(--muted);
        }
        .bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          width: 100%;
          max-width: 1000px;
        }
        .total {
          margin: 0;
          font-size: 22px;
          font-weight: 700;
          color: var(--ink);
        }
        .continue {
          min-height: 96px;
          min-width: 280px;
          background: var(--accent);
          color: var(--accent-on);
          border: none;
          border-radius: 16px;
          font-size: 26px;
          font-weight: 700;
          font-family: inherit;
          cursor: pointer;
        }
        .continue:disabled {
          opacity: 0.4;
          cursor: default;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Date picker
// ----------------------------------------------------------------------------

function DateScreen({
  title,
  options,
  onSelect,
  busy,
  error,
}: {
  title: string
  options: DateOption[]
  onSelect: (option: DateOption) => void
  busy: boolean
  error: string | null
}) {
  return (
    <Screen title={title} error={error} busy={busy}>
      <div className="grid">
        {options.map((option) => (
          <button key={option.date} className="tile" onClick={() => onSelect(option)} type="button" disabled={busy}>
            {option.label}
          </button>
        ))}
      </div>

      <style jsx>{`
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 18px;
          width: 100%;
          max-width: 900px;
        }
        .tile {
          min-height: 96px;
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 16px;
          font-size: 20px;
          font-weight: 700;
          color: var(--ink);
          cursor: pointer;
          font-family: inherit;
        }
        .tile:active {
          border-color: var(--accent);
          background: var(--paper);
        }
        .tile:disabled {
          opacity: 0.5;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Time picker
// ----------------------------------------------------------------------------

function TimeScreen({
  titlePrefix,
  slots,
  dateLabel,
  onSelect,
  busy,
  error,
}: {
  titlePrefix: string
  slots: BookingSlot[]
  dateLabel: string
  onSelect: (slot: BookingSlot) => void
  busy: boolean
  error: string | null
}) {
  if (!busy && slots.length === 0) {
    return (
      <Screen title={`No times left on ${dateLabel}`} error={error}>
        <p className="empty">Please go back and choose a different day.</p>
        <style jsx>{`
          .empty {
            font-size: 22px;
            color: var(--muted);
            text-align: center;
          }
        `}</style>
      </Screen>
    )
  }

  return (
    <Screen title={`${titlePrefix} — ${dateLabel}`} error={error} busy={busy}>
      <div className="grid">
        {slots.map((slot) => (
          <button key={slot.start} className="tile" onClick={() => onSelect(slot)} type="button" disabled={busy}>
            {slot.label}
          </button>
        ))}
      </div>

      <style jsx>{`
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 16px;
          width: 100%;
          max-width: 900px;
          max-height: 60vh;
          overflow-y: auto;
        }
        .tile {
          min-height: 96px;
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 16px;
          font-size: 22px;
          font-weight: 700;
          color: var(--ink);
          cursor: pointer;
          font-family: inherit;
        }
        .tile:active {
          border-color: var(--accent);
          background: var(--paper);
        }
        .tile:disabled {
          opacity: 0.5;
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Name + phone
// ----------------------------------------------------------------------------

function DetailsScreen({
  title,
  name,
  phone,
  onNameChange,
  onPhoneChange,
  showWhatsAppOptIn,
  whatsAppOptIn,
  onWhatsAppOptInChange,
  onSubmit,
  canSubmit,
  busy,
  error,
}: {
  title: string
  name: string
  phone: string
  onNameChange: (v: string) => void
  onPhoneChange: (v: string) => void
  showWhatsAppOptIn: boolean
  whatsAppOptIn: boolean
  onWhatsAppOptInChange: (v: boolean) => void
  onSubmit: () => void
  canSubmit: boolean
  busy: boolean
  error: string | null
}) {
  return (
    <Screen title={title} error={error} busy={busy}>
      <div className="form">
        <label>
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. Mziwonke"
            autoComplete="off"
            inputMode="text"
          />
        </label>
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

        {showWhatsAppOptIn && (
          <label className="optin">
            <input
              type="checkbox"
              checked={whatsAppOptIn}
              onChange={(e) => onWhatsAppOptInChange(e.target.checked)}
            />
            <span>
              Send me WhatsApp updates about my visit
            </span>
          </label>
        )}

        <button className="submit" onClick={onSubmit} type="button" disabled={!canSubmit || busy}>
          {busy ? "One moment…" : "Confirm"}
        </button>
      </div>

      <style jsx>{`
        .form {
          display: flex;
          flex-direction: column;
          gap: 24px;
          width: 100%;
          max-width: 560px;
        }
        label {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        label span {
          font-size: 19px;
          font-weight: 600;
          color: var(--muted);
        }
        input {
          min-height: 96px;
          font-size: 30px;
          font-weight: 600;
          font-family: inherit;
          color: var(--ink);
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 16px;
          padding: 0 24px;
        }
        input:focus {
          outline: none;
          border-color: var(--accent);
        }
        label.optin {
          flex-direction: row;
          align-items: center;
          gap: 20px;
          min-height: 96px;
          padding: 0 8px;
          cursor: pointer;
        }
        label.optin input {
          min-height: 0;
          width: 48px;
          height: 48px;
          padding: 0;
          flex-shrink: 0;
          accent-color: var(--accent);
          cursor: pointer;
        }
        label.optin span {
          font-size: 22px;
          font-weight: 600;
          color: var(--ink);
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        label.optin small {
          font-size: 16px;
          font-weight: 500;
          color: var(--muted);
        }
        .submit {
          min-height: 96px;
          margin-top: 12px;
          background: var(--accent);
          color: #fff;
          border: none;
          border-radius: 16px;
          font-size: 26px;
          font-weight: 700;
          font-family: inherit;
          cursor: pointer;
        }
        .submit:disabled {
          opacity: 0.4;
          cursor: default;
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
  printStatus,
  onRetryPrint,
}: {
  ticket: Ticket
  bookingEyebrow: string
  queueEyebrow: string
  onDone: () => void
  printStatus: "idle" | "printing" | "success" | "failed"
  onRetryPrint: () => void
}) {
  const isBooking = ticket.kind === "booking"

  return (
    <div className="ticketScreen">
      <div className="stub">
        <div className="top">
          <p className="eyebrow">{isBooking ? bookingEyebrow : queueEyebrow}</p>
          <p className="number">{ticket.ticketNumber}</p>
        </div>

        <div className="perf" aria-hidden="true" />

        <div className="bottom">
          <Row label="Name" value={ticket.customerName} />
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
          <p className="sms">We'll text you a confirmation shortly.</p>
        </div>
      </div>

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
        .printStatus {
          margin: -16px 0 0;
          font-size: 17px;
          font-weight: 600;
          color: var(--muted);
        }
        .printStatusError {
          color: var(--amber);
        }
        .printFailed {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
        }
        .retry {
          min-height: 64px;
          padding: 0 28px;
          background: transparent;
          border: 2px solid var(--line);
          border-radius: 14px;
          color: var(--ink);
          font-family: inherit;
          font-size: 19px;
          font-weight: 600;
          cursor: pointer;
        }
        .ticketScreen {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 40px;
          padding: 40px;
        }
        .stub {
          width: 100%;
          max-width: 480px;
          background: #fff;
          border-radius: 24px;
          box-shadow: 0 12px 32px rgba(23, 20, 18, 0.1);
          position: relative;
          overflow: hidden;
        }
        .top {
          padding: 40px 32px 32px;
          text-align: center;
          background: var(--amber);
          color: #fff;
        }
        .eyebrow {
          margin: 0 0 8px;
          font-size: 18px;
          font-weight: 600;
          opacity: 0.85;
        }
        .number {
          margin: 0;
          font-size: 56px;
          font-weight: 800;
          letter-spacing: 0.02em;
        }
        .perf {
          height: 0;
          border-top: 3px dashed var(--line);
          position: relative;
        }
        .perf::before,
        .perf::after {
          content: "";
          position: absolute;
          top: -14px;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: var(--paper);
        }
        .perf::before {
          left: -14px;
        }
        .perf::after {
          right: -14px;
        }
        .bottom {
          padding: 32px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .sms {
          margin: 12px 0 0;
          font-size: 16px;
          color: var(--muted);
          text-align: center;
        }
        .done {
          min-height: 96px;
          min-width: 280px;
          background: var(--accent);
          color: #fff;
          border: none;
          border-radius: 16px;
          font-size: 26px;
          font-weight: 700;
          font-family: inherit;
          cursor: pointer;
        }
      `}</style>
    </div>
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
          gap: 16px;
        }
        .label {
          font-size: 17px;
          font-weight: 600;
          color: var(--muted);
        }
        .value {
          font-size: 20px;
          font-weight: 700;
          color: var(--ink);
          text-align: right;
        }
      `}</style>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Shared screen chrome — title + optional error/busy row, full-bleed
// ----------------------------------------------------------------------------

function Screen({
  title,
  children,
  error,
  busy,
}: {
  title: string
  children: React.ReactNode
  error?: string | null
  busy?: boolean
}) {
  return (
    <div className="screen">
      <h2>{title}</h2>
      {busy && <p className="status">Loading…</p>}
      {error && <p className="status errorText">{error}</p>}
      {children}

      <style jsx>{`
        .screen {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 32px;
          padding: 100px 40px 40px;
        }
        h2 {
          font-size: 38px;
          font-weight: 700;
          color: var(--ink);
          margin: 0;
          text-align: center;
        }
        .status {
          margin: -12px 0 0;
          font-size: 19px;
          font-weight: 600;
          color: var(--muted);
        }
        .errorText {
          color: var(--amber);
        }
      `}</style>
    </div>
  )
}
