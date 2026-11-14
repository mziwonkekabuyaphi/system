// lib/payments/providers/paystack.ts
/**
 * Paystack as a CardProvider. The shop's OWN Paystack account; this platform never holds a key of its own.
 *
 * Facts used (Paystack's docs, as recorded in the earlier Paystack work in this project):
 *   - POST https://api.paystack.co/transaction/initialize   Bearer secret key; email + amount (integer, in the
 *     currency's subunit: cents for ZAR) are required; our own unique `reference` (letters, digits, - . = only);
 *     `callback_url` overrides the dashboard one; returns data.authorization_url + data.reference.
 *   - GET  https://api.paystack.co/transaction/verify/:reference  -> data.status "success", amount, currency, domain.
 *     Paystack's own guidance: ALWAYS verify before giving value; reaching the callback URL proves nothing.
 *   - POST https://api.paystack.co/refund                    { transaction: reference }; no amount = full refund.
 *   - Webhook: header x-paystack-signature = HEX HMAC-SHA512 of the RAW body, keyed with the SECRET KEY
 *     (no separate webhook secret, no timestamp). Event of interest: "charge.success".
 *   - There is NO API to register a webhook. The owner pastes the notice URL into their Paystack dashboard
 *     (Settings > API Keys & Webhooks); test and live keys have separate URL boxes.
 *
 * HOW IT FITS THE PIPELINE
 *   - connect:           one authenticated read-only call proves the key. Nothing is registered at Paystack.
 *   - createCheckout:    reference = "pay-<our payment id>-<6 hex>". The suffix keeps every attempt unique, because a
 *                        shisha request re-uses ONE payment row for retries. Stored as provider_checkout_id.
 *   - verifyWebhook:     signature over the raw body. A notice for the other mode (test/live) is ignored.
 *   - confirmSucceeded:  ALWAYS ON. The webhook body is never trusted for status or amount: Paystack is asked
 *                        directly (verify API) and must agree on reference, amount and currency before anything is
 *                        credited. If Paystack can't be reached the notice is retried.
 *   - return page:       see paystack-reconcile.ts (credits safely even if the owner forgot the webhook URL).
 *
 * Secrets are never logged and never put in an error message.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import {
  ConnectInputError,
  ProviderError,
  type CardProvider,
  type CheckoutRequest,
  type NormalisedWebhook,
  type PaymentMode,
  type ProviderConnection,
  type WebhookVerification,
} from "./types"

const API_BASE = "https://api.paystack.co"
const TIMEOUT_MS = 10_000

/** TODO(paystack): the real ZAR minimum isn't confirmed. R1 is deliberately low: Paystack itself rejects anything below its minimum. */
export const PAYSTACK_MIN_AMOUNT = 1

/** Test and live secret keys look like sk_test_… / sk_live_… (the mode can be read from the key). */
export function isPaystackSecretKey(key: string): boolean {
  return /^sk_(test|live)_[A-Za-z0-9]{8,}$/.test(key)
}

export function paystackModeFromKey(key: string): PaymentMode {
  return key.startsWith("sk_live_") ? "live" : "test"
}

/** Our references: "pay-" + payment id (36) + "-" + 6 hex. Only these are ever looked up from a return URL. */
export function isPaystackReference(reference: string): boolean {
  return /^pay-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{6}$/i.test(reference)
}

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------

async function paystackCall<T>(method: "GET" | "POST", path: string, secretKey: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: { status?: boolean; message?: string; data?: unknown } | null = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON error body */ }
    // Paystack answers { status: true|false, message, data }. A 200 with status:false is still a failure.
    if (!res.ok || !json || json.status !== true) {
      throw new ProviderError((typeof json?.message === "string" && json.message) || `Paystack returned ${res.status}`, res.ok ? 400 : res.status)
    }
    return json.data as T
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(error instanceof Error && error.name === "AbortError" ? "Paystack took too long to answer" : "Couldn't reach Paystack", 0)
  } finally {
    clearTimeout(timer)
  }
}

export interface PaystackVerification {
  /** Paystack's own word for the outcome: "success", "failed", "abandoned", … */
  status: string
  amountMinor: number
  currency: string
  reference: string
  id: string | null
  /** "test" or "live" as Paystack reports it ("" if absent). */
  domain: string
}

