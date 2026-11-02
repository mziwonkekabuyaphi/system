// components/admin/SettingsSwitch.tsx
//
// The on/off switch used in Settings (Kiosk, Display, Branding...): red track when
// on (a soft glow in the dark theme), solid grey when off, with a small "On"/"Off"
// word next to it. It is the same markup as `Toggle` in app/admin/settings/ui.tsx,
// kept here so the right-hand panels (Queue rules, Booking rules, Shifts, Shisha
// display, WhatsApp settings, the Inbox customer panel) can show the very same
// switch without importing from the Settings folder.
"use client"

import { BRAND_BG, BRAND_BORDER, BRAND_FOCUS_VISIBLE_RING, BRAND_TEXT } from "./brand"

export function SettingsSwitch({
  checked,
  disabled,
  onChange,
  label,
  showState = true,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  /** Accessible name (read out by screen readers). */
  label?: string
  /** Show the little "On" / "Off" word next to the switch. */
  showState?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex shrink-0 items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 ${BRAND_FOCUS_VISIBLE_RING} focus-visible:ring-offset-2 ${
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"
      }`}
    >
      <span
        className={`relative inline-block h-6 w-11 rounded-full border-2 transition-colors ${
          checked
            ? `${BRAND_BORDER} ${BRAND_BG} [[data-admin-theme=dark]_&]:border-accent [[data-admin-theme=dark]_&]:bg-accent [[data-admin-theme=dark]_&]:shadow-[0_0_10px_rgba(227,6,19,0.45)]`
            : "border-stone-400 bg-stone-300"
        }`}
      >
        <span
          className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-card shadow ring-1 ring-black/20 transition-all ${
            checked ? "left-[1.375rem]" : "left-0.5"
          }`}
        />
      </span>
      {showState && (
        <span className={`w-6 text-xs font-semibold ${checked ? `${BRAND_TEXT} [[data-admin-theme=dark]_&]:text-accent` : "text-stone-500"}`}>
          {checked ? "On" : "Off"}
        </span>
      )}
    </button>
  )
}
