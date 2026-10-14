// app/admin/settings/ClockPanels.tsx
"use client"

import { useEffect, useState } from "react"

import { updateClockSettings } from "../settings-actions"
import type { AdminClockSettings } from "../types"
import {
  CardSaveRow,
  ColorField,
  FieldRow,
  HEX_COLOR_PATTERN,
  SettingsCard,
  SubSection,
  inputClass,
  secondaryButtonClass,
  useCardForm,
} from "./ui"
import { ModuleToggleCard } from "./ModuleToggleCard"

// ---------------------------------------------------------------------------
// Staff clock-in — look and wording for the PIN pad at /clock/[slug].
// Writes to tenant_branding's clock_* columns via updateClockSettings; the
// pad itself is components/clock/ClockApp.tsx. Branding (name, logo, brand
// colour) is still edited only in Private Label, same as Kiosk and Display.
// ---------------------------------------------------------------------------
const DEFAULT_TITLE = "Clock in"
const DEFAULT_PROMPT = "Enter your PIN to clock in or out"
const DEFAULT_CLOCKED_IN = "Clocked in"
const DEFAULT_CLOCKED_OUT = "Clocked out"
const DEFAULT_INVALID_PIN = "PIN not recognized. Please try again."

const THEME_OPTIONS: Array<{
  value: AdminClockSettings["theme"]
  title: string
  description: string
  swatch: string
}> = [
  { value: "dark", title: "Dark", description: "Near-black with light text. Easy on the eyes on a shared tablet.", swatch: "#15110D" },
  { value: "light", title: "Light", description: "Off-white with dark text. Suits bright spaces.", swatch: "#FAF8F5" },
  { value: "custom", title: "Custom color", description: "Pick your own background. Text color adjusts automatically.", swatch: "" },
]

type ClockDraft = {
  theme: AdminClockSettings["theme"]
  backgroundColor: string
  tagline: string
  title: string
  prompt: string
  clockedInLabel: string
  clockedOutLabel: string
  invalidPinText: string
}

// DB column only accepts #RRGGBB, but the shared ColorField also allows #RGB.
function toSixDigitHex(value: string): string | null {
  if (!HEX_COLOR_PATTERN.test(value)) return null
  const clean = value.slice(1)
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean
  return `#${full.toUpperCase()}`
}

function toDraft(s: AdminClockSettings): ClockDraft {
  return {
    theme: s.theme,
    backgroundColor: s.backgroundColor ?? "#15110D",
    tagline: s.tagline ?? "",
    title: s.title ?? "",
    prompt: s.prompt ?? "",
    clockedInLabel: s.clockedInLabel ?? "",
    clockedOutLabel: s.clockedOutLabel ?? "",
    invalidPinText: s.invalidPinText ?? "",
  }
}

function toPayload(d: ClockDraft): AdminClockSettings {
  return {
    theme: d.theme,
    backgroundColor: toSixDigitHex(d.backgroundColor),
    tagline: d.tagline.trim() || null,
    title: d.title.trim() || null,
    prompt: d.prompt.trim() || null,
    clockedInLabel: d.clockedInLabel.trim() || null,
    clockedOutLabel: d.clockedOutLabel.trim() || null,
    invalidPinText: d.invalidPinText.trim() || null,
  }
}

const LOOK_KEYS: Array<keyof ClockDraft> = ["theme", "backgroundColor", "tagline"]
const WORDING_KEYS: Array<keyof ClockDraft> = ["title", "prompt", "clockedInLabel", "clockedOutLabel", "invalidPinText"]

// ---- Clock-in URL + QR code (same pattern as the Kiosk and Display tabs) ----

