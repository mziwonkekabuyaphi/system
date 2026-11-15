// lib/payments/providers/peach.ts
/**
 * Peach Payments as a CardProvider: Hosted Checkout V1, redirect-based (cards, EFT, wallets, whatever the shop's
 * Peach account has switched on). The shop's OWN Peach account; this platform never holds a key of its own.
 *
 * Source: Peach's developer docs (Hosted Checkout V1: authentication, payment request, redirect response, webhooks).
 * V1 needs only two credentials (Entity ID + Secret token). Peach's newer "V2" needs OAuth and more credentials.
 *
 *   - POST {host}/checkout/initiate  form-encoded, signed. Answers {"redirectUrl": "..."}. Host: secure.peachpayments.com
 *     (live) or testsecure.peachpayments.com (sandbox): separate Entity IDs and secret tokens per mode.
 *   - Signature (requests, webhooks and redirects all use it): HMAC-SHA256, key = secret token, message = every parameter
 *     except `signature`, sorted by name, name+value concatenated with nothing between (empty values included).
 *   - The calling domain must be on the shop's "Allowlisted domains" (Peach Dashboard > Checkout), sent as the Referer.
 *   - notificationUrl is sent PER REQUEST, so the owner doesn't paste a webhook address anywhere.
 *   - Notices are form-encoded POSTs, states created / pending / successful / uncertain / cancelled, in any order, and
 *     REFUND notices (paymentType RF) arrive at the same address: they must never credit anything.
 *   - merchantTransactionId must be 8-16 characters, so our 36-character payment id can't be used. A random 16-hex
 *     reference is generated per attempt and stored as provider_checkout_id (it is also unique per retry).
 *
 * KNOWN GAPS (TODO(peach), to be settled with a sandbox account):
 *   - Peach's own worked signing example does not reproduce from its written rule (no variant matches), so the rule is
 *     implemented as WRITTEN. Safe either way: Connect proves request signing (Peach rejects a bad signature), and a
 *     notice that doesn't verify is rejected and never credited. Webhook verification also accepts the same signature
 *     computed without `timestamp`, in case Peach leaves it out.
 *   - The exact list of "successful" result codes: only Peach/OPP's standard success family is treated as paid.
 *   - Minimum amount. Refunds (done by hand in the Peach Dashboard for now: canRefund is false).
 *
 * Secrets are never logged and never put in an error message.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import {
  ConnectInputError,
  ProviderError,
  type CardProvider,
  type CheckoutRequest,
  type NormalisedWebhook,
  type PaymentMode,
  type WebhookVerification,
} from "./types"

const HOSTS: Record<PaymentMode, string> = {
  live: "https://secure.peachpayments.com",
  test: "https://testsecure.peachpayments.com",
}
const TIMEOUT_MS = 10_000

/** TODO(peach): not stated in the docs. R2 is a cautious placeholder; confirm with Peach. */
export const PEACH_MIN_AMOUNT = 2

/** Our reference: 16 hex characters (Peach allows 8-16 for merchantTransactionId). */
export function isPeachReference(reference: string): boolean {
  return /^[0-9a-f]{16}$/.test(reference)
}

// ----------------------------------------------------------------------------
// Signature
// ----------------------------------------------------------------------------

/** HMAC-SHA256 (hex) over every parameter, sorted by name, "name" + "value" concatenated; the secret token is the key. */
export function peachSignature(params: Record<string, string>, secretToken: string): string {
  const message = Object.keys(params)
    .sort()
    .map((name) => `${name}${params[name]}`)
    .join("")
  return createHmac("sha256", secretToken).update(message).digest("hex")
}

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toLowerCase())
  const y = Buffer.from(b.trim().toLowerCase())
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

// ----------------------------------------------------------------------------
// Payment request
// ----------------------------------------------------------------------------

export interface PeachInitiate {
  mode: PaymentMode
  entityId: string
  secretToken: string
  amount: number
  merchantTransactionId: string
  shopperResultUrl: string
  notificationUrl: string
  cancelUrl: string
  /** The calling domain; must be on the shop's Allowlisted domains. */
  referer: string
}

export async function peachInitiate(args: PeachInitiate): Promise<{ redirectUrl: string }> {
  const params: Record<string, string> = {
    "authentication.entityId": args.entityId,
    amount: (Math.round(args.amount * 100) / 100).toFixed(2),
    currency: "ZAR",
    merchantTransactionId: args.merchantTransactionId,
    nonce: randomBytes(16).toString("hex"),
    paymentType: "DB",
    shopperResultUrl: args.shopperResultUrl,
    notificationUrl: args.notificationUrl,
    cancelUrl: args.cancelUrl,
  }
  const signature = peachSignature(params, args.secretToken)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${HOSTS[args.mode]}/checkout/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Referer: args.referer },
      body: new URLSearchParams({ ...params, signature }).toString(),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: { redirectUrl?: unknown } | null = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON error body */ }
    if (!res.ok) throw new ProviderError(`Peach returned ${res.status}`, res.status)
    if (!json || typeof json.redirectUrl !== "string" || !json.redirectUrl.startsWith("https://")) {
      throw new ProviderError("Peach didn't return a payment link", 502)
    }
    return { redirectUrl: json.redirectUrl }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(error instanceof Error && error.name === "AbortError" ? "Peach took too long to answer" : "Couldn't reach Peach", 0)
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------------------
// Notification
// ----------------------------------------------------------------------------

