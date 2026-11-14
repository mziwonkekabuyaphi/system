-- Tenant AI: bring-your-own-key (BYOK) + usage metering
-- ---------------------------------------------------------------------------
-- Principle (same as WhatsApp): the tenant pays their AI provider directly,
-- QLess provides the software and tracks usage.
--
--   tenant_ai_settings   one row per tenant: mode, on/off, provider, model,
--                        pointer to the encrypted key (Supabase Vault), budget
--   ai_model_pricing     platform-managed price list used for cost estimates
--   ai_platform_settings single row: USD->ZAR rate for estimates
--   ai_usage_ledger      append-only: one row per AI request
--   ai_usage_monthly     rollup per tenant per (tenant-local) month; makes the
--                        budget check on the hot WhatsApp path a single lookup
--
-- Modes: 'byok' (tenant's own key) and 'managed' (QLess platform key, metered).
-- Existing tenants are grandfathered onto 'managed' so nothing switches off
-- when the app deploys; new tenants default to 'byok'.
--
-- The raw API key is only ever readable through ai_resolve_tenant(), which is
-- granted to service_role only. Browser/authenticated roles cannot select it.
-- ---------------------------------------------------------------------------

-- 1. Platform settings ------------------------------------------------------
create table public.ai_platform_settings (
  id            boolean primary key default true check (id),
  usd_to_zar    numeric(10,4) not null check (usd_to_zar > 0),
  fx_updated_at timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);
comment on table public.ai_platform_settings is
  'Single row. usd_to_zar converts provider USD prices into the ZAR cost estimates tenants see. Update it occasionally; it is an estimate, not an invoice.';
insert into public.ai_platform_settings (id, usd_to_zar) values (true, 16.80);

-- 2. Model pricing ----------------------------------------------------------
create table public.ai_model_pricing (
  provider          text          not null,
  model             text          not null,
  display_name      text          not null,
  input_usd_per_1m  numeric(12,4) not null check (input_usd_per_1m  >= 0),
  output_usd_per_1m numeric(12,4) not null check (output_usd_per_1m >= 0),
  is_active         boolean       not null default true,
  price_checked_on  date          not null,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  primary key (provider, model)
);
comment on table public.ai_model_pricing is
  'Provider list prices (USD per 1M tokens, standard tier, no cache discount, so estimates are an upper bound). A model must be listed here before a tenant can select it. Only add non-reasoning models until the gateway sets reasoning effort: reasoning tokens are billed as output and can exhaust small max-output limits.';

insert into public.ai_model_pricing (provider, model, display_name, input_usd_per_1m, output_usd_per_1m, price_checked_on) values
  ('openai', 'gpt-4o-mini',  'GPT-4o mini',  0.15, 0.60, date '2026-11-14'),
  ('openai', 'gpt-4.1-nano', 'GPT-4.1 nano', 0.10, 0.40, date '2026-11-14'),
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 0.40, 1.60, date '2026-11-14');

-- 3. Per-tenant settings ----------------------------------------------------
create table public.tenant_ai_settings (
  tenant_id         uuid primary key references public.tenants(id) on delete cascade,
  mode              text not null default 'byok' check (mode in ('byok', 'managed')),
  enabled           boolean not null default true,
  provider          text not null default 'openai',
  model             text not null default 'gpt-4o-mini',
  api_key_secret_id uuid,
  key_last4         text,
  key_status        text not null default 'none' check (key_status in ('none', 'active', 'invalid')),
  key_saved_at      timestamptz,
  monthly_limit_zar numeric(12,2) check (monthly_limit_zar is null or monthly_limit_zar >= 0),
  warn_at_percent   smallint not null default 80 check (warn_at_percent between 1 and 100),
  last_error        text,
  last_error_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (provider, model) references public.ai_model_pricing (provider, model)
);
comment on table public.tenant_ai_settings is
  'Per-tenant AI configuration. The API key lives in Supabase Vault (api_key_secret_id); only ai_resolve_tenant() (service_role) can read it. monthly_limit_zar NULL = no limit; AI is blocked once the month''s estimated spend reaches it.';
comment on column public.tenant_ai_settings.key_last4 is 'Last 4 characters of the key, for display only.';

