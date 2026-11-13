# Card payment providers (Yoco, Ozow, ...)

A shop connects ONE card-payment provider (the database enforces one active connection per shop). The money goes
straight to the shop's own account with that provider. Everything that happens AFTER a payment is verified is the
same for every provider; only three things are provider-specific, and they live in one file per provider.

## Where things live

| Concern | File | Provider-specific? |
|---|---|---|
| Provider contract (what an adapter must do) | `lib/payments/providers/types.ts` | no |
| One adapter per provider | `lib/payments/providers/<provider>.ts` | yes |
| Registry (what is connectable) | `lib/payments/providers/index.ts` | no |
| Start a checkout (payment row, provider call, link) | `lib/payments/card.ts` | no |
| Read a shop's connection + secrets from Vault | `lib/payments/credentials.ts` | no |
| Webhook pipeline (lookup, signature, replay, settle) | `lib/payments/webhook-handler.ts` | no |
| Amount check, credit / tickets, refund-or-flag | `lib/payments/settle.ts` | no |
| Settings > Payments screen | `app/admin/payments/*` | no (built from the adapter's field list) |

Webhook URL per connection: `/api/webhooks/<provider>/<integrationId>`. The older
`/api/webhooks/yoco/<integrationId>` route is kept on purpose: shops that connected Yoco before this change
registered that exact URL in their Yoco portal.

## Adding a provider (e.g. Ozow)

1. Read the provider's CURRENT docs for: how a payment request is created, how its notification is signed, the
   amount format, test mode, and whether refunds exist through the API. Do not guess these.
2. Write `lib/payments/providers/<provider>.ts` implementing `CardProvider`:
   - `fields`: what the owner types (secret fields are saved encrypted in Vault, others in `config`)
   - `connect`: verify the credentials with the provider; return `secrets`, `config`, `mode`, `keyHint`
   - `createCheckout`: return `{ checkoutId, redirectUrl }`. `checkoutId` is the reference the webhook will carry back
     (use `paymentId` if the provider lets you set a merchant reference)
   - `verifyWebhook`: verify the signature over the RAW body and return a `NormalisedWebhook`
     (`amountMinor` in cents, `deliveryId` unique per notification or state change)
   - `canRefund` / `refund`: `canRefund` false means a failed-fulfilment payment is flagged `refund_needed`
     for the owner instead of refunded automatically
3. Register it in `providers/index.ts`.
4. Add a test like the ones for Yoco (signature good/bad, replay, amount mismatch).

Nothing else changes: checkout, the webhook pipeline and the settings screen work from the registry.

## Deploy order for the multi-provider change

1. Apply `supabase/proposed/payments_multi_provider.sql` (additive; the live Yoco shop keeps working before and after it).
   Try it on a Supabase branch first.
2. Deploy the app code. It needs the new functions from step 1 (`get_active_payment_integration`, `get_integration_secrets`).
3. Rollback of the app code needs no database change: the old functions and the legacy Yoco columns are untouched.