/** Asks Paystack itself what happened to a transaction. Throws ProviderError on an outage or a bad key. */
export async function paystackVerifyTransaction(secretKey: string, reference: string): Promise<PaystackVerification> {
  const data = await paystackCall<{ status?: string; amount?: number; currency?: string; reference?: string; id?: number | string; domain?: string }>(
    "GET",
    `/transaction/verify/${encodeURIComponent(reference)}`,
    secretKey,
  )
  return {
    status: String(data?.status ?? ""),
    amountMinor: Number(data?.amount),
    currency: String(data?.currency ?? "").toUpperCase(),
    reference: String(data?.reference ?? ""),
    id: data?.id !== undefined && data?.id !== null ? String(data.id) : null,
    domain: String(data?.domain ?? "").toLowerCase(),
  }
}

/** true only when Paystack agrees this exact payment succeeded, for this amount, in the right mode. */
export function verificationAgrees(v: PaystackVerification, expected: { reference: string; amountMinor: number | null; currency: string | null; mode: PaymentMode }): boolean {
  if (v.status !== "success") return false
  if (v.reference !== expected.reference) return false
  if (expected.amountMinor === null || !Number.isInteger(v.amountMinor) || v.amountMinor !== expected.amountMinor) return false
  if (expected.currency === null || v.currency !== expected.currency.toUpperCase()) return false
  if (v.domain && v.domain !== expected.mode) return false
  return true
}

// ----------------------------------------------------------------------------
// Webhook
// ----------------------------------------------------------------------------

/** Hex HMAC-SHA512 of the raw body, keyed with the shop's secret key. Constant-time compare. */
export function verifyPaystackSignature(args: { rawBody: string; signature: string | null; secretKey: string }): boolean {
  if (!args.signature || !args.secretKey) return false
  const expected = createHmac("sha512", args.secretKey).update(args.rawBody).digest("hex")
  const received = args.signature.trim().toLowerCase()
  if (received.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected))
}

interface PaystackEvent {
  event?: string
  data?: { id?: number | string | null; reference?: string; amount?: number; currency?: string; domain?: string }
}

function verifyPaystackWebhook(args: { rawBody: string; headers: Headers; connection: ProviderConnection }): WebhookVerification {
  const { rawBody, headers, connection } = args
  const secretKey = connection.secrets.secretKey
  if (!secretKey || !verifyPaystackSignature({ rawBody, signature: headers.get("x-paystack-signature"), secretKey })) {
    return { ok: false, reason: "bad_signature" }
  }

  let body: PaystackEvent
  try {
    body = JSON.parse(rawBody) as PaystackEvent
  } catch {
    return { ok: false, reason: "bad_body" }
  }
  if (!body || typeof body.event !== "string" || !body.event) return { ok: false, reason: "bad_body" }

  const data = body.data ?? {}
  const reference = typeof data.reference === "string" && data.reference ? data.reference : null
  // Paystack has no webhook id: the event name + its transaction id is the identity (a repeat is a duplicate).
  const idPart =
    data.id !== undefined && data.id !== null ? String(data.id) : reference ?? createHash("sha256").update(rawBody).digest("hex").slice(0, 16)

  // Test and live keys have separate webhook boxes; a notice for the other mode must never credit this shop.
  const domain = typeof data.domain === "string" ? data.domain.toLowerCase() : ""
  const wrongMode = domain !== "" && domain !== connection.mode

  const event: NormalisedWebhook = {
    deliveryId: `${body.event}:${idPart}`,
    eventType: body.event,
    type: body.event === "charge.success" && !wrongMode ? "succeeded" : "ignored",
    checkoutRef: reference,
    providerPaymentId: data.id !== undefined && data.id !== null ? String(data.id) : null,
    amountMinor: typeof data.amount === "number" ? data.amount : null,
    currency: typeof data.currency === "string" && data.currency ? data.currency.toUpperCase() : null,
  }
  return { ok: true, event }
}

// ----------------------------------------------------------------------------
// The provider
// ----------------------------------------------------------------------------

