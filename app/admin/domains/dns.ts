// app/admin/domains/dns.ts
//
// OWNERSHIP PROOF. A shop proves it controls a domain by publishing a secret, unique to that
// shop and domain, in a DNS TXT record:
//
//     _ndithini-verify.book.theirshop.com   TXT   "ndithini-verify=<token>"
//
// We look it up over DNS-over-HTTPS (two independent public resolvers; either one seeing the
// token is enough). Only the database's server-only function can then mark the domain proven,
// and only this check ever calls it. This is what stops one shop claiming another's domain:
// anyone can CLAIM a name, but only whoever controls its DNS can produce the token.
//
// Only two fixed endpoints are ever contacted, and the name is validated by the database and
// URL-encoded here, so a domain can't be used to make us call somewhere else.

const CHALLENGE_LABEL = "_ndithini-verify"
const TIMEOUT_MS = 5_000

export function challengeHost(): string {
  return CHALLENGE_LABEL
}

export function challengeFullName(domain: string): string {
  return `${CHALLENGE_LABEL}.${domain}`
}

export function challengeValue(token: string): string {
  return `ndithini-verify=${token}`
}

type DohAnswer = { type?: number; data?: string }
type DohResponse = { Status?: number; Answer?: DohAnswer[] }

const TXT_TYPE = 16

/** TXT data comes back quoted, and long values can be split into several quoted chunks. */
function cleanTxt(data: string): string {
  return data.replace(/"\s+"/g, "").replace(/^"|"$/g, "").trim()
}

type Lookup = { ok: true; values: string[] } | { ok: false }

async function lookup(endpoint: string, name: string, accept: string): Promise<Lookup> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept },
      signal: controller.signal,
      cache: "no-store",
    })
    if (!res.ok) return { ok: false }
    const json = (await res.json()) as DohResponse
    // Status 0 = found, 3 = the name doesn't exist (yet). Both are real answers.
    if (json.Status !== 0 && json.Status !== 3) return { ok: false }
    const values = (json.Answer ?? []).filter((a) => a.type === TXT_TYPE && typeof a.data === "string").map((a) => cleanTxt(a.data as string))
    return { ok: true, values }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

export type OwnershipCheck = { ok: true; proven: boolean } | { ok: false; error: string }

export async function checkOwnershipTxt(domain: string, token: string): Promise<OwnershipCheck> {
  const name = challengeFullName(domain)
  const expected = challengeValue(token).toLowerCase()

  const [cloudflare, google] = await Promise.all([
    lookup("https://cloudflare-dns.com/dns-query", name, "application/dns-json"),
    lookup("https://dns.google/resolve", name, "application/dns-json"),
  ])

  const seen = [cloudflare, google].some((r) => r.ok && r.values.some((v) => v.toLowerCase() === expected))
  if (seen) return { ok: true, proven: true }
  if (!cloudflare.ok && !google.ok) {
    return { ok: false, error: "We couldn't reach the DNS lookup service. Please try again in a minute." }
  }
  return { ok: true, proven: false }
}