/** Peach / OPP "successfully processed" result-code family (000.000.*, 000.100.1*, 000.3*, 000.6*). Pending is 000.200.*. */
const SUCCESS_CODE = /^(000\.000\.|000\.100\.1|000\.[36])/
const PENDING_CODE = /^000\.200\./

export function isPeachSuccessCode(code: string): boolean {
  return SUCCESS_CODE.test(code)
}

function field(body: Record<string, string>, ...names: string[]): string {
  for (const name of names) if (body[name] !== undefined) return body[name]
  return ""
}

/** Notices are form-encoded; the names are kept exactly as received (the signature covers them as received). */
export function parsePeachBody(rawBody: string): Record<string, string> | null {
  const text = rawBody.trim()
  if (!text || text.startsWith("{")) return null // empty, or Peach's one-off JSON configuration webhook: nothing to act on
  const out: Record<string, string> = {}
  for (const [name, value] of new URLSearchParams(text)) out[name] = value
  return out
}

function verifyPeachWebhook(args: { rawBody: string; secretToken: string | undefined }): WebhookVerification {
  const secretToken = args.secretToken
  if (!secretToken) return { ok: false, reason: "bad_signature" }
  const body = parsePeachBody(args.rawBody)
  if (!body) return { ok: false, reason: "bad_body" }

  const received = body.signature
  if (!received) return { ok: false, reason: "bad_signature" }
  const { signature: _ignored, ...signed } = body
  void _ignored
  const { timestamp: _ts, ...signedWithoutTimestamp } = signed
  void _ts
  const valid =
    sameSignature(received, peachSignature(signed, secretToken)) || sameSignature(received, peachSignature(signedWithoutTimestamp, secretToken))
  if (!valid) return { ok: false, reason: "bad_signature" }

  const paymentType = field(body, "paymentType").toUpperCase()
  const resultCode = field(body, "result.code", "result_code")
  const reference = field(body, "merchantTransactionId")
  const transactionId = field(body, "id")
  const checkoutId = field(body, "checkoutId")
  if (!reference) return { ok: false, reason: "bad_body" }

  // Only our own debits can ever credit. Refund (RF) and anything else at this address is recorded and ignored.
  let type: NormalisedWebhook["type"] = "ignored"
  if (paymentType === "DB") {
    if (isPeachSuccessCode(resultCode)) type = "succeeded"
    else if (PENDING_CODE.test(resultCode)) type = "ignored" // created / pending: not decided yet
    else if (resultCode) type = "failed" // cancelled, uncertain, rejected: logged only (a customer can retry)
  }

  const amountText = field(body, "amount")
  const amount = /^[0-9]{1,8}(\.[0-9]{2})?$/.test(amountText) ? Number.parseFloat(amountText) : Number.NaN
  const currency = field(body, "currency")

  const event: NormalisedWebhook = {
    // Peach sends no delivery id: transaction (or checkout) + result code is the identity. A retry is a duplicate,
    // "pending" -> "successful" is not.
    deliveryId: `${paymentType || "?"}:${transactionId || checkoutId || reference}:${resultCode || "none"}`,
    eventType: resultCode ? `${paymentType || "?"} ${resultCode}` : paymentType || null,
    type,
    checkoutRef: reference,
    providerPaymentId: transactionId || null,
    amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: currency ? currency.toUpperCase() : null,
  }
  return { ok: true, event }
}

/**
 * What the customer's browser POSTs back to us is only used to choose the words on the result page, never to credit
 * anything: "cancelled" when Peach says the customer cancelled, otherwise no hint.
 */
export function peachReturnHint(resultCode: string): "cancelled" | null {
  return /^100\.396\.10[14]$/.test(resultCode) ? "cancelled" : null
}

// ----------------------------------------------------------------------------
// The provider
// ----------------------------------------------------------------------------

