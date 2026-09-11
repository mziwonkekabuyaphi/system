/**
 * Rands WhatsApp Concierge — Supabase server client.
 *
 * SERVER-SIDE ONLY. This module uses the Supabase SERVICE ROLE key, which
 * bypasses Row Level Security and must NEVER be imported into a client
 * component or shipped to the browser. Use it only in route handlers,
 * server actions, and other server-only code.
 *
 * Design goals:
 *   - Singleton: the client is created once and cached across invocations,
 *     which is important for performance on Vercel's serverless runtime.
 *   - Graceful: if the required environment variables are missing, we return
 *     `null` instead of throwing, so callers can degrade safely rather than
 *     crash. (The webhook handler relies on this to always return 200.)
 *   - Debuggable: we log exactly which variable is missing when setup is
 *     incomplete, making misconfiguration easy to spot in the logs.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

// Module-level cache for the singleton instance. `undefined` means "not yet
// initialized"; `null` means "initialization was attempted but failed"
// (e.g. missing env vars) so we don't retry on every request.
let cachedClient: SupabaseClient | null | undefined = undefined

/**
 * Returns a cached, server-only Supabase client, or `null` if the required
 * environment variables are not configured.
 *
 * Required environment variables:
 *   - NEXT_PUBLIC_SUPABASE_URL      (your project URL)
 *   - SUPABASE_SERVICE_ROLE_KEY     (secret service role key — server only)
 */
export function getSupabaseServerClient(): SupabaseClient | null {
  // Return the cached result (client or null) if we've already initialized.
  if (cachedClient !== undefined) {
    return cachedClient
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // Log precisely which variable is missing to make debugging painless.
  if (!supabaseUrl) {
    console.log("[v0] Supabase not configured: NEXT_PUBLIC_SUPABASE_URL is missing")
  }
  if (!serviceRoleKey) {
    console.log("[v0] Supabase not configured: SUPABASE_SERVICE_ROLE_KEY is missing")
  }

  // If either value is absent, cache `null` and bail out gracefully.
  if (!supabaseUrl || !serviceRoleKey) {
    cachedClient = null
    return cachedClient
  }

  // Create the singleton client. We disable session persistence and token
  // refresh because this is a stateless, server-only context (no user login).
  cachedClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  console.log("[v0] Supabase server client initialized")
  return cachedClient
}
