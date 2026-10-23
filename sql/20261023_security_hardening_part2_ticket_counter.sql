-- ============================================================================
-- Security hardening, PART 2: queue ticket counter (QLess Systems)
-- Branch: fix/security-hardening        Date: 2026-10-23
--
-- Why: next_queue_ticket_number(tenant_id, date) can currently be called by
-- anyone, including logged-out visitors. The tenant_id is public (it is
-- returned by get_tenant_by_domain), so a stranger could keep calling it and
-- burn through a shop's ticket numbers.
--
-- Run this ONLY AFTER you have checked that your app calls this function from
-- server code (the admin / service-role client), not from the browser.
-- See the runbook: search the repo for  next_queue_ticket_number
-- If the browser calls it, do NOT run this file; tell Claude what you found.
--
-- To undo: run the rollback file.
-- ============================================================================

begin;

revoke all on function public.next_queue_ticket_number(uuid, date) from public, anon, authenticated;
grant execute on function public.next_queue_ticket_number(uuid, date) to service_role;

commit;
