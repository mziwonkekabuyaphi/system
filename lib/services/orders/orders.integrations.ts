// File: lib/services/orders/orders.integrations.ts
// ============================================================================
// Where the orders service talks to infrastructure outside this module family.
//
//   Card payments are NOT here: they go through the shared payments pipeline
//   (lib/payments/order-checkout.ts to start, lib/payments/settle.ts to finish),
//   the same one event tickets and shisha use, on the shop's own card provider.
//
//   TenantMessenger sends WhatsApp messages from the TENANT's own number (send-message
//   resolves its credentials per tenant). Needed for webhook-triggered messages
//   (card paid, wallet top-up resumed) where there is no inbound message to reply into.
// ============================================================================

import { logger } from '@/lib/whatsapp/utils/logger';
import { sendWhatsAppButtonsMessage, sendWhatsAppTextMessage } from '@/lib/whatsapp/send-message';

export interface TenantMessenger {
  sendText(tenantId: string, phone: string, text: string): Promise<void>;
  sendButtons(tenantId: string, phone: string, text: string, buttons: string[]): Promise<void>;
}

let messenger: TenantMessenger = {
  async sendText(tenantId, phone, text) {
    await sendWhatsAppTextMessage(tenantId, phone, text);
  },
  async sendButtons(tenantId, phone, text, buttons) {
    await sendWhatsAppButtonsMessage(tenantId, phone, text, buttons);
  },
};

/** Replace the default sender (tests). */
export function setTenantMessenger(impl: TenantMessenger): void {
  messenger = impl;
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
