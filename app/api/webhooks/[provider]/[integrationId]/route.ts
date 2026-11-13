// app/api/webhooks/[provider]/[integrationId]/route.ts
/**
 * Payment notices for every provider: /api/webhooks/<provider>/<integrationId>. Each shop connection has its
 * own URL. (/api/webhooks/yoco/... is matched by its own, older route file first and does the same thing.)
 * The provider-specific part (signature check, payload shape) lives in lib/payments/providers/<provider>.ts.
 */

import { handleProviderWebhook } from "@/lib/payments/webhook-handler"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// The ticket images are drawn and sent AFTER the provider has been answered; this is how long that may take.
// (Must be declared in the route file itself: Next reads it statically.)
export const maxDuration = 60

export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string; integrationId: string }> | { provider: string; integrationId: string } },
) {
  const { provider, integrationId } = await ctx.params
  return handleProviderWebhook(req, provider, integrationId)
}
