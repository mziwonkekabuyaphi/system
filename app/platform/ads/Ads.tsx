// app/platform/ads/Ads.tsx
"use client"

import { useState, useTransition, type ReactNode } from "react"

import {
  deleteCampaign, deleteSlide, deleteTier, generateBilling, previewShop, saveCampaign, saveGlobalSettings,
  saveShopAdSettings, saveSlide, saveTier, setBillingStatus, setCampaignStatus, setEarningStatus,
  setShopAdModule, setSlideActive, type PreviewAd,
} from "./actions"

// ───────────────────────── data shape (built in page.tsx) ─────────────────────────

type Mode = "plan" | "on" | "off"
type CampaignStatus = "draft" | "active" | "paused" | "ended"

export type AdsData = {
  ready: boolean
  loadError: string | null
  modulesRegistered: boolean
  settings: { enabled: boolean; everyN: number; defaultShareBps: number }
  kpis: { activeCampaigns: number; viewsThisMonth: number; grossCents: number; owedToShopsCents: number; unbilledCents: number; shopsShowing: number; shopsTotal: number }
  plans: Array<{ key: string; name: string }>
  tiers: Array<{ id: string; name: string; cpmCents: number; priority: number; description: string }>
  campaigns: Array<{
    id: string; name: string; advertiser: string | null; tierId: string | null; tierName: string | null
    cpmCents: number | null; budgetCents: number | null; spentCents: number; views: number
    startsAt: string | null; endsAt: string | null; status: CampaignStatus; shareBps: number | null
    planKeys: string[]; businessTypes: string[]; include: string[]; exclude: string[]
  }>
  slides: Array<{
    id: string; campaignId: string | null; campaignName: string | null; slideType: "business" | "sponsor"
    headline: string; tagline: string; description: string; mediaType: "image" | "video"
    imageUrl: string; videoUrl: string; durationSeconds: number; displayOrder: number
    isActive: boolean; startsAt: string | null; endsAt: string | null
  }>
  billing: Array<{ id: string; campaign: string; advertiser: string | null; views: number; grossCents: number; periodStart: string; periodEnd: string; status: string }>
  earnings: Array<{ id: string; shop: string; campaign: string; views: number; grossCents: number; shopCents: number; platformCents: number; periodStart: string; periodEnd: string; status: string }>
  shops: Array<{
    id: string; name: string; slug: string; status: string; plan: string; kioskOn: boolean
    adsMode: Mode; adsOn: boolean; optMode: Mode; optOutOn: boolean
    allowPlatformAds: boolean; businessType: string; shareBps: number | null; showsPlatformAds: boolean
  }>
}

type Res = { success: true } | { success: false; error: string }
type Msg = { ok: boolean; text: string } | null

// ───────────────────────── small helpers ─────────────────────────

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
const input = "rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
const btn = "rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
const btn2 = "rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 disabled:opacity-50"
const th = "py-2 pr-3 font-medium"
const label = "block text-xs uppercase text-stone-400"

const rand = (cents: number) => `R${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-ZA") : "—")
/** The billing period end is exclusive (midnight), so show the last day included. */
const lastDay = (s: string) => new Date(new Date(s).getTime() - 1000).toLocaleDateString("en-ZA")
const pctText = (bps: number | null) => (bps === null ? "" : String(bps / 100))
const toNum = (v: string): number | null => (v.trim() === "" ? null : Number(v))
const toLocalInput = (iso: string | null) => {
  if (!iso) return ""
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  paid: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  pending: "bg-amber-100 text-amber-800",
  invoiced: "bg-sky-100 text-sky-800",
  credited: "bg-sky-100 text-sky-800",
  draft: "bg-stone-100 text-stone-600",
  ended: "bg-stone-200 text-stone-600",
}
const Pill = ({ children, tone }: { children: ReactNode; tone?: string }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone ?? STATUS_STYLE[String(children)] ?? "bg-stone-100 text-stone-600"}`}>{children}</span>
)

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 border-b border-stone-100 pb-2 text-base font-semibold text-stone-900">{title}</h3>
        {children}
      </div>
    </div>
  )
}
const Field = ({ name, hint, full, children }: { name: string; hint?: string; full?: boolean; children: ReactNode }) => (
  <label className={`block space-y-1 ${full ? "sm:col-span-2" : ""}`}>
    <span className={label}>{name}</span>
    {children}
    {hint && <span className="block text-xs text-stone-500">{hint}</span>}
  </label>
)

// ───────────────────────── page ─────────────────────────

const TABS = ["Slides", "Campaigns", "Tiers", "Billing", "Shops", "Preview", "Settings"] as const
type Tab = (typeof TABS)[number]

