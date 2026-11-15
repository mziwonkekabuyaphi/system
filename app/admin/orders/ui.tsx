"use client"

// app/admin/orders/ui.tsx
//
// Small shared pieces for the Orders screens. Colours come from the same
// admin-* / card tokens AdminView uses, so the cream and dark themes and the
// shop's own accent colour work without extra code. If a token name differs
// from what your other managers use, change it here once.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ")

export const inputCls =
  "w-full rounded-lg border border-admin-text/15 bg-card px-3 py-2 text-sm text-admin-text outline-none transition-colors placeholder:text-admin-text/40 focus:border-admin-accent focus:ring-2 focus:ring-admin-accent/25 disabled:cursor-not-allowed disabled:opacity-50"

const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/40"

export const btn = {
  primary: cx(btnBase, "bg-admin-accent text-admin-on-accent hover:opacity-90"),
  ghost: cx(btnBase, "border border-admin-text/15 bg-card text-admin-text hover:bg-admin-text/[0.05]"),
  danger: cx(btnBase, "border border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400"),
}

export const cardCls = "rounded-xl border border-admin-text/10 bg-card"

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-admin-text/70">{label}</span>
      {children}
      {hint && <span className="text-xs text-admin-text/50">{hint}</span>}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/40",
        checked ? "bg-admin-accent" : "bg-admin-text/20",
      )}
    >
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  )
}

export function ToggleRow({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (n: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm text-admin-text">{label}</p>
        {hint && <p className="text-xs text-admin-text/50">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  )
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info"
const TONES: Record<Tone, string> = {
  neutral: "bg-admin-text/10 text-admin-text/70",
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/15 text-red-700 dark:text-red-400",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
}

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", TONES[tone])}>{children}</span>
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" }) {
  return (
    <div className={cx(cardCls, "px-4 py-3")}>
      <p className={cx("text-2xl font-semibold tabular-nums", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-admin-text")}>{value}</p>
      <p className="mt-0.5 text-xs text-admin-text/60">{label}</p>
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-admin-text">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-sm text-admin-text/60">{children}</p>}
    </div>
  )
}

/** Right-hand panel. Sits above the sidebar (z-30). Esc or a click outside closes it. */
export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-xl flex-col bg-admin-body text-admin-text shadow-2xl">
        <header className="flex items-center justify-between border-b border-admin-text/10 px-5 py-4">
          <h2 className="text-lg font-medium">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-xl leading-none text-admin-text/60 hover:bg-admin-text/10">
            &times;
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-admin-text/10 px-5 py-4">{footer}</footer>}
      </aside>
    </div>
  )
}

/** One bottom-of-screen message at a time. Errors stay a bit longer than confirmations. */
export function useNotice() {
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((text: string, error = false) => {
    if (timer.current) clearTimeout(timer.current)
    setNotice({ text, error })
    timer.current = setTimeout(() => setNotice(null), error ? 6000 : 2500)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const node = notice ? (
    <div
      role={notice.error ? "alert" : "status"}
      className={cx(
        "fixed bottom-6 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm shadow-lg",
        notice.error ? "bg-red-600 text-white" : "bg-admin-text text-admin-body",
      )}
    >
      {notice.text}
    </div>
  ) : null
  return { show, node }
}

export function money(n: number, currency = "ZAR") {
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency, minimumFractionDigits: 2 }).format(n)
}

/** Re-renders on an interval so "5 min ago" stays true. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
