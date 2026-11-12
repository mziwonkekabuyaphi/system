-- ============================================================================
-- PROPOSED — NOT APPLIED. Review, then run (Supabase SQL editor or a migration).
-- Tenant-owned payment gateways ("bring your own gateway"), Yoco first.
-- ============================================================================
-- Design in one paragraph
--   Each shop connects ITS OWN Yoco account. Its secret key and webhook secret live in Supabase
--   Vault (same pattern as tenant_whatsapp_integrations); the tables below hold only secret IDS,
--   never secrets. Only the server (service_role) can read a secret back. Customers pay on Yoco's
--   hosted checkout, so money goes straight to the shop's Yoco account and card details never
--   touch this platform. A signed Yoco webhook credits the Passport through the EXISTING
--   wallet_complete_topup (idempotent, service_role only).
--
-- Everything here is additive. It does not change any existing table or function.
--
-- Not verified from here (run once in a transaction you roll back, or on a test shop):
--   * the `delete from vault.secrets` in payments_disconnect (depends on your Vault version/grants)
--   * wallet_topups.created_by accepting NULL (the bot has no signed-in user)
-- ============================================================================

-- 1) Gateway connection per shop ---------------------------------------------
create table if not exists public.tenant_payment_integrations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  provider             text not null check (provider in ('yoco')),
  status               text not null default 'pending' check (status in ('pending','active','disabled','error')),
  mode                 text check (mode in ('test','live')),
  key_hint             text,                 -- last 4 characters of the secret key, for display only
  secret_key_secret_id uuid,                 -- vault.secrets.id
  webhook_secret_id    uuid,                 -- vault.secrets.id
  provider_webhook_id  text,
  last_error           text,
  last_error_at        timestamptz,
  last_event_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, provider)
);

-- 2) One row per attempt to collect money -------------------------------------
create table if not exists public.tenant_payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  integration_id      uuid not null references public.tenant_payment_integrations(id) on delete restrict,
  provider            text not null,
  purpose             text not null check (purpose in ('wallet_topup')),
  purpose_id          uuid not null,                       -- e.g. wallet_topups.id
  amount              numeric(12,2) not null check (amount > 0),
  currency            text not null default 'ZAR',
  status              text not null default 'creating' check (status in ('creating','pending','succeeded','failed','cancelled')),
  provider_checkout_id text,
  provider_payment_id  text,
  checkout_url        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  unique (purpose, purpose_id)
);
create unique index if not exists tenant_payments_checkout_uniq
  on public.tenant_payments (provider, provider_checkout_id) where provider_checkout_id is not null;
create index if not exists tenant_payments_integration_idx on public.tenant_payments (integration_id);

-- 3) Webhook de-duplication (Yoco retries; the same webhook-id must only ever act once) ----
create table if not exists public.payment_webhook_events (
  provider       text not null,
  webhook_id     text not null,
  integration_id uuid,
  event_type     text,
  outcome        text,
  received_at    timestamptz not null default now(),
  primary key (provider, webhook_id)
);

-- 4) Row-level security: shop managers can SEE their gateway status; nobody can write from a browser ----
alter table public.tenant_payment_integrations enable row level security;
alter table public.tenant_payments            enable row level security;
alter table public.payment_webhook_events     enable row level security;

drop policy if exists tenant_payment_integrations_select on public.tenant_payment_integrations;
create policy tenant_payment_integrations_select on public.tenant_payment_integrations
  for select to authenticated
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'settings.manage'));

drop policy if exists tenant_payments_select on public.tenant_payments;
create policy tenant_payments_select on public.tenant_payments
  for select to authenticated
  using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'settings.manage'));
-- No insert/update/delete policies on any of the three: only the server (service_role) writes.
-- payment_webhook_events has no policies at all: service_role only.