-- 4. Usage ledger (append-only) ---------------------------------------------
create table public.ai_usage_ledger (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  provider           text not null,
  model              text not null,
  purpose            text not null,
  key_source         text not null check (key_source in ('byok', 'managed')),
  status             text not null default 'ok' check (status in ('ok', 'error')),
  error_code         text,
  input_tokens       integer not null default 0 check (input_tokens  >= 0),
  output_tokens      integer not null default 0 check (output_tokens >= 0),
  total_tokens       integer generated always as (input_tokens + output_tokens) stored,
  priced             boolean not null default true,
  estimated_cost_usd numeric(14,8) not null default 0,
  estimated_cost_zar numeric(14,6) not null default 0,
  fx_rate            numeric(10,4),
  latency_ms         integer,
  conversation_id    uuid references public.conversations(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index ai_usage_ledger_tenant_created_idx on public.ai_usage_ledger (tenant_id, created_at desc);
comment on table public.ai_usage_ledger is
  'One row per AI request. Stores token counts and estimated cost only, never prompts or replies. priced=false means the model was missing from ai_model_pricing, so cost is 0 but tokens are still counted.';

create function public.ai_usage_ledger_block_update() returns trigger
language plpgsql as $$
begin
  raise exception 'ai_usage_ledger is append-only' using errcode = '42501';
end $$;
create trigger trg_ai_usage_ledger_no_update
  before update on public.ai_usage_ledger
  for each row execute function public.ai_usage_ledger_block_update();

-- 5. Monthly rollup ----------------------------------------------------------
create table public.ai_usage_monthly (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  period_start  date not null,
  requests      integer not null default 0,
  errors        integer not null default 0,
  input_tokens  bigint  not null default 0,
  output_tokens bigint  not null default 0,
  cost_usd      numeric(14,8) not null default 0,
  cost_zar      numeric(14,6) not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, period_start)
);
comment on table public.ai_usage_monthly is
  'Maintained only by ai_record_usage(). period_start is the first day of the month in the tenant''s own timezone (tenant_settings.timezone).';

-- updated_at helper
create function public.ai_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger trg_tenant_ai_settings_updated_at before update on public.tenant_ai_settings
  for each row execute function public.ai_set_updated_at();
create trigger trg_ai_model_pricing_updated_at before update on public.ai_model_pricing
  for each row execute function public.ai_set_updated_at();

-- 6. RLS + grants -------------------------------------------------------------
alter table public.ai_platform_settings enable row level security;
alter table public.ai_model_pricing     enable row level security;
alter table public.tenant_ai_settings   enable row level security;
alter table public.ai_usage_ledger      enable row level security;
alter table public.ai_usage_monthly     enable row level security;

revoke all on public.ai_platform_settings, public.ai_model_pricing, public.tenant_ai_settings,
              public.ai_usage_ledger, public.ai_usage_monthly from anon, authenticated;

-- platform settings: platform admins only
grant select, update on public.ai_platform_settings to authenticated;
create policy ai_platform_settings_select on public.ai_platform_settings
  for select using (public.is_platform_admin());
create policy ai_platform_settings_update on public.ai_platform_settings
  for update using (public.is_platform_admin()) with check (public.is_platform_admin());

-- pricing: any signed-in user can read active models (for the model picker); platform admins manage
grant select, insert, update on public.ai_model_pricing to authenticated;
create policy ai_model_pricing_select on public.ai_model_pricing
  for select to authenticated using (is_active or public.is_platform_admin());
create policy ai_model_pricing_insert on public.ai_model_pricing
  for insert to authenticated with check (public.is_platform_admin());
create policy ai_model_pricing_update on public.ai_model_pricing
  for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- tenant settings: column-level. The key pointer, mode and provider can never be read or written by a browser session.
grant select (tenant_id, mode, enabled, provider, model, key_last4, key_status, key_saved_at,
              monthly_limit_zar, warn_at_percent, last_error, last_error_at, updated_at)
  on public.tenant_ai_settings to authenticated;
grant update (enabled, model, monthly_limit_zar, warn_at_percent)
  on public.tenant_ai_settings to authenticated;
create policy tenant_ai_settings_select on public.tenant_ai_settings
  for select using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'settings.manage'));
