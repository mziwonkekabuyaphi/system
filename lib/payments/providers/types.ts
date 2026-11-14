// lib/payments/providers/types.ts
/**
 * The contract every card provider (Yoco, Ozow, later Peach) implements.
 *
 * Everything that is the SAME for every provider lives outside this folder and never changes when a
 * provider is added: the tenant_payments records, replay protection, the exact-amount check, the
 * idempotent fulfilment functions, refunds-needed handling. A provider only answers three questions:
 *   - connect:        "are these credentials real, and what do we need to keep?"
 *   - createCheckout: "give me a hosted page where the customer pays this amount"
 *   - verifyWebhook:  "is this call really from you, and what does it say?" (normalised)
 * plus, where the provider has one, refund.
 *
 * Server-only. Secrets are never logged and never put in an error message.
 */

export type ProviderId = "yoco" | "ozow" | "peach"
export type PaymentMode = "test" | "live"

/** An error from a provider's API. `status` is the HTTP status, or 0 when the provider couldn't be reached. */
export class ProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = "ProviderError"
  }
}

/** The owner typed something unusable (wrong key format). Safe to show as-is: it is written by the adapter, not by the provider. */
export class ConnectInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConnectInputError"
  }
}

/** A shop's connection, secrets included. Held in memory for one request and never cached or logged. */
export interface ProviderConnection {
  integrationId: string
  provider: ProviderId
  mode: PaymentMode
  /** Non-secret settings (e.g. an Ozow site code). */
  config: Record<string, string>
  /** Decrypted from Vault, by field name. */
  secrets: Record<string, string>
}

/** One input on the Settings > Payments connect form. */
export interface ProviderField {
  name: string
  label: string
  /** true = saved encrypted in Vault and never shown again; false = saved in `config`. */
  secret: boolean
  placeholder?: string
  help?: string
}

export interface ConnectRequest {
  integrationId: string
  /** Values typed by the shop owner, by field name (already trimmed). */
  fields: Record<string, string>
  /** The URL this provider must call with payment notices for THIS connection. */
  webhookUrl: string
}

export interface ConnectResult {
  mode: PaymentMode
  /** Shown on the settings screen so the owner can recognise the key. Never the whole key. */
  keyHint: string
  /** Everything to store in Vault, by name (includes secrets the provider handed back, like a webhook secret). */
  secrets: Record<string, string>
  /** Everything to store in `config`. */
  config: Record<string, string>
  providerWebhookId: string | null
}

export interface CheckoutRequest {
  connection: ProviderConnection
  /** In major units (rand). Each provider converts to what its API wants, once. */
  amount: number
  currency: string
  /** OUR tenant_payments.id. Providers that need a merchant reference use this. */
  paymentId: string
  /** Shown to the customer / on their statement where the provider supports it. */
  description: string
  successUrl: string
  cancelUrl: string
  failureUrl: string
  /** Where the provider sends payment notices (the webhook for this connection). */
  notifyUrl: string
  /** Same key on a retry must not create a second checkout (where the provider supports it). */
  idempotencyKey: string
  metadata?: Record<string, string>
}

export interface CheckoutResult {
  /** The reference we store as tenant_payments.provider_checkout_id and match the webhook against. */
  checkoutId: string
  redirectUrl: string
  mode: PaymentMode | null
}

/** What a provider's webhook says, in one shape. The generic handler decides what to do with it. */
export interface NormalisedWebhook {
  /** Unique per delivery or per state change. Used for replay protection. */
  deliveryId: string
  /** The provider's own event name, kept as-is for the audit log (payment_webhook_events.event_type). */
  eventType: string | null
  type: "succeeded" | "failed" | "ignored"
  /** Matches tenant_payments.provider_checkout_id. */
  checkoutRef: string | null
  providerPaymentId: string | null
  /** Smallest currency unit (cents). null if the provider didn't say. */
  amountMinor: number | null
  currency: string | null
}

export type WebhookVerification =
  | { ok: false; reason: "bad_signature" | "bad_body" }
  | { ok: true; event: NormalisedWebhook }

export interface CardProvider {
  readonly id: ProviderId
  readonly label: string
  /** One or two sentences for the settings screen. */
  readonly description: string
  /** Currencies this provider can charge in. */
  readonly currencies: readonly string[]
  /** Smallest amount (major units) the provider accepts. */
  readonly minAmount: number
  readonly fields: readonly ProviderField[]
  /** Vault name segment per secret, e.g. { secretKey: "key" } -> payments_yoco_key_<id>. Defaults to snake_case. */
  readonly vaultNames?: Readonly<Record<string, string>>
  /** Shown when the owner disconnects (e.g. "also remove the webhook in the provider's portal"). */
  readonly disconnectNote: string
  /** Shown when the provider rejects the credentials. */
  readonly invalidCredentialsMessage: string

  connect(req: ConnectRequest): Promise<ConnectResult>
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>
  /** Synchronous: signature checks are local. Must verify against the RAW body. */
  verifyWebhook(args: { rawBody: string; headers: Headers; connection: ProviderConnection }): WebhookVerification

  /**
   * Optional second opinion, asked only for a verified "succeeded" notice before anything is credited:
   * true = go ahead, false = the provider doesn't confirm it (nothing is credited, the notice is logged).
   * May throw on a provider outage: the notice is then retried by the provider.
   */
  confirmSucceeded?(args: { connection: ProviderConnection; event: NormalisedWebhook }): Promise<boolean>

  /** Remove our webhook from the shop's account at the provider (called on disconnect, best effort). Optional. */
  removeWebhook?(args: { connection: ProviderConnection; providerWebhookId: string }): Promise<void>

  /** Can a full refund be made through the provider's API for this connection right now? */
  canRefund(connection: ProviderConnection): boolean
  refund?(args: { connection: ProviderConnection; checkoutId: string; idempotencyKey: string }): Promise<void>
}
