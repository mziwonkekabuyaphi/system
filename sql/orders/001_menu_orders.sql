-- =====================================================================
-- Ndithini Platform  |  Module: menu_orders  (Rands "Product Management")
-- Target project : muelggaqfjumjjdqtnaq (Ndithini Platform)
-- Status         : DRAFT v3 - NOT applied. Tested on a throwaway Postgres.
-- v3 fixes       : stock CHECKs + atomic stock deduction/restore, track_inventory
--                  now defaults to false, staff references must be active tenant
--                  members, order_events status/payment history (append-only).
-- v2 fixes       : permissions.module (NOT NULL), unique (id,tenant_id) on
--                  tenant_customers detected by columns, EXECUTE revoked on
--                  trigger functions.
-- Conventions    : tenant_id on every table, composite FKs (id, tenant_id)
--                  so a child can never point at another tenant's parent,
--                  RLS via is_platform_admin() / user_has_permission() /
--                  tenant_has_module(), existing set_updated_at() trigger.
-- Payments       : manual only. Staff mark an order paid (who/when/how).
--                  No gateway, no wallet. Single payment fields on orders are
--                  deliberate for v1; partial payments, refunds or split tenders
--                  will need an order_payments table (revisit with the wallet).
-- Customers      : NO customer policies on purpose. Customer-facing ordering
--                  must go through a server action (service role) that
--                  re-reads prices from products and never trusts the client.
--                  Customers read the menu only via get_public_menu().
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Module, permissions, plan access
-- ---------------------------------------------------------------------
insert into public.modules (key, name, description)
select 'menu_orders', 'Menu & Orders',
       'Product catalogue and order taking with manual payment capture'
where not exists (select 1 from public.modules where key = 'menu_orders');

-- Which plans get it. Adjust plan keys to taste.
insert into public.plan_modules (plan_key, module_id)
select p.key, m.id
from public.plans p
cross join public.modules m
where m.key = 'menu_orders' and p.key in ('growth', 'business')
on conflict do nothing;

-- orders.view / orders.manage already exist. Add the missing ones.
-- (permissions.module is NOT NULL in the live schema.)
insert into public.permissions (key, module, description)
select v.key, v.module, v.description
from (values
  ('products.view',   'menu_orders', 'View the product catalogue and categories'),
  ('products.manage', 'menu_orders', 'Create, edit, reprice and archive products and categories'),
  ('orders.operate',  'menu_orders', 'Take orders, advance order status and record manual payments')
) as v(key, module, description)
where not exists (select 1 from public.permissions p where p.key = v.key);

-- owner: everything. staff: see catalogue + take orders (no repricing/voiding).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p
  on (r.key, p.key) in (
       ('tenant_owner', 'products.view'),
       ('tenant_owner', 'products.manage'),
       ('tenant_owner', 'orders.operate'),
       ('tenant_staff', 'products.view'),
       ('tenant_staff', 'orders.operate')
     )
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 1. Shared guard: tenant_id can never change after insert
-- ---------------------------------------------------------------------
create or replace function public.trg_prevent_tenant_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.tenant_id <> old.tenant_id then
    raise exception 'tenant_id is immutable';
  end if;
  return new;
end;
$$;

-- Needed so orders can use a composite FK to tenant_customers.
-- Detects ANY unique constraint on {id, tenant_id} (the shisha module adds one
-- too), so applying both modules never creates a duplicate.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.tenant_customers'::regclass
      and c.contype in ('u', 'p')
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k join pg_attribute a
             on a.attrelid = c.conrelid and a.attnum = k) = array['id', 'tenant_id']
  ) then
    alter table public.tenant_customers
      add constraint tenant_customers_id_tenant_uniq unique (id, tenant_id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. product_categories   (Rands: categories, text ids -> uuid)
-- ---------------------------------------------------------------------
create table public.product_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  parent_id   uuid,
  name        text not null check (length(btrim(name)) > 0),
  icon        text,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (parent_id, tenant_id)
    references public.product_categories (id, tenant_id)
    on delete set null (parent_id)
);

