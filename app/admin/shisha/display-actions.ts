// app/admin/shisha/display-actions.ts
"use server"

/**
 * Admin actions for the Shisha TV display settings (the right-hand drawer).
 * Same guard as ./actions.ts: shisha.manage for THEIR tenant (tenantId comes
 * from the membership, never the client) + the shisha module switched on.
 * Kept in its own file because `scoped()` in actions.ts is private, and a
 * "use server" file must not export helpers that would become callable actions.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { MODULE_KEYS, isTenantModuleEnabled, tenantHasModule } from "@/lib/services/plans"
import {
  DISPLAY_LABEL_MAX,
  DISPLAY_TICKER_MAX,
  DISPLAY_TITLE_MAX,
  SHISHA_DISPLAY_LABELS,
  SHISHA_DISPLAY_SELECT,
  isHex6,
  normalizeShishaDisplaySettings,
  rowToShishaDisplaySettings,
  shishaDisplaySettingsToRow,
  type ShishaDisplaySettings,
} from "./shisha-display-types"
import type { ShishaActionResult } from "./shisha-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scoped = { ok: true; supabase: ServerClient; tenantId: string } | { ok: false; error: string }

async function scopedManage(): Promise<Scoped> {
  const check = await requireTenantPermission("shisha.manage")
  if (!check.ok) return { ok: false, error: check.error }

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Supabase isn't configured." }

  const tenantId = check.member.tenantId
  if (!(await isTenantModuleEnabled(supabase, tenantId, MODULE_KEYS.shisha, { defaultOn: false, requirePlan: false }))) {
    return { ok: false, error: "Shisha isn't switched on for your business." }
  }
  return { ok: true, supabase, tenantId }
}

export type ShishaDisplayAdminState = {
  settings: ShishaDisplaySettings
  tenantSlug: string
  /** Custom background colours need the 'branding' module (same rule as the queue display). */
  canCustomizeBranding: boolean
}

export async function loadShishaDisplaySettings(): Promise<
  ({ ok: true } & ShishaDisplayAdminState) | { ok: false; error: string }
> {
  const s = await scopedManage()
  if (!s.ok) return s
  try {
    const [settingsRes, tenantRes, canCustomizeBranding] = await Promise.all([
      s.supabase.from("shisha_display_settings").select(SHISHA_DISPLAY_SELECT).eq("tenant_id", s.tenantId).maybeSingle(),
      s.supabase.from("tenants").select("slug").eq("id", s.tenantId).maybeSingle(),
      tenantHasModule(s.supabase, s.tenantId, MODULE_KEYS.branding).catch(() => false),
    ])
    if (settingsRes.error) throw new Error(settingsRes.error.message)
    if (tenantRes.error || !tenantRes.data) throw new Error(tenantRes.error?.message ?? "Tenant not found")

    return {
      ok: true,
      settings: rowToShishaDisplaySettings(settingsRes.data as unknown as Record<string, unknown> | null),
      tenantSlug: (tenantRes.data as { slug: string }).slug,
      canCustomizeBranding,
    }
  } catch (err) {
    console.error("[shisha] loadShishaDisplaySettings failed", { tenantId: s.tenantId, error: err })
    return { ok: false, error: "Couldn't load the display settings." }
  }
}

const BOOLEAN_KEYS = [
  "isEnabled",
  "showStats",
  "showFlavour",
  "showStation",
  "showCustomerName",
  "showFreeDevices",
  "showClock",
  "showTicker",
  "showMenu",
  "timeUpAlertEnabled",
] as const

export async function updateShishaDisplaySettings(input: ShishaDisplaySettings): Promise<ShishaActionResult> {
  const s = await scopedManage()
  if (!s.ok) return s

  // The input comes from the browser: re-check every field, don't trust the types.
  if (!input || typeof input !== "object") return { ok: false, error: "Invalid settings." }
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] !== "boolean") return { ok: false, error: "Invalid settings." }
  }
  if (input.theme !== "dark" && input.theme !== "light" && input.theme !== "custom") {
    return { ok: false, error: "Pick a colour theme." }
  }
  if (input.layout !== "board" && input.layout !== "lounge") return { ok: false, error: "Pick a layout." }
  if (input.sort !== "code" && input.sort !== "urgency") return { ok: false, error: "Pick a sort order." }
  if (!Number.isInteger(input.timeUpAlertSeconds) || input.timeUpAlertSeconds < 3 || input.timeUpAlertSeconds > 60) {
    return { ok: false, error: "Alert duration must be a whole number between 3 and 60 seconds." }
  }

  const value = normalizeShishaDisplaySettings(input)

  const tooLong = (v: string | null, max: number, name: string) =>
    v !== null && v.length > max ? `${name} is too long (${max} characters max).` : null
  const lengthError =
    tooLong(value.title, DISPLAY_TITLE_MAX, "The heading") ??
    tooLong(value.tickerText, DISPLAY_TICKER_MAX, "The ticker message") ??
    SHISHA_DISPLAY_LABELS.map((l) => tooLong(value.labels[l.key], DISPLAY_LABEL_MAX, `"${l.title}"`)).find(Boolean) ??
    null
  if (lengthError) return { ok: false, error: lengthError }

  if (value.theme === "custom") {
    if (!isHex6(value.backgroundColor)) return { ok: false, error: "Use a 6-digit background colour like #15110D." }
    if (!(await tenantHasModule(s.supabase, s.tenantId, MODULE_KEYS.branding).catch(() => false))) {
      return { ok: false, error: "Custom background colours are a Business plan feature." }
    }
  }

  const { error } = await s.supabase
    .from("shisha_display_settings")
    .upsert([{ tenant_id: s.tenantId, ...shishaDisplaySettingsToRow(value) }], { onConflict: "tenant_id" })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
