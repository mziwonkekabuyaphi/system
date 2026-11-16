"use client"

// app/admin/voice-notes/VoiceNotesToggle.tsx — the card itself. Switches instantly and puts it back if saving fails.
import { useState, useTransition } from "react"

import { cardCls, cx, ToggleRow, useNotice } from "@/app/admin/orders/ui"

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
  const { show, node } = useNotice()

  function change(next: boolean) {
    setEnabled(next)
    start(async () => {
      const res = await setVoiceNotesEnabled(next)
      if (!res.ok) {
        setEnabled(!next)
        show(res.error, true)
        return
      }
      show(next ? "Voice notes switched on." : "Voice notes switched off.")
    })
  }

  return (
    <section className={cx(cardCls, "space-y-3 p-5")}>
      <div>
        <h2 className="text-base font-medium text-admin-text">Voice notes</h2>
        <p className="text-xs text-admin-text/60">
          Customers can send a voice note on WhatsApp. It is turned into text and answered like a typed message. The bot always repeats what it heard, and never
          confirms a payment or a cancellation by voice.
        </p>
      </div>

      <ToggleRow
        label="Understand voice notes"
        hint={costNote ?? undefined}
        checked={enabled}
        onChange={change}
        disabled={!canManage || pending}
      />

      {enabled && problem && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-admin-text">
          Switched on, but it won&apos;t work yet: {problem}
        </p>
      )}
      {!canManage && <p className="text-xs text-admin-text/50">Only an owner or manager can change this.</p>}
      {node}
    </section>
  )
}
