-- =====================================================================
-- Ndithini Platform  |  Shisha module  |  001 schema  (DRAFT v3 - NOT APPLIED)
-- Target project: muelggaqfjumjjdqtnaq
-- Source: Rands (odpugxrihfspaucsdqjj) - 32 devices, 3 flavours, 5 stations, 0 sessions
--
-- WHEN TO APPLY: not during the ZozoQueue pilot week (26-30 Oct 2026).
-- Plan: apply in November, ideally on a Supabase branch database first.
--
-- v3 changes vs v2 (checked against the live Ndithini schema on 2026-10-24):
--   * MODULE GATING IN RLS: every policy now also requires
--     tenant_has_module(tenant_id, 'shisha'). v2 only checked the permission,
--     and tenant_staff gets shisha.operate in EVERY tenant, so a tenant without
--     the module (e.g. the Free plan) could still read/write these tables from a
--     browser client. Platform admins still bypass.
--   * DEVICE STATUS CAN NO LONGER DRIFT: a trigger on shisha_sessions keeps
--     shisha_devices.status in sync ('in_use' while a live session exists,
--     otherwise 'available'). 'maintenance' is manual and never overwritten.
--     Staff should not set 'in_use' by hand any more. (In Rands, SH - 01 got
--     stuck at in_use with no session; this prevents that.)
--   * shisha_sessions.paused is now a GENERATED column (status = 'paused'), so it
--     can never disagree with status. App code must change status, not paused.
--   * The trigger function is SECURITY DEFINER (staff with only shisha.operate
--     cannot write devices directly) and is NOT executable via the public API.
--
-- Kept from v2: permissions shisha.view / shisha.operate / shisha.manage,
-- soft delete via archived_at, partial unique indexes, shisha_settings,
-- 'completed' session status, one live session per device, composite
-- (tenant_id, x_id) foreign keys, set_updated_at() triggers.
--
-- BILLING NOTE (not built here): shisha_sessions.id is a stable, unique source id
-- for a future usage ledger (R5 per session in Rands). Decide before billing
-- whether the charge is on start or on completion, and whether a refill counts
-- as a new session.
--
-- PAYMENT NOTE: payment_method is free text recorded by staff ('cash', 'card').
-- Rands' 'vvip_tab' needs the wallet/tab engine, which Ndithini does not have yet.
--
-- NOTE: app/admin/page.tsx reads through the SERVICE-ROLE client, which
-- bypasses RLS. Every query and Server Action must still filter by tenant_id,
-- check tenant_has_module and re-check the permission. The policies below
-- protect browser-client / realtime access and are the second line of defence.
-- The Server Action that switches the module on must also check plan_modules.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Module registry, permissions, plan access
-- ---------------------------------------------------------------------
insert into public.modules (key, name, description)
select 'shisha', 'Shisha sessions',
       'Timed shisha/hookah sessions, devices, flavours and customer requests'
where not exists (select 1 from public.modules where key = 'shisha');

insert into public.permissions (key, module, description)
select v.key, 'shisha', v.description
from (values
  ('shisha.view',    'View shisha sessions, devices, flavours and requests'),
  ('shisha.operate', 'Run sessions: start, pause, refill, end; respond to requests'),
  ('shisha.manage',  'Manage flavours, devices, stations and shisha settings')
) as v(key, description)
where not exists (select 1 from public.permissions p where p.key = v.key);

-- DECISION: tenant_staff gets view + operate but NOT manage, so floor staff can
-- run sessions but cannot change prices or archive devices. Remove the two
-- tenant_staff rows below to keep staff out of shisha entirely. These grants
-- apply to every tenant's staff; the module gating in the policies (section 6)
-- is what stops tenants without the module from using them.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
  ('tenant_owner', 'shisha.view'),
  ('tenant_owner', 'shisha.operate'),
  ('tenant_owner', 'shisha.manage'),
  ('tenant_staff', 'shisha.view'),
  ('tenant_staff', 'shisha.operate')
) as g(role_key, perm_key)
join public.roles r       on r.key = g.role_key
join public.permissions p on p.key = g.perm_key
where not exists (
  select 1 from public.role_permissions rp
  where rp.role_id = r.id and rp.permission_id = p.id
);

-- DECISION: which plans unlock the module. Free is excluded.
-- (modules.path stays NULL: the admin renders shisha as a native tab in
-- AdminView, not through the iframe shell.)
insert into public.plan_modules (plan_key, module_id)
select pk.plan_key, m.id
from (values ('growth'), ('business')) as pk(plan_key)
cross join public.modules m
where m.key = 'shisha'
  and not exists (
    select 1 from public.plan_modules pm
    where pm.plan_key = pk.plan_key and pm.module_id = m.id
  );

