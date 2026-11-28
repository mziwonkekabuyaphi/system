// lib/site/host-slug.ts
//
// "Which shop does this request's hostname belong to?" for routes that run AFTER the middleware
// (robots.txt, sitemap.xml, the visit counter). Same rule as the middleware: the shop comes from the
// hostname and the database, never from anything the visitor sends. Null on our own hostnames.

import { isPlatformHostname, normalizeHost } from "@/lib/domains/custom-domain-routing"
import { resolveCustomDomain } from "@/lib/domains/resolve-custom-domain"
import { resolveSiteSubdomain } from "@/lib/domains/resolve-site-subdomain"
import { isSitesHostname, siteSlugFromHost } from "@/lib/domains/sites-domain"

export async function slugForRequestHost(rawHost: string | null | undefined): Promise<string | null> {
  const host = normalizeHost(rawHost)
  if (!host) return null

  if (isSitesHostname(host)) {
    const slug = siteSlugFromHost(host)
    if (!slug) return null
    const r = await resolveSiteSubdomain(slug)
    return r.ok && r.site ? r.site.slug : null
  }
  if (isPlatformHostname(host)) return null

  const r = await resolveCustomDomain(host)
  return r.ok ? r.slug : null
}
