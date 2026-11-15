// app/admin/domains/vercel.ts
//
// Thin client for the Vercel REST API, for attaching a shop's domain to THIS project.
// Server-only: it uses VERCEL_TOKEN, which must never reach a browser. Only the server actions
// in ./actions.ts import it. (Keep it that way; this file has no "use client" and no exports a
// client component should use.)
//
// Env (same names the previous implementation used):
//   VERCEL_TOKEN        API token with access to the project
//   VERCEL_PROJECT_ID   this project's id
//   VERCEL_TEAM_ID      only if the project lives under a team (omitted from requests otherwise,
//                       because Vercel rejects an empty teamId)

const VERCEL_API = "https://api.vercel.com"
const TIMEOUT_MS = 10_000

export type VercelFailureCode = "not_configured" | "domain_limit" | "in_use" | "not_found" | "rate_limited" | "forbidden" | "failed"
export type VercelResult<T> = { ok: true; data: T } | { ok: false; code: VercelFailureCode; error: string }

export interface VercelChallenge {
  type: string
  /** Full name the TXT record goes on, e.g. _vercel.shop.com */
  domain: string
  value: string
  reason: string
}

export interface ProjectDomain {
  name: string
  apexName: string
  verified: boolean
  verification: VercelChallenge[]
}

export interface DnsConfig {
  /** True when DNS doesn't point at Vercel yet (or a certificate can't be issued). */
  misconfigured: boolean
  /** Preferred CNAME target (rank 1), if Vercel recommends one. */
  recommendedCname: string | null
  /** Preferred A record values (rank 1), if Vercel recommends any. */
  recommendedIpv4: string[]
}

function credentials(): { token: string; projectId: string; teamId: string | null } | null {
  const token = process.env.VERCEL_TOKEN
  const projectId = process.env.VERCEL_PROJECT_ID
  if (!token || !projectId) return null
  return { token, projectId, teamId: process.env.VERCEL_TEAM_ID || null }
}

export function vercelConfigured(): boolean {
  return credentials() !== null
}

const NOT_CONFIGURED: VercelResult<never> = {
  ok: false,
  code: "not_configured",
  error: "Custom domains aren't fully set up on the server yet. Please contact support.",
}

type Raw = { status: number; body: Record<string, unknown> }

async function call(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<Raw | null> {
  const creds = credentials()
  if (!creds) return null
  const url = new URL(`${VERCEL_API}${path}`)
  if (creds.teamId) url.searchParams.set("teamId", creds.teamId)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: init.method,
      body: init.body,
      signal: controller.signal,
      cache: "no-store",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, body }
  } catch {
    return { status: 0, body: {} }
  } finally {
    clearTimeout(timer)
  }
}

function errorOf(raw: Raw): { code: string; message: string } {
  const e = (raw.body.error ?? {}) as { code?: unknown; message?: unknown }
  return { code: typeof e.code === "string" ? e.code : "", message: typeof e.message === "string" ? e.message : "" }
}

/** Vercel's messages are mostly readable, but never show a long or odd one verbatim. */
function describe(raw: Raw, fallback: string): VercelResult<never> {
  if (raw.status === 0) return { ok: false, code: "failed", error: "We couldn't reach Vercel. Please try again in a moment." }
  const { code, message } = errorOf(raw)
  if (raw.status === 429) return { ok: false, code: "rate_limited", error: "We're connecting a lot of domains right now. Please try again in a few minutes." }
  if (/limit|too many|exceed/i.test(`${code} ${message}`)) {
    return { ok: false, code: "domain_limit", error: "We've reached the number of domains our hosting plan allows. Please contact support." }
  }
  if (raw.status === 401 || raw.status === 403) {
    return { ok: false, code: "forbidden", error: "Our hosting account refused the request. Please contact support." }
  }
  if (raw.status === 404) return { ok: false, code: "not_found", error: "Domain not found." }
  const safe = message && message.length <= 160 ? message : ""
  return { ok: false, code: "failed", error: safe || fallback }
}

function toChallenges(value: unknown): VercelChallenge[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      type: String(v.type ?? "TXT"),
      domain: String(v.domain ?? ""),
      value: String(v.value ?? ""),
      reason: String(v.reason ?? ""),
    }))
    .filter((c) => c.domain && c.value)
}

function toProjectDomain(body: Record<string, unknown>, fallbackName: string): ProjectDomain {
  return {
    name: typeof body.name === "string" ? body.name : fallbackName,
    apexName: typeof body.apexName === "string" ? body.apexName : fallbackName,
    verified: body.verified === true,
    verification: toChallenges(body.verification),
  }
}

