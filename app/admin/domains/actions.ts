// app/admin/domains/actions.ts
"use server"

/**
 * Server Actions for the Custom domain feature (Settings > Custom domain).
 * ------------------------------------------------------------------------
 * Same layers as the rest of the admin:
 *   1. requireTenantPermission("settings.manage") proves the signed-in user may manage this
 *      shop's settings. The tenantId comes from their membership, NEVER from the browser.
 *   2. isModuleEnabled(tenantId, "custom_domain") proves the module is switched on.
 *   3. READS use the service-role client, always filtered by tenant_id.
 *   4. OWNER ACTIONS (claim, remove, set primary) run on the user's own session, so the database
 *      functions check auth.uid() themselves.
 *   5. STATE-ADVANCING calls (domain_record_ownership / _vercel / _dns) use the service-role
 *      client and are made ONLY by checkDomain, and only after it has really done the check:
 *      a DNS TXT lookup, an add to Vercel, Vercel's own DNS verdict. The database refuses those
 *      functions to everyone else, so a shop can't skip a step.
 *
 * checkDomain moves a domain through three gates, in order:
 *      prove you own it (TXT)  ->  attached to our hosting  ->  DNS points here  ->  ACTIVE
 * The database flips status to 'active' only when all three are recorded.
 */

import { createSessionClient } from "@/lib/supabase/session-server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { isPlatformHostname } from "@/lib/domains/custom-domain-routing"
import { challengeFullName, challengeHost, challengeValue, checkOwnershipTxt } from "./dns"
import {
  addProjectDomain,
  getDnsConfig,
  getProjectDomain,
  removeProjectDomain,
  vercelConfigured,
  verifyProjectDomain,
  type VercelChallenge,
} from "./vercel"
import type { CheckOutcome, DnsRecord, DomainList, DomainStatus, DomainStep, DomainView } from "./types"

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }
type Fail = { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scope = { ok: true; read: ServerClient; tenantId: string } | Fail

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODULE_OFF = "Custom domains aren't switched on for your business."
const GENERIC_ERROR = "Something went wrong. Please try again."
const NOT_FOUND = "Domain not found."
/** Same hostname rule as the database (tenant_domains_domain_format), so both layers always agree
 *  and a bad domain fails here without a round trip. Labels start/end with a letter or digit,
 *  the last label starts with a letter (so IP addresses never pass), nothing empty or oversized. */
const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
/** Don't hit DNS and Vercel more than this often for one domain, however often the page asks. */
const MIN_CHECK_INTERVAL_MS = 10_000

const fail = (error: string): Fail => ({ ok: false, error })
const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data })
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v)

const COLUMNS =
  "id,domain,is_primary,status,verification_token,ownership_verified_at,vercel_added_at,dns_configured_at,last_checked_at,last_error,expires_at,created_at"

interface Row {
  id: string
  domain: string
  is_primary: boolean
  status: DomainStatus
  verification_token: string | null
  ownership_verified_at: string | null
  vercel_added_at: string | null
  dns_configured_at: string | null
  last_checked_at: string | null
  last_error: string | null
  expires_at: string | null
  created_at: string
}

async function scoped(): Promise<Scope> {
  const check = await requireTenantPermission("settings.manage")
  if (!check.ok) return fail(check.error)
  const tenantId = check.member.tenantId
  if (!(await isModuleEnabled(tenantId, "custom_domain"))) return fail(MODULE_OFF)
  const read = getSupabaseServerClient()
  if (!read) return fail("Supabase isn't configured.")
  return { ok: true, read, tenantId }
}

/** Messages the database raises on purpose are written for people; anything technical is replaced. */
function friendly(error: { message?: string } | null | undefined): string {
  const m = (error?.message ?? "").trim()
  if (!m) return GENERIC_ERROR
  if (m.length > 160 || /violates|duplicate key|syntax|relation |column |function |permission denied|row-level security|JWT/i.test(m)) {
    console.error("[domains] database error:", m)
    return GENERIC_ERROR
  }
  return m
}

