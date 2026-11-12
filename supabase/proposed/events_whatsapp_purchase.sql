-- ============================================================================
-- PROPOSED — NOT APPLIED. Review, then run AFTER payments_gateway_yoco.sql.
-- Event tickets on WhatsApp: pay from the Passport OR by card on the shop's own Yoco account.
-- THIS FILE REPLACES supabase/proposed/event_purchase_ticket_whatsapp.sql (delete that one).
-- ============================================================================
-- Correction to my earlier proposal
--   _event_issue_order, when paying by wallet, calls wallet_get_or_create, and that function starts with
--   `if auth.uid() is null then raise 'Not authenticated'`. The bot has no signed-in user, so the earlier
--   wrapper would have failed for every PAID Passport purchase (free tickets would have worked).
--   Section 2 below fixes it with the smallest possible change to wallet_get_or_create: let the service
--   role through. Everything else in that function is unchanged.
--
-- What this file adds
--   1. tenant_payments learns about ticket orders (new purpose, new statuses, a metadata column).
--   2. wallet_get_or_create: also allows the service role (server) — see above.
--   3. event_quote_whatsapp          validates a purchase and returns the real price/availability.
--   4. event_purchase_ticket_whatsapp pays from the Passport (service_role only).
--   5. event_fulfil_card_order_whatsapp issues tickets AFTER a verified card payment (service_role only).
--
-- Card orders are fulfilled only by the signed webhook. If the tickets cannot be issued at that moment
-- (the tier sold out while the customer was paying, or the price changed), the webhook refunds the card
-- payment in full through Yoco instead of keeping the money.
--
-- Not verified from here: run once inside a transaction you roll back, on a test shop:
--   * _wallet_post with a NULL actor (the bot has no staff user)
--   * Passport purchase + card fulfilment end to end with a test Yoco key
-- ============================================================================

-- 1) tenant_payments: ticket orders ---------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.tenant_payments'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) ilike '%purpose%' or pg_get_constraintdef(oid) ilike '%status%')
  loop
    execute format('alter table public.tenant_payments drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.tenant_payments
  add constraint tenant_payments_purpose_check check (purpose in ('wallet_topup', 'event_order')),
  add constraint tenant_payments_status_check  check (status in ('creating','pending','succeeded','failed','cancelled','refund_needed','refunded'));

alter table public.tenant_payments add column if not exists metadata jsonb not null default '{}'::jsonb;

-- 2) wallet_get_or_create: allow the service role (body otherwise identical to the live function) -----
create or replace function public.wallet_get_or_create(p_tenant_id uuid, p_customer_id uuid)
returns public.wallets
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_cust public.tenant_customers;
  v_wallet public.wallets;
  v_currency text;
  v_server boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if auth.uid() is null and not v_server then raise exception 'Not authenticated'; end if;
  if not public.tenant_has_module(p_tenant_id, 'wallet') then
    raise exception 'Wallet is not enabled for this venue';
  end if;

  select * into v_cust from public.tenant_customers
  where id = p_customer_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Customer not found'; end if;

  if not (
    v_server
    or public.user_has_permission(p_tenant_id, 'wallet.operate')
    or public.user_has_permission(p_tenant_id, 'wallet.manage')
    or coalesce(v_cust.profile_id = auth.uid(), false)
  ) then
    raise exception 'Not authorized';
  end if;
  if v_cust.status <> 'active' then raise exception 'Customer is not active'; end if;

  insert into public.wallet_settings (tenant_id) values (p_tenant_id) on conflict do nothing;
  select currency into v_currency from public.wallet_settings where tenant_id = p_tenant_id;

  insert into public.wallets (tenant_id, customer_id, currency)
  values (p_tenant_id, p_customer_id, coalesce(v_currency, 'ZAR'))
  on conflict (tenant_id, customer_id) do nothing;

  select * into v_wallet from public.wallets
  where tenant_id = p_tenant_id and customer_id = p_customer_id;
  return v_wallet;
end;
$function$;

-- 3) Quote: the database's own answer on price and availability -------------------------------
create or replace function public.event_quote_whatsapp(
  p_tenant_id uuid, p_customer_id uuid, p_ticket_type_id uuid, p_quantity integer
)
returns table(
  event_id uuid, event_name text, event_start timestamptz,
  ticket_type_id uuid, ticket_type_name text,
  unit_price numeric, total numeric, available integer, quantity integer
)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_type public.event_ticket_types;
  v_event public.events;
  v_cust public.tenant_customers;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;
  if not public.tenant_has_module(p_tenant_id, 'events') then
    raise exception 'Events are not enabled for this venue';
  end if;

  select * into v_type from public.event_ticket_types where id = p_ticket_type_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Invalid ticket type'; end if;
  select * into v_event from public.events where id = v_type.event_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Event not found'; end if;

  if v_event.status <> 'active' then raise exception 'Tickets are not on sale for this event'; end if;
  if not v_type.is_active then raise exception 'This ticket type is not on sale'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 10 then
    raise exception 'You can buy between 1 and 10 tickets at a time';
  end if;
  if v_event.end_time is not null and v_event.end_time < now() then raise exception 'This event has ended'; end if;
  if v_type.sold + p_quantity > v_type.capacity then
    raise exception 'Only % left', greatest(v_type.capacity - v_type.sold, 0);
  end if;

  select * into v_cust from public.tenant_customers
  where id = p_customer_id and tenant_id = p_tenant_id and status = 'active';
  if not found then raise exception 'Customer not found'; end if;

  return query select
    v_event.id, v_event.name, v_event.start_time,
    v_type.id, v_type.name,
    v_type.price, round(v_type.price * p_quantity, 2),
    greatest(v_type.capacity - v_type.sold, 0), p_quantity;
