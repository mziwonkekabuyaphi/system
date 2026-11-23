"use client"

// app/admin/voice-notes/VoiceNotesToggle.tsx — the card itself. Switches instantly and puts it back if saving fails.
// Built from the same Settings pieces as the rest of Settings (SettingsCard + ToggleRow in app/admin/settings/ui),
// so it looks like "AI configuration" and the other cards.
import { useState, useTransition } from "react"

import { SettingsCard, ToggleRow } from "@/app/admin/settings/ui"

import { setVoiceNotesEnabled } from "./actions"

export function VoiceNotesToggle({
  initialEnabled,
  canManage,
  problem,
  costNote,
}: {
  initialEnabled: boolean
  canManage: boolean
  /** Why voice notes won't work right now even if switched on (null = nothing in the way). */
  problem: string | null
  costNote: string | null
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function change(next: boolean) {
    setMessage(null)
    setEnabled(next)
    start(async () => {
      const res = await setVoiceNotesEnabled(next)
      if (!res.ok) {
        setEnabled(!next)
        setMessage({ ok: false, text: res.error })
        return
      }
      setMessage({ ok: true, text: next ? "Voice notes switched on." : "Voice notes switched off." })
    })
  }

  return (
    <SettingsCard
      title="Voice notes"
      description="Customers can send a voice note on WhatsApp. It is turned into text and answered like a typed message. The bot always repeats what it heard, and never confirms a payment or a cancellation by voice."
    >
      <ToggleRow
        title="Understand voice notes"
        description={costNote ?? "Each voice note is billed per minute of audio and counts towards your monthly AI budget."}
        checked={enabled}
        onChange={change}
        disabled={!canManage || pending}
      />

      {enabled && problem && (
        <p role="status" className="rounded-md border border-line-strong bg-tint p-3 text-sm text-ink">
          Switched on, but it won&apos;t work yet: {problem}
        </p>
      )}
      {!canManage && <p className="text-xs text-ink-muted">Only an owner or manager can change this.</p>}
      {message && <p className={`text-sm ${message.ok ? "text-success" : "text-red-700"}`}>{message.text}</p>}
    </SettingsCard>
  )
}
