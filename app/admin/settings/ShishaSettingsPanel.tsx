// app/admin/settings/ShishaSettingsPanel.tsx
"use client"

import { useEffect, useState, useTransition } from "react"

import { refreshShisha, updateShishaSettings } from "../shisha/actions"
import { readAutoPrintRequests, writeAutoPrintRequests } from "../shisha/shisha-autoprint"
import type { ShishaSettings } from "../shisha/shisha-types"
import { SettingsCard, inputClass, primaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// Settings > Customer Journey > Shisha settings. Session length, refill warning
// and whether a station is required. (These used to be the "Timing" tab on the
// Shisha page.) Loads its own values; saving needs shisha.manage, which the
// server action checks again.
// ---------------------------------------------------------------------------

export function ShishaSettingsPanel({ canManage }: { canManage: boolean }) {
  const [settings, setSettings] = useState<ShishaSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await refreshShisha()
      if (cancelled) return
      if (result.ok) setSettings(result.snapshot.settings)
      else setLoadError(result.error)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
  if (!settings) return <p className="text-sm text-stone-500">Loading…</p>
  return (
    <div className="space-y-6">
      <ShishaSettingsForm initial={settings} canManage={canManage} />
      <SlipPrintingCard />
    </div>
  )
}

// This PC only: stored in this browser, so it is not limited to managers and does not
// change anything for other devices. The Shisha page does the printing, so it must stay
// open on the PC with the receipt printer.
function SlipPrintingCard() {
  const [autoPrint, setAutoPrint] = useState(false)

  useEffect(() => {
    setAutoPrint(readAutoPrintRequests())
  }, [])

  function change(on: boolean) {
    setAutoPrint(on)
    writeAutoPrintRequests(on)
  }

  return (
    <SettingsCard
      title="Request slips (this PC)"
      description="A choice for this computer only. Other computers are not affected."
    >
      <div className="max-w-md space-y-1">
        <label className="flex items-center gap-2 text-sm text-stone-800">
          <input type="checkbox" checked={autoPrint} onChange={(e) => change(e.target.checked)} />
          Print a slip on this PC when a customer requests a session
        </label>
        <p className="text-xs text-stone-500">
          Turn this on only on the PC with the receipt printer, and keep the Shisha page open there. Requests that
          arrive while the page is closed are not printed.
        </p>
      </div>
    </SettingsCard>
  )
}

function ShishaSettingsForm({ initial, canManage }: { initial: ShishaSettings; canManage: boolean }) {
  const [duration, setDuration] = useState(String(initial.coalDurationMinutes))
  const [threshold, setThreshold] = useState(String(initial.refillThresholdMinutes))
  const [requireStation, setRequireStation] = useState(initial.requireStation)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [isPending, startTransition] = useTransition()

  const d = Number(duration)
  const t = Number(threshold)
  const valid = Number.isInteger(d) && d >= 5 && d <= 480 && Number.isInteger(t) && t >= 1 && t <= 120 && t < d

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateShishaSettings({ coalDurationMinutes: d, refillThresholdMinutes: t, requireStation })
      setMessage(result.ok ? { text: "Saved.", ok: true } : { text: result.error, ok: false })
    })
  }

  return (
    <SettingsCard
      title="Timing and stations"
      description="Applies to new sessions and refills. Sessions already running keep the time they have."
    >
      <div className="max-w-md space-y-4">
        <label className="block space-y-1 text-sm">
          <span className="text-stone-600">Session length (minutes)</span>
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
            disabled={!canManage}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-stone-600">Warn this many minutes before time runs out</span>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="numeric"
            disabled={!canManage}
            className={inputClass}
          />
        </label>
        <div className="space-y-1 border-t border-stone-200 pt-4">
          <label className="flex items-center gap-2 text-sm text-stone-800">
            <input
              type="checkbox"
              checked={requireStation}
              onChange={(e) => setRequireStation(e.target.checked)}
              disabled={!canManage}
            />
            Require a station for every session
          </label>
          <p className="text-xs text-stone-500">
            Link hookahs to a usual station in the Hookahs page to have it selected automatically.
          </p>
        </div>
        {!valid && canManage && (
          <p className="text-xs text-red-700">
            Session length is 5–480 minutes, the warning is 1–120 minutes and must be shorter than the session.
          </p>
        )}
        {canManage ? (
          <div className="flex items-center gap-3">
            <button type="button" className={primaryButtonClass} disabled={isPending || !valid} onClick={save}>
              {isPending ? "Saving…" : "Save"}
            </button>
            {message && <span className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</span>}
          </div>
        ) : (
          <p className="text-xs text-stone-500">Only a manager can change these.</p>
        )}
      </div>
    </SettingsCard>
  )
}
