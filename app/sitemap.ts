// app/sitemap.ts
//
// sitemap.xml that depends on the hostname. A shop's own domain or free subdomain lists its landing page
// (when a site is published). Our own hostnames list just the platform's front page.

import { headers } from "next/headers"
import type { MetadataRoute } from "next"

import { platformOrigin } from "@/lib/domains/custom-domain-routing"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { slugForRequestHost } from "@/lib/site/host-slug"

export const dynamic = "force-dynamic"

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = (await headers()).get("host") ?? ""
  const slug = await slugForRequestHost(host)

  if (!slug) {
    const origin = platformOrigin()
    return origin ? [{ url: `${origin}/` }] : []
  }

  const db = getSupabaseServerClient()
  if (!db) return []
  const { data: tenant } = await db.from("tenants").select("id").eq("slug", slug).eq("status", "active").maybeSingle()
  if (!tenant) return []
  const { data: site } = await db.from("tenant_sites").select("is_published, published_at").eq("tenant_id", tenant.id).maybeSingle()
  if (!site?.is_published) return []

  return [{ url: `https://${host}/`, lastModified: site.published_at ? new Date(site.published_at as string) : undefined, changeFrequency: "weekly", priority: 1 }]
}
