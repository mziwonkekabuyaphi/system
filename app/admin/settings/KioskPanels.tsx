"use client"

import { useEffect, useState, useTransition } from "react"

import {
  setKioskEnabled,
  updateKioskSettings,
  updateQueueSettings,
} from "../settings-actions"
import type {
  AdminKioskSettings,
  AdminQueueSettings,
} from "../types"
import {
  CardSaveRow,
  FieldRow,
  SettingsCard,
  SubSection,
  Toggle,
  inputClass,
  secondaryButtonClass,
  useCardForm,
} from "./ui"

// ---------------------------------------------------------------------------
// Kiosk — kiosk-specific functionality ONLY: on/off, the public URL + QR
// code, and kiosk behavior (tagline / refresh timers / registration type /
// choice-screen wording).
//
// Choice-screen wording (heading + each card's title/subtitle) only shows
// when registrationType is "both" — a locked-to-one-path kiosk never
// renders that screen, so editing its copy would be dead configuration.
// Switching back to "both" later keeps whatever was last saved.
//
// Branding (display name, logo, colors, "Remove Powered by") is NOT edited
// here. Private Label is the single source of truth for that — this tab
// only ever reads it (indirectly, via what the kiosk itself renders at
// runtime from tenant_branding), it never provides a second set of editing
// controls for it. See BrandingFields under PrivateLabelPanel below.
// ---------------------------------------------------------------------------
export function KioskPanel({
  initialEnabled,
  includedInPlan,
  tenantSlug,
  initialKioskSettings,
  queueSettings,
  onQueueSettingsSaved,
}: {
  initialEnabled: boolean
  includedInPlan: boolean
  tenantSlug: string
  initialKioskSettings: AdminKioskSettings
  queueSettings: AdminQueueSettings
  onQueueSettingsSaved: (next: AdminQueueSettings) => void
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [isTogglePending, startToggleTransition] = useTransition()
  const [toggleError, setToggleError] = useState<string | null>(null)

  function handleToggle(next: boolean) {
    const previous = enabled
    setEnabled(next)
    setToggleError(null)
    startToggleTransition(async () => {
      const result = await setKioskEnabled(next)
      if (!result.success) {
        setEnabled(previous)
        setToggleError(result.error)
      }
    })
  }

  // Plan doesn't include the kiosk: show a locked card instead of a toggle
  // that would only bounce off the server. The URL and behavior panels are
  // hidden too -- the public kiosk page is unavailable on this plan.
  if (!includedInPlan) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Kiosk module</p>
        <p className="mt-1 text-sm text-stone-500">
          The self-service kiosk isn&apos;t included in your current plan. Upgrade from Plans &amp; Billing to give
          walk-ins a booking and queue screen.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Kiosk module</p>
            <p className="text-sm text-stone-500">Enable the self-service kiosk for this location.</p>
          </div>
          <Toggle checked={enabled} disabled={isTogglePending} onChange={handleToggle} />
        </div>
        {toggleError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{toggleError}</p>}
        {!enabled && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            The kiosk is off — walk-ins won&apos;t see a booking flow at the URL below. Everything else on this tab
            still saves, so you can set it up before switching it on.
          </p>
        )}
      </div>

      <KioskUrlPanel tenantSlug={tenantSlug} />

      <KioskServicesPanel queueSettings={queueSettings} onSaved={onQueueSettingsSaved} />

      <KioskBehaviorPanel initial={initialKioskSettings} />
    </div>
  )
}

// ---- Services: with or without --------------------------------------------
//
// Same underlying setting as "Require a service to join the queue" under
// Queue rules (queue_settings.require_service_selection) -- surfaced here
// because this is where an owner thinks about what customers see at the
// kiosk. Both places read/write the same value via the shared state in
// SettingsManager, so they can't disagree.

const SERVICE_MODE_OPTIONS: Array<{ value: boolean; title: string; description: string }> = [
  {
    value: true,
    title: "Customers pick a service",
    description: "Each customer chooses what they're here for. Best when services take different amounts of time.",
  },
  {
    value: false,
    title: "No services — one line",
    description:
      "Customers skip the service screen and just give their name and number. Everyone joins one shared line.",
  },
]

