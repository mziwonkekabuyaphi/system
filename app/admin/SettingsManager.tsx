// app/admin/SettingsManager.tsx
"use client"

import { useEffect, useRef, useState, useTransition } from "react"

import {
  removeLogo,
  setKioskEnabled,
  updateBookingSettings,
  updateBranding,
  updateBusinessHours,
  updateGeneralInfo,
  updateKioskSettings,
  updateMessageSettings,
  updateQueueSettings,
  uploadLogo,
} from "./settings-actions"
import type {
  AdminBookingSettings,
  AdminBranding,
  AdminBusinessHours,
  AdminKioskSettings,
  AdminMessageSettings,
  AdminPlan,
  AdminQueuePriorityMode,
  AdminQueueSettings,
  AdminTenantSettings,
} from "./types"

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

type SubTab = "general" | "kiosk" | "private-label" | "booking" | "queue" | "messages"

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "general", label: "Business Info" },
  { id: "kiosk", label: "Kiosk" },
  { id: "private-label", label: "Private Label" },
  { id: "booking", label: "Booking" },
  { id: "queue", label: "Queue" },
  { id: "messages", label: "Messages" },
]

// ---------------------------------------------------------------------------
// Shared styling
//
// CONTRAST FIX: inputs previously had no explicit background, so a white
// <input> sitting inside a white .bg-white card was basically invisible
// except for a thin border — and once a Save/upload button hit
// disabled:opacity-50 on a white background, it faded to almost nothing.
// Every field/button below now has a resting background distinct from the
// white cards, and disabled states use explicit muted colors instead of
// opacity, so "off"/disabled never means "blends into the page."
// ---------------------------------------------------------------------------
const inputClass =
  "w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-900 " +
  "placeholder:text-stone-400 focus:border-[#7A2E3A] focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#7A2E3A] " +
  "disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"

const secondaryButtonClass =
  "rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 " +
  "hover:bg-stone-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400 disabled:hover:bg-stone-100"

const primaryButtonClass =
  "rounded-full bg-[#7A2E3A] px-4 py-2 text-sm font-medium text-white hover:bg-[#651F2A] " +
  "disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"