create policy tenant_ai_settings_update on public.tenant_ai_settings
  for update using (public.is_platform_admin() or public.user_has_permission(tenant_id, 'settings.manage'))
  with check (public.is_platform_admin() or public.user_has_permission(tenant_id, 'settings.manage'));

-- usage: read-only for owners / billing viewers
grant select on public.ai_usage_ledger, public.ai_usage_monthly to authenticated;
create policy ai_usage_ledger_select on public.ai_usage_ledger
  for select using (
    public.is_platform_admin()
    or public.user_has_permission(tenant_id, 'billing.view')
    or public.user_has_permission(tenant_id, 'settings.manage'));
create policy ai_usage_monthly_select on public.ai_usage_monthly
  for select using (
    public.is_platform_admin()
    or public.user_has_permission(tenant_id, 'billing.view')
    or public.user_has_permission(tenant_id, 'settings.manage'));

-- 7. Functions ------------------------------------------------------------------

-- First day of the tenant's current month, in the tenant's own timezone.
create function public.ai_period_start(p_tenant_id uuid) returns date
language plpgsql stable security definer set search_path = public as $$
declare v_tz text;
begin
  select timezone into v_tz from public.tenant_settings where tenant_id = p_tenant_id;
  begin
    return date_trunc('month', now() at time zone coalesce(v_tz, 'UTC'))::date;
  exception when others then
    return date_trunc('month', now() at time zone 'UTC')::date;
  end;
end $$;

