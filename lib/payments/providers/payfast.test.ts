// lib/payments/providers/payfast.test.ts
/**
 * Tests for the PayFast adapter. Node's built-in runner, no framework needed:
 *   npx tsx --test lib/payments/providers/payfast.test.ts
 *
 * The signatures below were produced by a separate implementation (Python hashlib + urllib), not by payfast.ts, so the
 * tests don't just agree with themselves. All credentials here are made up (10000100 is PayFast's public sandbox id).
 */

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import {
  buildPayfastLink,
  clientIp,
  confirmWithPayfast,
  itemNameFrom,
  parseItn,
  payfastProvider,
  payfastRequestSignature,
  phpUrlencode,
} from "./payfast"
import { ConnectInputError, ProviderError, type ProviderConnection } from "./types"

const PASS = "My Pass&phrase~1"
const MERCHANT = "10000100"
const KEY = "46f0cd694581a"
const REF = "9b2f1c3e-1111-4222-8333-444455556666-a1b2c3"
const NOTIFY = "https://app.example.com/api/webhooks/payfast/f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00"

type Itn = { pairs: Array<[string, string]>; signature: string }
const V: {
  request: { fields: Record<string, string>; signature: string; passphrase: string }
  request_no_passphrase: { signature: string }
  itn_complete: Itn
  itn_pending: Itn
  itn_cancelled: Itn
  itn_other_merchant: Itn
} = {
  "request": {
    "fields": {
      "merchant_id": "10000100",
      "merchant_key": "46f0cd694581a",
      "return_url": "https://app.example.com/pay/ozow-return?status=success",
      "cancel_url": "https://app.example.com/pay/ozow-return?status=cancelled",
      "notify_url": "https://app.example.com/api/webhooks/payfast/f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00",
      "m_payment_id": "9b2f1c3e-1111-4222-8333-444455556666-a1b2c3",
      "amount": "25.00",
      "item_name": "Passport top-up (R25) it's ~ok"
    },
    "signature": "7c5a1f24e1e96a9daff65dcccb54d528",
    "passphrase": "My Pass&phrase~1"
  },
  "request_no_passphrase": {
    "signature": "4eafc14a636505b80ee86b4b532c12e8"
  },
  "itn_complete": {
    "pairs": [
      [
        "m_payment_id",
        "9b2f1c3e-1111-4222-8333-444455556666-a1b2c3"
      ],
      [
        "pf_payment_id",
        "1089250"
      ],
      [
        "payment_status",
        "COMPLETE"
      ],
      [
        "item_name",
        "Passport top-up"
      ],
      [
        "item_description",
        ""
      ],
      [
        "amount_gross",
        "25.00"
      ],
      [
        "amount_fee",
        "-0.78"
      ],
      [
        "amount_net",
        "24.22"
      ],
      [
        "custom_str1",
        ""
      ],
      [
        "custom_str2",
        ""
      ],
      [
        "custom_str3",
        ""
      ],
      [
        "custom_str4",
        ""
      ],
      [
        "custom_str5",
        ""
      ],
      [
        "custom_int1",
        ""
      ],
      [
        "custom_int2",
        ""
      ],
      [
        "custom_int3",
        ""
      ],
      [
        "custom_int4",
        ""
      ],
      [
        "custom_int5",
        ""
      ],
      [
        "name_first",
        ""
      ],
      [
        "name_last",
        ""
      ],
      [
        "email_address",
        ""
      ],
      [
        "merchant_id",
        "10000100"
      ]
    ],
    "signature": "b4afc9f8f7c39a02cbbb442131fddad5"
  },
  "itn_pending": {
    "pairs": [
      [
        "m_payment_id",
        "9b2f1c3e-1111-4222-8333-444455556666-a1b2c3"
      ],
      [
        "pf_payment_id",
        "1089250"
      ],
      [
        "payment_status",
        "PENDING"
      ],
      [
        "item_name",
        "Passport top-up"
      ],
      [
        "item_description",
        ""
      ],
      [
        "amount_gross",
        "25.00"
      ],
      [
        "amount_fee",
        "-0.78"
      ],
      [
        "amount_net",
        "24.22"
      ],
      [
        "custom_str1",
        ""
      ],
      [
        "custom_str2",
        ""
      ],
      [
        "custom_str3",
        ""
      ],
      [
        "custom_str4",
        ""
      ],
      [
        "custom_str5",
        ""
      ],
      [
        "custom_int1",
        ""
      ],
      [
        "custom_int2",
        ""
      ],
      [
        "custom_int3",
        ""
      ],
      [
        "custom_int4",
        ""
      ],
      [
        "custom_int5",
        ""
      ],
      [
        "name_first",
        ""
      ],
      [
        "name_last",
        ""
      ],
      [
        "email_address",
        ""
      ],
      [
        "merchant_id",
        "10000100"
      ]
    ],
    "signature": "19a438adeeafcc523278563f6fdd9dc4"
  },
  "itn_cancelled": {
    "pairs": [
      [
        "m_payment_id",
        "9b2f1c3e-1111-4222-8333-444455556666-a1b2c3"
      ],
      [
        "pf_payment_id",
        "1089250"
      ],
      [
        "payment_status",
        "CANCELLED"
      ],
      [
        "item_name",
        "Passport top-up"
      ],
      [
        "item_description",
        ""
      ],
      [
        "amount_gross",
        "25.00"
      ],
      [
        "amount_fee",
        "-0.78"
      ],
      [
        "amount_net",
        "24.22"
      ],
      [
        "custom_str1",
        ""
      ],
      [
        "custom_str2",
        ""
      ],
      [
        "custom_str3",
        ""
      ],
      [
        "custom_str4",
        ""
      ],
      [
        "custom_str5",
        ""
      ],
      [
        "custom_int1",
        ""
      ],
      [
        "custom_int2",
        ""
      ],
      [
        "custom_int3",
        ""
      ],
      [
        "custom_int4",
        ""
      ],
      [
        "custom_int5",
        ""
      ],
      [
        "name_first",
        ""
      ],
      [
        "name_last",
        ""
      ],
      [
        "email_address",
        ""
      ],
      [
        "merchant_id",
        "10000100"
      ]
    ],
    "signature": "d5e6d4c2cd4af1fae764a19bf5819b32"
  },
  "itn_other_merchant": {
    "pairs": [
      [
        "m_payment_id",
        "9b2f1c3e-1111-4222-8333-444455556666-a1b2c3"
      ],
      [
        "pf_payment_id",
        "1089250"
      ],
      [
        "payment_status",
        "COMPLETE"
      ],
      [
        "item_name",
        "Passport top-up"
      ],
      [
        "item_description",
        ""
      ],
      [
        "amount_gross",
        "25.00"
      ],
      [
        "amount_fee",
        "-0.78"
      ],
      [
        "amount_net",
        "24.22"
      ],
      [
        "custom_str1",
        ""
      ],
      [
        "custom_str2",
        ""
      ],
      [
        "custom_str3",
        ""
      ],
      [
        "custom_str4",
        ""
      ],
      [
        "custom_str5",
        ""
      ],
      [
        "custom_int1",
        ""
      ],
      [
        "custom_int2",
        ""
      ],
      [
        "custom_int3",
        ""
      ],
      [
        "custom_int4",
        ""
      ],
      [
        "custom_int5",
        ""
      ],
      [
        "name_first",
        ""
      ],
      [
        "name_last",
        ""
      ],
      [
        "email_address",
        ""
      ],
      [
        "merchant_id",
        "10009999"
      ]
    ],
    "signature": "c33284bb35a7fad35e288c7b68bc30c1"
  }
}

