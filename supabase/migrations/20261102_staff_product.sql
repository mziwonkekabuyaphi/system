-- Staff Management as its own sellable product.
-- R30 per active staff member per month, billed only to shops that do NOT run
-- Booking, Queue or Shisha (those already include staff).
-- Safe to run more than once.

-- 1. The module row (the platform admin switches it per shop in /platform/modules).
insert into public.modules (key, name, description, icon, path, display_order)
select 'staff', 'Staff Management',
       'Staff list, roles, PIN/QR clock-in and attendance. Sold on its own per active staff member.',
       'users', '/admin', 20
where not exists (select 1 from public.modules where key = 'staff');

-- 2. Price per staff member: one platform default (tenant_id null) plus optional per-shop overrides.
create table if not exists public.staff_billing_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  staff_fee numeric not null default 30 check (staff_fee >= 0), -- rands per active staff member per month
  currency text not null default 'ZAR',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists staff_billing_rates_one_default
  on public.staff_billing_rates ((tenant_id is null)) where tenant_id is null and is_active;
create unique index if not exists staff_billing_rates_one_per_tenant
  on public.staff_billing_rates (tenant_id) where tenant_id is not null and is_active;

alter table public.staff_billing_rates enable row level security;
drop policy if exists staff_billing_rates_all on public.staff_billing_rates;
create policy staff_billing_rates_all on public.staff_billing_rates
  for all using (is_platform_admin());

insert into public.staff_billing_rates (tenant_id, staff_fee)
select null, 30
where not exists (select 1 from public.staff_billing_rates where tenant_id is null and is_active);

-- 3. Invoices may now be for the 'staff' product.
alter table public.tenant_invoices drop constraint if exists tenant_invoices_product_check;
alter table public.tenant_invoices
  add constraint tenant_invoices_product_check check (product in ('booking_queue', 'shisha', 'staff'));
