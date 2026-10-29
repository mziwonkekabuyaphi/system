// app/admin/WhatsAppSettingsDrawer.tsx
//
// Right-hand overlay panel for everything WhatsApp, opened from the Inbox tab.
// Same pattern as the Shisha "TV display" drawer: it lives next to the thing it
// configures instead of on the Settings tab. Both tabs are the ORIGINAL panels,
// moved here unchanged:
//
//   Connection & templates -> WhatsAppTemplatesPanel (embeds the connection panel)
//   Messages               -> MessageSettingsPanel (AI default + message wording)
//
// Once opened, the panels stay mounted (just hidden when the drawer closes), so
// what was saved or typed is still there next time, and nothing reloads.
"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { AdminMessageSettings } from "./types"
import { MessageSettingsPanel } from "./settings/OperationsPanels"
import { WhatsAppTemplatesPanel } from "./settings/WhatsAppTemplatesPanel"

type Tab = "connection" | "messages"

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "connection", label: "Connection & templates" },
  { id: "messages", label: "Messages" },
]

export function WhatsAppSettingsDrawer({
  open,
  onClose,
  messageSettings,
}: {
  open: boolean
  onClose: () => void
  messageSettings: AdminMessageSettings
}) {
  // Mount first, then slide in a frame later, so the transition actually plays.
  const [visible, setVisible] = useState(open)
  const [shown, setShown] = useState(false)
  const [everOpened, setEverOpened] = useState(open)
  const [tab, setTab] = useState<Tab>("connection")
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open) {
      setEverOpened(true)
      setVisible(true)
      setTab("connection")
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setVisible(false), 220)
    return () => clearTimeout(t)
  }, [open])

  const requestClose = useCallback(() => onClose(), [onClose])

  // Escape closes; the page behind doesn't scroll while the panel is up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose()
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    panelRef.current?.focus()
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, requestClose])

  if (!everOpened) return null

  return (
    <div className={visible ? "fixed inset-0 z-50" : "hidden"} role="presentation">
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        onClick={requestClose}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsapp-settings-title"
        className={`absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-[#FBF9F3] shadow-2xl outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E6E1D4] px-5 py-4">
          <div>
            <h2 id="whatsapp-settings-title" className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
              WhatsApp settings
            </h2>
            <p className="mt-0.5 text-sm text-[#8A8375]">Your number, approved templates, and what customers are sent.</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-lg leading-none text-[#8A8375] hover:bg-[#F3EEE2]"
          >
            ×
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="WhatsApp settings">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={
                  tab === t.id
                    ? "rounded-md bg-[#7A2E3A] px-3 py-1.5 text-sm font-medium text-white"
                    : "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2]"
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Both tabs stay mounted so unsaved edits survive switching between them. */}
          <div className={tab === "connection" ? "" : "hidden"}>
            <WhatsAppTemplatesPanel />
          </div>
          <div className={tab === "messages" ? "" : "hidden"}>
            <MessageSettingsPanel initial={messageSettings} />
          </div>
        </div>
      </aside>
    </div>
  )
}
