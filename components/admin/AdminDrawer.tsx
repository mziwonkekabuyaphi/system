// components/admin/AdminDrawer.tsx
//
// Reusable right-hand overlay shell, same look and behaviour as
// shisha/ShishaDisplayDrawer.tsx: slides in from the right, dim backdrop,
// Escape / backdrop click / × closes, page behind doesn't scroll.
//
// It only provides the frame (header + scrolling body). The content decides
// how it saves. Children are unmounted when the drawer closes, so whatever you
// put inside loads fresh every time it opens.
"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

import { BRAND_BG, BRAND_FOCUS_BORDER, BRAND_ON, BRAND_SELECTED } from "./brand"

const WIDTHS = {
  md: "max-w-[460px]", // simple settings forms
  lg: "max-w-[620px]", // settings with a preview or option grids
  xl: "max-w-[1040px]", // tables (payroll)
} as const

export function AdminDrawer({
  open,
  onClose,
  title,
  subtitle,
  width = "md",
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  width?: keyof typeof WIDTHS
  /** Pinned bar under the scrolling body (Save / Discard). Omit for panels that save themselves. */
  footer?: ReactNode
  children: ReactNode
}) {
  // Mount first, slide in a frame later, so the transition actually plays.
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useRef(`admin-drawer-${Math.random().toString(36).slice(2, 8)}`).current

  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), 220)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // A confirm dialog inside the drawer can call preventDefault() on Escape
      // to say "I handled this", so the drawer doesn't close underneath it.
      if (e.key === "Escape" && !e.defaultPrevented) onClose()
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    panelRef.current?.focus()
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`absolute right-0 top-0 flex h-full w-full ${WIDTHS[width]} flex-col bg-panel shadow-2xl outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-tint"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && <div className="space-y-2 border-t border-line bg-card px-5 py-3">{footer}</div>}
      </aside>
    </div>
  )
}

// ---- shared building blocks (same look as ShishaDisplayDrawer) --------------

export const DRAWER_FIELD = `w-full rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink outline-none ${BRAND_FOCUS_BORDER} disabled:bg-tint`
export const DRAWER_BTN =
  "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50"
export const DRAWER_BTN_PRIMARY = `rounded-md ${BRAND_BG} ${BRAND_ON} px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`

export function DrawerTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string }>
  value: T
  onChange: (id: T) => void
  label: string
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={value === t.id ? DRAWER_BTN_PRIMARY : DRAWER_BTN}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function DrawerSwitch({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          checked ? BRAND_BG : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  )
}

export function DrawerField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-ink">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
    </label>
  )
}

export function DrawerGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export function DrawerOptionCard({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected ? `${BRAND_SELECTED} bg-card` : "border-line-strong bg-card hover:bg-tint"
      }`}
    >
      {children}
    </button>
  )
}
