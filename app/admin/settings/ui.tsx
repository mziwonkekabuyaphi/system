"use client"

import { useState } from "react"

export const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

// ---------------------------------------------------------------------------
// Shared styling
//
// CONTRAST FIX: inputs previously had no explicit background, so a white
// <input> sitting inside a white .bg-white card was basically invisible
// except for a thin border — and once a Save/upload button hit
// disabled:opacity-50 on a white background, it faded to almost nothing.
// Every field/button below now has a resting background distinct from the
// white cards, and disabled states use explicit muted colors instead of
// opacity, so "off"/disabled never means "blends into the page."
// ---------------------------------------------------------------------------
export const inputClass =
  "w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-900 " +
  "placeholder:text-stone-400 focus:border-[#7A2E3A] focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#7A2E3A] " +
  "disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"

export const secondaryButtonClass =
  "rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 " +
  "hover:bg-stone-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400 disabled:hover:bg-stone-100"

export const primaryButtonClass =
  "rounded-full bg-[#7A2E3A] px-4 py-2 text-sm font-medium text-white hover:bg-[#651F2A] " +
  "disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"



// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Layout primitives -- every settings page is built from these so they all
// look and behave the same: a page header, then cards. One card = one topic.
// ---------------------------------------------------------------------------

export function SettingsPageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="border-b border-stone-200 pb-4">
      <h2 className="font-[family-name:var(--font-admin-serif)] text-2xl tracking-tight text-stone-900">{title}</h2>
      <p className="mt-1 text-sm text-stone-500">{description}</p>
    </header>
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
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <header className="mb-4">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-stone-500">{description}</p>}
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
    <div className="space-y-3 border-t border-stone-100 pt-4 first:border-t-0 first:pt-0">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500">{title}</h4>
        {hint && <p className="mt-1 text-xs text-stone-400">{hint}</p>}
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
    <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 p-3">
      <div>
        <p className="text-sm font-medium text-stone-800">{title}</p>
        <p className="text-xs text-stone-500">{description}</p>
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
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
      <button type="button" onClick={onSave} disabled={!dirty || isPending} className={primaryButtonClass}>
        {isPending ? "Saving…" : "Save changes"}
      </button>
      {dirty && !isPending && (
        <button type="button" onClick={onDiscard} className={secondaryButtonClass}>
          Discard
        </button>
      )}
      {message ? (
        <span className={`text-sm ${message.ok ? "text-[#4B6B54]" : "text-red-700"}`}>{message.text}</span>
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
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-stone-400">{hint}</span>}
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
          className="h-10 w-10 shrink-0 rounded-lg border border-stone-300 bg-white p-0.5"
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
          placeholder="#7A2E3A"
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
    <div className="mt-4 flex items-center gap-3 border-t border-stone-100 pt-4">
      <button type="button" onClick={onSave} disabled={isPending} className={primaryButtonClass}>
        {isPending ? "Saving…" : "Save"}
      </button>
      {message && (
        <span className={`text-sm ${message.ok ? "text-[#4B6B54]" : "text-red-700"}`}>{message.text}</span>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 ring-inset ring-black/10 transition-colors disabled:cursor-not-allowed ${
        checked ? (disabled ? "bg-[#7A2E3A]/60" : "bg-[#7A2E3A]") : disabled ? "bg-stone-200" : "bg-stone-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  )
}
