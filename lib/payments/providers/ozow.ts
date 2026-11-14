// lib/payments/providers/ozow.ts
/**
 * Ozow (instant EFT / "Pay by Bank") as a CardProvider. South Africa only, ZAR only.
 *
 * Source: Ozow's integration docs ("Post from merchant website", "Process Ozow response", "Check transaction
 * status"). Only what those pages say is used; the two places the docs leave open are marked TODO(ozow).
 *
 * HOW IT FITS THE PIPELINE
 *   - connect:        no webhook is registered with Ozow (the notify URL travels with every payment request).
 *                     The credentials are proven by creating one throw-away TEST payment request, which fails
 *                     if the site code, API key or private key (hash) is wrong. Nothing can be paid on it.
 *   - createCheckout: POST https://api.ozow.com/postpaymentrequest returns a payment URL we can send on WhatsApp.
 *                     TransactionReference = OUR tenant_payments.id + a short random suffix. The suffix makes every
 *                     attempt unique, because a shisha request re-uses ONE payment row for retries (shisha-checkout.ts)
 *                     and Ozow is not documented to accept the same reference twice. The notice carries it back and
 *                     is matched on tenant_payments.provider_checkout_id, which stores exactly this value.
 *   - verifyWebhook:  the notification is a form post (JSON is accepted too). Its Hash is
 *                     SHA512(lowercase(variables 1-13 in documented order + private key)).
 *   - refunds:        not automatic. canRefund is false, so a paid-but-unfulfillable ticket is flagged
 *                     `refund_needed` for the owner (see settle.ts). Ozow does have a refund API; add it later.
 *
 * Secrets (API key, private key) are never logged and never put in an error message.
 */

import crypto from "node:crypto"

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

const API_BASE = "https://api.ozow.com"
const TIMEOUT_MS = 10_000
/** Ozow limits every URL we post to 150 characters. */
const MAX_URL_LENGTH = 150

/** TODO(ozow): Ozow's docs don't state a minimum payment. R5 is a cautious placeholder; confirm with Ozow. */
export const OZOW_MIN_AMOUNT = 5

/**
 * Ozow recommends confirming a "Complete" notice with their status API before crediting. The notice is already
 * authenticated by a hash that includes the shop's private key, so this is defence in depth, and it is OFF until it
 * has been tried against a real merchant account: its response shape comes from third-party summaries, and a wrong
 * guess would stop real payments being credited. TODO(ozow): verify against a test merchant, then switch on.
 */
export const CONFIRM_WITH_STATUS_API = false

// ----------------------------------------------------------------------------
// Hashing
// ----------------------------------------------------------------------------

/** SHA512 of the lowercase concatenation + private key, as lowercase hex (Ozow's scheme for requests and notices). */
export function ozowHash(parts: readonly string[], privateKey: string): string {
  return crypto.createHash("sha512").update(`${parts.join("")}${privateKey}`.toLowerCase(), "utf8").digest("hex")
}

/** Ozow warns that some SHA512 implementations drop leading zeros: compare without them. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toLowerCase().replace(/^0+/, ""))
  const y = Buffer.from(b.trim().toLowerCase().replace(/^0+/, ""))
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y)
}

// ----------------------------------------------------------------------------
// Payment request
// ----------------------------------------------------------------------------

export interface OzowPaymentRequest {
  siteCode: string
  apiKey: string
  privateKey: string
  /** Major units; formatted to two decimals here, once, for both the hash and the body. */
  amount: number
  /** Our tenant_payments.id (max 50 chars). */
  transactionReference: string
  bankReference: string
  successUrl: string
  cancelUrl: string
  errorUrl: string
  notifyUrl: string
  isTest: boolean
}

/** Bank statement reference: Ozow allows only letters, digits, spaces and dashes, max 20. */
export function bankReferenceFrom(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9 -]/g, "").replace(/\s+/g, " ").trim().slice(0, 20).trim()
  return cleaned || "Payment"
}

