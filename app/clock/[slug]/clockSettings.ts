// app/clock/[slug]/clockSettings.ts
/**
 * Clock-in pad customisation: types, defaults, and the resolver that turns
 * settings + brand color into CSS variables. Same rule as Display: text color
 * is never admin-picked, it's derived from the background by contrast, and the
 * brand accent is nudged until it's readable on that background.
 *
 * Reuses Display's helpers. If you'd rather not import across routes, move
 * displayTheme.ts to lib/theme/ and update both imports.
 */

import type { CSSProperties } from "react"
import {
  contrastRatio,
  ensureContrast,
  hexToRgba,
  resolveThemeTokens,
} from "@/app/display/[slug]/displayTheme"

export type ClockTheme = "dark" | "light" | "custom"

export interface ClockSettings {
  theme: ClockTheme
  /** #RRGGBB, only used when theme === "custom". */
  backgroundColor: string | null
  tagline: string | null
  title: string | null
  prompt: string | null
  clockedInLabel: string | null
  clockedOutLabel: string | null
  invalidPinText: string | null
}

export const DEFAULT_CLOCK_SETTINGS: ClockSettings = {
  theme: "dark",
  backgroundColor: null,
  tagline: null,
  title: null,
  prompt: null,
  clockedInLabel: null,
  clockedOutLabel: null,
  invalidPinText: null,
}

export interface ClockCopy {
  title: string
  prompt: string
  clockedIn: string
  clockedOut: string
  invalidPin: string
  tagline: string | null
}

export const CLOCK_COPY_DEFAULTS = {
  title: "Clock in",
  prompt: "Enter your PIN to clock in or out",
  clockedIn: "Clocked in",
  clockedOut: "Clocked out",
  invalidPin: "PIN not recognized. Please try again.",
}

export interface ClockLook {
  /** Spread onto the root element's style prop. */
  vars: CSSProperties
  bgSolid: string
  copy: ClockCopy
}

const INK = "#171412"
const PAPER = "#F5F1E8"
const DEFAULT_PRIMARY = "#2B6F5C"

const clean = (v: string | null | undefined) => v?.trim() || null

/** Row shape from tenant_branding (all clock_* columns). */
export function parseClockSettings(row: Record<string, unknown> | null | undefined): ClockSettings {
  if (!row) return DEFAULT_CLOCK_SETTINGS
  const theme = row.clock_theme
  return {
    theme: theme === "light" || theme === "custom" ? theme : "dark",
    backgroundColor: (row.clock_background_color as string | null) ?? null,
    tagline: (row.clock_tagline as string | null) ?? null,
    title: (row.clock_title as string | null) ?? null,
    prompt: (row.clock_prompt as string | null) ?? null,
    clockedInLabel: (row.clock_clocked_in_label as string | null) ?? null,
    clockedOutLabel: (row.clock_clocked_out_label as string | null) ?? null,
    invalidPinText: (row.clock_invalid_pin_text as string | null) ?? null,
  }
}

export function resolveClockLook(s: ClockSettings, primaryColor: string | null): ClockLook {
  const t = resolveThemeTokens(s.theme, s.backgroundColor)
  const accent = ensureContrast(primaryColor || DEFAULT_PRIMARY, t.bgSolid, t.fg, 3)
  // Text sitting ON an accent-filled button (e.g. the PIN pad's Enter key).
  const onAccent = contrastRatio(accent, INK) >= contrastRatio(accent, PAPER) ? INK : PAPER
  // Error text: a red nudged until it's readable on whatever background is chosen.
  const error = ensureContrast("#D9604C", t.bgSolid, t.fg, 3)

  return {
    bgSolid: t.bgSolid,
    vars: {
      "--clock-bg": t.bgCss,
      "--clock-fg": t.fg,
      "--clock-fg-70": hexToRgba(t.fg, 0.7),
      "--clock-fg-55": hexToRgba(t.fg, 0.55),
      "--clock-fg-28": hexToRgba(t.fg, 0.28),
      "--clock-accent": accent,
      "--clock-accent-soft": hexToRgba(accent, 0.22),
      "--clock-on-accent": onAccent,
      "--clock-surface": hexToRgba(t.fg, 0.07),
      "--clock-surface-active": hexToRgba(t.fg, 0.13),
      "--clock-line": hexToRgba(t.fg, 0.16),
      "--clock-error": error,
    } as CSSProperties,
    copy: {
      title: clean(s.title) ?? CLOCK_COPY_DEFAULTS.title,
      prompt: clean(s.prompt) ?? CLOCK_COPY_DEFAULTS.prompt,
      clockedIn: clean(s.clockedInLabel) ?? CLOCK_COPY_DEFAULTS.clockedIn,
      clockedOut: clean(s.clockedOutLabel) ?? CLOCK_COPY_DEFAULTS.clockedOut,
      invalidPin: clean(s.invalidPinText) ?? CLOCK_COPY_DEFAULTS.invalidPin,
      tagline: clean(s.tagline),
    },
  }
}
