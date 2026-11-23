"use client"

// app/admin/voice-notes/VoiceNotesToggle.tsx — the card itself. Switches instantly and puts it back if saving fails.
// Built from the same Settings pieces as the rest of Settings (SettingsCard, SubSection, ToggleRow, FieldRow, inputClass in
// app/admin/settings/ui), so it looks like "AI configuration" and the other cards, in light and dark theme.
// Two separate choices: (1) understand voice notes (turn them into text), (2) keep the recordings so staff can replay them.
import { useState, useTransition } from "react"

import { FieldRow, SettingsCard, SubSection, ToggleRow, inputClass } from "@/app/admin/settings/ui"

import { setVoiceAudioSettings, setVoiceNotesEnabled } from "./actions"
import { RETENTION_OPTIONS } from "./retention"

export function VoiceNotesToggle({
  initialEnabled,
  initialStoreAudio,
  initialRetentionDays,
  keptCount,
  canManage,
  problem,
  costNote,
}: {
  initialEnabled: boolean
  initialStoreAudio: boolean
  initialRetentionDays: number
  /** Recordings kept right now (not yet deleted). */
  keptCount: number
  canManage: boolean
  /** Why voice notes won't work right now even if switched on (null = nothing in the way). */
  problem: string | null
  costNote: string | null
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [storeAudio, setStoreAudio] = useState(initialStoreAudio)
  const [retentionDays, setRetentionDays] = useState(initialRetentionDays)
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

  function saveAudio(nextStore: boolean, nextDays: number) {
    const previous = { storeAudio, retentionDays }
    setMessage(null)
    setStoreAudio(nextStore)
    setRetentionDays(nextDays)
    start(async () => {
      const res = await setVoiceAudioSettings(nextStore, nextDays)
      if (!res.ok) {
        setStoreAudio(previous.storeAudio)
        setRetentionDays(previous.retentionDays)
        setMessage({ ok: false, text: res.error })
        return
      }
      setMessage({
        ok: true,
        text: nextStore ? `Recordings will be kept for ${nextDays} days.` : "Recordings switched off. Kept ones are being deleted.",
      })
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

      {enabled && (
        <SubSection
          title="Recordings"
          hint="A voice recording is personal information under POPIA. Keep it for as short a time as you can, and mention it in your privacy notice. Shortening the period, or switching this off, also deletes recordings that no longer qualify (within about 15 minutes)."
        >
          <ToggleRow
            title="Keep recordings so staff can replay them"
            description="Off by default. When on, the audio is stored privately and staff can play it in the inbox, even if the bot couldn't make it out. Customers are told their voice notes are kept."
            checked={storeAudio}
            onChange={(next) => saveAudio(next, retentionDays)}
            disabled={!canManage || pending}
          />

          {storeAudio && (
            <FieldRow label="Delete recordings after">
              <select
                className={`${inputClass} sm:max-w-[12rem]`}
                value={retentionDays}
                disabled={!canManage || pending}
                onChange={(event) => saveAudio(true, Number(event.target.value))}
              >
                {RETENTION_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </select>
            </FieldRow>
          )}

          {keptCount > 0 && (
            <p className="text-xs text-ink-muted">
              {keptCount} recording{keptCount === 1 ? " is" : "s are"} being kept right now.
            </p>
          )}
        </SubSection>
      )}

      {!canManage && <p className="text-xs text-ink-muted">Only an owner or manager can change this.</p>}
      {message && <p className={`text-sm ${message.ok ? "text-success" : "text-red-700"}`}>{message.text}</p>}
    </SettingsCard>
  )
}
