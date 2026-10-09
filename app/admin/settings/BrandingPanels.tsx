"use client"

import { useRef, useState, useTransition } from "react"

import {
  removeLogo,
  updateBranding,
  uploadLogo,
} from "../settings-actions"
import type {
  AdminBranding,
  AdminPlan,
} from "../types"
import {
  ColorField,
  FieldRow,
  SaveRow,
  Toggle,
  inputClass,
  secondaryButtonClass,
} from "./ui"

const MAX_LOGO_BYTES = 2 * 1024 * 1024
const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

// ---------------------------------------------------------------------------
// Private Label — the SINGLE place branding is edited. Controls how the
// business appears across every customer-facing surface (kiosk, booking &
// queue confirmations, WhatsApp). Two cards:
//   - Brand identity: display name, logo, colors
//   - Platform branding: "Remove Powered by" (Business plan only)
// Both save through the same AdminBranding shape and the same
// updateBranding()/uploadLogo()/removeLogo() actions as before — nothing
// about the data layer changed, only where the controls live.
// ---------------------------------------------------------------------------
export function PrivateLabelPanel({
  plan,
  canRemovePoweredBy,
  canCustomizeBranding,
  initial,
  onBrandingChange,
}: {
  plan: AdminPlan
  canRemovePoweredBy: boolean
  canCustomizeBranding: boolean
  initial: AdminBranding
  onBrandingChange?: (patch: Partial<{ displayName: string | null; logoUrl: string | null }>) => void
}) {
  return (
    <div className="space-y-3">
      <BrandingFields plan={plan} canRemovePoweredBy={canRemovePoweredBy} canCustomizeBranding={canCustomizeBranding} initial={initial} onBrandingChange={onBrandingChange} />
    </div>
  )
}

function BrandingFields({
  plan,
  canRemovePoweredBy,
  canCustomizeBranding,
  initial,
  onBrandingChange,
}: {
  plan: AdminPlan
  canRemovePoweredBy: boolean
  canCustomizeBranding: boolean
  initial: AdminBranding
  onBrandingChange?: (patch: Partial<{ displayName: string | null; logoUrl: string | null }>) => void
}) {
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

  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false)


  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBranding(form)
      if (result.success) {
        setMessage({ ok: true, text: "Saved." })
        onBrandingChange?.({ displayName: form.displayName })
      } else {
        setMessage({ ok: false, text: result.error })
        setForm((f) => ({ ...f, removePoweredBy: initial.removePoweredBy }))
      }
    })
  }

  function handleRemovePoweredByChange(next: boolean) {
    if (next && !canRemovePoweredBy) {
      setShowUpgradePrompt(true)
      return
    }
    setShowUpgradePrompt(false)
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
        onBrandingChange?.({ logoUrl: result.logoUrl })
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
      if (result.success) {
        setLogoUrl(null)
        onBrandingChange?.({ logoUrl: null })
      } else {
        setLogoError(result.error)
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Brand identity</p>
        <p className="text-sm text-stone-500">Set the name, logo, and colors customers see when interacting with your business.</p>
        {!canCustomizeBranding && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Custom logo and brand colours are a Business plan feature. Your display name can be changed on any plan.
            Upgrade from Plans &amp; Billing to unlock the rest.
          </p>
        )}

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
                    disabled={isLogoPending || !canCustomizeBranding}
                    className={secondaryButtonClass}
                  >
                    {isLogoPending ? "Uploading…" : logoUrl ? "Change logo" : "Upload logo"}
                  </button>
                  {logoUrl && (
                    <button
                      type="button"
                      onClick={handleRemoveLogo}
                      disabled={isLogoPending}
                      className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-500 hover:bg-stone-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-300"
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

          <div
            className={`grid grid-cols-2 gap-3 ${canCustomizeBranding ? "" : "pointer-events-none opacity-50"}`}
            aria-disabled={!canCustomizeBranding}
          >
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

        <SaveRow isPending={isPending} onSave={save} message={message} />
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Platform branding</p>
        <p className="text-sm text-stone-500">Control whether your customers see attribution to the platform.</p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-stone-800">Remove &quot;Powered by&quot;</p>
            <p className="text-sm text-stone-500">
              Hide the platform footer from customer-facing experiences. This is a Business plan feature.
            </p>
          </div>
          <Toggle checked={form.removePoweredBy} disabled={isPending} onChange={handleRemovePoweredByChange} />
        </div>

        {showUpgradePrompt && (
          <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span>
              This is a Business plan feature. Upgrade your plan to remove the &quot;Powered by&quot; footer from your
              kiosk.
            </span>
            <button
              type="button"
              onClick={() => setShowUpgradePrompt(false)}
              aria-label="Dismiss"
              className="shrink-0 text-amber-600 hover:text-amber-900"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking
//
// UPDATED: explanatory hints added under each field (these settings now
// actually control the live booking flow — see lib/services/booking.ts,
// app/admin/actions.ts, and app/api/cron/promote-bookings/route.ts).
// Also adds Queue Priority Mode (queuePriorityMode), a new tenant setting
// (supabase/migrations/20260915_add_queue_priority_mode.sql) that decides
// how a promoted booking is ordered relative to walk-ins once it's in the
// shared queue — see lib/services/queue.ts's getQueueSimulation() for
// exactly what each option does. It's saved through the same
// updateBookingSettings() action and SaveRow as everything else on this
// tab, and it's only meaningful once "Link bookings to the queue" is on,
// so its card is disabled (not hidden) until that toggle is switched on —
// same "off = visibly muted, not invisible" convention this file already
// uses for disabled inputs/buttons elsewhere.

