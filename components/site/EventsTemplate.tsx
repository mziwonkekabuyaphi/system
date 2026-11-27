// components/site/EventsTemplate.tsx
//
// The Events & Tables landing page. Server component. Events, ticket tiers and VVIP packages are the
// venue's real data (lib/site/load-site.ts), so adding an event in admin puts it on the site by itself
// (within the cache window, or at once on Publish). Tickets are sold on WhatsApp today, so every
// "Buy tickets" / "Reserve" button is a wa.me link that names the event or package.

import { Space_Grotesk, Unbounded } from "next/font/google"

import type { PublishedSite } from "@/lib/site/load-site"
import { waLink } from "@/lib/site/types"
import { HeroPhoto, JsonLd, SiteFooter, SiteLogo, WHATSAPP_GREEN, WHATSAPP_INK, mapsHref, money, onColor } from "./parts"

const display = Unbounded({ subsets: ["latin"], display: "swap" })
const body = Space_Grotesk({ subsets: ["latin"], display: "swap" })

export function EventsTemplate({ site, preview = false }: { site: PublishedSite; preview?: boolean }) {
  const { content: c, accent, timezone } = site
  const on = onColor(accent)
  const wa = (msg: string) => waLink(c.whatsappNumber, msg)
  const generalWa = wa(c.whatsappMessage || "Hi, I'd like to book.")
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-ZA", { ...o, timeZone: timezone }).format(new Date(iso))
  const day = (iso: string) => fmt(iso, { day: "2-digit" })
  const mon = (iso: string) => fmt(iso, { month: "short" }).toUpperCase()
  const when = (iso: string) => fmt(iso, { weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false })

  const showEvents = c.show.events
  const showPackages = c.show.packages && site.packages.length > 0
  const showGallery = c.show.gallery && c.gallery.length > 0
  const showHours = c.show.hours && c.hours.length > 0
  const showContact = c.show.contact && (c.address || generalWa)
  const next = site.events[0]

  const btn = "inline-block rounded-xl px-5 py-3 text-sm font-bold"
  const card = "rounded-2xl border border-white/10 bg-white/[0.05] p-5"
  const h2 = `${display.className} mb-6 text-2xl font-bold tracking-tight sm:text-3xl`
  const kicker = "mb-2 text-xs font-semibold uppercase tracking-[0.2em]"

  return (
    <div className={`${body.className} relative min-h-screen overflow-x-hidden bg-[#0C0919] text-[#F4F1FF] scroll-smooth`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] opacity-40" style={{ background: `radial-gradient(55% 60% at 80% 0%, ${accent}, transparent), radial-gradient(40% 50% at 0% 20%, #4B2BD8, transparent)` }} aria-hidden />

      <div className="relative mx-auto max-w-4xl px-5 pb-28 sm:pb-16">
        <nav className="flex items-center justify-between py-5">
          <span className="flex items-center gap-3 text-lg font-bold">
            <SiteLogo site={site} />
            {site.name}
          </span>
          <span className="hidden items-center gap-6 text-sm text-[#C9C2E6] sm:flex">
            {showEvents && <a href="#events" className="hover:text-white">Events</a>}
            {showPackages && <a href="#tables" className="hover:text-white">Tables</a>}
            {(showHours || showContact) && <a href="#visit" className="hover:text-white">Find us</a>}
            {generalWa && <a href={generalWa} className="rounded-full px-4 py-2 font-semibold" style={{ background: accent, color: on }}>Book on WhatsApp</a>}
          </span>
        </nav>

        <header className="relative mt-2 overflow-hidden rounded-3xl border border-white/10 bg-[#171233]">
          <HeroPhoto url={c.heroImageUrl} alt={site.name} />
          {c.heroImageUrl && <div className="absolute inset-0 bg-gradient-to-t from-[#0C0919] via-[#0C0919]/60 to-transparent" aria-hidden />}
          <div className="relative px-6 py-14 sm:px-10 sm:py-24">
            <p className={kicker} style={{ color: accent }}>
              {next ? `Next up · ${day(next.startTime)} ${mon(next.startTime)}` : "Events & tables"}
            </p>
            <h1 className={`${display.className} max-w-2xl text-3xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl`}>{c.headline}</h1>
            {c.subheadline && <p className="mt-4 max-w-xl text-lg text-[#C9C2E6]">{c.subheadline}</p>}
            {generalWa && (
              <a href={generalWa} className={`${btn} mt-7 !px-6 !py-3.5 !text-base`} style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>
                Book on WhatsApp
              </a>
            )}
          </div>
        </header>

        {c.about && <p className="mt-10 max-w-2xl text-lg leading-relaxed text-[#D6D0EE]">{c.about}</p>}

        {showEvents && (
          <section className="mt-14 scroll-mt-6" id="events" aria-labelledby="events-h">
            <h2 id="events-h" className={h2}>Upcoming events</h2>
            {site.events.length === 0 ? (
              <p className={`${card} text-[#C9C2E6]`}>No events on sale right now. Check back soon.</p>
            ) : (
              <div className="space-y-4">
                {site.events.map((e) => {
                  const link = wa(`Hi, I'd like tickets for ${e.name}.`)
                  const onSale = e.tickets.filter((t) => !t.soldOut)
                  return (
                    <article key={e.id} className={`${card} flex flex-wrap items-center gap-5`}>
                      <div className="w-[76px] shrink-0 rounded-xl py-2.5 text-center font-extrabold" style={{ background: accent, color: on }}>
                        <span className="block text-3xl leading-none">{day(e.startTime)}</span>
                        <small className="text-xs tracking-wider">{mon(e.startTime)}</small>
                      </div>
                      {e.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={e.imageUrl} alt="" loading="lazy" className="h-[76px] w-[76px] shrink-0 rounded-xl object-cover" />
                      )}
                      <div className="min-w-[200px] flex-1">
                        <h3 className="text-lg font-bold">{e.name}</h3>
                        <p className="mt-1 text-sm text-[#C9C2E6]">
                          {when(e.startTime)}
                          {e.location ? ` · ${e.location}` : ""}
                        </p>
                        {e.tickets.length > 0 && (
                          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#D6D0EE]">
                            {e.tickets.map((t) => (
                              <span key={t.id} className={t.soldOut ? "opacity-60" : ""}>
                                {t.name} <b>{t.soldOut ? "sold out" : money(t.price, site.currency)}</b>
                              </span>
                            ))}
                          </p>
                        )}
                      </div>
                      {link && onSale.length > 0 ? (
                        <a href={link} className={btn} style={{ background: accent, color: on }}>Buy tickets</a>
                      ) : (
                        e.tickets.length > 0 && onSale.length === 0 && <span className="text-sm font-semibold text-[#C9C2E6]">Sold out</span>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        )}

        {showPackages && (
          <section className="mt-14 scroll-mt-6" id="tables" aria-labelledby="tables-h">
            <h2 id="tables-h" className={h2}>Tables &amp; packages</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {site.packages.map((p) => {
                const link = wa(`Hi, I'd like to reserve the ${p.name}${p.eventName ? ` for ${p.eventName}` : ""}.`)
                return (
                  <article key={p.id} className={`${card} flex flex-col overflow-hidden !p-0`}>
                    {p.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imageUrl} alt="" loading="lazy" className="h-36 w-full object-cover" />
                    )}
                    <div className="flex flex-1 flex-col p-5">
                      <h3 className="text-lg font-bold">{p.name}</h3>
                      <p className="mt-1 text-sm text-[#C9C2E6]">
                        {p.eventName}
                        {p.seats ? ` · Seats ${p.seats}` : ""}
                      </p>
                      <p className="mt-3 text-2xl font-extrabold" style={{ color: accent }}>
                        {money(p.price, site.currency)}
                      </p>
                      {p.tabCredit > 0 && <p className="text-sm text-[#D6D0EE]">includes {money(p.tabCredit, site.currency)} bar tab</p>}
                      {p.description && <p className="mt-2 text-sm text-[#D6D0EE]">{p.description}</p>}
                      {p.benefits.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-sm text-[#D6D0EE]">
                          {p.benefits.map((b, i) => <li key={i}>{b}</li>)}
                        </ul>
                      )}
                      {link && <a href={link} className={`${btn} mt-5 self-start`} style={{ background: accent, color: on }}>Reserve</a>}
                    </div>
                  </article>
                )
              })}
            </div>
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
          <section className="mt-14 grid scroll-mt-6 gap-4 sm:grid-cols-2" id="visit" aria-labelledby="visit-h">
            <h2 id="visit-h" className={`${h2} mb-1 sm:col-span-2`}>Find us</h2>
            {showHours && (
              <div className={card}>
                <p className={kicker} style={{ color: accent }}>Opening hours</p>
                {c.hours.map((h, i) => (
                  <div key={i} className="flex justify-between gap-4 py-1.5 text-[15px] text-[#C9C2E6]">
                    <span>{h.label}</span>
                    <b className="text-[#F4F1FF]">{h.value}</b>
                  </div>
                ))}
              </div>
            )}
            {showContact && (
              <div className={card}>
                {c.address && (
                  <>
                    <p className={kicker} style={{ color: accent }}>Address</p>
                    <p className="text-[15px] leading-relaxed">{c.address}</p>
                    <a className="mt-2 inline-block text-sm underline underline-offset-4" href={mapsHref(site.name, c.address)}>Open in Maps</a>
                  </>
                )}
                {generalWa && (
                  <a href={generalWa} className={`${btn} mt-5 !block text-center`} style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>Chat on WhatsApp</a>
                )}
              </div>
            )}
          </section>
        )}

        <SiteFooter site={site} className="text-[#A39CC4]" />
      </div>

      {generalWa && (
        <a href={generalWa} className="fixed inset-x-5 bottom-5 z-40 mx-auto block max-w-md rounded-2xl py-4 text-center text-base font-extrabold shadow-xl sm:hidden" style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>
          Book on WhatsApp
        </a>
      )}
      {!preview && <JsonLd site={site} hours={showHours ? c.hours : undefined} />}
    </div>
  )
}
