"use client"

import { useEffect, useState } from "react"

import {
  updateDisplaySettings,
} from "../settings-actions"
import type {
  AdminDisplaySettings,
} from "../types"
import {
  CardSaveRow,
  ColorField,
  FieldRow,
  HEX_COLOR_PATTERN,
  SettingsCard,
  SubSection,
  ToggleRow,
  inputClass,
  secondaryButtonClass,
  useCardForm,
} from "./ui"

// ---------------------------------------------------------------------------
// Display — the ambient TV screen for the waiting area. Its own tab
// (separate from Kiosk) since it's a different physical device with a
// different job: kiosk is customer-operated self-service, display is a
// passive, unattended screen that just rotates through what's showing
// right now. Wording/timing here writes to tenant_branding's display_*
// columns via updateDisplaySettings — see migration_display_settings.sql
// and DisplayScreen.tsx (which is what actually renders these).
//
// Branding (name, logo, colors) still isn't edited here, same reasoning
// as the Kiosk tab — Private Label is the single source of truth for
// that, this tab only configures Display-specific behavior.
// ---------------------------------------------------------------------------
const DEFAULT_DISPLAY_MENU_TITLE = "On the menu"
const DEFAULT_DISPLAY_BOOKINGS_TITLE = "Upcoming bookings"
const DEFAULT_DISPLAY_QUEUE_TITLE = "Live queue"
const DEFAULT_DISPLAY_NOW_SERVING_LABEL = "Now serving"
const DEFAULT_DISPLAY_WAITING_LABEL = "Waiting"
const DEFAULT_DISPLAY_WAITING_EMPTY = "Nobody waiting right now."
const DEFAULT_DISPLAY_SERVING_EMPTY = "No one is being served right now."
const DEFAULT_DISPLAY_BOOKINGS_EMPTY = "No upcoming bookings."
const DEFAULT_DISPLAY_WALKIN_BADGE = "Walk-in"
const DEFAULT_DISPLAY_BOOKING_BADGE = "Booking"

// DB column only accepts #RRGGBB, but the shared ColorField also allows #RGB.
function toSixDigitHex(value: string): string | null {
  if (!HEX_COLOR_PATTERN.test(value)) return null
  const clean = value.slice(1)
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean
  return `#${full.toUpperCase()}`
}

const DISPLAY_LAYOUT_OPTIONS: Array<{
  value: AdminDisplaySettings["layout"]
  title: string
  description: string
}> = [
  {
    value: "rotation",
    title: "Rotating slides",
    description: "One big screen at a time: menu, bookings, queue. Best for a TV people glance at from across the room.",
  },
  {
    value: "board",
    title: "Live board",
    description: "Everything at once: Waiting, Now serving and Upcoming bookings as ticket columns, with your menu scrolling along the bottom.",
  },
]

const DISPLAY_THEME_OPTIONS: Array<{
  value: AdminDisplaySettings["theme"]
  title: string
  description: string
  swatch: string
}> = [
  { value: "dark", title: "Dark", description: "Near-black with light text. Easy on the eyes in dim rooms.", swatch: "#15110D" },
  { value: "light", title: "Light", description: "Off-white with dark text. Suits bright, airy spaces.", swatch: "#FAF8F5" },
  { value: "custom", title: "Custom color", description: "Pick your own background. Text color adjusts automatically.", swatch: "" },
]

// Form-state shape for the Display page: empty strings instead of nulls so
// inputs stay controlled. Converted to/from the server shapes below.
type DisplayDraft = {
  layout: AdminDisplaySettings["layout"]
  theme: AdminDisplaySettings["theme"]
  backgroundColor: string
  tagline: string
  showServices: boolean
  showBookings: boolean
  showQueue: boolean
  showQueueTicketNumber: boolean
  showQueueService: boolean
  showQueuePhone: boolean
  showQueueWaitEstimate: boolean
  showQueueDuration: boolean
  showQueueReference: boolean
  welcomeSeconds: number
  menuBookingsSeconds: number
  queueSeconds: number
  menuTitle: string
  bookingsTitle: string
  queueTitle: string
  nowServingLabel: string
  waitingLabel: string
  waitingEmptyText: string
  servingEmptyText: string
  bookingsEmptyText: string
  walkInBadgeLabel: string
  bookingBadgeLabel: string
}

