-- S114 staff access state — database acceptance on a replayed DB. Proves at the
-- database boundary what self-service account setup relies on
-- (atlas_team_profile_access_state, _shared/staff-access.mjs):
--   1. the functions are sealed: only service_role may execute them;
--   2. a fresh invitation (inactive profile created through Auth) is audited,
--      has never been active or removed, keeps its invited role, names its
--      still-active inviter and its age in whole days — the only state setup
--      may activate;
--   3. once activated, a profile stays ever_active after it is deactivated
--      (a removed member) and after a demotion; a direct SQL change counts too;
--   4. a pending invitation that Team removed reads as removed (S105 audit);
--      a role changed on a pending profile reads as role_changed;
--   5. the inviter's current status is read live: a demoted or removed inviter
--      shows as such; a malformed inviter reads as no inviter;
--   6. a profile created before the audit existed reads as not audited, and an
--      unknown profile id reads as not audited, never active, no inviter;
--   7. the answer holds no personal data: exactly the seven keys.
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- 1. Sealed ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.atlas_team_profile_access_state(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.atlas_team_profile_access_state(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'atlas_private.team_profile_access_state(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'atlas_private.team_profile_access_state(uuid)', 'EXECUTE')
  then raise exception 'browser roles can execute the access-state functions'; end if;
  if not has_function_privilege('service_role', 'public.atlas_team_profile_access_state(uuid)', 'EXECUTE')
  then raise exception 'service_role cannot execute the access-state wrapper'; end if;
  raise notice 'check 1 ok: sealed to service_role';
end $$;

-- Fixtures: inviters and invitations created the way Auth creates them (the
-- new-user trigger makes the inactive profile; the S96 audit trigger records
-- profile.created).
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('11400000-0000-4000-8000-0000000000a1', 's114.admin@example.invalid', '{"full_name":"Inviting Admin"}', '{}'),
  ('11400000-0000-4000-8000-0000000000a2', 's114.demotedinviter@example.invalid', '{"full_name":"Demoted Inviter"}', '{}'),
  ('11400000-0000-4000-8000-0000000000a3', 's114.removedinviter@example.invalid', '{"full_name":"Removed Inviter"}', '{}');
update public.profiles set active = true, role = 'admin' where id = '11400000-0000-4000-8000-0000000000a1';
update public.profiles set active = true, role = 'manager' where id in ('11400000-0000-4000-8000-0000000000a2', '11400000-0000-4000-8000-0000000000a3');

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, invited_at)
values
  ('11400000-0000-4000-8000-000000000001', 's114.pending@example.invalid', '{"full_name":"Pending Invitee"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a1","atlas_intended_role":"bartender"}', now() - interval '1 day'),
  ('11400000-0000-4000-8000-000000000002', 's114.removed@example.invalid', '{"full_name":"Removed Member"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a1","atlas_intended_role":"bartender"}', now() - interval '3 days'),
  ('11400000-0000-4000-8000-000000000003', 's114.demoted@example.invalid', '{"full_name":"Demoted Manager"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a1","atlas_intended_role":"manager"}', now() - interval '3 days'),
  ('11400000-0000-4000-8000-000000000004', 's114.direct@example.invalid', '{"full_name":"Direct SQL"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a1"}', now() - interval '3 days'),
  ('11400000-0000-4000-8000-000000000006', 's114.rolechanged@example.invalid', '{"full_name":"Role Changed"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a2","atlas_intended_role":"manager"}', now() - interval '2 days'),
  ('11400000-0000-4000-8000-000000000007', 's114.expired@example.invalid', '{"full_name":"Old Invitation"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a3","atlas_intended_role":"bartender"}', now() - interval '20 days'),
  ('11400000-0000-4000-8000-000000000008', 's114.cancelled@example.invalid', '{"full_name":"Cancelled Invitation"}', '{"atlas_invited_by":"11400000-0000-4000-8000-0000000000a1","atlas_intended_role":"bartender"}', now()),
  ('11400000-0000-4000-8000-000000000009', 's114.malformed@example.invalid', '{"full_name":"Malformed Inviter"}', '{"atlas_invited_by":"x"}', null);

-- A profile from before the audit existed: created with the audit trigger off.
alter table public.profiles disable trigger s96_profiles_access_audit;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('11400000-0000-4000-8000-000000000005', 's114.legacy@example.invalid', '{"full_name":"Legacy Person"}', '{"atlas_invited_by":"x"}');
alter table public.profiles enable trigger s96_profiles_access_audit;

-- Lifecycle changes, as Team Profiles (or an administrator) makes them.
update public.profiles set active = true, role = 'bartender' where id = '11400000-0000-4000-8000-000000000002';
update public.profiles set active = false where id = '11400000-0000-4000-8000-000000000002';
update public.profiles set active = true, role = 'manager' where id = '11400000-0000-4000-8000-000000000003';
update public.profiles set role = 'viewer' where id = '11400000-0000-4000-8000-000000000003';
update public.profiles set active = true where id = '11400000-0000-4000-8000-000000000004';
update public.profiles set active = false where id = '11400000-0000-4000-8000-000000000004';
update public.profiles set role = 'bartender' where id = '11400000-0000-4000-8000-000000000006';
-- The inviters change after inviting: one demoted, one removed.
update public.profiles set role = 'bartender' where id = '11400000-0000-4000-8000-0000000000a2';
update public.profiles set active = false where id = '11400000-0000-4000-8000-0000000000a3';
-- Team removed a still-pending invitation (S105 removal audit; never active).
insert into atlas_private.team_member_deletion_audit (action, target_kind, target_profile_id, mode)
values ('removed_from_team', 'login', '11400000-0000-4000-8000-000000000008', 'archived');

set local role service_role;

do $$
declare
  state jsonb;
  expect record;
begin
  for expect in
    select * from (values
      ('11400000-0000-4000-8000-000000000001'::uuid, '{"audited":true,"ever_active":false,"removed":false,"role_changed":false,"inviter_active":true,"inviter_role":"admin","invitation_age_days":1}'::jsonb,
        'a fresh invitation: audited, never active, active inviter, one day old'),
      ('11400000-0000-4000-8000-000000000002'::uuid, '{"audited":true,"ever_active":true,"removed":false,"role_changed":true,"inviter_active":true,"inviter_role":"admin","invitation_age_days":3}',
        'a deactivated member stays ever_active'),
      ('11400000-0000-4000-8000-000000000003'::uuid, '{"audited":true,"ever_active":true,"removed":false,"role_changed":true,"inviter_active":true,"inviter_role":"admin","invitation_age_days":3}',
        'a demoted, still active manager is ever_active'),
      ('11400000-0000-4000-8000-000000000004'::uuid, '{"audited":true,"ever_active":true,"removed":false,"role_changed":false,"inviter_active":true,"inviter_role":"admin","invitation_age_days":3}',
        'a direct SQL activate/deactivate counts'),
      ('11400000-0000-4000-8000-000000000006'::uuid, '{"audited":true,"ever_active":false,"removed":false,"role_changed":true,"inviter_active":true,"inviter_role":"bartender","invitation_age_days":2}',
        'a role set on a pending profile, from an inviter since demoted'),
      ('11400000-0000-4000-8000-000000000007'::uuid, '{"audited":true,"ever_active":false,"removed":false,"role_changed":false,"inviter_active":false,"inviter_role":"manager","invitation_age_days":20}',
        'an old invitation from an inviter since removed'),
      ('11400000-0000-4000-8000-000000000008'::uuid, '{"audited":true,"ever_active":false,"removed":true,"role_changed":false,"inviter_active":true,"inviter_role":"admin","invitation_age_days":0}',
        'a pending invitation that Team removed'),
      ('11400000-0000-4000-8000-000000000009'::uuid, '{"audited":true,"ever_active":false,"removed":false,"role_changed":false,"inviter_active":false,"inviter_role":null,"invitation_age_days":null}',
        'a malformed inviter reads as no inviter'),
      ('11400000-0000-4000-8000-000000000005'::uuid, '{"audited":false,"ever_active":false,"removed":false,"role_changed":false,"inviter_active":false,"inviter_role":null,"invitation_age_days":null}',
        'a pre-audit profile reads as not audited'),
      ('11400000-0000-4000-8000-0000000000ff'::uuid, '{"audited":false,"ever_active":false,"removed":false,"role_changed":false,"inviter_active":false,"inviter_role":null,"invitation_age_days":null}',
        'an unknown id: not audited, never active, no inviter')
    ) as t(id, expected, label)
  loop
    state := public.atlas_team_profile_access_state(expect.id);
    -- 7. exact equality: these seven keys and nothing else (nothing personal)
    if state is distinct from expect.expected then
      raise exception '%: got %, expected %', expect.label, state, expect.expected;
    end if;
  end loop;
  raise notice 'checks 2-7 ok: invitation, removal, demotion, direct SQL, role change, inviters, age, pre-audit and unknown profiles';
end $$;

reset role;

-- Only a browser role at runtime is refused, not just by grants on paper.
do $$
begin
  begin
    set local role authenticated;
    perform public.atlas_team_profile_access_state('11400000-0000-4000-8000-000000000001');
    raise exception 'authenticated could call the access-state wrapper';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  raise notice 'check 1b ok: authenticated refused at runtime';
end $$;

select 'S114 all staff access state checks passed' as result;
rollback;
