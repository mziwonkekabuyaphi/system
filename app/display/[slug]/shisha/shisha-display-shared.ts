// app/display/[slug]/shisha/shisha-display-shared.ts
//
// Types and pure helpers used by both Shisha TV layouts (the "board" grid in
// ShishaDisplayScreen.tsx and the "lounge" in ShishaLoungeView.tsx).

import type { ShishaDisplayStatus } from "@/app/admin/shisha/shisha-types"
import type { ShishaDisplayDevice } from "./actions"

export type CardState = ShishaDisplayStatus | "available" | "maintenance"

/** Fixed status colours: they carry meaning at a glance, so the brand never recolours
 *  them (the Lounge layout does use the brand colours for the "running" state). */
export const STATUS_BASE: Record<CardState, string> = {
  active: "#3FA7D6",
  refill: "#D9A441",
  expired: "#E5533D",
  paused: "#9B7FC7",
  available: "#3E9B6E",
  maintenance: "#8A8375",
}

export interface CardView {
  device: ShishaDisplayDevice
  state: CardState
  /** Seconds left; negative once overdue. null when there is no session. */
  raw: number | null
  /** 0-100, how much of the coal ring is filled. */
  pct: number
}

export const URGENCY_RANK: Record<CardState, number> = {
  expired: 0,
  refill: 1,
  active: 2,
  paused: 3,
  available: 4,
  maintenance: 5,
}

const pad = (n: number) => String(n).padStart(2, "0")

export function formatTimer(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** "12:05" or, once overdue, "+02:10". */
export function timerText(raw: number | null): string | null {
  if (raw === null) return null
  return raw < 0 ? `+${formatTimer(-raw)}` : formatTimer(raw)
}

export function formatPrice(amount: number, currency: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2
  try {
    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount)
  } catch {
    return `${amount.toFixed(digits)} ${currency}`
  }
}