function toDisplayDraft(s: AdminDisplaySettings): DisplayDraft {
  return {
    layout: s.layout,
    theme: s.theme,
    backgroundColor: s.backgroundColor ?? "#15110D",
    tagline: s.tagline ?? "",
    showServices: s.showServices,
    showBookings: s.showBookings,
    showQueue: s.showQueue,
    showQueueTicketNumber: s.showQueueTicketNumber,
    showQueueService: s.showQueueService,
    showQueuePhone: s.showQueuePhone,
    showQueueWaitEstimate: s.showQueueWaitEstimate,
    showQueueDuration: s.showQueueDuration,
    showQueueReference: s.showQueueReference,
    welcomeSeconds: s.welcomeSeconds,
    menuBookingsSeconds: s.menuBookingsSeconds,
    queueSeconds: s.queueSeconds,
    menuTitle: s.menuTitle ?? "",
    bookingsTitle: s.bookingsTitle ?? "",
    queueTitle: s.queueTitle ?? "",
    nowServingLabel: s.nowServingLabel ?? "",
    waitingLabel: s.waitingLabel ?? "",
    waitingEmptyText: s.waitingEmptyText ?? "",
    servingEmptyText: s.servingEmptyText ?? "",
    bookingsEmptyText: s.bookingsEmptyText ?? "",
    walkInBadgeLabel: s.walkInBadgeLabel ?? "",
    bookingBadgeLabel: s.bookingBadgeLabel ?? "",
  }
}

function toDisplayPayload(d: DisplayDraft): Parameters<typeof updateDisplaySettings>[0] {
  return {
    theme: d.theme,
    layout: d.layout,
    backgroundColor: toSixDigitHex(d.backgroundColor),
    tagline: d.tagline.trim() || null,
    showServices: d.showServices,
    showBookings: d.showBookings,
    showQueue: d.showQueue,
    welcomeSeconds: d.welcomeSeconds,
    menuBookingsSeconds: d.menuBookingsSeconds,
    queueSeconds: d.queueSeconds,
    menuTitle: d.menuTitle.trim() || null,
    bookingsTitle: d.bookingsTitle.trim() || null,
    queueTitle: d.queueTitle.trim() || null,
    nowServingLabel: d.nowServingLabel.trim() || null,
    waitingLabel: d.waitingLabel.trim() || null,
    waitingEmptyText: d.waitingEmptyText.trim() || null,
    servingEmptyText: d.servingEmptyText.trim() || null,
    bookingsEmptyText: d.bookingsEmptyText.trim() || null,
    walkInBadgeLabel: d.walkInBadgeLabel.trim() || null,
    bookingBadgeLabel: d.bookingBadgeLabel.trim() || null,
    showQueueTicketNumber: d.showQueueTicketNumber,
    showQueueService: d.showQueueService,
    showQueuePhone: d.showQueuePhone,
    showQueueWaitEstimate: d.showQueueWaitEstimate,
    showQueueDuration: d.showQueueDuration,
    showQueueReference: d.showQueueReference,
  }
}

// Which draft fields belong to which card. A card saves (and shows
// "Unsaved changes" for) only its own keys.
const DISPLAY_LOOK_KEYS: Array<keyof DisplayDraft> = ["layout", "theme", "backgroundColor", "tagline"]
const DISPLAY_SCREEN_KEYS: Array<keyof DisplayDraft> = ["showServices", "showBookings", "showQueue"]
const DISPLAY_QUEUE_KEYS: Array<keyof DisplayDraft> = [
  "showQueueTicketNumber",
  "showQueueService",
  "showQueuePhone",
  "showQueueWaitEstimate",
  "showQueueDuration",
  "showQueueReference",
]
const DISPLAY_TIMING_KEYS: Array<keyof DisplayDraft> = ["welcomeSeconds", "menuBookingsSeconds", "queueSeconds"]
const DISPLAY_WORDING_KEYS: Array<keyof DisplayDraft> = [
  "menuTitle",
  "bookingsTitle",
  "queueTitle",
  "nowServingLabel",
  "waitingLabel",
  "waitingEmptyText",
  "servingEmptyText",
  "bookingsEmptyText",
  "walkInBadgeLabel",
  "bookingBadgeLabel",
]

