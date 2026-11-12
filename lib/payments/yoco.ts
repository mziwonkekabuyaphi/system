// lib/payments/yoco.ts
/**
 * Yoco adapter (Checkout API) — pure functions, no database, no tenant logic.
 * Every call takes the SHOP'S OWN secret key; this platform never has a key of its own.
 *
 * Verified against Yoco's docs (Checkout API):
 *   - POST https://payments.yoco.com/api/checkouts   (Bearer secret key; amount in cents, currency ZAR,
 *     optional successUrl / cancelUrl / failureUrl / metadata; optional Idempotency-Key header;
 *     returns id, redirectUrl, processingMode "live" | "test"; minimum charge R2)
 *   - POST https://payments.yoco.com/api/webhooks    ({name, url}; returns id + `secret` ONCE)
 *   - POST https://payments.yoco.com/api/checkouts/{id}/refund  (Bearer secret key; no body = full refund;
 *     Idempotency-Key header supported; 202 + refundId; works for LIVE checkouts only)
 *   - Webhooks are Standard-Webhooks signed: headers webhook-id, webhook-timestamp, webhook-signature;
 *     HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, key = base64-decoded part of `whsec_...`;
 *     signature header is space-separated "v1,<base64>" entries; Yoco recommends a 3 minute tolerance.
 *
 * Secrets: never logged, never put in an error message.
 */

import crypto from "node:crypto"

const API_BASE = "https://payments.yoco.com/api"
const TIMEOUT_MS = 10_000

/** Yoco does not accept charges under R2. */
export const YOCO_MIN_AMOUNT = 2
export const WEBHOOK_TOLERANCE_SECONDS = 180

export class YocoError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = "YocoError"
  }
}

/** Test and live secret keys look like sk_test_… / sk_live_…. */
export function isYocoSecretKey(key: string): boolean {
  return /^sk_(test|live)_[A-Za-z0-9]{8,}$/.test(key)
}

export function yocoModeFromKey(key: string): "test" | "live" {
  return key.startsWith("sk_live_") ? "live" : "test"
}

async function yocoPost<T>(path: string, secretKey: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}`, ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (json as { message?: unknown; displayMessage?: unknown } | null)
      const detail = typeof msg?.displayMessage === "string" ? msg.displayMessage : typeof msg?.message === "string" ? msg.message : ""
      throw new YocoError(detail || `Yoco returned ${res.status}`, res.status)
    }
    return json as T
  } catch (error) {
    if (error instanceof YocoError) throw error
    throw new YocoError(error instanceof Error && error.name === "AbortError" ? "Yoco took too long to answer" : "Couldn't reach Yoco", 0)
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------------------
// Checkout
// ----------------------------------------------------------------------------

export interface YocoCheckout {
  id: string
  redirectUrl: string
  processingMode: "live" | "test" | null
}

export async function yocoCreateCheckout(args: {
  secretKey: string
  /** In rand; converted to whole cents here, once. */
  amount: number
  currency?: string
  successUrl: string
  cancelUrl: string
  failureUrl: string
  metadata?: Record<string, string>
  /** Same key on a retry returns the same checkout instead of creating two. */
  idempotencyKey?: string
}): Promise<YocoCheckout> {
  const cents = Math.round(args.amount * 100)
  if (!Number.isInteger(cents) || cents < YOCO_MIN_AMOUNT * 100) {
    throw new YocoError(`The minimum payment is R${YOCO_MIN_AMOUNT}`, 400)
  }
  const data = await yocoPost<{ id?: string; redirectUrl?: string; processingMode?: string }>(
    "/checkouts",
    args.secretKey,
    {
      amount: cents,
      currency: args.currency ?? "ZAR",
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      failureUrl: args.failureUrl,
      metadata: args.metadata,
    },
    args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : {},
  )
  if (!data?.id || !data.redirectUrl) throw new YocoError("Yoco didn't return a checkout link", 502)
  return {
    id: data.id,
    redirectUrl: data.redirectUrl,
    processingMode: data.processingMode === "live" || data.processingMode === "test" ? data.processingMode : null,
  }
}

// ----------------------------------------------------------------------------
// Refund (full). Used when a card payment succeeded but the tickets could not be issued.
// ----------------------------------------------------------------------------

export async function yocoRefundCheckout(args: {
  secretKey: string
  checkoutId: string
  /** Same key on a retry returns the same refund instead of refunding twice. */
  idempotencyKey: string
}): Promise<{ refundId: string | null; status: string | null }> {
  const data = await yocoPost<{ refundId?: string; status?: string }>(
    `/checkouts/${encodeURIComponent(args.checkoutId)}/refund`,
    args.secretKey,
    {},
    { "Idempotency-Key": args.idempotencyKey },
  )
  return { refundId: data?.refundId ?? null, status: data?.status ?? null }
}

// ----------------------------------------------------------------------------
// Webhook registration (also proves the key works: a bad key is rejected here)
// ----------------------------------------------------------------------------

export async function yocoRegisterWebhook(args: {
  secretKey: string
  name: string
  url: string
}): Promise<{ id: string; secret: string }> {
  const data = await yocoPost<{ id?: string; secret?: string }>("/webhooks", args.secretKey, { name: args.name, url: args.url })
  if (!data?.id || !data.secret || !data.secret.startsWith("whsec_")) {
    throw new YocoError("Yoco didn't return a webhook secret", 502)
  }
  return { id: data.id, secret: data.secret }
}

// ----------------------------------------------------------------------------
// Webhook verification
// ----------------------------------------------------------------------------

export function verifyYocoWebhook(args: {
  rawBody: string
  id: string | null
  timestamp: string | null
  signature: string | null
  secret: string
  nowSeconds?: number
}): boolean {
  const { rawBody, id, timestamp, signature, secret } = args
  if (!id || !timestamp || !signature || !secret.startsWith("whsec_")) return false

  const ts = Number(timestamp)
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(ts) || Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) return false

  let key: Buffer
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64")
  } catch {
    return false
  }
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest()

  // Header is a space-separated list of "v1,<base64>"; any one matching is enough.
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",")
    if (version !== "v1" || !sig) return false
    const received = Buffer.from(sig, "base64")
    return received.length === expected.length && crypto.timingSafeEqual(received, expected)
  })
}
