// app/robots.ts
//
// robots.txt that depends on the hostname. A shop's own domain or free subdomain gets rules for ITS site
// and points at ITS sitemap. Our own hostnames keep staff and internal areas out of search results.

import { headers } from "next/headers"
import type { MetadataRoute } from "next"

import { slugForRequestHost } from "@/lib/site/host-slug"

export const dynamic = "force-dynamic"

export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = (await headers()).get("host") ?? ""
  const slug = await slugForRequestHost(host)

  if (slug) {
    return {
      rules: { userAgent: "*", allow: "/", disallow: ["/web", "/kiosk", "/display", "/clock", "/scan", "/api", "/pay"] },
      sitemap: `https://${host}/sitemap.xml`,
    }
  }
  return {
    rules: { userAgent: "*", disallow: ["/admin", "/platform", "/api", "/auth", "/onboarding", "/site-preview"] },
  }
}
