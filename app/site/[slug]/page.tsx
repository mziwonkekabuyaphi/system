// app/site/[slug]/page.tsx
//
// A tenant's own website, at /site/[slug]. On a shop's custom domain, "/" is rewritten here
// (lib/domains/custom-domain-routing.ts), with the slug injected by us, never read from the URL.
//
//   published site  -> the template, CACHED (revalidate below, plus revalidatePath on Publish)
//   no site yet     -> exactly today's /web/[slug] page, so nobody's link breaks
//
// The fallback must stay live (the kiosk page reads live data), so that branch calls connection()
// to opt this one render out of the cache.

import type { Metadata } from "next"
import { connection } from "next/server"

import { BookingTemplate } from "@/components/site/BookingTemplate"
import { EventsTemplate } from "@/components/site/EventsTemplate"
import { OrdersTemplate } from "@/components/site/OrdersTemplate"
import { ShishaTemplate } from "@/components/site/ShishaTemplate"
import { SiteBeacon } from "@/components/site/SiteBeacon"
import { SiteJsonLd } from "@/components/site/SiteJsonLd"
import { loadPublishedSite } from "@/lib/site/load-site"
import WebPage, { generateMetadata as webMetadata } from "@/app/web/[slug]/page"

// 5 minutes: ticket availability and new events should show up soon even without a Publish.
export const revalidate = 300

type Props = Parameters<typeof WebPage>[0]

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await (props as { params: Promise<{ slug: string }> }).params
  const site = await loadPublishedSite(slug)
  if (!site) return webMetadata(props as never)
  const c = site.content
  const title = c.headline.toLowerCase().includes(site.name.toLowerCase()) ? c.headline : `${site.name}: ${c.headline}`
  const description = (c.subheadline || c.about || c.headline).slice(0, 160)
  const base = site.canonicalHost ? `https://${site.canonicalHost}` : null
  const image = c.heroImageUrl || site.logoUrl || null
  return {
    ...(base ? { metadataBase: new URL(base), alternates: { canonical: "/" } } : {}),
    title,
    description,
    robots: { index: true, follow: true },
    openGraph: { type: "website", siteName: site.name, title, description, ...(base ? { url: "/" } : {}), ...(image ? { images: [image] } : {}) },
    twitter: { card: image ? "summary_large_image" : "summary", title, description, ...(image ? { images: [image] } : {}) },
  }
}

export default async function SitePage(props: Props) {
  const { slug } = await (props as { params: Promise<{ slug: string }> }).params
  const site = await loadPublishedSite(slug)
  if (!site) {
    await connection()
    return <WebPage {...props} />
  }
  const page =
    site.template === "events" ? (
      <EventsTemplate site={site} />
    ) : site.template === "booking" ? (
      <BookingTemplate site={site} />
    ) : site.template === "orders" ? (
      <OrdersTemplate site={site} />
    ) : (
      <ShishaTemplate site={site} />
    )
  return (
    <>
      <SiteJsonLd site={site} />
      {page}
      <SiteBeacon />
    </>
  )
}
