// app/platform/ads/page.tsx — platform-sold kiosk ads: slides, campaigns, tiers,
// billing and revenue share, plus per-shop controls (opt-out, modules, share).
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { Ads, type AdsData } from "./Ads"

export const dynamic = "force-dynamic"

export default async function PlatformAds() {
  await requirePlatformAdmin() // the real gate: everything below uses the service-role client
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  const [
    settingsRes, tiersRes, advertisersRes, campaignsRes, targetsRes, slidesRes, billingRes, earningsRes,
    tenantsRes, plansRes, shopSettingsRes, modulesRes, planModulesRes, tenantModulesRes, monthViewsRes,
  ] = await Promise.all([
    supabase.from("platform_ad_settings").select("*").maybeSingle(),
    supabase.from("ad_tiers").select("*").is("tenant_id", null).order("priority", { ascending: false }),
    supabase.from("ad_advertisers").select("id, name").is("tenant_id", null),
    supabase.from("ad_campaigns").select("*").is("tenant_id", null).order("created_at", { ascending: false }).limit(500),
    supabase.from("ad_campaign_targets").select("campaign_id, tenant_id, mode"),
    supabase.from("kiosk_ads").select("*").is("tenant_id", null).order("display_order", { ascending: true }).limit(1000),
    supabase.from("kiosk_ad_billing").select("*").is("tenant_id", null).order("period_start", { ascending: false }).limit(300),
    supabase.from("ad_tenant_earnings").select("*").order("period_start", { ascending: false }).limit(500),
    supabase.from("tenants").select("id, name, slug, status, plan").order("name", { ascending: true }).limit(500),
    supabase.from("plans").select("key, name").order("sort_order", { ascending: true }),
    supabase.from("tenant_ad_settings").select("*"),
    supabase.from("modules").select("id, key").in("key", ["kiosk", "kiosk_ads", "platform_ads_opt_out"]),
    supabase.from("plan_modules").select("plan_key, module_id"),
    supabase.from("tenant_modules").select("tenant_id, module_id, enabled"),
    supabase.from("kiosk_ad_impressions").select("id", { count: "exact", head: true }).eq("is_platform_ad", true).gte("created_at", monthStart),
  ])

  const loadError =
    [settingsRes, tiersRes, advertisersRes, campaignsRes, targetsRes, slidesRes, billingRes, earningsRes, tenantsRes, plansRes, shopSettingsRes, modulesRes, planModulesRes, tenantModulesRes]
      .map((r) => r.error)
      .find(Boolean) ?? null

  const settings = (settingsRes.data as any) ?? { platform_ads_enabled: true, platform_slot_every_n: 4, default_tenant_share_bps: 3000 }
  const tiers = (tiersRes.data ?? []) as any[]
  const tierName = new Map(tiers.map((t) => [t.id as string, t.name as string]))
  const advertiserName = new Map(((advertisersRes.data ?? []) as any[]).map((a) => [a.id as string, a.name as string]))
  const campaigns = (campaignsRes.data ?? []) as any[]
  const campaignName = new Map(campaigns.map((c) => [c.id as string, c.name as string]))
  const campaignAdvertiser = new Map(campaigns.map((c) => [c.id as string, (advertiserName.get(c.advertiser_id) ?? null) as string | null]))
  const tenants = (tenantsRes.data ?? []) as any[]
  const shopName = new Map(tenants.map((t) => [t.id as string, t.name as string]))

  const include = new Map<string, string[]>()
  const exclude = new Map<string, string[]>()
  for (const t of (targetsRes.data ?? []) as any[]) {
    const map = t.mode === "include" ? include : exclude
    map.set(t.campaign_id, [...(map.get(t.campaign_id) ?? []), t.tenant_id])
  }

  // Module state, mirroring ad_module_enabled() in the database:
  //   kiosk                           plan must include it AND (row, default ON)
  //   kiosk_ads, platform_ads_opt_out an explicit row wins, otherwise the plan decides
  const moduleId = new Map(((modulesRes.data ?? []) as any[]).map((m) => [m.key as string, m.id as string]))
  const planHas = new Set(((planModulesRes.data ?? []) as any[]).map((r) => `${r.plan_key}:${r.module_id}`))
  const rowFor = new Map(((tenantModulesRes.data ?? []) as any[]).map((r) => [`${r.tenant_id}:${r.module_id}`, r.enabled === true]))
  const shopSettings = new Map(((shopSettingsRes.data ?? []) as any[]).map((s) => [s.tenant_id as string, s]))

  const modeOf = (tenantId: string, key: string): "plan" | "on" | "off" => {
    const row = rowFor.get(`${tenantId}:${moduleId.get(key)}`)
    return row === undefined ? "plan" : row ? "on" : "off"
  }

  const shops: AdsData["shops"] = tenants.map((t) => {
    const s = shopSettings.get(t.id)
    const kioskRow = rowFor.get(`${t.id}:${moduleId.get("kiosk")}`)
    const kioskOn = planHas.has(`${t.plan}:${moduleId.get("kiosk")}`) && (kioskRow ?? true)
    const adsMode = modeOf(t.id, "kiosk_ads")
    const optMode = modeOf(t.id, "platform_ads_opt_out")
    const adsOn = adsMode === "plan" ? planHas.has(`${t.plan}:${moduleId.get("kiosk_ads")}`) : adsMode === "on"
    const optOutOn = optMode === "plan" ? planHas.has(`${t.plan}:${moduleId.get("platform_ads_opt_out")}`) : optMode === "on"
    const allow = s?.allow_platform_ads ?? true
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      plan: t.plan,
      kioskOn,
      adsMode,
      adsOn,
      optMode,
      optOutOn,
      allowPlatformAds: allow,
      businessType: s?.business_type ?? "",
      shareBps: s?.tenant_share_bps_override ?? null,
      // the same rule as ad_platform_ads_allowed()
      showsPlatformAds: t.status === "active" && settings.platform_ads_enabled && kioskOn && (allow || !optOutOn),
    }
  })

  const platformCampaigns = campaigns
  const kpis: AdsData["kpis"] = {
    activeCampaigns: platformCampaigns.filter((c) => c.status === "active").length,
    viewsThisMonth: monthViewsRes.count ?? 0,
    grossCents: Math.round(platformCampaigns.reduce((n, c) => n + Number(c.spent_cents ?? 0), 0)),
    owedToShopsCents: ((earningsRes.data ?? []) as any[]).filter((e) => e.status !== "paid").reduce((n, e) => n + Number(e.tenant_cents ?? 0), 0),
    unbilledCents: ((billingRes.data ?? []) as any[]).filter((b) => b.status === "pending").reduce((n, b) => n + Number(b.gross_cents ?? 0), 0),
    shopsShowing: shops.filter((s) => s.showsPlatformAds).length,
    shopsTotal: shops.length,
  }

  const data: AdsData = {
    ready: !loadError,
    loadError: loadError ? loadError.message : null,
    modulesRegistered: moduleId.has("kiosk_ads") && moduleId.has("platform_ads_opt_out"),
    settings: {
      enabled: !!settings.platform_ads_enabled,
      everyN: Number(settings.platform_slot_every_n),
      defaultShareBps: Number(settings.default_tenant_share_bps),
    },
    kpis,
    plans: ((plansRes.data ?? []) as any[]).map((p) => ({ key: p.key, name: p.name })),
    tiers: tiers.map((t) => ({ id: t.id, name: t.name, cpmCents: t.cpm_rate_cents, priority: t.priority, description: t.description ?? "" })),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      advertiser: advertiserName.get(c.advertiser_id) ?? null,
      tierId: c.tier_id ?? null,
      tierName: tierName.get(c.tier_id) ?? null,
      cpmCents: c.cpm_rate_cents ?? null,
      budgetCents: c.budget_cents ?? null,
      spentCents: Math.round(Number(c.spent_cents ?? 0)),
      views: Number(c.impression_count ?? 0),
      startsAt: c.starts_at ?? null,
      endsAt: c.ends_at ?? null,
      status: c.status,
      shareBps: c.tenant_share_bps ?? null,
      planKeys: c.target_plan_keys ?? [],
      businessTypes: c.target_business_types ?? [],
      include: include.get(c.id) ?? [],
      exclude: exclude.get(c.id) ?? [],
    })),
    slides: ((slidesRes.data ?? []) as any[]).map((a) => ({
      id: a.id,
      campaignId: a.campaign_id ?? null,
      campaignName: campaignName.get(a.campaign_id) ?? null,
      slideType: a.slide_type,
      headline: a.headline,
      tagline: a.tagline ?? "",
      description: a.description ?? "",
      mediaType: a.media_type,
      imageUrl: a.image_url ?? "",
      videoUrl: a.video_url ?? "",
      durationSeconds: a.duration_seconds,
      displayOrder: a.display_order,
      isActive: a.is_active,
      startsAt: a.starts_at ?? null,
      endsAt: a.ends_at ?? null,
    })),
    billing: ((billingRes.data ?? []) as any[]).map((b) => ({
      id: b.id,
      campaign: campaignName.get(b.campaign_id) ?? "(deleted)",
      advertiser: campaignAdvertiser.get(b.campaign_id) ?? null,
      views: Number(b.impressions),
      grossCents: Number(b.gross_cents),
      periodStart: b.period_start,
      periodEnd: b.period_end,
      status: b.status,
    })),
    earnings: ((earningsRes.data ?? []) as any[]).map((e) => ({
      id: e.id,
      shop: shopName.get(e.tenant_id) ?? "(deleted)",
      campaign: campaignName.get(e.campaign_id) ?? "(deleted)",
      views: Number(e.impressions),
      grossCents: Number(e.gross_cents),
      shopCents: Number(e.tenant_cents),
      platformCents: Number(e.platform_cents),
      periodStart: e.period_start,
      periodEnd: e.period_end,
      status: e.status,
    })),
    shops,
  }

  return <Ads data={data} />
}
