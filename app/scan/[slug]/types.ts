// app/scan/[slug]/types.ts
//
// Shapes shared by the scanner page, the client app and the server actions.

export type ScanResult = "valid" | "invalid" | "duplicate" | "wrong_event" | "cancelled" | "event_closed"

/** What the page needs to dress itself as the tenant. Nothing secret, nothing per-user. */
export interface ScanTenant {
  slug: string
  name: string
  logoUrl: string | null
  timezone: string
  /** false when the tenant has paid to remove the "Powered by" line. */
  showPoweredBy: boolean
  /** CSS custom properties (--brand, --accent...) built from the tenant's colours. */
  brandVars: Record<string, string>
}

/** An event the gate can check people into (status = active). */
export interface ScanEvent {
  id: string
  name: string
  location: string | null
  /** ISO timestamps */
  startTime: string
  endTime: string | null
}

export interface ScanFeedRow {
  id: string
  ticketNumber: string | null
  result: ScanResult
  ticketType: string | null
  gate: string | null
  scannedAt: string
}

export interface ScanSnapshot {
  /** Tickets sold (issued or used). */
  sold: number
  /** Tickets that have been scanned in at least once. */
  admitted: number
  /** Scans the gate refused (invalid, duplicate, cancelled, wrong event, closed). */
  refused: number
  recent: ScanFeedRow[]
}

/** What a scan or manual check-in came back with. Refusals are results, not errors. */
export interface ScanOutcome {
  success: boolean
  result: ScanResult
  message: string
  ticketNumber?: string
  ticketType?: string | null
  holder?: string | null
  entriesUsed?: number
  entriesAllowed?: number
  lastScannedAt?: string | null
  /** Set when a phone number checked in several tickets at once. */
  ticketCount?: number
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }
