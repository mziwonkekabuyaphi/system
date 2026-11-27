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
import { freeSiteHost } from "@/lib/domains/sites-domain"
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
  /** The free address (https://slug.<sites domain>), or null when ZozoWeb's domain isn't configured. */
  freeAddress: string | null
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
    freeAddress: freeSiteHost(s.slug) ? `https://${freeSiteHost(s.slug)}` : null,
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
// Photos. The owner picks a file; we check it, store it in the public "site-assets" bucket under
// {tenant_id}/..., and hand back its https URL, which then goes through sanitizeContent like any other.
// ---------------------------------------------------------------------------

const MAX_BYTES = 3 * 1024 * 1024
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

function looksLike(type: string, b: Uint8Array): boolean {
  if (type === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  // WEBP: "RIFF" .... "WEBP"
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
}

export async function uploadSiteImage(formData: FormData): Promise<{ ok: true; url: string } | Fail> {
  const s = await scoped()
  if (!s.ok) return s
  const file = formData.get("file")
  if (!(file instanceof File)) return fail("Choose a photo first.")
  const ext = TYPES[file.type]
  if (!ext) return fail("Use a PNG, JPG or WEBP photo.")
  if (file.size > MAX_BYTES) return fail("That photo is over 3 MB. Please use a smaller one.")
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < 12 || !looksLike(file.type, bytes)) return fail("That file doesn't look like a real photo.")

  const path = `${s.tenantId}/${crypto.randomUUID()}.${ext}`
  const { error } = await s.db.storage.from("site-assets").upload(path, bytes, { contentType: file.type, upsert: false })
  if (error) {
    console.error("[website] photo upload failed", error.message)
    return fail(GENERIC)
  }
  return { ok: true, url: s.db.storage.from("site-assets").getPublicUrl(path).data.publicUrl }
}
