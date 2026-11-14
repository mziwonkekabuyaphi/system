// lib/payments/providers/ozow.test.ts
/**
 * Tests for the Ozow adapter. No framework needed: Node's built-in runner.
 *   npx tsx --test lib/payments/providers/ozow.test.ts
 *
 * The hash vectors were produced by a separate implementation (Python hashlib), not by ozow.ts, so these
 * tests don't just agree with themselves. All keys here are made up.
 */

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { bankReferenceFrom, confirmWithStatusApi, ozowCreatePaymentRequest, ozowProvider, parseOzowBody } from "./ozow"
import { ConnectInputError, ProviderError, type ProviderConnection } from "./types"

const PRIVATE_KEY = "PrivKey123"
const SITE = "TSTSTE0001"
const REF = "9b2f1c3e-1111-4222-8333-444455556666"
const TXN = "7d5c0f4e-aaaa-4bbb-8ccc-ddddeeeeffff"
const WEBHOOK = "https://app.example.com/api/webhooks/ozow/f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00"

const REQUEST_HASH =
  "5f5783b3f6034cb90108e714d61c5895563e3057602ef79b5eb860a2c48d8b13dc3a9a426c5bc8db28f83c98222b951311c9cf64e92cb3b3aaf87ce663da25ac"
const NOTICE_HASH =
  "0347ab16a8591376c75d93493875fd81ee6beac9cea6517db485f064eb9decb3a319d68e9e14df20638c582b8501353a096b488c7953bcddd2a6321807590d12"
const NOTICE_HASH_WITH_MESSAGE =
  "1ccbb0d749d8cd1bd4dc5963e27506fca286e31a26c26699c5fb4d623ee80be07e5d5a28d34fa6cd67eb99be09df5d071d865764640846a68b650facc2ced3f7"

function connection(mode: "test" | "live" = "live"): ProviderConnection {
  return {
    integrationId: "f6f8ea2d-4d4d-467f-9c9b-8814e6a97f00",
    provider: "ozow",
    mode,
    config: { siteCode: SITE },
    secrets: { apiKey: "api-key-abcd", privateKey: PRIVATE_KEY },
  }
}

/** A notice the way Ozow posts it (form-encoded). */
function notice(overrides: Record<string, string> = {}, hash = NOTICE_HASH): string {
  const fields: Record<string, string> = {
    SiteCode: SITE,
    TransactionId: TXN,
    TransactionReference: REF,
    Amount: "25.00",
    Status: "Complete",
    Optional1: "",
    Optional2: "",
    Optional3: "",
    Optional4: "",
    Optional5: "",
    CurrencyCode: "ZAR",
    IsTest: "false",
    StatusMessage: "",
    ...overrides,
  }
  return new URLSearchParams({ ...fields, Hash: hash }).toString()
}

const verify = (rawBody: string, conn = connection()) => ozowProvider.verifyWebhook({ rawBody, headers: new Headers(), connection: conn })

