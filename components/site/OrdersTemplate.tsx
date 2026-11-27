// components/site/OrdersTemplate.tsx
//
// The WhatsApp Orders landing page (takeaways, bottle stores, bakeries, shops). Server component.
// The catalogue, delivery areas and fees, order options and opening hours are the shop's real data
// (lib/site/load-site.ts). Ordering itself stays on WhatsApp where the shop's order flow already runs:
// every "Order" button is a wa.me link with the item pre-filled. No cart, no checkout, nothing to keep in sync.

import { Bricolage_Grotesque, Inter } from "next/font/google"

import type { PublishedSite } from "@/lib/site/load-site"
import { waLink } from "@/lib/site/types"
import { HeroPhoto, JsonLd, SiteFooter, SiteLogo, WHATSAPP_GREEN, WHATSAPP_INK, mapsHref, money, onColor } from "./parts"

const display = Bricolage_Grotesque({ subsets: ["latin"], display: "swap" })
const body = Inter({ subsets: ["latin"], display: "swap" })

export function OrdersTemplate({ site, preview = false }: { site: PublishedSite; preview?: boolean }) {
  const { content: c, accent, orderInfo: info } = site
  const on = onColor(accent, "#16181D")
  const m = (n: number) => money(n, site.currency)
  const general = waLink(c.whatsappNumber, c.whatsappMessage || "Hi, I'd like to place an order.")

  const showMenu = c.show.menu && site.catalogue.length > 0
  const showAreas = c.show.areas && site.deliveryAreas.length > 0
  const showHours = c.show.hours && site.businessHours.length > 0
  const showContact = c.show.contact && Boolean(c.address)
  const showGallery = c.show.gallery && c.gallery.length > 0
  const showFind = showHours || showContact || Boolean(info?.collectionInstructions)

  const ways: string[] = []
  if (info?.collection) ways.push(info.prepMinutes > 0 ? `Collection · ready in about ${info.prepMinutes} min` : "Collection")
  if (info?.delivery && site.deliveryAreas.length > 0) ways.push(info.deliveryMinutes > 0 ? `Delivery · about ${info.deliveryMinutes} min` : "Delivery")
  if (info?.dineIn) ways.push("Dine-in")

  const card = "rounded-2xl border border-[#E4E6EB] bg-white p-5"
  const h2 = `${display.className} mb-5 text-3xl font-bold tracking-tight sm:text-4xl`
  const kicker = "mb-2 text-xs font-semibold uppercase tracking-[0.2em]"

  return (
    <div className={`${body.className} relative min-h-screen overflow-x-hidden bg-[#F7F8FA] text-[#16181D] scroll-smooth`}>
      <div className="mx-auto max-w-3xl px-5 pb-28 sm:pb-16">
        <nav className="flex items-center justify-between py-5">
          <span className={`${display.className} flex items-center gap-3 text-xl font-bold`}>
            <SiteLogo site={site} />
            {site.name}
          </span>
          <span className="hidden items-center gap-6 text-sm text-[#444A55] sm:flex">
            {showMenu && <a href="#menu" className="hover:text-black">Menu</a>}
            {showAreas && <a href="#delivery" className="hover:text-black">Delivery</a>}
            {showFind && <a href="#find" className="hover:text-black">Find us</a>}
            {general && <a href={general} className="rounded-full px-4 py-2 font-semibold" style={{ background: accent, color: on }}>Order now</a>}
          </span>
        </nav>

        <header className="relative overflow-hidden rounded-3xl bg-[#16181D] p-7 text-white sm:p-12">
          <HeroPhoto url={c.heroImageUrl} alt={site.name} />
          {c.heroImageUrl ? (
            <div className="absolute inset-0 bg-black/60" aria-hidden />
          ) : (
            <div className="absolute inset-0 opacity-50" style={{ background: `radial-gradient(70% 90% at 100% 0%, ${accent}, transparent)` }} aria-hidden />
          )}
          <div className="relative">
            <p className={kicker} style={{ color: c.heroImageUrl ? "#fff" : accent }}>Order online</p>
            <h1 className={`${display.className} max-w-xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl`}>{c.headline}</h1>
            {c.subheadline && <p className="mt-3 max-w-xl text-base text-[#E4E6EB] sm:text-lg">{c.subheadline}</p>}
            {general && (
              <a href={general} className="mt-6 inline-block rounded-xl px-6 py-3.5 text-base font-bold" style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>
                Order on WhatsApp
              </a>
            )}
            {ways.length > 0 && (
              <ul className="mt-5 flex flex-wrap gap-2 text-sm">
                {ways.map((w) => (
                  <li key={w} className="rounded-full bg-white/15 px-3 py-1">{w}</li>
                ))}
              </ul>
            )}
          </div>
        </header>

        {c.about && <p className="mt-8 text-lg leading-relaxed text-[#444A55]">{c.about}</p>}

        {showMenu && (
          <section className="mt-14 scroll-mt-6" id="menu" aria-labelledby="menu-h">
            <h2 id="menu-h" className={h2}>Menu</h2>
            {site.catalogue.length > 1 && (
              <nav aria-label="Categories" className="mb-6 flex flex-wrap gap-2">
                {site.catalogue.map((g) => (
                  <a key={g.key} href={`#cat-${g.key}`} className="rounded-full border border-[#D5D8DE] bg-white px-4 py-1.5 text-sm font-medium hover:bg-[#EEF0F3]">
                    {g.label}
                  </a>
                ))}
              </nav>
            )}
            {site.catalogue.map((g) => (
              <div key={g.key} id={`cat-${g.key}`} className="mb-8 scroll-mt-4">
                <h3 className="mb-2 flex items-center text-lg font-bold">
                  {g.label}
                  {g.ageRestricted && <span className="ml-2 rounded bg-[#16181D] px-1.5 py-0.5 text-xs font-semibold text-white">18+</span>}
                </h3>
                <ul className="overflow-hidden rounded-2xl border border-[#E4E6EB] bg-white">
                  {g.items.map((it) => {
                    const link = waLink(c.whatsappNumber, `Hi, I'd like to order: ${it.name}.`)
                    return (
                      <li key={it.id} className="flex items-center justify-between gap-4 border-t border-[#EEF0F3] px-5 py-3.5 first:border-0">
                        {it.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={it.imageUrl} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{it.name}</p>
                          {it.description && <p className="mt-0.5 text-sm text-[#5C6370]">{it.description}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <b>{m(it.price)}</b>
                          {link && (
                            <a href={link} aria-label={`Order ${it.name} on WhatsApp`} className="rounded-lg px-3 py-1.5 text-sm font-bold" style={{ background: accent, color: on }}>
                              Order
                            </a>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            {info?.minOrder ? <p className="text-sm text-[#5C6370]">Minimum order {m(info.minOrder)}.</p> : null}
          </section>
        )}

        {showAreas && (
          <section className="mt-14 scroll-mt-6" id="delivery" aria-labelledby="delivery-h">
            <h2 id="delivery-h" className={h2}>Delivery areas</h2>
            <div className={`${card} divide-y divide-[#EEF0F3]`}>
              {site.deliveryAreas.map((a) => (
                <div key={a.id} className="flex justify-between gap-4 py-2.5 text-[15px] first:pt-0 last:pb-0">
                  <span>{a.name}</span>
                  <span className="text-right text-[#444A55]">
                    <b className="text-[#16181D]">{a.fee === 0 ? "Free" : m(a.fee)}</b>
                    {a.fee > 0 && a.freeOver ? ` · free over ${m(a.freeOver)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {showGallery && (
          <section className="mt-14" aria-labelledby="gallery">
            <h2 id="gallery" className={h2}>Gallery</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {c.gallery.map((u) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={u} src={u} alt="" loading="lazy" className="h-36 w-full rounded-xl object-cover" />
              ))}
            </div>
          </section>
        )}

        {showFind && (
          <section className="mt-14 grid scroll-mt-6 gap-4 sm:grid-cols-2" id="find" aria-labelledby="find-h">
            <h2 id="find-h" className={`${h2} mb-1 sm:col-span-2`}>Find us</h2>
            {showHours && (
              <div className={card}>
                <p className={kicker} style={{ color: "#5C6370" }}>Opening hours</p>
                {site.businessHours.map((h, i) => (
                  <div key={i} className="flex justify-between gap-4 py-1.5 text-[15px] text-[#444A55]">
                    <span>{h.label}</span>
                    <b className="text-[#16181D]">{h.value}</b>
                  </div>
                ))}
              </div>
            )}
            {(showContact || info?.collectionInstructions) && (
              <div className={card}>
                {showContact && (
                  <>
                    <p className={kicker} style={{ color: "#5C6370" }}>Address</p>
                    <p className="text-[15px] leading-relaxed">{c.address}</p>
                    <a className="mt-2 inline-block text-sm underline underline-offset-4" href={mapsHref(site.name, c.address)}>Open in Maps</a>
                  </>
                )}
                {info?.collectionInstructions && <p className="mt-3 text-sm text-[#444A55]">{info.collectionInstructions}</p>}
              </div>
            )}
          </section>
        )}

        <SiteFooter site={site} className="text-[#5C6370]" />
      </div>

      {general && (
        <a href={general} className="fixed inset-x-5 bottom-5 z-40 mx-auto block max-w-md rounded-2xl py-4 text-center text-base font-extrabold shadow-xl sm:hidden" style={{ background: WHATSAPP_GREEN, color: WHATSAPP_INK }}>
          Order on WhatsApp
        </a>
      )}
      {!preview && <JsonLd site={site} hours={showHours ? site.businessHours : undefined} />}
    </div>
  )
}
