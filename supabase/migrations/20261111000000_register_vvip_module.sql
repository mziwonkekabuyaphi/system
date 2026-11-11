-- VVIP tables become a real add-on module, switched per shop by the platform admin.
-- It needs Events (VVIP packages belong to an event) and Events needs Passport (wallet),
-- so Passport controls VVIP through the existing module_requires chain.
-- Already applied to the "Ndithini Platform" project. Safe to run twice.
insert into public.modules (key, name, description, kind, switchable_by, default_on, plan_gated)
select 'vvip', 'VVIP tables & tabs',
       'Premium tables with a prepaid bar tab, sold per event and paid from Passport',
       'addon', 'platform', false, false
where not exists (select 1 from public.modules where key = 'vvip');

insert into public.module_requires (module_key, requires_key, requirement_group)
select 'vvip', 'events', 1
where not exists (
  select 1 from public.module_requires where module_key = 'vvip' and requires_key = 'events'
);