end
$function$;

-- 4) Pay from the Passport --------------------------------------------------------------------
create or replace function public.event_purchase_ticket_whatsapp(
  p_tenant_id       uuid,
  p_customer_id     uuid,
  p_ticket_type_id  uuid,
  p_quantity        integer default 1,
  p_idempotency_key text    default null
)
returns public.event_orders
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_type   public.event_ticket_types;
  v_event  public.events;
  v_cust   public.tenant_customers;
  v_wallet public.wallets;
  v_order  public.event_orders;
  v_total  numeric(12,2);
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;
  if not public.tenant_has_module(p_tenant_id, 'events') then
    raise exception 'Events are not enabled for this venue';
  end if;

  select * into v_type from public.event_ticket_types where id = p_ticket_type_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Invalid ticket type'; end if;
  select * into v_event from public.events where id = v_type.event_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Event not found'; end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > 10 then
    raise exception 'You can buy between 1 and 10 tickets at a time';
  end if;
  if v_event.end_time is not null and v_event.end_time < now() then raise exception 'This event has ended'; end if;

  select * into v_cust from public.tenant_customers
  where id = p_customer_id and tenant_id = p_tenant_id and status = 'active';
  if not found then raise exception 'Customer not found'; end if;

  -- A retried WhatsApp message returns the same order instead of selling (and charging) twice.
  if p_idempotency_key is not null then
    select * into v_order from public.event_orders
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key and customer_id = v_cust.id;
    if found then return v_order; end if;
  end if;

  v_total := round(v_type.price * p_quantity, 2);
  if v_total > 0 then
    if not public.tenant_has_module(p_tenant_id, 'wallet') then
      raise exception 'Passport is not enabled for this venue';
    end if;
    select * into v_wallet from public.wallets where tenant_id = p_tenant_id and customer_id = v_cust.id;
    if not found or v_wallet.status <> 'active' then
      raise exception 'Your Passport can''t be used right now';
    end if;
    if v_wallet.balance < v_total then
      raise exception 'Your Passport balance is too low for this purchase';
    end if;
  end if;

  return public._event_issue_order(
    v_event.id, p_ticket_type_id, p_quantity, v_cust.id, v_cust.phone,
    'online', 'wallet', null, false, null, p_idempotency_key
  );
end
$function$;

-- 5) Issue tickets for a card payment that the webhook has already verified ------------------------
create or replace function public.event_fulfil_card_order_whatsapp(p_payment_id uuid, p_provider_reference text default null)
returns public.event_orders
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pay   public.tenant_payments;
  v_type  public.event_ticket_types;
  v_event public.events;
  v_cust  public.tenant_customers;
  v_order public.event_orders;
  v_qty   integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;

  select * into v_pay from public.tenant_payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_pay.purpose <> 'event_order' then raise exception 'Not a ticket payment'; end if;

  -- Already fulfilled: return the same order (safe to call twice).
  if v_pay.metadata ? 'order_id' then
    select * into v_order from public.event_orders where id = (v_pay.metadata->>'order_id')::uuid;
    return v_order;
  end if;

  v_qty := (v_pay.metadata->>'quantity')::integer;
  select * into v_type from public.event_ticket_types
  where id = (v_pay.metadata->>'ticket_type_id')::uuid and tenant_id = v_pay.tenant_id;
  if not found then raise exception 'Invalid ticket type'; end if;
  select * into v_event from public.events where id = v_type.event_id and tenant_id = v_pay.tenant_id;
  if not found then raise exception 'Event not found'; end if;
  select * into v_cust from public.tenant_customers
  where id = (v_pay.metadata->>'customer_id')::uuid and tenant_id = v_pay.tenant_id;
  if not found then raise exception 'Customer not found'; end if;

  -- What the customer paid must equal what these tickets cost right now.
  if round(v_type.price * v_qty, 2) <> v_pay.amount then
    raise exception 'price_changed';
  end if;

  -- Raises 'Only N left' / 'Tickets are not on sale ...' if it can no longer be issued.
  v_order := public._event_issue_order(
    v_event.id, v_type.id, v_qty, v_cust.id, v_cust.phone,
    'online', 'card', null, false, null, 'card-' || p_payment_id::text
  );

  update public.tenant_payments
     set metadata = metadata || jsonb_build_object('order_id', v_order.id, 'provider_reference', p_provider_reference),
         updated_at = now()
   where id = p_payment_id;
  return v_order;
end
$function$;

-- 6) Server-only ---------------------------------------------------------------------------
revoke all on function public.event_quote_whatsapp(uuid, uuid, uuid, integer)                   from public, anon, authenticated;
revoke all on function public.event_purchase_ticket_whatsapp(uuid, uuid, uuid, integer, text)  from public, anon, authenticated;
revoke all on function public.event_fulfil_card_order_whatsapp(uuid, text)                      from public, anon, authenticated;
grant execute on function public.event_quote_whatsapp(uuid, uuid, uuid, integer)               to service_role;
grant execute on function public.event_purchase_ticket_whatsapp(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.event_fulfil_card_order_whatsapp(uuid, text)                   to service_role;
