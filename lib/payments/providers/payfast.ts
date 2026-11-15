// lib/payments/providers/payfast.ts
/**
 * PayFast (Payfast by Network) as a CardProvider: the customer pays on PayFast's hosted page (cards, instant EFT, and
 * whatever the shop's PayFast account has switched on) and the money goes to the shop's OWN PayFast account.
 *
 * Source: PayFast's custom-integration rules as described by PayFast's own security checklist and the integration
 * guides / SDKs that follow them. PayFast's developer site itself wasn't reachable while this was written, so the items
 * marked TODO(payfast) are to be settled with the first sandbox payment.
 *
 *   - Payment page: https://www.payfast.co.za/eng/process (live) / https://sandbox.payfast.co.za/eng/process (sandbox).
 *     The request is the form fields below plus `signature`. We hand the customer the same fields as a signed link (GET),
 *     so there is no server call at all when a checkout is created.
 *   - Signature (request): MD5 of "name=urlencode(value)" pairs in PayFast's FIXED field order (not alphabetical),
 *     joined with "&", EMPTY values left out, then "&passphrase=urlencode(passphrase)". A passphrase is REQUIRED here:
 *     without one the signature is unsalted, so anyone could forge it.
 *   - ITN (Instant Transaction Notification): a form POST to notify_url (sent per request, so nothing to register).
 *     PayFast's four mandatory checks, all done here: (1) signature, (2) the sender is PayFast's own server,
 *     (3) the amount matches (settle.ts), (4) PayFast confirms the data (POST to /eng/query/validate -> "VALID").
 *   - Fields: payment_status COMPLETE | FAILED | PENDING | CANCELLED, m_payment_id (ours), pf_payment_id (theirs),
 *     amount_gross. There is no currency field: PayFast is ZAR only.
 *
 * KNOWN GAPS (TODO(payfast)): the link is a GET to /eng/process (the form POST is the documented one; GET is what the
 * common SDKs use); the minimum amount; refunds (PayFast has an API, not built: canRefund is false, the owner refunds
 * in the PayFast dashboard); connect can only check the FORMAT of the credentials, because PayFast has no free
 * credential check, so the first test payment is the proof. Every check fails closed: nothing is credited on a doubt.
 *
 * Secrets (merchant key, passphrase) are never logged and never put in an error message.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { promises as dns } from "node:dns"

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

const HOSTS: Record<PaymentMode, string> = {
  live: "www.payfast.co.za",
  test: "sandbox.payfast.co.za",
}
/** The servers an ITN may come from (PayFast's own list). */
const ITN_SOURCE_HOSTS: Record<PaymentMode, string[]> = {
  live: ["www.payfast.co.za", "w1w.payfast.co.za", "w2w.payfast.co.za"],
  test: ["sandbox.payfast.co.za"],
}
const TIMEOUT_MS = 10_000

/** TODO(payfast): PayFast's minimum isn't confirmed. R5 is a cautious placeholder. */
export const PAYFAST_MIN_AMOUNT = 5

/** Our reference (m_payment_id): payment id (36) + "-" + 6 hex = 43 characters (PayFast allows 100). Unique per attempt. */
export function isPayfastReference(reference: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{6}$/i.test(reference)
}

// ----------------------------------------------------------------------------
// Signature
// ----------------------------------------------------------------------------

/** PHP's urlencode(): space -> "+", everything but letters, digits and "-_." percent-encoded in UPPER-case hex. */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex")

