// app/admin/settings/WhatsAppConnectionPanel.tsx
"use client"

import { useCallback, useEffect, useState } from "react"

import { ConnectWhatsAppButton } from "@/components/whatsapp/ConnectWhatsAppButton"
import { getWhatsAppConnectionPanelAction, type ConnectionPanelData } from "@/app/onboarding/whatsapp/actions"
import { SettingsCard, primaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// WhatsApp connection — status + connect / reconnect. Rendered at the top of the
// "WhatsApp messages" settings page. Four states: not connected, setting up
// (pending), connected, needs attention (error).
// ---------------------------------------------------------------------------

const BADGE: Record<string, { label: string; className: string }> = {
  not_connected: { label: "Not connected", className: "bg-stone-100 text-stone-600" },
  pending: { label: "Setting up", className: "bg-amber-100 text-amber-800" },
  connected: { label: "Connected", className: "bg-emerald-100 text-emerald-800" },
  error: { label: "Needs attention", className: "bg-red-100 text-red-800" },
}

const BLOCK_TEXT = {
  not_owner: "Only the business owner can connect WhatsApp.",
  plan: "WhatsApp isn't included in your current plan. Upgrade in Billing to connect it.",
  not_configured: "Connecting WhatsApp yourself isn't available on this platform yet. Please contact support.",
} as const

const REPLACE_WARNING =
  "Reconnect to refresh the connection, or connect a different number.\n\n" +
  "If you connect a DIFFERENT number, your current number stops receiving customer messages.\n\nContinue?"

export function WhatsAppConnectionPanel({ onConnected }: { onConnected?: () => void }) {
  const [data, setData] = useState<ConnectionPanelData | null>(null)

  const load = useCallback(async () => {
    setData(await getWhatsAppConnectionPanelAction())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function handleConnected() {
    void load()
    onConnected?.()
  }

  return (
    <SettingsCard
      title="WhatsApp connection"
      description="The WhatsApp number your customers message. You connect it by signing in with Meta; we never see your Meta password."
    >
      {data === null ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : !data.success ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{data.error}</p>
      ) : (
        <ConnectionBody data={data} onConnected={handleConnected} />
      )}
    </SettingsCard>
  )
}

function ConnectionBody({
  data,
  onConnected,
}: {
  data: Extract<ConnectionPanelData, { success: true }>
  onConnected: () => void
}) {
  const { status } = data
  const badge = BADGE[status.state]
  const numberText = status.displayPhone ?? (status.phoneNumberId ? `Number ID ${status.phoneNumberId}` : null)

  const buttonLabel =
    status.state === "connected"
      ? "Reconnect or change number"
      : status.state === "error"
        ? "Try again"
        : status.state === "pending"
          ? "Finish connecting"
          : "Connect WhatsApp"

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}>{badge.label}</span>
        {numberText && <span className="text-sm text-stone-700">{numberText}</span>}
        {status.state === "connected" && !status.connectedVia && (
          <span className="text-xs text-stone-400">Set up for you by ZozoQueue</span>
        )}
      </div>

      {status.lastError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {status.state === "connected" ? "The last reconnect attempt didn't finish: " : ""}
          {status.lastError}
        </p>
      )}

      {status.state === "pending" && !status.lastError && (
        <p className="text-sm text-stone-600">The connection was started but not finished. Press the button to finish it.</p>
      )}

      {data.block === null ? (
        <ConnectWhatsAppButton
          config={data.config}
          label={buttonLabel}
          className={primaryButtonClass}
          confirmMessage={status.state === "connected" ? REPLACE_WARNING : undefined}
          onConnected={onConnected}
        />
      ) : (
        <p className="text-sm text-stone-500">{BLOCK_TEXT[data.block]}</p>
      )}

      {data.block === null && (
        <p className="text-xs text-stone-400">
          Use a number that isn&apos;t already used in the WhatsApp or WhatsApp Business app. Meta bills you directly for messages; add a
          payment method in WhatsApp Manager.
        </p>
      )}
    </div>
  )
}
