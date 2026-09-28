-- S96 opsrisk regression test: audit history is append-only and staff
-- access changes are attributably audited.
--
-- Run against a replay database that has all migrations applied:
--   psql -v ON_ERROR_STOP=1 -f tests/sql/s96_audit_append_only_test.sql
-- Fails (raises) before 20261010096000/096100/096200; passes after.
-- Everything runs in one transaction and is rolled back.

begin;

-- Fixtures: one admin, one manager, one bartender.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'admin@example.test'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'manager@example.test'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'bartender@example.test');
insert into public.profiles (id, email, display_name, role, active) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'admin@example.test', 'Admin', 'admin', true),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'manager@example.test', 'Manager', 'manager', true),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'bartender@example.test', 'Bartender', 'bartender', true)
on conflict (id) do update set role = excluded.role, active = excluded.active;

insert into atlas_private.team_profile_events (event_type, profile_id, actor_id, actor_label, actor_role)
values ('role_changed', 'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'Admin', 'admin');

-- T1: service_role cannot UPDATE, DELETE or TRUNCATE audit history.
set local role service_role;
do $t1$
declare denied int := 0;
begin
  begin update atlas_private.team_profile_events set actor_label = 'forged'; exception when insufficient_privilege then denied := denied + 1; end;
  begin delete from atlas_private.team_profile_events; exception when insufficient_privilege then denied := denied + 1; end;
  begin truncate atlas_private.settings_events; exception when insufficient_privilege then denied := denied + 1; end;
  begin delete from atlas_private.ai_tool_calls; exception when insufficient_privilege then denied := denied + 1; end;
  begin update public.inventory_movements set quantity_change = 0; exception when insufficient_privilege then denied := denied + 1; end;
  if denied <> 5 then raise exception 'T1 FAIL: service_role could rewrite audit history (% of 5 denied)', denied; end if;
  raise notice 'T1 pass: service_role UPDATE/DELETE/TRUNCATE on audit tables denied';
end
$t1$;
reset role;

-- T2: even the table owner (postgres) is stopped by the trigger.
do $t2$
declare denied int := 0;
begin
  begin update atlas_private.team_profile_events set actor_label = 'forged'; exception when insufficient_privilege then denied := denied + 1; end;
  begin delete from atlas_private.team_profile_events; exception when insufficient_privilege then denied := denied + 1; end;
  begin truncate atlas_private.team_profile_events; exception when insufficient_privilege then denied := denied + 1; end;
  if denied <> 3 then raise exception 'T2 FAIL: owner could rewrite audit history (% of 3 denied)', denied; end if;
  raise notice 'T2 pass: owner UPDATE/DELETE/TRUNCATE blocked by trigger';
end
$t2$;

-- T3: referential ON DELETE SET NULL still works (deleting a count session
-- nulls inventory_count_events.session_id), and nothing else may change.
do $t3$
declare s uuid; e uuid;
begin
  insert into atlas_private.inventory_count_sessions (session_key, client_request_id, title, started_by, started_by_label)
  values ('s96-test', 's96-test', 'S96 test', 'aaaaaaaa-0000-4000-8000-000000000002', 'Manager') returning id into s;
  insert into atlas_private.inventory_count_events (event_type, session_id, actor_id, actor_label, actor_role)
  values ('session_started', s, 'aaaaaaaa-0000-4000-8000-000000000002', 'Manager', 'manager') returning id into e;
  delete from atlas_private.inventory_count_sessions where id = s;
  if exists (select 1 from atlas_private.inventory_count_events where id = e and session_id is null and actor_label = 'Manager') then
    raise notice 'T3 pass: FK SET NULL cascade allowed, audit row preserved';
  else
    raise exception 'T3 FAIL: cascade did not preserve the audit row';
  end if;
end
$t3$;

-- T4: break-glass works only for a superuser-class session that opts in.
do $t4$
begin
  perform set_config('atlas.audit_break_glass', 'on', true);
  update atlas_private.team_profile_events set actor_label = actor_label;
  perform set_config('atlas.audit_break_glass', '', true);
  raise notice 'T4 pass: documented break-glass path available to postgres';
end
$t4$;

-- T5: an admin role change through PostgREST (authenticated + JWT claims)
-- is audited in the same transaction with actor, role and old/new values.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
update public.profiles set role = 'viewer', active = false where id = 'aaaaaaaa-0000-4000-8000-000000000003';
reset role;
do $t5$
declare r record;
begin
  select * into r from atlas_private.security_audit_events
  where target_id = 'aaaaaaaa-0000-4000-8000-000000000003' order by id desc limit 1;
  if r is null then raise exception 'T5 FAIL: admin role change left no audit record'; end if;
  if r.action <> 'profile.role_changed' or r.actor_id <> 'aaaaaaaa-0000-4000-8000-000000000001'
     or r.actor_profile_role <> 'admin' or r.request_role <> 'authenticated'
     or r.old_values ->> 'role' <> 'bartender' or r.new_values ->> 'role' <> 'viewer'
     or (r.new_values ->> 'active')::boolean is not false then
    raise exception 'T5 FAIL: audit record incomplete: %', row_to_json(r);
  end if;
  raise notice 'T5 pass: role change audited (actor, role, request role, old/new, timestamp)';
end
$t5$;

-- T6: security_audit_events cannot be read or written by browsers and
-- cannot be rewritten by service_role.
set local role authenticated;
do $t6a$
begin
  begin
    perform 1 from atlas_private.security_audit_events;
    raise exception 'T6 FAIL: authenticated can read security audit';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into atlas_private.security_audit_events (action, target_type) values ('forged.event', 'profile');
    raise exception 'T6 FAIL: authenticated can forge security audit';
  exception when insufficient_privilege then null;
  end;
end
$t6a$;
reset role;
set local role service_role;
do $t6b$
begin
  begin
    delete from atlas_private.security_audit_events;
    raise exception 'T6 FAIL: service_role can delete security audit';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into atlas_private.security_audit_events (action, target_type) values ('forged.event', 'profile');
    raise exception 'T6 FAIL: service_role can forge security audit';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T6 pass: security audit is not readable/writable by browsers and not forgeable/erasable by service_role';
end
$t6b$;
reset role;

-- T7: a manager session cannot insert forged/backdated stock movements.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $t7$
begin
  begin
    insert into public.inventory_movements (item_name, movement_type, quantity_change, created_by, created_at)
    values ('Forged', 'restock', 999, 'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '30 days');
    raise exception 'T7 FAIL: manager inserted a forged, backdated movement attributed to another user';
  exception when insufficient_privilege then
    raise notice 'T7 pass: browser INSERT into inventory_movements denied';
  end;
end
$t7$;
reset role;

rollback;
