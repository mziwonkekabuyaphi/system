// lib/payments/providers/peach.test.ts
/**
 * Tests for the Peach Payments adapter. Node's built-in runner, no framework needed:
 *   npx tsx --test lib/payments/providers/peach.test.ts
 *
 * The signed sample notices below were produced by a separate implementation (Python hmac), not by peach.ts, so the
 * tests don't just agree with themselves. Peach's own worked signing example in its docs does NOT reproduce from its
 * written rule, so it can't be used as a vector; the real proof is the first sandbox payment. All keys are made up.
 */

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { isPeachReference, isPeachSuccessCode, parsePeachBody, peachProvider, peachReturnHint, peachSignature } from "./peach"
import { ConnectInputError, ProviderError, type ProviderConnection } from "./types"

const KEY = "peachSecretToken1234567890abcdef"
const ENTITY = "8ac7a4ca68c22c4d0168c2caab2e0025"
const REF = "a1b2c3d4e5f60789"
const NOTIFY = "https://app.example.com/api/webhooks/peach/f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00"

type Vector = { params: Record<string, string>; signature: string }
const V: Record<string, Vector> = {
  "success": {
    "params": {
      "amount": "25.00",
      "checkoutId": "948cc8dec52a11eb85290242ac130003",
      "currency": "ZAR",
      "id": "8ac7a4a184123d86018413e098f32191",
      "merchant.name": "Peach Payments",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "paymentBrand": "VISA",
      "paymentType": "DB",
      "result.code": "000.100.110",
      "result.description": "Request successfully processed in 'Merchant in Integrator Test Mode'",
      "card.bin": "",
      "timestamp": "2026-11-14T10:00:00Z"
    },
    "signature": "90c44db366a0651e58fd9c017552b1d21b17886f556336f25359ddd526aca867"
  },
  "refund": {
    "params": {
      "amount": "25.00",
      "checkoutId": "948cc8dec52a11eb85290242ac130003",
      "currency": "ZAR",
      "id": "8ac7a4a184123d86018413e098f32191",
      "merchant.name": "Peach Payments",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "paymentBrand": "VISA",
      "paymentType": "RF",
      "result.code": "000.100.110",
      "result.description": "Request successfully processed in 'Merchant in Integrator Test Mode'",
      "card.bin": "",
      "timestamp": "2026-11-14T10:00:00Z"
    },
    "signature": "0bb53f9cec9baffb47447d511fd9c48a5ce3c69cc5fab5b1b772f7f7335da058"
  },
  "pending": {
    "params": {
      "amount": "25.00",
      "checkoutId": "948cc8dec52a11eb85290242ac130003",
      "currency": "ZAR",
      "id": "8ac7a4a184123d86018413e098f32191",
      "merchant.name": "Peach Payments",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "paymentBrand": "VISA",
      "paymentType": "DB",
      "result.code": "000.200.000",
      "result.description": "transaction pending",
      "card.bin": "",
      "timestamp": "2026-11-14T10:00:00Z"
    },
    "signature": "9002aa395429bccd6594d8ce2c10bfdb40dc7633df6c22ca91548267d487bdaa"
  },
  "cancelled": {
    "params": {
      "amount": "25.00",
      "checkoutId": "948cc8dec52a11eb85290242ac130003",
      "currency": "ZAR",
      "merchant.name": "Peach Payments",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "paymentType": "DB",
      "timestamp": "2026-11-14T10:00:00Z",
      "result_code": "100.396.101",
      "result_description": "Cancelled by user"
    },
    "signature": "ae3bc19c446950bac7cc9f9699147a3184d61325556d244c1a5ebbfde1898b39"
  },
  "uncertain": {
    "params": {
      "amount": "25.00",
      "checkoutId": "948cc8dec52a11eb85290242ac130003",
      "currency": "ZAR",
      "merchant.name": "Peach Payments",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "paymentType": "DB",
      "timestamp": "2026-11-14T10:00:00Z",
      "result_code": "100.396.104",
      "result_description": "Uncertain status - probably cancelled by user"
    },
    "signature": "06d60e9a0197f76b87e4d5fdad0452e1b224998ba9c9838cd65452c418f6ba8b"
  },
  "success_no_timestamp_signature": {
    "params": {
      "amount": "25.00",
      "checkoutId": "948cc8dec52a11eb85290242ac130003",
      "currency": "ZAR",
      "id": "8ac7a4a184123d86018413e098f32191",
      "merchant.name": "Peach Payments",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "paymentBrand": "VISA",
      "paymentType": "DB",
      "result.code": "000.100.110",
      "result.description": "Request successfully processed in 'Merchant in Integrator Test Mode'",
      "card.bin": "",
      "timestamp": "2026-11-14T10:00:00Z"
    },
    "signature": "54e55e97c699f5977849f10d617c689b446cc1081fde203324d603bb36044c09"
  },
  "request": {
    "params": {
      "authentication.entityId": "8ac7a4ca68c22c4d0168c2caab2e0025",
      "amount": "25.00",
      "currency": "ZAR",
      "merchantTransactionId": "a1b2c3d4e5f60789",
      "nonce": "0123456789abcdef0123456789abcdef",
      "paymentType": "DB",
      "shopperResultUrl": "https://app.example.com/pay/peach-return",
      "notificationUrl": "https://app.example.com/api/webhooks/peach/f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00",
      "cancelUrl": "https://app.example.com/pay/result?status=cancelled"
    },
    "signature": "b485b046b40893264d64b377786d50cc2367399be03cc2722178ebd299427c34"
  }
}

