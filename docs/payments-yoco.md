# Tenant-owned payments (Yoco) + Passport + Events on WhatsApp

Each shop connects **its own** Yoco account. Customers pay on Yoco's hosted page and the money goes
straight to the shop. The platform never holds funds or sees card details.

## What is in this branch
| Area | Files |
|---|---|
| Database (proposed, not auto-run) | `supabase/proposed/payments_gateway_yoco.sql`, `supabase/proposed/events_whatsapp_purchase.sql` |
| Yoco + credentials | `lib/payments/yoco.ts`, `credentials.ts`, `passport-topup.ts`, `event-checkout.ts` |
| WhatsApp services | `lib/services/passport.ts`, `lib/services/event-tickets.ts` |
| Wiring (modified files) | `lib/whatsapp/action-router.ts`, `intent-router.ts`, `reply.ts`, `utils/services-list.ts`, `lib/services/profile.ts`, `plans.ts` |
| Webhook + pages | `app/api/webhooks/yoco/[integrationId]/route.ts`, `app/pay/result/page.tsx` |
| Owner screen | `app/admin/payments/actions.ts`, `PaymentsPanel.tsx` |

## Setup, in order
1. **Review and apply the SQL** (Supabase SQL editor or a migration): `payments_gateway_yoco.sql` first, then
   `events_whatsapp_purchase.sql`. `events_whatsapp_purchase.sql` replaces the earlier
   `event_purchase_ticket_whatsapp.sql` proposal if you ever saw it.
2. **Env var:** set `NEXT_PUBLIC_APP_URL` to the app's public https URL (webhooks and the return page need it).
3. **Mount the owner screen:** render `<PaymentsPanel />` in the admin Settings area for users with `settings.manage`.
4. **Connect with a TEST key first** (`sk_test_...`) from Settings > Payments.
5. **Turn modules on** per shop in super admin: `wallet` (Passport) and/or `events`.

## First test (use a Yoco test key)
- Passport > Top Up > amount > pay on the Yoco test page > expect a "Top-up received" WhatsApp message.
- Events > Buy Tickets > pay with Passport; then again with Card.
- Confirm in the DB: `tenant_payments.status = 'succeeded'`, ledger row, `event_orders` + `event_tickets`.

## Things to confirm during that first test (not verifiable without running it)
- Yoco's `payment.succeeded` payload has `amount` (cents) and `currency`. The webhook credits **nothing** if
  the amount is missing or different, and records a warning for the owner.
- `_wallet_post` accepts a NULL actor (the bot has no staff user).
- `wallet_topups.created_by` accepts NULL.
- `delete from vault.secrets` works in `payments_disconnect` on your Vault version.

## Safety rules the webhook enforces before crediting anything
signature over the raw body (3 min tolerance) -> replay protection by webhook-id -> checkout id must be one we
created for THIS integration -> exact amount + currency -> idempotent database function. `payment.failed` is
deliberately not acted on (a customer can retry and succeed). If tickets can no longer be issued after payment,
the card payment is refunded in full via Yoco (live keys only); otherwise it is flagged `refund_needed` and
shown to the owner.

## Known gaps
- No QR image on tickets yet (ticket numbers only).
- No expiry job for abandoned top-ups / card checkouts.
- Disconnecting deletes our stored secrets but the owner must also remove the webhook in the Yoco portal.
- Yoco switches a webhook off after 5 days without a successful delivery; no health check yet.
