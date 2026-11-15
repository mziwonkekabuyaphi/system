-- Event settings: sales rules + the look of the WhatsApp event ticket image, per tenant.
-- Mirrors tenant_booking_ticket_settings (same columns/RLS shape). Events have no public page, so the
-- ticket image sent on WhatsApp is the whole customer-facing surface.
--
-- Rules are enforced in the database (inside the WhatsApp quote/purchase RPCs), not only in the bot,
-- so they hold for every channel that goes through those functions.

create table if not exists public.tenant_event_settings (
  tenant_id                  uuid primary key references public.tenants(id) on delete cascade,
  max_per_purchase           integer not null default 10 check (max_per_purchase between 1 and 10),
  max_per_customer           integer check (max_per_customer between 1 and 100),   -- null = no limit
  stop_sales_minutes_before  integer not null default 0 check (stop_sales_minutes_before between 0 and 10080), -- 0 = until the event ends
  updated_at                 timestamptz not null default now()
);

create table if not exists public.tenant_event_ticket_settings (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  enabled       boolean not null default true,
  header_style  text not null default 'gradient' check (header_style in ('gradient','solid','light')),
  header_color  text check (header_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color  text check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  eyebrow       text check (char_length(eyebrow) <= 40),
  footer_text   text check (char_length(footer_text) <= 120),
  show_logo     boolean not null default true,
  show_price    boolean not null default true,
  show_reference boolean not null default true,
  show_phone    boolean not null default false,
  show_address  boolean not null default true,
  updated_at    timestamptz not null default now()
);

alter table public.tenant_event_settings        enable row level security;
alter table public.tenant_event_ticket_settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tenant_event_settings','tenant_event_ticket_settings'] loop
    execute format('create policy %I on public.%I for select to authenticated using (is_platform_admin() or is_tenant_member(tenant_id))', t||'_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (is_platform_admin() or user_has_permission(tenant_id, ''events.manage''))', t||'_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (is_platform_admin() or user_has_permission(tenant_id, ''events.manage'')) with check (is_platform_admin() or user_has_permission(tenant_id, ''events.manage''))', t||'_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (is_platform_admin())', t||'_delete', t);
  end loop;
end $$;

-- One place for the sales rules. Raises the same plain-sentence exceptions the bot already maps to
-- customer wording (see friendly() in lib/payments/event-checkout.ts).
create or replace function public._event_enforce_sales_rules(
  p_tenant_id uuid, p_event public.events, p_customer_id uuid, p_quantity integer
) returns void
language plpgsql security definer set search_path = public as $$
declare
  s public.tenant_event_settings;
  v_have integer;
begin
  select * into s from public.tenant_event_settings where tenant_id = p_tenant_id;
  if not found then
    s.max_per_purchase := 10; s.max_per_customer := null; s.stop_sales_minutes_before := 0;
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > s.max_per_purchase then
    if s.max_per_purchase = 1 then
      raise exception 'You can buy 1 ticket at a time';
    end if;
    raise exception 'You can buy between 1 and % tickets at a time', s.max_per_purchase;
  end if;

  if s.stop_sales_minutes_before > 0
     and now() >= p_event.start_time - make_interval(mins => s.stop_sales_minutes_before) then
    raise exception 'Ticket sales for this event have closed';
  end if;

  if s.max_per_customer is not null and p_customer_id is not null then
    select count(*) into v_have from public.event_tickets
     where tenant_id = p_tenant_id and event_id = p_event.id and customer_id = p_customer_id
       and status in ('issued','used');
    if v_have + p_quantity > s.max_per_customer then
      raise exception 'Limit of % tickets per person for this event (you have %)', s.max_per_customer, v_have;
    end if;
  end if;
end $$;

revoke all on function public._event_enforce_sales_rules(uuid, public.events, uuid, integer) from public, anon, authenticated;

-- Quote: the hard-coded 1..10 check becomes the tenant's rules.
create or replace function public.event_quote_whatsapp(
  p_tenant_id uuid, p_customer_id uuid, p_ticket_type_id uuid, p_quantity integer
) returns table(event_id uuid, event_name text, event_start timestamptz, ticket_type_id uuid,
                ticket_type_name text, unit_price numeric, total numeric, available integer, quantity integer)
language plpgsql security definer set search_path = public as $$
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
  if v_event.end_time is not null and v_event.end_time < now() then raise exception 'This event has ended'; end if;

  select * into v_cust from public.tenant_customers
  where id = p_customer_id and tenant_id = p_tenant_id and status = 'active';
  if not found then raise exception 'Customer not found'; end if;

  perform public._event_enforce_sales_rules(p_tenant_id, v_event, v_cust.id, p_quantity);

  if v_type.sold + p_quantity > v_type.capacity then
    raise exception 'Only % left', greatest(v_type.capacity - v_type.sold, 0);
  end if;

  return query select
    v_event.id, v_event.name, v_event.start_time,
    v_type.id, v_type.name,
    v_type.price, round(v_type.price * p_quantity, 2),
    greatest(v_type.capacity - v_type.sold, 0), p_quantity;
end
$$;

-- Purchase: rules run AFTER the idempotency lookup so a retried message returns the existing order
-- instead of tripping the per-customer limit against its own earlier tickets.
create or replace function public.event_purchase_ticket_whatsapp(
  p_tenant_id uuid, p_customer_id uuid, p_ticket_type_id uuid, p_quantity integer default 1,
  p_idempotency_key text default null
) returns public.event_orders
language plpgsql security definer set search_path = public as $$
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

  perform public._event_enforce_sales_rules(p_tenant_id, v_event, v_cust.id, p_quantity);

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
$$;
