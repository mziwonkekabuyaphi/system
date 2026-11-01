"use client"

import { BRAND_BG, BRAND_BORDER, BRAND_BTN_DISABLED, BRAND_FOCUS_BORDER, BRAND_FOCUS_RING, BRAND_FOCUS_VISIBLE_RING, BRAND_ON, BRAND_TEXT } from "@/components/admin/brand"

import { useState } from "react"

export const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

// ---------------------------------------------------------------------------
// Shared styling
//
// CONTRAST FIX: inputs previously had no explicit background, so a white
// <input> sitting inside a white .bg-card card was basically invisible
// except for a thin border — and once a Save/upload button hit
// disabled:opacity-50 on a white background, it faded to almost nothing.
// Every field/button below now has a resting background distinct from the
// white cards, and disabled states use explicit muted colors instead of
// opacity, so "off"/disabled never means "blends into the page."
// ---------------------------------------------------------------------------
export const inputClass =
  "w-full rounded-md border border-line-strong bg-canvas px-3 py-2 text-sm text-ink " +
  `placeholder:text-ink-muted ${BRAND_FOCUS_BORDER} focus:bg-card focus:outline-none focus:ring-1 ${BRAND_FOCUS_RING} ` +
  "[[data-admin-theme=dark]_&]:focus:border-accent [[data-admin-theme=dark]_&]:focus:ring-accent " +
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-tint disabled:text-ink-muted"

export const secondaryButtonClass =
  "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink transition-shadow " +
  "hover:bg-tint [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)] " +
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-tint disabled:text-ink-muted disabled:hover:bg-tint disabled:hover:shadow-none"

export const primaryButtonClass =
  `rounded-md ${BRAND_BG} px-4 py-2 text-sm font-medium ${BRAND_ON} transition-shadow hover:brightness-90 ` +
  "[[data-admin-theme=dark]_&]:bg-accent [[data-admin-theme=dark]_&]:text-on-color [[data-admin-theme=dark]_&]:shadow-[0_4px_16px_rgba(227,6,19,0.35)] " +
  `disabled:cursor-not-allowed ${BRAND_BTN_DISABLED} disabled:shadow-none disabled:hover:brightness-100`



// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Layout primitives -- every settings page is built from these so they all
// look and behave the same: a page header, then cards. One card = one topic.
// ---------------------------------------------------------------------------

export function SettingsPageHeader({
  title,
  description,
  icon,
}: {
  title: string
  description: string
  icon?: React.ReactNode
}) {
  return (
    <header className="border-b border-line pb-4">
      <h2 className="flex items-center gap-2 font-[family-name:var(--font-admin-serif)] text-xl text-ink">
        {icon && <span className="text-accent">{icon}</span>}
        {title}
      </h2>
      <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
    </header>
  )
}

/** A number or short value with a red left edge, like the stat tiles on Staff / Shisha / Queue. */
export function SettingsStatTile({
  label,
  value,
  hint,
  icon,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="relative rounded-lg border border-line border-l-[3px] border-l-accent bg-card px-4 py-3 shadow-sm">
      {icon && <span className="absolute right-3 top-3 text-ink-muted/60">{icon}</span>}
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <div className="mt-1 truncate font-[family-name:var(--font-admin-serif)] text-2xl tabular-nums text-ink">{value}</div>
      {hint && <p className="mt-0.5 truncate text-xs text-ink-muted">{hint}</p>}
    </div>
  )
}

export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-line bg-card p-4 shadow-sm sm:p-5">
      <header className="mb-4">
        <h3 className="flex items-center gap-2 font-[family-name:var(--font-admin-serif)] text-lg text-ink">
          <span className="h-4 w-[3px] rounded-full bg-accent" aria-hidden />
          {title}
        </h3>
        {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
      </header>
      <div className="space-y-4">{children}</div>
      {footer}
    </section>
  )
}

/** A labelled group inside a card. Deliberately heavier than a field label
 *  so the eye can tell "section" from "row". */