function connection(mode: "test" | "live" = "test", over: { passphrase?: string | null; merchantId?: string | null } = {}): ProviderConnection {
  const passphrase = over.passphrase === undefined ? PASS : over.passphrase
  const merchantId = over.merchantId === undefined ? MERCHANT : over.merchantId
  return {
    integrationId: "f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00",
    provider: "payfast",
    mode,
    config: merchantId ? { merchantId } : {},
    secrets: { merchantKey: KEY, ...(passphrase ? { passphrase } : {}) },
  }
}

/** An ITN body the way PayFast posts it: form-encoded, fields in order, signature last. */
function body(v: Itn, tweak: (pairs: Array<[string, string]>) => Array<[string, string]> = (p) => p, signature = v.signature): string {
  return new URLSearchParams([...tweak(v.pairs), ["signature", signature]]).toString()
}

const verify = (raw: string, conn = connection()) => payfastProvider.verifyWebhook({ rawBody: raw, headers: new Headers(), connection: conn })

describe("php-style url encoding", () => {
  it("matches PHP urlencode()", () => {
    assert.equal(phpUrlencode("a b&c=d/é~!*'()-_."), "a+b%26c%3Dd%2F%C3%A9%7E%21%2A%27%28%29-_.")
  })
})

describe("request signature", () => {
  it("matches the independently computed value, in PayFast's fixed order, with the passphrase", () => {
    assert.equal(payfastRequestSignature(V.request.fields, PASS), V.request.signature)
  })

  it("the order of keys in the object doesn't matter (PayFast's fixed order is used)", () => {
    const shuffled = Object.fromEntries(Object.entries(V.request.fields).reverse())
    assert.equal(payfastRequestSignature(shuffled, PASS), V.request.signature)
  })

  it("leaves empty values out, and an absent passphrase out", () => {
    assert.equal(payfastRequestSignature({ ...V.request.fields, return_url: "  " }, PASS) === V.request.signature, false)
    assert.equal(payfastRequestSignature(V.request.fields, ""), V.request_no_passphrase.signature)
  })
})

