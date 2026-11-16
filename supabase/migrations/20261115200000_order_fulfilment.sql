-- Order fulfilment: collection, delivery and dine-in, configured per tenant.
--
--  * order_settings gets the switches (collection / delivery / dine-in), prep + delivery time estimates
--    and collection instructions. Existing shops keep today's behaviour: collection on, the others off.
--  * order_delivery_areas: the places a shop delivers to, each with its own fee, minimum order and an
--    optional "free delivery over" amount.
--  * orders records how it is fulfilled (fulfilment, area, address, delivery fee).
--  * place_order enforces all of it (allowed method, area, address, minimum order, fee) and charges the
--    fee exactly once per checkout: it is added to the FIRST order of the attempt (one wallet debit /
--    one card payment covers every vendor order), so cancelling that order refunds the fee with it.
--  * status 'out_for_delivery' for delivery orders (ready -> out_for_delivery -> completed).
--
-- Same access model as the other order tables: RLS on, no policies, read and written by the service role
-- after the server action has checked the caller's orders.manage permission and filtered by tenant_id.

alter table public.order_settings
  add column if not exists collection_enabled      boolean not null default true,
  add column if not exists delivery_enabled        boolean not null default false,
  add column if not exists dine_in_enabled         boolean not null default false,
  add column if not exists collection_instructions text check (char_length(collection_instructions) <= 200),
  add column if not exists prep_time_minutes       integer not null default 15 check (prep_time_minutes between 0 and 240),
  add column if not exists delivery_time_minutes   integer not null default 45 check (delivery_time_minutes between 5 and 240);

alter table public.order_settings
  drop constraint if exists order_settings_one_fulfilment_check;
alter table public.order_settings
  add constraint order_settings_one_fulfilment_check
  check (collection_enabled or delivery_enabled or dine_in_enabled);

create table if not exists public.order_delivery_areas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null check (btrim(name) <> '' and char_length(name) <= 60),
  fee         numeric(10,2) not null default 0 check (fee >= 0),
  min_order   numeric(10,2) not null default 0 check (min_order >= 0),
  free_over   numeric(10,2) check (free_over is null or free_over > 0),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index if not exists order_delivery_areas_tenant_name_key
  on public.order_delivery_areas (tenant_id, lower(btrim(name)));
alter table public.order_delivery_areas enable row level security;

alter table public.orders
  add column if not exists fulfilment         text not null default 'collection',
  add column if not exists delivery_area_id   uuid,
  add column if not exists delivery_area_name text,
  add column if not exists delivery_address   text check (char_length(delivery_address) <= 300),
  add column if not exists delivery_fee       numeric(12,2) not null default 0 check (delivery_fee >= 0);

alter table public.orders drop constraint if exists orders_fulfilment_check;
alter table public.orders add constraint orders_fulfilment_check
  check (fulfilment in ('collection','delivery','dine_in'));
alter table public.orders drop constraint if exists orders_delivery_details_check;
alter table public.orders add constraint orders_delivery_details_check
  check (fulfilment <> 'delivery' or (btrim(coalesce(delivery_address,'')) <> '' and btrim(coalesce(delivery_area_name,'')) <> ''));

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status = any (array['pending','placed','preparing','ready','out_for_delivery','collected','completed','cancelled','scheduled']));

-- The area is a snapshot on the order (name + address), so editing or deleting an area later never
-- rewrites history; the id is informational only and is set null if the area row goes away.
alter table public.orders drop constraint if exists orders_delivery_area_fk;
alter table public.orders add constraint orders_delivery_area_fk
  foreign key (tenant_id, delivery_area_id) references public.order_delivery_areas (tenant_id, id) on delete set null (delivery_area_id);

create or replace function public._orders_json(p_attempt uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'order_number', o.order_number, 'vendor_id', o.vendor_id,
      'vendor_name', v.name, 'collection_point', v.collection_point,
      'total', o.total_amount, 'status', o.status,
      'fulfilment', o.fulfilment, 'delivery_fee', o.delivery_fee,
      'delivery_area', o.delivery_area_name, 'delivery_address', o.delivery_address,
      'table_label', o.table_label,
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
                  'product_name', i.product_name, 'quantity', i.quantity, 'unit_price', i.unit_price)
                  order by i.created_at, i.id), '[]'::jsonb)
                from order_items i where i.order_id = o.id)
    ) order by o.created_at, o.id), '[]'::jsonb)
  from orders o join order_vendors v on v.tenant_id = o.tenant_id and v.id = o.vendor_id
  where o.payment_attempt_id = p_attempt;
$$;

drop function if exists public.place_order(uuid, uuid, text, text, text, uuid, timestamptz, text, jsonb);