create unique index product_categories_name_uniq
  on public.product_categories
  (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

comment on table public.product_categories is
  'Per-tenant menu/catalogue categories, optionally nested one level via parent_id.';

-- ---------------------------------------------------------------------
-- 3. products
--    Dropped from Rands: shisha_id, locker_id (legacy FKs),
--    total_sales / total_revenue / last_sold_at / product_views
--    (denormalised stats - derive them from order_items instead).
-- ---------------------------------------------------------------------
create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  category_id         uuid,
  name                text not null check (length(btrim(name)) > 0),
  short_description   text,
  description         text,
  sku                 text,
  barcode             text,
  brand               text,
  vendor              text,
  product_type        text not null default 'standard',   -- 'standard' | later 'shisha', etc.
  price               numeric(12,2) not null default 0 check (price >= 0),
  cost_price          numeric(12,2) check (cost_price >= 0),
  compare_price       numeric(12,2) check (compare_price >= 0),
  track_inventory     boolean not null default false,   -- opt-in: tracked products are decremented per order
  stock_quantity      integer not null default 0 check (stock_quantity >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  status              text not null default 'active'
                        check (status in ('draft', 'active', 'archived')),
  is_available        boolean not null default true,       -- quick "86 it" toggle
  featured            boolean not null default false,
  is_alcohol          boolean not null default false,
  vault_eligible      boolean not null default false,      -- used by the future Vault module
  preorder_enabled    boolean not null default false,
  image_url           text,
  gallery             jsonb not null default '[]'::jsonb,
  variants            jsonb not null default '[]'::jsonb,
  options             jsonb not null default '{}'::jsonb,
  available_on        text[] not null default array['pos']
                        check (available_on <@ array['pos','kiosk','whatsapp','web']),
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (category_id, tenant_id)
    references public.product_categories (id, tenant_id)
    on delete set null (category_id)
);

create unique index products_tenant_sku_uniq
  on public.products (tenant_id, sku) where sku is not null;
create index products_tenant_status_idx on public.products (tenant_id, status);
create index products_tenant_category_idx on public.products (tenant_id, category_id);

comment on column public.products.is_available is
  'Temporary on/off switch (sold out today) without archiving the product.';

-- ---------------------------------------------------------------------
-- 4. order_settings   (Rands: kitchen_status single global row)
-- ---------------------------------------------------------------------
create table public.order_settings (
  tenant_id             uuid primary key references public.tenants(id) on delete cascade,
  accepting_orders      boolean not null default true,
  default_prep_minutes  integer not null default 15 check (default_prep_minutes > 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

insert into public.order_settings (tenant_id)
select id from public.tenants
on conflict do nothing;

create or replace function public.trg_tenants_order_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_settings (tenant_id) values (new.id)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

create trigger tenants_order_settings
  after insert on public.tenants
  for each row execute function public.trg_tenants_order_settings();

-- ---------------------------------------------------------------------
-- 5. order_counters + orders
--    Rands problems fixed here: duplicate total/total_amount, duplicate
--    order_id/order_number, items jsonb duplicating order_items,
--    epoch-ms prep_start_time, global (not per-tenant) order sequence.
-- ---------------------------------------------------------------------
create table public.order_counters (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  order_date  date not null,
  seq         integer not null default 0,
  primary key (tenant_id, order_date)
);
-- Only ever touched by the SECURITY DEFINER trigger below.
alter table public.order_counters enable row level security;

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  order_number     integer not null,                 -- per-tenant, per-day, set by trigger
  business_date    date not null,                    -- tenant-timezone day, set by trigger
  customer_id      uuid,
  customer_name    text,
  customer_phone   text,
  source           text not null default 'pos'
                     check (source in ('pos','kiosk','whatsapp','web','vvip_pos')),
  service_type     text check (service_type in ('dine_in','takeaway','table_service')),
  table_label      text,
  status           text not null default 'pending'
                     check (status in ('pending','preparing','ready','collected','cancelled')),
  scheduled_for    timestamptz,
  prep_started_at  timestamptz,
  prep_minutes     integer check (prep_minutes > 0),
  ready_at         timestamptz,
  ready_by         uuid references public.profiles(id) on delete set null,
  collected_at     timestamptz,
  collected_by     uuid references public.profiles(id) on delete set null,
  subtotal         numeric(12,2) not null default 0 check (subtotal >= 0),   -- maintained by trigger
  discount_amount  numeric(12,2) not null default 0 check (discount_amount >= 0),
  total            numeric(12,2) generated always as (subtotal - discount_amount) stored,
  payment_status   text not null default 'unpaid'
                     check (payment_status in ('unpaid','paid','refunded','void')),
  payment_method   text check (payment_method in ('cash','card','eft','tab','other')),
  payment_reference text,
  paid_at          timestamptz,
  paid_by          uuid references public.profiles(id) on delete set null,
  notes            text,
  meta             jsonb not null default '{}'::jsonb,
  created_by       uuid references public.profiles(id) on delete set null,
  updated_by       uuid references public.profiles(id) on delete set null,   -- set by the app on every change; feeds order_events
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, business_date, order_number),
  check (total >= 0),
  -- manual payment must leave an audit trail
  check (payment_status <> 'paid'
         or (payment_method is not null and paid_at is not null and paid_by is not null)),
  foreign key (customer_id, tenant_id)
    references public.tenant_customers (id, tenant_id)
    on delete set null (customer_id)
);

create index orders_tenant_created_idx on public.orders (tenant_id, created_at desc);
create index orders_tenant_status_idx  on public.orders (tenant_id, status);
create index orders_tenant_payment_idx on public.orders (tenant_id, payment_status);

create or replace function public.trg_orders_assign_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
  v_seq  integer;
begin
  -- Skipped when importing historical orders that already carry a number.
  if new.order_number is not null and new.business_date is not null then
    return new;
  end if;

  v_date := (coalesce(new.created_at, now())
             at time zone public.waitlist_tenant_tz(new.tenant_id))::date;

  insert into public.order_counters (tenant_id, order_date, seq)
  values (new.tenant_id, v_date, 1)
  on conflict (tenant_id, order_date)
  do update set seq = public.order_counters.seq + 1
  returning seq into v_seq;

  new.business_date := v_date;
  new.order_number  := v_seq;
  return new;
end;
$$;

create trigger orders_assign_number
  before insert on public.orders
  for each row execute function public.trg_orders_assign_number();

-- ---------------------------------------------------------------------
-- 6. order_items   (Rands: empty table; real lines lived in orders.items jsonb)
-- ---------------------------------------------------------------------
create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  order_id      uuid not null,
  product_id    uuid,
  product_name  text not null,                       -- snapshot at time of sale
  unit_price    numeric(12,2) not null check (unit_price >= 0),  -- snapshot at time of sale
  quantity      integer not null default 1 check (quantity > 0),
  line_total    numeric(12,2) generated always as (unit_price * quantity) stored,
  notes         text,
  options       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  foreign key (order_id, tenant_id)
    references public.orders (id, tenant_id) on delete cascade,
  foreign key (product_id, tenant_id)
    references public.products (id, tenant_id) on delete set null (product_id)
);