function connection(mode: "test" | "live" = "test", secretToken: string | null = KEY, entityId: string | null = ENTITY): ProviderConnection {
  return {
    integrationId: "f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00",
    provider: "peach",
    mode,
    config: entityId ? { entityId } : {},
    secrets: secretToken ? { secretToken } : {},
  }
}

/** A notice the way Peach posts it: form-encoded, signature included. */
const notice = (v: Vector, overrides: Record<string, string> = {}, signature = v.signature) =>
  new URLSearchParams({ ...v.params, ...overrides, signature }).toString()

const verify = (rawBody: string, conn = connection()) => peachProvider.verifyWebhook({ rawBody, headers: new Headers(), connection: conn })

describe("signature", () => {
  it("matches the independently computed value for a request", () => {
    assert.equal(peachSignature(V.request.params, KEY), V.request.signature)
  })

  it("sorts by name, so the order the parameters are given in doesn't matter", () => {
    const reversed = Object.fromEntries(Object.entries(V.request.params).reverse())
    assert.equal(peachSignature(reversed, KEY), V.request.signature)
  })
})

describe("webhook verification and normalising", () => {
  it("accepts a correctly signed successful debit and normalises it", () => {
    const res = verify(notice(V.success))
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.event, {
      deliveryId: "DB:8ac7a4a184123d86018413e098f32191:000.100.110",
      eventType: "DB 000.100.110",
      type: "succeeded",
      checkoutRef: REF,
      providerPaymentId: "8ac7a4a184123d86018413e098f32191",
      amountMinor: 2500,
      currency: "ZAR",
    })
  })

  it("also accepts a signature computed without the timestamp field", () => {
    assert.equal(verify(notice(V.success_no_timestamp_signature)).ok, true)
  })

  it("rejects a wrong or missing signature, a tampered amount, and a different secret token", () => {
    assert.deepEqual(verify(notice(V.success, {}, "0".repeat(64))), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(notice(V.success).replace(/&signature=[0-9a-f]+/, "")), { ok: false, reason: "bad_signature" })
    // Signed for 25.00, body now says 99.00:
    assert.deepEqual(verify(notice(V.success, { amount: "99.00" })), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(notice(V.success), connection("test", "someOtherSecretToken1234567890")), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(notice(V.success), connection("test", null)), { ok: false, reason: "bad_signature" })
  })

  it("a refund notice (paymentType RF) is valid but never credits", () => {
    const res = verify(notice(V.refund))
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.event.type, "ignored")
  })

  it("created / pending is ignored; cancelled and uncertain are 'failed' (logged only)", () => {
    const pending = verify(notice(V.pending))
    assert.equal(pending.ok, true)
    if (pending.ok) assert.equal(pending.event.type, "ignored")

    for (const name of ["cancelled", "uncertain"] as const) {
      const res = verify(notice(V[name]))
      assert.equal(res.ok, true, name)
      if (res.ok) {
        assert.equal(res.event.type, "failed", name)
        assert.equal(res.event.checkoutRef, REF)
      }
    }
  })

  it("success and pending for the same transaction have different delivery ids (pending then successful still credits)", () => {
    const a = verify(notice(V.success))
    const b = verify(notice(V.pending))
    assert.ok(a.ok && b.ok)
    if (a.ok && b.ok) assert.notEqual(a.event.deliveryId, b.event.deliveryId)
  })

  it("empty and JSON bodies are bad_body (never a credit)", () => {
    assert.deepEqual(verify(""), { ok: false, reason: "bad_body" })
    assert.deepEqual(verify('{"configuration":"webhook"}'), { ok: false, reason: "bad_body" })
  })
})