export function DisplayPanel({
  tenantSlug,
  initial,
  canCustomizeBranding,
}: {
  tenantSlug: string
  initial: AdminDisplaySettings
  canCustomizeBranding: boolean
}) {
  const form = useCardForm<DisplayDraft>({
    initial: toDisplayDraft(initial),
    persist: (full) => updateDisplaySettings(toDisplayPayload(full)),
  })
  const { draft, set } = form
  const busy = form.savingCard !== null
  const isBoard = draft.layout === "board"

  // ColorField keeps its own text while you type, so "Discard" has to nudge
  // it to re-read the value.
  const [colorResetKey, setColorResetKey] = useState(0)

  function footer(cardId: string, keys: Array<keyof DisplayDraft>, onDiscard?: () => void) {
    return (
      <CardSaveRow
        dirty={form.isDirty(keys)}
        isPending={form.savingCard === cardId}
        onSave={() => form.save(cardId, keys)}
        onDiscard={() => {
          form.discard(keys)
          onDiscard?.()
        }}
        message={form.messages[cardId] ?? null}
      />
    )
  }

  function textField(
    key: keyof DisplayDraft,
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
          onChange={(e) => set(key, e.target.value as DisplayDraft[typeof key])}
          placeholder={placeholder}
          maxLength={maxLength}
        />
      </FieldRow>
    )
  }

  return (
    <div className="space-y-4">
      <DisplayUrlPanel tenantSlug={tenantSlug} />

      <SettingsCard
        title="Layout & look"
        description="How the TV is arranged and what it looks like. These apply to both layouts."
        footer={footer("look", DISPLAY_LOOK_KEYS, () => setColorResetKey((k) => k + 1))}
      >
        <SubSection
          title="Layout"
          hint="Rotating slides shows one big screen at a time. Live board shows everything at once."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {DISPLAY_LAYOUT_OPTIONS.map((option) => {
              const selected = draft.layout === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={busy}
                  onClick={() => set("layout", option.value)}
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
        </SubSection>

        <SubSection
          title="Colour theme"
          hint="Text colour is chosen for you so it stays readable on any background. Brand colours are nudged lighter or darker if they'd be hard to read."
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {DISPLAY_THEME_OPTIONS.map((option) => {
              const selected = draft.theme === option.value
              const locked = option.value === "custom" && !canCustomizeBranding
              const swatch =
                option.value === "custom"
                  ? HEX_COLOR_PATTERN.test(draft.backgroundColor)
                    ? draft.backgroundColor
                    : "#15110D"
                  : option.swatch
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={busy || locked}
                  onClick={() => set("theme", option.value)}
                  aria-pressed={selected}
                  className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
                    locked ? "cursor-not-allowed opacity-60 " : ""
                  }${
                    selected
                      ? "border-[#7A2E3A] bg-[#7A2E3A]/5 ring-1 ring-[#7A2E3A]"
                      : "border-stone-300 bg-stone-50 hover:bg-stone-100"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 shrink-0 rounded-full border border-stone-300" style={{ background: swatch }} />
                    <span className={`text-sm font-semibold ${selected ? "text-[#7A2E3A]" : "text-stone-800"}`}>
                      {option.title}
                    </span>
                  </span>
                  <span className="text-xs text-stone-500">
                    {locked ? "Custom background colours are a Business plan feature." : option.description}
                  </span>
                </button>
              )
            })}
          </div>
          {draft.theme === "custom" && canCustomizeBranding && (
            <div className="max-w-xs">
              <ColorField
                key={colorResetKey}
                label="Background colour"
                value={draft.backgroundColor}
                onChange={(hex) => set("backgroundColor", hex)}
              />
            </div>
          )}
        </SubSection>

        <SubSection title="Tagline">
          <FieldRow
            label="Tagline under your name"
            hint="Separate from the kiosk tagline, so “Tap anywhere to check in” never shows on the TV. Leave empty for none."
          >
            <input
              className={inputClass}
              value={draft.tagline}
              onChange={(e) => set("tagline", e.target.value)}
              placeholder="e.g. Walk-ins welcome"
              maxLength={80}
            />
          </FieldRow>
        </SubSection>
      </SettingsCard>

      <SettingsCard
        title="Screens to show"
        description={
          isBoard
            ? "Choose which sections appear on the board. A section with nothing to show is left out automatically."
            : "Choose which screens are in the rotation. A screen with nothing to show is skipped automatically."
        }
        footer={footer("screens", DISPLAY_SCREEN_KEYS)}
      >
        <ToggleRow
          title="Menu"
          description="Your bookable services and prices."
          checked={draft.showServices}
          disabled={busy}
          onChange={(v) => set("showServices", v)}
        />
        <ToggleRow
          title="Upcoming bookings"
          description="Confirmed appointments coming up next."
          checked={draft.showBookings}
          disabled={busy}
          onChange={(v) => set("showBookings", v)}
        />
        <ToggleRow
          title="Live queue"
          description="Who's being served now and who's waiting."
          checked={draft.showQueue}
          disabled={busy}
          onChange={(v) => set("showQueue", v)}
        />
      </SettingsCard>

      <SettingsCard
        title="Queue ticket details"
        description="What shows next to each customer's name. A detail is skipped for any ticket that doesn't have it."
        footer={footer("queue", DISPLAY_QUEUE_KEYS)}
      >
        <ToggleRow
          title="Ticket number"
          description='e.g. Q014. Fills the first column (headed "Ticket"). When off, that column shows plain positions: 1, 2, 3…'
          checked={draft.showQueueTicketNumber}
          disabled={busy}
          onChange={(v) => set("showQueueTicketNumber", v)}
        />
        <ToggleRow
          title="Service"
          description="Turn this off if you don't use services, or don't want them shown here."
          checked={draft.showQueueService}
          disabled={busy}
          onChange={(v) => set("showQueueService", v)}
        />
        <ToggleRow
          title="Cellphone number"
          description="Always shown masked (e.g. 071 *** **34). The raw number is never sent to the TV. Off by default because this screen is public."
          checked={draft.showQueuePhone}
          disabled={busy}
          onChange={(v) => set("showQueuePhone", v)}
        />
        <ToggleRow
          title="Estimated wait time"
          description="How much longer each waiting customer is likely to wait."
          checked={draft.showQueueWaitEstimate}
          disabled={busy}
          onChange={(v) => set("showQueueWaitEstimate", v)}
        />
        <ToggleRow
          title="Time waited so far"
          description="How long each customer has already been in the queue."
          checked={draft.showQueueDuration}
          disabled={busy}
          onChange={(v) => set("showQueueDuration", v)}
        />
        <ToggleRow
          title="Booking reference"
          description="Only appears for tickets that came from a confirmed booking, not walk-ins."
          checked={draft.showQueueReference}
          disabled={busy}
          onChange={(v) => set("showQueueReference", v)}
        />
      </SettingsCard>

      {!isBoard && (
        <SettingsCard
          title="Timing"
          description="How long each screen stays up. Only applies to the rotating-slides layout."
          footer={footer("timing", DISPLAY_TIMING_KEYS)}
        >
          <FieldRow
            label="Welcome slide (seconds)"
            hint="How long your logo and name show when the screen first starts. It never repeats after that."
          >
            <input
              type="number"
              min={2}
              max={30}
              className={inputClass}
              value={draft.welcomeSeconds}
              onChange={(e) => set("welcomeSeconds", Number(e.target.value))}
            />
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow label="Menu & bookings (seconds)" hint="How long each of these screens shows before moving on.">
              <input
                type="number"
                min={3}
                max={120}
                className={inputClass}
                value={draft.menuBookingsSeconds}
                onChange={(e) => set("menuBookingsSeconds", Number(e.target.value))}
              />
            </FieldRow>
            <FieldRow label="Live queue (seconds)" hint="Usually longer, since there's more to read.">
              <input
                type="number"
                min={3}
                max={300}
                className={inputClass}
                value={draft.queueSeconds}
                onChange={(e) => set("queueSeconds", Number(e.target.value))}
              />
            </FieldRow>
          </div>
        </SettingsCard>
      )}

      <SettingsCard
        title="Wording"
        description="Every piece of text on the TV is yours to change. Leave a field empty to use the default shown in it."
        footer={footer("wording", DISPLAY_WORDING_KEYS)}
      >
        <SubSection title="Screen headings">
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("menuTitle", "Menu heading", DEFAULT_DISPLAY_MENU_TITLE, 60)}
            {textField("bookingsTitle", "Bookings heading", DEFAULT_DISPLAY_BOOKINGS_TITLE, 60)}
            {textField("queueTitle", "Queue heading", DEFAULT_DISPLAY_QUEUE_TITLE, 60)}
            {textField("nowServingLabel", '"Now serving" label', DEFAULT_DISPLAY_NOW_SERVING_LABEL, 40)}
          </div>
        </SubSection>

        {isBoard ? (
          <SubSection title="Live board" hint="Column heading, empty-column messages and ticket badges.">
            <div className="grid gap-4 sm:grid-cols-2">
              {textField("waitingLabel", '"Waiting" column heading', DEFAULT_DISPLAY_WAITING_LABEL, 40)}
              <div className="hidden sm:block" />
              {textField(
                "waitingEmptyText",
                "Waiting column — empty message",
                DEFAULT_DISPLAY_WAITING_EMPTY,
                100,
                "Shown when nobody is waiting.",
              )}
              {textField(
                "servingEmptyText",
                "Now serving column — empty message",
                DEFAULT_DISPLAY_SERVING_EMPTY,
                100,
                "Shown when nobody is being served.",
              )}
              {textField(
                "bookingsEmptyText",
                "Bookings column — empty message",
                DEFAULT_DISPLAY_BOOKINGS_EMPTY,
                100,
                "Shown when there are no upcoming bookings.",
              )}
              <div className="hidden sm:block" />
              {textField(
                "walkInBadgeLabel",
                "Walk-in ticket badge",
                DEFAULT_DISPLAY_WALKIN_BADGE,
                20,
                "Small label on tickets from customers who walked in.",
              )}
              {textField(
                "bookingBadgeLabel",
                "Booking ticket badge",
                DEFAULT_DISPLAY_BOOKING_BADGE,
                20,
                "Small label on tickets that came from a booking.",
              )}
            </div>
          </SubSection>
        ) : (
          <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
            More wording options (column heading, empty messages, ticket badges) appear here when you choose the Live
            board layout.
          </p>
        )}
      </SettingsCard>
    </div>
  )
}

