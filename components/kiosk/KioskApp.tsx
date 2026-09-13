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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
      <span>Powered by QLess</span>

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

export function KioskApp({ slug, branding, initialServices }: KioskAppProps) {
  const [step, setStep] = useState<Step>("welcome")
  const [path, setPath] = useState<Path | null>(null)

  const [services] = useState<CatalogService[]>(initialServices)
  const [selectedService, setSelectedService] = useState<CatalogService | null>(null)

  const [dateOptions, setDateOptions] = useState<DateOption[]>([])
  const [selectedDate, setSelectedDate] = useState<DateOption | null>(null)

  const [slots, setSlots] = useState<BookingSlot[]>([])
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null)

  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")

  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const resetAll = useCallback(() => {
    setStep("welcome")
    setPath(null)
    setSelectedService(null)
    setDateOptions([])
    setSelectedDate(null)
    setSlots([])
    setSelectedSlot(null)
    setName("")
    setPhone("")
    setTicket(null)
    setError(null)
    setBusy(false)
  }, [])

  useIdleReset(resetAll, step !== "welcome", branding.idleRefreshSeconds * 1000)
  useConfirmationAutoReset(step === "ticket", branding.confirmationRefreshSeconds * 1000, resetAll)

  // ---- navigation ----------------------------------------------------

  // "both" shows the normal book-vs-queue choice screen. A registration
  // type locked to a single path skips that screen entirely and drops
  // the customer straight into service selection for that path — there's
  // nothing to choose between, so don't make them tap through a screen
  // with only one live option.
  const goToChoice = () => {
    if (branding.registrationType === "booking") {
      setPath("booking")
      setStep("service")
      return
    }
    if (branding.registrationType === "queue") {
      setPath("queue")
      setStep("service")
      return
    }
    setStep("choice")
  }

  const choosePath = (p: Path) => {
    setPath(p)
    setStep("service")
  }

  const chooseService = async (service: CatalogService) => {
    setSelectedService(service)
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
    setDateOptions(result.data)
    setStep("date")
  }

  const chooseDate = async (option: DateOption) => {
    if (!selectedService) return
    setSelectedDate(option)
    setError(null)
    setBusy(true)
    const result = await fetchKioskTimeSlots(slug, selectedService.id, option.date)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSlots(result.data)
    setStep("time")
  }

  const chooseSlot = (slot: BookingSlot) => {
    setSelectedSlot(slot)
    setStep("details")
  }

  const submit = async () => {
    if (!selectedService) return
    setError(null)
    setBusy(true)

    if (path === "booking") {
      if (!selectedDate || !selectedSlot) {
        setBusy(false)
        return
      }
      const result = await submitKioskBooking(slug, {
        serviceId: selectedService.id,
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
      return
    }

    const result = await submitKioskQueueJoin(slug, {
      serviceId: selectedService.id,
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
  }

  const canSubmit = name.trim().length >= 2 && phone.trim().length >= 9

  const cssVars = useMemo(
    () =>
      ({
        "--ink": "#171412",
        "--paper": "#FAF8F5",
        "--accent": branding.primaryColor,
        "--amber": branding.secondaryColor,
        "--line": "#E4DED4",
        "--muted": "#6B655C",
      }) as React.CSSProperties,
    [branding.primaryColor, branding.secondaryColor],
  )

  return (
    <div className="kiosk" style={cssVars}>
      {step !== "welcome" && step !== "ticket" && (
        <button className="startOver" onClick={resetAll} type="button">
          Start over
        </button>
      )}

      {step === "welcome" && <WelcomeScreen branding={branding} onTap={goToChoice} />}

      {step === "choice" && <ChoiceScreen onChoose={choosePath} />}

      {step === "service" && (
        <ServiceScreen
          services={services}
          onSelect={chooseService}
          busy={busy}
          error={error}
        />
      )}

      {step === "date" && (
        <DateScreen options={dateOptions} onSelect={chooseDate} busy={busy} error={error} />
      )}

      {step === "time" && (
        <TimeScreen
          slots={slots}
          dateLabel={selectedDate?.label ?? ""}
          onSelect={chooseSlot}
          busy={busy}
          error={error}
        />
      )}

      {step === "details" && (
        <DetailsScreen
          name={name}
          phone={phone}
          onNameChange={setName}
          onPhoneChange={setPhone}
          onSubmit={submit}
          canSubmit={canSubmit}
          busy={busy}
          error={error}
        />
      )}

      {step === "ticket" && ticket && <TicketScreen ticket={ticket} onDone={resetAll} />}

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
      `}</style>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Welcome — the entire screen is the tap target
// ----------------------------------------------------------------------------

function WelcomeScreen({ branding, onTap }: { branding: KioskBranding; onTap: () => void }) {
  return (
    <button className="welcome" onClick={onTap} type="button" aria-label="Tap to begin">
      {branding.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logoUrl} alt="" className="logo" />
      )}
      <h1>{branding.displayName}</h1>
      <p className="tap">{branding.tagline}</p>

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
        .logo {
          max-height: 96px;
          max-width: 320px;
          object-fit: contain;
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

function ChoiceScreen({ onChoose }: { onChoose: (path: Path) => void }) {
  return (
    <Screen title="How can we help you today?">
      <div className="tiles">
        <button className="tile" onClick={() => onChoose("booking")} type="button">
          <span className="tileTitle">Book a time</span>
          <span className="tileSub">Pick a date and time that works for you</span>
        </button>
        <button className="tile" onClick={() => onChoose("queue")} type="button">
          <span className="tileTitle">Join the queue</span>
          <span className="tileSub">Walk in now and we'll call you</span>
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
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 20px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: flex-start;
          gap: 12px;
          padding: 32px;
          text-align: left;
          cursor: pointer;
          font-family: inherit;
        }
        .tile:active {
          border-color: var(--accent);
          background: var(--paper);
        }
        .tileTitle {
          font-size: 30px;
          font-weight: 700;
          color: var(--ink);
        }
        .tileSub {
          font-size: 19px;
          font-weight: 500;
          color: var(--muted);
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

// ----------------------------------------------------------------------------
// Service picker
// ----------------------------------------------------------------------------

function ServiceScreen({
  services,
  onSelect,
  busy,
  error,
}: {
  services: CatalogService[]
  onSelect: (service: CatalogService) => void
  busy: boolean
  error: string | null
}) {
  if (services.length === 0) {
    return (
      <Screen title="What are you here for?">
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

  return (
    <Screen title="What are you here for?" error={error} busy={busy}>
      <div className="grid">
        {services.map((service) => (
          <button key={service.id} className="tile" onClick={() => onSelect(service)} type="button" disabled={busy}>
            <span className="name">{service.name}</span>
            <span className="meta">
              {service.durationMinutes} min · R{service.price.toFixed(0)}
            </span>
          </button>
        ))}
      </div>

      <style jsx>{`
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
        .name {
          font-size: 22px;
          font-weight: 700;
          color: var(--ink);
        }
        .meta {
          font-size: 17px;
          font-weight: 500;
          color: var(--muted);
        }
      `}</style>
    </Screen>
  )
}

// ----------------------------------------------------------------------------
// Date picker
// ----------------------------------------------------------------------------

function DateScreen({
  options,
  onSelect,
  busy,
  error,
}: {
  options: DateOption[]
  onSelect: (option: DateOption) => void
  busy: boolean
  error: string | null
}) {
  return (
    <Screen title="Which day works for you?" error={error} busy={busy}>
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
  slots,
  dateLabel,
  onSelect,
  busy,
  error,
}: {
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
    <Screen title={`Pick a time — ${dateLabel}`} error={error} busy={busy}>
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
  name,
  phone,
  onNameChange,
  onPhoneChange,
  onSubmit,
  canSubmit,
  busy,
  error,
}: {
  name: string
  phone: string
  onNameChange: (v: string) => void
  onPhoneChange: (v: string) => void
  onSubmit: () => void
  canSubmit: boolean
  busy: boolean
  error: string | null
}) {
  return (
    <Screen title="Almost done — who are we booking for?" error={error} busy={busy}>
      <div className="form">
        <label>
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. Thandiwe"
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

function TicketScreen({ ticket, onDone }: { ticket: Ticket; onDone: () => void }) {
  const isBooking = ticket.kind === "booking"

  return (
    <div className="ticketScreen">
      <div className="stub">
        <div className="top">
          <p className="eyebrow">{isBooking ? "Your booking" : "Your place in line"}</p>
          <p className="number">{ticket.ticketNumber}</p>
        </div>

        <div className="perf" aria-hidden="true" />

        <div className="bottom">
          <Row label="Name" value={ticket.customerName} />
          <Row label="Service" value={ticket.serviceName} />
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

      <button className="done" onClick={onDone} type="button">
        Done
      </button>

      <style jsx>{`
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
