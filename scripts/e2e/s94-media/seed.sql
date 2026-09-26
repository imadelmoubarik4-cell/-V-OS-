-- Test people for the local S94 Media stack (fresh replayed database only).
-- Password for all: s94-e2e-password (checked by the auth stub, not by Postgres).
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('5e940000-0000-4000-8000-00000000a001', 'authenticated', 'authenticated', 'admin@s94.e2e.test', now(), '{}', '{}'),
  ('5e940000-0000-4000-8000-00000000a002', 'authenticated', 'authenticated', 'manager@s94.e2e.test', now(), '{}', '{}'),
  ('5e940000-0000-4000-8000-00000000a003', 'authenticated', 'authenticated', 'bartender@s94.e2e.test', now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, email, display_name, role, active)
values
  ('5e940000-0000-4000-8000-00000000a001', 'admin@s94.e2e.test', 'Edda Admin', 'admin', true),
  ('5e940000-0000-4000-8000-00000000a002', 'manager@s94.e2e.test', 'Magnus Manager', 'manager', true),
  ('5e940000-0000-4000-8000-00000000a003', 'bartender@s94.e2e.test', 'Birna Bartender', 'bartender', true)
on conflict (id) do update set role = excluded.role, active = true, display_name = excluded.display_name;