describe("verifyWebhook", () => {
  it("accepts a correctly signed Complete notice and normalises it", () => {
    const res = verify(notice())
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.event, {
      deliveryId: `${TXN}:complete`,
      eventType: "Complete",
      type: "succeeded",
      checkoutRef: REF,
      providerPaymentId: TXN,
      amountMinor: 2500,
      currency: "ZAR",
    })
  })

  it("includes StatusMessage in the hash, decoding form encoding first", () => {
    const res = verify(notice({ StatusMessage: "Test transaction completed" }, NOTICE_HASH_WITH_MESSAGE))
    assert.equal(res.ok, true)
  })

  it("accepts the same notice as JSON", () => {
    const body = JSON.stringify({ SiteCode: SITE, TransactionId: TXN, TransactionReference: REF, Amount: 25, Status: "Complete", CurrencyCode: "ZAR", IsTest: false, StatusMessage: null, Hash: NOTICE_HASH })
    // Amount 25 (a number) would break the hash if sent as 25 instead of "25.00": a JSON sender must send the string.
    assert.equal(verify(body).ok, false)
    const ok = JSON.stringify({ SiteCode: SITE, TransactionId: TXN, TransactionReference: REF, Amount: "25.00", Status: "Complete", CurrencyCode: "ZAR", IsTest: false, StatusMessage: null, Hash: NOTICE_HASH })
    assert.equal(verify(ok).ok, true)
  })

  it("rejects a wrong hash, a missing hash and a tampered amount", () => {
    assert.deepEqual(verify(notice({}, "0".repeat(128))), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(notice().replace(/&Hash=[^&]*/, "")), { ok: false, reason: "bad_signature" })
    assert.deepEqual(verify(notice({ Amount: "1.00" })), { ok: false, reason: "bad_signature" })
  })

  it("rejects a notice signed with another private key", () => {
    const other = connection()
    other.secrets = { ...other.secrets, privateKey: "SomeOtherKey" }
    assert.deepEqual(verify(notice(), other), { ok: false, reason: "bad_signature" })
  })

  it("rejects a valid hash for a different site code", () => {
    const other = connection()
    other.config = { siteCode: "OTHER-SITE-1" }
    assert.deepEqual(verify(notice(), other), { ok: false, reason: "bad_signature" })
  })

  it("rejects an empty or unreadable body", () => {
    assert.deepEqual(verify(""), { ok: false, reason: "bad_body" })
    assert.deepEqual(verify("{not json"), { ok: false, reason: "bad_body" })
  })

  it("compares hashes ignoring leading zeros and case", () => {
    const upper = NOTICE_HASH.toUpperCase()
    assert.equal(verify(notice({}, upper)).ok, true)
    // NOTICE_HASH starts with "0": dropping it must still match.
    assert.equal(verify(notice({}, NOTICE_HASH.replace(/^0+/, ""))).ok, true)
  })

  it("ignores a test notice on a live shop and a live notice on a test shop", async () => {
    const { createHash } = await import("node:crypto")
    // Properly signed in both cases: only the IsTest flag differs from the connection's mode.
    const signed = (isTest: string) =>
      createHash("sha512").update(`${SITE}${TXN}${REF}25.00CompleteZAR${isTest}${PRIVATE_KEY}`.toLowerCase()).digest("hex")

    const testNoticeOnLiveShop = verify(notice({ IsTest: "true" }, signed("true")), connection("live"))
    assert.equal(testNoticeOnLiveShop.ok, true)
    if (testNoticeOnLiveShop.ok) assert.equal(testNoticeOnLiveShop.event.type, "ignored")

    const liveNoticeOnTestShop = verify(notice(), connection("test"))
    assert.equal(liveNoticeOnTestShop.ok, true)
    if (liveNoticeOnTestShop.ok) assert.equal(liveNoticeOnTestShop.event.type, "ignored")

    const testNoticeOnTestShop = verify(notice({ IsTest: "true" }, signed("true")), connection("test"))
    assert.equal(testNoticeOnTestShop.ok, true)
    if (testNoticeOnTestShop.ok) assert.equal(testNoticeOnTestShop.event.type, "succeeded")
  })

  it("never turns Pending or PendingInvestigation into a credit", async () => {
    const { createHash } = await import("node:crypto")
    const sign = (status: string) =>
      createHash("sha512").update(`${SITE}${TXN}${REF}25.00${status}ZARfalse${PRIVATE_KEY}`.toLowerCase()).digest("hex")
    for (const [status, type] of [["Pending", "ignored"], ["PendingInvestigation", "ignored"], ["Cancelled", "failed"], ["Error", "failed"], ["Abandoned", "failed"]] as const) {
      const res = verify(notice({ Status: status }, sign(status)))
      assert.equal(res.ok, true, status)
      if (res.ok) {
        assert.equal(res.event.type, type, status)
        assert.equal(res.event.deliveryId, `${TXN}:${status.toLowerCase()}`)
      }
    }
  })
})

