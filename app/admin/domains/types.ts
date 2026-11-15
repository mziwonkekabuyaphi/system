// app/admin/domains/types.ts
//
// Shapes shared by the custom-domain server actions and the Settings panel.

export type DomainStatus = "pending" | "active" | "disabled"

/** Where a domain is in its life. The panel shows the instructions that belong to the current step. */
export type DomainStep = "prove_ownership" | "connect" | "active" | "disabled"

/** One DNS record the owner has to create at the place they bought the domain. */
export interface DnsRecord {
  type: "TXT" | "CNAME" | "A"
  /** Name to enter at the registrar. "@" means the bare domain itself. */
  host: string
  value: string
  /** The full name this record ends up at, for people who want to double-check. */
  fullName: string
}

export interface DomainView {
  id: string
  domain: string
  status: DomainStatus
  isPrimary: boolean
  step: DomainStep
  ownershipVerified: boolean
  /** Plain-words problem from the last check, if any. */
  problem: string | null
  lastCheckedAt: string | null
  /** Unproven claims lapse; shown so the owner knows how long they have. */
  expiresAt: string | null
  createdAt: string
  /** What to do right now (empty when active, or when the records couldn't be loaded). */
  records: DnsRecord[]
  /** Extra TXT record Vercel asks for when the domain is registered with another Vercel account. */
  vercelChallenge: DnsRecord | null
  /** The address once live. */
  liveUrl: string | null
}

export interface DomainList {
  domains: DomainView[]
  /** False when the server has no Vercel credentials, so connecting can't work yet. */
  serverReady: boolean
}

export interface CheckOutcome {
  view: DomainView
  /** What just happened, in plain words, for the owner. */
  message: string
}
