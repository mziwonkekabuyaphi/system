// app/admin/settings/WhatsAppSettingsPanels.tsx
//
// Settings > WhatsApp Settings. Moved here from the Inbox's right-hand drawer
// (WhatsAppSettingsDrawer, now removed) so it behaves like every other settings page: it is
// listed in SettingsManager's nav and only appears while the `whatsapp` module is effective
// for the shop (switched on AND at least one module that uses WhatsApp is on).
// The two original panels are unchanged:
//
//   Connection & templates -> WhatsAppTemplatesPanel (embeds the connection panel)
//   Messages               -> MessageSettingsPanel (AI default + message wording)
//
// Both stay mounted (just hidden) so unsaved edits survive switching between the two.
"use client"

import { useState } from "react"

import type { AdminMessageSettings } from "../types"
import { MessageSettingsPanel } from "./OperationsPanels"
import { WhatsAppTemplatesPanel } from "./WhatsAppTemplatesPanel"

type Tab = "connection" | "messages"

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "connection", label: "Connection & templates" },
  { id: "messages", label: "Messages" },
]

export function WhatsAppSettingsPanels({ messageSettings }: { messageSettings: AdminMessageSettings }) {
  const [tab, setTab] = useState<Tab>("connection")

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
        <WhatsAppTemplatesPanel />
      </div>
      <div className={tab === "messages" ? "" : "hidden"}>
        <MessageSettingsPanel initial={messageSettings} />
      </div>
    </div>
  )
}