describe("payment request", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  const base = {
    siteCode: SITE,
    apiKey: "api-key-abcd",
    privateKey: PRIVATE_KEY,
    amount: 25,
    transactionReference: REF,
    bankReference: "Passport top-up",
    successUrl: "https://app.example.com/pay/ozow-return?status=success",
    cancelUrl: "https://app.example.com/pay/ozow-return?status=cancelled",
    errorUrl: "https://app.example.com/pay/ozow-return?status=failed",
    notifyUrl: WEBHOOK,
    isTest: false,
  }

  it("posts the documented fields with the independently computed hash and the ApiKey header", async () => {
    let seen: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ paymentRequestId: "pr-1", url: "https://pay.ozow.com/pr-1/Secure", errorMessage: null }), { status: 200 })
    }) as typeof fetch

    const out = await ozowCreatePaymentRequest(base)
    assert.deepEqual(out, { paymentRequestId: "pr-1", url: "https://pay.ozow.com/pr-1/Secure" })
    assert.ok(seen)
    const s = seen as { url: string; init: RequestInit }
    assert.equal(s.url, "https://api.ozow.com/postpaymentrequest")
    assert.equal((s.init.headers as Record<string, string>).ApiKey, "api-key-abcd")
    const body = JSON.parse(s.init.body as string)
    assert.equal(body.amount, "25.00")
    assert.equal(body.hashCheck, REQUEST_HASH)
    assert.equal(body.isTest, false)
    assert.equal(body.currencyCode, "ZAR")
    assert.equal(body.countryCode, "ZA")
  })

  it("turns an Ozow error message or a missing link into an error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ url: null, errorMessage: "Invalid hash" }), { status: 200 })) as typeof fetch
    await assert.rejects(ozowCreatePaymentRequest(base), (e: unknown) => e instanceof ProviderError && e.status === 400)
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch
    await assert.rejects(ozowCreatePaymentRequest(base), (e: unknown) => e instanceof ProviderError && e.status === 502)
  })

  it("refuses a URL longer than Ozow allows, before calling Ozow", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    await assert.rejects(ozowCreatePaymentRequest({ ...base, notifyUrl: `https://app.example.com/${"a".repeat(150)}` }), ProviderError)
    assert.equal(called, false)
  })

  it("createCheckout builds a unique reference from our payment id, sends customers back via ozow-return, and tests only in test mode", async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response(JSON.stringify({ paymentRequestId: "pr-2", url: "https://pay.ozow.com/pr-2/Secure", errorMessage: null }), { status: 200 })
    }) as typeof fetch

    const req = {
      amount: 150,
      currency: "ZAR",
      paymentId: REF,
      description: "Summer Fest — tickets!",
      successUrl: "https://app.example.com/pay/result?status=success",
      cancelUrl: "https://app.example.com/pay/result?status=cancelled",
      failureUrl: "https://app.example.com/pay/result?status=failed",
      notifyUrl: WEBHOOK,
      idempotencyKey: "event-x",
    }
    const live = await ozowProvider.createCheckout({ ...req, connection: connection("live") })
    assert.deepEqual({ ...live, checkoutId: "x" }, { checkoutId: "x", redirectUrl: "https://pay.ozow.com/pr-2/Secure", mode: "live" })
    await ozowProvider.createCheckout({ ...req, connection: connection("test") })

    // The stored checkout id IS the reference sent to Ozow: that is what the notice will carry back.
    assert.equal(live.checkoutId, bodies[0].transactionReference)
    assert.match(String(bodies[0].transactionReference), new RegExp("^" + REF + "-[0-9a-f]{6}$"))
    assert.ok(String(bodies[0].transactionReference).length <= 50)
    // A retry on the same payment row (shisha) must never reuse the reference.
    assert.notEqual(bodies[0].transactionReference, bodies[1].transactionReference)
    assert.equal(bodies[0].successUrl, "https://app.example.com/pay/ozow-return?status=success")
    assert.equal(bodies[0].isTest, false)
    assert.equal(bodies[1].isTest, true)
    assert.equal(bodies[0].bankReference, "Summer Fest tickets")
  })

  it("won't create a checkout for a half-connected shop", async () => {
    const c = connection()
    c.secrets = { apiKey: "x" }
    await assert.rejects(ozowProvider.createCheckout({ amount: 10, currency: "ZAR", paymentId: REF, description: "x", successUrl: "", cancelUrl: "", failureUrl: "", notifyUrl: WEBHOOK, idempotencyKey: "k", connection: c }), (e: unknown) => e instanceof ProviderError && e.status === 401)
  })
})

