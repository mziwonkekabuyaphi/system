-- ============================================================================
-- ROLLBACK for security hardening parts 1 and 2 (QLess Systems)
-- Puts every function back to how it was: callable by everyone, triggers back
-- to running as the calling user, search_path back to unset.
-- Use this if something breaks after running part 1 or part 2.
-- ============================================================================

begin;

grant execute on function public.block_duplicate_booking()                         to public, anon, authenticated, service_role;
grant execute on function public.block_duplicate_queue_entry()                     to public, anon, authenticated, service_role;
grant execute on function public.get_my_context(text)                              to public, anon, authenticated, service_role;
grant execute on function public.register_as_tenant_customer(text, text, text, text) to public, anon, authenticated, service_role;
grant execute on function public.notify_queue_entry(uuid, text)                    to public, anon, authenticated, service_role;
grant execute on function public.promote_bookings_to_queue()                       to public, anon, authenticated, service_role;
grant execute on function public.next_queue_ticket_number(uuid, date)              to public, anon, authenticated, service_role;

alter function public.trg_queue_entry_after_insert()        security invoker reset search_path;
alter function public.trg_queue_entry_after_status_change() security invoker reset search_path;

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
    execute format('alter function %s reset search_path', r.sig);
  end loop;
end $$;

commit;