describe("result codes and helpers", () => {
  it("only Peach's success family counts as paid", () => {
    for (const code of ["000.000.000", "000.100.110", "000.100.112", "000.300.000", "000.600.000"]) assert.equal(isPeachSuccessCode(code), true, code)
    for (const code of ["000.200.000", "000.200.100", "100.396.101", "100.396.104", "800.100.151", "", "000.400.110"]) assert.equal(isPeachSuccessCode(code), false, code)
  })

  it("recognises only our own 16-hex reference", () => {
    assert.equal(isPeachReference(REF), true)
    assert.equal(isPeachReference("A1B2C3D4E5F60789"), false)
    assert.equal(isPeachReference("a1b2c3d4"), false)
    assert.equal(isPeachReference(`${REF}x`), false)
  })

  it("the return hint is only ever 'cancelled'", () => {
    assert.equal(peachReturnHint("100.396.101"), "cancelled")
    assert.equal(peachReturnHint("100.396.104"), "cancelled")
    assert.equal(peachReturnHint("000.100.110"), null)
    assert.equal(peachReturnHint(""), null)
  })

  it("parsePeachBody keeps names exactly as received and decodes values", () => {
    assert.deepEqual(parsePeachBody("a.b=1&c=x+y%27z&empty="), { "a.b": "1", c: "x y'z", empty: "" })
  })
})

