-- Public bucket for event ticket QR PNGs (written only by the server with the service role).
-- Files are named <tenant_id>/<ticket_id>.png; there is no listing policy for anon/authenticated.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ticket-qrcodes', 'ticket-qrcodes', true, 1048576, array['image/png'])
on conflict (id) do nothing;
