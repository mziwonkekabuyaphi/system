// lib/payments/providers/paystack.test.ts
/**
 * Tests for the Paystack adapter. Node's built-in runner, no framework needed:
 *   npx tsx --test lib/payments/providers/paystack.test.ts
 *
 * The signatures below were produced by a separate implementation (Python hmac), not by paystack.ts, so the tests
 * don't just agree with themselves. All keys here are made up.
 */

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { isPaystackReference, paystackProvider, verificationAgrees, verifyPaystackSignature } from "./paystack"
import { ConnectInputError, ProviderError, type ProviderConnection } from "./types"

const KEY = "sk_test_abcdefgh1234"
const PAYMENT_ID = "9b2f1c3e-1111-4222-8333-444455556666"
const REF = `pay-${PAYMENT_ID}-a1b2c3`
const NOTIFY = "https://app.example.com/api/webhooks/paystack/f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00"

const BODY = '{"event":"charge.success","data":{"id":4099260516,"reference":"pay-9b2f1c3e-1111-4222-8333-444455556666-a1b2c3","amount":2500,"currency":"ZAR","domain":"test","status":"success"}}'
const SIG = "82a9c700c0e06e6410904333f51b889d3d71998b0049104989f08498ef849c98b6a00ad57df69acb8950997cd7c0325c4da0165720658260c0a8d7a7c1d9b806"
const BODY_LIVE = BODY.replace('"domain":"test"', '"domain":"live"')
const SIG_LIVE = "cff7767fb25fce332c74f93c64a240803e5bc3b58b21f766b7e9e56aedb9a18ff0a7fa211de62e9c8af18fe2c7d9d5b9a8d5e37bed7203d58e5e1fd79fe54f1d"
const BODY_OTHER = '{"event":"charge.failed","data":{"id":1,"reference":"pay-9b2f1c3e-1111-4222-8333-444455556666-a1b2c3"}}'
const SIG_OTHER = "dd9fa01aa1068916c39a959ec504e5e578d5f3f7212ebbe21f733dbda987a40e80db2e12f6c44bc4eebe76c940220cf0e7f4fac347003eb4718fc40a6fa78709"
const SIG_BADJSON = "85ab58e18908899cbab34d0434294d0253cc0d959d2dc88d8eb7c11b4771f5d45a5d416a5e38d0a24bdd03e3b6e8314cd921b79c5b414d99b0ca08123e22bb72"

/** secretKey: null = a connection with no key saved (undefined would fall back to the default). */
function connection(mode: "test" | "live" = "test", secretKey: string | null = KEY): ProviderConnection {
  return {
    integrationId: "f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00",
    provider: "paystack",
    mode,
    config: {},
    secrets: secretKey ? { secretKey } : {},
  }
}

const verify = (rawBody: string, signature: string | null, conn = connection()) =>
  paystackProvider.verifyWebhook({ rawBody, headers: new Headers(signature ? { "x-paystack-signature": signature } : {}), connection: conn })

describe("webhook signature and normalising", () => {
  it("accepts a correctly signed charge.success and normalises it", () => {
    const res = verify(BODY, SIG)
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.event, {
      deliveryId: "charge.success:4099260516",
      eventType: "charge.success",
      type: "succeeded",
      checkoutRef: REF,
      providerPaymentId: "4099260516",
      amountMinor: 2500,
      currency: "ZAR",
    })
  })

  it("rejects a wrong, missing or altered signature, and a different key", () => {
    assert.deepEqual(verify(BODY, "0".repeat(128)), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(BODY, null), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(BODY.replace("2500", "100"), SIG), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(BODY, SIG, connection("test", "sk_test_someOtherKey99")), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(BODY, SIG, connection("test", null)), { ok: false, reason: "bad_signature" })
  })

  it("accepts an upper-case signature (hex is case-insensitive)", () => {
    assert.equal(verify(BODY, SIG.toUpperCase()).ok, true)
  })

  it("a signed but unreadable body is bad_body, not a credit", () => {
    assert.deepEqual(verify("not json", SIG_BADJSON), { ok: false, reason: "bad_body" })
  })

  it("only charge.success can succeed; other events are ignored", () => {
    const res = verify(BODY_OTHER, SIG_OTHER)
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.event.type, "ignored")
  })

  it("a notice for the other mode never credits (test notice on a live shop, live notice on a test shop)", () => {
    const testOnLive = verify(BODY, SIG, connection("live"))
    assert.equal(testOnLive.ok, true)
    if (testOnLive.ok) assert.equal(testOnLive.event.type, "ignored")

    const liveOnTest = verify(BODY_LIVE, SIG_LIVE, connection("test"))
    assert.equal(liveOnTest.ok, true)
    if (liveOnTest.ok) assert.equal(liveOnTest.event.type, "ignored")

    const liveOnLive = verify(BODY_LIVE, SIG_LIVE, connection("live"))
    assert.equal(liveOnLive.ok, true)
    if (liveOnLive.ok) assert.equal(liveOnLive.event.type, "succeeded")
  })

  it("verifyPaystackSignature is exposed with the same behaviour", () => {
    assert.equal(verifyPaystackSignature({ rawBody: BODY, signature: SIG, secretKey: KEY }), true)
    assert.equal(verifyPaystackSignature({ rawBody: BODY, signature: SIG.slice(2), secretKey: KEY }), false)
  })
})

