// app/admin/sidebar-theme.ts
//
// Tenant-configurable colours for the admin dashboard sidebar
// (tenant_branding.admin_sidebar_color / admin_sidebar_text_color /
// admin_accent_color). Pure helpers, no server or React imports, so both
// AdminView.tsx and the Private Label panel can use them.
//
// All three are optional. When sidebarColor is null the sidebar keeps its
// built-in look (the admin-* Tailwind tokens) and nothing here is applied.

import type { CSSProperties } from "react"

export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

export interface SidebarColors {
  sidebarColor: string | null
  sidebarTextColor: string | null
  accentColor: string | null
}

function parse(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** White or near-black, whichever reads better on `hex`. */
export function readableTextOn(hex: string): string {
  return contrast(hex, "#FFFFFF") >= contrast(hex, "#1C1917") ? "#FFFFFF" : "#1C1917"
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parse(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const isHex = (v: string | null | undefined): v is string => !!v && HEX_COLOR_RE.test(v)

/** CSS variables for the sidebar, or null when the tenant hasn't customised it
 *  (or the stored value isn't a valid hex). Missing text/accent are derived from
 *  the background so a half-set theme is still readable. */
export function sidebarStyleVars(colors: SidebarColors | null | undefined): CSSProperties | null {
  if (!colors || !isHex(colors.sidebarColor)) return null
  const bg = colors.sidebarColor
  const text = isHex(colors.sidebarTextColor) ? colors.sidebarTextColor : readableTextOn(bg)
  const accent = isHex(colors.accentColor) ? colors.accentColor : text
  return {
    "--sb-bg": bg,
    "--sb-text": text,
    "--sb-text-muted": rgba(text, 0.6),
    "--sb-line": rgba(text, 0.12),
    "--sb-hover": rgba(text, 0.08),
    "--sb-accent": accent,
    "--sb-on-accent": readableTextOn(accent),
  } as CSSProperties
}
