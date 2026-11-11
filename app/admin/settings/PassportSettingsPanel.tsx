// app/admin/settings/PassportSettingsPanel.tsx
"use client"

import { useEffect, useState, useTransition } from "react"

import { getPassportSettings, updatePassportSettings } from "../passport/actions"
import type { PassportSettings } from "../passport/passport-types"
import { SettingsCard, inputClass, primaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// Settings > Customer Journey > Passport settings. Top-up limits, an optional balance ceiling and
// whether customers may top up online themselves. Loads its own values; saving needs wallet.manage,
// which the server action checks again.
// ---------------------------------------------------------------------------

export function PassportSettingsPanel({ canManage }: { canManage: boolean }) {
  const [settings, setSettings] = useState<PassportSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await getPassportSettings()
      if (cancelled) return
      if (result.ok) setSettings(result.settings)
      else setLoadError(result.error)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) return <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">{loadError}</p>
  if (!settings) return <p className="text-sm text-ink-muted">Loading…</p>
  return <PassportSettingsForm initial={settings} canManage={canManage} />
}

function PassportSettingsForm({ initial, canManage }: { initial: PassportSettings; canManage: boolean }) {
  const [minTopup, setMinTopup] = useState(String(initial.minTopup))
  const [maxTopup, setMaxTopup] = useState(String(initial.maxTopup))
  const [maxBalance, setMaxBalance] = useState(initial.maxBalance === null ? "" : String(initial.maxBalance))
  const [allowCustomerTopup, setAllowCustomerTopup] = useState(initial.allowCustomerTopup)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [isPending, startTransition] = useTransition()

  const min = Number(minTopup.replace(",", "."))
  const max = Number(maxTopup.replace(",", "."))
  const ceiling = maxBalance.trim() === "" ? null : Number(maxBalance.replace(",", "."))
  const valid =
    Number.isFinite(min) &&
    min >= 1 &&
    Number.isFinite(max) &&
    max >= min &&
    (ceiling === null || (Number.isFinite(ceiling) && ceiling >= max))

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updatePassportSettings({ minTopup: min, maxTopup: max, maxBalance: ceiling, allowCustomerTopup })
      setMessage(result.ok ? { text: "Saved.", ok: true } : { text: result.error, ok: false })
    })
  }

  return (
    <SettingsCard
      title="Top-ups and limits"
      description={`Amounts are in ${initial.currency}. Changes apply to new top-ups; money already in a Passport is not affected.`}
    >
      <div className="max-w-md space-y-4">
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">Smallest top-up</span>
          <input value={minTopup} onChange={(e) => setMinTopup(e.target.value)} inputMode="decimal" disabled={!canManage} className={inputClass} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">Largest top-up</span>
          <input value={maxTopup} onChange={(e) => setMaxTopup(e.target.value)} inputMode="decimal" disabled={!canManage} className={inputClass} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">Most a customer can hold at once (leave blank for no limit)</span>
          <input value={maxBalance} onChange={(e) => setMaxBalance(e.target.value)} inputMode="decimal" placeholder="No limit" disabled={!canManage} className={inputClass} />
        </label>
        <div className="space-y-1 border-t border-line pt-4">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={allowCustomerTopup} onChange={(e) => setAllowCustomerTopup(e.target.checked)} disabled={!canManage} />
            Let customers top up their own Passport online
          </label>
          <p className="text-xs text-ink-muted">Counter top-ups taken by your staff are always allowed.</p>
        </div>
        {!valid && canManage && (
          <p className="text-xs text-accent">
            The smallest top-up must be at least 1, the largest can't be below it, and the balance limit can't be below the largest top-up.
          </p>
        )}
        {canManage ? (
          <div className="flex items-center gap-3">
            <button type="button" className={primaryButtonClass} disabled={isPending || !valid} onClick={save}>
              {isPending ? "Saving…" : "Save"}
            </button>
            {message && <span className={`text-sm ${message.ok ? "text-success" : "text-accent"}`}>{message.text}</span>}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">Only the owner can change these.</p>
        )}
      </div>
    </SettingsCard>
  )
}