describe("connect", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const fields = { siteCode: SITE, apiKey: "api-key-abcd", privateKey: PRIVATE_KEY, mode: "Test" }

  it("proves the credentials with one TEST request and registers no webhook", async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ paymentRequestId: "pr", url: "https://pay.ozow.com/pr/Secure", errorMessage: null }), { status: 200 })
    }) as typeof fetch
    const res = await ozowProvider.connect({ integrationId: "i", fields, webhookUrl: WEBHOOK })
    assert.equal(body.isTest, true)
    assert.equal(res.mode, "test")
    assert.equal(res.keyHint, "abcd")
    assert.deepEqual(res.config, { siteCode: SITE })
    assert.deepEqual(res.secrets, { apiKey: "api-key-abcd", privateKey: PRIVATE_KEY })
    assert.equal(res.providerWebhookId, null)
  })

  it("maps a rejected request to a credentials error and an outage to an outage", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ errorMessage: "bad hash" }), { status: 200 })) as typeof fetch
    await assert.rejects(ozowProvider.connect({ integrationId: "i", fields, webhookUrl: WEBHOOK }), (e: unknown) => e instanceof ProviderError && e.status === 401)
    globalThis.fetch = (async () => { throw new Error("network") }) as typeof fetch
    await assert.rejects(ozowProvider.connect({ integrationId: "i", fields, webhookUrl: WEBHOOK }), (e: unknown) => e instanceof ProviderError && e.status === 0)
  })

  it("rejects a bad mode or site code before calling Ozow", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as typeof fetch
    await assert.rejects(ozowProvider.connect({ integrationId: "i", fields: { ...fields, mode: "maybe" }, webhookUrl: WEBHOOK }), ConnectInputError)
    await assert.rejects(ozowProvider.connect({ integrationId: "i", fields: { ...fields, siteCode: "no way!" }, webhookUrl: WEBHOOK }), ConnectInputError)
    assert.equal(called, false)
  })
})

describe("helpers", () => {
  it("bankReferenceFrom keeps only what Ozow allows, within 20 characters", () => {
    assert.equal(bankReferenceFrom("Summer Fest — tickets!"), "Summer Fest tickets")
    assert.equal(bankReferenceFrom("A very long event name for a ticket"), "A very long event na")
    assert.equal(bankReferenceFrom("***"), "Payment")
  })

  it("parseOzowBody handles forms, JSON and junk", () => {
    assert.deepEqual(parseOzowBody("A=1&b=x+y"), { a: "1", b: "x y" })
    assert.deepEqual(parseOzowBody('{"A":1,"B":null}'), { a: "1", b: "" })
    assert.equal(parseOzowBody("   "), null)
  })
})

describe("status API confirmation (switched off by default)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const event = { deliveryId: "d", eventType: "Complete", type: "succeeded" as const, checkoutRef: REF, providerPaymentId: TXN, amountMinor: 2500, currency: "ZAR" }

  it("is off: confirmSucceeded says yes without calling Ozow", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("[]") }) as typeof fetch
    assert.equal(await ozowProvider.confirmSucceeded?.({ connection: connection("live"), event }), true)
    assert.equal(called, false)
  })

  it("when used, needs a Complete record with the same id and amount", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([{ transactionId: TXN, status: "Complete", amount: 25 }]))) as typeof fetch
    assert.equal(await confirmWithStatusApi(connection(), event), true)
    globalThis.fetch = (async () => new Response(JSON.stringify([{ transactionId: TXN, status: "Pending", amount: 25 }]))) as typeof fetch
    assert.equal(await confirmWithStatusApi(connection(), event), false)
    globalThis.fetch = (async () => new Response(JSON.stringify([{ transactionId: TXN, status: "Complete", amount: 24 }]))) as typeof fetch
    assert.equal(await confirmWithStatusApi(connection(), event), false)
    globalThis.fetch = (async () => new Response("oops", { status: 500 })) as typeof fetch
    await assert.rejects(confirmWithStatusApi(connection(), event), ProviderError)
  })
})
