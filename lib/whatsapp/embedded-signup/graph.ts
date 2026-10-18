// lib/whatsapp/embedded-signup/graph.ts
/**
 * Tiny Graph API client for the WhatsApp self-connect flow.
 *
 * SERVER ONLY. Deliberately NOT a "use server" file (a browser must never be
 * able to call these). Tokens go in the Authorization header, never in a URL,
 * and are never logged or put into an error message.
 *
 * Graph version comes from META_GRAPH_API_VERSION (e.g. "v25.0"); if it is
 * missing or malformed we fall back to v25.0, the version Meta's current
 * Embedded Signup docs use.
 */

const VERSION_PATTERN = /^v\d{2}\.\d$/
const DEFAULT_VERSION = "v25.0"

export function getGraphVersion(): string {
  const configured = (process.env.META_GRAPH_API_VERSION ?? "").trim()
  return VERSION_PATTERN.test(configured) ? configured : DEFAULT_VERSION
}

export class GraphError extends Error {
  readonly status: number
  readonly code: number | null

  constructor(message: string, status: number, code: number | null) {
    super(message)
    this.name = "GraphError"
    this.status = status
    this.code = code
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

interface GraphRequestOptions {
  method?: "GET" | "POST"
  /** Sent as "Authorization: Bearer <token>". */
  token?: string
  query?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/**
 * Returns the parsed JSON body, or the raw text when Meta answers with a
 * plain string (the token-exchange page in Meta's docs shows a bare token).
 * Throws GraphError on any non-2xx answer, network failure or timeout.
 */
export async function graphRequest(path: string, options: GraphRequestOptions = {}): Promise<unknown> {
  const url = new URL(`https://graph.facebook.com/${getGraphVersion()}/${path.replace(/^\/+/, "")}`)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)

  const headers: Record<string, string> = {}
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers["Content-Type"] = "application/json"

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      cache: "no-store",
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError"
    throw new GraphError(timedOut ? "Meta took too long to answer." : "Couldn't reach Meta.", 0, null)
  }

  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON: keep the raw text
  }

  if (!response.ok) {
    const err = asRecord(asRecord(parsed)?.error)
    const userMessage = typeof err?.error_user_msg === "string" ? err.error_user_msg : null
    const message = typeof err?.message === "string" ? err.message : null
    const code = typeof err?.code === "number" ? err.code : null
    throw new GraphError(userMessage || message || `Meta returned an error (${response.status}).`, response.status, code)
  }

  return parsed
}