create index order_items_order_idx   on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);

create or replace function public.trg_order_items_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  uuid := coalesce(new.order_id,  old.order_id);
  v_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
begin
  update public.orders o
     set subtotal = coalesce((select sum(i.line_total)
                              from public.order_items i
                              where i.order_id = v_order and i.tenant_id = v_tenant), 0)
   where o.id = v_order and o.tenant_id = v_tenant;
  return null;
end;
$$;

create trigger order_items_recalc
  after insert or update or delete on public.order_items
  for each row execute function public.trg_order_items_recalc();

-- ---------------------------------------------------------------------
-- 6b. Stock: atomic deduct / restore (tracked products only)
--     The UPDATE ... WHERE stock_quantity >= qty takes the row lock, so two
--     concurrent sales of the last units cannot both succeed.
--     Deleting a whole order restores stock like deleting its items does;
--     cancel the order instead if you want to keep it for history.
-- ---------------------------------------------------------------------
create or replace function public.order_stock_adjust(
  p_tenant uuid, p_product uuid, p_qty integer)   -- p_qty > 0 deducts, < 0 restores
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tracked boolean;
  v_rows    integer;
begin
  if p_product is null or p_qty = 0 then
    return;
  end if;

  select track_inventory into v_tracked
  from public.products where id = p_product and tenant_id = p_tenant;
  if not coalesce(v_tracked, false) then
    return;
  end if;

  update public.products
     set stock_quantity = stock_quantity - p_qty
   where id = p_product and tenant_id = p_tenant
     and stock_quantity - p_qty >= 0;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'Insufficient stock for product %', p_product
      using errcode = 'check_violation';
  end if;
