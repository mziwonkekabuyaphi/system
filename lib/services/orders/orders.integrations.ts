// File: lib/services/orders/orders.integrations.ts
// ============================================================================
// The two places where the orders service talks to infrastructure that is NOT
// part of this module family and must itself be tenant-aware:
//
//   1. CardPaymentGateway  — creates a hosted checkout (Yoco) using the
//      TENANT's own merchant credentials, and later calls
//      fulfillOrderAfterPayment(paymentAttemptId) from the verified webhook.
//   2. TenantMessenger     — sends WhatsApp messages from the TENANT's
//      phone_number_id with its access token (tenant_whatsapp_integrations ->
//      vault secret). Needed for webhook-triggered messages (card paid, top-up
//      resumed) where there is no inbound message to reply into.
//
// Register real implementations once at app start-up. Until you do, the
// defaults fail loudly rather than silently sending from / charging against
// the wrong account.
// ============================================================================

import { logger } from '@/lib/whatsapp/utils/logger';

export interface CardCheckoutRequest {
  tenantId: string;
  customerId: string;
  phone: string;
  amount: number;
  currency: string;
  /** Echo this back in the webhook metadata; it is the key fulfillOrderAfterPayment needs. */
  paymentAttemptId: string;
  orderIds: string[];
  description: string;
  successUrl: string;
  cancelUrl: string;
  failureUrl: string;
}

export interface CardCheckoutResult {
  checkoutUrl: string;
  paymentSessionId: string;
}

export interface CardPaymentGateway {
  /**
   * Must NOT create an `orders` row (place_order already did). Must use the
   * tenant's own payment credentials, and the webhook handler must verify the
   * signature against that same tenant's secret before calling
   * fulfillOrderAfterPayment(paymentAttemptId).
   */
  createCheckout(request: CardCheckoutRequest): Promise<CardCheckoutResult>;
}

export interface TenantMessenger {
  sendText(tenantId: string, phone: string, text: string): Promise<void>;
  sendButtons(tenantId: string, phone: string, text: string, buttons: string[]): Promise<void>;
}

let gateway: CardPaymentGateway = {
  async createCheckout() {
    throw new Error('CardPaymentGateway not configured — call setCardPaymentGateway() at start-up');
  },
};

let messenger: TenantMessenger = {
  async sendText(tenantId, phone) {
    logger.error('[orders] TenantMessenger not configured — message NOT sent', { tenantId, phone });
  },
  async sendButtons(tenantId, phone) {
    logger.error('[orders] TenantMessenger not configured — message NOT sent', { tenantId, phone });
  },
};

export function setCardPaymentGateway(impl: CardPaymentGateway): void {
  gateway = impl;
}

export function setTenantMessenger(impl: TenantMessenger): void {
  messenger = impl;
}

export function getCardPaymentGateway(): CardPaymentGateway {
  return gateway;
}

export async function notifyText(tenantId: string, phone: string, text: string): Promise<void> {
  try {
    await messenger.sendText(tenantId, phone, text);
  } catch (error) {
    logger.error('[orders] notifyText failed', { tenantId, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function notifyButtons(tenantId: string, phone: string, text: string, buttons: string[]): Promise<void> {
  try {
    await messenger.sendButtons(tenantId, phone, text, buttons);
  } catch (error) {
    logger.error('[orders] notifyButtons failed', { tenantId, error: error instanceof Error ? error.message : String(error) });
  }
}

export function getAppBaseUrl(): string {
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!baseUrl) throw new Error('APP_BASE_URL environment variable is required');
  return baseUrl.replace(/\/$/, '');
}
