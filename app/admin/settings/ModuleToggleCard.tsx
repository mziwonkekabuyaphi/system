// app/admin/settings/ModuleToggleCard.tsx
"use client"

import { useEffect, useState, useTransition } from "react"

import { getModuleSwitch, setModuleSwitch } from "../settings-actions"
import { Toggle } from "./ui"

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
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">{title}</p>
          <p className="text-sm text-stone-500">{description}</p>
        </div>
        {enabled === null ? (
          <span className="text-xs text-stone-400">Loading…</span>
        ) : (
          <Toggle checked={enabled} disabled={isPending} onChange={handleToggle} />
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {enabled === false && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {offNotice}
        </p>
      )}
    </div>
  )
}
