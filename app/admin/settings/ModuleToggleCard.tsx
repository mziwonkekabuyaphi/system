// app/admin/settings/ModuleToggleCard.tsx
"use client"

import { useEffect, useState, useTransition } from "react"

import { getModuleSwitch, setModuleSwitch } from "../settings-actions"
import { SettingsCard, Toggle } from "./ui"

/**
 * On/off card for the Public display and Staff clock-in tabs -- same look as
 * the "Kiosk module" card. It loads its own current state from the server, so
 * no parent file needs to pass anything in.
 */
export function ModuleToggleCard({
  which,
  title,
  description,
  offNotice,
}: {
  which: "display" | "clock"
  title: string
  description: string
  offNotice: string
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null) // null = still loading
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getModuleSwitch(which).then((result) => {
      if (cancelled) return
      if (result.success) setEnabled(result.enabled)
      else {
        setEnabled(true)
        setError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [which])

  function handleToggle(next: boolean) {
    const previous = enabled
    setEnabled(next)
    setError(null)
    startTransition(async () => {
      const result = await setModuleSwitch(which, next)
      if (!result.success) {
        setEnabled(previous)
        setError(result.error)
      }
    })
  }

  return (
    <SettingsCard title={title} description={description}>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
        <div>
          <p className="text-sm font-medium text-ink">
            {enabled === null ? "Checking…" : enabled ? "Switched on" : "Switched off"}
          </p>
          <p className="text-xs text-ink-muted">Turn this on or off for this location.</p>
        </div>
        {enabled === null ? (
          <span className="text-xs text-ink-muted">Loading…</span>
        ) : (
          <Toggle checked={enabled} disabled={isPending} onChange={handleToggle} />
        )}
      </div>
      {error && <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      {enabled === false && (
        <p className="rounded-lg border border-warn-line bg-warn-soft-2 px-3 py-2 text-sm text-warn-strong">
          {offNotice}
        </p>
      )}
    </SettingsCard>
  )
}