-- 5) Vault helpers (server only) ------------------------------------------------
create or replace function public.payments_vault_put_secret(p_name text, p_secret text, p_description text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if p_name is null or p_name !~
     '^payments_(yoco_key|yoco_whsec)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_secret_name' using errcode = '22023';
  end if;
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'secret_empty' using errcode = '22023';
  end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    v_id := vault.create_secret(p_secret, p_name, coalesce(p_description, ''));
  else
    perform vault.update_secret(v_id, p_secret, p_name, coalesce(p_description, ''));
  end if;
  return v_id;
end $function$;

-- Used by the bot when it creates a checkout: the shop's active secret key.
create or replace function public.get_tenant_payment_credentials(p_tenant_id uuid, p_provider text default 'yoco')
returns table(integration_id uuid, mode text, secret_key text)
language sql security definer set search_path to 'public'
as $function$
  select tpi.id, tpi.mode, vs.decrypted_secret
  from public.tenant_payment_integrations tpi
  join vault.decrypted_secrets vs on vs.id = tpi.secret_key_secret_id
  where tpi.tenant_id = p_tenant_id and tpi.provider = p_provider and tpi.status = 'active'
  limit 1;
$function$;

-- Used by the webhook: look the shop up from the integration id in the URL, with its webhook secret.
create or replace function public.get_payment_integration_credentials(p_integration_id uuid)
returns table(tenant_id uuid, provider text, mode text, webhook_secret text)
language sql security definer set search_path to 'public'
as $function$
  select tpi.tenant_id, tpi.provider, tpi.mode, vs.decrypted_secret
  from public.tenant_payment_integrations tpi
  join vault.decrypted_secrets vs on vs.id = tpi.webhook_secret_id
  where tpi.id = p_integration_id and tpi.status = 'active'
  limit 1;
$function$;

-- Disconnect: remove the stored secrets and switch the integration off.
create or replace function public.payments_disconnect(p_integration_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.tenant_payment_integrations;
begin
  select * into v_row from public.tenant_payment_integrations where id = p_integration_id for update;
  if not found then return; end if;
  update public.tenant_payment_integrations
     set status = 'disabled', mode = null, key_hint = null,
         secret_key_secret_id = null, webhook_secret_id = null, provider_webhook_id = null,
         updated_at = now()
   where id = p_integration_id;
  delete from vault.secrets where id in (v_row.secret_key_secret_id, v_row.webhook_secret_id);
end $function$;

-- 6) Top-up creation for the WhatsApp bot (service_role twin of wallet_create_topup) -------------
-- wallet_create_topup / wallet_get_or_create both require a signed-in customer (auth.uid()), which the
-- bot does not have. Same rules as wallet_create_topup, minus the login, plus the max_balance check.
create or replace function public.wallet_create_topup_whatsapp(
  p_tenant_id   uuid,
  p_customer_id uuid,
  p_amount      numeric,
  p_provider    text default 'yoco'
)
returns public.wallet_topups
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_cust   public.tenant_customers;
  v_set    public.wallet_settings;
  v_wallet public.wallets;
  v_row    public.wallet_topups;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;
  if not public.tenant_has_module(p_tenant_id, 'wallet') then
    raise exception 'Wallet is not enabled for this venue';
  end if;

  select * into v_cust from public.tenant_customers
  where id = p_customer_id and tenant_id = p_tenant_id and status = 'active';
  if not found then raise exception 'Customer not found'; end if;

  insert into public.wallet_settings (tenant_id) values (p_tenant_id) on conflict do nothing;
  select * into v_set from public.wallet_settings where tenant_id = p_tenant_id;
  if not v_set.allow_customer_topup then
    raise exception 'Online top-ups are not enabled for this venue';
  end if;

  p_amount := round(p_amount, 2);
  if p_amount < v_set.min_topup or p_amount > v_set.max_topup then
    raise exception 'Top-up must be between % and %', v_set.min_topup, v_set.max_topup;
  end if;

  insert into public.wallets (tenant_id, customer_id, currency)
  values (p_tenant_id, v_cust.id, coalesce(v_set.currency, 'ZAR'))
  on conflict (tenant_id, customer_id) do nothing;
  select * into v_wallet from public.wallets where tenant_id = p_tenant_id and customer_id = v_cust.id;

  if v_wallet.status <> 'active' then
    raise exception '%', coalesce(v_wallet.block_reason, 'Wallet is ' || v_wallet.status);
  end if;
  if v_set.max_balance is not null and v_wallet.balance + p_amount > v_set.max_balance then
    raise exception 'That would take the Passport over its balance limit';
  end if;

  insert into public.wallet_topups (tenant_id, wallet_id, amount, status, provider, created_by)
  values (p_tenant_id, v_wallet.id, p_amount, 'pending', p_provider, null)
  returning * into v_row;
  return v_row;
end
$function$;

-- 7) Server-only access ---------------------------------------------------------
revoke all on function public.payments_vault_put_secret(text, text, text)               from public, anon, authenticated;
revoke all on function public.get_tenant_payment_credentials(uuid, text)                from public, anon, authenticated;
revoke all on function public.get_payment_integration_credentials(uuid)                 from public, anon, authenticated;
revoke all on function public.payments_disconnect(uuid)                                 from public, anon, authenticated;
revoke all on function public.wallet_create_topup_whatsapp(uuid, uuid, numeric, text)   from public, anon, authenticated;
grant execute on function public.payments_vault_put_secret(text, text, text)            to service_role;
grant execute on function public.get_tenant_payment_credentials(uuid, text)             to service_role;
grant execute on function public.get_payment_integration_credentials(uuid)              to service_role;
grant execute on function public.payments_disconnect(uuid)                              to service_role;
grant execute on function public.wallet_create_topup_whatsapp(uuid, uuid, numeric, text) to service_role;