-- ---------------------------------------------------------------------
-- 2. Shared-table change: allow composite FKs to tenant_customers
--    (harmless: id is already the primary key; instant at current size)
--    This is the ONLY change to a ZozoQueue table.
-- ---------------------------------------------------------------------
do $$
begin
  -- Detects ANY unique constraint on {id, tenant_id} (the menu_orders module
  -- adds one too), so applying both modules never creates a duplicate.
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.tenant_customers'::regclass
      and c.contype in ('u', 'p')
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k join pg_attribute a
             on a.attrelid = c.conrelid and a.attnum = k) = array['id', 'tenant_id']
  ) then
    alter table public.tenant_customers
      add constraint tenant_customers_tenant_id_id_key unique (tenant_id, id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------
create table public.shisha_settings (
  tenant_id                 uuid primary key references public.tenants(id) on delete cascade,
  coal_duration_minutes     integer not null default 60
                              check (coal_duration_minutes between 5 and 480),
  refill_threshold_minutes  integer not null default 15
                              check (refill_threshold_minutes between 1 and 120),
  updated_at                timestamptz not null default now(),
  constraint shisha_settings_threshold_lt_duration
    check (refill_threshold_minutes < coal_duration_minutes)
);
comment on table public.shisha_settings is
  'Per-tenant shisha timing. One row per tenant; the app falls back to 60/15 when the row is missing. Currency and timezone come from tenant_settings, not here.';

create table public.shisha_locations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  is_active    boolean not null default true,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint shisha_locations_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.shisha_locations is
  'Shisha stations (areas of the venue). is_active hides a station from customers; archived_at is the soft delete.';

create table public.shisha_products (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  price         numeric(10,2) not null default 0 check (price >= 0),
  is_available  boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint shisha_products_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.shisha_products is
  'Flavours. is_available = in/out of stock; archived_at is the soft delete (sessions keep pointing at archived flavours for history and analytics).';

create table public.shisha_devices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  device_code  text not null,
  device_name  text,
  location_id  uuid,
  status       text not null default 'available',
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint shisha_devices_status_check
    check (status in ('available', 'in_use', 'maintenance')),
  constraint shisha_devices_tenant_id_id_key unique (tenant_id, id),
  constraint shisha_devices_location_fk
    foreign key (tenant_id, location_id)
    references public.shisha_locations (tenant_id, id)
);
comment on table public.shisha_devices is
  'Physical hookahs. Staff-only (never customer-visible). status: available / in_use / maintenance. in_use is maintained by a trigger from live sessions; only maintenance is set by hand. archived_at replaces the old status = ''deleted''.';

create table public.shisha_sessions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  customer_id             uuid,            -- NULL = walk-in (replaces 'walkin_customer' phone)
  customer_phone          text,            -- snapshot, optional
  device_id               uuid,
  product_id              uuid,
  location_id             uuid,
  start_time              timestamptz not null default now(),
  last_refill_time        timestamptz not null default now(),
  remaining_time_seconds  integer not null default 3600,   -- app sets from shisha_settings
  total_amount            numeric(10,2) not null check (total_amount >= 0),
  refill_count            integer not null default 0,
  status                  text not null default 'active',
  paused                  boolean generated always as (status = 'paused') stored,
  ended_at                timestamptz,
  payment_method          text,            -- free text recorded by staff, e.g. 'cash', 'card'
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint shisha_sessions_status_check
    check (status in ('active', 'refill', 'paused', 'expired', 'completed')),
  constraint shisha_sessions_tenant_id_id_key unique (tenant_id, id),
  constraint shisha_sessions_customer_fk
    foreign key (tenant_id, customer_id)
    references public.tenant_customers (tenant_id, id),
  constraint shisha_sessions_device_fk
    foreign key (tenant_id, device_id)
    references public.shisha_devices (tenant_id, id),
  constraint shisha_sessions_product_fk
    foreign key (tenant_id, product_id)
    references public.shisha_products (tenant_id, id),
  constraint shisha_sessions_location_fk
    foreign key (tenant_id, location_id)
    references public.shisha_locations (tenant_id, id)
);
comment on table public.shisha_sessions is
  'Timed sessions. Live = active / refill / paused. completed = ended by staff, expired = timer ran out. Walk-ins have customer_id NULL. paused is generated from status: change status, never paused.';