export async function getProjectDomain(domain: string): Promise<VercelResult<ProjectDomain>> {
  const creds = credentials()
  if (!creds) return NOT_CONFIGURED
  const raw = await call(`/v9/projects/${encodeURIComponent(creds.projectId)}/domains/${encodeURIComponent(domain)}`)
  if (!raw) return NOT_CONFIGURED
  if (raw.status >= 200 && raw.status < 300) return { ok: true, data: toProjectDomain(raw.body, domain) }
  return describe(raw, "We couldn't read that domain from Vercel.")
}

/**
 * Attach the domain to the project. Safe to repeat: if it's already on THIS project (an earlier
 * attempt got that far), that counts as success. If it's on another Vercel account or project,
 * it's refused.
 */
export async function addProjectDomain(domain: string): Promise<VercelResult<ProjectDomain>> {
  const creds = credentials()
  if (!creds) return NOT_CONFIGURED
  const raw = await call(`/v10/projects/${encodeURIComponent(creds.projectId)}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  })
  if (!raw) return NOT_CONFIGURED
  if (raw.status >= 200 && raw.status < 300) return { ok: true, data: toProjectDomain(raw.body, domain) }

  if (raw.status === 409) {
    const existing = await getProjectDomain(domain)
    if (existing.ok) return existing
    return { ok: false, code: "in_use", error: "That domain is already connected to another project. Remove it there first, then try again." }
  }
  return describe(raw, "We couldn't add that domain. Please try again.")
}

/** Ask Vercel to re-check the domain's own verification (only needed when it required a TXT record). */
export async function verifyProjectDomain(domain: string): Promise<VercelResult<ProjectDomain>> {
  const creds = credentials()
  if (!creds) return NOT_CONFIGURED
  const raw = await call(`/v9/projects/${encodeURIComponent(creds.projectId)}/domains/${encodeURIComponent(domain)}/verify`, { method: "POST" })
  if (!raw) return NOT_CONFIGURED
  if (raw.status >= 200 && raw.status < 300) return { ok: true, data: toProjectDomain(raw.body, domain) }
  // Vercel answers 400 while the record still isn't visible. That's "not yet", not a failure.
  if (raw.status === 400) return getProjectDomain(domain)
  return describe(raw, "We couldn't verify that domain yet.")
}

/** What Vercel sees for this domain, and the DNS records it recommends. */
export async function getDnsConfig(domain: string): Promise<VercelResult<DnsConfig>> {
  const creds = credentials()
  if (!creds) return NOT_CONFIGURED
  const raw = await call(`/v6/domains/${encodeURIComponent(domain)}/config`, { query: { projectIdOrName: creds.projectId } })
  if (!raw) return NOT_CONFIGURED
  if (raw.status < 200 || raw.status >= 300) return describe(raw, "We couldn't read the DNS settings for that domain.")

  const byRank = <T extends { rank?: unknown }>(items: T[]) => [...items].sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99))
  const cnames = byRank(Array.isArray(raw.body.recommendedCNAME) ? (raw.body.recommendedCNAME as Array<{ rank?: unknown; value?: unknown }>) : [])
  const ipv4s = byRank(Array.isArray(raw.body.recommendedIPv4) ? (raw.body.recommendedIPv4 as Array<{ rank?: unknown; value?: unknown }>) : [])

  const cname = cnames.find((c) => typeof c.value === "string" && c.value)?.value
  const ips = ipv4s.find((c) => Array.isArray(c.value) && c.value.length > 0)?.value
  return {
    ok: true,
    data: {
      misconfigured: raw.body.misconfigured !== false, // anything but an explicit false counts as not ready
      recommendedCname: typeof cname === "string" ? cname : null,
      recommendedIpv4: Array.isArray(ips) ? ips.filter((v): v is string => typeof v === "string") : [],
    },
  }
}

/** Detach the domain from the project. A domain that's already gone counts as removed. */
export async function removeProjectDomain(domain: string): Promise<VercelResult<null>> {
  const creds = credentials()
  if (!creds) return NOT_CONFIGURED
  const raw = await call(`/v9/projects/${encodeURIComponent(creds.projectId)}/domains/${encodeURIComponent(domain)}`, { method: "DELETE" })
  if (!raw) return NOT_CONFIGURED
  if ((raw.status >= 200 && raw.status < 300) || raw.status === 404) return { ok: true, data: null }
  return describe(raw, "We couldn't remove that domain from our hosting. Please try again.")
}
