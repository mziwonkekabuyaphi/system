// app/admin/website/actions.ts
"use server"

/**
 * Server Actions for Settings > Website (ZozoWeb: Shisha, Events and Booking templates).
 * Same layers as the Custom domain actions:
 *   1. requireTenantPermission("settings.manage"): tenantId comes from the membership, never the browser.
 *   2. isModuleEnabled(tenantId, "web"): switched on by the platform admin.
 *   3. Every query runs on the service-role client and is filtered by tenant_id.
 * Everything saved goes through sanitizeContent, so the public page can't be handed raw input.
 * Publishing copies draft -> published and refreshes the cached /site/[slug] page.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { TEMPLATES, isTemplate, sanitizeContent, type SiteContent, type SiteTemplate } from "@/lib/site/types"

type Fail = { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scope = { ok: true; db: ServerClient; tenantId: string; slug: string; name: string } | Fail

const GENERIC = "Something went wrong. Please try again."
const fail = (error: string): Fail => ({ ok: false, error })

async function scoped(): Promise<Scope> {
  const check = await requireTenantPermission("settings.manage")
  if (!check.ok) return fail(check.error)
  const tenantId = check.member.tenantId
  if (!(await isModuleEnabled(tenantId, "web"))) return fail("Website isn't switched on for your business.")
  const db = getSupabaseServerClient()
  if (!db) return fail("Supabase isn't configured.")
  const { data: tenant } = await db.from("tenants").select("name, slug").eq("id", tenantId).maybeSingle()
  if (!tenant?.slug) return fail("Your business has no web address (slug) yet.")
  return { ok: true, db, tenantId, slug: tenant.slug as string, name: tenant.name as string }
}

export interface WebsiteState {
  slug: string
  /** Template being edited. */
  template: SiteTemplate
  /** Templates this shop can use: the module each one reads must be switched on. */
  availableTemplates: SiteTemplate[]
  draft: SiteContent
  isPublished: boolean
  publishedAt: string | null
  /** The draft differs from what visitors see (or nothing is published yet). */
  hasUnpublishedChanges: boolean
}

async function availableTemplates(tenantId: string): Promise<SiteTemplate[]> {
  const on = await Promise.all(TEMPLATES.map(async (t) => (await Promise.all(t.modules.map((m) => isModuleEnabled(tenantId, m)))).some(Boolean)))
  return TEMPLATES.filter((_, i) => on[i]).map((t) => t.id)
}

async function readState(s: Extract<Scope, { ok: true }>): Promise<WebsiteState> {
  const { data } = await s.db
    .from("tenant_sites")
    .select("draft, published, is_published, published_at, template, published_template")
    .eq("tenant_id", s.tenantId)
    .maybeSingle()
  const available = await availableTemplates(s.tenantId)
  const template: SiteTemplate = isTemplate(data?.template) ? data.template : (available[0] ?? "shisha")
  const draft = sanitizeContent(data?.draft, s.name, template)
  const isPublished = Boolean(data?.is_published && data?.published)
  const liveTemplate: SiteTemplate = isTemplate(data?.published_template) ? data.published_template : template
  const published = isPublished ? sanitizeContent(data?.published, s.name, liveTemplate) : null
  return {
    slug: s.slug,
    template,
    availableTemplates: available,
    draft,
    isPublished,
    publishedAt: (data?.published_at as string | null) ?? null,
    hasUnpublishedChanges: !published || liveTemplate !== template || JSON.stringify(published) !== JSON.stringify(draft),
  }
}

/** The template must be a known one AND its module must be on for this shop. */
async function checkedTemplate(s: Extract<Scope, { ok: true }>, input: unknown): Promise<SiteTemplate | Fail> {
  if (!isTemplate(input)) return fail("Pick a template.")
  if (!(await availableTemplates(s.tenantId)).includes(input)) return fail("That template needs a module that isn't switched on for your business.")
  return input
}

export async function getWebsite(): Promise<{ ok: true; state: WebsiteState } | Fail> {
  const s = await scoped()
  if (!s.ok) return s
  return { ok: true, state: await readState(s) }
}