async function ozowRequest<T>(method: "GET" | "POST", path: string, apiKey: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Accept: "application/json", ApiKey: apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
    if (!res.ok) throw new ProviderError(`Ozow returned ${res.status}`, res.status)
    return json as T
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(error instanceof Error && error.name === "AbortError" ? "Ozow took too long to answer" : "Couldn't reach Ozow", 0)
  } finally {
    clearTimeout(timer)
  }
}

/** Creates a payment request and returns the hosted payment URL (Ozow's PostPaymentRequest API). */
export async function ozowCreatePaymentRequest(req: OzowPaymentRequest): Promise<{ paymentRequestId: string | null; url: string }> {
  for (const url of [req.successUrl, req.cancelUrl, req.errorUrl, req.notifyUrl]) {
    if (url.length > MAX_URL_LENGTH) throw new ProviderError("A payment URL is longer than Ozow allows (150 characters)", 400)
  }
  const amount = (Math.round(req.amount * 100) / 100).toFixed(2)
  const isTest = req.isTest ? "true" : "false"
  // Documented order: SiteCode, CountryCode, CurrencyCode, Amount, TransactionReference, BankReference,
  // (Optional1-5 and Customer, not sent), CancelUrl, ErrorUrl, SuccessUrl, NotifyUrl, IsTest, then the private key.
  const hashCheck = ozowHash(
    [req.siteCode, "ZA", "ZAR", amount, req.transactionReference, req.bankReference, req.cancelUrl, req.errorUrl, req.successUrl, req.notifyUrl, isTest],
    req.privateKey,
  )
  const data = await ozowRequest<{ paymentRequestId?: string | null; url?: string | null; errorMessage?: string | null }>("POST", "/postpaymentrequest", req.apiKey, {
    countryCode: "ZA",
    amount,
    transactionReference: req.transactionReference,
    bankReference: req.bankReference,
    cancelUrl: req.cancelUrl,
    currencyCode: "ZAR",
    errorUrl: req.errorUrl,
    isTest: req.isTest,
    notifyUrl: req.notifyUrl,
    siteCode: req.siteCode,
    successUrl: req.successUrl,
    hashCheck,
  })
  if (data?.errorMessage) throw new ProviderError("Ozow rejected the payment request", 400)
  if (!data?.url) throw new ProviderError("Ozow didn't return a payment link", 502)
  return { paymentRequestId: data.paymentRequestId ?? null, url: data.url }
}

/**
 * Ozow POSTS the customer back to the success / cancel / error URL. A normal Next page can't answer a POST, so
 * the customer comes back through app/pay/ozow-return, which redirects to the ordinary result page. Derived from
 * the URLs the shared code gives us, so no other file has to know about Ozow.
 */
function returnUrl(url: string): string {
  return url.replace("/pay/result", "/pay/ozow-return")
}

// ----------------------------------------------------------------------------
// Notification
// ----------------------------------------------------------------------------

/** Ozow's notification variables 1-13, in the order the hash is built from. (Keys are compared lower-case.) */
const RESPONSE_HASH_ORDER = [
  "sitecode", "transactionid", "transactionreference", "amount", "status",
  "optional1", "optional2", "optional3", "optional4", "optional5",
  "currencycode", "istest", "statusmessage",
] as const

/** Form body (what Ozow documents as a "post") or JSON, into lower-case keys and string values. */
export function parseOzowBody(rawBody: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  const text = rawBody.trim()
  if (!text) return null
  if (text.startsWith("{")) {
    let json: unknown
    try { json = JSON.parse(text) } catch { return null }
    if (!json || typeof json !== "object" || Array.isArray(json)) return null
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (v === null || v === undefined) out[k.toLowerCase()] = ""
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k.toLowerCase()] = String(v)
    }
    return out
  }
  for (const [k, v] of new URLSearchParams(text)) out[k.toLowerCase()] = v
  return out
}

function statusType(status: string): NormalisedWebhook["type"] {
  switch (status.toLowerCase()) {
    case "complete":
      return "succeeded"
    // A customer can retry after one of these, so they are logged and never fail the payment (see webhook-handler.ts).
    case "cancelled":
    case "error":
    case "abandoned":
      return "failed"
    // Pending / PendingInvestigation: not decided yet. Ozow posts again when it is.
    default:
      return "ignored"
  }
}

