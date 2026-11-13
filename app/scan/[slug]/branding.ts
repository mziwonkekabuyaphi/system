// app/scan/[slug]/branding.ts
//
// Turns a tenant's two brand colours (tenant_branding.primary_color / secondary_color) into the
// CSS variables scanner.css expects. Pure functions, safe to run on the server or in the browser.
//
//   primary   -> the header band
//   secondary -> the accent: scan button, progress bar, highlights (falls back to primary)
//
// Whatever colours a tenant picks, text must stay readable on them, so each colour also gets
// a computed "on" colour (white or near-black) and a darker / lighter variant where needed.

type RGB = [number, number, number]

const HEX = /^#[0-9a-f]{6}$/i

export const DEFAULT_PRIMARY = "#1e293b"
export const DEFAULT_ACCENT = "#2563eb"

const toRgb = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

const toHex = ([r, g, b]: RGB): string =>
  "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")

/** t = 0 returns a, t = 1 returns b. */
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [255, 255, 255]
const INK: RGB = [15, 23, 42]

/** WCAG relative luminance. */
function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const contrast = (a: RGB, b: RGB): number => {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** White text unless it would be hard to read on this colour, then near-black. */
function textOn(bg: RGB): { on: string; soft: string; dim: string } {
  if (contrast(bg, WHITE) >= 3) {
    return { on: "#ffffff", soft: "rgba(255,255,255,0.2)", dim: "rgba(255,255,255,0.8)" }
  }
  return { on: "#0f172a", soft: "rgba(15,23,42,0.14)", dim: "rgba(15,23,42,0.75)" }
}

/** Darken until the colour reads as text on white (4.5:1). */
function readableOnWhite(c: RGB): RGB {
  let out = c
  for (let i = 0; i < 24 && contrast(out, WHITE) < 4.5; i += 1) out = mix(out, BLACK, 0.1)
  return out
}

/** Lighten until the colour shows up on a black camera view. */
function visibleOnBlack(c: RGB): RGB {
  let out = c
  for (let i = 0; i < 24 && luminance(out) < 0.22; i += 1) out = mix(out, WHITE, 0.12)
  return out
}

const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`

export function cleanHex(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toLowerCase() : fallback
}

export function buildBrandVars(primary: string | null | undefined, secondary: string | null | undefined): Record<string, string> {
  const hasPrimary = typeof primary === "string" && HEX.test(primary.trim())
  const hasSecondary = typeof secondary === "string" && HEX.test(secondary.trim())

  // Nothing set: neutral slate header with a blue accent. Only primary set: it does both jobs.
  const brandHex = cleanHex(primary, DEFAULT_PRIMARY)
  const accentHex = hasSecondary ? cleanHex(secondary, DEFAULT_ACCENT) : hasPrimary ? brandHex : DEFAULT_ACCENT

  const brand = toRgb(brandHex)
  const accent = toRgb(accentHex)
  const onBrand = textOn(brand)
  const onAccent = textOn(accent)

  return {
    "--brand": brandHex,
    "--brand-dark": toHex(mix(brand, BLACK, 0.4)),
    "--brand-on": onBrand.on,
    "--brand-on-soft": onBrand.soft,
    "--brand-on-dim": onBrand.dim,
    "--accent": accentHex,
    "--accent-dark": toHex(mix(accent, BLACK, 0.3)),
    "--accent-text": toHex(readableOnWhite(accent)),
    "--accent-vivid": toHex(visibleOnBlack(accent)),
    "--accent-on": onAccent.on,
    "--accent-on-soft": onAccent.soft,
    "--accent-on-dim": onAccent.dim,
    "--accent-glow": rgba(accent, 0.18),
    "--accent-subtle": rgba(accent, 0.07),
    "--accent-mid": rgba(accent, 0.12),
    "--shadow-accent": `0 8px 24px ${rgba(accent, 0.25)}`,
  }
}

/** The colour the browser's address bar / status bar should take on phones. */
export function themeColor(primary: string | null | undefined): string {
  return cleanHex(primary, DEFAULT_PRIMARY)
}

// Re-exported for the contrast check in tests / scripts.
export const _internals = { contrast, luminance, toRgb, INK }
