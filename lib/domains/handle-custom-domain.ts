// lib/domains/handle-custom-domain.ts
//
// What middleware.ts does for a request that arrived on a shop's own domain (anything that
// isn't one of our hostnames). Session handling is skipped on purpose: these are public,
// anonymous pages, and staff sign in on the platform domain only.

import { NextResponse, type NextRequest } from "next/server"

import { platformOrigin, routeCustomDomainPath } from "./custom-domain-routing"
import { resolveCustomDomain } from "./resolve-custom-domain"

function page(status: number, title: string, body: string, extra?: Record<string, string>): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f6f5f2;color:#222}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#666;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store", ...extra },
  })
}

export const notFoundPage = () => page(404, "This address isn’t set up yet", "The business that owns this address hasn’t finished connecting it. Please check the link and try again.")
export const unavailablePage = () => page(503, "Temporarily unavailable", "We couldn’t load this page just now. Please try again in a moment.", { "retry-after": "5" })

/** Route a request for ONE shop's public pages (the slug is ours, never the visitor's). Shared with the free-subdomain handler. */
export function serveForSlug(request: NextRequest, slug: string): NextResponse {
  const { pathname, search } = request.nextUrl
  const route = routeCustomDomainPath(pathname, slug)

  switch (route.kind) {
    case "pass":
      return NextResponse.next()
    case "rewrite": {
      const url = request.nextUrl.clone()
      url.pathname = route.pathname
      return NextResponse.rewrite(url)
    }
    case "platform": {
      const origin = platformOrigin()
      if (!origin) return notFoundPage()
      return NextResponse.redirect(`${origin}${pathname}${search}`, 308)
    }
    default:
      return notFoundPage()
  }
}

export async function handleCustomDomain(request: NextRequest, host: string): Promise<NextResponse> {
  const resolved = await resolveCustomDomain(host)
  if (!resolved.ok) return unavailablePage()
  if (!resolved.slug) return notFoundPage()
  return serveForSlug(request, resolved.slug)
}
