"use client"

import { useRef, useState, useTransition } from "react"

import {
  removeLogo,
  updateBranding,
  uploadLogo,
} from "../settings-actions"
import { readableTextOn, sidebarStyleVars } from "../sidebar-theme"
import type {
  AdminBranding,
  AdminPlan,
} from "../types"

type BrandingPatch = Partial<{
  displayName: string | null
  logoUrl: string | null
  sidebarColor: string | null
  sidebarTextColor: string | null
  accentColor: string | null
  adminTheme: "cream" | "dark"
}>
import {
  ColorField,
  FieldRow,
  SettingsCard,
  SettingsStatTile,
  ToggleRow,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./ui"

// Small line icon for the summary tiles.
function TileIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024
const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

// Ready-made primary + secondary pairs for tenants who don't have brand
// colours yet. Chosen to read well on the dark customer-facing screens and
// to avoid reds, ambers, purples and greens (reserved for status colours).
const SUGGESTED_PALETTES: { name: string; primary: string; secondary: string }[] = [
  { name: "Ocean + coral", primary: "#2EC4B6", secondary: "#FF7F6B" },
  { name: "Sky blue + lime", primary: "#4DA3FF", secondary: "#A6D96A" },
  { name: "Hot pink + aqua", primary: "#FF4D8D", secondary: "#2ED1C2" },
  { name: "Indigo + cyan", primary: "#6C8CFF", secondary: "#3DD6D0" },
  { name: "Rose gold + cream", primary: "#D98B7A", secondary: "#F0D9C4" },
  { name: "Teal + blush", primary: "#2BB5C0", secondary: "#F28BA8" },
  { name: "Silver + ice blue", primary: "#C9D1D9", secondary: "#7CC4F0" },
  { name: "Copper + sand", primary: "#C9825B", secondary: "#E8D2A6" },
  { name: "Neon lime + deep teal", primary: "#9BE564", secondary: "#2F9E8F" },
  { name: "Magenta + sky", primary: "#D94FA0", secondary: "#5AC8E8" },
  { name: "Wine + sage", primary: "#C0576A", secondary: "#6FA07C" },
  { name: "Electric blue + magenta", primary: "#3FA7F5", secondary: "#E04FA0" },
  { name: "Red + gold", primary: "#E5533D", secondary: "#E2B33C" },
  { name: "Periwinkle + peach", primary: "#8FA8FF", secondary: "#FFB08A" },
  { name: "Cobalt + silver", primary: "#4F7CFF", secondary: "#D5DCE4" },
  { name: "Trust blue + green", primary: "#1A73E8", secondary: "#00D075" },
  { name: "Coral + slate", primary: "#FF385C", secondary: "#264653" },
  { name: "Forest + moss", primary: "#2D5016", secondary: "#4A7C59" },
  { name: "Neon green + charcoal", primary: "#1DB954", secondary: "#212121" },
  { name: "Royal purple + gold", primary: "#6B35AC", secondary: "#E8C547" },
]

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
  onBrandingChange?: (patch: BrandingPatch) => void
}) {
  return (
    <div className="space-y-4">
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
  onBrandingChange?: (patch: BrandingPatch) => void
}) {
  const initialForm = {
    displayName: initial.displayName,
    primaryColor: initial.primaryColor,
    secondaryColor: initial.secondaryColor,
    removePoweredBy: initial.removePoweredBy,
    sidebarColor: initial.sidebarColor ?? null,
    sidebarTextColor: initial.sidebarTextColor ?? null,
    accentColor: initial.accentColor ?? null,
    adminTheme: (initial.adminTheme === "dark" ? "dark" : "cream") as "cream" | "dark",
  }
  const [form, setForm] = useState(initialForm)
  // The last saved copy of the form, to know when there are unsaved changes.
  const [saved, setSaved] = useState(initialForm)
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [logoUrl, setLogoUrl] = useState(initial.logoUrl)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [isLogoPending, startLogoTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false)

  // Bumped whenever colours are set programmatically (palette pick, "Use my
  // brand colours", sidebar toggle) so the hex inputs remount and show the
  // new values instead of whatever was typed before.
  const [colorSyncKey, setColorSyncKey] = useState(0)


  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateBranding(form)
      if (result.success) {
        setMessage({ ok: true, text: "Saved." })
        setSaved(form)
        onBrandingChange?.({
          displayName: form.displayName,
          sidebarColor: form.sidebarColor,
          sidebarTextColor: form.sidebarTextColor,
          accentColor: form.accentColor,
          adminTheme: form.adminTheme,
        })
      } else {
        setMessage({ ok: false, text: result.error })
        setForm((f) => ({ ...f, removePoweredBy: initial.removePoweredBy }))
      }
    })
  }

  function discard() {
    setForm(saved)
    setColorSyncKey((k) => k + 1)
    setMessage(null)
  }

  // Seeds the dashboard colours from the kiosk brand colours (primary ->
  // sidebar, secondary -> active item) with a readable text colour.
  function brandSidebarColors() {
    const bg = form.primaryColor ?? "#1F2937"
    return { sidebarColor: bg, sidebarTextColor: readableTextOn(bg), accentColor: form.secondaryColor ?? "#D4A017" }
  }

  function toggleCustomSidebar(next: boolean) {
    setColorSyncKey((k) => k + 1)
    setForm({
      ...form,
      ...(next ? brandSidebarColors() : { sidebarColor: null, sidebarTextColor: null, accentColor: null }),
    })
  }

  const customSidebar = form.sidebarColor != null
  const previewVars = sidebarStyleVars(form)

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
    <div className="space-y-4">
      {/* ================= Summary (follows the form live) ================= */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SettingsStatTile label="Display name" value={form.displayName?.trim() || "Not set"} hint="Shown to customers" icon={<TileIcon><path d="M4 7V5h16v2M12 5v14M9 19h6" /></TileIcon>} />
        <SettingsStatTile label="Logo" value={logoUrl ? "Uploaded" : "None yet"} hint="PNG, JPEG, WebP or SVG" icon={<TileIcon><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.500 4 3.500 3-2.500 4 3" /></TileIcon>} />
        <SettingsStatTile
          label="Customer colours"
          value={
            <span className="flex items-center gap-2">
              <span className="h-6 w-6 rounded-full border border-line-strong" style={{ backgroundColor: form.primaryColor ?? "#7A2E3A" }} />
              <span className="h-6 w-6 rounded-full border border-line-strong" style={{ backgroundColor: form.secondaryColor ?? "#4B6B54" }} />
            </span>
          }
          hint={`${form.primaryColor ?? "#7A2E3A"} · ${form.secondaryColor ?? "#4B6B54"}`}
          icon={<TileIcon><path d="M12 3a9 9 0 100 18c1.100 0 1.800-.8 1.800-1.700 0-.5-.2-.9-.5-1.200-.3-.3-.5-.7-.5-1.200 0-.9.8-1.700 1.700-1.700H17a4 4 0 004-4c0-4.400-4-8.200-9-8.200z" /></TileIcon>}
        />
        <SettingsStatTile
          label="Dashboard"
          value={form.adminTheme === "dark" ? "Dark" : "Cream"}
          hint={customSidebar ? "Custom sidebar colours" : "Standard sidebar"}
          icon={<TileIcon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></TileIcon>}
        />
      </div>

      {/* ================= Brand identity ================= */}
      <SettingsCard title="Brand identity" description="Set the name, logo, and colors customers see when interacting with your business.">
        {!canCustomizeBranding && (
          <p className="rounded-lg border border-warn-line bg-warn-soft-2 px-3 py-2 text-sm text-warn-strong">
            Custom logo and brand colours are a Business plan feature. Your display name can be changed on any plan.
            Upgrade from Plans &amp; Billing to unlock the rest.
          </p>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <FieldRow label="Display name">
            <input
              className={inputClass}
              value={form.displayName ?? ""}
              onChange={(e) => setForm({ ...form, displayName: e.target.value || null })}
            />
          </FieldRow>

          <FieldRow label="Logo">
            <div className="flex items-center gap-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-line-strong bg-canvas">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external Storage URL, not a static/local asset
                  <img src={logoUrl} alt="Shop logo" className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-ink-muted">No logo</span>
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
                      className={secondaryButtonClass}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-xs text-ink-muted">PNG, JPEG, WebP, or SVG. Up to 2MB.</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => handleLogoFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {logoError && <p className="mt-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">{logoError}</p>}
          </FieldRow>
        </div>
      </SettingsCard>

      {/* ================= Customer-facing colours ================= */}
      <SettingsCard title="Customer-facing colours" description="These colours apply everywhere your customers see your brand: the kiosk, the public display and your messages.">
        <div
          className={`grid gap-4 sm:grid-cols-2 ${canCustomizeBranding ? "" : "pointer-events-none opacity-50"}`}
          aria-disabled={!canCustomizeBranding}
        >
          <ColorField
            key={`primary-${colorSyncKey}`}
            label="Primary color"
            value={form.primaryColor ?? "#7A2E3A"}
            onChange={(hex) => setForm({ ...form, primaryColor: hex })}
          />
          <ColorField
            key={`secondary-${colorSyncKey}`}
            label="Secondary color"
            value={form.secondaryColor ?? "#4B6B54"}
            onChange={(hex) => setForm({ ...form, secondaryColor: hex })}
          />
        </div>

        <div
          className={`border-t border-line pt-4 ${canCustomizeBranding ? "" : "pointer-events-none opacity-50"}`}
          aria-disabled={!canCustomizeBranding}
        >
          <p className="text-sm font-medium text-ink">Don&apos;t have brand colours yet?</p>
          <p className="text-sm text-ink-muted">
            Pick a ready-made combination. You can still fine-tune either colour afterwards.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
            {SUGGESTED_PALETTES.map((palette) => {
              const selected =
                form.primaryColor?.toLowerCase() === palette.primary.toLowerCase() &&
                form.secondaryColor?.toLowerCase() === palette.secondary.toLowerCase()
              return (
                <button
                  key={palette.name}
                  type="button"
                  onClick={() => {
                    setColorSyncKey((k) => k + 1)
                    setForm({ ...form, primaryColor: palette.primary, secondaryColor: palette.secondary })
                  }}
                  aria-pressed={selected}
                  className={`flex flex-col items-start gap-2 rounded-lg border p-2 text-left text-xs transition-shadow ${
                    selected
                      ? "border-accent bg-canvas ring-1 ring-accent [[data-admin-theme=dark]_&]:shadow-[0_0_14px_rgba(227,6,19,0.25)]"
                      : "border-line bg-card hover:bg-tint [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
                  }`}
                >
                  <span className="flex w-full overflow-hidden rounded-md">
                    <span className="h-8 flex-1" style={{ backgroundColor: palette.primary }} />
                    <span className="h-8 flex-1" style={{ backgroundColor: palette.secondary }} />
                  </span>
                  <span className="font-medium text-ink-soft">{palette.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      </SettingsCard>

      {/* ================= Dashboard look ================= */}
      <SettingsCard title="Dashboard look" description="How this admin dashboard looks for you and your team.">
        <ToggleRow
          title="Dark dashboard"
          description="A dark look for the whole dashboard, sidebar included. Turning it on clears custom sidebar colours (you can set them again below)."
          checked={form.adminTheme === "dark"}
          disabled={isPending}
          onChange={(on) => {
            // Switching to dark also drops custom sidebar colours, so the sidebar goes dark with it.
            // Custom colours can be switched on again below, and they then win over the dark default.
            if (on) setColorSyncKey((k) => k + 1)
            setForm({
              ...form,
              adminTheme: on ? "dark" : "cream",
              ...(on ? { sidebarColor: null, sidebarTextColor: null, accentColor: null } : {}),
            })
          }}
        />

        <div
          className={`space-y-3 ${canCustomizeBranding ? "" : "pointer-events-none opacity-50"}`}
          aria-disabled={!canCustomizeBranding}
        >
          <ToggleRow
            title="Custom dashboard colours"
            description="Colour the sidebar of this admin dashboard. Off keeps the standard look."
            checked={customSidebar}
            disabled={isPending}
            onChange={toggleCustomSidebar}
          />

          {customSidebar && (
            <div className="grid gap-5 lg:grid-cols-[1fr_auto]">
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <ColorField
                    key={`sidebar-${colorSyncKey}`}
                    label="Sidebar"
                    value={form.sidebarColor ?? "#1F2937"}
                    onChange={(hex) => setForm({ ...form, sidebarColor: hex })}
                  />
                  <ColorField
                    key={`sidebar-text-${colorSyncKey}`}
                    label="Sidebar text"
                    value={form.sidebarTextColor ?? readableTextOn(form.sidebarColor ?? "#1F2937")}
                    onChange={(hex) => setForm({ ...form, sidebarTextColor: hex })}
                  />
                  <ColorField
                    key={`accent-${colorSyncKey}`}
                    label="Active item"
                    value={form.accentColor ?? "#D4A017"}
                    onChange={(hex) => setForm({ ...form, accentColor: hex })}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setColorSyncKey((k) => k + 1)
                    setForm({ ...form, ...brandSidebarColors() })
                  }}
                  className={secondaryButtonClass}
                >
                  Use my brand colours
                </button>
              </div>

              {previewVars && (
                <div
                  style={{ ...previewVars, backgroundColor: "var(--sb-bg)", color: "var(--sb-text)" }}
                  className="flex w-56 flex-col gap-1 self-start rounded-lg border border-line p-3 text-sm"
                  aria-label="Sidebar preview"
                >
                  <span
                    style={{ backgroundColor: "var(--sb-accent)", color: "var(--sb-on-accent)" }}
                    className="rounded-md px-3 py-2"
                  >
                    Staff
                  </span>
                  <span style={{ color: "var(--sb-text-muted)" }} className="px-3 py-2">
                    Analytics
                  </span>
                  <span style={{ color: "var(--sb-text-muted)" }} className="px-3 py-2">
                    Billing &amp; Plans
                  </span>
                  <span style={{ color: "var(--sb-text-muted)" }} className="px-3 py-2">
                    Settings
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingsCard>

      {/* ================= Platform branding ================= */}
      <SettingsCard title="Platform branding" description="Control whether your customers see attribution to the platform.">
        <ToggleRow
          title={'Hide "zozoQ" Branding'}
          description={'Remove "Powered By zozoQ" on footer from customer-facing experiences. This is a Business plan feature.'}
          checked={form.removePoweredBy}
          disabled={isPending}
          onChange={handleRemovePoweredByChange}
        />

        {showUpgradePrompt && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-warn-line bg-warn-soft-2 px-3 py-2 text-sm text-warn-strong">
            <span>
              This is a Business plan feature. Upgrade your plan to remove &quot;zozoQ Branding&quot; footer from your
              kiosk.
            </span>
            <button
              type="button"
              onClick={() => setShowUpgradePrompt(false)}
              aria-label="Dismiss"
              className="shrink-0 text-warn hover:text-warn-strong"
            >
              ✕
            </button>
          </div>
        )}
      </SettingsCard>

      {/* ================= One save for the whole page ================= */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-4 py-3 shadow-lg [[data-admin-theme=dark]_&]:shadow-[0_0_24px_rgba(227,6,19,0.12)]">
        <button type="button" onClick={save} disabled={!dirty || isPending} className={primaryButtonClass}>
          {isPending ? "Saving…" : "Save changes"}
        </button>
        {dirty && !isPending && (
          <button type="button" onClick={discard} className={secondaryButtonClass}>
            Discard
          </button>
        )}
        {message ? (
          <span className={`text-sm ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</span>
        ) : dirty ? (
          <span className="text-sm text-warn">Unsaved changes</span>
        ) : (
          <span className="text-sm text-ink-muted">All changes saved</span>
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

