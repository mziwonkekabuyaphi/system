// components/site/BookingTemplate.tsx
//
// The Booking & Queue landing page (salon, barber, clinic...). Server component. Services, prices and
// opening hours are the shop's real data (lib/site/load-site.ts). "Book now" and "Join the queue" go to
// the shop's existing /web page (WebLink), which already runs the real flow, so nothing is rebuilt here.
// There is deliberately no "people waiting" badge: the page is cached for minutes, and a stale count
// would mislead walk-ins.

import { DM_Sans, Playfair_Display } from "next/font/google"

import type { PublishedSite } from "@/lib/site/load-site"
import { waLink } from "@/lib/site/types"
import { HeroPhoto, JsonLd, SiteFooter, SiteLogo, WHATSAPP_GREEN, WHATSAPP_INK, mapsHref, money, onColor } from "./parts"
import { WebLink } from "./WebLink"

const display = Playfair_Display({ subsets: ["latin"], display: "swap" })
const body = DM_Sans({ subsets: ["latin"], display: "swap" })

export function BookingTemplate({ site, preview = false }: { site: PublishedSite; preview?: boolean }) {
  const { content: c, accent } = site
  const on = onColor(accent, "#2A1F1A")
  const wa = waLink(c.whatsappNumber, c.whatsappMessage || "Hi, I'd like to book.")
  const showServices = c.show.services && site.services.length > 0
  const showHours = c.show.hours && site.businessHours.length > 0
  const showContact = c.show.contact && (c.address || wa)
  const showGallery = c.show.gallery && c.gallery.length > 0
  const canAct = site.canBook || site.canQueue
  const primaryLabel = site.canBook ? "Book now" : "Join the queue"

  const btn = "inline-block rounded-xl px-6 py-3.5 text-[15px] font-bold"
  const card = "rounded-2xl border border-[#E8D5C4] bg-white p-6"
  const h2 = `${display.className} mb-5 text-3xl font-semibold tracking-tight sm:text-4xl`
  const kicker = "mb-2 text-xs font-semibold uppercase tracking-[0.2em]"

  return (
    <div className={`${body.className} relative min-h-screen overflow-x-hidden bg-[#FBF7F2] text-[#2A1F1A] scroll-smooth`}>
      <div className="mx-auto max-w-4xl px-5 pb-28 sm:pb-16">
        <nav className="flex items-center justify-between py-5">
          <span className={`${display.className} flex items-center gap-3 text-xl font-semibold`}>
            <SiteLogo site={site} />
            {site.name}
          </span>
          <span className="hidden items-center gap-6 text-sm text-[#5A4A40] sm:flex">
            {showServices && <a href="#services" className="hover:text-black">Services</a>}
            {(showHours || showContact) && <a href="#visit" className="hover:text-black">Visit</a>}
            {canAct && (
              <WebLink slug={site.slug} className="rounded-full px-4 py-2 font-semibold" style={{ background: accent, color: on }}>
                {primaryLabel}
              </WebLink>
            )}
          </span>
        </nav>

        <header className="grid items-center gap-8 py-8 sm:grid-cols-2 sm:gap-12 sm:py-14">
          <div className="order-2 sm:order-1">
            <p className={kicker} style={{ color: "#8A6A55" }}>Book · Queue · Walk in</p>
            <h1 className={`${display.className} text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl`}>{c.headline}</h1>
            {c.subheadline && <p className="mb-7 mt-4 text-lg text-[#5A4A40]">{c.subheadline}</p>}
            <div className="flex flex-wrap gap-3">
              {site.canBook && (
                <WebLink slug={site.slug} className={btn} style={{ background: accent, color: on }}>Book now</WebLink>
              )}
              {site.canQueue && (
                <WebLink slug={site.slug} className={`${btn} border-2`} style={{ borderColor: accent, color: "#2A1F1A" }}>Join the queue</WebLink>
              )}
              {!canAct && wa && (
                <a href={wa} className={btn} style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>Chat on WhatsApp</a>
              )}
            </div>
          </div>
          <div className="relative order-1 min-h-[260px] overflow-hidden rounded-3xl bg-[#E8D5C4] sm:order-2 sm:min-h-[380px]">
            <HeroPhoto url={c.heroImageUrl} alt={site.name} />
            {!c.heroImageUrl && (
              <div className="absolute inset-0 grid place-items-center" style={{ background: `linear-gradient(135deg, ${accent}, #E8D5C4)` }} aria-hidden>
                <span className={`${display.className} text-8xl font-semibold`} style={{ color: on, opacity: 0.85 }}>
                  {site.name.trim().charAt(0).toUpperCase()}
                </span>
              </div>
            )}
          </div>
        </header>

        {c.about && <p className="max-w-2xl text-lg leading-relaxed text-[#5A4A40]">{c.about}</p>}

        {showServices && (
          <section className="mt-14 scroll-mt-6" id="services" aria-labelledby="services-h">
            <h2 id="services-h" className={h2}>Services &amp; prices</h2>
            <ul className="overflow-hidden rounded-2xl border border-[#E8D5C4] bg-white">
              {site.services.map((s) => (
                <li key={s.id} className="flex items-baseline justify-between gap-4 border-t border-[#EFE2D5] px-6 py-4 text-lg first:border-0">
                  <span>
                    {s.name}
                    {s.durationMinutes > 0 && <span className="ml-2 text-sm text-[#7A675A]">{s.durationMinutes} min</span>}
                  </span>
                  <b className="shrink-0">{money(s.price, site.currency)}</b>
                </li>
              ))}
            </ul>
          </section>
        )}

        {showGallery && (
          <section className="mt-14" aria-labelledby="gallery">
            <h2 id="gallery" className={h2}>Gallery</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {c.gallery.map((u) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={u} src={u} alt="" loading="lazy" className="h-36 w-full rounded-xl object-cover sm:h-44" />
              ))}
            </div>
          </section>
        )}

        {(showHours || showContact) && (
          <section className="mt-14 grid scroll-mt-6 gap-5 sm:grid-cols-2" id="visit" aria-labelledby="visit-h">
            <h2 id="visit-h" className={`${h2} mb-0 sm:col-span-2`}>Visit us</h2>
            {showHours && (
              <div className={card}>
                <p className={kicker} style={{ color: "#8A6A55" }}>Opening hours</p>
                {site.businessHours.map((h, i) => (
                  <div key={i} className="flex justify-between gap-4 py-2 text-[15px] text-[#5A4A40]">
                    <span>{h.label}</span>
                    <b className="text-[#2A1F1A]">{h.value}</b>
                  </div>
                ))}
              </div>
            )}
            {showContact && (
              <div className={card}>
                {c.address && (
                  <>
                    <p className={kicker} style={{ color: "#8A6A55" }}>Address</p>
                    <p className="text-[15px] leading-relaxed">{c.address}</p>
                    <a className="mt-2 inline-block text-sm underline underline-offset-4" href={mapsHref(site.name, c.address)}>Open in Maps</a>
                  </>
                )}
                {wa && <a href={wa} className={`${btn} mt-5 !block text-center`} style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>Chat on WhatsApp</a>}
              </div>
            )}
          </section>
        )}

        {canAct && (
          <section className="mt-14 rounded-3xl bg-[#2A1F1A] p-10 text-center text-white">
            <h2 className={`${display.className} mb-5 text-3xl font-semibold`}>Ready when you are</h2>
            <WebLink slug={site.slug} className={btn} style={{ background: accent, color: on }}>
              {primaryLabel}
            </WebLink>
          </section>
        )}

        <SiteFooter site={site} className="text-[#7A675A]" />
      </div>

      {canAct && (
        <WebLink
          slug={site.slug}
          className="fixed inset-x-5 bottom-5 z-40 mx-auto block max-w-md rounded-2xl py-4 text-center text-base font-extrabold shadow-xl sm:hidden"
          style={{ background: accent, color: on }}
        >
          {primaryLabel}
        </WebLink>
      )}
      {!preview && <JsonLd site={site} hours={showHours ? site.businessHours : undefined} />}
    </div>
  )
}