function ClockUrlPanel({ tenantSlug }: { tenantSlug: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const clockUrl = origin ? `${origin}/clock/${tenantSlug}` : null

  async function copyUrl() {
    if (!clockUrl) return
    try {
      await navigator.clipboard.writeText(clockUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — the URL
      // is already selectable in the input, so this just skips the toast.
    }
  }

  return (
    <SettingsCard
      title="Clock-in address"
      description="Open this link on the shared tablet at your shop. Staff enter their PIN to clock in or out. No login needed."
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input className={inputClass} readOnly value={clockUrl ?? "Loading…"} onFocus={(e) => e.target.select()} />
            <button type="button" className={secondaryButtonClass} onClick={copyUrl} disabled={!clockUrl}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          {clockUrl && (
            <a
              href={clockUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm font-medium text-[#7A2E3A] hover:underline"
            >
              Open the clock-in pad ↗
            </a>
          )}
        </div>

        <div className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
          {clockUrl ? (
            // Third-party QR generator — this URL isn't sensitive (PIN-gated on the page itself).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(clockUrl)}`}
              alt="QR code linking to the staff clock-in page"
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

export function ClockPanel({
  tenantSlug,
  initial,
  canCustomizeBranding,
}: {
  tenantSlug: string
  initial: AdminClockSettings
  canCustomizeBranding: boolean
}) {
  const form = useCardForm<ClockDraft>({
    initial: toDraft(initial),
    persist: (full) => updateClockSettings(toPayload(full)),
  })
  const { draft, set } = form
  const busy = form.savingCard !== null
  const [colorResetKey, setColorResetKey] = useState(0)

  function footer(cardId: string, keys: Array<keyof ClockDraft>, onDiscard?: () => void) {
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

  function textField(key: keyof ClockDraft, label: string, placeholder: string, maxLength: number, hint?: string) {
    return (
      <FieldRow label={label} hint={hint ?? `Defaults to "${placeholder}".`}>
        <input
          className={inputClass}
          value={draft[key] as string}
          onChange={(e) => set(key, e.target.value as ClockDraft[typeof key])}
          placeholder={placeholder}
          maxLength={maxLength}
        />
      </FieldRow>
    )
  }

  return (
    <div className="space-y-4">
      <ModuleToggleCard
        which="clock"
        title="Staff clock-in module"
        description="Enable the staff clock-in pad for this location."
        offNotice="Clock-in is off — staff won't be able to clock in or out at the address below. Everything else on this tab still saves, so you can set it up before switching it on."
      />

      <ClockUrlPanel tenantSlug={tenantSlug} />

      <SettingsCard
        title="Look"
        description="What the clock-in pad looks like on your shared tablet."
        footer={footer("look", LOOK_KEYS, () => setColorResetKey((k) => k + 1))}
      >
        <SubSection
          title="Colour theme"
          hint="Text colour is chosen for you so it stays readable on any background. Your brand colour (set under Branding) is used for the PIN dots and Enter button, and is nudged lighter or darker if it'd be hard to read."
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((option) => {
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
          <FieldRow label="Tagline under your name" hint="Leave empty for none.">
            <input
              className={inputClass}
              value={draft.tagline}
              onChange={(e) => set("tagline", e.target.value)}
              placeholder="e.g. Have a great shift"
              maxLength={80}
            />
          </FieldRow>
        </SubSection>
      </SettingsCard>

      <SettingsCard
        title="Local terms"
        description="Rename what staff see on the pad. Leave a field empty to use the default."
        footer={footer("wording", WORDING_KEYS)}
      >
        {textField("title", "Heading", DEFAULT_TITLE, 60)}
        {textField("prompt", "PIN prompt", DEFAULT_PROMPT, 80)}
        {textField("clockedInLabel", "Clock-in confirmation", DEFAULT_CLOCKED_IN, 40, `Shown above the staff member's name. Defaults to "${DEFAULT_CLOCKED_IN}".`)}
        {textField("clockedOutLabel", "Clock-out confirmation", DEFAULT_CLOCKED_OUT, 40, `Defaults to "${DEFAULT_CLOCKED_OUT}".`)}
        {textField("invalidPinText", "Wrong PIN message", DEFAULT_INVALID_PIN, 100)}
      </SettingsCard>
    </div>
  )
}
