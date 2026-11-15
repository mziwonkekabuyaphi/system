// app/api/webhooks/yoco/[integrationId]/route.ts
/**
 * KEPT ON PURPOSE. Shops that connected Yoco before the multi-provider change registered THIS exact URL in
 * their Yoco portal (/api/webhooks/yoco/<integrationId>), so it must keep working. It is now a thin wrapper
 * around the same pipeline every provider uses (lib/payments/webhook-handler.ts).
 */

import { handleProviderWebhook } from "@/lib/payments/webhook-handler"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// The ticket images are drawn and sent AFTER the provider has been answered; this is how long that may take.
// (Must be declared in the route file itself: Next reads it statically.)
export const maxDuration = 60

export async function POST(req: Request, ctx: { params: Promise<{ integrationId: string }> | { integrationId: string } }) {
  const { integrationId } = await ctx.params
  return handleProviderWebhook(req, "yoco", integrationId)
}
