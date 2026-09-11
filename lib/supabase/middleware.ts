import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  // Gate anything under /app (your tenant admin shell) or /admin (the
  // WhatsApp-booking module, mounted separately from the shell) behind a
  // session. This is an early, cheap rejection at the edge — the real
  // enforcement for /admin still lives in layout.tsx's
  // requireTenantMember(), which additionally checks for an active
  // tenant_members row, not just a signed-in user. Keep both: this check
  // only knows "is there a session," not "is there a tenant."
  const gatedPrefixes = ["/app", "/admin"]
  if (!user && gatedPrefixes.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
