"use client"

import { useEffect, useState, useTransition, type ReactNode } from "react"

import { detailsFieldsFrom, detailsFieldsProblem } from "@/lib/kiosk/detailsFields"

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
                  ? "border-[color:var(--sb-bg,#7A2E3A)] bg-[color-mix(in_srgb,var(--sb-bg,#7A2E3A)_6%,transparent)] ring-1 ring-[color:var(--sb-bg,#7A2E3A)]"
                  : "border-stone-300 bg-stone-50 hover:bg-stone-100"
              }`}
            >
              <span className={`text-sm font-semibold ${selected ? "text-[color:var(--sb-bg,#7A2E3A)]" : "text-stone-800"}`}>
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
        This setting covers the walk-in queue on the kiosk, WhatsApp and admin. Appointments have their own
        switch, <strong>Require a service to book</strong> on the Booking tab: turn that off too if appointments
        should also skip the service screen (they then use the appointment length set there). If you haven&apos;t
        added any services yet and appointments still need one, the kiosk skips the service screen and shows only
        the walk-in queue.
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
          {kioskUrl && (
            <a
              href={kioskUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm font-medium text-[color:var(--sb-bg,#7A2E3A)] hover:underline"
            >
              Open the kiosk ↗
            </a>
          )}
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
  // Which fields the details screen asks for (see lib/kiosk/detailsFields.ts).
  showName: boolean
  showSurname: boolean
  showPhone: boolean
  showEmail: boolean
  emailRequired: boolean
  showCustom: boolean
  customLabel: string
  customRequired: boolean
  // Whether the kiosk shows the "Send me WhatsApp updates" tick box (and sends kiosk confirmation texts).
  showWhatsAppOptIn: boolean
}

type DetailsToggleKey = "showName" | "showSurname" | "showPhone" | "showEmail" | "emailRequired" | "showCustom" | "customRequired" | "showWhatsAppOptIn"

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
    ...detailsFieldsFrom(s),
    showWhatsAppOptIn: s.showWhatsAppOptIn ?? true,
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
    showName: d.showName,
    showSurname: d.showSurname,
    showPhone: d.showPhone,
    showEmail: d.showEmail,
    emailRequired: d.showEmail && d.emailRequired,
    showCustom: d.showCustom,
    customLabel: d.customLabel.trim(),
    customRequired: d.showCustom && d.customRequired,
    showWhatsAppOptIn: d.showWhatsAppOptIn,
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
  "showName",
  "showSurname",
  "showPhone",
  "showEmail",
  "emailRequired",
  "showCustom",
  "customLabel",
  "customRequired",
  "showWhatsAppOptIn",
]

function KioskBehaviorPanel({ initial }: { initial: AdminKioskSettings }) {
  const form = useCardForm<KioskDraft>({
    initial: toKioskDraft(initial),
    persist: async (full) => {
      // Refuse settings that would leave the customer nothing to fill in (or an unnamed question).
      const problem = detailsFieldsProblem(detailsFieldsFrom(full))
      if (problem) return { success: false as const, error: problem }
      return updateKioskSettings(toKioskPayload(full))
    },
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

  // One on/off row for the details screen, with optional extra controls shown while it is on.
  function fieldToggle(key: DetailsToggleKey, label: string, hint: string, extra?: ReactNode, locked = false) {
    return (
      <div className="rounded-xl border border-stone-200 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-stone-800">{label}</p>
            <p className="text-xs text-stone-500">{hint}</p>
          </div>
          <Toggle checked={locked ? true : draft[key]} disabled={busy || locked} onChange={(next) => set(key, next)} />
        </div>
        {draft[key] && extra && <div className="mt-3 space-y-3 border-t border-stone-100 pt-3">{extra}</div>}
      </div>
    )
  }

  function requiredCheckbox(key: "emailRequired" | "customRequired") {
    return (
      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          checked={draft[key]}
          disabled={busy}
          onChange={(e) => set(key, e.target.checked)}
        />
        Customers must fill this in
      </label>
    )
  }

  const detailsProblem = detailsFieldsProblem(detailsFieldsFrom(draft))

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
                    ? "border-[color:var(--sb-bg,#7A2E3A)] bg-[color-mix(in_srgb,var(--sb-bg,#7A2E3A)_6%,transparent)] ring-1 ring-[color:var(--sb-bg,#7A2E3A)]"
                    : "border-stone-300 bg-stone-50 hover:bg-stone-100"
                }`}
              >
                <span className={`text-sm font-semibold ${selected ? "text-[color:var(--sb-bg,#7A2E3A)]" : "text-stone-800"}`}>
                  {option.title}
                </span>
                <span className="text-xs text-stone-500">{option.description}</span>
              </button>
            )
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Local terms"
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

        <SubSection title="Details screen" hint="Right before the customer submits. Choose what customers are asked for.">
          {textField("detailsScreenTitle", "Screen heading", DEFAULT_DETAILS_SCREEN_TITLE, 80)}

          <div className="space-y-2">
            <p className="text-sm font-medium text-stone-700">Fields to show</p>
            {fieldToggle("showName", "Name", "The customer's first name. Needs at least 2 letters.")}
            {fieldToggle("showSurname", "Surname", "Shown next to Name, and saved together with it as the customer's name.")}
            {fieldToggle(
              "showPhone",
              "Cellphone number",
              "Needs 10 digits. Always on for now: bookings and the queue identify customers by their cellphone number.",
              undefined,
              true,
            )}
            {fieldToggle(
              "showWhatsAppOptIn",
              "WhatsApp updates tick box",
              "Shows “Send me WhatsApp updates about my visit” under the cellphone number. It is never pre-ticked, and only appears if your WhatsApp is connected. Turn this off to hide it: no new customers can opt in at the kiosk, and the kiosk stops sending its own WhatsApp confirmation. Turn off individual messages under WhatsApp messages to stop the rest.",
            )}
            {fieldToggle(
              "showEmail",
              "Email address",
              "Checked to look like a real email address.",
              requiredCheckbox("emailRequired"),
            )}
            {fieldToggle(
              "showCustom",
              "Custom question",
              "Ask one thing of your own, e.g. “Car registration” or “Allergies”.",
              <>
                <FieldRow label="Question" hint="This is the label customers see above the box.">
                  <input
                    className={inputClass}
                    value={draft.customLabel}
                    onChange={(e) => set("customLabel", e.target.value)}
                    placeholder="e.g. Car registration"
                    maxLength={40}
                  />
                </FieldRow>
                {requiredCheckbox("customRequired")}
              </>,
            )}
            {detailsProblem && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {detailsProblem}
              </p>
            )}
          </div>
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