// ---- Display URL + QR code -------------------------------------------------

function DisplayUrlPanel({ tenantSlug }: { tenantSlug: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const displayUrl = origin ? `${origin}/display/${tenantSlug}` : null

  async function copyUrl() {
    if (!displayUrl) return
    try {
      await navigator.clipboard.writeText(displayUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — the URL
      // is already selectable in the input, so this just skips the toast.
    }
  }

  return (
    <SettingsCard
      title="Screen address"
      description="Open this link in the TV's browser and leave the tab open. No login needed."
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input className={inputClass} readOnly value={displayUrl ?? "Loading…"} onFocus={(e) => e.target.select()} />
            <button type="button" className={secondaryButtonClass} onClick={copyUrl} disabled={!displayUrl}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          {displayUrl && (
            <a
              href={displayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm font-medium text-[#7A2E3A] hover:underline"
            >
              Open the screen ↗
            </a>
          )}
        </div>

        <div className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
          {displayUrl ? (
            // Third-party QR generator — this URL isn't sensitive.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(displayUrl)}`}
              alt="QR code linking to the display"
              width={160}
              height={160}
            />
          ) : (
            <div className="flex h-40 w-40 items-center justify-center text-xs text-stone-400">Loading…</div>
          )}
          <span className="text-xs text-stone-500">Scan to open on a phone or tablet</span>
        </div>
      </div>
    </SettingsCard>
  )
}


