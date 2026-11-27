// components/site/SiteByTemplate.tsx
//
// The one place that maps a template name to its component. Adding a template (e.g. Orders) =
// add it to TEMPLATES in lib/site/types.ts, build its component, add one line here.

import type { PublishedSite } from "@/lib/site/load-site"
import { BookingTemplate } from "./BookingTemplate"
import { EventsTemplate } from "./EventsTemplate"
import { OrdersTemplate } from "./OrdersTemplate"
import { ShishaTemplate } from "./ShishaTemplate"

export function SiteByTemplate({ site, preview = false }: { site: PublishedSite; preview?: boolean }) {
  if (site.template === "events") return <EventsTemplate site={site} preview={preview} />
  if (site.template === "booking") return <BookingTemplate site={site} preview={preview} />
  if (site.template === "orders") return <OrdersTemplate site={site} preview={preview} />
  return <ShishaTemplate site={site} preview={preview} />
}
