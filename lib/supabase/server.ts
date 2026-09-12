import { createClient as createSupabaseClient } from "@supabase/supabase-js"

/**
 * Server-only Supabase client using the service-role key.
 * Bypasses RLS, so every query must be explicitly scoped by tenant_id.
 * Never import this into client components — the service key would leak.
 */
export function getSupabaseServerClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
