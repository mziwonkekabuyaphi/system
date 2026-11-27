// lib/domains/handle-sites-domain.ts
//
// What middleware.ts does for a request on the free sites domain ({slug}.<sites domain>):
//   apex / www / reserved / odd names  -> the platform's front page
//   unknown, module off, or unpublished -> "not set up yet" (404)
//   shop has its own active domain      -> redirect there (one site for Google, not two)
//   otherwise                           -> the shop's public pages, routed exactly like a custom domain
// Session handling is skipped on purpose: these are public, anonymous pages.

import { NextResponse, type NextRequest } from "next/server"

import { platformOrigin } from "./custom-domain-routing"
import { notFoundPage, serveForSlug, unavailablePage } from "./handle-custom-domain"
import { resolveSiteSubdomain } from "./resolve-site-subdomain"
import { siteSlugFromHost } from "./sites-domain"

export async function handleSitesDomain(request: NextRequest, host: string): Promise<NextResponse> {
  const slug = siteSlugFromHost(host)
  if (!slug) {
    const origin = platformOrigin()
    return origin ? NextResponse.redirect(origin, 307) : notFoundPage()
  }

  const resolved = await resolveSiteSubdomain(slug)
  if (!resolved.ok) return unavailablePage()
  if (!resolved.site) return notFoundPage()

  const { pathname, search } = request.nextUrl
  if (resolved.site.primaryDomain) {
    // Permanent, but browsers may only remember it briefly: the shop might disconnect its domain later.
    const res = NextResponse.redirect(`https://${resolved.site.primaryDomain}${pathname}${search}`, 308)
    res.headers.set("cache-control", "public, max-age=300")
    return res
  }

  return serveForSlug(request, resolved.site.slug)
}
