-- The event ticket always draws its QR code (it is the entry pass), so no toggle column is needed.
alter table public.tenant_event_ticket_settings drop column if exists show_qr;