describe("payment link", () => {
  const args = {
    merchantId: MERCHANT,
    merchantKey: KEY,
    passphrase: PASS,
    reference: REF,
    amount: 25,
    itemName: V.request.fields.item_name,
    returnUrl: V.request.fields.return_url,
    cancelUrl: V.request.fields.cancel_url,
    notifyUrl: V.request.fields.notify_url,
  }

  it("is a signed link to the right host for the mode, fields in PayFast's order", () => {
    const test = new URL(buildPayfastLink({ ...args, mode: "test" }))
    assert.equal(test.origin, "https://sandbox.payfast.co.za")
    assert.equal(test.pathname, "/eng/process")
    assert.equal(new URL(buildPayfastLink({ ...args, mode: "live" })).origin, "https://www.payfast.co.za")

    assert.deepEqual([...test.searchParams.keys()], ["merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "m_payment_id", "amount", "item_name", "signature"])
    assert.equal(test.searchParams.get("amount"), "25.00")
    assert.equal(test.searchParams.get("item_name"), args.itemName)
    assert.equal(test.searchParams.get("signature"), V.request.signature)
  })

  it("never puts the passphrase in the link", () => {
    const link = buildPayfastLink({ ...args, mode: "test" })
    assert.equal(link.includes(encodeURIComponent(PASS)), false)
    assert.equal(link.includes("passphrase"), false)
  })
})

describe("createCheckout", () => {
  const req = {
    amount: 25,
    currency: "ZAR",
    paymentId: "9b2f1c3e-1111-4222-8333-444455556666",
    description: "Passport top-up",
    successUrl: "https://app.example.com/pay/result?status=success",
    cancelUrl: "https://app.example.com/pay/result?status=cancelled",
    failureUrl: "https://app.example.com/pay/result?status=failed",
    notifyUrl: NOTIFY,
    idempotencyKey: "topup-1",
  }

  it("makes a link without calling PayFast, with a unique reference and POST-safe return URLs", async () => {
    const realFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    try {
      const first = await payfastProvider.createCheckout({ ...req, connection: connection("test") })
      const second = await payfastProvider.createCheckout({ ...req, connection: connection("test") })
      assert.equal(called, false)

      const url = new URL(first.redirectUrl)
      assert.equal(first.checkoutId, url.searchParams.get("m_payment_id"))
      assert.match(first.checkoutId, /^9b2f1c3e-1111-4222-8333-444455556666-[0-9a-f]{6}$/)
      assert.equal(url.searchParams.get("return_url"), "https://app.example.com/pay/ozow-return?status=success")
      assert.equal(url.searchParams.get("cancel_url"), "https://app.example.com/pay/ozow-return?status=cancelled")
      assert.equal(url.searchParams.get("notify_url"), NOTIFY)
      assert.equal(first.mode, "test")
      // A retry on the same payment row (shisha) must never reuse the reference.
      assert.notEqual(first.checkoutId, second.checkoutId)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("refuses an amount under the minimum and a half-connected shop", async () => {
    await assert.rejects(payfastProvider.createCheckout({ ...req, amount: 1, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 400)
    await assert.rejects(payfastProvider.createCheckout({ ...req, connection: connection("test", { passphrase: null }) }), (e: unknown) => e instanceof ProviderError && e.status === 401)
    await assert.rejects(payfastProvider.createCheckout({ ...req, connection: connection("test", { merchantId: null }) }), (e: unknown) => e instanceof ProviderError && e.status === 401)
  })
})

describe("ITN verification and normalising", () => {
  it("accepts a correctly signed COMPLETE notice and normalises it", () => {
    const res = verify(body(V.itn_complete))
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.event, {
      deliveryId: "1089250:complete",
      eventType: "COMPLETE",
      type: "succeeded",
      checkoutRef: REF,
      providerPaymentId: "1089250",
      amountMinor: 2500,
      currency: "ZAR",
    })
  })

  it("accepts the same notice with spaces posted as %20 instead of +", () => {
    assert.equal(verify(body(V.itn_complete).replace(/\+/g, "%20")).ok, true)
  })

  it("rejects a wrong or missing signature, a tampered amount, no passphrase, and the wrong passphrase", () => {
    assert.deepEqual(verify(body(V.itn_complete, (p) => p, "0".repeat(32))), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(body(V.itn_complete).replace(/&signature=[0-9a-f]+$/, "")), { ok: false, reason: "bad_signature" })
    // Signed for 25.00, body now says 0.10:
    const tampered = body(V.itn_complete, (p) => p.map(([k, v]): [string, string] => (k === "amount_gross" ? [k, "0.10"] : [k, v])))
    assert.deepEqual(verify(tampered), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(body(V.itn_complete), connection("test", { passphrase: null })), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(body(V.itn_complete), connection("test", { passphrase: "another passphrase" })), { ok: false, reason: "bad_signature" })
  })

  it("rejects a validly signed notice for a different merchant", () => {
    assert.deepEqual(verify(body(V.itn_other_merchant)), { ok: false, reason: "bad_signature" })
  })

  it("only COMPLETE can succeed; PENDING is ignored; CANCELLED is 'failed' (logged only)", () => {
    const pending = verify(body(V.itn_pending))
    assert.equal(pending.ok, true)
    if (pending.ok) {
      assert.equal(pending.event.type, "ignored")
      assert.equal(pending.event.deliveryId, "1089250:pending")
    }
    const cancelled = verify(body(V.itn_cancelled))
    assert.equal(cancelled.ok, true)
    if (cancelled.ok) assert.equal(cancelled.event.type, "failed")
  })

  it("empty and JSON bodies are bad_body (never a credit)", () => {
    assert.deepEqual(verify(""), { ok: false, reason: "bad_body" })
    assert.deepEqual(verify('{"payment_status":"COMPLETE"}'), { ok: false, reason: "bad_body" })
  })

  it("parseItn keeps the order received and the empty fields", () => {
    const parsed = parseItn("b=2&a=&c=x+y")
    assert.deepEqual(parsed?.pairs, [["b", "2"], ["a", ""], ["c", "x y"]])
  })
})

describe("PayFast's own checks: sender and confirmation", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const raw = body(V.itn_complete)
  const headers = (ip?: string) => new Headers(ip ? { "x-forwarded-for": `${ip}, 10.0.0.1` } : {})
  const lookup = async (host: string) => (host === "sandbox.payfast.co.za" ? ["197.97.145.144"] : ["197.97.145.150", "41.74.179.194"])

  it("confirms when the sender is PayFast and PayFast says VALID, posting the notice without its signature", async () => {
    let sent: { url: string; body: string } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: init.body as string }
      return new Response("VALID")
    }) as typeof fetch
    assert.equal(await confirmWithPayfast({ rawBody: raw, headers: headers("197.97.145.144"), mode: "test", lookup }), true)
    assert.ok(sent)
    const s = sent as unknown as { url: string; body: string }
    assert.equal(s.url, "https://sandbox.payfast.co.za/eng/query/validate")
    assert.equal(s.body.includes("signature"), false)
    assert.equal(s.body.startsWith("m_payment_id="), true)
  })

  it("says no when PayFast says INVALID, and no when the sender isn't a PayFast server (without calling PayFast)", async () => {
    globalThis.fetch = (async () => new Response("INVALID")) as typeof fetch
    assert.equal(await confirmWithPayfast({ rawBody: raw, headers: headers("197.97.145.144"), mode: "test", lookup }), false)

    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("VALID") }) as typeof fetch
    assert.equal(await confirmWithPayfast({ rawBody: raw, headers: headers("203.0.113.9"), mode: "test", lookup }), false)
    assert.equal(called, false)
  })

  it("uses the live hosts for live mode (a sandbox address is not a live PayFast server)", async () => {
    globalThis.fetch = (async () => new Response("VALID")) as typeof fetch
    assert.equal(await confirmWithPayfast({ rawBody: raw, headers: headers("197.97.145.150"), mode: "live", lookup }), true)
    assert.equal(await confirmWithPayfast({ rawBody: raw, headers: headers("197.97.145.144"), mode: "live", lookup }), false)
  })

  it("throws on an outage (so PayFast retries), and a lookup failure counts as an outage", async () => {
    globalThis.fetch = (async () => new Response("oops", { status: 500 })) as typeof fetch
    await assert.rejects(confirmWithPayfast({ rawBody: raw, headers: headers("197.97.145.144"), mode: "test", lookup }), ProviderError)
    await assert.rejects(
      confirmWithPayfast({ rawBody: raw, headers: headers("197.97.145.144"), mode: "test", lookup: async () => { throw new Error("dns") } }),
      (e: unknown) => e instanceof ProviderError && e.status === 0,
    )
  })

  it("reads the sender from x-forwarded-for, then x-real-ip", () => {
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4")
    assert.equal(clientIp(new Headers({ "x-real-ip": "9.9.9.9" })), "9.9.9.9")
    assert.equal(clientIp(new Headers()), null)
  })

  it("the provider's hook runs the same checks", async () => {
    globalThis.fetch = (async () => new Response("INVALID")) as typeof fetch
    const event = { deliveryId: "d", eventType: "COMPLETE", type: "succeeded" as const, checkoutRef: REF, providerPaymentId: "1", amountMinor: 2500, currency: "ZAR" }
    // No sender header: the sender check is skipped, PayFast's answer still decides.
    assert.equal(await payfastProvider.confirmSucceeded?.({ connection: connection(), event, rawBody: raw, headers: new Headers() }), false)
  })
})