export const paystackProvider: CardProvider = {
  id: "paystack",
  label: "Paystack",
  description:
    "Customers pay on Paystack's secure page and the money goes straight to your own Paystack account. This platform never holds your money or sees card details.",
  currencies: ["ZAR"],
  minAmount: PAYSTACK_MIN_AMOUNT,
  fields: [
    {
      name: "secretKey",
      label: "Paystack secret key",
      secret: true,
      placeholder: "sk_test_… or sk_live_…",
      help: "Find it in your Paystack Dashboard under Settings > API Keys & Webhooks. Use the secret key, never the public one. Start with the test key. It is saved encrypted and can't be shown again.",
    },
  ],
  // Vault name: payments_paystack_secret_key_<integration id> (the default snake_case of the field name).
  disconnectNote: "Also remove the webhook address from your Paystack dashboard (Settings > API Keys & Webhooks).",
  invalidCredentialsMessage: "Paystack didn't accept that key. Check you copied the secret key, not the public one.",
  webhookSetup: {
    instructions:
      "Paystack can't be told our address automatically. In your Paystack dashboard open Settings > API Keys & Webhooks and paste this address into the Webhook URL box (the Test box for a test key, the Live box for a live key), then save.",
  },

  async connect({ fields }) {
    const secretKey = (fields.secretKey ?? "").trim()
    if (!isPaystackSecretKey(secretKey)) {
      throw new ConnectInputError("That doesn't look like a Paystack secret key. It starts with sk_test_ or sk_live_.")
    }
    // One authenticated, read-only call: Paystack rejects a bad key here, before anything is saved.
    await paystackCall("GET", "/transaction?perPage=1", secretKey)
    return {
      mode: paystackModeFromKey(secretKey),
      keyHint: secretKey.slice(-4),
      secrets: { secretKey },
      config: {},
      providerWebhookId: null,
    }
  },

  async createCheckout(req: CheckoutRequest) {
    const secretKey = req.connection.secrets.secretKey
    if (!secretKey) throw new ProviderError("Paystack isn't fully connected", 401)
    const cents = Math.round(req.amount * 100)
    if (!Number.isInteger(cents) || cents < PAYSTACK_MIN_AMOUNT * 100) {
      throw new ProviderError(`The minimum payment is R${PAYSTACK_MIN_AMOUNT}`, 400)
    }

    // Paystack insists on a customer email. We don't collect one, so a placeholder on this app's own host is used.
    const host = new URL(req.notifyUrl).hostname
    const email = `customer-${req.paymentId}@${host}`
    // Unique on every call (letters, digits and dashes only, as Paystack requires).
    const reference = `pay-${req.paymentId}-${randomBytes(3).toString("hex")}`
    // Paystack adds ?trxref=…&reference=… to the callback, so keep it free of our own query string.
    const returnBase = new URL(req.successUrl)
    const callbackUrl = `${returnBase.origin}${returnBase.pathname}`

    const data = await paystackCall<{ authorization_url?: string; reference?: string }>("POST", "/transaction/initialize", secretKey, {
      email,
      amount: cents,
      currency: req.currency,
      reference,
      callback_url: callbackUrl,
      metadata: { ...(req.metadata ?? {}), paymentId: req.paymentId, cancel_action: req.cancelUrl },
    })
    if (!data?.authorization_url) throw new ProviderError("Paystack didn't return a payment link", 502)
    // Paystack keeps our reference as given; use what it returned if present so the stored id is the one it will send back.
    return { checkoutId: data.reference || reference, redirectUrl: data.authorization_url, mode: req.connection.mode }
  },

  verifyWebhook: ({ rawBody, headers, connection }) => verifyPaystackWebhook({ rawBody, headers, connection }),

  /** Always on: Paystack itself must agree on reference, amount, currency and mode before anything is credited. */
  async confirmSucceeded({ connection, event }) {
    const secretKey = connection.secrets.secretKey
    if (!secretKey || !event.checkoutRef) return false
    const verified = await paystackVerifyTransaction(secretKey, event.checkoutRef)
    return verificationAgrees(verified, {
      reference: event.checkoutRef,
      amountMinor: event.amountMinor,
      currency: event.currency,
      mode: connection.mode,
    })
  },

  // Full refund by reference. Whether TEST-mode transactions can be refunded isn't confirmed: if Paystack refuses, settle.ts
  // flags the payment `refund_needed` and the owner is told in Settings > Payments, exactly as for a Yoco test payment.
  canRefund: () => true,
  async refund({ connection, checkoutId }) {
    const secretKey = connection.secrets.secretKey
    if (!secretKey) throw new ProviderError("Paystack isn't fully connected", 401)
    await paystackCall("POST", "/refund", secretKey, { transaction: checkoutId })
  },
}
