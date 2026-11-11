"use client"

// app/admin/events/ui.tsx
//
// Small shared pieces for the Events area. Styling follows the admin shell:
// Tailwind with the admin-* tokens, the tenant's accent via --sb-accent (falling
// back to the built-in accent), stone-* for neutrals, and Font Awesome icons
// (loaded in app/admin/layout.tsx, as the Rands dashboard uses them too).
// Subtle fills use stone-500 at low opacity so they read on both the cream and
// dark dashboard themes.

import { useEffect, type ReactNode } from "react"
import type { EventStatus } from "./types"
import { STATUS_LABEL } from "./format"

export const ACCENT_BG = "bg-[var(--sb-accent,var(--color-admin-accent))] text-[color:var(--sb-on-accent,var(--color-admin-on-accent))]"
export const ACCENT_TEXT = "text-[color:var(--sb-accent,var(--color-admin-accent))]"
export const ACCENT_RING = "ring-2 ring-[color:var(--sb-accent,var(--color-admin-accent))]"
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--sb-accent,var(--color-admin-accent))]"

export const PANEL = "rounded-2xl border border-stone-200 bg-card"
export const WELL = "rounded-xl border border-stone-200/70 bg-stone-500/[0.07]"

const BTN = `inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`
export const BTN_PRIMARY = `${BTN} ${ACCENT_BG} hover:opacity-90`
export const BTN_GHOST = `${BTN} border border-stone-200 text-stone-600 hover:bg-stone-500/10 hover:text-stone-900`
export const BTN_DANGER = `${BTN} bg-red-600 text-white hover:bg-red-700`
export const BTN_SUCCESS = `${BTN} bg-emerald-600 text-white hover:bg-emerald-700`

export const INPUT = `w-full rounded-xl border border-stone-200 bg-transparent px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 ${FOCUS}`
export const LABEL = "mb-1 block text-xs font-medium text-stone-500"

const STATUS_DOT: Record<EventStatus, string> = {
  active: "bg-emerald-500",
  draft: "bg-amber-400",
  ended: "bg-stone-400",
  cancelled: "bg-red-500",
}

/** Pill that sits on a banner image, so it carries its own dark backing. */
export function StatusPill({ status, soldOut }: { status: EventStatus; soldOut?: boolean }) {
  const label = status === "active" && soldOut ? "Sold out" : STATUS_LABEL[status]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1 text-[0.68rem] font-semibold text-white backdrop-blur">
      <span className={`h-1.5 w-1.5 rounded-full ${soldOut && status === "active" ? "bg-red-500" : STATUS_DOT[status]}`} />
      {label}
    </span>
  )
}

export function Chip({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "accent"; children: ReactNode }) {
  const tones = {
    neutral: "bg-stone-500/15 text-stone-600",
    good: "bg-emerald-500/15 text-emerald-600",
    warn: "bg-amber-500/15 text-amber-600",
    bad: "bg-red-500/15 text-red-600",
    accent: "bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_15%,transparent)] text-[color:var(--sb-accent,var(--color-admin-accent))]",
  }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[0.68rem] font-semibold ${tones[tone]}`}>{children}</span>
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2 overflow-hidden rounded-full bg-stone-500/15"
    >
      <div className={`h-full rounded-full bg-[var(--sb-accent,var(--color-admin-accent))] transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <i className={`fa-solid fa-${name} ${className}`} aria-hidden="true" />
}

export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-stone-300 px-6 py-12 text-center">
      <Icon name={icon} className="text-3xl text-stone-400" />
      <p className="font-medium text-stone-800">{title}</p>
      {children && <p className="max-w-sm text-sm text-stone-500">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: "md" | "lg"
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[90vh] w-full ${size === "lg" ? "max-w-2xl" : "max-w-md"} flex-col rounded-3xl border border-stone-200 bg-card shadow-2xl`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-6 py-4">
          <h2 className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={`rounded-full p-1.5 text-stone-500 hover:bg-stone-500/10 ${FOCUS}`}>
            <Icon name="xmark" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-stone-200 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

/** Fixed bottom-centre notice. role=status so assistive tech announces it. */
export function Notice({ notice }: { notice: { tone: "good" | "bad"; text: string } | null }) {
  if (!notice) return null
  return (
    <div
      role="status"
      className={`fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-xl ${
        notice.tone === "good" ? "bg-emerald-600" : "bg-red-600"
      }`}
    >
      {notice.text}
    </div>
  )
}
