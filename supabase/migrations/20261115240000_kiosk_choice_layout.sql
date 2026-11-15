-- Lets a shop pick how the kiosk's first (Booking / Queue) screen looks.
-- Additive and nullable: null means the original side-by-side cards.
alter table public.tenant_branding add column if not exists choice_layout text;
alter table public.tenant_branding drop constraint if exists tenant_branding_choice_layout_check;
alter table public.tenant_branding
  add constraint tenant_branding_choice_layout_check
  check (choice_layout is null or choice_layout in ('cards', 'rows', 'split'));
