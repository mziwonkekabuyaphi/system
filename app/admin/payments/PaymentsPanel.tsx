"use client"

// app/admin/payments/PaymentsPanel.tsx
//
// "Settings > Payments": the shop owner connects their OWN Yoco account here, so card payments go
// straight to them. Mount it anywhere in the admin Settings area for users who hold settings.manage:
//
//   <PaymentsPanel />
//
// It is self-contained (loads its own state through actions.ts) and reuses the Events area's styling.

import { useCallback, useEffect, useState } from "react"
import { connectYoco, disconnectYoco, loadPaymentSettings, type PaymentSettings } from "./actions"
import { ACCENT_TEXT, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Chip, INPUT, Icon, LABEL, PANEL, WELL } from "../events/ui"

export function PaymentsPanel() {
  const [info, setInfo] = useState<PaymentSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [editing, setEditing] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await loadPaymentSettings()
    if (res.ok) setInfo(res.data)
    else setLoadError(res.error)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function connect() {
    setBusy(true)
    setError(null)
    setDone(null)
    const res = await connectYoco(key)
    setBusy(false)
    if (!res.ok) return setError(res.error)
    setKey("") // the key is not kept in the page once saved
    setEditing(false)
    setDone(res.data.mode === "live" ? "Yoco is connected. Real payments are switched on." : "Yoco is connected in TEST mode. No real money moves yet.")
    await refresh()
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    const res = await disconnectYoco()
    setBusy(false)
    setConfirmOff(false)
    if (!res.ok) return setError(res.error)
    setDone("Yoco is disconnected.")
    await refresh()
  }

  if (loadError) return <p role="alert" className="text-sm text-red-600">{loadError}</p>
  if (!info) return <div className="h-40 animate-pulse rounded-2xl bg-stone-500/10" aria-busy="true" />

  const showForm = !info.connected || editing

  return (
    <section className={`${PANEL} space-y-5 p-5`} aria-label="Payments">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-stone-900">
            <Icon name="credit-card" className={ACCENT_TEXT} /> Card payments (Yoco)
          </h2>
          <p className="mt-1 max-w-xl text-xs text-stone-500">
            Customers pay on Yoco&apos;s secure page and the money goes straight to <strong>your own Yoco account</strong>. This platform never holds your money or sees card details.
          </p>
        </div>
        {info.connected ? <Chip tone={info.mode === "live" ? "good" : "warn"}>{info.mode === "live" ? "Live" : "Test mode"}</Chip> : <Chip>Not connected</Chip>}
      </div>

      {info.connected && !editing && (
        <div className={`${WELL} space-y-1 p-3 text-sm`}>
          <p className="text-stone-800">Connected · secret key ending <span className="font-mono">{info.keyHint ?? "••••"}</span></p>
          <p className="text-xs text-stone-500">
            {info.lastEventAt ? `Last payment notice received ${new Date(info.lastEventAt).toLocaleString("en-ZA")}.` : "No payment notice received yet."}
          </p>
          {info.mode === "test" && <p className="text-xs text-amber-600">Test mode: payments are practice only. Connect your live key when you&apos;re ready.</p>}
        </div>
      )}

      {info.refundsNeeded > 0 && (
        <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {info.refundsNeeded} ticket payment{info.refundsNeeded === 1 ? "" : "s"} came in but the tickets could not be issued, and
          {info.refundsNeeded === 1 ? " it needs" : " they need"} a refund. Please refund {info.refundsNeeded === 1 ? "it" : "them"} in your Yoco portal.
        </p>
      )}

      {info.lastError && (
        <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {info.lastError}
        </p>
      )}

      {showForm && (
        <div className="space-y-2">
          <label className={LABEL} htmlFor="yoco-key">Yoco secret key</label>
          <input
            id="yoco-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT} font-mono`}
            placeholder="sk_test_… or sk_live_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="text-xs text-stone-500">
            Find it in your Yoco Business Portal under the developer / API keys section. Use the <strong>secret</strong> key, never the public one. Start with a test key. It is saved encrypted and can&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={connect} disabled={busy || key.trim() === ""}>
              {busy ? "Connecting…" : info.connected ? "Replace key" : "Connect Yoco"}
            </button>
            {editing && (
              <button type="button" className={BTN_GHOST} onClick={() => { setEditing(false); setKey(""); setError(null) }} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {info.connected && !editing && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => { setEditing(true); setDone(null) }}>Replace key</button>
          {confirmOff ? (
            <>
              <span className="text-xs text-stone-600">Customers won&apos;t be able to pay by card. We&apos;ll also remove our webhook from your Yoco account.</span>
              <button type="button" className={BTN_DANGER} onClick={disconnect} disabled={busy}>Yes, disconnect</button>
              <button type="button" className={BTN_GHOST} onClick={() => setConfirmOff(false)} disabled={busy}>Keep</button>
            </>
          ) : (
            <button type="button" className={BTN_GHOST} onClick={() => setConfirmOff(true)}>Disconnect</button>
          )}
        </div>
      )}

      {error && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      {done && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">{done}</p>}
    </section>
  )
}