end;
$$;
revoke all on function public.order_stock_adjust(uuid, uuid, integer) from public, anon, authenticated;

create or replace function public.trg_order_items_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select status into v_status from public.orders
     where id = new.order_id and tenant_id = new.tenant_id;
    if v_status = 'cancelled' then
      raise exception 'Cannot change items on a cancelled order';
    end if;
  end if;

  if tg_op = 'INSERT' then
    perform public.order_stock_adjust(new.tenant_id, new.product_id, new.quantity);
  elsif tg_op = 'UPDATE' then
    perform public.order_stock_adjust(old.tenant_id, old.product_id, -old.quantity);
    perform public.order_stock_adjust(new.tenant_id, new.product_id,  new.quantity);
  else  -- DELETE
    select status into v_status from public.orders
     where id = old.order_id and tenant_id = old.tenant_id;
    if coalesce(v_status, '') <> 'cancelled' then   -- cancelled orders were already restored
      perform public.order_stock_adjust(old.tenant_id, old.product_id, -old.quantity);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.trg_order_items_stock() from public, anon, authenticated;

create trigger order_items_stock
  after insert or update of product_id, quantity or delete on public.order_items
  for each row execute function public.trg_order_items_stock();

create or replace function public.trg_orders_cancel_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    for r in select product_id, quantity from public.order_items
             where order_id = new.id and tenant_id = new.tenant_id loop
      perform public.order_stock_adjust(new.tenant_id, r.product_id, -r.quantity);
    end loop;
  elsif old.status = 'cancelled' and new.status <> 'cancelled' then
    for r in select product_id, quantity from public.order_items
             where order_id = new.id and tenant_id = new.tenant_id loop
      perform public.order_stock_adjust(new.tenant_id, r.product_id, r.quantity);
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function public.trg_orders_cancel_stock() from public, anon, authenticated;

create trigger orders_cancel_stock
  after update of status on public.orders
  for each row execute function public.trg_orders_cancel_stock();

-- ---------------------------------------------------------------------
-- 6c. Staff references must be ACTIVE members of the order's tenant
--     (checked when the value is set or changed, so an ex-staff member
--     stays on old orders).
-- ---------------------------------------------------------------------
create or replace function public.trg_orders_validate_staff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_col text;
  v_id  uuid;
  v_old uuid;
begin
  foreach v_col in array array['created_by', 'updated_by', 'ready_by', 'collected_by', 'paid_by'] loop
    v_id  := (to_jsonb(new) ->> v_col)::uuid;
    v_old := case when tg_op = 'UPDATE' then (to_jsonb(old) ->> v_col)::uuid end;
    if v_id is not null and v_id is distinct from v_old
       and not exists (select 1 from public.tenant_members tm
                       where tm.tenant_id = new.tenant_id
                         and tm.profile_id = v_id
                         and tm.status = 'active') then
      raise exception '% is not an active member of this tenant', v_col;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.trg_orders_validate_staff() from public, anon, authenticated;