function verifyOzowWebhook(args: { rawBody: string; connection: ProviderConnection }): WebhookVerification {
  const { rawBody, connection } = args
  const privateKey = connection.secrets.privateKey
  const siteCode = connection.config.siteCode
  if (!privateKey || !siteCode) return { ok: false, reason: "bad_signature" }

  const body = parseOzowBody(rawBody)
  if (!body) return { ok: false, reason: "bad_body" }

  const received = body.hash
  if (!received) return { ok: false, reason: "bad_signature" }
  // Missing variables count as empty (Ozow sends the optional ones empty), exactly as received otherwise.
  const expected = ozowHash(RESPONSE_HASH_ORDER.map((k) => body[k] ?? ""), privateKey)
  if (!sameHash(received, expected)) return { ok: false, reason: "bad_signature" }
  // A valid hash for a different site is still not ours.
  if ((body.sitecode ?? "").toLowerCase() !== siteCode.toLowerCase()) return { ok: false, reason: "bad_signature" }

  const transactionId = body.transactionid
  const status = body.status ?? ""
  if (!transactionId || !status) return { ok: false, reason: "bad_body" }

  // A test notice must never credit a live shop, and a live notice never a test shop.
  const noticeIsTest = (body.istest ?? "").toLowerCase() === "true"
  const type: NormalisedWebhook["type"] = noticeIsTest === (connection.mode === "test") ? statusType(status) : "ignored"

  const amount = Number.parseFloat(body.amount ?? "")
  const event: NormalisedWebhook = {
    // One id per state change: a repeat of the same status is a duplicate, Pending -> Complete is not.
    deliveryId: `${transactionId}:${status.toLowerCase()}`,
    eventType: status,
    type,
    checkoutRef: body.transactionreference || null,
    providerPaymentId: transactionId,
    amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: body.currencycode ? body.currencycode.toUpperCase() : null,
  }
  return { ok: true, event }
}

// ----------------------------------------------------------------------------
// Optional confirmation with Ozow's status API (see CONFIRM_WITH_STATUS_API)
// ----------------------------------------------------------------------------

/** true when Ozow itself says this transaction is Complete for this amount. Throws on a network failure (the notice is retried). */
export async function confirmWithStatusApi(connection: ProviderConnection, event: NormalisedWebhook): Promise<boolean> {
  const apiKey = connection.secrets.apiKey
  const siteCode = connection.config.siteCode
  if (!apiKey || !siteCode || !event.checkoutRef) return false
  const rows = await ozowRequest<unknown>(
    "GET",
    `/GetTransactionByReference?siteCode=${encodeURIComponent(siteCode)}&transactionReference=${encodeURIComponent(event.checkoutRef)}`,
    apiKey,
  )
  if (!Array.isArray(rows)) return false
  return rows.some((row) => {
    if (!row || typeof row !== "object") return false
    const r: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) r[k.toLowerCase()] = v
    const amount = Number(r.amount)
    return (
      String(r.status ?? "").toLowerCase() === "complete" &&
      String(r.transactionid ?? "").toLowerCase() === (event.providerPaymentId ?? "").toLowerCase() &&
      Number.isFinite(amount) &&
      Math.round(amount * 100) === event.amountMinor
    )
  })
}

// ----------------------------------------------------------------------------
// The provider
// ----------------------------------------------------------------------------