export function SubSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-soft">{title}</h4>
        {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="text-xs text-ink-muted">{description}</p>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

/** Save footer for a card that tracks its own unsaved changes. */
export function CardSaveRow({
  dirty,
  isPending,
  onSave,
  onDiscard,
  message,
}: {
  dirty: boolean
  isPending: boolean
  onSave: () => void
  onDiscard: () => void
  message: { ok: boolean; text: string } | null
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
      <button type="button" onClick={onSave} disabled={!dirty || isPending} className={primaryButtonClass}>
        {isPending ? "Saving…" : "Save changes"}
      </button>
      {dirty && !isPending && (
        <button type="button" onClick={onDiscard} className={secondaryButtonClass}>
          Discard
        </button>
      )}
      {message ? (
        <span className={`text-sm ${message.ok ? "text-success" : "text-red-700"}`}>{message.text}</span>
      ) : dirty ? (
        <span className="text-sm text-amber-700">Unsaved changes</span>
      ) : null}
    </div>
  )
}

/**
 * Draft/saved form state with per-card saving.
 *
 * The server actions take the WHOLE record, so a card can't just send its own
 * fields. Instead each card saves `{ ...lastSaved, ...thisCard'sDraftFields }`:
 * only that card's edits are written, and edits sitting unsaved in other cards
 * are left alone (and keep showing their own "Unsaved changes").
 */
export function useCardForm<T extends Record<string, unknown>>({
  initial,
  persist,
}: {
  initial: T
  persist: (full: T) => Promise<{ success: true } | { success: false; error: string }>
}) {
  const [saved, setSaved] = useState<T>(initial)
  const [draft, setDraft] = useState<T>(initial)
  const [savingCard, setSavingCard] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string } | null>>({})

  function set<K extends keyof T>(key: K, value: T[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    setMessages({})
  }

  function isDirty(keys: Array<keyof T>) {
    return keys.some((k) => draft[k] !== saved[k])
  }

  function discard(keys: Array<keyof T>) {
    setDraft((d) => {
      const next = { ...d }
      for (const k of keys) next[k] = saved[k]
      return next
    })
    setMessages({})
  }

  async function save(cardId: string, keys: Array<keyof T>) {
    const merged = { ...saved }
    for (const k of keys) merged[k] = draft[k]
    setSavingCard(cardId)
    setMessages((m) => ({ ...m, [cardId]: null }))
    const result = await persist(merged)
    setSavingCard(null)
    if (result.success) {
      setSaved(merged)
      setMessages((m) => ({ ...m, [cardId]: { ok: true, text: "Saved." } }))
    } else {
      setMessages((m) => ({ ...m, [cardId]: { ok: false, text: result.error } }))
    }
  }

  return { draft, set, isDirty, discard, save, savingCard, messages }
}

export function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-ink-muted">{hint}</span>}
      {children}
    </label>
  )
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const isValid = HEX_COLOR_PATTERN.test(draft)

  function commit(next: string) {
    setDraft(next)
    if (HEX_COLOR_PATTERN.test(next)) onChange(next)
  }

  return (
    <FieldRow label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-10 w-10 shrink-0 rounded-md border border-line-strong bg-card p-0.5"
          value={isValid ? draft : value}
          onChange={(e) => {
            setDraft(e.target.value)
            onChange(e.target.value)
          }}
        />
        <input
          type="text"
          className={`${inputClass} ${!isValid ? "border-red-300 bg-red-50" : ""}`}
          value={draft}
          onChange={(e) => commit(e.target.value)}
          placeholder="#1F2937"
        />
      </div>
    </FieldRow>
  )
}

export function SaveRow({
  isPending,
  onSave,
  message,
}: {
  isPending: boolean
  onSave: () => void
  message: { ok: boolean; text: string } | null
}) {
  return (
    <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
      <button type="button" onClick={onSave} disabled={isPending} className={primaryButtonClass}>
        {isPending ? "Saving…" : "Save"}
      </button>
      {message && (
        <span className={`text-sm ${message.ok ? "text-success" : "text-red-700"}`}>{message.text}</span>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  disabled,
  onChange,
  label,
  showState = true,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  label?: string
  showState?: boolean
}) {
  // VISIBILITY FIX: the OFF state used to be a pale grey with no border, which
  // vanished on a white card. OFF is now a solid mid-grey track with a darker
  // border, a white thumb with a ring + shadow, and a small "Off"/"On" word,
  // so it can always be seen -- including while disabled.
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
