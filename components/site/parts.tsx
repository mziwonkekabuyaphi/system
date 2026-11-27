// components/site/parts.tsx
//
// Small pieces every ZozoWeb template shares, so the three templates stay short and behave the same:
// money, logo, hero photo, footer, Maps link and the search-engine data (JSON-LD).

import type { PublishedSite } from "@/lib/site/load-site"

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount)
  } catch {
    return `${amount}`
  }
}

/** Black or white text, whichever reads better on this colour. */
export function onColor(hex: string, dark = "#14110F", light = "#FFFFFF"): string {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? dark : light
}

export const WHATSAPP_GREEN = "#25D366"
export const WHATSAPP_INK = "#06240F"

export function mapsHref(name: string, address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address}`)}`
}

export function SiteLogo({ site }: { site: PublishedSite }) {
  if (!site.logoUrl || !/^https:\/\//.test(site.logoUrl)) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={site.logoUrl} alt="" width={40} height={40} className="h-10 w-10 rounded-full object-cover" />
}

/** The hero photo as a real <img> (never injected into CSS), filling its positioned parent. */
export function HeroPhoto({ url, alt, priority = true }: { url: string; alt: string; priority?: boolean }) {
  if (!url) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} loading={priority ? "eager" : "lazy"} className="absolute inset-0 h-full w-full object-cover" />
}

export function SiteFooter({ site, className = "" }: { site: PublishedSite; className?: string }) {
  return (
    <footer className={`mt-14 flex flex-wrap items-center justify-between gap-2 text-xs ${className}`}>
      <span>© {new Date().getFullYear()} {site.name}</span>
      {!site.removePoweredBy && <span>Powered by ZozoWeb</span>}
    </footer>
  )
}

/** LocalBusiness data so Google can show the shop's name, address and phone. Skipped in the owner's preview. */
export function JsonLd({ site, hours }: { site: PublishedSite; hours?: { label: string; value: string }[] }) {
  const data: Record<string, unknown> = { "@context": "https://schema.org", "@type": "LocalBusiness", name: site.name }
  if (site.content.address) data.address = site.content.address
  if (site.content.heroImageUrl) data.image = site.content.heroImageUrl
  if (site.content.whatsappNumber) data.telephone = `+${site.content.whatsappNumber}`
  if (hours && hours.length > 0) data.openingHours = hours.map((h) => `${h.label} ${h.value}`)
  // "<" is escaped so shop text can never close the script tag.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />
}