create table public.shisha_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  request_type    text not null,
  session_id      uuid,
  customer_id     uuid,
  customer_phone  text,
  location_name   text,   -- denormalised snapshots, same as Rands
  flavour_name    text,
  device_code     text,
  amount          numeric(10,2),
  request_data    jsonb,
  status          text not null default 'pending',
  created_at      timestamptz not null default now(),
  responded_at    timestamptz,
  constraint shisha_requests_type_check
    check (request_type in ('order_session', 'maintenance', 'issue_report', 'end_session')),
  constraint shisha_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'completed')),
  constraint shisha_requests_session_fk
    foreign key (tenant_id, session_id)
    references public.shisha_sessions (tenant_id, id),
  constraint shisha_requests_customer_fk
    foreign key (tenant_id, customer_id)
    references public.tenant_customers (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- 4. Indexes (every tenant-scoped list query leads with tenant_id)
-- ---------------------------------------------------------------------
-- Uniqueness among non-archived rows only, so an archived name/code can be reused.
create unique index shisha_locations_tenant_name_uq
  on public.shisha_locations (tenant_id, lower(name)) where archived_at is null;
create unique index shisha_products_tenant_name_uq
  on public.shisha_products (tenant_id, lower(name)) where archived_at is null;
create unique index shisha_devices_tenant_code_uq
  on public.shisha_devices (tenant_id, device_code) where archived_at is null;

-- A device can only be in one live session at a time.
create unique index shisha_sessions_one_live_per_device
  on public.shisha_sessions (tenant_id, device_id)
  where device_id is not null and status in ('active', 'refill', 'paused');

create index shisha_devices_tenant_location_idx  on public.shisha_devices  (tenant_id, location_id);
create index shisha_sessions_tenant_status_idx   on public.shisha_sessions (tenant_id, status);
create index shisha_sessions_tenant_created_idx  on public.shisha_sessions (tenant_id, created_at desc);
create index shisha_sessions_tenant_device_idx   on public.shisha_sessions (tenant_id, device_id);
create index shisha_sessions_tenant_customer_idx on public.shisha_sessions (tenant_id, customer_id);
create index shisha_requests_tenant_status_idx   on public.shisha_requests (tenant_id, status, created_at desc);
create index shisha_requests_tenant_session_idx  on public.shisha_requests (tenant_id, session_id);

-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------
create trigger set_updated_at before update on public.shisha_settings
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.shisha_locations
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.shisha_products
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.shisha_devices
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.shisha_sessions
  for each row execute function public.set_updated_at();

-- Keeps shisha_devices.status in step with live sessions. Runs as the function
-- owner so floor staff (shisha.operate only) can start/end sessions without
-- needing write access to devices. 'maintenance' is never overwritten.
create or replace function public.shisha_sync_device_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := '{}';
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    if old.device_id is not null then
      v_ids := array_append(v_ids, old.device_id);
    end if;
  end if;
  if tg_op = 'INSERT' or tg_op = 'UPDATE' then
    if new.device_id is not null then
      v_ids := array_append(v_ids, new.device_id);
    end if;
  end if;

  if array_length(v_ids, 1) is null then
    return null;
  end if;

  update public.shisha_devices dv
     set status = case
           when exists (
             select 1 from public.shisha_sessions s
             where s.tenant_id = dv.tenant_id
               and s.device_id = dv.id
               and s.status in ('active', 'refill', 'paused')
           ) then 'in_use'
           else 'available'
         end
   where dv.id = any (v_ids)
     and dv.status <> 'maintenance';

  return null;
end;
$$;

-- Trigger functions are not meant to be called as API endpoints.
revoke all on function public.shisha_sync_device_status() from public, anon, authenticated;

create trigger shisha_sessions_sync_device
  after insert or update of status, device_id or delete on public.shisha_sessions
  for each row execute function public.shisha_sync_device_status();

-- ---------------------------------------------------------------------
-- 6. Row level security
--    Every policy requires the tenant to have the shisha module switched on
--    (tenant_has_module), except for platform admins.
--    Staff: shisha.view (read), shisha.operate (sessions/requests),
--    shisha.manage (everything).
--    Customers: their own sessions/requests, plus active stations and
--    in-stock flavours of tenants they belong to. Customer-created rows
--    (e.g. order_session requests) go through server actions using the
--    service-role client, like tenant_invites.
--    Column-level limits (e.g. operate may flip device status but not rename)
--    cannot be expressed in RLS; those go through service-role Server Actions.
-- ---------------------------------------------------------------------
alter table public.shisha_settings  enable row level security;
alter table public.shisha_locations enable row level security;
alter table public.shisha_products  enable row level security;
alter table public.shisha_devices   enable row level security;
alter table public.shisha_sessions  enable row level security;
alter table public.shisha_requests  enable row level security;

-- settings (staff only)
create policy shisha_settings_select on public.shisha_settings for select using (
  is_platform_admin()
  or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.view'))
);
create policy shisha_settings_write on public.shisha_settings for all
  using (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')))
  with check (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')));

-- stations
create policy shisha_locations_select on public.shisha_locations for select using (
  is_platform_admin()
  or (tenant_has_module(tenant_id, 'shisha') and (
        user_has_permission(tenant_id, 'shisha.view')
        or (is_active and archived_at is null and exists (
              select 1 from public.tenant_customers tc
              where tc.tenant_id = shisha_locations.tenant_id and tc.profile_id = auth.uid()))))
);
create policy shisha_locations_write on public.shisha_locations for all
  using (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')))
  with check (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')));

-- flavours
create policy shisha_products_select on public.shisha_products for select using (
  is_platform_admin()
  or (tenant_has_module(tenant_id, 'shisha') and (
        user_has_permission(tenant_id, 'shisha.view')
        or (is_available and archived_at is null and exists (
              select 1 from public.tenant_customers tc
              where tc.tenant_id = shisha_products.tenant_id and tc.profile_id = auth.uid()))))
);
create policy shisha_products_write on public.shisha_products for all
  using (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')))
  with check (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')));

-- devices (staff only)
create policy shisha_devices_select on public.shisha_devices for select using (
  is_platform_admin()
  or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.view'))
);
create policy shisha_devices_write on public.shisha_devices for all
  using (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')))
  with check (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and user_has_permission(tenant_id, 'shisha.manage')));

-- sessions
create policy shisha_sessions_select on public.shisha_sessions for select using (
  is_platform_admin()
  or (tenant_has_module(tenant_id, 'shisha') and (
        user_has_permission(tenant_id, 'shisha.view')
        or exists (
             select 1 from public.tenant_customers tc
             where tc.id = shisha_sessions.customer_id and tc.profile_id = auth.uid())))
);
create policy shisha_sessions_write on public.shisha_sessions for all
  using (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and (
          user_has_permission(tenant_id, 'shisha.operate')
          or user_has_permission(tenant_id, 'shisha.manage'))))
  with check (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and (
          user_has_permission(tenant_id, 'shisha.operate')
          or user_has_permission(tenant_id, 'shisha.manage'))));

-- requests
create policy shisha_requests_select on public.shisha_requests for select using (
  is_platform_admin()
  or (tenant_has_module(tenant_id, 'shisha') and (
        user_has_permission(tenant_id, 'shisha.view')
        or exists (
             select 1 from public.tenant_customers tc
             where tc.id = shisha_requests.customer_id and tc.profile_id = auth.uid())))
);
create policy shisha_requests_write on public.shisha_requests for all
  using (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and (
          user_has_permission(tenant_id, 'shisha.operate')
          or user_has_permission(tenant_id, 'shisha.manage'))))
  with check (
    is_platform_admin()
    or (tenant_has_module(tenant_id, 'shisha') and (
          user_has_permission(tenant_id, 'shisha.operate')
          or user_has_permission(tenant_id, 'shisha.manage'))));

-- ---------------------------------------------------------------------
-- 7. OPTIONAL - realtime (commented out)
--    supabase_realtime currently has no tables in Ndithini. Only enable this
--    if the admin will subscribe from a BROWSER Supabase client (RLS applies
--    there). If the shisha tab follows the same server-action refresh as the
--    rest of /admin, skip it. Always filter subscriptions by tenant_id.
-- ---------------------------------------------------------------------
-- alter publication supabase_realtime add table
--   public.shisha_sessions, public.shisha_requests, public.shisha_devices;

-- ---------------------------------------------------------------------
-- 8. OPTIONAL - WhatsApp notifications (commented out; shared-table changes)
--    The three Rands notification triggers are NOT ported (Ndithini has no
--    notification_queue). If you send from a Server Action instead:
--      * whatsapp_templates.key has a CHECK allowing only the 6 existing keys,
--        so shisha_ready / shisha_refilled / shisha_session_ended need it
--        widened first
--      * each tenant also needs its own Meta-approved template rows
--      * always resolve the customer by (tenant_id, phone), never phone alone
-- ---------------------------------------------------------------------
-- do $$
-- declare c text;
-- begin
--   select conname into c from pg_constraint
--   where conrelid = 'public.whatsapp_templates'::regclass
--     and contype = 'c' and pg_get_constraintdef(oid) ilike '%queue_joined%';
--   if c is not null then
--     execute format('alter table public.whatsapp_templates drop constraint %I', c);
--   end if;
--   alter table public.whatsapp_templates
--     add constraint whatsapp_templates_key_check check (key = any (array[
--       'queue_joined','queue_almost_turn','queue_called','booking_confirmation',
--       'booking_reminder','waitlist_slot_open',
--       'shisha_ready','shisha_refilled','shisha_session_ended']));
-- end $$;

commit;
