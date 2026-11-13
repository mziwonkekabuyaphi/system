// lib/payments/providers/yoco.ts
/**
 * Yoco as a CardProvider. A thin adapter over lib/payments/yoco.ts (which stays the one place that
 * knows Yoco's HTTP API and its Standard-Webhooks signature scheme).
 */

import {
  YOCO_MIN_AMOUNT,
  isYocoSecretKey,
  verifyYocoWebhook,
  yocoCreateCheckout,
  yocoDeleteWebhook,
  yocoModeFromKey,
  yocoRefundCheckout,
  yocoRegisterWebhook,
} from "../yoco"
import { ConnectInputError, ProviderError, type CardProvider, type NormalisedWebhook, type WebhookVerification } from "./types"

interface YocoWebhookBody {
  type?: string
  payload?: { id?: string; amount?: number; currency?: string; metadata?: { checkoutId?: string } }
}

export const yocoProvider: CardProvider = {
  id: "yoco",
  label: "Yoco",
  description:
    "Customers pay on Yoco's secure page and the money goes straight to your own Yoco account. This platform never holds your money or sees card details.",
  currencies: ["ZAR"],
  minAmount: YOCO_MIN_AMOUNT,
  fields: [
    {
      name: "secretKey",
      label: "Yoco secret key",
      secret: true,
      placeholder: "sk_test_… or sk_live_…",
      help: "Find it in your Yoco Business Portal under the developer / API keys section. Use the secret key, never the public one. Start with a test key. It is saved encrypted and can't be shown again.",
    },
  ],
  // Keeps the Vault names the live Yoco shop already uses (payments_yoco_key_<id>, payments_yoco_whsec_<id>).
  vaultNames: { secretKey: "key", webhookSecret: "whsec" },
  disconnectNote: "We'll also remove our webhook from your Yoco account.",
  invalidCredentialsMessage: "Yoco didn't accept that key. Check you copied the secret key, not the public one.",

  async connect({ fields, webhookUrl }) {
    const secretKey = fields.secretKey ?? ""
    if (!isYocoSecretKey(secretKey)) {
      throw new ConnectInputError("That doesn't look like a Yoco secret key. It starts with sk_test_ or sk_live_.")
    }
    // Registering the webhook is also the key check: Yoco rejects a bad key here, before anything is saved.
    const webhook = await yocoRegisterWebhook({ secretKey, name: "Passport payments", url: webhookUrl })
    return {
      mode: yocoModeFromKey(secretKey),
      keyHint: secretKey.slice(-4),
      secrets: { secretKey, webhookSecret: webhook.secret },
      config: {},
      providerWebhookId: webhook.id,
    }
  },

  async createCheckout(req) {
    const secretKey = req.connection.secrets.secretKey
    if (!secretKey) throw new ProviderError("Yoco isn't fully connected", 401)
    const checkout = await yocoCreateCheckout({
      secretKey,
      amount: req.amount,
      currency: req.currency,
      successUrl: req.successUrl,
      cancelUrl: req.cancelUrl,
      failureUrl: req.failureUrl,
      metadata: { paymentId: req.paymentId, ...(req.metadata ?? {}) },
      idempotencyKey: req.idempotencyKey,
    })
    return { checkoutId: checkout.id, redirectUrl: checkout.redirectUrl, mode: checkout.processingMode }
  },

  verifyWebhook({ rawBody, headers, connection }): WebhookVerification {
    const id = headers.get("webhook-id")
    const secret = connection.secrets.webhookSecret
    const ok =
      Boolean(secret) &&
      verifyYocoWebhook({
        rawBody,
        id,
        timestamp: headers.get("webhook-timestamp"),
        signature: headers.get("webhook-signature"),
        secret: secret as string,
      })
    if (!ok || !id) return { ok: false, reason: "bad_signature" }

    let body: YocoWebhookBody
    try {
      body = JSON.parse(rawBody) as YocoWebhookBody
    } catch {
      return { ok: false, reason: "bad_body" }
    }

    const checkoutRef = body.payload?.metadata?.checkoutId
    const event: NormalisedWebhook = {
      deliveryId: id,
      eventType: body.type ?? null,
      // payment.failed is deliberately not a failure we act on (see settle.ts): a customer can retry on the same checkout.
      type: body.type === "payment.succeeded" ? "succeeded" : body.type === "payment.failed" ? "failed" : "ignored",
      checkoutRef: typeof checkoutRef === "string" && checkoutRef ? checkoutRef : null,
      providerPaymentId: typeof body.payload?.id === "string" ? body.payload.id : null,
      amountMinor: typeof body.payload?.amount === "number" ? body.payload.amount : null,
      currency: typeof body.payload?.currency === "string" ? body.payload.currency : null,
    }
    return { ok: true, event }
  },

  async removeWebhook({ connection, providerWebhookId }) {
    const secretKey = connection.secrets.secretKey
    if (secretKey) await yocoDeleteWebhook(secretKey, providerWebhookId)
  },

  // Yoco refunds work for LIVE checkouts only.
  canRefund: (connection) => connection.mode === "live",
  async refund({ connection, checkoutId, idempotencyKey }) {
    const secretKey = connection.secrets.secretKey
    if (!secretKey) throw new ProviderError("Yoco isn't fully connected", 401)
    await yocoRefundCheckout({ secretKey, checkoutId, idempotencyKey })
  },
}