export async function saveWebsiteDraft(input: unknown, templateInput: unknown): Promise<{ ok: true; state: WebsiteState } | Fail> {
  const s = await scoped()
  if (!s.ok) return s
  const template = await checkedTemplate(s, templateInput)
  if (typeof template !== "string") return template
  const draft = sanitizeContent(input, s.name, template)
  const { error } = await s.db
    .from("tenant_sites")
    .upsert({ tenant_id: s.tenantId, template, draft, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" })
  if (error) {
    console.error("[website] save draft failed", error.message)
    return fail(GENERIC)
  }
  return { ok: true, state: await readState(s) }
}

/** Saves what's on screen, then publishes exactly that. */
export async function publishWebsite(input: unknown, templateInput: unknown): Promise<{ ok: true; state: WebsiteState } | Fail> {
  const s = await scoped()
  if (!s.ok) return s
  const template = await checkedTemplate(s, templateInput)
  if (typeof template !== "string") return template
  const content = sanitizeContent(input, s.name, template)
  const now = new Date().toISOString()
  const { error } = await s.db.from("tenant_sites").upsert(
    { tenant_id: s.tenantId, template, published_template: template, draft: content, published: content, is_published: true, published_at: now, updated_at: now },
    { onConflict: "tenant_id" },
  )
  if (error) {
    console.error("[website] publish failed", error.message)
    return fail(GENERIC)
  }
  revalidatePath(`/site/${s.slug}`)
  await cleanUnusedImages(s, content)
  return { ok: true, state: await readState(s) }
}

export async function unpublishWebsite(): Promise<{ ok: true; state: WebsiteState } | Fail> {
  const s = await scoped()
  if (!s.ok) return s
  const { error } = await s.db
    .from("tenant_sites")
    .update({ is_published: false, updated_at: new Date().toISOString() })
    .eq("tenant_id", s.tenantId)
  if (error) {
    console.error("[website] unpublish failed", error.message)
    return fail(GENERIC)
  }
  revalidatePath(`/site/${s.slug}`)
  return { ok: true, state: await readState(s) }
}

// ---------------------------------------------------------------------------
// Photos. The browser never gets storage access: the upload runs here on the service role, only after
// the owner's permission + module are checked, and always under {tenant_id}/ so shops can't touch each
// other's files. The bucket (site-images) has no write policies at all. Unused photos are cleaned up on Publish.
// ---------------------------------------------------------------------------

const BUCKET = "site-images"
const MAX_BYTES = 3 * 1024 * 1024
const MAX_FILES_PER_TENANT = 40
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

export async function uploadSiteImage(formData: FormData): Promise<{ ok: true; url: string } | Fail> {
  const s = await scoped()
  if (!s.ok) return s

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return fail("Choose a photo to upload.")
  const ext = TYPES[file.type]
  if (!ext) return fail("Use a PNG, JPG or WebP photo.")
  if (file.size > MAX_BYTES) return fail("Each photo must be under 3 MB.")

  const { data: existing } = await s.db.storage.from(BUCKET).list(s.tenantId, { limit: MAX_FILES_PER_TENANT + 1 })
  if ((existing?.length ?? 0) >= MAX_FILES_PER_TENANT) return fail("You've reached the photo limit. Remove some you no longer use first.")

  const path = `${s.tenantId}/${crypto.randomUUID()}.${ext}`
  const { error } = await s.db.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (error) {
    console.error("[website] photo upload failed", error.message)
    return fail(GENERIC)
  }
  return { ok: true, url: s.db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl }
}

/**
 * After a Publish: delete this shop's uploaded photos that nothing uses any more. A photo is only
 * deleted once it is older than an hour and is in neither the published page nor the draft, so a
 * photo removed in the editor never breaks the live site, and one just uploaded in another tab is safe.
 */
async function cleanUnusedImages(s: Extract<Scope, { ok: true }>, used: SiteContent): Promise<void> {
  try {
    const keep = new Set([used.heroImageUrl, ...used.gallery].filter(Boolean).map((u) => decodeURIComponent(u.split("?")[0]).split(`/${BUCKET}/`)[1]))
    const { data: files } = await s.db.storage.from(BUCKET).list(s.tenantId, { limit: 200 })
    const cutoff = Date.now() - 3_600_000
    const stale = (files ?? [])
      .filter((f) => f.name && !keep.has(`${s.tenantId}/${f.name}`) && Date.parse(f.created_at ?? "") < cutoff)
      .map((f) => `${s.tenantId}/${f.name}`)
    if (stale.length > 0) await s.db.storage.from(BUCKET).remove(stale)
  } catch (e) {
    console.error("[website] photo cleanup failed", e)
  }
}

// ---------------------------------------------------------------------------
// "Write my website for me". Returns a SUGGESTION only: nothing is saved or published. The editor puts it
// in the three text boxes and the owner decides. The shop's facts come from the database (by the signed-in
// membership's tenant id), never from the browser; the owner's notes are passed to the model as data.
// ---------------------------------------------------------------------------

const lastCopyAt = new Map<string, number>()
const COPY_COOLDOWN_MS = 8_000

const AI_BLOCKED: Record<string, string> = {
  not_configured: "AI isn't set up for your business yet. Turn it on in Settings > AI.",
  disabled: "AI is switched off for your business. Turn it on in Settings > AI.",
  no_key: "Add your AI key in Settings > AI first.",
  key_invalid: "Your AI key was rejected. Check it in Settings > AI.",
  budget_exceeded: "This month's AI limit has been reached.",
  tenant_inactive: "AI isn't available for your business right now.",
}

export async function generateWebsiteCopy(input: {
  template: unknown
  tone: unknown
  language: unknown
  notes: unknown
}): Promise<{ ok: true; copy: WebsiteCopy } | Fail> {
  const s = await scoped()
  if (!s.ok) return s

  const template = await checkedTemplate(s, input.template)
  if (typeof template !== "string") return template
  const tone: CopyTone = COPY_TONES.find((t) => t === input.tone) ?? "friendly"
  const language: CopyLanguage = COPY_LANGUAGES.find((l) => l === input.language) ?? "English"
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 300) : ""

  const now = Date.now()
  if (now - (lastCopyAt.get(s.tenantId) ?? 0) < COPY_COOLDOWN_MS) return fail("Give it a few seconds, then try again.")
  lastCopyAt.set(s.tenantId, now)

  const site = await loadSiteFacts(s.tenantId, template)
  if (!site) return fail(GENERIC)

  try {
    return { ok: true, copy: await writeWebsiteCopy(site, { tone, language, notes }) }
  } catch (error) {
    if (error instanceof AiUnavailableError) return fail(AI_BLOCKED[error.reason] ?? "AI isn't available right now.")
    console.error("[website] write copy failed", error instanceof Error ? error.message : "unknown error")
    return fail("We couldn't write it just now. Please try again in a moment.")
  }
}

// ---------------------------------------------------------------------------
// Visit stats (read only). Counters are written by /api/site/event; the shop is checked here by the
// signed-in membership, so an owner can only ever read their own shop's numbers.
// ---------------------------------------------------------------------------

export interface WebsiteStats {
  /** Oldest first, one entry per day for the last 30 days (UTC days), zeros filled in. */
  days: { day: string; views: number; whatsappTaps: number }[]
}

export async function getWebsiteStats(): Promise<{ ok: true; stats: WebsiteStats } | Fail> {
  const s = await scoped()
  if (!s.ok) return s
  const today = new Date()
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29))
  const fromKey = from.toISOString().slice(0, 10)

  const { data, error } = await s.db.from("site_stats_daily").select("day, views, whatsapp_taps").eq("tenant_id", s.tenantId).gte("day", fromKey)
  if (error) {
    console.error("[website] stats read failed", error.message)
    return fail(GENERIC)
  }
  const byDay = new Map((data ?? []).map((r) => [String(r.day), r]))
  const days = Array.from({ length: 30 }, (_, i) => {
    const key = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10)
    const row = byDay.get(key)
    return { day: key, views: Number(row?.views) || 0, whatsappTaps: Number(row?.whatsapp_taps) || 0 }
  })
  return { ok: true, stats: { days } }
}