-- Stores/replaces the tenant's own key in Vault and switches the tenant to BYOK.
-- Caller (a server action using the service role) must have already checked settings.manage.
create function public.ai_save_tenant_key(p_tenant_id uuid, p_api_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := 'ai_key_' || p_tenant_id::text;
  v_key  text := btrim(p_api_key);
  v_id   uuid;
begin
  if v_key is null or length(v_key) < 20 or length(v_key) > 400 or v_key ~ '\s' then
    raise exception 'invalid_api_key_format' using errcode = '22023';
  end if;
  perform 1 from public.tenant_ai_settings where tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'tenant_not_found' using errcode = '22023';
  end if;

  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    v_id := vault.create_secret(v_key, v_name, 'Tenant AI provider API key');
  else
    perform vault.update_secret(v_id, v_key, v_name, 'Tenant AI provider API key');
  end if;

  update public.tenant_ai_settings
     set api_key_secret_id = v_id,
         key_last4         = right(v_key, 4),
         key_status        = 'active',
         key_saved_at      = now(),
         last_error        = null,
         last_error_at     = null,
         mode              = 'byok'
   where tenant_id = p_tenant_id;
end $$;

-- Deletes the tenant's key from Vault.
create function public.ai_remove_tenant_key(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select api_key_secret_id into v_id from public.tenant_ai_settings where tenant_id = p_tenant_id for update;
  if v_id is not null then
    delete from vault.secrets where id = v_id;
  end if;
  update public.tenant_ai_settings
     set api_key_secret_id = null, key_last4 = null, key_status = 'none', key_saved_at = null
   where tenant_id = p_tenant_id;
end $$;

-- The one call the AI gateway makes before every AI request. Always returns exactly one row.
-- blocked_reason IS NULL means the request may proceed; api_key is NULL for managed mode
-- (caller uses the platform key) and whenever the request is blocked.
create function public.ai_resolve_tenant(p_tenant_id uuid)
returns table (
  provider text, model text, api_key text, key_source text,
  blocked_reason text, spent_zar numeric, limit_zar numeric, percent_used numeric
)
language plpgsql security definer set search_path = public as $$
declare
  s        public.tenant_ai_settings%rowtype;
  v_spent  numeric;
  v_key    text;
  v_reason text;
begin
  select * into s from public.tenant_ai_settings where tenant_id = p_tenant_id;
  if not found then
    return query select null::text, null::text, null::text, null::text,
                        'not_configured'::text, 0::numeric, null::numeric, null::numeric;
    return;
  end if;

  select m.cost_zar into v_spent from public.ai_usage_monthly m
   where m.tenant_id = p_tenant_id and m.period_start = public.ai_period_start(p_tenant_id);
  v_spent := coalesce(v_spent, 0);

  perform 1 from public.tenants t where t.id = p_tenant_id and t.status = 'active';
  if not found then
    v_reason := 'tenant_inactive';
  elsif not s.enabled then
    v_reason := 'disabled';
  elsif s.mode = 'byok' then
    if s.key_status = 'invalid' then
      v_reason := 'key_invalid';
    elsif s.api_key_secret_id is null then
      v_reason := 'no_key';
    else
      select ds.decrypted_secret into v_key from vault.decrypted_secrets ds where ds.id = s.api_key_secret_id;
      if v_key is null then v_reason := 'no_key'; end if;
    end if;
  end if;

  if v_reason is null and s.monthly_limit_zar is not null and v_spent >= s.monthly_limit_zar then
    v_reason := 'budget_exceeded';
  end if;

  return query select
    s.provider,
    s.model,
    case when v_reason is null and s.mode = 'byok' then v_key else null end,
    s.mode,
    v_reason,
    v_spent,
    s.monthly_limit_zar,
    case when s.monthly_limit_zar is null or s.monthly_limit_zar = 0 then null
         else round(v_spent / s.monthly_limit_zar * 100, 2) end;
end $$;

-- Records one AI request (success or failure) against the tenant: ledger row, monthly rollup,
-- and, for failures, last_error (with key-like strings redacted). An invalid_api_key failure on a
-- BYOK tenant marks the key invalid so we stop calling the provider until they fix it.
create function public.ai_record_usage(
  p_tenant_id       uuid,
  p_provider        text,
  p_model           text,
  p_purpose         text,
  p_key_source      text,
  p_status          text    default 'ok',
  p_error_code      text    default null,
  p_error_message   text    default null,
  p_input_tokens    integer default 0,
  p_output_tokens   integer default 0,
  p_latency_ms      integer default null,
  p_conversation_id uuid    default null
)
returns table (estimated_cost_zar numeric, month_spent_zar numeric, limit_zar numeric, percent_used numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_in     integer := greatest(coalesce(p_input_tokens, 0), 0);
  v_out    integer := greatest(coalesce(p_output_tokens, 0), 0);
  v_fx     numeric;
  v_in_p   numeric;
  v_out_p  numeric;
  v_priced boolean := false;
  v_usd    numeric := 0;
  v_zar    numeric := 0;
  v_period date;
  v_spent  numeric;
  v_limit  numeric;
  v_msg    text;
begin
  if p_status not in ('ok', 'error') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_key_source not in ('byok', 'managed') then
    raise exception 'invalid_key_source' using errcode = '22023';
  end if;

  select usd_to_zar into v_fx from public.ai_platform_settings where id;
  select pr.input_usd_per_1m, pr.output_usd_per_1m into v_in_p, v_out_p
    from public.ai_model_pricing pr where pr.provider = p_provider and pr.model = p_model;
  if found then
    v_priced := true;
    v_usd := (v_in * v_in_p + v_out * v_out_p) / 1000000.0;
    v_zar := v_usd * coalesce(v_fx, 0);
  end if;

  insert into public.ai_usage_ledger
    (tenant_id, provider, model, purpose, key_source, status, error_code,
     input_tokens, output_tokens, priced, estimated_cost_usd, estimated_cost_zar, fx_rate,
     latency_ms, conversation_id)
  values
    (p_tenant_id, p_provider, p_model, p_purpose, p_key_source, p_status, left(p_error_code, 60),
     v_in, v_out, v_priced, v_usd, v_zar, v_fx, p_latency_ms, p_conversation_id);

  v_period := public.ai_period_start(p_tenant_id);
  insert into public.ai_usage_monthly as m
    (tenant_id, period_start, requests, errors, input_tokens, output_tokens, cost_usd, cost_zar)
  values
    (p_tenant_id, v_period, 1, case when p_status = 'error' then 1 else 0 end, v_in, v_out, v_usd, v_zar)
  on conflict (tenant_id, period_start) do update set
    requests      = m.requests + 1,
    errors        = m.errors + excluded.errors,
    input_tokens  = m.input_tokens + excluded.input_tokens,
    output_tokens = m.output_tokens + excluded.output_tokens,
    cost_usd      = m.cost_usd + excluded.cost_usd,
    cost_zar      = m.cost_zar + excluded.cost_zar,
    updated_at    = now()
  returning m.cost_zar into v_spent;

  if p_status = 'error' then
    v_msg := coalesce(p_error_message, '');
    v_msg := regexp_replace(v_msg, 'sk-[A-Za-z0-9_\-\*\.]+', 'sk-***', 'g');
    v_msg := regexp_replace(v_msg, '[A-Za-z0-9_\-]{32,}', '***', 'g');
    v_msg := left(v_msg, 200);
    update public.tenant_ai_settings
       set last_error    = nullif(v_msg, ''),
           last_error_at = now(),
           key_status    = case when p_error_code = 'invalid_api_key' and p_key_source = 'byok' and mode = 'byok'
                                then 'invalid' else key_status end
     where tenant_id = p_tenant_id;
  end if;

  select s.monthly_limit_zar into v_limit from public.tenant_ai_settings s where s.tenant_id = p_tenant_id;

  return query select
    v_zar,
    v_spent,
    v_limit,
    case when v_limit is null or v_limit = 0 then null else round(v_spent / v_limit * 100, 2) end;
end $$;

-- Dashboard breakdown. SECURITY INVOKER: row-level security decides who sees what.
create function public.ai_usage_breakdown(p_tenant_id uuid, p_days integer default 30)
returns table (
  purpose text, model text, requests bigint, errors bigint,
  input_tokens bigint, output_tokens bigint, cost_zar numeric
)
language sql stable security invoker set search_path = public as $$
  select l.purpose, l.model, count(*), count(*) filter (where l.status = 'error'),
         sum(l.input_tokens)::bigint, sum(l.output_tokens)::bigint, sum(l.estimated_cost_zar)
    from public.ai_usage_ledger l
   where l.tenant_id = p_tenant_id
     and l.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)))
   group by l.purpose, l.model
   order by sum(l.estimated_cost_zar) desc, count(*) desc;