create trigger orders_validate_staff
  before insert or update on public.orders
  for each row execute function public.trg_orders_validate_staff();

-- ---------------------------------------------------------------------
-- 6d. order_events: who moved an order through each status / payment state.
--     Written by a trigger only; clients get read access. Actor = the signed-in
--     user, else orders.updated_by (server actions on the service role set it).
-- ---------------------------------------------------------------------
create table public.order_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  order_id    uuid not null,
  kind        text not null check (kind in ('status', 'payment')),
  from_value  text,
  to_value    text not null,
  actor_id    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  foreign key (order_id, tenant_id)
    references public.orders (id, tenant_id) on delete cascade
);
create index order_events_order_idx on public.order_events (tenant_id, order_id, created_at);

create trigger order_events_no_update
  before update on public.order_events
  for each row execute function public.trg_append_only();

create or replace function public.trg_orders_log_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := coalesce(auth.uid(), new.updated_by, new.created_by);
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (tenant_id, order_id, kind, from_value, to_value, actor_id)
    values (new.tenant_id, new.id, 'status', null, new.status, v_actor);
  else
    if new.status is distinct from old.status then
      insert into public.order_events (tenant_id, order_id, kind, from_value, to_value, actor_id)
      values (new.tenant_id, new.id, 'status', old.status, new.status, v_actor);
    end if;
    if new.payment_status is distinct from old.payment_status then
      insert into public.order_events (tenant_id, order_id, kind, from_value, to_value, actor_id)
      values (new.tenant_id, new.id, 'payment', old.payment_status, new.payment_status,
              coalesce(new.paid_by, v_actor));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.trg_orders_log_events() from public, anon, authenticated;

create trigger orders_log_events
  after insert or update on public.orders
  for each row execute function public.trg_orders_log_events();

-- ---------------------------------------------------------------------
-- 7. updated_at + tenant_id immutability
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['product_categories','products','order_settings','orders']
  loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;

  foreach t in array array['product_categories','products','order_settings','orders','order_items']
  loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.trg_prevent_tenant_change()',
                   t || '_tenant_guard', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 8. Row Level Security
--    Reads : permission only (so a downgraded tenant can still see history)
--    Writes: permission AND module enabled for the tenant
-- ---------------------------------------------------------------------
alter table public.product_categories enable row level security;
alter table public.products           enable row level security;
alter table public.order_settings     enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.order_events       enable row level security;

-- product_categories
create policy product_categories_select on public.product_categories for select
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'products.view'));
create policy product_categories_write on public.product_categories for all
  using (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and public.user_has_permission(tenant_id, 'products.manage')))
  with check (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and public.user_has_permission(tenant_id, 'products.manage')));

-- products
create policy products_select on public.products for select
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'products.view'));
create policy products_write on public.products for all
  using (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and public.user_has_permission(tenant_id, 'products.manage')))
  with check (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and public.user_has_permission(tenant_id, 'products.manage')));

-- order_settings
create policy order_settings_select on public.order_settings for select
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.view'));
create policy order_settings_write on public.order_settings for update
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.manage'))
  with check (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.manage'));

-- orders
create policy orders_select on public.orders for select
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.view'));
create policy orders_insert on public.orders for insert
  with check (public.is_platform_admin()
              or (public.tenant_has_module(tenant_id, 'menu_orders')
                  and (public.user_has_permission(tenant_id, 'orders.operate')
                       or public.user_has_permission(tenant_id, 'orders.manage'))));
create policy orders_update on public.orders for update
  using (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and (public.user_has_permission(tenant_id, 'orders.operate')
                  or public.user_has_permission(tenant_id, 'orders.manage'))))
  with check (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and (public.user_has_permission(tenant_id, 'orders.operate')
                  or public.user_has_permission(tenant_id, 'orders.manage'))));
create policy orders_delete on public.orders for delete
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.manage'));

-- order_events (read only for clients; the trigger writes them)
create policy order_events_select on public.order_events for select
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.view'));

