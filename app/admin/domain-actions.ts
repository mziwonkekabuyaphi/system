// app/admin/domain-actions.ts
"use server"

/**
 * Custom-domain actions — Settings > Private Label > Custom domain.
 *
 * Same tenantContext() shape as settings-actions.ts: requireTenantMember()
 * is the auth+membership gate, then every tenant_domains query still
 * filters by .eq("tenant_id", tenantId) on the service-role client —
 * same belt-and-suspenders reasoning as everywhere else in that file.
 *
 * VERIFICATION IS VERCEL'S JOB, NOT OURS: nothing here runs a DNS lookup.
 * addCustomDomain() calls Vercel's `POST /v10/projects/{id}/domains`,
 * which either comes back `verified: true` immediately (rare — usually
 * only when the hostname is already provably tied to this account, e.g.
 * a subdomain of something already verified) or hands back a
 * `verification` challenge array (almost always a single TXT record on
 * `_vercel.<domain>`) that the tenant needs to add at their registrar.
 * checkCustomDomainVerification() then calls Vercel's own
 * `POST .../verify` and trusts whatever it says — `tenant_domains.status`
 * here is just a mirror of Vercel's last answer, not an independent
 * source of truth about DNS state.
 *
 * Endpoints used (confirmed against Vercel's REST API reference):
 *   POST   /v10/projects/{id}/domains              — add;      -> { verified, verification[] }
 *   POST   /v9/projects/{id}/domains/{domain}/verify — verify;  -> { verified }  (no verification[] here)
 *   GET    /v9/projects/{id}/domains/{domain}       — refetch;  -> { verified, verification[] }
 *   DELETE /v9/projects/{id}/domains/{domain}       — remove
 * The verify endpoint alone doesn't return the challenge details when
 * still unverified, so checkCustomDomainVerification() follows up with a
 * GET to have something to show the tenant again — see there.
 *
 * tenant_domains.status vocabulary used here: 'pending' (added to Vercel,
 * not yet verified), 'active' (Vercel confirms verified), 'failed'
 * (Vercel rejected the domain outright, e.g. malformed). I'm inferring
 * these three from the one sample row you shared (status: "active") —
 * confirm 'pending'/'failed' match your actual column constraint/enum
 * before relying on this in production.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"

type ActionResult = { success: true } | { success: false; error: string }

export interface VerificationChallenge {
  type: string
  domain: string
  value: string
  reason?: string
}

type AddDomainResult =
  | { success: true; status: "active" }
  | { success: true; status: "pending"; verification: VerificationChallenge[] }
  | { success: false; error: string }

type VerifyDomainResult =
  | { success: true; verified: true }
  | { success: true; verified: false; verification: VerificationChallenge[] }
  | { success: false; error: string }

const VERCEL_API = "https://api.vercel.com"
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID!
// Only set if this project lives under a Vercel team — omitted from the
// query string entirely otherwise, since Vercel treats a present-but-empty
// teamId as an error rather than "no team".
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID

function vercelUrl(path: string): string {
  const url = new URL(`${VERCEL_API}${path}`)
  if (VERCEL_TEAM_ID) url.searchParams.set("teamId", VERCEL_TEAM_ID)
  return url.toString()
}

async function vercelFetch(path: string, init?: RequestInit) {
  const res = await fetch(vercelUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

// Deliberately conservative: lowercase letters/digits/hyphens, at least
// one dot, no protocol or path. Vercel re-validates this anyway
// (400 if malformed) — this just avoids spending an API call on
// something obviously wrong ("http://", a bare word, a path).
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i

function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
}

async function tenantContext() {
  const { tenantId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId }
}

// Vercel's error responses are `{ error: { code, message } }` — surface
// the message when there is one rather than a generic fallback, since
// these are usually already tenant-readable ("Invalid domain", "This
// domain is already in use by a different project", etc.).
function vercelErrorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: string } })?.error?.message
  return message || fallback
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------
export async function addCustomDomain(domainInput: string): Promise<AddDomainResult> {
  const domain = normalizeDomain(domainInput)
  if (!DOMAIN_PATTERN.test(domain)) {
    return { success: false, error: "Enter a valid domain, e.g. book.yourshop.com" }
  }

  try {
    const { supabase, tenantId } = await tenantContext()

    const { ok, body } = await vercelFetch(`/v10/projects/${VERCEL_PROJECT_ID}/domains`, {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    })

    if (!ok) {
      return { success: false, error: vercelErrorMessage(body, "Couldn't add that domain. Please try again.") }
    }

    const verified: boolean = body.verified === true
    const verification: VerificationChallenge[] = body.verification ?? []

    const { error: dbError } = await supabase.from("tenant_domains").insert({
      tenant_id: tenantId,
      domain,
      is_primary: false,
      status: verified ? "active" : "pending",
    })

    if (dbError) {
      // Roll back the Vercel side so a failed DB write doesn't leave an
      // orphaned domain attached to the project with no tenant_domains
      // row behind it — same "don't leave the two systems out of sync"
      // instinct as uploadLogo's Storage-then-DB sequencing.
      await vercelFetch(`/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`, { method: "DELETE" })
      if (dbError.message.includes("duplicate key")) {
        return { success: false, error: "That domain is already added." }
      }
      return { success: false, error: dbError.message }
    }

    revalidatePath("/admin")
    return verified ? { success: true, status: "active" } : { success: true, status: "pending", verification }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Check verification — call from the UI (a "Check again" button, or a
// light poll) until this reports verified: true. Also what the Settings
// page should call on load for any domain still 'pending', since the
// verify response alone doesn't include the DNS instructions — only the
// follow-up GET does — so this is the one place that fetches them fresh
// rather than trusting whatever was returned back when the domain was
// first added.
// ---------------------------------------------------------------------------
export async function checkCustomDomainVerification(domainInput: string): Promise<VerifyDomainResult> {
  const domain = normalizeDomain(domainInput)

  try {
    const { supabase, tenantId } = await tenantContext()

    // Confirm this tenant actually owns this domain before spending a
    // Vercel API call on it — same reasoning as every other
    // .eq("tenant_id", ...) filter in this file.
    const { data: row, error: rowError } = await supabase
      .from("tenant_domains")
      .select("domain")
      .eq("tenant_id", tenantId)
      .eq("domain", domain)
      .maybeSingle()

    if (rowError) return { success: false, error: rowError.message }
    if (!row) return { success: false, error: "That domain isn't on your account." }

    const verifyCall = await vercelFetch(`/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}/verify`, {
      method: "POST",
    })

    if (!verifyCall.ok) {
      // Vercel 400s here mid-verification with a human-readable reason
      // ("The domain does not have a TXT record...", "The TXT record...
      // does not match...") — that's not a failure of this action, it's
      // the expected shape of "not verified yet, here's why." Surface it
      // as the message rather than a generic error.
      return {
        success: true,
        verified: false,
        verification: await fetchVerificationChallenge(domain),
      }
    }

    if (verifyCall.body.verified === true) {
      const { error: updateError } = await supabase
        .from("tenant_domains")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("domain", domain)

      if (updateError) return { success: false, error: updateError.message }

      revalidatePath("/admin")
      return { success: true, verified: true }
    }

    return { success: true, verified: false, verification: await fetchVerificationChallenge(domain) }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// The verify endpoint's response doesn't include the `verification`
// challenge array — only add (POST) and get (GET) do. Pulled into its
// own helper since checkCustomDomainVerification() needs it from two
// branches (a 400 from verify, and a 200 with verified: false).
async function fetchVerificationChallenge(domain: string): Promise<VerificationChallenge[]> {
  const { ok, body } = await vercelFetch(`/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`)
  if (!ok) return []
  return body.verification ?? []
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------
export async function removeCustomDomain(domainInput: string): Promise<ActionResult> {
  const domain = normalizeDomain(domainInput)

  try {
    const { supabase, tenantId } = await tenantContext()

    const { data: row, error: rowError } = await supabase
      .from("tenant_domains")
      .select("domain")
      .eq("tenant_id", tenantId)
      .eq("domain", domain)
      .maybeSingle()

    if (rowError) return { success: false, error: rowError.message }
    if (!row) return { success: false, error: "That domain isn't on your account." }

    const { ok, status, body } = await vercelFetch(`/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`, {
      method: "DELETE",
    })

    // Vercel 404s if the domain's already gone on their side (e.g.
    // removed manually from the Vercel dashboard) — treat that the same
    // as success rather than blocking the tenant from clearing their own
    // stale row over it.
    if (!ok && status !== 404) {
      return { success: false, error: vercelErrorMessage(body, "Couldn't remove that domain. Please try again.") }
    }

    const { error: deleteError } = await supabase
      .from("tenant_domains")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("domain", domain)

    if (deleteError) return { success: false, error: deleteError.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Set primary — DB-only, no Vercel call needed. Vercel has no concept of
// "primary" among the domains attached to a project; that's purely how
// this app decides which verified domain to, e.g., show as the kiosk's
// canonical URL.
// ---------------------------------------------------------------------------
export async function setPrimaryDomain(domainInput: string): Promise<ActionResult> {
  const domain = normalizeDomain(domainInput)

  try {
    const { supabase, tenantId } = await tenantContext()

    // Two writes, not one clever UPDATE ... CASE: clearing every row
    // then setting the one is easier to reason about than ordering
    // guarantees across rows in a single statement. Not wrapped in an
    // explicit transaction — same trust level as this app's other
    // non-transactional multi-step writes (e.g. Storage + tenant_branding
    // in settings-actions.ts's uploadLogo).
    const { error: clearError } = await supabase
      .from("tenant_domains")
      .update({ is_primary: false, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)

    if (clearError) return { success: false, error: clearError.message }

    const { error: setError } = await supabase
      .from("tenant_domains")
      .update({ is_primary: true, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("domain", domain)
      .eq("status", "active") // an unverified domain can't become primary

    if (setError) return { success: false, error: setError.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