/** The fields we send, in PayFast's fixed order (the order is part of the signature). */
const REQUEST_FIELD_ORDER = ["merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "m_payment_id", "amount", "item_name"] as const

/** Signature for a payment request. Empty values are left out, as PayFast requires. */
export function payfastRequestSignature(fields: Record<string, string>, passphrase: string): string {
  const pairs = REQUEST_FIELD_ORDER.filter((name) => (fields[name] ?? "").trim() !== "").map((name) => `${name}=${phpUrlencode(fields[name].trim())}`)
  if (passphrase) pairs.push(`passphrase=${phpUrlencode(passphrase.trim())}`)
  return md5(pairs.join("&"))
}

/** The parameter string PayFast signs and validates for an ITN: every posted field except `signature`, in the order received, empty ones included. */
function itnParamString(pairs: Array<[string, string]>): string {
  return pairs
    .filter(([name]) => name !== "signature")
    .map(([name, value]) => `${name}=${phpUrlencode(value)}`)
    .join("&")
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toLowerCase())
  const y = Buffer.from(b.trim().toLowerCase())
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

/** Posted pairs in the order received (URLSearchParams keeps the order), plus the same pairs exactly as encoded on the wire. */
export function parseItn(rawBody: string): { pairs: Array<[string, string]>; wire: Array<[string, string]> } | null {
  const text = rawBody.trim()
  if (!text || text.startsWith("{")) return null
  const pairs: Array<[string, string]> = []
  for (const [name, value] of new URLSearchParams(text)) pairs.push([name, value])
  const wire = text.split("&").map((segment): [string, string] => {
    const i = segment.indexOf("=")
    return i === -1 ? [segment, ""] : [decodeURIComponent(segment.slice(0, i).replace(/\+/g, " ")), segment.slice(i + 1)]
  })
  return { pairs, wire }
}

// ----------------------------------------------------------------------------
// Payment link
// ----------------------------------------------------------------------------

/** Bytes PayFast accepts for item_name: keep it short and plain (max 100). */
export function itemNameFrom(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9 .,:'&()\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 100).trim()
  return cleaned || "Payment"
}

/**
 * PayFast sends the customer back to return_url / cancel_url. Both go through app/pay/ozow-return (a route that
 * answers GET and POST and redirects to the ordinary result page), derived from the URLs the shared code gives us.
 */
function returnUrl(url: string): string {
  return url.replace("/pay/result", "/pay/ozow-return")
}

export function buildPayfastLink(args: {
  mode: PaymentMode
  merchantId: string
  merchantKey: string
  passphrase: string
  reference: string
  amount: number
  itemName: string
  returnUrl: string
  cancelUrl: string
  notifyUrl: string
}): string {
  const fields: Record<string, string> = {
    merchant_id: args.merchantId,
    merchant_key: args.merchantKey,
    return_url: args.returnUrl,
    cancel_url: args.cancelUrl,
    notify_url: args.notifyUrl,
    m_payment_id: args.reference,
    amount: (Math.round(args.amount * 100) / 100).toFixed(2),
    item_name: args.itemName,
  }
  const signature = payfastRequestSignature(fields, args.passphrase)
  const query = [...REQUEST_FIELD_ORDER.map((name) => `${name}=${phpUrlencode(fields[name].trim())}`), `signature=${signature}`].join("&")
  return `https://${HOSTS[args.mode]}/eng/process?${query}`
}

// ----------------------------------------------------------------------------
// Notification (ITN)
// ----------------------------------------------------------------------------

function verifyPayfastItn(args: { rawBody: string; connection: ProviderConnection }): WebhookVerification {
  const { rawBody, connection } = args
  const passphrase = connection.secrets.passphrase
  const merchantId = connection.config.merchantId
  if (!passphrase || !merchantId) return { ok: false, reason: "bad_signature" }

  const parsed = parseItn(rawBody)
  if (!parsed) return { ok: false, reason: "bad_body" }
  const body: Record<string, string> = {}
  for (const [name, value] of parsed.pairs) body[name] = value

  const received = body.signature
  if (!received) return { ok: false, reason: "bad_signature" }
  // Recomputed from the values as decoded (PayFast's own sample) and, in case encodings differ, as posted on the wire.
  const decoded = `${itnParamString(parsed.pairs)}&passphrase=${phpUrlencode(passphrase.trim())}`
  const wire = `${parsed.wire.filter(([name]) => name !== "signature").map(([name, value]) => `${name}=${value}`).join("&")}&passphrase=${phpUrlencode(passphrase.trim())}`
  if (!sameHash(received, md5(decoded)) && !sameHash(received, md5(wire))) return { ok: false, reason: "bad_signature" }
  // A validly signed notice for a different merchant is still not ours.
  if (body.merchant_id !== undefined && body.merchant_id !== merchantId) return { ok: false, reason: "bad_signature" }

  const status = (body.payment_status ?? "").toUpperCase()
  const reference = body.m_payment_id ?? ""
  const pfPaymentId = body.pf_payment_id ?? ""
  if (!status || !reference || !pfPaymentId) return { ok: false, reason: "bad_body" }

  const gross = /^[0-9]{1,8}(\.[0-9]{1,2})?$/.test(body.amount_gross ?? "") ? Number.parseFloat(body.amount_gross) : Number.NaN
  const event: NormalisedWebhook = {
    // One id per state change: a repeat of the same status is a duplicate, PENDING -> COMPLETE is not.
    deliveryId: `${pfPaymentId}:${status.toLowerCase()}`,
    eventType: status,
    type: status === "COMPLETE" ? "succeeded" : status === "FAILED" || status === "CANCELLED" ? "failed" : "ignored",
    checkoutRef: reference,
    providerPaymentId: pfPaymentId,
    amountMinor: Number.isFinite(gross) ? Math.round(gross * 100) : null,
    currency: "ZAR", // PayFast is ZAR only and the notice carries no currency
  }
  return { ok: true, event }
}

// ----------------------------------------------------------------------------
// The two checks that need the network (PayFast's mandatory checks 2 and 4)
// ----------------------------------------------------------------------------

export type Lookup = (host: string) => Promise<string[]>

/** Resolves a host to its IPv4/IPv6 addresses. */
const realLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((a: { address: string }) => a.address)

/** First address in x-forwarded-for (Vercel sets it), else x-real-ip. null if neither is present. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || null
}

/**
 * true only when (a) the request came from one of PayFast's own servers and (b) PayFast itself says the data is VALID.
 * Throws on a network failure (the notice is then retried by PayFast), never "true" on a doubt.
 */
export async function confirmWithPayfast(args: { rawBody: string; headers: Headers; mode: PaymentMode; lookup?: Lookup }): Promise<boolean> {
  const { rawBody, headers, mode } = args
  const lookup = args.lookup ?? realLookup
  const parsed = parseItn(rawBody)
  if (!parsed) return false

  // (2) Source: only when the platform tells us the sender address (Vercel always does).
  const ip = clientIp(headers)
  if (ip) {
    let allowed = false
    for (const host of ITN_SOURCE_HOSTS[mode]) {
      let addresses: string[]
      try {
        addresses = await lookup(host)
      } catch {
        throw new ProviderError("Couldn't look up PayFast's servers", 0)
      }
      if (addresses.includes(ip)) { allowed = true; break }
    }
    if (!allowed) return false
  }

  // (4) PayFast confirms the data it sent is the data we received.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`https://${HOSTS[mode]}/eng/query/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: itnParamString(parsed.pairs),
      signal: controller.signal,
    })
    if (!res.ok) throw new ProviderError(`PayFast returned ${res.status}`, res.status)
    return (await res.text()).trim() === "VALID"
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(error instanceof Error && error.name === "AbortError" ? "PayFast took too long to answer" : "Couldn't reach PayFast", 0)
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------------------
// The provider
// ----------------------------------------------------------------------------

