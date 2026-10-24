-- =====================================================================
-- Ndithini Platform  |  Shisha module  |  002 backfill  (DRAFT v3 - NOT APPLIED)
-- Run AFTER 001_shisha_module_schema.sql (v3).
--
-- Data read from Rands on 2026-10-23:
--   5 locations, 3 flavours, 32 devices, 1 request, 0 sessions.
-- Original UUIDs are preserved for locations, flavours and the request.
--
-- BEFORE RUNNING
--   1. Create the Rands tenant in Ndithini first (it has only
--      "Mziwonke Spa & Salon" and "Testing Venue" today).
--   2. Put it on the growth or business plan (the module is not in Free).
--   3. Replace <RANDS_TENANT_ID> below. The script fails fast if you forget.
--
-- v3 changes vs v2
--   * Device statuses are the real ones: all 'available' except SH - 02
--     ('maintenance'). SH - 01 was stuck at in_use with 0 sessions, so it is
--     imported as 'available'. Nothing is 'in_use' (the 001 trigger owns that).
--   * Test devices HOOKAH and RANDS are skipped by default
--     (v_include_test_devices = false) => expected counts 5 / 3 / 30 / 1.
--     Set it to true to import all 32.
--   * Refuses to run twice for the same tenant.
--   * Warns if the tenant's plan does not include the module.
--   * Module enable uses ON CONFLICT DO UPDATE so a disabled row gets enabled.
--   * Verification counts at the bottom.
--
-- NOTES
--   A. Customer link: the pending request's Rands profile (27635713652) has
--      no tenant_customers row in Ndithini yet, so customer_id stays NULL;
--      the phone and accountId are kept in the row.
--   B. Payment method 'vvip_tab' needs the wallet/tab engine (not built).
-- =====================================================================

begin;

do $$
declare
  v_tenant_txt           text    := '<RANDS_TENANT_ID>';  -- replace with the tenant uuid
  v_tenant               uuid;
  v_include_test_devices boolean := false;
  v_module               uuid;
  v_plan                 text;
begin
  if v_tenant_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Replace <RANDS_TENANT_ID> with the Rands tenant uuid before running (got: %)', v_tenant_txt;
  end if;
  v_tenant := v_tenant_txt::uuid;

  if not exists (select 1 from public.tenants where id = v_tenant) then
    raise exception 'Tenant % does not exist in Ndithini', v_tenant;
  end if;

  if exists (select 1 from public.shisha_locations where tenant_id = v_tenant)
     or exists (select 1 from public.shisha_products  where tenant_id = v_tenant)
     or exists (select 1 from public.shisha_devices   where tenant_id = v_tenant)
     or exists (select 1 from public.shisha_requests  where tenant_id = v_tenant) then
    raise exception 'Tenant % already has shisha data; refusing to backfill twice', v_tenant;
  end if;

  select id into v_module from public.modules where key = 'shisha';
  if v_module is null then
    raise exception 'Module "shisha" not found; run 001 first';
  end if;

  -- Plan check (warning only; adjust if your plan column is named differently).
  select plan into v_plan from public.tenants where id = v_tenant;
  if v_plan is null or not exists (
       select 1 from public.plan_modules pm
       where pm.plan_key = v_plan and pm.module_id = v_module) then
    raise warning 'Tenant plan "%" does not include the shisha module; tenant_has_module may still return false', v_plan;
  end if;

  -- Locations
  insert into public.shisha_locations (id, tenant_id, name, is_active) values
    ('943484d5-ecc8-41a3-a610-bea53f0c722b', v_tenant, 'Post Office',      true),
    ('d87c21e0-2c45-4866-ac41-9b935ef49e71', v_tenant, 'Mshayi''s Corner', true),
    ('e081e300-5855-4292-a2a9-39d7109c975d', v_tenant, 'VIP South',        true),
    ('994e5a7f-ffce-40f6-b140-1f2c5f026f8d', v_tenant, 'Rands',            true),
    ('e09b9d38-644f-4ba6-971c-7957a74da37b', v_tenant, 'Shisha Lounge',    true);

  -- Flavours
  insert into public.shisha_products (id, tenant_id, name, price, is_available) values
    ('15913c6f-b683-4875-a6a5-ccb10b6deef7', v_tenant, 'Mzi Mint',    265, true),
    ('3c7cc399-659a-4a4b-8f09-073e256fb0b7', v_tenant, 'Lady Killer', 250, true),
    ('3c69554b-da4e-4ce8-a691-948af232ae4b', v_tenant, 'Shisha',      263, true);

  -- Devices (location_id was NULL in Rands for all; kept as-is).
  -- Test devices HOOKAH and RANDS are skipped unless v_include_test_devices.
  insert into public.shisha_devices (tenant_id, device_code, status)
  select v_tenant, code, status from (
    select 'HOOKAH'::text as code, 'available'::text as status, true as is_test
    union all select 'RANDS', 'available', true
    union all select 'SH - ' || lpad(n::text, 2, '0'),
                     case when n = 2 then 'maintenance' else 'available' end,
                     false
              from generate_series(1, 30) as n
  ) d
  where v_include_test_devices or not d.is_test;

  -- The single pending request (customer_id NULL, see note A).
  insert into public.shisha_requests
    (id, tenant_id, request_type, location_name, flavour_name, amount,
     customer_phone, request_data, status, created_at)
  values
    ('2dab1271-ca37-4baa-86a4-894c01157f87', v_tenant, 'order_session',
     'Rands', 'Lady Killer', 250, '27635713652',
     '{"accountId":"09372a97-df69-4b91-999c-8e9a4092fd50","paymentMethod":"vvip_tab"}'::jsonb,
     'pending', '2026-09-07 11:49:37.213966+00');

  -- Turn the module on for this tenant.
  insert into public.tenant_modules (tenant_id, module_id, enabled, enabled_at)
  values (v_tenant, v_module, true, now())
  on conflict (tenant_id, module_id) do update set enabled = true;
end $$;

commit;

-- ---------------------------------------------------------------------
-- Verify (replace the id). Expected: locations 5, products 3, devices 30
-- (32 if test devices included), requests 1, maintenance 1, in_use 0.
-- ---------------------------------------------------------------------
-- select
--   (select count(*) from public.shisha_locations where tenant_id = '<RANDS_TENANT_ID>') as locations,
--   (select count(*) from public.shisha_products  where tenant_id = '<RANDS_TENANT_ID>') as products,
--   (select count(*) from public.shisha_devices   where tenant_id = '<RANDS_TENANT_ID>') as devices,
--   (select count(*) from public.shisha_devices   where tenant_id = '<RANDS_TENANT_ID>' and status = 'maintenance') as maintenance,
--   (select count(*) from public.shisha_devices   where tenant_id = '<RANDS_TENANT_ID>' and status = 'in_use') as in_use,
--   (select count(*) from public.shisha_requests  where tenant_id = '<RANDS_TENANT_ID>') as requests;
