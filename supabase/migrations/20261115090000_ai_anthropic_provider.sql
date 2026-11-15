-- Claude (Anthropic) as a second AI provider.
--
-- 1. Model prices (USD per 1M tokens, standard tier, prompts up to 100K tokens; Haiku 5.5 is 5x above
--    100K, which WhatsApp prompts never reach). Checked against platform.claude.com pricing on 2026-11-15.
--    These models think by default; the gateway now sets effort "low" and a token floor for Claude, so
--    they are safe to list even though the table note says "non-reasoning only".
-- 2. ai_save_tenant_key can switch the shop's provider + model in the same transaction as the key, so a
--    key is never stored against the wrong vendor.

insert into public.ai_model_pricing (provider, model, display_name, input_usd_per_1m, output_usd_per_1m, price_checked_on) values
  ('anthropic', 'claude-haiku-5-5',  'Claude Haiku 5.5',  0.10,  0.50, date '2026-11-15'),
  ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 2.00, 10.00, date '2026-11-15')
on conflict (provider, model) do nothing;

drop function if exists public.ai_save_tenant_key(uuid, text);

create function public.ai_save_tenant_key(
  p_tenant_id uuid,
  p_api_key   text,
  p_provider  text default null,
  p_model     text default null
) returns void
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

  -- Switching vendor: provider and model must be given together and must be a listed, active model.
  if p_provider is not null then
    if p_model is null or not exists (
      select 1 from public.ai_model_pricing
       where provider = p_provider and model = p_model and is_active
    ) then
      raise exception 'unknown_model' using errcode = '22023';
    end if;
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
         mode              = 'byok',
         provider          = coalesce(p_provider, provider),
         model             = case when p_provider is null then model else p_model end
   where tenant_id = p_tenant_id;
end $$;

revoke all on function public.ai_save_tenant_key(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ai_save_tenant_key(uuid, text, text, text) to service_role;