create or replace function public.place_order(
  p_tenant uuid, p_customer uuid, p_phone text, p_customer_name text, p_payment_method text,
  p_attempt uuid, p_scheduled_for timestamptz, p_table_label text, p_lines jsonb,
  p_fulfilment text default 'collection', p_delivery_area uuid default null, p_delivery_address text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_set order_settings%rowtype;
  l record; g record;
  v_prod products%rowtype;
  v_resolved jsonb := '[]'::jsonb;
  v_total numeric := 0;          -- items only
  v_grand numeric;               -- items + delivery fee: what the customer pays
  v_vendor uuid;
  v_wallet wallets%rowtype;
  v_status text; v_pay text;
  v_order_id uuid; v_first uuid;
  v_fulfil text := coalesce(nullif(btrim(p_fulfilment), ''), 'collection');
  v_area order_delivery_areas%rowtype;
  v_address text := nullif(btrim(coalesce(p_delivery_address, '')), '');
  v_table text := nullif(btrim(coalesce(p_table_label, '')), '');
  v_fee numeric := 0;
  v_this_fee numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_attempt::text, 0));

  if exists (select 1 from orders where tenant_id = p_tenant and payment_attempt_id = p_attempt) then
    return jsonb_build_object('outcome', 'already_placed', 'orders', _orders_json(p_attempt),
      'total', (select sum(total_amount) from orders where tenant_id = p_tenant and payment_attempt_id = p_attempt));
  end if;

  if not tenant_has_module(p_tenant, 'orders') then
    return jsonb_build_object('outcome', 'ordering_not_enabled');
  end if;

  select * into v_set from order_settings where tenant_id = p_tenant;
  if not found then return jsonb_build_object('outcome', 'ordering_not_configured'); end if;
  if not (p_payment_method = any (v_set.allowed_payment_methods)) then
    return jsonb_build_object('outcome', 'payment_method_not_allowed');
  end if;
  if p_payment_method = 'wallet' and not tenant_has_module(p_tenant, 'wallet') then
    return jsonb_build_object('outcome', 'payment_method_not_allowed');
  end if;

  -- How the order reaches the customer.
  if v_fulfil not in ('collection', 'delivery', 'dine_in') then
    return jsonb_build_object('outcome', 'invalid_fulfilment');
  end if;
  if (v_fulfil = 'collection' and not v_set.collection_enabled)
     or (v_fulfil = 'delivery' and not v_set.delivery_enabled)
     or (v_fulfil = 'dine_in' and not v_set.dine_in_enabled) then
    return jsonb_build_object('outcome', 'fulfilment_not_allowed');
  end if;
  if v_fulfil = 'delivery' then
    select * into v_area from order_delivery_areas
     where tenant_id = p_tenant and id = p_delivery_area and is_active;
    if not found then return jsonb_build_object('outcome', 'delivery_area_unavailable'); end if;
    if v_address is null or char_length(v_address) < 5 or char_length(v_address) > 300 then
      return jsonb_build_object('outcome', 'delivery_address_required');
    end if;
  elsif v_fulfil = 'dine_in' then
    if v_table is null then return jsonb_build_object('outcome', 'table_required'); end if;
  end if;

  if p_scheduled_for is not null then
    if not v_set.allow_scheduling then
      return jsonb_build_object('outcome', 'scheduling_not_allowed');
    end if;
    if p_scheduled_for < now() + make_interval(mins => v_set.schedule_min_lead_minutes) then
      return jsonb_build_object('outcome', 'schedule_too_soon', 'min_lead_minutes', v_set.schedule_min_lead_minutes);
    end if;
  end if;

  if not exists (select 1 from tenant_customers where tenant_id = p_tenant and id = p_customer) then
    return jsonb_build_object('outcome', 'customer_not_found');
  end if;

  for l in
    select x.product_id, sum(x.quantity)::int as qty
      from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity int)
     group by x.product_id
     order by x.product_id
  loop
    if l.qty is null or l.qty < 1 or l.qty > 50 then
      return jsonb_build_object('outcome', 'invalid_quantity');
    end if;
    select * into v_prod from products where tenant_id = p_tenant and id = l.product_id for update;
    if not found then
      return jsonb_build_object('outcome', 'product_not_found');
    end if;
    if v_prod.status <> 'active' or not v_prod.is_available then
      return jsonb_build_object('outcome', 'product_unavailable', 'product_name', v_prod.name);
    end if;
    if v_prod.track_inventory and v_prod.stock_quantity is not null and v_prod.stock_quantity < l.qty then
      return jsonb_build_object(
        'outcome', case when v_prod.stock_quantity <= 0 then 'out_of_stock' else 'low_stock' end,
        'product_name', v_prod.name, 'stock', v_prod.stock_quantity);
    end if;
    v_vendor := coalesce(v_prod.vendor_id, v_set.default_vendor_id);
    if v_vendor is null then
      return jsonb_build_object('outcome', 'no_vendor_configured');
    end if;
    if not exists (select 1 from order_vendors where tenant_id = p_tenant and id = v_vendor and is_active) then
      return jsonb_build_object('outcome', 'vendor_unavailable', 'product_name', v_prod.name);
    end if;
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.name, 'quantity', l.qty,
      'unit_price', v_prod.price, 'subtotal', round(v_prod.price * l.qty, 2), 'vendor_id', v_vendor));
    v_total := v_total + round(v_prod.price * l.qty, 2);
  end loop;

  if jsonb_array_length(v_resolved) = 0 then
    return jsonb_build_object('outcome', 'empty_cart');
  end if;

  -- Delivery fee and minimum order are judged on the whole checkout (all vendors together).
  if v_fulfil = 'delivery' then
    if v_area.min_order > 0 and v_total < v_area.min_order then
      return jsonb_build_object('outcome', 'below_minimum_order', 'min_order', v_area.min_order, 'subtotal', v_total);
    end if;
    v_fee := case when v_area.free_over is not null and v_total >= v_area.free_over then 0 else v_area.fee end;
  end if;
  v_grand := v_total + v_fee;

  if p_payment_method = 'wallet' then
    select * into v_wallet from wallets where tenant_id = p_tenant and customer_id = p_customer for update;
    if not found then return jsonb_build_object('outcome', 'wallet_not_found'); end if;
    if v_wallet.status <> 'active' then return jsonb_build_object('outcome', 'wallet_inactive'); end if;
    if v_wallet.balance < v_grand then
      return jsonb_build_object('outcome', 'insufficient_funds', 'balance', v_wallet.balance, 'total', v_grand);
    end if;
  end if;

  v_status := case when p_payment_method = 'card' then 'pending'
                   when p_scheduled_for is not null then 'scheduled' else 'placed' end;
  v_pay    := case when p_payment_method = 'wallet' then 'paid' else 'pending' end;

  for g in
    select (r.value->>'vendor_id')::uuid as vendor_id,
           sum((r.value->>'subtotal')::numeric) as total,
           min(r.ordinality) as ord
      from jsonb_array_elements(v_resolved) with ordinality as r(value, ordinality)
     group by 1 order by ord
  loop
    -- The fee rides on the first order only; every delivery order carries the same address.
    v_this_fee := case when v_first is null then v_fee else 0 end;

    insert into orders (tenant_id, customer_id, customer_phone, customer_name, vendor_id, order_number,
                        status, payment_method, payment_status, payment_attempt_id, total_amount,
                        scheduled_for, table_label,
                        fulfilment, delivery_area_id, delivery_area_name, delivery_address, delivery_fee)
    values (p_tenant, p_customer, p_phone, p_customer_name, g.vendor_id, _next_order_number(p_tenant),
            v_status, p_payment_method, v_pay, p_attempt, g.total + v_this_fee,
            p_scheduled_for, case when v_fulfil = 'dine_in' then v_table else p_table_label end,
            v_fulfil,
            case when v_fulfil = 'delivery' then v_area.id end,
            case when v_fulfil = 'delivery' then v_area.name end,
            case when v_fulfil = 'delivery' then v_address end,
            v_this_fee)
    returning id into v_order_id;

    v_first := coalesce(v_first, v_order_id);

    insert into order_items (tenant_id, order_id, product_id, product_name, quantity, unit_price, subtotal)
    select p_tenant, v_order_id, (r.value->>'product_id')::uuid, r.value->>'name',
           (r.value->>'quantity')::int, (r.value->>'unit_price')::numeric, (r.value->>'subtotal')::numeric
      from jsonb_array_elements(v_resolved) with ordinality as r(value, ordinality)
     where (r.value->>'vendor_id')::uuid = g.vendor_id
     order by r.ordinality;

    if p_payment_method <> 'card' then perform _apply_order_stock(v_order_id); end if;
  end loop;

  if p_payment_method = 'wallet' then
    perform _wallet_post(v_wallet.id, 'debit', 'purchase', v_grand, 'order', v_first,
                         'Order payment', 'order_payment:' || p_attempt,
                         jsonb_build_object('payment_attempt_id', p_attempt), null);
  end if;

  return jsonb_build_object('outcome', 'ok', 'total', v_grand, 'delivery_fee', v_fee, 'orders', _orders_json(p_attempt));
end $$;

revoke all on function public.place_order(uuid, uuid, text, text, text, uuid, timestamptz, text, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, text, text, uuid, timestamptz, text, jsonb, text, uuid, text) to service_role;
