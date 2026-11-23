"use client"

// app/admin/settings/AiSettingsPanel.tsx
/**
 * Settings > AI. The owner brings their own AI provider key (they pay the provider directly), turns AI
 * on or off, sets a monthly spending limit, and sees what the AI has used this month.
 *
 * Loads its own data through server actions, so the key never passes through page props: the browser
 * only ever receives the last 4 characters of a saved key.
 */

import { useCallback, useEffect, useState } from "react"

import {
  getAiSettings,
  removeAiKey,
  saveAiKey,
  updateAiSettings,
  type AiSettingsDto,
} from "../ai-settings-actions"
import {
  FieldRow,
  SettingsCard,
  SettingsPageHeader,
  SettingsStatTile,
  SubSection,
  ToggleRow,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./ui"

const PURPOSE_LABELS: Record<string, string> = {
  intent_classification: "Understanding messages",
  concierge_reply: "Answering questions",
  booking_parser: "Reading booking requests",
  shisha_entry: "Reading shisha requests",
}

const BLOCKED_MESSAGES: Record<string, string> = {
  disabled: "AI is switched off. Customers get the standard menu instead.",
  no_key: "Add your API key below to turn AI on.",
  key_invalid: "Your provider rejected the saved key, so AI is paused. Replace the key to turn it back on.",
  budget_exceeded: "You've reached this month's limit, so AI is paused until next month or until you raise the limit.",
  tenant_inactive: "AI is unavailable because this shop is not active.",
  not_configured: "AI isn't set up for this shop yet.",
  unavailable: "AI is temporarily unavailable. Customers get the standard menu instead.",
}

const rand = (n: number) => `R${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const count = (n: number) => n.toLocaleString("en-ZA")

/** `embedded`: rendered inside WhatsApp Settings, so the page header is left out. */
export function AiSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [settings, setSettings] = useState<AiSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [enabled, setEnabled] = useState(true)
  const [model, setModel] = useState("")
  const [limitText, setLimitText] = useState("")
  const [warnText, setWarnText] = useState("80")

  const [replacingKey, setReplacingKey] = useState(false)
  const [keyText, setKeyText] = useState("")
  // Vendor + model chosen while adding or replacing a key (applied together with the key).
  const [pickProvider, setPickProvider] = useState("")
  const [pickModel, setPickModel] = useState("")

  const [busy, setBusy] = useState<null | "settings" | "key" | "remove">(null)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const apply = useCallback((s: AiSettingsDto) => {
    setSettings(s)
    setEnabled(s.enabled)
    setModel(s.model)
    setPickProvider(s.provider)
    setPickModel(s.model)
    setLimitText(s.monthlyLimitZar === null ? "" : String(s.monthlyLimitZar))
    setWarnText(String(s.warnAtPercent))
  }, [])

  const load = useCallback(async () => {
    const result = await getAiSettings()
    if (result.success) {
      setLoadError(null)
      apply(result.settings)
    } else {
      setLoadError(result.error)
    }
  }, [apply])

  useEffect(() => {
    void load()
  }, [load])

  if (loadError) {
    return (
      <div className="space-y-6">
        {!embedded && <SettingsPageHeader title="AI" description="Use your own AI account and keep an eye on what it costs." />}
        <p className="rounded-md border border-line bg-tint p-3 text-sm text-ink">{loadError}</p>
      </div>
    )
  }
  if (!settings) {
    return (
      <div className="space-y-6">
        {!embedded && <SettingsPageHeader title="AI" description="Use your own AI account and keep an eye on what it costs." />}
        <p className="text-sm text-ink-muted">Loading…</p>
      </div>
    )
  }

  const byok = settings.mode === "byok"
  const hasKey = settings.keyStatus !== "none"
  const showKeyInput = !hasKey || replacingKey
  const choosing = showKeyInput
  const switching = choosing && pickProvider !== "" && pickProvider !== settings.provider
  const activeProviderId = choosing && pickProvider ? pickProvider : settings.provider
  const activeProvider = settings.providers.find((p) => p.id === activeProviderId)
  const activeLabel = activeProvider?.label ?? settings.providerLabel
  const activeHelpUrl = activeProvider?.keyHelpUrl ?? settings.keyHelpUrl
  const activePlaceholder = activeProvider?.keyPlaceholder ?? "sk-…"
  const modelOptions = switching ? (activeProvider?.models ?? []) : settings.models
  const shownModel = switching ? pickModel : model

  function onPickProvider(id: string) {
    setPickProvider(id)
    const next = settings?.providers.find((p) => p.id === id)
    setPickModel(id === settings?.provider ? settings.model : (next?.models[0]?.id ?? ""))
  }
  const totalTokens = settings.month.inputTokens + settings.month.outputTokens
  const pct = settings.month.percentUsed
  const warnLevel = settings.warnAtPercent
  const limitDirty = limitText.trim() !== (settings.monthlyLimitZar === null ? "" : String(settings.monthlyLimitZar))
  const settingsDirty =
    enabled !== settings.enabled || model !== settings.model || limitDirty || warnText !== String(settings.warnAtPercent)

  async function onSaveSettings() {
    if (!settings) return
    setNotice(null)
    const trimmed = limitText.trim()
    const limit = trimmed === "" ? null : Number(trimmed.replace(",", "."))
    if (limit !== null && !Number.isFinite(limit)) {
      setNotice({ kind: "error", text: "Enter the monthly limit as a number of rand, or leave it empty for no limit." })
      return
    }
    setBusy("settings")
    const result = await updateAiSettings({ enabled, model, monthlyLimitZar: limit, warnAtPercent: Number(warnText) })
    setBusy(null)
    if (!result.success) return setNotice({ kind: "error", text: result.error })
    setNotice({ kind: "ok", text: "AI settings saved." })
    await load()
  }

  async function onSaveKey() {
    setNotice(null)
    setBusy("key")
    const result = await saveAiKey(keyText, switching ? pickProvider : undefined, switching ? pickModel : undefined)
    setBusy(null)
    if (!result.success) return setNotice({ kind: "error", text: result.error })
    setKeyText("")
    setReplacingKey(false)
    setNotice({ kind: "ok", text: "Key verified and stored securely. You now pay your AI provider directly." })
    await load()
  }

  async function onRemoveKey() {
    if (!window.confirm("Remove your API key? AI will stop working until you add a key again.")) return
    setNotice(null)
    setBusy("remove")
    const result = await removeAiKey()
    setBusy(null)
    if (!result.success) return setNotice({ kind: "error", text: result.error })
    setNotice({ kind: "ok", text: "Key removed." })
    await load()
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <SettingsPageHeader
          title="AI"
          description="Use your own AI account for the WhatsApp assistant, and see exactly what it uses."
        />
      )}

      {settings.blockedReason && settings.blockedReason !== "disabled" && (
        <p role="status" className="rounded-md border border-line-strong bg-tint p-3 text-sm text-ink">
          {BLOCKED_MESSAGES[settings.blockedReason] ?? BLOCKED_MESSAGES.unavailable}
        </p>
      )}
      {!settings.blockedReason && pct !== null && pct >= warnLevel && (
        <p role="status" className="rounded-md border border-line-strong bg-tint p-3 text-sm text-ink">
          You've used {pct}% of this month's AI limit. AI pauses automatically when it reaches 100%.
        </p>
      )}
      {notice && (
        <p
          role="status"
          className={`rounded-md border p-3 text-sm ${notice.kind === "ok" ? "border-line bg-tint text-ink" : "border-line-strong bg-tint text-ink"}`}
        >
          {notice.text}
        </p>
      )}

      <SettingsCard
        title="AI usage this month"
        description="Estimated from your provider's list prices. Your provider's invoice is the final word."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <SettingsStatTile label="Tokens used" value={count(totalTokens)} hint={`${count(settings.month.inputTokens)} in · ${count(settings.month.outputTokens)} out`} />
          <SettingsStatTile label="Estimated cost" value={rand(settings.month.costZar)} hint={`${count(settings.month.requests)} AI requests`} />
          <SettingsStatTile
            label="Monthly limit"
            value={settings.monthlyLimitZar === null ? "No limit" : rand(settings.monthlyLimitZar)}
            hint={pct === null ? undefined : `${pct}% used`}
          />
        </div>

        {pct !== null && (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-tint"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(pct))}
            aria-label="Share of the monthly AI limit used"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        )}

        {settings.breakdown.length > 0 && (
          <SubSection title="Last 30 days" hint="What the AI was used for.">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink-muted">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Used for</th>
                    <th className="py-1 pr-3 text-right font-medium">Requests</th>
                    <th className="py-1 pr-3 text-right font-medium">Tokens</th>
                    <th className="py-1 text-right font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.breakdown.map((row) => (
                    <tr key={`${row.purpose}-${row.model}`} className="border-t border-line text-ink">
                      <td className="py-1.5 pr-3">
                        {PURPOSE_LABELS[row.purpose] ?? row.purpose}
                        <span className="ml-2 text-xs text-ink-muted">{row.model}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {count(row.requests)}
                        {row.errors > 0 && <span className="ml-1 text-xs text-ink-muted">({row.errors} failed)</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{count(row.inputTokens + row.outputTokens)}</td>
                      <td className="py-1.5 text-right tabular-nums">{rand(row.costZar)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SubSection>
        )}
      </SettingsCard>

      <SettingsCard
        title="AI configuration"
        description={
          byok
            ? "You use your own AI account, so you pay your provider directly and QLess adds no AI charge."
            : "Your shop currently uses AI provided by QLess. Add your own key below to control the cost yourself."
        }
      >
        <ToggleRow
          title="Enable AI"
          description="Understands customer messages and answers questions. When off, customers get the standard menu."
          checked={enabled}
          onChange={setEnabled}
        />

        <SubSection title="Provider">
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldRow label="AI provider">
              <select className={inputClass} value={activeProviderId} disabled={!choosing || busy !== null} onChange={(e) => onPickProvider(e.target.value)}>
                {(settings.providers.length > 0 ? settings.providers : [{ id: settings.provider, label: settings.providerLabel }]).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow
              label="Model"
              hint={byok ? "Smaller models cost less and are plenty for understanding messages." : "Chosen by QLess while you're on QLess-managed AI."}
            >
              <select
                className={inputClass}
                value={shownModel}
                disabled={switching ? busy !== null : !byok}
                onChange={(e) => (switching ? setPickModel(e.target.value) : setModel(e.target.value))}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {!modelOptions.some((m) => m.id === shownModel) && <option value={shownModel}>{shownModel}</option>}
              </select>
            </FieldRow>
          </div>
        </SubSection>

        <SubSection title="API key" hint="Stored encrypted on our servers. The full key is never shown again after you save it.">
          {hasKey && !replacingKey ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
              <div>
                <p className="font-mono text-sm text-ink">sk-••••••••••••{settings.keyLast4}</p>
                <p className="text-xs text-ink-muted">
                  {settings.keyStatus === "active"
                    ? `${settings.providerLabel} connected`
                    : `${settings.providerLabel} rejected this key. Replace it.`}
                  {settings.keySavedAt ? ` · saved ${new Date(settings.keySavedAt).toLocaleDateString("en-ZA")}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" className={secondaryButtonClass} onClick={() => setReplacingKey(true)} disabled={busy !== null}>
                  Replace key
                </button>
                <button type="button" className={secondaryButtonClass} onClick={onRemoveKey} disabled={busy !== null}>
                  {busy === "remove" ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <FieldRow label={`${activeLabel} API key`}>
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={activePlaceholder}
                  value={keyText}
                  onChange={(e) => setKeyText(e.target.value)}
                />
              </FieldRow>
              <p className="text-xs text-ink-muted">
                Don't have one?{" "}
                <a className="underline" href={activeHelpUrl} target="_blank" rel="noreferrer noopener">
                  Create a key in your {activeLabel} account
                </a>
                . We check it with {activeLabel} before saving.
              </p>
              <div className="flex gap-2">
                <button type="button" className={primaryButtonClass} onClick={onSaveKey} disabled={busy !== null || keyText.trim() === ""}>
                  {busy === "key" ? "Checking…" : "Verify and save key"}
                </button>
                {replacingKey && (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => {
                      setReplacingKey(false)
                      setKeyText("")
                      setPickProvider(settings.provider)
                      setPickModel(settings.model)
                    }}
                    disabled={busy !== null}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
          {settings.lastError && (
            <p className="text-xs text-ink-muted">
              Last problem{settings.lastErrorAt ? ` (${new Date(settings.lastErrorAt).toLocaleString("en-ZA")})` : ""}: {settings.lastError}
            </p>
          )}
        </SubSection>

        <SubSection title="Spending limit" hint="AI pauses by itself once this month's estimated cost reaches the limit, so a busy month can't surprise you.">
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldRow label="Monthly limit (R)" hint="Leave empty for no limit.">
              <input
                className={inputClass}
                inputMode="decimal"
                placeholder="No limit"
                value={limitText}
                onChange={(e) => setLimitText(e.target.value)}
              />
            </FieldRow>
            <FieldRow label="Warn me at (%)">
              <input className={inputClass} inputMode="numeric" value={warnText} onChange={(e) => setWarnText(e.target.value)} />
            </FieldRow>
          </div>
        </SubSection>

        <div className="flex justify-end">
          <button type="button" className={primaryButtonClass} onClick={onSaveSettings} disabled={busy !== null || !settingsDirty}>
            {busy === "settings" ? "Saving…" : "Save changes"}
          </button>
        </div>
      </SettingsCard>
    </div>
  )
}