export const peachProvider: CardProvider = {
  id: "peach",
  label: "Peach Payments",
  description:
    "Customers pay on Peach Payments' secure page (cards, instant EFT and more, depending on your Peach account) and the money goes straight to your own Peach account. This platform never holds your money or sees card details.",
  currencies: ["ZAR"],
  minAmount: PEACH_MIN_AMOUNT,
  fields: [
    {
      name: "entityId",
      label: "Peach Entity ID",
      secret: false,
      placeholder: "e.g. 8ac7a4ca68c22c4d0168c2caab2e0025",
      help: "From your Peach Payments Dashboard, Checkout > API keys. Use the Entity ID for the mode you are connecting (the Test one for practice).",
    },
    {
      name: "secretToken",
      label: "Peach Secret token",
      secret: true,
      help: "From the same place. Saved encrypted and can't be shown again. Test and live have different tokens.",
    },
    {
      name: "mode",
      label: "Mode (test or live)",
      secret: false,
      placeholder: "test",
      help: "Type test to practise (no real money moves). Type live when you are ready for real payments.",
    },
  ],
  // Vault names: payments_peach_secret_token_<id> (the default snake_case of the field name).
  disconnectNote: "Peach needs nothing removed on your side. You can also remove this platform's domain from your Peach Allowlisted domains.",
  invalidCredentialsMessage:
    "Peach didn't accept those details. Check the Entity ID, the secret token and the mode, and that this platform's domain is in your Peach Dashboard under Checkout > Allowlisted domains.",
  prerequisite: {
    instructions:
      "Before connecting: in your Peach Payments Dashboard open Checkout > Allowlisted domains, click Add domain and add this domain. Peach only accepts payment requests from allowlisted domains (a live domain is checked by Peach first, which can take a little while).",
  },

  async connect({ fields, webhookUrl }) {
    const entityId = (fields.entityId ?? "").trim()
    const secretToken = (fields.secretToken ?? "").trim()
    const mode = (fields.mode ?? "").trim().toLowerCase()
    if (mode !== "test" && mode !== "live") throw new ConnectInputError("Type test or live in the Mode box.")
    if (!/^[A-Za-z0-9]{16,64}$/.test(entityId)) throw new ConnectInputError("That doesn't look like a Peach Entity ID (letters and numbers only).")
    if (secretToken.length < 16 || /\s/.test(secretToken)) throw new ConnectInputError("That doesn't look like a Peach secret token.")

    // Proof that Entity ID, secret token (the signature) and the allowlisted domain all work together: Peach only answers
    // a correctly signed request from an allowlisted domain. Nothing is paid; the link is thrown away.
    const origin = new URL(webhookUrl).origin
    try {
      await peachInitiate({
        mode,
        entityId,
        secretToken,
        amount: PEACH_MIN_AMOUNT,
        merchantTransactionId: randomBytes(8).toString("hex"),
        shopperResultUrl: `${origin}/pay/peach-return`,
        notificationUrl: webhookUrl,
        cancelUrl: `${origin}/pay/result?status=cancelled`,
        referer: origin,
      })
    } catch (error) {
      // A rejected request (bad signature, unknown entity, domain not allowlisted) is a credentials problem; an outage stays an outage.
      if (error instanceof ProviderError && error.status >= 400 && error.status < 500) throw new ProviderError("Peach rejected the credentials", 401)
      throw error
    }

    return { mode: mode as PaymentMode, keyHint: entityId.slice(-4), secrets: { secretToken }, config: { entityId }, providerWebhookId: null }
  },

  async createCheckout(req: CheckoutRequest) {
    const secretToken = req.connection.secrets.secretToken
    const entityId = req.connection.config.entityId
    if (!secretToken || !entityId) throw new ProviderError("Peach isn't fully connected", 401)
    const cents = Math.round(req.amount * 100)
    if (!Number.isInteger(cents) || cents < PEACH_MIN_AMOUNT * 100) throw new ProviderError(`The minimum payment is R${PEACH_MIN_AMOUNT}`, 400)

    const origin = new URL(req.notifyUrl).origin
    // 16 hex = 64 random bits: unique per attempt (a shisha retry re-uses ONE payment row, so the payment id can't be the reference).
    const reference = randomBytes(8).toString("hex")
    const { redirectUrl } = await peachInitiate({
      mode: req.connection.mode,
      entityId,
      secretToken,
      amount: req.amount,
      merchantTransactionId: reference,
      // Peach POSTs the customer back, which a normal page can't answer: see app/pay/peach-return/route.ts.
      shopperResultUrl: `${origin}/pay/peach-return`,
      notificationUrl: req.notifyUrl,
      cancelUrl: req.cancelUrl,
      referer: origin,
    })
    return { checkoutId: reference, redirectUrl, mode: req.connection.mode }
  },

  verifyWebhook: ({ rawBody, connection }) => verifyPeachWebhook({ rawBody, secretToken: connection.secrets.secretToken }),

  // Refunds are made by the owner in the Peach Dashboard for now: settle.ts flags the payment `refund_needed`.
  canRefund: () => false,
}