function KioskServicesPanel({
  queueSettings,
  onSaved,
}: {
  queueSettings: AdminQueueSettings
  onSaved: (next: AdminQueueSettings) => void
}) {
  const [requireService, setRequireService] = useState(queueSettings.requireServiceSelection)
  const [minutes, setMinutes] = useState(queueSettings.defaultServiceDurationMinutes)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const dirty =
    requireService !== queueSettings.requireServiceSelection ||
    minutes !== queueSettings.defaultServiceDurationMinutes

  function save() {
    if (!requireService && !(minutes >= 1)) {
      setMessage({ ok: false, text: "Enter at least 1 minute." })
      return
    }
    setMessage(null)
    const next = {
      ...queueSettings,
      requireServiceSelection: requireService,
      defaultServiceDurationMinutes: minutes,
    }
    startTransition(async () => {
      const result = await updateQueueSettings(next)
      if (result.success) {
        onSaved(next)
        setMessage({ ok: true, text: "Saved." })
      } else {
        setMessage({ ok: false, text: result.error })
      }
    })
  }

  function discard() {
    setRequireService(queueSettings.requireServiceSelection)
    setMinutes(queueSettings.defaultServiceDurationMinutes)
    setMessage(null)
  }

  return (
    <SettingsCard
      title="Services"
      description="Does your shop need customers to choose a service before they join?"
      footer={
        <CardSaveRow dirty={dirty} isPending={isPending} onSave={save} onDiscard={discard} message={message} />
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {SERVICE_MODE_OPTIONS.map((option) => {
          const selected = requireService === option.value
          return (
            <button
              key={String(option.value)}
              type="button"
              disabled={isPending}
              onClick={() => {
                setRequireService(option.value)
                setMessage(null)
              }}
              aria-pressed={selected}
              className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
                selected
                  ? "border-[#7A2E3A] bg-[#7A2E3A]/5 ring-1 ring-[#7A2E3A]"
                  : "border-stone-300 bg-stone-50 hover:bg-stone-100"
              }`}
            >
              <span className={`text-sm font-semibold ${selected ? "text-[#7A2E3A]" : "text-stone-800"}`}>
                {option.title}
              </span>
              <span className="text-xs text-stone-500">{option.description}</span>
            </button>
          )
        })}
      </div>

      {!requireService && (
        <div className="max-w-xs">
          <FieldRow
            label="Estimated minutes per customer"
            hint="Used to work out wait times when there's no service to take the length from."
          >
            <input
              type="number"
              min={1}
              className={inputClass}
              value={minutes}
              onChange={(e) => {
                setMinutes(Number(e.target.value))
                setMessage(null)
              }}
            />
          </FieldRow>
        </div>
      )}

      <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
        Bookings always need a service (available times depend on how long it takes), so pair &ldquo;No
        services&rdquo; with <strong>Queue Only</strong> under Customer options below. This setting also applies to
        WhatsApp and admin walk-ins. If you haven&apos;t added any services yet, the kiosk already skips the service
        screen and shows only the walk-in queue.
      </p>
    </SettingsCard>
  )
}

// ---- Kiosk URL + QR code ---------------------------------------------------

function KioskUrlPanel({ tenantSlug }: { tenantSlug: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const kioskUrl = origin ? `${origin}/kiosk/${tenantSlug}` : null

  async function copyUrl() {
    if (!kioskUrl) return
    try {
      await navigator.clipboard.writeText(kioskUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — the URL
      // is already selectable in the input, so this just skips the toast.
    }
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Kiosk address</p>
      <p className="text-sm text-stone-500">The registration URL used for your kiosk.</p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input className={inputClass} readOnly value={kioskUrl ?? "Loading…"} onFocus={(e) => e.target.select()} />
            <button type="button" className={secondaryButtonClass} onClick={copyUrl} disabled={!kioskUrl}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-stone-400">Print this on a table stand, or open it directly on the kiosk tablet.</p>
        </div>

        <div className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
          {kioskUrl ? (
            // Third-party QR generator — the kiosk URL isn't sensitive
            // (it's the same link printed on a counter stand), so a hosted
            // generator is fine here; swap for a self-hosted one if that
            // changes.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(kioskUrl)}`}
              alt="QR code linking to the kiosk"
              width={160}
              height={160}
            />
          ) : (
            <div className="flex h-40 w-40 items-center justify-center text-xs text-stone-400">Loading…</div>
          )}
          <span className="text-xs text-stone-500">Scan to continue on phone</span>
        </div>
      </div>
    </div>
  )
}

// ---- Idle / confirmation refresh + registration type -----------------------

const REGISTRATION_TYPE_OPTIONS: Array<{
  value: AdminKioskSettings["registrationType"]
  title: string
  description: string
}> = [
  { value: "both", title: "Booking and Queue", description: "Customers choose between booking a time or joining the walk-in queue." },
  { value: "booking", title: "Booking Only", description: "Customers go straight into picking a date and time — no walk-in option." },
  { value: "queue", title: "Queue Only", description: "Customers go straight into joining the walk-in queue — no booking option." },
]

// Placeholder text only — shown greyed-out in an empty field so the admin
// can see exactly what their kiosk renders before they've customized
// anything. Must stay in sync with app/kiosk/[slug]/page.tsx's own
// DEFAULT_CHOICE_TITLE / DEFAULT_BOOKING_CARD_TITLE / etc., which is where
// these strings actually take effect as fallbacks.
const DEFAULT_CHOICE_TITLE = "How can we help you today?"
const DEFAULT_BOOKING_CARD_TITLE = "Book a time"
const DEFAULT_BOOKING_CARD_SUBTITLE = "Pick a date and time that works for you"
const DEFAULT_QUEUE_CARD_TITLE = "Join the queue"
const DEFAULT_QUEUE_CARD_SUBTITLE = "Walk in now and we'll call you"
const DEFAULT_SERVICE_SCREEN_TITLE = "What are you here for?"
const DEFAULT_DATE_SCREEN_TITLE = "Which day works for you?"
const DEFAULT_TIME_SCREEN_TITLE = "Pick a time"
const DEFAULT_DETAILS_SCREEN_TITLE = "Almost done — who are we booking for?"
const DEFAULT_TICKET_BOOKING_EYEBROW = "Your booking"
const DEFAULT_TICKET_QUEUE_EYEBROW = "Your place in line"

// Form-state shape for the kiosk behaviour page (empty strings, not nulls).
type KioskDraft = {
  tagline: string
  idleRefreshSeconds: number
  confirmationRefreshSeconds: number
  registrationType: AdminKioskSettings["registrationType"]
  choiceTitle: string
  bookingCardTitle: string
  bookingCardSubtitle: string
  queueCardTitle: string
  queueCardSubtitle: string
  serviceScreenTitle: string
  dateScreenTitle: string
  timeScreenTitle: string
  detailsScreenTitle: string
  ticketBookingEyebrow: string
  ticketQueueEyebrow: string
}

function toKioskDraft(s: AdminKioskSettings): KioskDraft {
  return {
    tagline: s.tagline ?? "",
    idleRefreshSeconds: s.idleRefreshSeconds,
    confirmationRefreshSeconds: s.confirmationRefreshSeconds,
    registrationType: s.registrationType,
    choiceTitle: s.choiceTitle ?? "",
    bookingCardTitle: s.bookingCardTitle ?? "",
    bookingCardSubtitle: s.bookingCardSubtitle ?? "",
    queueCardTitle: s.queueCardTitle ?? "",
    queueCardSubtitle: s.queueCardSubtitle ?? "",
    serviceScreenTitle: s.serviceScreenTitle ?? "",
    dateScreenTitle: s.dateScreenTitle ?? "",
    timeScreenTitle: s.timeScreenTitle ?? "",
    detailsScreenTitle: s.detailsScreenTitle ?? "",
    ticketBookingEyebrow: s.ticketBookingEyebrow ?? "",
    ticketQueueEyebrow: s.ticketQueueEyebrow ?? "",
  }
}

// Return type intentionally inferred (not annotated) so the same keys the
// page already sent before this redesign keep flowing through unchanged.
function toKioskPayload(d: KioskDraft) {
  return {
    tagline: d.tagline.trim() || null,
    idleRefreshSeconds: d.idleRefreshSeconds,
    confirmationRefreshSeconds: d.confirmationRefreshSeconds,
    registrationType: d.registrationType,
    choiceTitle: d.choiceTitle.trim() || null,
    bookingCardTitle: d.bookingCardTitle.trim() || null,
    bookingCardSubtitle: d.bookingCardSubtitle.trim() || null,
    queueCardTitle: d.queueCardTitle.trim() || null,
    queueCardSubtitle: d.queueCardSubtitle.trim() || null,
    serviceScreenTitle: d.serviceScreenTitle.trim() || null,
    dateScreenTitle: d.dateScreenTitle.trim() || null,
    timeScreenTitle: d.timeScreenTitle.trim() || null,
    detailsScreenTitle: d.detailsScreenTitle.trim() || null,
    ticketBookingEyebrow: d.ticketBookingEyebrow.trim() || null,
    ticketQueueEyebrow: d.ticketQueueEyebrow.trim() || null,
  }
}

const KIOSK_OPTIONS_KEYS: Array<keyof KioskDraft> = ["registrationType"]
const KIOSK_TIMING_KEYS: Array<keyof KioskDraft> = ["idleRefreshSeconds", "confirmationRefreshSeconds"]
const KIOSK_WORDING_KEYS: Array<keyof KioskDraft> = [
  "tagline",
  "choiceTitle",
  "bookingCardTitle",
  "bookingCardSubtitle",
  "queueCardTitle",
  "queueCardSubtitle",
  "serviceScreenTitle",
  "dateScreenTitle",
  "timeScreenTitle",
  "detailsScreenTitle",
  "ticketBookingEyebrow",
  "ticketQueueEyebrow",
]

function KioskBehaviorPanel({ initial }: { initial: AdminKioskSettings }) {
  const form = useCardForm<KioskDraft>({
    initial: toKioskDraft(initial),
    persist: (full) => updateKioskSettings(toKioskPayload(full)),
  })
  const { draft, set } = form
  const busy = form.savingCard !== null
  const showsBooking = draft.registrationType !== "queue"
  const showsQueue = draft.registrationType !== "booking"

  function footer(cardId: string, keys: Array<keyof KioskDraft>) {
    return (
      <CardSaveRow
        dirty={form.isDirty(keys)}
        isPending={form.savingCard === cardId}
        onSave={() => form.save(cardId, keys)}
        onDiscard={() => form.discard(keys)}
        message={form.messages[cardId] ?? null}
      />
    )
  }

  function textField(
    key: keyof KioskDraft,
    label: string,
    placeholder: string,
    maxLength: number,
    hint?: string,
  ) {
    return (
      <FieldRow label={label} hint={hint ?? `Defaults to "${placeholder}".`}>
        <input
          className={inputClass}
          value={draft[key] as string}
          onChange={(e) => set(key, e.target.value as KioskDraft[typeof key])}
          placeholder={placeholder}
          maxLength={maxLength}
        />
      </FieldRow>
    )
  }

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Customer options"
        description="What customers are allowed to do at the kiosk."
        footer={footer("options", KIOSK_OPTIONS_KEYS)}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {REGISTRATION_TYPE_OPTIONS.map((option) => {
            const selected = draft.registrationType === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={busy}
                onClick={() => set("registrationType", option.value)}
                aria-pressed={selected}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
                  selected
                    ? "border-[#7A2E3A] bg-[#7A2E3A]/5 ring-1 ring-[#7A2E3A]"
                    : "border-stone-300 bg-stone-50 hover:bg-stone-100"
                }`}
              >
                <span className={`text-sm font-semibold ${selected ? "text-[#7A2E3A]" : "text-stone-800"}`}>
                  {option.title}
                </span>
                <span className="text-xs text-stone-500">{option.description}</span>
              </button>
            )
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Wording"
        description="Every piece of text on the kiosk is yours to change, in the order customers see it. Leave a field empty to use the default shown in it."
        footer={footer("wording", KIOSK_WORDING_KEYS)}
      >
        <SubSection title="1 · Welcome screen">
          {textField(
            "tagline",
            "Tagline",
            "Tap anywhere to check in",
            80,
            'Shown under your shop name. Defaults to "Tap anywhere to check in".',
          )}
        </SubSection>

        {draft.registrationType === "both" && (
          <SubSection
            title="2 · Choice screen"
            hint='Where customers pick booking or the walk-in queue. Rename these to fit your business, e.g. "Reserve a table" / "Get in line".'
          >
            {textField("choiceTitle", "Screen heading", DEFAULT_CHOICE_TITLE, 80)}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-4 rounded-xl border border-stone-200 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Booking card</p>
                {textField("bookingCardTitle", "Title", DEFAULT_BOOKING_CARD_TITLE, 40)}
                {textField("bookingCardSubtitle", "Subtitle", DEFAULT_BOOKING_CARD_SUBTITLE, 100)}
              </div>
              <div className="space-y-4 rounded-xl border border-stone-200 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Queue card</p>
                {textField("queueCardTitle", "Title", DEFAULT_QUEUE_CARD_TITLE, 40)}
                {textField("queueCardSubtitle", "Subtitle", DEFAULT_QUEUE_CARD_SUBTITLE, 100)}
              </div>
            </div>
          </SubSection>
        )}

        <SubSection title="Service screen" hint="Shown on every path when the customer picks a service.">
          {textField("serviceScreenTitle", "Screen heading", DEFAULT_SERVICE_SCREEN_TITLE, 80)}
        </SubSection>

        {showsBooking && (
          <SubSection title="Booking screens" hint="Only on the booking path.">
            <div className="grid gap-4 sm:grid-cols-2">
              {textField("dateScreenTitle", "Date screen heading", DEFAULT_DATE_SCREEN_TITLE, 80)}
              {textField(
                "timeScreenTitle",
                "Time screen heading",
                DEFAULT_TIME_SCREEN_TITLE,
                40,
                `The kiosk adds the date automatically (e.g. "${DEFAULT_TIME_SCREEN_TITLE} — Today"), so just enter the part before it. Defaults to "${DEFAULT_TIME_SCREEN_TITLE}".`,
              )}
            </div>
          </SubSection>
        )}

        <SubSection title="Details screen" hint="Right before the customer submits.">
          {textField("detailsScreenTitle", "Name & phone screen heading", DEFAULT_DETAILS_SCREEN_TITLE, 80)}
        </SubSection>

        <SubSection title="Final ticket" hint="Small label above the ticket number on the last screen.">
          <div className="grid gap-4 sm:grid-cols-2">
            {showsBooking &&
              textField("ticketBookingEyebrow", "Ticket label — booking", DEFAULT_TICKET_BOOKING_EYEBROW, 30)}
            {showsQueue && textField("ticketQueueEyebrow", "Ticket label — queue", DEFAULT_TICKET_QUEUE_EYEBROW, 30)}
          </div>
        </SubSection>
      </SettingsCard>

      <SettingsCard
        title="Timing"
        description="How the kiosk resets between customers."
        footer={footer("timing", KIOSK_TIMING_KEYS)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldRow
            label="Idle reset (seconds)"
            hint="How long before the kiosk returns to the welcome screen when nobody is using it."
          >
            <input
              type="number"
              min={10}
              max={600}
              className={inputClass}
              value={draft.idleRefreshSeconds}
              onChange={(e) => set("idleRefreshSeconds", Number(e.target.value))}
            />
          </FieldRow>
          <FieldRow
            label="Confirmation screen (seconds)"
            hint="How long the confirmation ticket stays up before returning to the welcome screen."
          >
            <input
              type="number"
              min={3}
              max={120}
              className={inputClass}
              value={draft.confirmationRefreshSeconds}
              onChange={(e) => set("confirmationRefreshSeconds", Number(e.target.value))}
            />
          </FieldRow>
        </div>
      </SettingsCard>
    </div>
  )
}


