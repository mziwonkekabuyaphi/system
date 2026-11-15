// lib/domains/custom-domain-routing.ts
//
// Pure, edge-safe helpers (no Node APIs, no Supabase client) for serving a shop's public
// pages on its own domain. Used by middleware.ts.
//
// THE RULE THAT KEEPS SHOPS APART: the shop's slug is always INJECTED by us from the domain
// lookup, never read from the visitor's URL. So book.shop-a.com can only ever show shop A,
// and a request like /kiosk/shop-b becomes /kiosk/shop-a/shop-b, which matches no route and 404s.

const PLATFORM_ROOT_DOMAIN = (process.env.NEXT_PUBLIC_PLATFORM_DOMAIN ?? "").trim().toLowerCase()

/** Lowercase host without port or trailing dot. */
export function normalizeHost(raw: string | null | undefined): string {
  return (raw ?? "").split(":")[0].trim().toLowerCase().replace(/\.$/, "")
}

function hostOf(urlOrHost: string | undefined): string {
  if (!urlOrHost) return ""
  try {
    return normalizeHost(new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).host)
  } catch {
    return ""
  }
}

// The platform's own public addresses. Deriving them from NEXT_PUBLIC_APP_URL as well means
// forgetting NEXT_PUBLIC_PLATFORM_DOMAIN can't turn the platform's own site into a "custom domain"
// that 404s for everyone.
const APP_HOSTS = new Set(
  [hostOf(process.env.NEXT_PUBLIC_APP_URL), hostOf(process.env.VERCEL_PROJECT_PRODUCTION_URL)].filter(Boolean),
)

/** Is this one of OUR hostnames (as opposed to a shop's own domain)? */
export function isPlatformHostname(rawHost: string): boolean {
  const host = normalizeHost(rawHost)
  if (!host || host === "localhost" || host === "127.0.0.1") return true
  if (host.endsWith(".vercel.app")) return true
  if (APP_HOSTS.has(host)) return true
  if (PLATFORM_ROOT_DOMAIN && (host === PLATFORM_ROOT_DOMAIN || host.endsWith(`.${PLATFORM_ROOT_DOMAIN}`))) return true
  return false
}

/** Where staff and marketing pages live. Null if the platform URL isn't configured. */
export function platformOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")
  if (!raw) return null
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).origin
  } catch {
    return null
  }
}

export type CustomDomainRoute =
  | { kind: "rewrite"; pathname: string } // serve this internal path instead
  | { kind: "pass" } // shared routes (webhooks, payment return, referral links)
  | { kind: "platform" } // staff / marketing: belongs on the platform's own domain
  | { kind: "not-found" }

/** Public pages that exist per shop, as /{page}/[slug]. */
const SLUG_PAGES = new Set(["web", "kiosk", "display", "clock", "scan"])
/** Shared routes that don't belong to one shop. */
const PASS_PREFIXES = new Set(["api", "pay", "refer"])
const PASS_FILES = new Set(["robots.txt", "sitemap.xml", "manifest.webmanifest", "manifest.json"])
/** Staff, sign-in and marketing areas. Staff sign in on the platform domain only. */
const PLATFORM_PREFIXES = new Set(["admin", "platform", "login", "signup", "auth", "sales", "onboarding", "demo"])

/**
 * Decide what a request on a shop's custom domain should show.
 *
 *   /                -> /web/{slug}         customer page
 *   /kiosk           -> /kiosk/{slug}
 *   /display         -> /display/{slug}
 *   /display/shisha  -> /display/{slug}/shisha
 *   /clock, /scan    -> /clock/{slug}, /scan/{slug}
 *   /api, /pay, /refer, /robots.txt, ...   unchanged
 *   /admin, /login, ... redirect to the platform domain
 *   anything else    404
 */
export function routeCustomDomainPath(pathname: string, slug: string): CustomDomainRoute {
  const clean = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/"
  if (clean === "/") return { kind: "rewrite", pathname: `/web/${encodeURIComponent(slug)}` }

  const parts = clean.split("/").filter(Boolean)
  const first = parts[0].toLowerCase()

  if (PLATFORM_PREFIXES.has(first)) return { kind: "platform" }
  if (PASS_PREFIXES.has(first) || (parts.length === 1 && PASS_FILES.has(first))) return { kind: "pass" }

  if (SLUG_PAGES.has(first)) {
    // Refuse anything that could climb out of the page's own folder.
    for (const segment of parts.slice(1)) {
      let decoded: string
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        return { kind: "not-found" }
      }
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return { kind: "not-found" }
    }
    const rest = parts.length > 1 ? `/${parts.slice(1).join("/")}` : ""
    return { kind: "rewrite", pathname: `/${first}/${encodeURIComponent(slug)}${rest}` }
  }

  return { kind: "not-found" }
}
