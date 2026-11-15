import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh for requests on OUR OWN hostnames, called from the root middleware.ts.
 *
 * Custom-domain routing (a shop's own domain -> its public pages) lives in lib/domains and is
 * decided in middleware.ts BEFORE this runs, so a visitor on a shop's domain never reaches here.
 * (That routing used to sit in an unused `middleware` export in this file. Next.js only runs the
 * root middleware.ts, so it never executed. Hostname detection is now lib/domains/custom-domain-routing.ts.)
 */

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
