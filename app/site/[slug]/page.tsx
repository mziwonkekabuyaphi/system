// app/site/[slug]/page.tsx
//
// A tenant's own website. Three ways visitors arrive, all ending here:
//   - the free address   mysalon.<zozoweb domain>  (middleware.ts rewrites "/" to /site/mysalon)
//   - the shop's own domain book.theirsalon.co.za   (lib/domains rewrites "/" here, slug injected by us)
//   - our own domain, /site/mysalon                 (testing / links)
//
//   published site  -> the template, CACHED (revalidate below, plus revalidatePath on Publish)
//   no site yet     -> exactly today's /web/[slug] page, so nobody's link breaks
//
// The fallback must stay live (the kiosk page reads live data), so that branch calls connection()
// to opt this one render out of the cache.

import type { Metadata } from "next"
import { connection } from "next/server"

import { SiteByTemplate } from "@/components/site/SiteByTemplate"
import { loadPublishedSite } from "@/lib/site/load-site"
import WebPage, { generateMetadata as webMetadata } from "@/app/web/[slug]/page"

// 5 minutes: ticket availability and new events show up soon even without a Publish.
export const revalidate = 300

type Props = Parameters<typeof WebPage>[0]

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await (props as { params: Promise<{ slug: string }> }).params
  const site = await loadPublishedSite(slug)
  if (!site) return webMetadata(props as never)
  return {
    title: site.name,
    description: site.content.subheadline || site.content.headline,
    robots: { index: true, follow: true },
    openGraph: {
      title: site.name,
      description: site.content.subheadline || site.content.headline,
      images: site.content.heroImageUrl ? [site.content.heroImageUrl] : undefined,
    },
  }
}

export default async function SitePage(props: Props) {
  const { slug } = await (props as { params: Promise<{ slug: string }> }).params
  const site = await loadPublishedSite(slug)
  if (!site) {
    await connection()
    return <WebPage {...props} />
  }
  return <SiteByTemplate site={site} />
}