/** Accepts what people actually paste: "https://Book.Shop.com/", "book.shop.com:443", "book.shop.com." */
function normalizeDomainInput(input: string): string {
  return (typeof input === "string" ? input : "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
}

async function loadRow(read: ServerClient, tenantId: string, id: string): Promise<Row | null> {
  const { data } = await read.from("tenant_domains").select(COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
  return (data as Row | null) ?? null
}

function stepOf(row: Row): DomainStep {
  if (row.status === "disabled") return "disabled"
  if (!row.ownership_verified_at) return "prove_ownership"
  if (row.status === "active") return "active"
  return "connect"
}

function toChallengeRecord(c: VercelChallenge, apex: string): DnsRecord {
  const suffix = `.${apex}`
  return { type: "TXT", host: c.domain.endsWith(suffix) ? c.domain.slice(0, -suffix.length) : c.domain, value: c.value, fullName: c.domain }
}

/** The "point your domain at us" instructions, from what Vercel itself recommends for THIS domain.
 *  Nothing here is hard-coded: addresses change, and Vercel knows the right ones. */
async function connectInstructions(domain: string): Promise<{ records: DnsRecord[]; challenge: DnsRecord | null; problem: string | null }> {
  const [project, config] = await Promise.all([getProjectDomain(domain), getDnsConfig(domain)])
  if (!project.ok) return { records: [], challenge: null, problem: project.error }
  const apex = project.data.apexName
  const isApex = domain === apex
  const challenge = !project.data.verified && project.data.verification.length > 0 ? toChallengeRecord(project.data.verification[0], apex) : null

  if (!config.ok) return { records: [], challenge, problem: config.error }
  const records: DnsRecord[] = []
  if (isApex) {
    for (const ip of config.data.recommendedIpv4) records.push({ type: "A", host: "@", value: ip, fullName: domain })
  } else if (config.data.recommendedCname) {
    records.push({ type: "CNAME", host: domain.slice(0, domain.length - apex.length - 1), value: config.data.recommendedCname, fullName: domain })
  }
  const problem = records.length === 0 ? "We couldn't load the DNS records for this domain yet. Press Check now in a moment." : null
  return { records, challenge, problem }
}

async function buildView(row: Row): Promise<DomainView> {
  const step = stepOf(row)
  let records: DnsRecord[] = []
  let vercelChallenge: DnsRecord | null = null
  let problem = row.last_error

  if (step === "prove_ownership" && row.verification_token) {
    records = [{ type: "TXT", host: challengeHost(), value: challengeValue(row.verification_token), fullName: challengeFullName(row.domain) }]
  } else if (step === "connect") {
    const connect = await connectInstructions(row.domain)
    records = connect.records
    vercelChallenge = connect.challenge
    if (!problem && connect.problem) problem = connect.problem
  }

  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    isPrimary: row.is_primary,
    step,
    ownershipVerified: Boolean(row.ownership_verified_at),
    problem,
    lastCheckedAt: row.last_checked_at,
    expiresAt: row.ownership_verified_at ? null : row.expires_at,
    createdAt: row.created_at,
    records,
    vercelChallenge,
    liveUrl: step === "active" ? `https://${row.domain}` : null,
  }
}

// ============================================================================
// Reading
// ============================================================================

export async function listDomains(): Promise<ActionResult<DomainList>> {
  const c = await scoped()
  if (!c.ok) return c
  const { data, error } = await c.read.from("tenant_domains").select(COLUMNS).eq("tenant_id", c.tenantId).order("created_at")
  if (error) return fail(friendly(error))
  const rows = ((data ?? []) as Row[]).sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.created_at.localeCompare(b.created_at))
  const domains = await Promise.all(rows.map((r) => buildView(r)))
  return ok({ domains, serverReady: vercelConfigured() })
}

// ============================================================================
// Owner actions (user session: the database checks auth.uid() itself)
// ============================================================================

export async function claimDomain(input: string): Promise<ActionResult<DomainView>> {
  const c = await scoped()
  if (!c.ok) return c

  const domain = normalizeDomainInput(input)
  if (!domain || domain.length > 253 || !HOSTNAME_RE.test(domain)) {
    return fail("Enter a valid domain, like book.yourshop.com")
  }
  if (isPlatformHostname(domain)) return fail("That address belongs to us or to a hosting provider. Use a domain you own.")

  const db = await createSessionClient()
  const { data, error } = await db.rpc("domain_claim", { p_tenant_id: c.tenantId, p_domain: domain })
  if (error) return fail(friendly(error))
  return ok(await buildView(data as Row))
}

export async function setPrimaryDomain(domainId: string): Promise<ActionResult<DomainView>> {
  const c = await scoped()
  if (!c.ok) return c
  if (!isUuid(domainId)) return fail(NOT_FOUND)

  const db = await createSessionClient()
  const { data, error } = await db.rpc("domain_set_primary", { p_tenant_id: c.tenantId, p_domain_id: domainId })
  if (error) return fail(friendly(error))
  return ok(await buildView(data as Row))
}

