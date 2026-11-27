// components/site/ShishaTemplate.tsx
//
// The Shisha Lounge landing page. A server component: no JS needed to read it, so it is fast and
// cacheable. The menu and areas are the shop's real data (see lib/site/load-site.ts); the words
// come from the owner's published content. "Order on WhatsApp" is a plain wa.me link.

import { Fraunces, Inter } from "next/font/google"

import type { PublishedSite } from "@/lib/site/load-site"
import { waLink } from "@/lib/site/types"
import { HeroPhoto, JsonLd, SiteFooter, SiteLogo, WHATSAPP_GREEN, WHATSAPP_INK, mapsHref, money, onColor } from "./parts"

const display = Fraunces({ subsets: ["latin"], display: "swap" })
const body = Inter({ subsets: ["latin"], display: "swap" })

export function ShishaTemplate({ site, preview = false }: { site: PublishedSite; preview?: boolean }) {
  const { content: c, accent } = site
  const on = onColor(accent)
  const wa = waLink(c.whatsappNumber, c.whatsappMessage || "Hi, I'd like to order a shisha.")
  const showMenu = c.show.menu && site.menu.length > 0
  const showAreas = c.show.areas && site.areas.length > 0
  const showHours = c.show.hours && c.hours.length > 0
  const showGallery = c.show.gallery && c.gallery.length > 0
  const showContact = c.show.contact && (c.address || wa)

  const h2 = `${display.className} mb-5 text-3xl font-semibold tracking-tight sm:text-4xl`
  const card = "rounded-2xl border border-white/10 bg-white/[0.04] p-5"
  const kicker = "mb-2 text-xs font-semibold uppercase tracking-[0.2em]"

  return (
    <div className={`${body.className} relative min-h-screen overflow-x-hidden bg-[#120F0D] text-[#F5EDE3] scroll-smooth`}>
      {/* soft glow behind the hero, tinted with the shop's colour */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-30" style={{ background: `radial-gradient(60% 60% at 50% 0%, ${accent}, transparent)` }} aria-hidden />

      <div className="relative mx-auto max-w-4xl px-5 pb-28 sm:pb-16">
        <nav className="flex items-center justify-between py-5">
          <span className={`${display.className} flex items-center gap-3 text-xl font-semibold`}>
            <SiteLogo site={site} />
            {site.name}
          </span>
          <span className="hidden items-center gap-6 text-sm text-[#CDBFAE] sm:flex">
            {showMenu && <a href="#menu" className="hover:text-white">Menu</a>}
            {showAreas && <a href="#areas" className="hover:text-white">Seating</a>}
            {(showHours || showContact) && <a href="#visit" className="hover:text-white">Visit</a>}
            {wa && (
              <a href={wa} className="rounded-full px-4 py-2 font-semibold" style={{ background: accent, color: on }}>
                Order now
              </a>
            )}
          </span>
        </nav>

        <header className="relative mt-2 flex min-h-[340px] items-end overflow-hidden rounded-3xl border border-white/10 bg-[#1D1713] p-6 sm:min-h-[460px] sm:p-10">
          <HeroPhoto url={c.heroImageUrl} alt={site.name} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/5" aria-hidden />
          <div className="relative max-w-2xl">
            <p className={kicker} style={{ color: accent }}>Shisha lounge</p>
            <h1 className={`${display.className} text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl`}>{c.headline}</h1>
            {c.subheadline && <p className="mt-4 max-w-xl text-base text-[#E8DCCB] sm:text-lg">{c.subheadline}</p>}
            {wa && (
              <a href={wa} className="mt-6 inline-block rounded-xl px-6 py-3.5 text-base font-bold" style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>
                Order on WhatsApp
              </a>
            )}
          </div>
        </header>

        {c.about && <p className="mt-10 max-w-2xl text-lg leading-relaxed text-[#D9CDBD]">{c.about}</p>}

        {showMenu && (
          <section className="mt-14 scroll-mt-6" id="menu" aria-labelledby="menu-h">
            <h2 id="menu-h" className={h2}>The menu</h2>
            <ul className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
              {site.menu.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-4 border-t border-white/10 px-5 py-4 text-base first:border-0">
                  <span>{m.name}</span>
                  <b className="shrink-0" style={{ color: accent }}>{money(m.price, site.currency)}</b>
                </li>
              ))}
            </ul>
          </section>
        )}

        {showAreas && (
          <section className="mt-14 scroll-mt-6" id="areas" aria-labelledby="areas-h">
            <h2 id="areas-h" className={h2}>Where to sit</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {site.areas.map((a) => (
                <div key={a.id} className={`${card} text-center font-medium`}>{a.name}</div>
              ))}
            </div>
          </section>
        )}

        {showGallery && (
          <section className="mt-14" aria-labelledby="vibe">
            <h2 id="vibe" className={h2}>The vibe</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {c.gallery.map((u) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={u} src={u} alt="" loading="lazy" className="h-36 w-full rounded-xl object-cover sm:h-44" />
              ))}
            </div>
          </section>
        )}

        {(showHours || showContact) && (
          <section className="mt-14 grid scroll-mt-6 gap-4 sm:grid-cols-2" id="visit" aria-labelledby="visit-h">
            <h2 id="visit-h" className={`${h2} mb-1 sm:col-span-2`}>Visit us</h2>
            {showHours && (
              <div className={card}>
                <p className={kicker} style={{ color: accent }}>Opening hours</p>
                {c.hours.map((h, i) => (
                  <div key={i} className="flex justify-between gap-4 py-1.5 text-[15px] text-[#CDBFAE]">
                    <span>{h.label}</span>
                    <b className="text-[#F5EDE3]">{h.value}</b>
                  </div>
                ))}
              </div>
            )}
            {showContact && (
              <div className={card}>
                {c.address && (
                  <>
                    <p className={kicker} style={{ color: accent }}>Find us</p>
                    <p className="text-[15px] leading-relaxed">{c.address}</p>
                    <a className="mt-2 inline-block text-sm underline underline-offset-4" href={mapsHref(site.name, c.address)}>Open in Maps</a>
                  </>
                )}
                {wa && (
                  <a href={wa} className="mt-5 block rounded-xl py-3 text-center text-[15px] font-bold" style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>
                    Order on WhatsApp
                  </a>
                )}
              </div>
            )}
          </section>
        )}

        <SiteFooter site={site} className="text-[#A89C8D]" />
      </div>

      {wa && (
        <a
          href={wa}
          className="fixed inset-x-5 bottom-5 z-40 mx-auto block max-w-md rounded-2xl py-4 text-center text-base font-extrabold shadow-xl sm:hidden"
          style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}
        >
          Order on WhatsApp
        </a>
      )}
      {!preview && <JsonLd site={site} hours={showHours ? c.hours : undefined} />}
    </div>
  )
}
