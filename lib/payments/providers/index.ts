// lib/payments/providers/index.ts
/**
 * The registry. Adding a provider = write its adapter, register it here. Nothing else changes:
 * checkout, the webhook pipeline and the settings screen all work from this list.
 *
 * Only providers registered here can be connected or used, even though the database already allows
 * 'ozow' and 'peach' (so the schema never has to wait for the code).
 */

import { ozowProvider } from "./ozow"
import { yocoProvider } from "./yoco"
import type { CardProvider, ProviderId } from "./types"

const REGISTRY: Partial<Record<ProviderId, CardProvider>> = {
  yoco: yocoProvider,
  ozow: ozowProvider,
}

/** null for an unknown or not-yet-implemented provider. */
export function getProvider(id: string | null | undefined): CardProvider | null {
  if (!id) return null
  return REGISTRY[id as ProviderId] ?? null
}

export function listProviders(): CardProvider[] {
  return Object.values(REGISTRY).filter((p): p is CardProvider => Boolean(p))
}

export type {
  CardProvider,
  CheckoutRequest,
  CheckoutResult,
  ConnectRequest,
  ConnectResult,
  NormalisedWebhook,
  PaymentMode,
  ProviderConnection,
  ProviderField,
  ProviderId,
  WebhookVerification,
} from "./types"
export { ConnectInputError, ProviderError } from "./types"
