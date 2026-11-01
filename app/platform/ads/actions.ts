// app/platform/ads/actions.ts
"use server"

// Platform-admin actions for kiosk ads. Same rule as app/platform/tenants/actions.ts:
// every action calls requirePlatformAdmin() FIRST (session-based) because the
// writes below use the service-role client and trust the caller completely.
//
// Everything here edits PLATFORM-owned rows only (tenant_id IS NULL). A shop's
// own ads are managed from the shop's own admin, not from here.

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { invalidateModuleCache } from "@/lib/tenant/modules"

type R<T = object> = ({ success: true } & T) | { success: false; error: string }

async function ctx() {
  await requirePlatformAdmin()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase }
}

const fail = (e: unknown): { success: false; error: string } => ({
  success: false,
  error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e),
})

const refresh = () => revalidatePath("/platform/ads")

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URL_RE = /^https?:\/\/\S+$/i
const CAMPAIGN_STATUS = ["draft", "active", "paused", "ended"] as const
const BILLING_STATUS = ["pending", "invoiced", "paid"] as const
const EARNING_STATUS = ["pending", "credited", "paid"] as const
const AD_MODULES = ["kiosk_ads", "platform_ads_opt_out"] as const

const toCents = (rand: number) => Math.round(rand * 100)
const toBps = (pct: number) => Math.round(pct * 100)
const money = (rand: number | null, label: string, max = 100_000_000): string | null =>
  rand === null ? null : !Number.isFinite(rand) || rand < 0 || rand > max ? `${label} must be a number from 0 up.` : null
const pct = (p: number | null, label: string): string | null =>
  p === null ? null : !Number.isFinite(p) || p < 0 || p > 100 ? `${label} must be between 0 and 100.` : null
const iso = (v: string | null): string | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const clean = (s: string) => s.trim()
const dupe = (e: { code?: string } | null, text: string) => (e?.code === "23505" ? text : null)

// ───────────────────────── global settings ─────────────────────────