describe("createCheckout", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
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
  const answer = (redirectUrl = "https://testsecure.peachpayments.com/checkout/abc") =>
    (async () => new Response(JSON.stringify({ redirectUrl }), { status: 201 })) as typeof fetch

  it("posts a signed form to the right host for the mode, with our domain as Referer", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; form: Record<string, string> }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, form: Object.fromEntries(new URLSearchParams(init.body as string)) })
      return new Response(JSON.stringify({ redirectUrl: "https://secure.peachpayments.com/checkout/abc" }), { status: 201 })
    }) as typeof fetch

    const test = await peachProvider.createCheckout({ ...req, connection: connection("test") })
    await peachProvider.createCheckout({ ...req, connection: connection("live") })

    assert.equal(calls[0].url, "https://testsecure.peachpayments.com/checkout/initiate")
    assert.equal(calls[1].url, "https://secure.peachpayments.com/checkout/initiate")
    assert.equal(calls[0].headers.Referer, "https://app.example.com")
    assert.equal(calls[0].headers["Content-Type"], "application/x-www-form-urlencoded")

    const form = calls[0].form
    assert.equal(form["authentication.entityId"], ENTITY)
    assert.equal(form.amount, "25.00")
    assert.equal(form.currency, "ZAR")
    assert.equal(form.paymentType, "DB")
    assert.equal(form.notificationUrl, NOTIFY)
    assert.equal(form.shopperResultUrl, "https://app.example.com/pay/peach-return")
    assert.equal(form.cancelUrl, req.cancelUrl)
    assert.match(form.nonce, /^[0-9a-f]{32}$/)
    // The signature covers every other field exactly as posted.
    const { signature, ...signed } = form
    assert.equal(signature, peachSignature(signed, KEY))

    // The stored checkout id is the reference sent to Peach (that is what the notice carries back), within Peach's 8-16 limit.
    assert.equal(test.checkoutId, form.merchantTransactionId)
    assert.match(test.checkoutId, /^[0-9a-f]{16}$/)
    assert.deepEqual({ ...test, checkoutId: "x" }, { checkoutId: "x", redirectUrl: "https://secure.peachpayments.com/checkout/abc", mode: "test" })
    // A retry on the same payment row (shisha) must never reuse the reference or the nonce.
    assert.notEqual(calls[0].form.merchantTransactionId, calls[1].form.merchantTransactionId)
    assert.notEqual(calls[0].form.nonce, calls[1].form.nonce)
  })

  it("refuses an amount under the minimum and a half-connected shop, before calling Peach", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    await assert.rejects(peachProvider.createCheckout({ ...req, amount: 1, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 400)
    await assert.rejects(peachProvider.createCheckout({ ...req, connection: connection("test", null) }), (e: unknown) => e instanceof ProviderError && e.status === 401)
    await assert.rejects(peachProvider.createCheckout({ ...req, connection: connection("test", KEY, null) }), (e: unknown) => e instanceof ProviderError && e.status === 401)
    assert.equal(called, false)
  })

  it("turns an error status, a missing link or a non-https link into an error", async () => {
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as typeof fetch
    await assert.rejects(peachProvider.createCheckout({ ...req, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 403)
    globalThis.fetch = (async () => new Response("{}", { status: 201 })) as typeof fetch
    await assert.rejects(peachProvider.createCheckout({ ...req, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 502)
    globalThis.fetch = answer("http://insecure.example.com/x")
    await assert.rejects(peachProvider.createCheckout({ ...req, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 502)
  })
})

describe("connect", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const fields = { entityId: ENTITY, secretToken: KEY, mode: "Test" }
  const connect = (f: Record<string, string> = fields) => peachProvider.connect({ integrationId: "i", fields: f, webhookUrl: NOTIFY })

  it("proves the credentials with one signed request to the right host, saves the token as a secret, registers no webhook", async () => {
    let url = ""
    globalThis.fetch = (async (u: string) => { url = u; return new Response(JSON.stringify({ redirectUrl: "https://testsecure.peachpayments.com/checkout/abc" }), { status: 201 }) }) as typeof fetch
    const res = await connect()
    assert.equal(url, "https://testsecure.peachpayments.com/checkout/initiate")
    assert.equal(res.mode, "test")
    assert.equal(res.keyHint, ENTITY.slice(-4))
    assert.deepEqual(res.secrets, { secretToken: KEY })
    assert.deepEqual(res.config, { entityId: ENTITY })
    assert.equal(res.providerWebhookId, null)

    await connect({ ...fields, mode: "LIVE" }).then((r) => assert.equal(r.mode, "live"))
    assert.equal(url, "https://secure.peachpayments.com/checkout/initiate")
  })

  it("a rejected request (bad signature, unknown entity, domain not allowlisted) becomes a credentials error; an outage stays an outage", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 403 })) as typeof fetch
    await assert.rejects(connect(), (e: unknown) => e instanceof ProviderError && e.status === 401)
    globalThis.fetch = (async () => new Response("bad", { status: 400 })) as typeof fetch
    await assert.rejects(connect(), (e: unknown) => e instanceof ProviderError && e.status === 401)
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch
    await assert.rejects(connect(), (e: unknown) => e instanceof ProviderError && e.status === 503)
    globalThis.fetch = (async () => { throw new Error("network") }) as typeof fetch
    await assert.rejects(connect(), (e: unknown) => e instanceof ProviderError && e.status === 0)
  })

  it("rejects an unusable mode, Entity ID or token before calling Peach", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    await assert.rejects(connect({ ...fields, mode: "maybe" }), ConnectInputError)
    await assert.rejects(connect({ ...fields, entityId: "short" }), ConnectInputError)
    await assert.rejects(connect({ ...fields, secretToken: "tiny" }), ConnectInputError)
    await assert.rejects(connect({ ...fields, secretToken: "has spaces in it 1234567890" }), ConnectInputError)
    assert.equal(called, false)
  })
})

describe("provider facts", () => {
  it("has no automatic refunds and no webhook to register, and tells the owner to allowlist the domain first", () => {
    assert.equal(peachProvider.canRefund(connection()), false)
    assert.equal(peachProvider.refund, undefined)
    assert.ok(peachProvider.prerequisite?.instructions.includes("Allowlisted domains"))
    assert.equal(peachProvider.webhookSetup, undefined)
    assert.deepEqual([...peachProvider.currencies], ["ZAR"])
  })
})
