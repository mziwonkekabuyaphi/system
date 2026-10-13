// app/web/[slug]/page.tsx
/**
 * Customer-facing web link for one tenant, at /web/[their-slug].
 * This is what the WhatsApp bot sends to customers, so the link never says
 * "kiosk". It shows exactly the same page as /kiosk/[slug] (same checks,
 * same branding, same plan gate) by re-using it, so there is only ONE page
 * to maintain.
 *
 * NOTE: `dynamic` must be written out here (Next.js cannot read it through a
 * re-export); the page and metadata are simply re-used.
 */

export const dynamic = "force-dynamic"

export { default, generateMetadata } from "@/app/kiosk/[slug]/page"