export const payfastProvider: CardProvider = {
  id: "payfast",
  label: "PayFast",
  description:
    "Customers pay on PayFast's secure page (cards, instant EFT and more, depending on your PayFast account) and the money goes straight to your own PayFast account. This platform never holds your money or sees card details.",
  currencies: ["ZAR"],
  minAmount: PAYFAST_MIN_AMOUNT,
  fields: [
    {
      name: "merchantId",
      label: "PayFast Merchant ID",
      secret: false,
      placeholder: "e.g. 10000100",
      help: "From your PayFast dashboard: Settings > Integration. Use the Merchant ID for the mode you are connecting (the sandbox one for practice).",
    },
    {
      name: "merchantKey",
      label: "PayFast Merchant key",
      secret: true,
      help: "From the same place. Saved encrypted and can't be shown again.",
    },
    {
      name: "passphrase",
      label: "PayFast Passphrase",
      secret: true,
      help: "Required. Set it in your PayFast dashboard (Settings > Integration > Passphrase) and type exactly the same here, with no extra spaces. It signs every payment, so PayFast and this platform must match character for character.",
    },
    {
      name: "mode",
      label: "Mode (test or live)",
      secret: false,
      placeholder: "test",
      help: "Type test for a PayFast sandbox account (no real money moves). Type live for real payments.",
    },
  ],
  // Vault names: payments_payfast_merchant_key_<id>, payments_payfast_passphrase_<id> (the default snake_case of the field names).
  disconnectNote: "PayFast needs nothing removed on your side.",
  invalidCredentialsMessage: "PayFast didn't accept those details. Check the Merchant ID, Merchant key and passphrase.",
  prerequisite: {
    instructions:
      "Before connecting: in your PayFast dashboard open Settings > Integration and set a Passphrase. You will type the same passphrase here. After connecting, do one small test payment: PayFast can only check your details when a payment is made.",
  },

  async connect({ fields }) {
    const merchantId = (fields.merchantId ?? "").trim()
    const merchantKey = (fields.merchantKey ?? "").trim()
    const passphrase = (fields.passphrase ?? "").trim()
    const mode = (fields.mode ?? "").trim().toLowerCase()
    if (mode !== "test" && mode !== "live") throw new ConnectInputError("Type test or live in the Mode box.")
    if (!/^[0-9]{5,12}$/.test(merchantId)) throw new ConnectInputError("That doesn't look like a PayFast Merchant ID (numbers only).")
    if (!/^[A-Za-z0-9]{8,32}$/.test(merchantKey)) throw new ConnectInputError("That doesn't look like a PayFast Merchant key (letters and numbers only).")
    if (passphrase.length < 1 || passphrase.length > 100) throw new ConnectInputError("Enter the passphrase you set in your PayFast dashboard.")

    // PayFast has no free way to check these credentials: only a payment does. So this checks the format only.
    return { mode: mode as PaymentMode, keyHint: merchantId.slice(-4), secrets: { merchantKey, passphrase }, config: { merchantId }, providerWebhookId: null }
  },

  async createCheckout(req: CheckoutRequest) {
    const { merchantKey, passphrase } = req.connection.secrets
    const merchantId = req.connection.config.merchantId
    if (!merchantKey || !passphrase || !merchantId) throw new ProviderError("PayFast isn't fully connected", 401)
    if (!(req.amount >= PAYFAST_MIN_AMOUNT)) throw new ProviderError(`The minimum payment is R${PAYFAST_MIN_AMOUNT}`, 400)

    // Unique on every call (a shisha retry re-uses ONE payment row). The notice carries it back as m_payment_id.
    const reference = `${req.paymentId}-${randomBytes(3).toString("hex")}`
    const redirectUrl = buildPayfastLink({
      mode: req.connection.mode,
      merchantId,
      merchantKey,
      passphrase,
      reference,
      amount: req.amount,
      itemName: itemNameFrom(req.description),
      returnUrl: returnUrl(req.successUrl),
      cancelUrl: returnUrl(req.cancelUrl),
      notifyUrl: req.notifyUrl,
    })
    return { checkoutId: reference, redirectUrl, mode: req.connection.mode }
  },

  verifyWebhook: ({ rawBody, connection }) => verifyPayfastItn({ rawBody, connection }),

  /** PayFast's checks 2 and 4: the sender is PayFast, and PayFast confirms the data. Both must pass before anything is credited. */
  async confirmSucceeded({ connection, rawBody, headers }) {
    return confirmWithPayfast({ rawBody, headers, mode: connection.mode })
  },

  // Refunds are made by the owner in the PayFast dashboard for now: settle.ts flags the payment `refund_needed`.
  canRefund: () => false,
}
