// app/display/[slug]/displayTheme.ts
/**
 * Color + contrast helpers shared by both Display layouts (rotating slides
 * in DisplayScreen.tsx, live board in BoardScreen.tsx). Text color is never
 * admin-picked: it's derived from the chosen background by contrast, and
 * brand accents are nudged toward the text color until they stay readable.
 */

import type { DisplayTheme } from "./actions"

export const DEFAULT_ACCENT = "#E2B33C"
export const DEFAULT_SECONDARY = "#3E7C74"

export const DARK_BG_SOLID = "#15110d"
const DARK_BG = "radial-gradient(120% 100% at 50% -10%, #221a12 0%, #15110d 55%, #100c09 100%)"
const LIGHT_BG_SOLID = "#FAF8F5"
const LIGHT_BG = "radial-gradient(120% 100% at 50% -10%, #FFFFFF 0%, #FAF8F5 55%, #F1EDE6 100%)"
const INK = "#171412"
const PAPER = "#F5F1E8"

export function toRgb(hex: string | null | undefined): [number, number, number] | null {
  const clean = (hex ?? "").replace("#", "")
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const int = Number.parseInt(full, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

export function toHex([r, g, b]: [number, number, number]): string {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

/** Plain rgba conversion instead of CSS color-mix() -- some smart TV
 *  browsers (older Tizen/webOS/Android TV WebView builds) don't support
 *  color-mix() yet, and this only needs to run once per render anyway. */
export function hexToRgba(hex: string, alpha: number): string {
  const rgb = toRgb(hex) ?? [226, 179, 60] // DEFAULT_ACCENT fallback
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const rgb = toRgb(hex) ?? [0, 0, 0]
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function mixHex(from: string, to: string, amount: number): string {
  const a = toRgb(from)
  const b = toRgb(to)
  if (!a || !b) return from
  return toHex([0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * amount)) as [number, number, number])
}

/** Moves `color` toward `target` (the readable text color) in small steps
 *  until it clears `min` contrast against `bg`. Colors that already pass
 *  are returned unchanged, so a good brand color is never altered. */
export function ensureContrast(color: string, bg: string, target: string, min: number): string {
  if (!toRgb(color)) return color
  let out = color
  for (let i = 1; i <= 10 && contrastRatio(out, bg) < min; i++) out = mixHex(color, target, i / 10)
  return out
}

export interface ThemeTokens {
  bgCss: string
  bgSolid: string
  fg: string
}

export function resolveThemeTokens(theme: DisplayTheme, custom: string | null): ThemeTokens {
  if (theme === "light") return { bgCss: LIGHT_BG, bgSolid: LIGHT_BG_SOLID, fg: INK }
  if (theme === "custom" && toRgb(custom)) {
    const bg = toHex(toRgb(custom) as [number, number, number])
    return { bgCss: bg, bgSolid: bg, fg: contrastRatio(bg, INK) >= contrastRatio(bg, PAPER) ? INK : PAPER }
  }
  return { bgCss: DARK_BG, bgSolid: DARK_BG_SOLID, fg: PAPER }
}

export function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min`
}