export function Ads({ data }: { data: AdsData }) {
  const [tab, setTab] = useState<Tab>("Slides")
  const [msg, setMsg] = useState<Msg>(null)
  const [busy, start] = useTransition()

  /** Runs a server action, shows its result, and runs `after` on success (e.g. close a modal). */
  const run = (fn: () => Promise<Res>, ok: string, after?: () => void) => {
    setMsg(null)
    start(async () => {
      const res = await fn()
      if (res.success) { setMsg({ ok: true, text: ok }); after?.() } else setMsg({ ok: false, text: res.error })
    })
  }
  const ctx = { data, busy, run, setMsg, start }
  const k = data.kpis

  const kpis: Array<[string, string]> = [
    ["Active campaigns", String(k.activeCampaigns)],
    ["Views this month", k.viewsThisMonth.toLocaleString("en-ZA")],
    ["Billed to date", rand(k.grossCents)],
    ["Not yet invoiced", rand(k.unbilledCents)],
    ["Owed to shops", rand(k.owedToShopsCents)],
    ["Shops showing ads", `${k.shopsShowing} / ${k.shopsTotal}`],
  ]

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Kiosk ads</h1>
        <p className="mt-1 text-sm text-stone-500">
          Ads you sell that play on shop kiosks. Each shop earns a share of what the advertiser pays; shops on a plan with the opt-out can switch them off.
        </p>
      </div>

      {data.loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Couldn&apos;t load everything: {data.loadError}. If you haven&apos;t yet, apply <span className="font-mono">ndithini_kiosk_ads_v2.sql</span> in Supabase.
        </p>
      )}
      {data.ready && !data.modulesRegistered && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          The <span className="font-mono">kiosk_ads</span> / <span className="font-mono">platform_ads_opt_out</span> modules aren&apos;t registered yet, so the per-shop switches won&apos;t work. Apply the SQL first.
        </p>
      )}
      {!data.settings.enabled && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">Platform ads are switched OFF for every shop (Settings tab).</p>
      )}
      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {kpis.map(([l, v]) => (
          <div key={l} className={card}>
            <p className="text-xs uppercase text-stone-400">{l}</p>
            <p className="mt-1 text-xl text-stone-900 tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-4 py-1.5 text-sm ${tab === t ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700"}`}>
            {t}
          </button>
        ))}
      </nav>

      {tab === "Slides" && <SlidesTab {...ctx} />}
      {tab === "Campaigns" && <CampaignsTab {...ctx} />}
      {tab === "Tiers" && <TiersTab {...ctx} />}
      {tab === "Billing" && <BillingTab {...ctx} />}
      {tab === "Shops" && <ShopsTab {...ctx} />}
      {tab === "Preview" && <PreviewTab {...ctx} />}
      {tab === "Settings" && <SettingsTab {...ctx} />}
    </main>
  )
}

type Ctx = {
  data: AdsData
  busy: boolean
  run: (fn: () => Promise<Res>, ok: string, after?: () => void) => void
  setMsg: (m: Msg) => void
  start: (fn: () => Promise<void>) => void
}

// ───────────────────────── Slides ─────────────────────────

type Slide = AdsData["slides"][number]

function SlidesTab({ data, busy, run }: Ctx) {
  const [editing, setEditing] = useState<Slide | "new" | null>(null)
  const [query, setQuery] = useState("")
  const shown = data.slides.filter((s) => `${s.headline} ${s.campaignName ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className={card}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className={btn} onClick={() => setEditing("new")}>Add slide</button>
        <input className={`${input} w-full sm:w-64`} placeholder="Search slides" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="ml-auto text-xs text-stone-500">{data.slides.length} slides · {data.slides.filter((s) => s.isActive).length} active</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="text-xs uppercase text-stone-400">
            <tr><th className={th}>Order</th><th className={th}>Type</th><th className={th}>Headline</th><th className={th}>Media</th><th className={th}>Secs</th><th className={th}>Campaign</th><th className={th}>Active</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {shown.map((s) => (
              <tr key={s.id}>
                <td className="py-2 pr-3 tabular-nums">{s.displayOrder}</td>
                <td className="pr-3">{s.slideType === "sponsor" ? "Sponsor" : "Business"}</td>
                <td className="pr-3 text-stone-900">{s.headline}</td>
                <td className="pr-3">{s.mediaType}</td>
                <td className="pr-3 tabular-nums">{s.durationSeconds}</td>
                <td className="pr-3">{s.campaignName ?? <span className="text-stone-400">House ad (no revenue)</span>}</td>
                <td className="pr-3">
                  <button className="rounded-full border border-stone-300 px-3 py-1 text-xs hover:bg-stone-100" disabled={busy} onClick={() => run(() => setSlideActive({ id: s.id, active: !s.isActive }), s.isActive ? "Slide switched off." : "Slide switched on.")}>
                    {s.isActive ? "On" : "Off"}
                  </button>
                </td>
                <td className="space-x-2 text-right">
                  <button className={btn2} onClick={() => setEditing(s)}>Edit</button>
                  <button
                    className={btn2}
                    disabled={busy}
                    onClick={() => window.confirm(`Delete "${s.headline}"? Views already recorded are kept.`) && run(() => deleteSlide({ id: s.id }), "Slide deleted.")}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="py-3 text-sm text-stone-500">No slides yet.</p>}
      </div>
      {editing && <SlideForm slide={editing === "new" ? null : editing} data={data} busy={busy} run={run} onClose={() => setEditing(null)} />}
    </div>
  )
}

function SlideForm({ slide, data, busy, run, onClose }: { slide: Slide | null; data: AdsData; busy: boolean; run: Ctx["run"]; onClose: () => void }) {
  const [f, setF] = useState({
    campaignId: slide?.campaignId ?? "",
    slideType: slide?.slideType ?? ("sponsor" as "sponsor" | "business"),
    headline: slide?.headline ?? "",
    tagline: slide?.tagline ?? "",
    description: slide?.description ?? "",
    mediaType: slide?.mediaType ?? ("image" as "image" | "video"),
    imageUrl: slide?.imageUrl ?? "",
    videoUrl: slide?.videoUrl ?? "",
    durationSeconds: String(slide?.durationSeconds ?? 15),
    displayOrder: String(slide?.displayOrder ?? 0),
    isActive: slide?.isActive ?? true,
    startsAt: toLocalInput(slide?.startsAt ?? null),
    endsAt: toLocalInput(slide?.endsAt ?? null),
  })
  const set = <K extends keyof typeof f>(key: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [key]: v }))

  return (
    <Modal title={slide ? "Edit slide" : "Add slide"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="Campaign" hint="Leave empty for a house ad (plays, earns nothing)." full>
          <select className={`${input} w-full`} value={f.campaignId} onChange={(e) => set("campaignId", e.target.value)}>
            <option value="">None (house ad)</option>
            {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.advertiser ? ` · ${c.advertiser}` : ""}</option>)}
          </select>
        </Field>
        <Field name="Type">
          <select className={`${input} w-full`} value={f.slideType} onChange={(e) => set("slideType", e.target.value as "sponsor" | "business")}>
            <option value="sponsor">Sponsor ad</option>
            <option value="business">Business promotion</option>
          </select>
        </Field>
        <Field name="Order" hint="Lower plays first within its tier.">
          <input className={`${input} w-full`} type="number" value={f.displayOrder} onChange={(e) => set("displayOrder", e.target.value)} />
        </Field>
        <Field name="Headline *" full><input className={`${input} w-full`} value={f.headline} onChange={(e) => set("headline", e.target.value)} /></Field>
        <Field name="Tagline" full><input className={`${input} w-full`} value={f.tagline} onChange={(e) => set("tagline", e.target.value)} /></Field>
        <Field name="Description" full><textarea className={`${input} w-full`} rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
        <Field name="Media" full>
          <div className="flex gap-2">
            {(["image", "video"] as const).map((m) => (
              <button key={m} type="button" onClick={() => set("mediaType", m)} className={f.mediaType === m ? btn : btn2}>{m === "image" ? "Image" : "Video"}</button>
            ))}
          </div>
        </Field>
        <Field name="Image link" hint="https:// link to the picture (also used as the video's cover)." full>
          <input className={`${input} w-full`} type="url" placeholder="https://…" value={f.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} />
        </Field>
        {f.mediaType === "video" && (
          <Field name="Video link" hint="MP4 or WebM. Counted as a view when it finishes." full>
            <input className={`${input} w-full`} type="url" placeholder="https://…" value={f.videoUrl} onChange={(e) => set("videoUrl", e.target.value)} />
          </Field>
        )}
        <Field name="Seconds on screen"><input className={`${input} w-full`} type="number" min={3} value={f.durationSeconds} onChange={(e) => set("durationSeconds", e.target.value)} /></Field>
        <div />
        <Field name="Starts (optional)"><input className={`${input} w-full`} type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
        <Field name="Ends (optional)"><input className={`${input} w-full`} type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Active (visible on kiosks)
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn2} onClick={onClose}>Cancel</button>
        <button
          className={btn}
          disabled={busy}
          onClick={() =>
            run(
              () => saveSlide({
                id: slide?.id,
                campaignId: f.campaignId || null,
                slideType: f.slideType,
                headline: f.headline,
                tagline: f.tagline,
                description: f.description,
                mediaType: f.mediaType,
                imageUrl: f.imageUrl,
                videoUrl: f.videoUrl,
                durationSeconds: Number(f.durationSeconds),
                displayOrder: Number(f.displayOrder),
                isActive: f.isActive,
                startsAt: fromLocalInput(f.startsAt),
                endsAt: fromLocalInput(f.endsAt),
              }),
              "Slide saved.",
              onClose,
            )
          }
        >
          Save slide
        </button>
      </div>
    </Modal>
  )
}