describe("verification against Paystack's own answer", () => {
  const base = { status: "success", amountMinor: 2500, currency: "ZAR", reference: REF, id: "4099260516", domain: "test" }
  const expected = { reference: REF, amountMinor: 2500, currency: "ZAR", mode: "test" as const }

  it("agrees only when status, reference, amount, currency and mode all match", () => {
    assert.equal(verificationAgrees(base, expected), true)
    assert.equal(verificationAgrees({ ...base, status: "failed" }, expected), false)
    assert.equal(verificationAgrees({ ...base, reference: "pay-other" }, expected), false)
    assert.equal(verificationAgrees({ ...base, amountMinor: 2400 }, expected), false)
    assert.equal(verificationAgrees({ ...base, currency: "NGN" }, expected), false)
    assert.equal(verificationAgrees({ ...base, domain: "live" }, expected), false)
    assert.equal(verificationAgrees({ ...base, amountMinor: Number.NaN }, expected), false)
    assert.equal(verificationAgrees(base, { ...expected, amountMinor: null }), false)
  })
})

describe("confirmSucceeded (always on)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const event = { deliveryId: "d", eventType: "charge.success", type: "succeeded" as const, checkoutRef: REF, providerPaymentId: "4099260516", amountMinor: 2500, currency: "ZAR" }
  const answer = (data: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify({ status: true, message: "Verification successful", data }), { status: 200 })) as typeof fetch

  it("asks Paystack's verify endpoint with the shop's own key, and says yes when it agrees", async () => {
    let seen: { url: string; auth: string } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization }
      return new Response(JSON.stringify({ status: true, data: { status: "success", amount: 2500, currency: "ZAR", reference: REF, id: 4099260516, domain: "test" } }))
    }) as typeof fetch
    assert.equal(await paystackProvider.confirmSucceeded?.({ connection: connection(), event, rawBody: "", headers: new Headers() }), true)
    assert.ok(seen)
    const s = seen as unknown as { url: string; auth: string }
    assert.equal(s.url, `https://api.paystack.co/transaction/verify/${REF}`)
    assert.equal(s.auth, `Bearer ${KEY}`)
  })

  it("says no when Paystack disagrees on status, amount or reference", async () => {
    globalThis.fetch = answer({ status: "failed", amount: 2500, currency: "ZAR", reference: REF, domain: "test" })
    assert.equal(await paystackProvider.confirmSucceeded?.({ connection: connection(), event, rawBody: "", headers: new Headers() }), false)
    globalThis.fetch = answer({ status: "success", amount: 1, currency: "ZAR", reference: REF, domain: "test" })
    assert.equal(await paystackProvider.confirmSucceeded?.({ connection: connection(), event, rawBody: "", headers: new Headers() }), false)
    globalThis.fetch = answer({ status: "success", amount: 2500, currency: "ZAR", reference: "pay-someone-else", domain: "test" })
    assert.equal(await paystackProvider.confirmSucceeded?.({ connection: connection(), event, rawBody: "", headers: new Headers() }), false)
  })

  it("throws on an outage (so Paystack retries the notice) and says no without a reference", async () => {
    globalThis.fetch = (async () => new Response("oops", { status: 500 })) as typeof fetch
    await assert.rejects(paystackProvider.confirmSucceeded!({ connection: connection(), event, rawBody: "", headers: new Headers() }), ProviderError)
    assert.equal(await paystackProvider.confirmSucceeded?.({ connection: connection(), event: { ...event, checkoutRef: null }, rawBody: "", headers: new Headers() }), false)
  })
})

