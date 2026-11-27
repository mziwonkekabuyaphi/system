// lib/domains/resolve-site-subdomain.ts
//
// "Is this free subdomain a live site?" for the middleware. Same approach as resolve-custom-domain:
// a plain fetch to the REST endpoint (small, edge-safe), service role only, short cache.

const HIT_TTL_MS = 60_000
const MISS_TTL_MS = 15_000
const MAX_ENTRIES = 500
const TIMEOUT_MS = 2_500

export interface ResolvedSite {
  slug: string
  /** The shop's active primary custom domain, if it has one. The free address redirects there. */
  primaryDomain: string | null
}

const cache = new Map<string, { site: ResolvedSite | null; expiresAt: number }>()

export type ResolveSiteResult = { ok: true; site: ResolvedSite | null } | { ok: false }

export async function resolveSiteSubdomain(slug: string): Promise<ResolveSiteResult> {
  const hit = cache.get(slug)
  if (hit && Date.now() < hit.expiresAt) return { ok: true, site: hit.site }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { ok: false }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${url}/rest/v1/rpc/resolve_site_subdomain`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_slug: slug }),
      signal: controller.signal,
      cache: "no-store",
    })
    if (!res.ok) return { ok: false }
    const data = (await res.json()) as { slug?: unknown; primary_domain?: unknown } | null
    const site: ResolvedSite | null =
      data && typeof data.slug === "string" && data.slug
        ? { slug: data.slug, primaryDomain: typeof data.primary_domain === "string" && data.primary_domain ? data.primary_domain : null }
        : null

    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(slug, { site, expiresAt: Date.now() + (site ? HIT_TTL_MS : MISS_TTL_MS) })
    return { ok: true, site }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}