-- order_items (same rules as their order)
create policy order_items_select on public.order_items for select
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.view'));
create policy order_items_insert on public.order_items for insert
  with check (public.is_platform_admin()
              or (public.tenant_has_module(tenant_id, 'menu_orders')
                  and (public.user_has_permission(tenant_id, 'orders.operate')
                       or public.user_has_permission(tenant_id, 'orders.manage'))));
create policy order_items_update on public.order_items for update
  using (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and (public.user_has_permission(tenant_id, 'orders.operate')
                  or public.user_has_permission(tenant_id, 'orders.manage'))))
  with check (public.is_platform_admin()
         or (public.tenant_has_module(tenant_id, 'menu_orders')
             and (public.user_has_permission(tenant_id, 'orders.operate')
                  or public.user_has_permission(tenant_id, 'orders.manage'))));
create policy order_items_delete on public.order_items for delete
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'orders.manage'));

-- ---------------------------------------------------------------------
-- 9. Public menu for kiosk / WhatsApp / web (no table access for anon)
--    Exposes only customer-safe columns: no cost_price, stock, sku, meta.
-- ---------------------------------------------------------------------
create or replace function public.get_public_menu(p_tenant_id uuid, p_channel text default 'kiosk')
returns table (
  id uuid, name text, short_description text, description text,
  price numeric, image_url text, category_id uuid, category_name text,
  category_sort integer, featured boolean, is_alcohol boolean,
  variants jsonb, options jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.name, p.short_description, p.description,
         p.price, p.image_url, p.category_id, c.name, coalesce(c.sort_order, 0),
         p.featured, p.is_alcohol, p.variants, p.options
  from public.products p
  left join public.product_categories c
         on c.id = p.category_id and c.tenant_id = p.tenant_id and c.active
  where p.tenant_id = p_tenant_id
    and public.tenant_has_module(p_tenant_id, 'menu_orders')
    and p.status = 'active'
    and p.is_available
    and p_channel = any (p.available_on)
  order by coalesce(c.sort_order, 0), p.featured desc, p.name;
$$;

revoke all on function public.get_public_menu(uuid, text) from public;
grant execute on function public.get_public_menu(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. Realtime for the kitchen / pickup display (respects RLS)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime'
                       and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 11. Trigger functions are not API endpoints
--     (SECURITY DEFINER functions are callable by default; see the security
--     hardening migrations.)
-- ---------------------------------------------------------------------
revoke all on function public.trg_prevent_tenant_change()   from public, anon, authenticated;
revoke all on function public.trg_tenants_order_settings()  from public, anon, authenticated;
revoke all on function public.trg_orders_assign_number()    from public, anon, authenticated;
revoke all on function public.trg_order_items_recalc()      from public, anon, authenticated;

commit;

-- =====================================================================
-- DATA MIGRATION PLAN (run separately, after this is applied and the
-- Rands tenant row exists in Ndithini)
--   categories : Rands `categories` has 0 rows. Seed from the 10 distinct
--                text values in products.category (beers, whiskey, ...).
--   products   : 19 rows. category text -> category_id lookup.
--                Skip the 1 `locker_rental` product (legacy lockers).
--                Keep the 1 vault_eligible product flag.
--                Set track_inventory = true and copy stock_quantity for all 19
--                (Rands tracks all of them; the new default is false).
--   orders     : 11 rows. 10 are source=vvip_pos / payment_method=vvip_tab
--                (VVIP module) - hold these until VVIP moves, or import as
--                history. Only 1 is a real WhatsApp order.
--   order_items: Rands table is EMPTY. Explode orders.items jsonb
--                (keys: name|product_name, product_id, quantity, unit_price)
--                into order_items rows. Totals recalc via trigger.
--   settings   : kitchen_status.value -> order_settings.accepting_orders
--   dropped    : order_queue (replace with Realtime on orders),
--                order_counters (recreated empty, per tenant)
-- =====================================================================