$$;

-- 8. New tenants get a settings row (BYOK by default); existing tenants are grandfathered ----
create function public.trg_provision_tenant_ai_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.tenant_ai_settings (tenant_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger trg_tenants_provision_ai_settings
  after insert on public.tenants
  for each row execute function public.trg_provision_tenant_ai_settings();

insert into public.tenant_ai_settings (tenant_id, mode)
  select id, 'managed' from public.tenants
  on conflict do nothing;

-- 9. Function privileges: service_role only (matches the WhatsApp secret functions) -----------
revoke all on function public.ai_period_start(uuid)                        from public, anon, authenticated;
revoke all on function public.ai_save_tenant_key(uuid, text)               from public, anon, authenticated;
revoke all on function public.ai_remove_tenant_key(uuid)                   from public, anon, authenticated;
revoke all on function public.ai_resolve_tenant(uuid)                      from public, anon, authenticated;
revoke all on function public.ai_record_usage(uuid, text, text, text, text, text, text, text, integer, integer, integer, uuid)
                                                                           from public, anon, authenticated;
revoke all on function public.trg_provision_tenant_ai_settings()           from public, anon, authenticated;
revoke all on function public.ai_usage_ledger_block_update()               from public, anon, authenticated;
revoke all on function public.ai_set_updated_at()                          from public, anon, authenticated;
revoke all on function public.ai_usage_breakdown(uuid, integer)            from public, anon;

grant execute on function public.ai_period_start(uuid)                     to service_role;
grant execute on function public.ai_save_tenant_key(uuid, text)            to service_role;
grant execute on function public.ai_remove_tenant_key(uuid)                to service_role;
grant execute on function public.ai_resolve_tenant(uuid)                   to service_role;
grant execute on function public.ai_record_usage(uuid, text, text, text, text, text, text, text, integer, integer, integer, uuid)
                                                                           to service_role;
grant execute on function public.ai_usage_breakdown(uuid, integer)         to authenticated, service_role;