export const ozowProvider: CardProvider = {
  id: "ozow",
  label: "Ozow",
  description:
    "Customers pay by instant EFT from their own bank, through Ozow's secure page, and the money goes straight to your own Ozow account. This platform never holds your money or sees banking details.",
  currencies: ["ZAR"],
  minAmount: OZOW_MIN_AMOUNT,
  fields: [
    { name: "siteCode", label: "Ozow site code", secret: false, placeholder: "e.g. ABC-ABC-001", help: "From your Ozow merchant admin, under your site." },
    { name: "apiKey", label: "Ozow API key", secret: true, help: "From the merchant details section of your Ozow merchant admin. Saved encrypted and can't be shown again." },
    { name: "privateKey", label: "Ozow private key", secret: true, help: "From the merchant details section of your Ozow merchant admin. Never share it. Saved encrypted and can't be shown again." },
    { name: "mode", label: "Mode (test or live)", secret: false, placeholder: "test", help: "Type test to practise (no real money moves). Type live when you are ready for real payments." },
  ],
  // Vault names: payments_ozow_api_key_<id>, payments_ozow_private_key_<id> (the default snake_case of the field names).
  disconnectNote: "Ozow needs nothing removed on your side. Payment links already sent stop being credited.",
  invalidCredentialsMessage: "Ozow didn't accept those details. Check the site code, API key and private key.",

  async connect({ fields, webhookUrl }) {
    const siteCode = (fields.siteCode ?? "").trim()
    const apiKey = (fields.apiKey ?? "").trim()
    const privateKey = (fields.privateKey ?? "").trim()
    const mode = (fields.mode ?? "").trim().toLowerCase()
    if (mode !== "test" && mode !== "live") throw new ConnectInputError("Type test or live in the Mode box.")
    if (!/^[A-Za-z0-9-]{3,50}$/.test(siteCode)) throw new ConnectInputError("That doesn't look like an Ozow site code (letters, numbers and dashes).")

    // Proof that the three credentials work together: one TEST payment request. Nobody is sent the link.
    const base = new URL(webhookUrl).origin
    try {
      await ozowCreatePaymentRequest({
        siteCode,
        apiKey,
        privateKey,
        amount: OZOW_MIN_AMOUNT,
        transactionReference: crypto.randomUUID(),
        bankReference: "Connection check",
        successUrl: `${base}/pay/ozow-return?status=success`,
        cancelUrl: `${base}/pay/ozow-return?status=cancelled`,
        errorUrl: `${base}/pay/ozow-return?status=failed`,
        notifyUrl: webhookUrl,
        isTest: true,
      })
    } catch (error) {
      // A rejected request (bad key, bad hash) is a credentials problem; an outage stays an outage.
      if (error instanceof ProviderError && (error.status === 400 || error.status === 401 || error.status === 403)) {
        throw new ProviderError("Ozow rejected the credentials", 401)
      }
      throw error
    }

    return {
      mode: mode as PaymentMode,
      keyHint: apiKey.slice(-4),
      secrets: { apiKey, privateKey },
      config: { siteCode },
      providerWebhookId: null,
    }
  },

  async createCheckout(req: CheckoutRequest) {
    const { apiKey, privateKey } = req.connection.secrets
    const siteCode = req.connection.config.siteCode
    if (!apiKey || !privateKey || !siteCode) throw new ProviderError("Ozow isn't fully connected", 401)
    // 36-character payment id + "-" + 6 hex = 43 characters (Ozow allows 50). Unique on every call.
    const reference = `${req.paymentId}-${crypto.randomBytes(3).toString("hex")}`
    const result = await ozowCreatePaymentRequest({
      siteCode,
      apiKey,
      privateKey,
      amount: req.amount,
      transactionReference: reference,
      bankReference: bankReferenceFrom(req.description),
      successUrl: returnUrl(req.successUrl),
      cancelUrl: returnUrl(req.cancelUrl),
      errorUrl: returnUrl(req.failureUrl),
      notifyUrl: req.notifyUrl,
      isTest: req.connection.mode === "test",
    })
    // The notice carries TransactionReference back, so that is the reference we store and match on.
    return { checkoutId: reference, redirectUrl: result.url, mode: req.connection.mode }
  },

  verifyWebhook: ({ rawBody, connection }) => verifyOzowWebhook({ rawBody, connection }),

  async confirmSucceeded({ connection, event }) {
    if (!CONFIRM_WITH_STATUS_API || connection.mode !== "live") return true
    return confirmWithStatusApi(connection, event)
  },

  // Automatic refunds are not built yet: a failed-fulfilment payment is flagged for the owner instead.
  canRefund: () => false,
}
