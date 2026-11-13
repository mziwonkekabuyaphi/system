"use client"

// app/admin/payments/PaymentsPanel.tsx
//
// "Settings > Payments": the shop owner connects their OWN card-payment account here, so card payments go
// straight to them. Mount it anywhere in the admin Settings area for users who hold settings.manage:
//
//   <PaymentsPanel />
//
// It is self-contained (loads its own state through actions.ts) and reuses the Events area's styling.
// The form is built from each provider's own field list (lib/payments/providers), so adding a provider adds
// no UI code. A shop has ONE active provider: to switch, disconnect first.

import { useCallback, useEffect, useState } from "react"
import { connectProvider, disconnectProvider, loadPaymentSettings, type PaymentSettings } from "./actions"
import { ACCENT_TEXT, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Chip, INPUT, Icon, LABEL, PANEL, WELL } from "../events/ui"

export function PaymentsPanel() {
  const [info, setInfo] = useState<PaymentSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
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

  if (loadError) return <p role="alert" className="text-sm text-red-600">{loadError}</p>
  if (!info) return <div className="h-40 animate-pulse rounded-2xl bg-stone-500/10" aria-busy="true" />

  const connected = info.active !== null
  // While connected, the form (if opened) is for the provider that is connected.
  const provider = info.providers.find((p) => p.id === (info.active?.provider ?? selected)) ?? info.providers[0] ?? null
  const showForm = provider !== null && (!connected || editing)
  const ready = provider !== null && provider.fields.every((f) => (values[f.name] ?? "").trim() !== "")

  function reset() {
    setValues({}) // secrets are not kept in the page once saved or cancelled
    setEditing(false)
    setError(null)
  }

  async function connect() {
    if (!provider) return
    setBusy(true)
    setError(null)
    setDone(null)
    const res = await connectProvider(provider.id, values)
    setBusy(false)
    if (!res.ok) return setError(res.error)
    reset()
    setDone(
      res.data.mode === "live"
        ? `${res.data.label} is connected. Real payments are switched on.`
        : `${res.data.label} is connected in TEST mode. No real money moves yet.`,
    )
    await refresh()
  }

  async function disconnect() {
    const label = info?.active?.label ?? "Card payments"
    setBusy(true)
    setError(null)
    const res = await disconnectProvider()
    setBusy(false)
    setConfirmOff(false)
    if (!res.ok) return setError(res.error)
    setDone(`${label} is disconnected.`)
    await refresh()
  }

  return (
    <section className={`${PANEL} space-y-5 p-5`} aria-label="Payments">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-stone-900">
            <Icon name="credit-card" className={ACCENT_TEXT} /> Card payments{provider ? ` (${provider.label})` : ""}
          </h2>
          <p className="mt-1 max-w-xl text-xs text-stone-500">
            {provider?.description ?? "No payment provider is available yet."}
          </p>
        </div>
        {connected ? <Chip tone={info.active?.mode === "live" ? "good" : "warn"}>{info.active?.mode === "live" ? "Live" : "Test mode"}</Chip> : <Chip>Not connected</Chip>}
      </div>

      {!connected && info.providers.length > 1 && (
        <fieldset>
          <legend className={LABEL}>Payment provider</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment provider">
            {info.providers.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={provider?.id === p.id}
                onClick={() => { setSelected(p.id); setValues({}); setError(null) }}
                className={`rounded-full border px-4 py-1.5 text-xs font-semibold ${provider?.id === p.id ? "border-transparent bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_16%,transparent)] text-stone-900" : "border-stone-200 text-stone-600 hover:bg-stone-500/10"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {connected && !editing && info.active && (
        <div className={`${WELL} space-y-1 p-3 text-sm`}>
          <p className="text-stone-800">Connected to {info.active.label} · key ending <span className="font-mono">{info.active.keyHint ?? "••••"}</span></p>
          <p className="text-xs text-stone-500">
            {info.active.lastEventAt ? `Last payment notice received ${new Date(info.active.lastEventAt).toLocaleString("en-ZA")}.` : "No payment notice received yet."}
          </p>
          {info.active.mode === "test" && <p className="text-xs text-amber-600">Test mode: payments are practice only. Connect your live details when you&apos;re ready.</p>}
        </div>
      )}

      {info.refundsNeeded > 0 && (
        <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {info.refundsNeeded} ticket payment{info.refundsNeeded === 1 ? "" : "s"} came in but the tickets could not be issued, and
          {info.refundsNeeded === 1 ? " it needs" : " they need"} a refund. Please refund {info.refundsNeeded === 1 ? "it" : "them"} in your{" "}
          {info.refundProviders.length > 0 ? info.refundProviders.join(" / ") : "payment provider"} portal.
        </p>
      )}

      {info.lastError && (
        <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {info.lastError}
        </p>
      )}

      {showForm && provider && (
        <div className="space-y-3">
          {provider.fields.map((f) => (
            <div key={f.name} className="space-y-1">
              <label className={LABEL} htmlFor={`pay-${provider.id}-${f.name}`}>{f.label}</label>
              <input
                id={`pay-${provider.id}-${f.name}`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                className={`${INPUT} font-mono`}
                placeholder={f.placeholder}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
              {f.help && <p className="text-xs text-stone-500">{f.help}</p>}
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={connect} disabled={busy || !ready}>
              {busy ? "Connecting…" : connected ? "Replace details" : `Connect ${provider.label}`}
            </button>
            {editing && (
              <button type="button" className={BTN_GHOST} onClick={reset} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {connected && !editing && info.active && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => { setEditing(true); setDone(null) }}>Replace details</button>
          {confirmOff ? (
            <>
              <span className="text-xs text-stone-600">
                Customers won&apos;t be able to pay by card. {info.providers.find((p) => p.id === info.active?.provider)?.disconnectNote}
              </span>
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
