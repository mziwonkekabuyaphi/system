// app/admin/SettingsManager.tsx
"use client"

import { useRef, useState, useTransition } from "react"

import { removeLogo, setKioskEnabled, updateBranding, updateGeneralInfo, uploadLogo } from "./settings-actions"
import type { AdminBranding, AdminPlan, AdminTenantSettings } from "./types"

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

type SubTab = "general" | "kiosk" | "private-label"

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "kiosk", label: "Kiosk" },
  { id: "private-label", label: "Private Label" },
]

const inputClass =
  "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:border-[#7A2E3A] focus:outline-none focus:ring-1 focus:ring-[#7A2E3A]"

export function SettingsManager({
  initialPlan,
  initialSettings,
  initialBranding,
  initialKioskEnabled,
}: {
  initialPlan: AdminPlan
  initialSettings: AdminTenantSettings
  initialBranding: AdminBranding
  initialKioskEnabled: boolean
}) {
  const [subTab, setSubTab] = useState<SubTab>("general")

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
              subTab === t.id ? "bg-stone-800 text-white" : "border border-stone-300 text-stone-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "general" && <GeneralInfoPanel initial={initialSettings} />}
      {subTab === "kiosk" && <KioskPanel initialEnabled={initialKioskEnabled} />}
      {subTab === "private-label" && <PrivateLabelPanel plan={initialPlan} initial={initialBranding} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// General info
// ---------------------------------------------------------------------------
function GeneralInfoPanel({ initial }: { initial: AdminTenantSettings }) {
  const [form, setForm] = useState(initial)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateGeneralInfo(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">General info</p>
      <p className="text-sm text-stone-500">Contact details and defaults shown to customers.</p>

      <div className="mt-4 space-y-3">
        <FieldRow label="Timezone">
          <input
            className={inputClass}
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Currency">
          <input
            className={inputClass}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Contact email">
          <input
            className={inputClass}
            value={form.contactEmail ?? ""}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Contact phone">
          <input
            className={inputClass}
            value={form.contactPhone ?? ""}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Address">
          <textarea
            className={inputClass}
            rows={2}
            value={form.address ?? ""}
            onChange={(e) => setForm({ ...form, address: e.target.value || null })}
          />
        </FieldRow>
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kiosk
// ---------------------------------------------------------------------------
function KioskPanel({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleToggle(next: boolean) {
    const previous = enabled
    setEnabled(next)
    setError(null)
    startTransition(async () => {
      const result = await setKioskEnabled(next)
      if (!result.success) {
        setEnabled(previous)
        setError(result.error)
      }
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Kiosk module</p>
          <p className="text-sm text-stone-500">Enable the self-service kiosk for this location.</p>
        </div>
        <Toggle checked={enabled} disabled={isPending} onChange={handleToggle} />
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Private Label
// ---------------------------------------------------------------------------
function PrivateLabelPanel({ plan, initial }: { plan: AdminPlan; initial: AdminBranding }) {
  // Text/color fields go through the explicit Save button below (updateBranding).
  // The logo is its own thing — it uploads immediately on file select, same as
  // most logo pickers behave, since "pick a file" and "save settings" being two
  // separate steps is a confusing UX for an image.
  const [form, setForm] = useState({
    displayName: initial.displayName,
    primaryColor: initial.primaryColor,
    secondaryColor: initial.secondaryColor,
    removePoweredBy: initial.removePoweredBy,
  })
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [logoUrl, setLogoUrl] = useState(initial.logoUrl)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [isLogoPending, startLogoTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isBusiness = plan === "business"

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBranding(form)
      if (result.success) {
        setMessage({ ok: true, text: "Saved." })
      } else {
        setMessage({ ok: false, text: result.error })
        setForm((f) => ({ ...f, removePoweredBy: initial.removePoweredBy }))
      }
    })
  }

  function handleRemovePoweredByChange(next: boolean) {
    if (next && !isBusiness) return // upgrade banner below is the answer, not a failed save
    setForm({ ...form, removePoweredBy: next })
  }

  function handleLogoFile(file: File | null) {
    if (!file) return
    setLogoError(null)

    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setLogoError("Logo must be a PNG, JPEG, WebP, or SVG image")
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo must be 2MB or smaller")
      return
    }

    const formData = new FormData()
    formData.set("file", file)

    startLogoTransition(async () => {
      const result = await uploadLogo(formData)
      if (result.success) {
        setLogoUrl(result.logoUrl)
      } else {
        setLogoError(result.error)
      }
      if (fileInputRef.current) fileInputRef.current.value = ""
    })
  }

  function handleRemoveLogo() {
    setLogoError(null)
    startLogoTransition(async () => {
      const result = await removeLogo()
      if (result.success) setLogoUrl(null)
      else setLogoError(result.error)
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Branding</p>
        <p className="text-sm text-stone-500">How your shop appears on the kiosk and customer-facing pages.</p>

        <div className="mt-4 space-y-4">
          <FieldRow label="Display name">
            <input
              className={inputClass}
              value={form.displayName ?? ""}
              onChange={(e) => setForm({ ...form, displayName: e.target.value || null })}
            />
          </FieldRow>

          <FieldRow label="Logo">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-stone-200 bg-stone-50">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external Storage URL, not a static/local asset
                  <img src={logoUrl} alt="Shop logo" className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-stone-400">No logo</span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLogoPending}
                    className="rounded-full border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                  >
                    {isLogoPending ? "Uploading…" : logoUrl ? "Change logo" : "Upload logo"}
                  </button>
                  {logoUrl && (
                    <button
                      type="button"
                      onClick={handleRemoveLogo}
                      disabled={isLogoPending}
                      className="rounded-full px-3 py-1.5 text-sm font-medium text-stone-500 hover:bg-stone-100 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-xs text-stone-400">PNG, JPEG, WebP, or SVG. Up to 2MB.</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => handleLogoFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
          </FieldRow>

          <div className="grid grid-cols-2 gap-3">
            <ColorField
              label="Primary color"
              value={form.primaryColor ?? "#7A2E3A"}
              onChange={(hex) => setForm({ ...form, primaryColor: hex })}
            />
            <ColorField
              label="Secondary color"
              value={form.secondaryColor ?? "#4B6B54"}
              onChange={(hex) => setForm({ ...form, secondaryColor: hex })}
            />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">
              Remove &quot;Powered by&quot;
            </p>
            <p className="text-sm text-stone-500">Hide the platform footer on the kiosk.</p>
          </div>
          <Toggle
            checked={form.removePoweredBy}
            disabled={isPending || !isBusiness}
            onChange={handleRemovePoweredByChange}
          />
        </div>

        {!isBusiness && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This is a Business plan feature. Upgrade your plan to remove the &quot;Powered by&quot; footer from your
            kiosk.
          </div>
        )}
      </div>

      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-stone-600">{label}</span>
      {children}
    </label>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const isValid = HEX_COLOR_PATTERN.test(draft)

  function commit(next: string) {
    setDraft(next)
    if (HEX_COLOR_PATTERN.test(next)) onChange(next)
  }

  return (
    <FieldRow label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-10 w-10 shrink-0 rounded-lg border border-stone-300 p-0.5"
          value={isValid ? draft : value}
          onChange={(e) => {
            setDraft(e.target.value)
            onChange(e.target.value)
          }}
        />
        <input
          type="text"
          className={`${inputClass} ${!isValid ? "border-red-300" : ""}`}
          value={draft}
          onChange={(e) => commit(e.target.value)}
          placeholder="#7A2E3A"
        />
      </div>
    </FieldRow>
  )
}

function SaveRow({
  isPending,
  onSave,
  message,
}: {
  isPending: boolean
  onSave: () => void
  message: { ok: boolean; text: string } | null
}) {
  return (
    <div className="mt-4 flex items-center gap-3 border-t border-stone-100 pt-4">
      <button
        type="button"
        onClick={onSave}
        disabled={isPending}
        className="rounded-full bg-[#7A2E3A] px-4 py-2 text-sm font-medium text-white hover:bg-[#651F2A] disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {message && (
        <span className={`text-sm ${message.ok ? "text-[#4B6B54]" : "text-red-700"}`}>{message.text}</span>
      )}
    </div>
  )
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-[#7A2E3A]" : "bg-stone-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  )
}
