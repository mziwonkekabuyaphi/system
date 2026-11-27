// lib/domains/sites-domain.ts
//
// Free subdomains: {slug}.<sites domain>, e.g. glow-salon.zozoweb.co.za.
// Pure, edge-safe helpers (used by middleware.ts and by the Website settings page).
//
// The sites domain is its own domain (NEXT_PUBLIC_SITES_DOMAIN) on purpose: wildcard certificates
// need that domain's DNS on Vercel, and isPlatformHostname treats every subdomain of the platform
// domain as ours, so shops' free sites must not live under it.
//
// As with custom domains, the slug comes from the HOSTNAME, is checked against the database, and is
// then injected into the internal path. A visitor can never pick another shop's pages.

import { normalizeHost } from "./custom-domain-routing"

export const SITES_ROOT_DOMAIN = (process.env.NEXT_PUBLIC_SITES_DOMAIN ?? "").trim().toLowerCase()

/** Names a shop can never get as a free address (ours, or confusing / abusable). */
const RESERVED = new Set([
  "www", "app", "admin", "api", "auth", "login", "signup", "platform", "sales", "demo", "mail", "email",
  "smtp", "imap", "ftp", "ns1", "ns2", "cdn", "static", "assets", "status", "help", "support", "billing",
  "pay", "payments", "dashboard", "dev", "staging", "test", "zozo", "zozoq", "zozoapp", "zozoweb",
])

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Is this the sites domain itself or anything under it? Checked BEFORE the platform check. */
export function isSitesHostname(rawHost: string): boolean {
  const host = normalizeHost(rawHost)
  return Boolean(SITES_ROOT_DOMAIN) && (host === SITES_ROOT_DOMAIN || host.endsWith(`.${SITES_ROOT_DOMAIN}`))
}

/** Can this slug be used as a free address? */
export function isValidSiteLabel(label: string): boolean {
  return LABEL_RE.test(label) && !label.startsWith("xn--") && !RESERVED.has(label)
}

/** "glow-salon.zozoweb.co.za" -> "glow-salon". Null for the apex, www, reserved or multi-level names. */
export function siteSlugFromHost(rawHost: string): string | null {
  if (!isSitesHostname(rawHost)) return null
  const host = normalizeHost(rawHost)
  if (host === SITES_ROOT_DOMAIN) return null
  const label = host.slice(0, -(SITES_ROOT_DOMAIN.length + 1))
  return isValidSiteLabel(label) ? label : null
}

/** The free address for a slug, or null when no sites domain is configured or the slug can't be a hostname. */
export function freeSiteHost(slug: string): string | null {
  const label = slug.trim().toLowerCase()
  return SITES_ROOT_DOMAIN && isValidSiteLabel(label) ? `${label}.${SITES_ROOT_DOMAIN}` : null
}