export async function saveGlobalSettings(input: { enabled: boolean; everyN: number; defaultSharePct: number }): Promise<R> {
  try {
    const { supabase } = await ctx()
    if (!Number.isInteger(input.everyN) || input.everyN < 2 || input.everyN > 50) return { success: false, error: "Platform slot must be every 2nd to 50th slide." }
    const bad = pct(input.defaultSharePct, "Default shop share")
    if (bad) return { success: false, error: bad }

    const { error } = await supabase
      .from("platform_ad_settings")
      .update({ platform_ads_enabled: input.enabled, platform_slot_every_n: input.everyN, default_tenant_share_bps: toBps(input.defaultSharePct) })
      .eq("id", true)
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ───────────────────────── tiers ─────────────────────────

export async function saveTier(input: { id?: string; name: string; cpmRand: number; priority: number; description: string }): Promise<R> {
  try {
    const { supabase } = await ctx()
    const name = clean(input.name)
    if (name.length < 2) return { success: false, error: "Enter a tier name." }
    const bad = money(input.cpmRand, "CPM")
    if (bad) return { success: false, error: bad }
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) return { success: false, error: "Priority must be a whole number (higher plays first)." }

    const row = { name, cpm_rate_cents: toCents(input.cpmRand), priority: input.priority, description: clean(input.description) || null }
    const { error } = input.id
      ? await supabase.from("ad_tiers").update(row).eq("id", input.id).is("tenant_id", null)
      : await supabase.from("ad_tiers").insert({ ...row, tenant_id: null })
    if (error) return { success: false, error: dupe(error, "A tier with that name already exists.") ?? error.message }
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

export async function deleteTier(input: { id: string }): Promise<R> {
  try {
    const { supabase } = await ctx()
    // campaigns keep running: their tier just becomes empty (FK is ON DELETE SET NULL)
    const { error } = await supabase.from("ad_tiers").delete().eq("id", input.id).is("tenant_id", null)
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ───────────────────────── campaigns ─────────────────────────

async function advertiserIdFor(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, name: string): Promise<string | null> {
  const n = clean(name)
  if (!n) return null
  const { data, error } = await supabase.from("ad_advertisers").select("id").is("tenant_id", null).eq("name", n).maybeSingle()
  if (error) throw error
  if (data) return data.id as string
  const { data: created, error: createError } = await supabase.from("ad_advertisers").insert({ tenant_id: null, name: n }).select("id").single()
  if (createError) throw createError
  return created.id as string
}

export async function saveCampaign(input: {
  id?: string
  name: string
  advertiser: string
  tierId: string | null
  /** R per 1000 views. null = use the tier's rate. */
  cpmRand: number | null
  budgetRand: number | null
  startsAt: string | null
  endsAt: string | null
  status: (typeof CAMPAIGN_STATUS)[number]
  /** % of revenue the host shop earns. null = use the shop's override or the platform default. */
  sharePct: number | null
  planKeys: string[]
  businessTypes: string[]
  /** If any: ONLY these shops. */
  include: string[]
  /** Never these shops. */
  exclude: string[]
}): Promise<R> {
  try {
    const { supabase } = await ctx()
    const name = clean(input.name)
    if (name.length < 2) return { success: false, error: "Enter a campaign name." }
    if (!(CAMPAIGN_STATUS as readonly string[]).includes(input.status)) return { success: false, error: "Pick a valid status." }
    for (const bad of [money(input.cpmRand, "CPM"), money(input.budgetRand, "Budget"), pct(input.sharePct, "Shop share")]) if (bad) return { success: false, error: bad }
    if (input.tierId && !UUID.test(input.tierId)) return { success: false, error: "Invalid tier." }

    const startsAt = iso(input.startsAt)
    const endsAt = iso(input.endsAt)
    if (startsAt && endsAt && endsAt <= startsAt) return { success: false, error: "The end date must be after the start date." }

    const include = [...new Set(input.include)]
    const exclude = [...new Set(input.exclude)]
    if ([...include, ...exclude].some((id) => !UUID.test(id))) return { success: false, error: "Invalid shop in the targeting list." }
    if (include.some((id) => exclude.includes(id))) return { success: false, error: "A shop can't be both included and excluded." }

    const businessTypes = [...new Set(input.businessTypes.map((t) => clean(t).toLowerCase()).filter(Boolean))]
    const planKeys = [...new Set(input.planKeys)]
    if (planKeys.length) {
      const { data: plans, error } = await supabase.from("plans").select("key").in("key", planKeys)
      if (error) return fail(error)
      if ((plans ?? []).length !== planKeys.length) return { success: false, error: "Unknown plan in the targeting list." }
    }

    const advertiser_id = await advertiserIdFor(supabase, input.advertiser)
    const row = {
      name,
      advertiser_id,
      tier_id: input.tierId || null,
      cpm_rate_cents: input.cpmRand === null ? null : toCents(input.cpmRand),
      budget_cents: input.budgetRand === null ? null : toCents(input.budgetRand),
      starts_at: startsAt,
      ends_at: endsAt,
      status: input.status,
      tenant_share_bps: input.sharePct === null ? null : toBps(input.sharePct),
      target_plan_keys: planKeys,
      target_business_types: businessTypes,
    }

    let id = input.id
    if (id) {
      const { error } = await supabase.from("ad_campaigns").update(row).eq("id", id).is("tenant_id", null)
      if (error) return fail(error)
    } else {
      const { data, error } = await supabase.from("ad_campaigns").insert({ ...row, tenant_id: null }).select("id").single()
      if (error || !data) return fail(error)
      id = data.id as string
    }

    // Replace the include/exclude lists. (Not one transaction: if this fails the campaign is saved, the lists are not, and the error says so.)
    const { error: clearError } = await supabase.from("ad_campaign_targets").delete().eq("campaign_id", id)
    if (clearError) return { success: false, error: `Campaign saved, but the shop lists weren't: ${clearError.message}` }
    const rows = [
      ...include.map((tenant_id) => ({ campaign_id: id, tenant_id, mode: "include" })),
      ...exclude.map((tenant_id) => ({ campaign_id: id, tenant_id, mode: "exclude" })),
    ]
    if (rows.length) {
      const { error } = await supabase.from("ad_campaign_targets").insert(rows)
      if (error) return { success: false, error: `Campaign saved, but the shop lists weren't: ${error.message}` }
    }

    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

export async function setCampaignStatus(input: { id: string; status: (typeof CAMPAIGN_STATUS)[number] }): Promise<R> {
  try {
    const { supabase } = await ctx()
    if (!(CAMPAIGN_STATUS as readonly string[]).includes(input.status)) return { success: false, error: "Pick a valid status." }
    const { error } = await supabase.from("ad_campaigns").update({ status: input.status }).eq("id", input.id).is("tenant_id", null)
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

export async function deleteCampaign(input: { id: string }): Promise<R> {
  try {
    const { supabase } = await ctx()
    const { error } = await supabase.from("ad_campaigns").delete().eq("id", input.id).is("tenant_id", null)
    if (error) {
      // impressions / billing keep their campaign (ON DELETE RESTRICT) so what was billed can always be reproduced
      if (error.code === "23503") return { success: false, error: "This campaign already has views or billing, so it can't be deleted. Set it to Ended instead." }
      return fail(error)
    }
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ───────────────────────── slides (the ads themselves) ─────────────────────────

export async function saveSlide(input: {
  id?: string
  campaignId: string | null
  slideType: "business" | "sponsor"
  headline: string
  tagline: string
  description: string
  mediaType: "image" | "video"
  imageUrl: string
  videoUrl: string
  durationSeconds: number
  displayOrder: number
  isActive: boolean
  startsAt: string | null
  endsAt: string | null
}): Promise<R> {
  try {
    const { supabase } = await ctx()
    const headline = clean(input.headline)
    if (headline.length < 2) return { success: false, error: "Enter a headline." }
    if (!["business", "sponsor"].includes(input.slideType)) return { success: false, error: "Pick a slide type." }
    if (!["image", "video"].includes(input.mediaType)) return { success: false, error: "Pick image or video." }
    const imageUrl = clean(input.imageUrl)
    const videoUrl = clean(input.videoUrl)
    if (input.mediaType === "image" && !URL_RE.test(imageUrl)) return { success: false, error: "Enter the image link (starting with https://)." }
    if (input.mediaType === "video" && !URL_RE.test(videoUrl)) return { success: false, error: "Enter the video link (starting with https://)." }
    if (imageUrl && !URL_RE.test(imageUrl)) return { success: false, error: "The image link must start with https://." }
    if (videoUrl && !URL_RE.test(videoUrl)) return { success: false, error: "The video link must start with https://." }
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 3 || input.durationSeconds > 600) return { success: false, error: "Duration must be 3 to 600 seconds." }
    if (!Number.isInteger(input.displayOrder)) return { success: false, error: "Order must be a whole number." }
    if (input.campaignId && !UUID.test(input.campaignId)) return { success: false, error: "Invalid campaign." }

    const startsAt = iso(input.startsAt)
    const endsAt = iso(input.endsAt)
    if (startsAt && endsAt && endsAt <= startsAt) return { success: false, error: "The end date must be after the start date." }

    const row = {
      campaign_id: input.campaignId || null, // empty = a house ad (no revenue)
      slide_type: input.slideType,
      headline,
      tagline: clean(input.tagline) || null,
      description: clean(input.description) || null,
      media_type: input.mediaType,
      image_url: imageUrl || null,
      video_url: videoUrl || null,
      duration_seconds: input.durationSeconds,
      display_order: input.displayOrder,
      is_active: input.isActive,
      starts_at: startsAt,
      ends_at: endsAt,
    }
    const { error } = input.id
      ? await supabase.from("kiosk_ads").update(row).eq("id", input.id).is("tenant_id", null)
      : await supabase.from("kiosk_ads").insert({ ...row, tenant_id: null })
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

export async function setSlideActive(input: { id: string; active: boolean }): Promise<R> {
  try {
    const { supabase } = await ctx()
    const { error } = await supabase.from("kiosk_ads").update({ is_active: input.active }).eq("id", input.id).is("tenant_id", null)
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

export async function deleteSlide(input: { id: string }): Promise<R> {
  try {
    const { supabase } = await ctx()
    // views already recorded are kept (kiosk_ad_impressions.ad_id goes to NULL)
    const { error } = await supabase.from("kiosk_ads").delete().eq("id", input.id).is("tenant_id", null)
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ───────────────────────── per-shop controls ─────────────────────────

/** Opt-out switch, targeting category and revenue-share override for one shop. */
export async function saveShopAdSettings(input: {
  tenantId: string
  allowPlatformAds: boolean
  businessType: string
  /** null = no override (campaign / platform default applies) */
  sharePct: number | null
}): Promise<R> {
  try {
    const { supabase } = await ctx()
    if (!UUID.test(input.tenantId)) return { success: false, error: "Invalid shop." }
    const bad = pct(input.sharePct, "Share")
    if (bad) return { success: false, error: bad }

    const { error } = await supabase.from("tenant_ad_settings").upsert(
      {
        tenant_id: input.tenantId,
        allow_platform_ads: input.allowPlatformAds,
        business_type: clean(input.businessType).toLowerCase() || null, // lowercase so it matches campaign targeting
        tenant_share_bps_override: input.sharePct === null ? null : toBps(input.sharePct),
      },
      { onConflict: "tenant_id" },
    )
    if (error) return fail(error)
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

/** mode 'plan' = follow the shop's plan (removes the override row); 'on' / 'off' = force it for this shop. */
export async function setShopAdModule(input: { tenantId: string; moduleKey: string; mode: "plan" | "on" | "off" }): Promise<R> {
  try {
    const { supabase } = await ctx()
    if (!UUID.test(input.tenantId)) return { success: false, error: "Invalid shop." }
    if (!(AD_MODULES as readonly string[]).includes(input.moduleKey)) return { success: false, error: "That module can't be switched here." }
    if (!["plan", "on", "off"].includes(input.mode)) return { success: false, error: "Invalid setting." }

    const { data: mod, error: modError } = await supabase.from("modules").select("id").eq("key", input.moduleKey).maybeSingle()
    if (modError) return fail(modError)
    if (!mod) return { success: false, error: `Module '${input.moduleKey}' isn't registered. Apply ndithini_kiosk_ads_v2.sql first.` }

    const { error } =
      input.mode === "plan"
        ? await supabase.from("tenant_modules").delete().eq("tenant_id", input.tenantId).eq("module_id", mod.id)
        : await supabase
            .from("tenant_modules")
            .upsert({ tenant_id: input.tenantId, module_id: mod.id, enabled: input.mode === "on" }, { onConflict: "tenant_id,module_id" })
    if (error) return fail(error)

    invalidateModuleCache(input.tenantId, input.moduleKey)
    refresh()
    revalidatePath("/platform/modules")
    return { success: true }
  } catch (e) { return fail(e) }
}

// ───────────────────────── billing ─────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Bills platform campaigns for [from, to) and works out each shop's share. Safe to repeat; invoiced/paid rows are never overwritten. */
export async function generateBilling(input: { from: string; to: string }): Promise<R<{ campaigns: number }>> {
  try {
    const { supabase } = await ctx()
    if (!DAY.test(input.from) || !DAY.test(input.to)) return { success: false, error: "Pick both dates." }
    // South Africa has no daylight saving, so a fixed +02:00 is correct. "To" is not included.
    const p_start = `${input.from}T00:00:00+02:00`
    const p_end = `${input.to}T00:00:00+02:00`
    if (new Date(p_end) <= new Date(p_start)) return { success: false, error: "The end date must be after the start date." }

    const { data, error } = await supabase.rpc("generate_ad_billing", { p_start, p_end })
    if (error) return fail(error)
    refresh()
    return { success: true, campaigns: Number(data ?? 0) }
  } catch (e) { return fail(e) }
}

export async function setBillingStatus(input: { id: string; status: (typeof BILLING_STATUS)[number] }): Promise<R> {
  try {
    const { supabase } = await ctx()
    if (!(BILLING_STATUS as readonly string[]).includes(input.status)) return { success: false, error: "Invalid status." }
    const { data, error } = await supabase.from("kiosk_ad_billing").update({ status: input.status }).eq("id", input.id).is("tenant_id", null).select("id").maybeSingle()
    if (error) return fail(error)
    if (!data) return { success: false, error: "Billing row not found." }
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

export async function setEarningStatus(input: { id: string; status: (typeof EARNING_STATUS)[number] }): Promise<R> {
  try {
    const { supabase } = await ctx()
    if (!(EARNING_STATUS as readonly string[]).includes(input.status)) return { success: false, error: "Invalid status." }
    const { data, error } = await supabase.from("ad_tenant_earnings").update({ status: input.status }).eq("id", input.id).select("id").maybeSingle()
    if (error) return fail(error)
    if (!data) return { success: false, error: "Earning not found." }
    refresh()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ───────────────────────── preview ─────────────────────────

export type PreviewAd = {
  id: string
  source: string
  headline: string
  tagline: string | null
  mediaType: string
  imageUrl: string | null
  durationSeconds: number
  position: number
}

/** Exactly what a shop's kiosk would be sent right now (calls the same get_kiosk_ads the kiosk calls). */
export async function previewShop(input: { tenantId: string }): Promise<R<{ ads: PreviewAd[] }>> {
  try {
    const { supabase } = await ctx()
    if (!UUID.test(input.tenantId)) return { success: false, error: "Pick a shop." }
    const { data, error } = await supabase.rpc("get_kiosk_ads", { p_tenant_id: input.tenantId })
    if (error) return fail(error)
    const ads = ((data ?? []) as Array<Record<string, any>>).map((a) => ({
      id: a.id,
      source: a.source,
      headline: a.headline,
      tagline: a.tagline ?? null,
      mediaType: a.media_type,
      imageUrl: a.image_url ?? null,
      durationSeconds: a.duration_seconds,
      position: a.sort_position,
    }))
    return { success: true, ads }
  } catch (e) { return fail(e) }
}
