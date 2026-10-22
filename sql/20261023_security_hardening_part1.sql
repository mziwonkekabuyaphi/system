-- ============================================================================
-- Security hardening, PART 1 (QLess Systems / Ndithini platform)
-- Branch: fix/security-hardening        Date: 2026-10-23
--
-- What this does (nothing here changes how the app behaves for real users):
--   1. Trigger-only functions can no longer be called over the public API.
--   2. Functions that already require a logged-in user stop being callable
--      by logged-out visitors.
--   3. The two queue-notification triggers are switched to run with the
--      table owner's rights, so locking down notify_queue_entry cannot
--      break inserts or status changes.
--   4. notify_queue_entry and promote_bookings_to_queue become server-only
--      (the cron job runs as "postgres", the function owner, so it keeps
--      working).
--   5. Fixes the "mutable search_path" warnings.
--
-- Deliberately NOT touched (they are intentionally public, or already safe):
--   get_tenant_by_domain, is_tenant_open_now, is_within_business_hours,
--   tenant_has_module, is_platform_admin, is_tenant_member,
--   user_has_permission, get_user_tenant_ids, get_user_role_key_for_tenant,
--   salesperson_my_clients, salesperson_my_summary.
--   (Several are used inside row-level-security policies that apply to
--   logged-out visitors; revoking them would break public pages.)
--
-- Safe to run more than once. To undo: run the rollback file.
-- ============================================================================

begin;

-- 1. Trigger-only functions: never meant to be called as API endpoints.
revoke all on function public.block_duplicate_booking()     from public, anon, authenticated;
revoke all on function public.block_duplicate_queue_entry() from public, anon, authenticated;

-- 2. Functions that raise "Not authenticated" when there is no logged-in user.
revoke all on function public.get_my_context(text) from public, anon;
grant execute on function public.get_my_context(text) to authenticated, service_role;

revoke all on function public.register_as_tenant_customer(text, text, text, text) from public, anon;
grant execute on function public.register_as_tenant_customer(text, text, text, text) to authenticated, service_role;

-- 3. Queue triggers run with the owner's rights, so they can still call
--    notify_queue_entry after step 4, whoever inserts the row.
alter function public.trg_queue_entry_after_insert()
  security definer set search_path = public, extensions;
alter function public.trg_queue_entry_after_status_change()
  security definer set search_path = public, extensions;

-- 4. Server-only helpers.
revoke all on function public.notify_queue_entry(uuid, text) from public, anon, authenticated;
grant execute on function public.notify_queue_entry(uuid, text) to service_role;

revoke all on function public.promote_bookings_to_queue() from public, anon, authenticated;
grant execute on function public.promote_bookings_to_queue() to service_role;

-- 5. Pin the search_path on the remaining functions the linter flagged.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'set_updated_at',
        'queue_position_ahead',
        'estimate_wait_minutes',
        'avg_service_minutes',
        '_commission_actor',
        'trg_append_only',
        'trg_commission_rules_guard'
      )
  loop
    execute format('alter function %s set search_path = public, extensions', r.sig);
  end loop;
end $$;

commit;
