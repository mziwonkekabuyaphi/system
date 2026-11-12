-- Expire abandoned card checkouts, and let a LATE payment on an expired top-up still be credited.
-- Server only (service_role). Additive: no existing table or function is changed.
--
-- Why two pieces: wallet_complete_topup refuses a top-up that is no longer 'pending'. If we expire a
-- top-up and the customer then pays anyway, the webhook would fail and Yoco would retry for days with
-- the money taken and nothing credited. wallet_revive_topup lets the webhook put an EXPIRED top-up back
-- to pending first, so a late payment is credited normally.

-- 1) Expire.
--    'creating' = we never got a link back from Yoco (crashed before the customer saw anything): short grace.
--    'pending'  = the customer has a link and may still pay: long grace.
--    Ticket orders hold no stock while unpaid (tickets are issued only after a verified payment), so for
--    them expiring is only a status change. Top-ups also get their wallet_topups row marked 'expired'.
create or replace function public.payments_expire_abandoned(
  p_creating_after interval default interval '1 hour',
  p_pending_after  interval default interval '24 hours'
)
returns table(payments_expired integer, topups_expired integer)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_payments integer := 0;
  v_topups   integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;

  with gone as (
    update public.tenant_payments p
       set status = 'cancelled',
           metadata = p.metadata || jsonb_build_object('expired_at', now(), 'expired_from', p.status),
           updated_at = now()
     where (p.status = 'creating' and p.created_at < now() - p_creating_after)
        or (p.status = 'pending'  and p.created_at < now() - p_pending_after)
    returning p.id, p.purpose, p.purpose_id
  ), tu as (
    update public.wallet_topups t
       set status = 'expired'
      from gone
     where gone.purpose = 'wallet_topup' and t.id = gone.purpose_id and t.status = 'pending'
    returning t.id
  )
  select (select count(*) from gone)::integer, (select count(*) from tu)::integer
    into v_payments, v_topups;

  return query select v_payments, v_topups;
end
$function$;

-- 2) Revive an expired top-up when its payment turns out to have succeeded after all.
create or replace function public.wallet_revive_topup(p_topup_id uuid)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
declare v_n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;
  update public.wallet_topups set status = 'pending' where id = p_topup_id and status = 'expired';
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$function$;

revoke all on function public.payments_expire_abandoned(interval, interval) from public, anon, authenticated;
revoke all on function public.wallet_revive_topup(uuid)                     from public, anon, authenticated;
grant execute on function public.payments_expire_abandoned(interval, interval) to service_role;
grant execute on function public.wallet_revive_topup(uuid)                     to service_role;