describe("createCheckout", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const req = {
    amount: 25,
    currency: "ZAR",
    paymentId: PAYMENT_ID,
    description: "Passport top-up",
    successUrl: "https://app.example.com/pay/result?status=success",
    cancelUrl: "https://app.example.com/pay/result?status=cancelled",
    failureUrl: "https://app.example.com/pay/result?status=failed",
    notifyUrl: NOTIFY,
    idempotencyKey: "topup-1",
  }

  it("initialises with whole cents, a placeholder email on our host, a unique reference and a query-free callback", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      calls.push({ url, body })
      return new Response(JSON.stringify({ status: true, data: { authorization_url: "https://checkout.paystack.com/abc123", reference: body.reference } }))
    }) as typeof fetch

    const first = await paystackProvider.createCheckout({ ...req, connection: connection() })
    await paystackProvider.createCheckout({ ...req, connection: connection() })

    assert.equal(calls[0].url, "https://api.paystack.co/transaction/initialize")
    assert.equal(calls[0].body.amount, 2500)
    assert.equal(calls[0].body.currency, "ZAR")
    assert.equal(calls[0].body.email, `customer-${PAYMENT_ID}@app.example.com`)
    assert.equal(calls[0].body.callback_url, "https://app.example.com/pay/result")
    assert.match(String(calls[0].body.reference), /^pay-9b2f1c3e-1111-4222-8333-444455556666-[0-9a-f]{6}$/)
    assert.equal(isPaystackReference(String(calls[0].body.reference)), true)
    assert.deepEqual(first, { checkoutId: calls[0].body.reference, redirectUrl: "https://checkout.paystack.com/abc123", mode: "test" })
    // A retry on the same payment row (shisha) must never reuse the reference.
    assert.notEqual(calls[0].body.reference, calls[1].body.reference)
    const meta = calls[0].body.metadata as Record<string, string>
    assert.equal(meta.paymentId, PAYMENT_ID)
    assert.equal(meta.cancel_action, "https://app.example.com/pay/result?status=cancelled")
  })

  it("refuses an amount under the minimum, and a half-connected shop, before calling Paystack", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    await assert.rejects(paystackProvider.createCheckout({ ...req, amount: 0.5, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 400)
    await assert.rejects(paystackProvider.createCheckout({ ...req, connection: connection("test", null) }), (e: unknown) => e instanceof ProviderError && e.status === 401)
    assert.equal(called, false)
  })

  it("treats a 200 with status:false as a failure, and a missing link as an error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: false, message: "Currency not supported by merchant" }), { status: 200 })) as typeof fetch
    await assert.rejects(paystackProvider.createCheckout({ ...req, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.message === "Currency not supported by merchant")
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: true, data: {} }))) as typeof fetch
    await assert.rejects(paystackProvider.createCheckout({ ...req, connection: connection() }), (e: unknown) => e instanceof ProviderError && e.status === 502)
  })
})

describe("connect", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const connect = (secretKey: string) => paystackProvider.connect({ integrationId: "i", fields: { secretKey }, webhookUrl: NOTIFY })

  it("proves the key with one read-only call, saves only the secret key, and registers no webhook", async () => {
    let url = ""
    globalThis.fetch = (async (u: string) => { url = u; return new Response(JSON.stringify({ status: true, data: [] })) }) as typeof fetch
    const res = await connect(KEY)
    assert.equal(url, "https://api.paystack.co/transaction?perPage=1")
    assert.equal(res.mode, "test")
    assert.equal(res.keyHint, "1234")
    assert.deepEqual(res.secrets, { secretKey: KEY })
    assert.deepEqual(res.config, {})
    assert.equal(res.providerWebhookId, null)
  })

  it("reads live mode from a live key", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: true, data: [] }))) as typeof fetch
    assert.equal((await connect("sk_live_abcdefgh5678")).mode, "live")
  })

  it("a rejected key is a 401 (so the owner sees the invalid-key message); a bad format never reaches Paystack", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: false, message: "Invalid key" }), { status: 401 })) as typeof fetch
    await assert.rejects(connect(KEY), (e: unknown) => e instanceof ProviderError && e.status === 401)
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    await assert.rejects(connect("pk_test_publickeynotsecret"), ConnectInputError)
    assert.equal(called, false)
  })

  it("an outage stays an outage (status 0)", async () => {
    globalThis.fetch = (async () => { throw new Error("network") }) as typeof fetch
    await assert.rejects(connect(KEY), (e: unknown) => e instanceof ProviderError && e.status === 0)
  })
})

describe("refund", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it("is available, and asks Paystack for a full refund by our reference", async () => {
    assert.equal(paystackProvider.canRefund(connection()), true)
    let sent: { url: string; body: unknown } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(init.body as string) }
      return new Response(JSON.stringify({ status: true, data: { status: "pending" } }))
    }) as typeof fetch
    await paystackProvider.refund?.({ connection: connection(), checkoutId: REF, idempotencyKey: "r" })
    assert.deepEqual(sent, { url: "https://api.paystack.co/refund", body: { transaction: REF } })
  })

  it("a refusal throws, so settle.ts flags refund_needed instead of pretending it worked", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: false, message: "Refunds not available for test transactions" }), { status: 400 })) as typeof fetch
    await assert.rejects(paystackProvider.refund!({ connection: connection(), checkoutId: REF, idempotencyKey: "r" }), ProviderError)
  })
})

describe("references", () => {
  it("recognises only our own format", () => {
    assert.equal(isPaystackReference(REF), true)
    assert.equal(isPaystackReference(`pay-${PAYMENT_ID}`), false)
    assert.equal(isPaystackReference("pay-123"), false)
    assert.equal(isPaystackReference(`${REF}; drop table`), false)
  })
})
