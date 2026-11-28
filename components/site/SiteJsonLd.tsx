// components/site/SiteJsonLd.tsx
//
// Structured data (schema.org) so search engines understand the page: the business, and for the Events
// template each upcoming event. Only facts the shop published or that are live in its data; nothing invented.
// "<" is escaped so no text can close the script tag.

import type { PublishedSite } from "@/lib/site/load-site"

export function SiteJsonLd({ site }: { site: PublishedSite }) {
  const { content: c } = site
  const url = site.canonicalHost ? `https://${site.canonicalHost}/` : undefined
  const image = c.heroImageUrl || site.logoUrl || undefined
  const address = c.address ? { "@type": "PostalAddress", streetAddress: c.address } : undefined

  const business = {
    "@context": "https://schema.org",
    "@type": site.template === "events" ? "EventVenue" : "LocalBusiness",
    name: site.name,
    description: c.subheadline || c.headline,
    url,
    image,
    address,
    telephone: c.whatsappNumber ? `+${c.whatsappNumber}` : undefined,
  }

  const events = site.events.map((e) => ({
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.name,
    startDate: e.startTime,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    location: { "@type": "Place", name: e.location || site.name, address },
    image: e.imageUrl ?? undefined,
    description: e.description ?? undefined,
  }))

  return (
    <>
      {[business, ...events].map((data, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />
      ))}
    </>
  )
}
