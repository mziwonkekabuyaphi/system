-- Per-path switch for printing a ticket at the kiosk. Default true = today's behaviour.
alter table public.booking_settings add column if not exists kiosk_print_ticket boolean not null default true;
alter table public.queue_settings add column if not exists kiosk_print_ticket boolean not null default true;
