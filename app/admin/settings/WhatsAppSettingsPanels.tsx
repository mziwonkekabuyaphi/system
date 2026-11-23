// app/admin/settings/WhatsAppSettingsPanels.tsx
//
// Settings > WhatsApp Settings. One page for everything WhatsApp, in four tabs:
//
//   Connection -> WhatsAppConnectionPanel (number, connect / reconnect)
//   Templates  -> WhatsAppTemplatesPanel (Meta-approved templates, grouped Appointments / Queue / Staff / Orders)
//   Messages   -> MessageSettingsPanel (AI default + message wording)
//   AI         -> AiSettingsPanel (own provider key, spending limit, usage). Moved here from its own settings page.
//
// The page only appears while the `whatsapp` module is effective for the shop. Inside it, each template
// group only appears while its parent module is on (see GROUPS in WhatsAppTemplatesPanel).
//
// All tabs stay mounted (just hidden) so unsaved edits survive switching between them.
"use client"

import { useState } from "react"
import type { ReactNode } from "react"

import type { AdminMessageSettings } from "../types"
import { AiSettingsPanel } from "./AiSettingsPanel"
import { MessageSettingsPanel } from "./OperationsPanels"
import { WhatsAppConnectionPanel } from "./WhatsAppConnectionPanel"
import { WhatsAppTemplatesPanel } from "./WhatsAppTemplatesPanel"

export type WhatsAppSettingsTab = "connection" | "templates" | "messages" | "ai"
type Tab = WhatsAppSettingsTab

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "connection", label: "Connection" },
  { id: "templates", label: "Templates" },
  { id: "messages", label: "Messages" },
  { id: "ai", label: "AI" },
]

export function WhatsAppSettingsPanels({
  messageSettings,
  modules,
  initialTab,
  aiExtra,
}: {
  messageSettings: AdminMessageSettings
  /** Effective module state (flags.on). Decides which template groups and wording fields are listed. */
  modules: Record<string, boolean>
  /** Open on this tab (old "AI settings" links open "ai"). Defaults to Connection. */
  initialTab?: WhatsAppSettingsTab
  /** Shown under the AI settings, e.g. the server-rendered voice notes setting. */
  aiExtra?: ReactNode
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "connection")
  // Bumped after a (re)connect so the Templates tab re-reads its "connected" flag.
  const [connectionVersion, setConnectionVersion] = useState(0)

  return (
    <div className="space-y-5">
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
                ? "rounded-md bg-accent-alt px-3 py-1.5 text-sm font-medium text-on-color"
                : "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink hover:bg-tint"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={tab === "connection" ? "" : "hidden"}>
        <WhatsAppConnectionPanel onConnected={() => setConnectionVersion((v) => v + 1)} />
      </div>
      <div className={tab === "templates" ? "" : "hidden"}>
        <WhatsAppTemplatesPanel modules={modules} reloadKey={connectionVersion} />
      </div>
      <div className={tab === "messages" ? "" : "hidden"}>
        <MessageSettingsPanel
          initial={messageSettings}
          showBooking={modules.booking === true}
          showQueue={modules.queue === true}
        />
      </div>
      <div className={tab === "ai" ? "" : "hidden"}>
        <div className="space-y-5">
          <AiSettingsPanel embedded />
          {aiExtra}
        </div>
      </div>
    </div>
  )
}
