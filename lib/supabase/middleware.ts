import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/admin";

/**
 * CUSTOM DOMAINS (new): a verified tenant custom domain
 * (testvenue.qless.test, book.someshop.com, ...) resolves to the exact
 * same /kiosk/[slug] route the platform's own domain already serves —
 * the domain is purely a routing alias in front of code that hasn't
 * changed at all. page.tsx/actions.ts still resolve everything by slug;
 * this only decides WHICH slug a given hostname means.
 *
 * NOTE ON THIS FILE'S SHAPE: what you shared with me only contained
 * `updateSession`, with no `middleware`/default export or `config`
 * calling it — but the build log shows Next.js *does* detect a
 * middleware file at this path, so something must invoke it. I've added
 * the `middleware` export and a `config.matcher` below as the missing
 * piece. If your real file already had a different matcher or a
 * different wrapper around updateSession, tell me what it was — this
 * matcher (everything except static assets) needs to actually cover the
 * paths a tenant's custom domain will be hit on, or none of this runs.
 *
 * NOTE ON ASSUMPTIONS: `isPlatformHostname` needs to know what "us" is.
 * I've hardcoded *.vercel.app and localhost as always-us, and left
 * NEXT_PUBLIC_PLATFORM_DOMAIN as the one thing you need to set to your
 * actual production domain (e.g. "qless.app") for this to correctly tell
 * your own domain apart from a tenant's.
 */

const PLATFORM_ROOT_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN ?? "";

function isPlatformHostname(hostname: string): boolean {
  const host = hostname.split(":")[0].toLowerCase(); // strip :port, e.g. localhost:3000
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host.endsWith(".vercel.app")) return true;
  if (PLATFORM_ROOT_DOMAIN && (host === PLATFORM_ROOT_DOMAIN || host.endsWith(`.${PLATFORM_ROOT_DOMAIN}`))) {
    return true;
  }
  return false;
}

interface TenantDomainLookup {
  tenants: { slug: string; status: string } | null;
}

// Trusted server-side lookup, same trust model as the public kiosk route
// (app/kiosk/[slug]/page.tsx's own comment on this exact point): an
// incoming hostname is public information a visitor controls just by
// pointing DNS at us, exactly like a slug in a URL is — nothing here is
// gated behind a session, so the service-role client is the right tool.
// Only a `status = 'active'` tenant_domains row resolves — 'pending'
// (added to Vercel, not yet verified) and 'failed' rows never route
// traffic, same as an unverified custom domain shouldn't be able to.
async function resolveTenantSlugForHostname(hostname: string): Promise<string | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("tenant_domains")
    .select("tenants(slug, status)")
    .eq("domain", hostname)
    .eq("status", "active")
    .maybeSingle<TenantDomainLookup>();

  if (error || !data?.tenants) return null;
  if (data.tenants.status !== "active") return null; // tenant itself paused/suspended

  return data.tenants.slug;
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the auth token if it's expired.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gate /admin behind a session. The real enforcement for tenant
  // membership lives in app/admin/layout.tsx's requireTenantMember().
  if (!user && request.nextUrl.pathname.startsWith("/admin")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

// Entry point Next.js actually calls. Custom-domain rewriting happens
// BEFORE updateSession's auth check, and skips it entirely on a match, so
// a kiosk visitor arriving on a tenant's own domain never pays for a
// Supabase auth-session lookup they don't need. /admin traffic always
// skips the hostname check and goes straight to updateSession — admin
// staff are assumed to always sign in on the platform's own domain, never
// a tenant's custom domain, since Private Label branding is a
// customer-facing (kiosk) concept, not an admin-facing one.
export async function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") ?? request.nextUrl.hostname;

  if (!request.nextUrl.pathname.startsWith("/admin") && !isPlatformHostname(hostname)) {
    const slug = await resolveTenantSlugForHostname(hostname);
    if (slug) {
      const url = request.nextUrl.clone();
      const suffix = request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname;
      url.pathname = `/kiosk/${slug}${suffix}`;
      return NextResponse.rewrite(url);
    }
    // No active tenant_domains row for this host — fall through to
    // whatever the app does at this path today (a 404, since nothing's
    // mounted at "/"). Not inventing a "domain not configured" page here,
    // since that's a product decision that wasn't part of this ask.
  }

  return updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
