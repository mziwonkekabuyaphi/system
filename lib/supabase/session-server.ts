// lib/supabase/session-server.ts
//
// This app already has lib/supabase/server.ts → getSupabaseServerClient(),
// a SERVICE-ROLE client used to actually read/write data (bypasses RLS by
// design — see page.tsx's file header). That client has no idea who's
// logged in; it isn't meant to.
//
// This file is the other half: a client that reads the visitor's auth
// cookies so we can answer "who is signed in?" It's what login/signup
// and tenant resolution use. Kept as a separate file/name on purpose so
// dropping this in doesn't silently overwrite the existing service-role
// client at the same import path.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSessionClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render — safe to ignore,
            // middleware refreshes the session cookie on every request.
          }
        },
      },
    }
  );
}