export function SettingsManager({
  initialPlan,
  tenantSlug,
  initialSettings,
  initialBranding,
  initialKioskEnabled,
  initialKioskSettings,
  initialBookingSettings,
  initialQueueSettings,
  initialMessageSettings,
  initialBusinessHours,
}: {
  initialPlan: AdminPlan
  tenantSlug: string
  initialSettings: AdminTenantSettings
  initialBranding: AdminBranding
  initialKioskEnabled: boolean
  initialKioskSettings: AdminKioskSettings
  initialBookingSettings: AdminBookingSettings
  initialQueueSettings: AdminQueueSettings
  initialMessageSettings: AdminMessageSettings
  initialBusinessHours: AdminBusinessHours
}) {
  const [subTab, setSubTab] = useState<SubTab>("general")

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium ${
              subTab === t.id
                ? "border-stone-800 bg-stone-800 text-white"
                : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "general" && (
        <div className="space-y-3">
          <BusinessInfoPanel initial={initialSettings} />
          <OpeningHoursPanel initial={initialBusinessHours} />
        </div>
      )}
      {subTab === "kiosk" && (
        <KioskPanel
          initialEnabled={initialKioskEnabled}
          tenantSlug={tenantSlug}
          initialKioskSettings={initialKioskSettings}
        />
      )}
      {subTab === "private-label" && <PrivateLabelPanel plan={initialPlan} initial={initialBranding} />}
      {subTab === "booking" && <BookingSettingsPanel initial={initialBookingSettings} />}
      {subTab === "queue" && <QueueSettingsPanel initial={initialQueueSettings} />}
      {subTab === "messages" && <MessageSettingsPanel initial={initialMessageSettings} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Business Info (formerly "General info")
// ---------------------------------------------------------------------------
function BusinessInfoPanel({ initial }: { initial: AdminTenantSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateGeneralInfo(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Business Info</p>
      <p className="text-sm text-stone-500">Contact details and defaults shown to customers.</p>

      <div className="mt-4 space-y-3">
        <FieldRow
          label="Timezone"
          hint="Used everywhere a time is shown or calculated for customers — booking availability, cancellation cutoffs, and confirmations all use this."
        >
          <input
            className={inputClass}
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Currency">
          <input
            className={inputClass}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Contact email">
          <input
            className={inputClass}
            value={form.contactEmail ?? ""}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Contact phone">
          <input
            className={inputClass}
            value={form.contactPhone ?? ""}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Address">
          <textarea
            className={inputClass}
            rows={2}
            value={form.address ?? ""}
            onChange={(e) => setForm({ ...form, address: e.target.value || null })}
          />
        </FieldRow>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Opening Hours — controls what the kiosk and WhatsApp bot will accept.
// Times are entered in the tenant's own timezone (set above in Business
// Info) — the DB compares against that same timezone when deciding whether
// a walk-in or booking is allowed right now.
// ---------------------------------------------------------------------------
function OpeningHoursPanel({ initial }: { initial: AdminBusinessHours }) {
  const [days, setDays] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function updateDay(dayOfWeek: number, patch: Partial<AdminBusinessHours[number]>) {
    setDays((prev) => prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)))
  }

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBusinessHours(days)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  const sorted = [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Opening Hours</p>
      <p className="text-sm text-stone-500">
        Controls when customers can join the queue on the kiosk or start a booking over WhatsApp. Times are in the
        timezone set above.
      </p>

      <div className="mt-4 space-y-2">
        {sorted.map((day) => (
          <div key={day.dayOfWeek} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2">
            <span className="w-24 shrink-0 text-sm font-medium text-stone-800">{DAY_LABELS[day.dayOfWeek]}</span>

            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input
                type="checkbox"
                checked={day.isClosed}
                onChange={(e) =>
                  updateDay(day.dayOfWeek, {
                    isClosed: e.target.checked,
                    openTime: e.target.checked ? null : day.openTime ?? "09:00",
                    closeTime: e.target.checked ? null : day.closeTime ?? "17:00",
                  })
                }
              />
              Closed
            </label>

            {!day.isClosed && (
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  className={`${inputClass} w-32`}
                  value={day.openTime ?? ""}
                  onChange={(e) => updateDay(day.dayOfWeek, { openTime: e.target.value })}
                />
                <span className="text-sm text-stone-400">to</span>
                <input
                  type="time"
                  className={`${inputClass} w-32`}
                  value={day.closeTime ?? ""}
                  onChange={(e) => updateDay(day.dayOfWeek, { closeTime: e.target.value })}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
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
function KioskPanel({
  initialEnabled,
  tenantSlug,
  initialKioskSettings,
}: {
  initialEnabled: boolean
  tenantSlug: string
  initialKioskSettings: AdminKioskSettings
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

      <KioskBehaviorPanel initial={initialKioskSettings} />
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
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Kiosk URL</p>
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

function KioskBehaviorPanel({ initial }: { initial: AdminKioskSettings }) {
  const [tagline, setTagline] = useState(initial.tagline ?? "")
  const [idleRefreshSeconds, setIdleRefreshSeconds] = useState(initial.idleRefreshSeconds)
  const [confirmationRefreshSeconds, setConfirmationRefreshSeconds] = useState(initial.confirmationRefreshSeconds)
  const [registrationType, setRegistrationType] = useState(initial.registrationType)
  const [choiceTitle, setChoiceTitle] = useState(initial.choiceTitle ?? "")
  const [bookingCardTitle, setBookingCardTitle] = useState(initial.bookingCardTitle ?? "")
  const [bookingCardSubtitle, setBookingCardSubtitle] = useState(initial.bookingCardSubtitle ?? "")
  const [queueCardTitle, setQueueCardTitle] = useState(initial.queueCardTitle ?? "")
  const [queueCardSubtitle, setQueueCardSubtitle] = useState(initial.queueCardSubtitle ?? "")
  const [serviceScreenTitle, setServiceScreenTitle] = useState(initial.serviceScreenTitle ?? "")
  const [dateScreenTitle, setDateScreenTitle] = useState(initial.dateScreenTitle ?? "")
  const [timeScreenTitle, setTimeScreenTitle] = useState(initial.timeScreenTitle ?? "")
  const [detailsScreenTitle, setDetailsScreenTitle] = useState(initial.detailsScreenTitle ?? "")
  const [ticketBookingEyebrow, setTicketBookingEyebrow] = useState(initial.ticketBookingEyebrow ?? "")
  const [ticketQueueEyebrow, setTicketQueueEyebrow] = useState(initial.ticketQueueEyebrow ?? "")
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateKioskSettings({
        tagline: tagline.trim() || null,
        idleRefreshSeconds,
        confirmationRefreshSeconds,
        registrationType,
        choiceTitle: choiceTitle.trim() || null,
        bookingCardTitle: bookingCardTitle.trim() || null,
        bookingCardSubtitle: bookingCardSubtitle.trim() || null,
        queueCardTitle: queueCardTitle.trim() || null,
        queueCardSubtitle: queueCardSubtitle.trim() || null,
        serviceScreenTitle: serviceScreenTitle.trim() || null,
        dateScreenTitle: dateScreenTitle.trim() || null,
        timeScreenTitle: timeScreenTitle.trim() || null,
        detailsScreenTitle: detailsScreenTitle.trim() || null,
        ticketBookingEyebrow: ticketBookingEyebrow.trim() || null,
        ticketQueueEyebrow: ticketQueueEyebrow.trim() || null,
      })
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Kiosk behavior</p>
      <p className="text-sm text-stone-500">Control what the kiosk displays and how it resets between customers.</p>

      <div className="mt-4 space-y-4">
        <FieldRow label="Tagline" hint='Shown under your shop name on the welcome screen. Defaults to "Tap anywhere to check in".'>
          <input
            className={inputClass}
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="Tap anywhere to check in"
            maxLength={80}
          />
        </FieldRow>

        <FieldRow
          label="Idle refresh time (seconds)"
          hint="The time it takes before the kiosk automatically refreshes when no one has used it."
        >
          <input
            type="number"
            min={10}
            max={600}
            className={inputClass}
            value={idleRefreshSeconds}
            onChange={(e) => setIdleRefreshSeconds(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow
          label="Confirmation refresh time (seconds)"
          hint="The time it takes before the kiosk redirects to the start page after displaying the confirmation page."
        >
          <input
            type="number"
            min={3}
            max={120}
            className={inputClass}
            value={confirmationRefreshSeconds}
            onChange={(e) => setConfirmationRefreshSeconds(Number(e.target.value))}
          />
        </FieldRow>

        <div>
          <span className="mb-1 block text-sm text-stone-600">Registration types allowed</span>
          <p className="mb-2 text-xs text-stone-400">Choose what type of registration is publicly allowed.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {REGISTRATION_TYPE_OPTIONS.map((option) => {
              const selected = registrationType === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRegistrationType(option.value)}
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
        </div>

        <div className="border-t border-stone-200 pt-4">
          <FieldRow
            label="Service screen heading"
            hint={`Shown on every kiosk path (booking, queue, or both) when picking a service. Defaults to "${DEFAULT_SERVICE_SCREEN_TITLE}".`}
          >
            <input
              className={inputClass}
              value={serviceScreenTitle}
              onChange={(e) => setServiceScreenTitle(e.target.value)}
              placeholder={DEFAULT_SERVICE_SCREEN_TITLE}
              maxLength={80}
            />
          </FieldRow>
        </div>

        {registrationType !== "queue" && (
          <div>
            <FieldRow
              label="Date screen heading"
              hint={`Shown on the booking path, right after picking a service. Defaults to "${DEFAULT_DATE_SCREEN_TITLE}".`}
            >
              <input
                className={inputClass}
                value={dateScreenTitle}
                onChange={(e) => setDateScreenTitle(e.target.value)}
                placeholder={DEFAULT_DATE_SCREEN_TITLE}
                maxLength={80}
              />
            </FieldRow>
          </div>
        )}

        {registrationType !== "queue" && (
          <div>
            <FieldRow
              label="Time screen heading"
              hint={`Shown on the booking path, right before the time grid. The kiosk adds the date automatically (e.g. "${DEFAULT_TIME_SCREEN_TITLE} — Today"), so just enter the part before the date. Defaults to "${DEFAULT_TIME_SCREEN_TITLE}".`}
            >
              <input
                className={inputClass}
                value={timeScreenTitle}
                onChange={(e) => setTimeScreenTitle(e.target.value)}
                placeholder={DEFAULT_TIME_SCREEN_TITLE}
                maxLength={40}
              />
            </FieldRow>
          </div>
        )}

        <div>
          <FieldRow
            label="Name/phone screen heading"
            hint={`Shown on every kiosk path, right before submitting. Defaults to "${DEFAULT_DETAILS_SCREEN_TITLE}".`}
          >
            <input
              className={inputClass}
              value={detailsScreenTitle}
              onChange={(e) => setDetailsScreenTitle(e.target.value)}
              placeholder={DEFAULT_DETAILS_SCREEN_TITLE}
              maxLength={80}
            />
          </FieldRow>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {registrationType !== "queue" && (
            <FieldRow
              label="Ticket label — booking"
              hint={`Small label above the ticket number on the final screen. Defaults to "${DEFAULT_TICKET_BOOKING_EYEBROW}".`}
            >
              <input
                className={inputClass}
                value={ticketBookingEyebrow}
                onChange={(e) => setTicketBookingEyebrow(e.target.value)}
                placeholder={DEFAULT_TICKET_BOOKING_EYEBROW}
                maxLength={30}
              />
            </FieldRow>
          )}
          {registrationType !== "booking" && (
            <FieldRow
              label="Ticket label — queue"
              hint={`Small label above the ticket number on the final screen. Defaults to "${DEFAULT_TICKET_QUEUE_EYEBROW}".`}
            >
              <input
                className={inputClass}
                value={ticketQueueEyebrow}
                onChange={(e) => setTicketQueueEyebrow(e.target.value)}
                placeholder={DEFAULT_TICKET_QUEUE_EYEBROW}
                maxLength={30}
              />
            </FieldRow>
          )}
        </div>

        {registrationType === "both" && (
          <div className="border-t border-stone-200 pt-4">
            <span className="mb-1 block text-sm font-medium text-stone-800">Choice screen wording</span>
            <p className="mb-3 text-xs text-stone-400">
              What customers see on the screen where they pick booking or the walk-in queue. Rename these to fit
              your business — e.g. &quot;Reserve a table&quot; / &quot;Get in line&quot;.
            </p>

            <div className="space-y-4">
              <FieldRow label="Screen heading" hint={`Defaults to "${DEFAULT_CHOICE_TITLE}".`}>
                <input
                  className={inputClass}
                  value={choiceTitle}
                  onChange={(e) => setChoiceTitle(e.target.value)}
                  placeholder={DEFAULT_CHOICE_TITLE}
                  maxLength={80}
                />
              </FieldRow>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-4 rounded-xl border border-stone-200 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Booking card</p>
                  <FieldRow label="Title" hint={`Defaults to "${DEFAULT_BOOKING_CARD_TITLE}".`}>
                    <input
                      className={inputClass}
                      value={bookingCardTitle}
                      onChange={(e) => setBookingCardTitle(e.target.value)}
                      placeholder={DEFAULT_BOOKING_CARD_TITLE}
                      maxLength={40}
                    />
                  </FieldRow>
                  <FieldRow label="Subtitle" hint={`Defaults to "${DEFAULT_BOOKING_CARD_SUBTITLE}".`}>
                    <input
                      className={inputClass}
                      value={bookingCardSubtitle}
                      onChange={(e) => setBookingCardSubtitle(e.target.value)}
                      placeholder={DEFAULT_BOOKING_CARD_SUBTITLE}
                      maxLength={100}
                    />
                  </FieldRow>
                </div>

                <div className="space-y-4 rounded-xl border border-stone-200 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Queue card</p>
                  <FieldRow label="Title" hint={`Defaults to "${DEFAULT_QUEUE_CARD_TITLE}".`}>
                    <input
                      className={inputClass}
                      value={queueCardTitle}
                      onChange={(e) => setQueueCardTitle(e.target.value)}
                      placeholder={DEFAULT_QUEUE_CARD_TITLE}
                      maxLength={40}
                    />
                  </FieldRow>
                  <FieldRow label="Subtitle" hint={`Defaults to "${DEFAULT_QUEUE_CARD_SUBTITLE}".`}>
                    <input
                      className={inputClass}
                      value={queueCardSubtitle}
                      onChange={(e) => setQueueCardSubtitle(e.target.value)}
                      placeholder={DEFAULT_QUEUE_CARD_SUBTITLE}
                      maxLength={100}
                    />
                  </FieldRow>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Private Label — the SINGLE place branding is edited. Controls how the
// business appears across every customer-facing surface (kiosk, booking &
// queue confirmations, WhatsApp). Two cards:
//   - Brand identity: display name, logo, colors
//   - Platform branding: "Remove Powered by" (Business plan only)
// Both save through the same AdminBranding shape and the same
// updateBranding()/uploadLogo()/removeLogo() actions as before — nothing
// about the data layer changed, only where the controls live.
// ---------------------------------------------------------------------------
function PrivateLabelPanel({ plan, initial }: { plan: AdminPlan; initial: AdminBranding }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-[family-name:var(--font-admin-serif)] text-xl text-stone-900">Private Label</p>
        <p className="text-sm text-stone-500">
          Control the brand customers see across your booking, queue, kiosk, and WhatsApp experience.
        </p>
      </div>

      <BrandingFields plan={plan} initial={initial} />
    </div>
  )
}

function BrandingFields({ plan, initial }: { plan: AdminPlan; initial: AdminBranding }) {
  const [form, setForm] = useState({
    displayName: initial.displayName,
    primaryColor: initial.primaryColor,
    secondaryColor: initial.secondaryColor,
    removePoweredBy: initial.removePoweredBy,
  })
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [logoUrl, setLogoUrl] = useState(initial.logoUrl)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [isLogoPending, startLogoTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false)

  const isBusiness = plan === "business"

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBranding(form)
      if (result.success) {
        setMessage({ ok: true, text: "Saved." })
      } else {
        setMessage({ ok: false, text: result.error })
        setForm((f) => ({ ...f, removePoweredBy: initial.removePoweredBy }))
      }
    })
  }

  function handleRemovePoweredByChange(next: boolean) {
    if (next && !isBusiness) {
      setShowUpgradePrompt(true)
      return
    }
    setShowUpgradePrompt(false)
    setForm({ ...form, removePoweredBy: next })
  }

  function handleLogoFile(file: File | null) {
    if (!file) return
    setLogoError(null)

    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setLogoError("Logo must be a PNG, JPEG, WebP, or SVG image")
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo must be 2MB or smaller")
      return
    }

    const formData = new FormData()
    formData.set("file", file)

    startLogoTransition(async () => {
      const result = await uploadLogo(formData)
      if (result.success) {
        setLogoUrl(result.logoUrl)
      } else {
        setLogoError(result.error)
      }
      if (fileInputRef.current) fileInputRef.current.value = ""
    })
  }

  function handleRemoveLogo() {
    setLogoError(null)
    startLogoTransition(async () => {
      const result = await removeLogo()
      if (result.success) setLogoUrl(null)
      else setLogoError(result.error)
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Brand identity</p>
        <p className="text-sm text-stone-500">Set the name, logo, and colors customers see when interacting with your business.</p>

        <div className="mt-4 space-y-4">
          <FieldRow label="Display name">
            <input
              className={inputClass}
              value={form.displayName ?? ""}
              onChange={(e) => setForm({ ...form, displayName: e.target.value || null })}
            />
          </FieldRow>

          <FieldRow label="Logo">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-stone-200 bg-stone-50">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external Storage URL, not a static/local asset
                  <img src={logoUrl} alt="Shop logo" className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-stone-400">No logo</span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLogoPending}
                    className={secondaryButtonClass}
                  >
                    {isLogoPending ? "Uploading…" : logoUrl ? "Change logo" : "Upload logo"}
                  </button>
                  {logoUrl && (
                    <button
                      type="button"
                      onClick={handleRemoveLogo}
                      disabled={isLogoPending}
                      className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-500 hover:bg-stone-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-300"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-xs text-stone-400">PNG, JPEG, WebP, or SVG. Up to 2MB.</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => handleLogoFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
          </FieldRow>

          <div className="grid grid-cols-2 gap-3">
            <ColorField
              label="Primary color"
              value={form.primaryColor ?? "#7A2E3A"}
              onChange={(hex) => setForm({ ...form, primaryColor: hex })}
            />
            <ColorField
              label="Secondary color"
              value={form.secondaryColor ?? "#4B6B54"}
              onChange={(hex) => setForm({ ...form, secondaryColor: hex })}
            />
          </div>
        </div>

        <SaveRow isPending={isPending} onSave={save} message={message} />
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Platform branding</p>
        <p className="text-sm text-stone-500">Control whether your customers see attribution to the platform.</p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-stone-800">Remove &quot;Powered by&quot;</p>
            <p className="text-sm text-stone-500">
              Hide the platform footer from customer-facing experiences. This is a Business plan feature.
            </p>
          </div>
          <Toggle checked={form.removePoweredBy} disabled={isPending} onChange={handleRemovePoweredByChange} />
        </div>

        {showUpgradePrompt && (
          <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span>
              This is a Business plan feature. Upgrade your plan to remove the &quot;Powered by&quot; footer from your
              kiosk.
            </span>
            <button
              type="button"
              onClick={() => setShowUpgradePrompt(false)}
              aria-label="Dismiss"
              className="shrink-0 text-amber-600 hover:text-amber-900"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking
//
// UPDATED: explanatory hints added under each field (these settings now
// actually control the live booking flow — see lib/services/booking.ts,
// app/admin/actions.ts, and app/api/cron/promote-bookings/route.ts).
// Also adds Queue Priority Mode (queuePriorityMode), a new tenant setting
// (supabase/migrations/20260915_add_queue_priority_mode.sql) that decides
// how a promoted booking is ordered relative to walk-ins once it's in the
// shared queue — see lib/services/queue.ts's getQueueSimulation() for
// exactly what each option does. It's saved through the same
// updateBookingSettings() action and SaveRow as everything else on this
// tab, and it's only meaningful once "Link bookings to the queue" is on,
// so its card is disabled (not hidden) until that toggle is switched on —
// same "off = visibly muted, not invisible" convention this file already
// uses for disabled inputs/buttons elsewhere.
// ---------------------------------------------------------------------------
const QUEUE_PRIORITY_MODE_OPTIONS: Array<{
  value: AdminQueuePriorityMode
  title: string
  description: string
}> = [
  {
    value: "fifo",
    title: "First come, first served",
    description: "A promoted booking is treated exactly like a walk-in, ordered by when it entered the queue.",
  },
  {
    value: "priority",
    title: "Honor appointment time",
    description:
      "A promoted booking is served at or before its actual appointment time wherever possible — even ahead of walk-ins who joined earlier.",
  },
  {
    value: "hybrid",
    title: "First come, but flag it",
    description:
      "Same order as \u201cFirst come, first served,\u201d but staff see a warning if a booking's wait would run past its appointment time.",
  },
]

function BookingSettingsPanel({ initial }: { initial: AdminBookingSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBookingSettings(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">
              Link bookings to the queue
            </p>
            <p className="text-sm text-stone-500">
              When on, confirmed bookings automatically join the walk-in queue shortly before their start
              time, so front-of-house sees one unified line instead of two separate systems.
            </p>
          </div>
          <Toggle
            checked={form.unifyWithQueue}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, unifyWithQueue: next })}
          />
        </div>
        <p className="mt-3 text-xs text-stone-400">
          Checked automatically about once a minute — a booking won&apos;t appear in the queue instantly the
          moment it becomes eligible, but within about a minute of it. This doesn&apos;t change who&apos;s
          allowed to join the queue as a walk-in (see the Queue tab) — it only adds bookings alongside them.
        </p>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Booking rules</p>
        <p className="text-sm text-stone-500">Timing defaults for appointments at this location.</p>

        <div className="mt-4 space-y-3">
          <FieldRow
            label="Add to queue this many minutes before start time"
            hint="Calculated from each booking's start time, in your shop's timezone (Business Info tab) — not from when the booking was made."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.queueLeadTimeMinutes}
              onChange={(e) => setForm({ ...form, queueLeadTimeMinutes: Number(e.target.value) })}
            />
          </FieldRow>
          <FieldRow
            label="Minimum notice to book (minutes)"
            hint="Customers can't book an appointment sooner than this from right now. Enforced on every booking attempt, not just hidden in the time list."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.minNoticeMinutes}
              onChange={(e) => setForm({ ...form, minNoticeMinutes: Number(e.target.value) })}
            />
          </FieldRow>
          <FieldRow
            label="How far ahead customers can book (days)"
            hint="Customers can book up to and including this many days ahead, in your shop's timezone. Also still limited by your Opening Hours. Set to 0 for same-day booking only — the kiosk and booking flow then skip the date picker entirely and go straight to today's available times."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.maxAdvanceDays}
              onChange={(e) => setForm({ ...form, maxAdvanceDays: Number(e.target.value) })}
            />
          </FieldRow>
          <FieldRow
            label="Free cancellation window (minutes before start)"
            hint="Once a booking is inside this window, it can no longer be cancelled from the Today tab."
          >
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.cancellationWindowMinutes}
              onChange={(e) => setForm({ ...form, cancellationWindowMinutes: Number(e.target.value) })}
            />
          </FieldRow>
        </div>

        <SaveRow isPending={isPending} onSave={save} message={message} />
      </div>

      <div
        className={`rounded-2xl border border-stone-200 bg-white p-4 shadow-sm ${
          form.unifyWithQueue ? "" : "opacity-60"
        }`}
      >
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Queue priority</p>
        <p className="text-sm text-stone-500">
          How a promoted booking is ordered against walk-ins once it's in the queue.
          {!form.unifyWithQueue && " Only applies while \u201cLink bookings to the queue\u201d above is on."}
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {QUEUE_PRIORITY_MODE_OPTIONS.map((option) => {
            const selected = form.queuePriorityMode === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={!form.unifyWithQueue || isPending}
                onClick={() => setForm({ ...form, queuePriorityMode: option.value })}
                aria-pressed={selected}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed ${
                  selected
                    ? "border-[#7A2E3A] bg-[#7A2E3A]/5 ring-1 ring-[#7A2E3A]"
                    : "border-stone-300 bg-stone-50 hover:bg-stone-100 disabled:hover:bg-stone-50"
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

        <SaveRow isPending={isPending} onSave={save} message={message} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function QueueSettingsPanel({ initial }: { initial: AdminQueueSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateQueueSettings(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Queue</p>
      <p className="text-sm text-stone-500">How the walk-in line behaves for this location.</p>

      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-stone-800">Auto-call next</p>
            <p className="text-sm text-stone-500">Automatically call the next customer when a slot frees up.</p>
          </div>
          <Toggle
            checked={form.autoCallNext}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, autoCallNext: next })}
          />
        </div>

        <FieldRow label="Maximum queue size (blank = no limit)">
          <input
            type="number"
            min={1}
            className={inputClass}
            value={form.maxQueueSize ?? ""}
            onChange={(e) => setForm({ ...form, maxQueueSize: e.target.value ? Number(e.target.value) : null })}
          />
        </FieldRow>

        <FieldRow label="Notify a customer this many people before their turn">
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.notifyBeforeTurnPosition}
            onChange={(e) => setForm({ ...form, notifyBeforeTurnPosition: Number(e.target.value) })}
          />
        </FieldRow>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-stone-800">Allow walk-ins via WhatsApp</p>
          <Toggle
            checked={form.allowWalkinWhatsapp}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, allowWalkinWhatsapp: next })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-stone-800">Allow walk-ins via kiosk</p>
          <Toggle
            checked={form.allowWalkinKiosk}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, allowWalkinKiosk: next })}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stone-100 pt-4">
          <div>
            <p className="text-sm font-medium text-stone-800">Require a service to join the queue</p>
            <p className="text-sm text-stone-500">
              Turn this off if walk-ins don&apos;t choose between services — they&apos;ll skip straight to giving
              their name and number on the kiosk, WhatsApp, and admin.
            </p>
          </div>
          <Toggle
            checked={form.requireServiceSelection}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, requireServiceSelection: next })}
          />
        </div>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function MessageSettingsPanel({ initial }: { initial: AdminMessageSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateMessageSettings(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Messages</p>
          <p className="text-sm text-stone-500">WhatsApp templates and default AI handling for conversations.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-stone-600">AI replies by default</span>
          <Toggle
            checked={form.aiEnabledDefault}
            disabled={isPending}
            onChange={(next) => setForm({ ...form, aiEnabledDefault: next })}
          />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <FieldRow label="Booking confirmation">
          <textarea
            className={inputClass}
            rows={2}
            value={form.bookingConfirmationTemplate ?? ""}
            onChange={(e) => setForm({ ...form, bookingConfirmationTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Booking reminder">
          <textarea
            className={inputClass}
            rows={2}
            value={form.bookingReminderTemplate ?? ""}
            onChange={(e) => setForm({ ...form, bookingReminderTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Joined the queue">
          <textarea
            className={inputClass}
            rows={2}
            value={form.queueJoinedTemplate ?? ""}
            onChange={(e) => setForm({ ...form, queueJoinedTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Almost your turn">
          <textarea
            className={inputClass}
            rows={2}
            value={form.queueAlmostTurnTemplate ?? ""}
            onChange={(e) => setForm({ ...form, queueAlmostTurnTemplate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="You've been called">
          <textarea
            className={inputClass}
            rows={2}
            value={form.queueCalledTemplate ?? ""}
            onChange={(e) => setForm({ ...form, queueCalledTemplate: e.target.value || null })}
          />
        </FieldRow>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-stone-400">{hint}</span>}
      {children}
    </label>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const isValid = HEX_COLOR_PATTERN.test(draft)

  function commit(next: string) {
    setDraft(next)
    if (HEX_COLOR_PATTERN.test(next)) onChange(next)
  }

  return (
    <FieldRow label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-10 w-10 shrink-0 rounded-lg border border-stone-300 bg-white p-0.5"
          value={isValid ? draft : value}
          onChange={(e) => {
            setDraft(e.target.value)
            onChange(e.target.value)
          }}
        />
        <input
          type="text"
          className={`${inputClass} ${!isValid ? "border-red-300 bg-red-50" : ""}`}
          value={draft}
          onChange={(e) => commit(e.target.value)}
          placeholder="#7A2E3A"
        />
      </div>
    </FieldRow>
  )
}

function SaveRow({
  isPending,
  onSave,
  message,
}: {
  isPending: boolean
  onSave: () => void
  message: { ok: boolean; text: string } | null
}) {
  return (
    <div className="mt-4 flex items-center gap-3 border-t border-stone-100 pt-4">
      <button type="button" onClick={onSave} disabled={isPending} className={primaryButtonClass}>
        {isPending ? "Saving…" : "Save"}
      </button>
      {message && (
        <span className={`text-sm ${message.ok ? "text-[#4B6B54]" : "text-red-700"}`}>{message.text}</span>
      )}
    </div>
  )
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 ring-inset ring-black/10 transition-colors disabled:cursor-not-allowed ${
        checked ? (disabled ? "bg-[#7A2E3A]/60" : "bg-[#7A2E3A]") : disabled ? "bg-stone-200" : "bg-stone-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  )
}