// ───────────────────────── Campaigns ─────────────────────────

type Campaign = AdsData["campaigns"][number]

function targetingText(c: Campaign, shopName: (id: string) => string) {
  const parts: string[] = []
  if (c.planKeys.length) parts.push(`plans: ${c.planKeys.join(", ")}`)
  if (c.businessTypes.length) parts.push(`types: ${c.businessTypes.join(", ")}`)
  if (c.include.length) parts.push(`only ${c.include.map(shopName).join(", ")}`)
  if (c.exclude.length) parts.push(`not ${c.exclude.map(shopName).join(", ")}`)
  return parts.length ? parts.join(" · ") : "All shops"
}

function CampaignsTab({ data, busy, run }: Ctx) {
  const [editing, setEditing] = useState<Campaign | "new" | null>(null)
  const shopName = (id: string) => data.shops.find((s) => s.id === id)?.name ?? "?"

  return (
    <div className={card}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-stone-500">One campaign per advertiser deal. Targeting decides which shops play it.</p>
        <button className={btn} onClick={() => setEditing("new")}>New campaign</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-left text-sm">
          <thead className="text-xs uppercase text-stone-400">
            <tr><th className={th}>Campaign</th><th className={th}>Advertiser</th><th className={th}>Rate / 1000</th><th className={th}>Budget used</th><th className={th}>Views</th><th className={th}>Shops</th><th className={th}>Status</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.campaigns.map((c) => {
              const cpm = c.cpmCents ?? data.tiers.find((t) => t.id === c.tierId)?.cpmCents ?? 0
              return (
                <tr key={c.id} className="align-top">
                  <td className="py-2 pr-3 text-stone-900">{c.name}<span className="block text-xs text-stone-500">{c.tierName ?? "No tier"} · {date(c.startsAt)} → {date(c.endsAt)}</span></td>
                  <td className="pr-3">{c.advertiser ?? "—"}</td>
                  <td className="pr-3 tabular-nums">{rand(cpm)}{c.cpmCents === null && <span className="block text-xs text-stone-500">from tier</span>}</td>
                  <td className="pr-3 tabular-nums">
                    {rand(c.spentCents)}{c.budgetCents !== null && <span className="text-stone-500"> / {rand(c.budgetCents)}</span>}
                    {c.budgetCents !== null && c.spentCents >= c.budgetCents && <span className="block text-xs text-red-600">Budget used up, stopped</span>}
                  </td>
                  <td className="pr-3 tabular-nums">{c.views.toLocaleString("en-ZA")}</td>
                  <td className="max-w-[220px] pr-3 text-xs text-stone-600">{targetingText(c, shopName)}{c.shareBps !== null && <span className="block">Shop share {c.shareBps / 100}%</span>}</td>
                  <td className="pr-3">
                    <select
                      className={input}
                      value={c.status}
                      disabled={busy}
                      onChange={(e) => run(() => setCampaignStatus({ id: c.id, status: e.target.value as CampaignStatus }), `${c.name} is now ${e.target.value}.`)}
                    >
                      {(["draft", "active", "paused", "ended"] as const).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="space-x-2 text-right">
                    <button className={btn2} onClick={() => setEditing(c)}>Edit</button>
                    <button
                      className={btn2}
                      disabled={busy}
                      onClick={() => window.confirm(`Delete campaign "${c.name}" and its slides?`) && run(() => deleteCampaign({ id: c.id }), "Campaign deleted.")}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {data.campaigns.length === 0 && <p className="py-3 text-sm text-stone-500">No campaigns yet.</p>}
      </div>
      {editing && <CampaignForm campaign={editing === "new" ? null : editing} data={data} busy={busy} run={run} onClose={() => setEditing(null)} />}
    </div>
  )
}

function CampaignForm({ campaign, data, busy, run, onClose }: { campaign: Campaign | null; data: AdsData; busy: boolean; run: Ctx["run"]; onClose: () => void }) {
  const [f, setF] = useState({
    name: campaign?.name ?? "",
    advertiser: campaign?.advertiser ?? "",
    tierId: campaign?.tierId ?? "",
    cpm: campaign?.cpmCents == null ? "" : String(campaign.cpmCents / 100),
    budget: campaign?.budgetCents == null ? "" : String(campaign.budgetCents / 100),
    startsAt: toLocalInput(campaign?.startsAt ?? null),
    endsAt: toLocalInput(campaign?.endsAt ?? null),
    status: (campaign?.status ?? "active") as CampaignStatus,
    share: pctText(campaign?.shareBps ?? null),
    planKeys: campaign?.planKeys ?? ([] as string[]),
    businessTypes: (campaign?.businessTypes ?? []).join(", "),
  })
  // per-shop: "" = follow the rules above, "include" = only these shops, "exclude" = never these
  const [shopMode, setShopMode] = useState<Record<string, "" | "include" | "exclude">>(() => {
    const m: Record<string, "" | "include" | "exclude"> = {}
    for (const id of campaign?.include ?? []) m[id] = "include"
    for (const id of campaign?.exclude ?? []) m[id] = "exclude"
    return m
  })
  const set = <K extends keyof typeof f>(key: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [key]: v }))
  const pick = (mode: "include" | "exclude") => Object.entries(shopMode).filter(([, m]) => m === mode).map(([id]) => id)

  return (
    <Modal title={campaign ? "Edit campaign" : "New campaign"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="Campaign name *" full><input className={`${input} w-full`} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field name="Advertiser" hint="Type a name. New names are added automatically." full>
          <input className={`${input} w-full`} value={f.advertiser} onChange={(e) => set("advertiser", e.target.value)} />
        </Field>
        <Field name="Tier" hint="Sets the rate and how early it plays.">
          <select className={`${input} w-full`} value={f.tierId} onChange={(e) => set("tierId", e.target.value)}>
            <option value="">None</option>
            {data.tiers.map((t) => <option key={t.id} value={t.id}>{t.name} · {rand(t.cpmCents)} / 1000</option>)}
          </select>
        </Field>
        <Field name="Rate per 1000 views (R)" hint="Empty = use the tier's rate.">
          <input className={`${input} w-full`} type="number" min={0} step="0.01" value={f.cpm} onChange={(e) => set("cpm", e.target.value)} />
        </Field>
        <Field name="Budget (R)" hint="Stops playing when this is spent. Empty = no cap.">
          <input className={`${input} w-full`} type="number" min={0} step="0.01" value={f.budget} onChange={(e) => set("budget", e.target.value)} />
        </Field>
        <Field name="Shop's share (%)" hint={`Empty = shop's own deal, else the default (${data.settings.defaultShareBps / 100}%).`}>
          <input className={`${input} w-full`} type="number" min={0} max={100} step="0.5" value={f.share} onChange={(e) => set("share", e.target.value)} />
        </Field>
        <Field name="Starts"><input className={`${input} w-full`} type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
        <Field name="Ends"><input className={`${input} w-full`} type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></Field>
        <Field name="Status">
          <select className={`${input} w-full`} value={f.status} onChange={(e) => set("status", e.target.value as CampaignStatus)}>
            {(["draft", "active", "paused", "ended"] as const).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>

        <div className="space-y-2 rounded-xl border border-stone-200 p-3 sm:col-span-2">
          <p className="text-sm font-semibold text-stone-800">Which shops play it</p>
          <p className="text-xs text-stone-500">Leave everything empty to play on every shop that shows platform ads. Filters combine (a shop must match all of them).</p>
          <div>
            <span className={label}>Only these plans</span>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {data.plans.map((p) => (
                <label key={p.key} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={f.planKeys.includes(p.key)} onChange={(e) => set("planKeys", e.target.checked ? [...f.planKeys, p.key] : f.planKeys.filter((k) => k !== p.key))} />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
          <Field name="Only these business types" hint="Comma separated, e.g. salon, barber. Set a shop's type on the Shops tab.">
            <input className={`${input} w-full`} value={f.businessTypes} onChange={(e) => set("businessTypes", e.target.value)} />
          </Field>
          <details>
            <summary className="cursor-pointer text-xs uppercase text-stone-400">Pick individual shops ({pick("include").length} only · {pick("exclude").length} never)</summary>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto text-sm">
              {data.shops.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2">
                  <span>{s.name} <span className="font-mono text-xs text-stone-500">{s.slug}</span></span>
                  <select className={input} value={shopMode[s.id] ?? ""} onChange={(e) => setShopMode((c) => ({ ...c, [s.id]: e.target.value as "" | "include" | "exclude" }))}>
                    <option value="">Follow the filters</option>
                    <option value="include">Only these shops</option>
                    <option value="exclude">Never this shop</option>
                  </select>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn2} onClick={onClose}>Cancel</button>
        <button
          className={btn}
          disabled={busy}
          onClick={() =>
            run(
              () => saveCampaign({
                id: campaign?.id,
                name: f.name,
                advertiser: f.advertiser,
                tierId: f.tierId || null,
                cpmRand: toNum(f.cpm),
                budgetRand: toNum(f.budget),
                startsAt: fromLocalInput(f.startsAt),
                endsAt: fromLocalInput(f.endsAt),
                status: f.status,
                sharePct: toNum(f.share),
                planKeys: f.planKeys,
                businessTypes: f.businessTypes.split(","),
                include: pick("include"),
                exclude: pick("exclude"),
              }),
              "Campaign saved.",
              onClose,
            )
          }
        >
          Save campaign
        </button>
      </div>
    </Modal>
  )
}

// ───────────────────────── Tiers ─────────────────────────

type Tier = AdsData["tiers"][number]

function TiersTab({ data, busy, run }: Ctx) {
  const [editing, setEditing] = useState<Tier | "new" | null>(null)
  return (
    <div className={card}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-stone-500">A tier is a price plus a priority. Higher priority plays earlier in each shop&apos;s loop.</p>
        <button className={btn} onClick={() => setEditing("new")}>New tier</button>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-stone-400"><tr><th className={th}>Tier</th><th className={th}>Rate / 1000 views</th><th className={th}>Priority</th><th className={th}>Notes</th><th /></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {data.tiers.map((t) => (
            <tr key={t.id}>
              <td className="py-2 pr-3 text-stone-900">{t.name}</td>
              <td className="pr-3 tabular-nums">{rand(t.cpmCents)}</td>
              <td className="pr-3 tabular-nums">{t.priority}</td>
              <td className="pr-3 text-stone-600">{t.description || "—"}</td>
              <td className="space-x-2 text-right">
                <button className={btn2} onClick={() => setEditing(t)}>Edit</button>
                <button className={btn2} disabled={busy} onClick={() => window.confirm(`Delete tier "${t.name}"? Campaigns on it keep running with no tier.`) && run(() => deleteTier({ id: t.id }), "Tier deleted.")}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.tiers.length === 0 && <p className="py-3 text-sm text-stone-500">No tiers yet. Make one (for example Standard and Featured) before creating campaigns.</p>}
      {editing && <TierForm tier={editing === "new" ? null : editing} busy={busy} run={run} onClose={() => setEditing(null)} />}
    </div>
  )
}

function TierForm({ tier, busy, run, onClose }: { tier: Tier | null; busy: boolean; run: Ctx["run"]; onClose: () => void }) {
  const [name, setName] = useState(tier?.name ?? "")
  const [cpm, setCpm] = useState(tier ? String(tier.cpmCents / 100) : "")
  const [priority, setPriority] = useState(String(tier?.priority ?? 0))
  const [description, setDescription] = useState(tier?.description ?? "")
  return (
    <Modal title={tier ? "Edit tier" : "New tier"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="Tier name *" full><input className={`${input} w-full`} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field name="Rate per 1000 views (R)"><input className={`${input} w-full`} type="number" min={0} step="0.01" value={cpm} onChange={(e) => setCpm(e.target.value)} /></Field>
        <Field name="Priority" hint="Higher plays first."><input className={`${input} w-full`} type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} /></Field>
        <Field name="Notes" full><textarea className={`${input} w-full`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn2} onClick={onClose}>Cancel</button>
        <button className={btn} disabled={busy} onClick={() => run(() => saveTier({ id: tier?.id, name, cpmRand: Number(cpm || 0), priority: Number(priority), description }), "Tier saved.", onClose)}>Save tier</button>
      </div>
    </Modal>
  )
}

// ───────────────────────── Billing ─────────────────────────

function BillingTab({ data, busy, run }: Ctx) {
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const [from, setFrom] = useState(iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))))
  const [to, setTo] = useState(iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))))
  const sum = (rows: Array<{ shopCents: number }>) => rows.reduce((n, r) => n + r.shopCents, 0)

  return (
    <div className="space-y-5">
      <div className={card}>
        <p className="mb-1 text-sm font-semibold text-stone-800">Work out billing for a period</p>
        <p className="mb-2 text-xs text-stone-500">
          Totals each campaign&apos;s views and splits the money with the shops that played them. Run it as often as you like for the same dates: rows already invoiced or paid are never changed, and overlapping periods are refused so nothing is billed twice.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field name="From (first day)"><input className={input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field name="To (not included)"><input className={input} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <button className={btn} disabled={busy} onClick={() => run(() => generateBilling({ from, to }), "Billing worked out for that period.")}>Work out billing</button>
        </div>
      </div>

      <div className={card}>
        <p className="mb-2 text-sm font-semibold text-stone-800">What advertisers owe you</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="text-xs uppercase text-stone-400"><tr><th className={th}>Period</th><th className={th}>Campaign</th><th className={th}>Advertiser</th><th className={th}>Views</th><th className={th}>Amount</th><th className={th}>Status</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {data.billing.map((b) => (
                <tr key={b.id}>
                  <td className="py-2 pr-3">{date(b.periodStart)} – {lastDay(b.periodEnd)}</td>
                  <td className="pr-3 text-stone-900">{b.campaign}</td>
                  <td className="pr-3">{b.advertiser ?? "—"}</td>
                  <td className="pr-3 tabular-nums">{b.views.toLocaleString("en-ZA")}</td>
                  <td className="pr-3 tabular-nums">{rand(b.grossCents)}</td>
                  <td className="pr-3">
                    <select className={input} value={b.status} disabled={busy} onChange={(e) => run(() => setBillingStatus({ id: b.id, status: e.target.value as "pending" | "invoiced" | "paid" }), "Status updated.")}>
                      <option value="pending">pending</option><option value="invoiced">invoiced</option><option value="paid">paid</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.billing.length === 0 && <p className="py-3 text-sm text-stone-500">Nothing billed yet.</p>}
        </div>
      </div>

      <div className={card}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-stone-800">What you owe shops (their share)</p>
          <span className="text-xs text-stone-500">Not yet paid: {rand(sum(data.earnings.filter((e) => e.status !== "paid")))}</span>
        </div>
        <p className="mb-2 text-xs text-stone-500">Mark &quot;credited&quot; once you take it off the shop&apos;s own invoice, and &quot;paid&quot; once it&apos;s settled.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="text-xs uppercase text-stone-400"><tr><th className={th}>Period</th><th className={th}>Shop</th><th className={th}>Campaign</th><th className={th}>Views</th><th className={th}>Ad revenue</th><th className={th}>Shop share</th><th className={th}>Yours</th><th className={th}>Status</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {data.earnings.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-3">{date(e.periodStart)} – {lastDay(e.periodEnd)}</td>
                  <td className="pr-3 text-stone-900">{e.shop}</td>
                  <td className="pr-3">{e.campaign}</td>
                  <td className="pr-3 tabular-nums">{e.views.toLocaleString("en-ZA")}</td>
                  <td className="pr-3 tabular-nums">{rand(e.grossCents)}</td>
                  <td className="pr-3 tabular-nums">{rand(e.shopCents)}</td>
                  <td className="pr-3 tabular-nums">{rand(e.platformCents)}</td>
                  <td className="pr-3">
                    <select className={input} value={e.status} disabled={busy} onChange={(ev) => run(() => setEarningStatus({ id: e.id, status: ev.target.value as "pending" | "credited" | "paid" }), "Status updated.")}>
                      <option value="pending">pending</option><option value="credited">credited</option><option value="paid">paid</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.earnings.length === 0 && <p className="py-3 text-sm text-stone-500">No shop earnings yet.</p>}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────── Shops ─────────────────────────

type Shop = AdsData["shops"][number]

function ShopsTab({ data, busy, run }: Ctx) {
  return (
    <div className={`${card} overflow-x-auto`}>
      <p className="mb-2 text-sm text-stone-500">
        Whether each shop plays platform ads. &quot;Follow plan&quot; uses the shop&apos;s plan; On / Off force it for just that shop (for example, sell the opt-out to a free shop). A shop&apos;s opt-out only counts while it has the opt-out.
      </p>
      <table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="text-xs uppercase text-stone-400">
          <tr><th className={th}>Shop</th><th className={th}>Shows platform ads?</th><th className={th}>Own ads</th><th className={th}>Can opt out</th><th className={th}>Opted out</th><th className={th}>Business type</th><th className={th}>Their share %</th><th /></tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {data.shops.map((s) => <ShopRow key={`${s.id}:${s.allowPlatformAds}:${s.businessType}:${s.shareBps}`} shop={s} busy={busy} run={run} registered={data.modulesRegistered} defaultShare={data.settings.defaultShareBps} />)}
        </tbody>
      </table>
      {data.shops.length === 0 && <p className="py-3 text-sm text-stone-500">No shops yet.</p>}
    </div>
  )
}

function ModuleSelect({ value, effective, disabled, onChange }: { value: Mode; effective: boolean; disabled: boolean; onChange: (m: Mode) => void }) {
  return (
    <div className="flex items-center gap-2">
      <select className={input} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Mode)}>
        <option value="plan">Follow plan</option><option value="on">Force on</option><option value="off">Force off</option>
      </select>
      <Pill tone={effective ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}>{effective ? "On" : "Off"}</Pill>
    </div>
  )
}

function ShopRow({ shop, busy, run, registered, defaultShare }: { shop: Shop; busy: boolean; run: Ctx["run"]; registered: boolean; defaultShare: number }) {
  const [allow, setAllow] = useState(shop.allowPlatformAds)
  const [type, setType] = useState(shop.businessType)
  const [share, setShare] = useState(pctText(shop.shareBps))
  const dirty = allow !== shop.allowPlatformAds || type !== shop.businessType || share !== pctText(shop.shareBps)
  const why = shop.status !== "active" ? `Shop is ${shop.status}` : !shop.kioskOn ? "Kiosk is off" : !allow && shop.optOutOn ? "Opted out" : "Platform ads are off for everyone"

  return (
    <tr className="align-top">
      <td className="py-3 pr-3"><span className="text-stone-900">{shop.name}</span><span className="block text-xs text-stone-500">/{shop.slug} · {shop.plan}</span></td>
      <td className="pr-3">{shop.showsPlatformAds ? <Pill tone="bg-emerald-100 text-emerald-800">Yes</Pill> : <span><Pill tone="bg-stone-100 text-stone-600">No</Pill><span className="block text-xs text-stone-500">{why}</span></span>}</td>
      <td className="pr-3"><ModuleSelect value={shop.adsMode} effective={shop.adsOn} disabled={busy || !registered} onChange={(mode) => run(() => setShopAdModule({ tenantId: shop.id, moduleKey: "kiosk_ads", mode }), `${shop.name}: own ads updated.`)} /></td>
      <td className="pr-3"><ModuleSelect value={shop.optMode} effective={shop.optOutOn} disabled={busy || !registered} onChange={(mode) => run(() => setShopAdModule({ tenantId: shop.id, moduleKey: "platform_ads_opt_out", mode }), `${shop.name}: opt-out updated.`)} /></td>
      <td className="pr-3">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={!allow} onChange={(e) => setAllow(!e.target.checked)} /> Opted out
        </label>
        {!allow && !shop.optOutOn && <span className="block text-xs text-amber-700">Ignored: no opt-out on their plan</span>}
      </td>
      <td className="pr-3"><input className={`${input} w-28`} placeholder="e.g. salon" value={type} onChange={(e) => setType(e.target.value)} /></td>
      <td className="pr-3"><input className={`${input} w-20`} type="number" min={0} max={100} step="0.5" placeholder={`${defaultShare / 100}`} value={share} onChange={(e) => setShare(e.target.value)} /></td>
      <td className="text-right">
        <button
          className={btn}
          disabled={busy || !dirty}
          onClick={() => run(() => saveShopAdSettings({ tenantId: shop.id, allowPlatformAds: allow, businessType: type, sharePct: toNum(share) }), `${shop.name} saved.`)}
        >
          Save
        </button>
      </td>
    </tr>
  )
}

// ───────────────────────── Preview ─────────────────────────

function PreviewTab({ data, busy, setMsg, start }: Ctx) {
  const [shopId, setShopId] = useState(data.shops[0]?.id ?? "")
  const [ads, setAds] = useState<PreviewAd[] | null>(null)
  const total = (ads ?? []).reduce((n, a) => n + a.durationSeconds, 0)

  return (
    <div className={card}>
      <p className="mb-2 text-sm text-stone-500">See exactly what a shop&apos;s kiosk would be sent right now, in play order. Uses the same call the kiosk makes, so it respects targeting, budgets, dates and opt-outs.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select className={input} value={shopId} onChange={(e) => { setShopId(e.target.value); setAds(null) }}>
          {data.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button
          className={btn}
          disabled={busy || !shopId}
          onClick={() => {
            setMsg(null)
            start(async () => {
              const res = await previewShop({ tenantId: shopId })
              if (res.success) setAds(res.ads)
              else setMsg({ ok: false, text: res.error })
            })
          }}
        >
          Show what plays
        </button>
        {ads && <span className="text-xs text-stone-500">{ads.length} slides · one loop ≈ {total}s</span>}
      </div>
      {ads && ads.length === 0 && <p className="py-3 text-sm text-stone-500">Nothing would play for this shop.</p>}
      <ol className="space-y-2">
        {(ads ?? []).map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-xl border border-stone-200 p-2 text-sm">
            <span className="w-6 text-center text-stone-400 tabular-nums">{a.position}</span>
            {a.imageUrl ? <img src={a.imageUrl} alt="" className="h-12 w-20 rounded-lg object-cover" /> : <div className="h-12 w-20 rounded-lg bg-stone-100" />}
            <div className="flex-1">
              <p className="text-stone-900">{a.headline}</p>
              {a.tagline && <p className="text-xs text-stone-500">{a.tagline}</p>}
            </div>
            <Pill tone={a.source === "platform" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}>{a.source === "platform" ? "Platform ad" : "Shop's own"}</Pill>
            <span className="w-12 text-right text-xs text-stone-500 tabular-nums">{a.durationSeconds}s</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ───────────────────────── Settings ─────────────────────────

function SettingsTab({ data, busy, run }: Ctx) {
  const [enabled, setEnabled] = useState(data.settings.enabled)
  const [everyN, setEveryN] = useState(String(data.settings.everyN))
  const [share, setShare] = useState(String(data.settings.defaultShareBps / 100))
  return (
    <div className={`${card} max-w-xl space-y-3`}>
      <label className="flex items-center gap-2 text-sm text-stone-800">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Play platform ads on shop kiosks <span className="text-xs text-stone-500">(master switch, turns them off everywhere)</span>
      </label>
      <Field name="Platform ad slot" hint="A platform ad takes at most 1 in every N slides, so shops keep their own space. 4 means 1 in 4.">
        <input className={`${input} w-24`} type="number" min={2} max={50} value={everyN} onChange={(e) => setEveryN(e.target.value)} />
      </Field>
      <Field name="Default shop share (%)" hint="What a shop earns of the advertiser's money unless the campaign or the shop has its own number. Applies to views from now on; views already counted keep the share they had.">
        <input className={`${input} w-24`} type="number" min={0} max={100} step="0.5" value={share} onChange={(e) => setShare(e.target.value)} />
      </Field>
      <button className={btn} disabled={busy} onClick={() => run(() => saveGlobalSettings({ enabled, everyN: Number(everyN), defaultSharePct: Number(share) }), "Settings saved.")}>Save settings</button>
    </div>
  )
}
