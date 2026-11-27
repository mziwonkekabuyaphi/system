// app/site/[slug]/preview/page.tsx
//
// "Preview" for the owner: the DRAFT rendered exactly like the live site, before Publish.
// Never cached, never indexed, and only for a signed-in person with Settings permission at THIS business.
// Anyone else gets a 404, so the existence of a draft is not revealed.

import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { SiteByTemplate } from "@/components/site/SiteByTemplate"
import { loadDraftSite } from "@/lib/site/load-site"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Preview", robots: { index: false, follow: false } }

export default async function PreviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const site = await loadDraftSite(slug)
  if (!site) return notFound()

  const check = await requireTenantPermission("settings.manage")
  if (!check.ok || check.member.tenantId !== site.tenantId) return notFound()

  return (
    <>
      <div className="sticky top-0 z-50 bg-amber-300 px-4 py-2 text-center text-sm font-semibold text-black">
        Preview of your draft. Visitors only see this after you press Publish.
      </div>
      <SiteByTemplate site={site} preview />
    </>
  )
}
