"use client"

import { useEffect, useState, useTransition, type ReactNode } from "react"

import { detailsFieldsFrom, detailsFieldsProblem } from "@/lib/kiosk/detailsFields"

import {
  setKioskEnabled,
  updateKioskSettings,
} from "../settings-actions"
import type {
  AdminKioskSettings,
  AdminQueueSettings,
} from "../types"
import {
  CardSaveRow,
  FieldRow,
  SettingsCard,
  SettingsStatTile,
  SubSection,
  Toggle,
  inputClass,
  secondaryButtonClass,
  useCardForm,
} from "./ui"

// Small line icon for the summary tiles.
function TileIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

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
}: {
  initialEnabled: boolean
  includedInPlan: boolean
  tenantSlug: string
  initialKioskSettings: AdminKioskSettings
  /** No longer used here (the Services card moved to Queue rules); kept so existing callers still compile. */
  queueSettings?: AdminQueueSettings
  onQueueSettingsSaved?: (next: AdminQueueSettings) => void
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [isTogglePending, startToggleTransition] = useTransition()
  const [toggleError, setToggleError] = useState<string | null>(null)
  // Held here (not inside the behaviour panel) so the summary tiles follow what is being edited.
  const form = useKioskForm(initialKioskSettings)

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
      <SettingsCard title="Kiosk module">
        <p className="text-sm text-ink-muted">
          The self-service kiosk isn&apos;t included in your current plan. Upgrade from Plans &amp; Billing to give
          walk-ins a booking and queue screen.
        </p>
      </SettingsCard>
    )
  }

  const modeTitle = REGISTRATION_TYPE_OPTIONS.find((o) => o.value === form.draft.registrationType)?.title ?? "—"

  return (
    <div className="space-y-4">
      {/* ================= Summary (follows the form live) ================= */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SettingsStatTile
          label="Kiosk"
          value={enabled ? "On" : "Off"}
          hint={enabled ? "Walk-ins can use it" : "Hidden from walk-ins"}
          icon={<TileIcon><rect x="6" y="2.5" width="12" height="19" rx="2" /><path d="M10 18.5h4" /></TileIcon>}
        />
        <SettingsStatTile
          label="Customers can"
          value={modeTitle}
          hint="Set under Customer options"
          icon={<TileIcon><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></TileIcon>}
        />
        <SettingsStatTile
          label="Idle reset"
          value={`${form.draft.idleRefreshSeconds}s`}
          hint="Back to the welcome screen"
          icon={<TileIcon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></TileIcon>}
        />
        <SettingsStatTile
          label="Ticket screen"
          value={`${form.draft.confirmationRefreshSeconds}s`}
          hint="How long the ticket stays up"
          icon={<TileIcon><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z" /></TileIcon>}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
        <SettingsCard title="Kiosk module" description="Enable the self-service kiosk for this location.">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
            <div>
              <p className="text-sm font-medium text-ink">{enabled ? "Kiosk is on" : "Kiosk is off"}</p>
              <p className="text-xs text-ink-muted">Switch the kiosk on or off for walk-ins.</p>
            </div>
            <Toggle checked={enabled} disabled={isTogglePending} onChange={handleToggle} />
          </div>
          {toggleError && <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">{toggleError}</p>}
          {!enabled && (
            <p className="rounded-lg border border-warn-line bg-warn-soft-2 px-3 py-2 text-sm text-warn-strong">
              The kiosk is off — walk-ins won&apos;t see a booking flow at the URL on the right. Everything else on this
              tab still saves, so you can set it up before switching it on.
            </p>
          )}
        </SettingsCard>

        <KioskUrlPanel tenantSlug={tenantSlug} />
      </div>

      <KioskBehaviorPanel form={form} />
    </div>
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
    <SettingsCard title="Kiosk address" description="The registration URL used for your kiosk.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
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
              className="inline-block text-sm font-medium text-[color:var(--sb-bg,var(--color-accent-alt))] hover:underline"
            >
              Open the kiosk ↗
            </a>
          )}
          <p className="text-xs text-ink-muted">Print this on a table stand, or open it directly on the kiosk tablet.</p>
        </div>

        <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-canvas p-3">
          {kioskUrl ? (
            // Third-party QR generator — the kiosk URL isn't sensitive
            // (it's the same link printed on a counter stand), so a hosted
            // generator is fine here; swap for a self-hosted one if that
            // changes. The white frame keeps the code scannable on the dark theme.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(kioskUrl)}`}
              alt="QR code linking to the kiosk"
              width={160}
              height={160}
              className="rounded-md bg-white p-2"
            />
          ) : (
            <div className="flex h-40 w-40 items-center justify-center text-xs text-ink-muted">Loading…</div>
          )}
          <span className="text-xs text-ink-muted">Scan to continue on phone</span>
        </div>
      </div>
    </SettingsCard>
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
const DEFAULT_WHATSAPP_OPTIN_LABEL = "Send me WhatsApp updates about my visit"
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
  whatsAppOptInLabel: string
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
    whatsAppOptInLabel: s.whatsAppOptInLabel ?? "",
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
    whatsAppOptInLabel: d.whatsAppOptInLabel.trim() || null,
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
  "whatsAppOptInLabel",
]

function useKioskForm(initial: AdminKioskSettings) {
  return useCardForm<KioskDraft>({
    initial: toKioskDraft(initial),
    persist: async (full) => {
      // Refuse settings that would leave the customer nothing to fill in (or an unnamed question).
      const problem = detailsFieldsProblem(detailsFieldsFrom(full))
      if (problem) return { success: false as const, error: problem }
      return updateKioskSettings(toKioskPayload(full))
    },
  })
}

function KioskBehaviorPanel({ form }: { form: ReturnType<typeof useKioskForm> }) {
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
      <div className="rounded-lg border border-line bg-canvas p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">{label}</p>
            <p className="text-xs text-ink-muted">{hint}</p>
          </div>
          <Toggle checked={locked ? true : draft[key]} disabled={busy || locked} onChange={(next) => set(key, next)} />
        </div>
        {draft[key] && extra && <div className="mt-3 space-y-3 border-t border-line pt-3">{extra}</div>}
      </div>
    )
  }

  function requiredCheckbox(key: "emailRequired" | "customRequired") {
    return (
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent"
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
                className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-shadow ${
                  selected
                    ? "border-[color:var(--sb-bg,var(--color-accent-alt))] bg-[color-mix(in_srgb,var(--sb-bg,var(--color-accent-alt))_6%,transparent)] ring-1 ring-[color:var(--sb-bg,var(--color-accent-alt))] [[data-admin-theme=dark]_&]:shadow-[0_0_16px_rgba(227,6,19,0.25)]"
                    : "border-line-strong bg-canvas hover:bg-tint [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
                }`}
              >
                <span className={`text-sm font-semibold ${selected ? "text-[color:var(--sb-bg,var(--color-accent-alt))]" : "text-ink"}`}>
                  {option.title}
                </span>
                <span className="text-xs text-ink-muted">{option.description}</span>
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
              <div className="space-y-4 rounded-lg border border-line bg-canvas p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Booking card</p>
                {textField("bookingCardTitle", "Title", DEFAULT_BOOKING_CARD_TITLE, 40)}
                {textField("bookingCardSubtitle", "Subtitle", DEFAULT_BOOKING_CARD_SUBTITLE, 100)}
              </div>
              <div className="space-y-4 rounded-lg border border-line bg-canvas p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Queue card</p>
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
            <p className="text-sm font-medium text-ink">Fields to show</p>
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
              textField(
                "whatsAppOptInLabel",
                "Tick box wording",
                DEFAULT_WHATSAPP_OPTIN_LABEL,
                80,
                `What customers read next to the tick box. Keep it short. Defaults to "${DEFAULT_WHATSAPP_OPTIN_LABEL}".`,
              ),
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
              <p className="rounded-lg border border-warn-line bg-warn-soft-2 px-3 py-2 text-sm text-warn-strong">
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


