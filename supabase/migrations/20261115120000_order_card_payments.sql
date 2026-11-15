-- Card payment links for WhatsApp food/drink orders, through the shared tenant_payments pipeline
-- (the same one event tickets, shisha and Passport top-ups use).
-- Additive: one CHECK constraint is widened and one function is replaced with a superset of itself.
--
-- A tenant_payments row with purpose = 'order_payment' has purpose_id = orders.payment_attempt_id.
-- One attempt can cover several orders (a cart is split per vendor), all paid by that one link.
-- The orders are created 'pending' first (stock is only applied on payment, by confirm_card_payment),
-- and the signed webhook confirms them. If the link expires unpaid, the pending orders are cancelled
-- here so they never linger (fail_card_payment only touches pending/pending card orders).

-- 1) Allow the new purpose.
alter table public.tenant_payments drop constraint if exists tenant_payments_purpose_check;
alter table public.tenant_payments
  add constraint tenant_payments_purpose_check
  check (purpose = any (array['wallet_topup'::text, 'event_order'::text, 'shisha_request'::text, 'order_payment'::text]));

-- 2) Expiry: same as before, plus cancel the still-pending orders of an expired order payment.
create or replace function public.payments_expire_abandoned(
  p_creating_after interval default interval '1 hour',
  p_pending_after  interval default interval '24 hours'
)
returns table(payments_expired integer, topups_expired integer)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_payments integer := 0;
  v_topups   integer := 0;
  v_orders   integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;

  with gone as (
    update public.tenant_payments p
       set status = 'cancelled',
           metadata = p.metadata || jsonb_build_object('expired_at', now(), 'expired_from', p.status),
           updated_at = now()
     where (p.status = 'creating' and p.created_at < now() - p_creating_after)
        or (p.status = 'pending'  and p.created_at < now() - p_pending_after)
    returning p.id, p.purpose, p.purpose_id
  ), tu as (
    update public.wallet_topups t
       set status = 'expired'
      from gone
     where gone.purpose = 'wallet_topup' and t.id = gone.purpose_id and t.status = 'pending'
    returning t.id
  ), od as (
    select public.fail_card_payment(gone.purpose_id) as n
      from gone
     where gone.purpose = 'order_payment'
  )
  select (select count(*) from gone)::integer,
         (select count(*) from tu)::integer,
         (select count(*) from od)::integer
    into v_payments, v_topups, v_orders;

  return query select v_payments, v_topups;
end
$function$;

revoke all on function public.payments_expire_abandoned(interval, interval) from public, anon, authenticated;
grant execute on function public.payments_expire_abandoned(interval, interval) to service_role;