export async function removeDomain(domainId: string): Promise<ActionResult> {
  const c = await scoped()
  if (!c.ok) return c
  if (!isUuid(domainId)) return fail(NOT_FOUND)

  const row = await loadRow(c.read, c.tenantId, domainId)
  if (!row) return fail(NOT_FOUND)

  // Detach from hosting FIRST: if that fails we keep the record, so nothing is left running
  // on our hosting with no shop attached to it.
  if (row.vercel_added_at) {
    const removed = await removeProjectDomain(row.domain)
    if (!removed.ok) return fail(removed.error)
  }

  const db = await createSessionClient()
  const { error } = await db.rpc("domain_remove", { p_tenant_id: c.tenantId, p_domain_id: domainId })
  if (error) return fail(friendly(error))
  return ok(undefined)
}

// ============================================================================
// The progress action
// ============================================================================

async function recordDns(read: ServerClient, domainId: string, configured: boolean, problem: string | null): Promise<string | null> {
  const { error } = await read.rpc("domain_record_dns", { p_domain_id: domainId, p_configured: configured, p_error: problem })
  return error ? friendly(error) : null
}

/**
 * Does whatever step is next for this domain, then reports where it stands.
 * Safe to call repeatedly (the panel polls it): checks closer together than 10 seconds
 * return the current state without calling DNS or Vercel again.
 */
export async function checkDomain(domainId: string): Promise<ActionResult<CheckOutcome>> {
  const c = await scoped()
  if (!c.ok) return c
  if (!isUuid(domainId)) return fail(NOT_FOUND)
  const { read, tenantId } = c

  let row = await loadRow(read, tenantId, domainId)
  if (!row) return fail(NOT_FOUND)
  if (row.status === "disabled") return fail("This domain has been switched off. Please contact support.")

  const reload = async (): Promise<Row | null> => loadRow(read, tenantId, domainId)
  const respond = async (message: string): Promise<ActionResult<CheckOutcome>> => {
    const fresh = (await reload()) ?? row
    return ok({ view: await buildView(fresh as Row), message })
  }

  if (row.last_checked_at && Date.now() - Date.parse(row.last_checked_at) < MIN_CHECK_INTERVAL_MS) {
    return respond("Checked a moment ago. Give it a few seconds, then try again.")
  }

  // --- Gate 1: prove ownership (DNS TXT) -------------------------------------------------
  if (!row.ownership_verified_at) {
    if (!row.verification_token) return fail("This claim has no code. Remove it and add the domain again.")
    const proof = await checkOwnershipTxt(row.domain, row.verification_token)
    if (!proof.ok) return fail(proof.error)
    if (!proof.proven) {
      const stampError = await recordDns(read, row.id, false, null) // just stamps last_checked_at
      if (stampError) return fail(stampError)
      return respond("We couldn't find the TXT record yet. DNS changes can take a few minutes, sometimes longer. We'll keep checking.")
    }
    const { error } = await read.rpc("domain_record_ownership", { p_domain_id: row.id })
    if (error) return fail(friendly(error))
    row = (await reload()) ?? row
  }

  // --- Gate 2: attach to our hosting -------------------------------------------------------
  if (!row.vercel_added_at) {
    const added = await addProjectDomain(row.domain)
    if (!added.ok) {
      await recordDns(read, row.id, false, added.error)
      return respond(added.error)
    }
    const { error } = await read.rpc("domain_record_vercel", { p_domain_id: row.id, p_added: true })
    if (error) return fail(friendly(error))
    row = (await reload()) ?? row
  }

  // --- Gate 3: does DNS point at us? (Vercel's own verdict) ---------------------------------
  const project = await getProjectDomain(row.domain)
  if (!project.ok) {
    await recordDns(read, row.id, false, project.error)
    return respond(project.error)
  }
  let verified = project.data.verified
  if (!verified) {
    const retry = await verifyProjectDomain(row.domain)
    if (retry.ok) verified = retry.data.verified
  }
  const config = await getDnsConfig(row.domain)
  if (!config.ok) {
    await recordDns(read, row.id, false, config.error)
    return respond(config.error)
  }

  const live = verified && !config.data.misconfigured
  const problem = live
    ? null
    : !verified
      ? "Our hosting needs one more DNS record before it can confirm this domain. It's shown below."
      : "Your domain isn't pointing at us yet. Add the record shown below. It can take a few minutes to spread."
  const recordError = await recordDns(read, row.id, live, problem)
  if (recordError) return fail(recordError)

  return respond(live ? "Connected. Your domain is live." : (problem as string))
}