describe("connect", () => {
  const fields = { merchantId: MERCHANT, merchantKey: KEY, passphrase: PASS, mode: "Test" }
  const connect = (f: Record<string, string> = fields) => payfastProvider.connect({ integrationId: "i", fields: f, webhookUrl: NOTIFY })

  it("saves the merchant key and passphrase as secrets, the merchant id as config, and registers no webhook", async () => {
    const res = await connect()
    assert.equal(res.mode, "test")
    assert.equal(res.keyHint, MERCHANT.slice(-4))
    assert.deepEqual(res.secrets, { merchantKey: KEY, passphrase: PASS })
    assert.deepEqual(res.config, { merchantId: MERCHANT })
    assert.equal(res.providerWebhookId, null)
    assert.equal((await connect({ ...fields, mode: "LIVE" })).mode, "live")
  })

  it("rejects an unusable mode, Merchant ID, key or passphrase", async () => {
    await assert.rejects(connect({ ...fields, mode: "maybe" }), ConnectInputError)
    await assert.rejects(connect({ ...fields, merchantId: "abc" }), ConnectInputError)
    await assert.rejects(connect({ ...fields, merchantKey: "short" }), ConnectInputError)
    await assert.rejects(connect({ ...fields, passphrase: "   " }), ConnectInputError)
  })
})

describe("provider facts and helpers", () => {
  it("is ZAR only, needs a passphrase field, has no automatic refunds and no webhook to register", () => {
    assert.deepEqual([...payfastProvider.currencies], ["ZAR"])
    assert.ok(payfastProvider.fields.some((f) => f.name === "passphrase" && f.secret))
    assert.equal(payfastProvider.canRefund(connection()), false)
    assert.equal(payfastProvider.webhookSetup, undefined)
    assert.equal(payfastProvider.prerequisite?.showDomain, undefined)
  })

  it("itemNameFrom keeps it plain and within 100 characters", () => {
    assert.equal(itemNameFrom("Summer Fest — tickets!"), "Summer Fest tickets")
    assert.equal(itemNameFrom("x".repeat(150)).length, 100)
    assert.equal(itemNameFrom("***"), "Payment")
  })
})
