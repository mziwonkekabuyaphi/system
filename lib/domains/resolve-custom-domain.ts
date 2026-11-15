// lib/domains/resolve-custom-domain.ts
//
// "Which shop is this hostname?" for the middleware. Asks the database function
// public.resolve_custom_domain, which answers only when the domain is ACTIVE, the shop is
// active AND the Custom domain module is switched on, so switching the module off stops a
// domain at once (within the cache window).
//
// Plain fetch to the REST endpoint instead of the Supabase client: this runs on every request to
// a custom domain, so it stays small and edge-safe. The function is callable by the service role
// only, which is why the service key is used here (server-side only, never sent to a browser).

const HIT_TTL_MS = 60_000
const MISS_TTL_MS = 15_000
const MAX_ENTRIES = 500
const TIMEOUT_MS = 2_500

const cache = new Map<string, { slug: string | null; expiresAt: number }>()

export type ResolveResult =
  | { ok: true; slug: string | null } // slug null = no such active domain
  | { ok: false } // couldn't find out (never cached, so a blip doesn't stick)

export async function resolveCustomDomain(host: string): Promise<ResolveResult> {
  const hit = cache.get(host)
  if (hit && Date.now() < hit.expiresAt) return { ok: true, slug: hit.slug }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { ok: false }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${url}/rest/v1/rpc/resolve_custom_domain`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_host: host }),
      signal: controller.signal,
      cache: "no-store",
    })
    if (!res.ok) return { ok: false }
    const data: unknown = await res.json()
    const slug = typeof data === "string" && data.length > 0 ? data : null

    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(host, { slug, expiresAt: Date.now() + (slug ? HIT_TTL_MS : MISS_TTL_MS) })
    return { ok: true, slug }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}
