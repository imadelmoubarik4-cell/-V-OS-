-- S100 security & cost hardening acceptance.
--
-- Run against a replay database that has all migrations applied:
--   psql -v ON_ERROR_STOP=1 -f tests/sql/s100_security_cost_hardening.sql
-- Fails (raises) before 20261017090000_s100_security_cost_hardening.sql; passes after.
-- Everything runs in one transaction and is rolled back.
--
-- Proves: the new AI cost/throttle RPCs and the block-event trail are sealed to
-- service_role only (actor re-validated, never browser-callable); the block-event
-- trail is append-only; the recipe price/flag change audit is written by a DEFINER
-- trigger that no frontend path can skip, is append-only, and that only managers can
-- change recipe prices (anon/inactive/viewer/bartender cannot).

begin;

-- Fixtures: admin, manager, two non-managers, one inactive manager.
insert into auth.users (id, email) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 's100-admin@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 's100-manager@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 's100-bartender@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000004', 's100-viewer@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000005', 's100-inactive@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, email, display_name, role, active) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 's100-admin@example.test', 'Admin', 'admin', true),
  ('bbbbbbbb-0000-4000-8000-000000000002', 's100-manager@example.test', 'Manager', 'manager', true),
  ('bbbbbbbb-0000-4000-8000-000000000003', 's100-bartender@example.test', 'Bartender', 'bartender', true),
  ('bbbbbbbb-0000-4000-8000-000000000004', 's100-viewer@example.test', 'Viewer', 'viewer', true),
  ('bbbbbbbb-0000-4000-8000-000000000005', 's100-inactive@example.test', 'Ex-Manager', 'manager', false)
on conflict (id) do update set role = excluded.role, active = excluded.active;

-- ---------------------------------------------------------------------------
-- T1: the new AI RPCs are not callable by browser roles (actor-spoofing guard).
-- ---------------------------------------------------------------------------
do $t1$
declare
  fns text[] := array[
    'public.atlas_ai_run_start(uuid,text,uuid,text,jsonb)',
    'public.atlas_ai_record_block(uuid,text,text,text,jsonb)',
    'public.atlas_ai_usage_summary(uuid,text)',
    'public.atlas_ai_limits_set(uuid,text,jsonb)'
  ];
  f text;
begin
  foreach f in array fns loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'T1 FAIL: anon can execute %', f;
    end if;
    if has_function_privilege('authenticated', f, 'execute') then
      raise exception 'T1 FAIL: authenticated can execute %', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'T1 FAIL: service_role cannot execute %', f;
    end if;
  end loop;
  raise notice 'T1 pass: AI cost/throttle RPCs are service_role-only';
end
$t1$;

-- ---------------------------------------------------------------------------
-- T2: no public RPC taking p_actor_id/p_actor_role is browser-executable.
-- ---------------------------------------------------------------------------
do $t2$
declare leaked text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and pg_get_function_identity_arguments(p.oid) ~ '\mp_actor_(id|role)\M'
    and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'));
  if leaked is not null then
    raise exception 'T2 FAIL: p_actor_* RPC(s) executable by a browser role: %', leaked;
  end if;
  raise notice 'T2 pass: every p_actor_* RPC is service_role-only';
end
$t2$;

-- ---------------------------------------------------------------------------
-- T3: atlas_ai_record_block re-validates the actor and records an event; the
-- block-event trail is append-only even for service_role.
-- ---------------------------------------------------------------------------
set local role service_role;
do $t3$
declare cnt int;
begin
  -- forged actor/role is rejected (ai_require_actor fails closed)
  begin
    perform public.atlas_ai_record_block(
      'bbbbbbbb-0000-4000-8000-000000000003', 'admin', 'rate_limited', 'text', '{}'::jsonb);
    raise exception 'T3 FAIL: record_block accepted a forged actor role';
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like 'T3 FAIL%' then raise; end if;
  end;
  -- genuine actor records a block
  perform public.atlas_ai_record_block(
    'bbbbbbbb-0000-4000-8000-000000000002', 'manager', 'budget_daily', 'text',
    jsonb_build_object('reason','budget_daily'));
  select count(*) into cnt from atlas_private.ai_block_events
    where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' and kind = 'budget_daily';
  if cnt <> 1 then raise exception 'T3 FAIL: block event not recorded (% rows)', cnt; end if;
  raise notice 'T3 pass: record_block re-validates actor and records a block event';
end
$t3$;

do $t3b$
declare denied int := 0;
begin
  begin update atlas_private.ai_block_events set kind = 'other'; exception when insufficient_privilege then denied := denied + 1; end;
  begin delete from atlas_private.ai_block_events; exception when insufficient_privilege then denied := denied + 1; end;
  begin truncate atlas_private.ai_block_events; exception when insufficient_privilege then denied := denied + 1; end;
  if denied <> 3 then raise exception 'T3b FAIL: block trail is not append-only (% of 3 denied)', denied; end if;
  raise notice 'T3b pass: ai_block_events is append-only for service_role';
end
$t3b$;
reset role;

-- browser roles cannot touch the block trail at all
set local role authenticated;
do $t3c$
begin
  begin
    perform 1 from atlas_private.ai_block_events;
    raise exception 'T3c FAIL: authenticated can read ai_block_events';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into atlas_private.ai_block_events (kind) values ('other');
    raise exception 'T3c FAIL: authenticated can forge ai_block_events';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T3c pass: ai_block_events is sealed from browser roles';
end
$t3c$;
reset role;

-- ---------------------------------------------------------------------------
-- T4: the usage summary RPC is manager/admin-only and reports the new limits.
-- ---------------------------------------------------------------------------
set local role service_role;
do $t4$
declare j jsonb;
begin
  -- a non-manager actor is refused (42501)
  begin
    perform public.atlas_ai_usage_summary('bbbbbbbb-0000-4000-8000-000000000003', 'bartender');
    raise exception 'T4 FAIL: usage summary returned for a bartender';
  exception when insufficient_privilege then null;
  end;
  j := public.atlas_ai_usage_summary('bbbbbbbb-0000-4000-8000-000000000002', 'manager');
  if not (j ? 'limits' and j ? 'spend' and j ? 'blocks') then
    raise exception 'T4 FAIL: usage summary shape incomplete: %', j;
  end if;
  if not ((j->'limits') ? 'chat_requests_per_minute' and (j->'limits') ? 'daily_budget_usd') then
    raise exception 'T4 FAIL: usage summary is missing the S100 limits: %', j->'limits';
  end if;
  raise notice 'T4 pass: usage summary is manager-only and reports S100 limits';
end
$t4$;
reset role;

-- ---------------------------------------------------------------------------
-- T5: a manager can tune the limits; a present null key disables a budget cap.
-- ---------------------------------------------------------------------------
set local role service_role;
do $t5$
declare j jsonb;
begin
  j := public.atlas_ai_limits_set('bbbbbbbb-0000-4000-8000-000000000002', 'manager',
    jsonb_build_object('chat_requests_per_minute', 7, 'daily_budget_usd', null));
  if (j->'limits'->>'chat_requests_per_minute') <> '7' then
    raise exception 'T5 FAIL: chat_requests_per_minute not updated: %', j->'limits';
  end if;
  if (j->'limits'->'daily_budget_usd') <> 'null'::jsonb then
    raise exception 'T5 FAIL: daily_budget_usd not cleared to null: %', j->'limits';
  end if;
  -- a non-manager cannot set limits
  begin
    perform public.atlas_ai_limits_set('bbbbbbbb-0000-4000-8000-000000000004', 'viewer', '{}'::jsonb);
    raise exception 'T5 FAIL: a viewer set AI limits';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T5 pass: limits_set is manager-only and honours null (disable-cap)';
end
$t5$;
reset role;

-- ---------------------------------------------------------------------------
-- T6: a manager recipe price/flag change is audited with actor, role, old/new.
-- ---------------------------------------------------------------------------
insert into public.recipes (id, name, type, menu_price, happy_hour_price, active, show_on_menu)
values ('bbbbbbbb-0000-4000-8000-0000000000a1', 'S100 Test Negroni', 'cocktail', 18.0, 12.0, true, true)
on conflict (id) do update set menu_price = excluded.menu_price;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
update public.recipes
  set menu_price = 21.0, happy_hour_price = 14.0, active = false, show_on_menu = false
  where id = 'bbbbbbbb-0000-4000-8000-0000000000a1';
reset role;

do $t6$
declare r record;
begin
  -- the price change is recorded with full attribution
  select * into r from atlas_private.recipe_price_events
  where recipe_id = 'bbbbbbbb-0000-4000-8000-0000000000a1' and field = 'menu_price'
  order by changed_at desc limit 1;
  if r is null then raise exception 'T6 FAIL: manager menu_price change left no audit row'; end if;
  if r.old_value <> '18.0' or r.new_value <> '21.0'
     or r.changed_by <> 'bbbbbbbb-0000-4000-8000-000000000002' or r.changed_by_role <> 'manager' then
    raise exception 'T6 FAIL: menu_price audit row incomplete: %', row_to_json(r);
  end if;
  -- the other three commercial fields are each recorded
  if (select count(distinct field) from atlas_private.recipe_price_events
      where recipe_id = 'bbbbbbbb-0000-4000-8000-0000000000a1'
        and field in ('menu_price','happy_hour_price','active','show_on_menu')) <> 4 then
    raise exception 'T6 FAIL: not all commercial fields were audited';
  end if;
  raise notice 'T6 pass: manager recipe price/flag changes are audited with actor, role, old/new';
end
$t6$;

-- ---------------------------------------------------------------------------
-- T7: the recipe audit table is sealed and append-only.
-- ---------------------------------------------------------------------------
set local role service_role;
do $t7$
declare denied int := 0;
begin
  begin update atlas_private.recipe_price_events set new_value = 'forged'; exception when insufficient_privilege then denied := denied + 1; end;
  begin delete from atlas_private.recipe_price_events; exception when insufficient_privilege then denied := denied + 1; end;
  begin truncate atlas_private.recipe_price_events; exception when insufficient_privilege then denied := denied + 1; end;
  if denied <> 3 then raise exception 'T7 FAIL: recipe audit is not append-only (% of 3 denied)', denied; end if;
  raise notice 'T7 pass: recipe_price_events is append-only for service_role';
end
$t7$;
reset role;
set local role authenticated;
do $t7b$
begin
  begin
    perform 1 from atlas_private.recipe_price_events;
    raise exception 'T7b FAIL: authenticated can read recipe_price_events';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T7b pass: recipe_price_events is sealed from browser roles';
end
$t7b$;
reset role;

-- ---------------------------------------------------------------------------
-- T8: anon/inactive/viewer/bartender cannot change recipe prices.
-- A browser role whose RLS predicate fails updates 0 rows (no audit, no change);
-- anon has no table grant at all (insufficient_privilege).
-- ---------------------------------------------------------------------------
-- 8a: bartender
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000003","role":"authenticated"}', true);
do $t8a$
declare affected int;
begin
  update public.recipes set menu_price = 999 where id = 'bbbbbbbb-0000-4000-8000-0000000000a1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'T8a FAIL: bartender changed a recipe price (% rows)', affected; end if;
  raise notice 'T8a pass: bartender cannot change recipe prices';
end
$t8a$;
reset role;

-- 8b: viewer
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000004","role":"authenticated"}', true);
do $t8b$
declare affected int;
begin
  update public.recipes set menu_price = 999 where id = 'bbbbbbbb-0000-4000-8000-0000000000a1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'T8b FAIL: viewer changed a recipe price (% rows)', affected; end if;
  raise notice 'T8b pass: viewer cannot change recipe prices';
end
$t8b$;
reset role;

-- 8c: inactive manager
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000005","role":"authenticated"}', true);
do $t8c$
declare affected int;
begin
  update public.recipes set menu_price = 999 where id = 'bbbbbbbb-0000-4000-8000-0000000000a1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'T8c FAIL: an inactive manager changed a recipe price (% rows)', affected; end if;
  raise notice 'T8c pass: an inactive manager cannot change recipe prices';
end
$t8c$;
reset role;

-- 8d: anon has no write grant on recipes at all
set local role anon;
do $t8d$
begin
  begin
    update public.recipes set menu_price = 999 where id = 'bbbbbbbb-0000-4000-8000-0000000000a1';
    raise exception 'T8d FAIL: anon updated a recipe';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T8d pass: anon cannot update recipes';
end
$t8d$;
reset role;

-- the price never moved off the manager-set value during T8
do $t8e$
begin
  if (select menu_price from public.recipes where id = 'bbbbbbbb-0000-4000-8000-0000000000a1') <> 21.0 then
    raise exception 'T8e FAIL: a non-manager role moved the recipe price';
  end if;
  raise notice 'T8e pass: recipe price unchanged by non-manager roles';
end
$t8e$;

-- ---------------------------------------------------------------------------
-- T9: the durable text-chat throttle actually fires (not just the grants).
-- ---------------------------------------------------------------------------
insert into atlas_private.ai_settings (id, enabled, chat_requests_per_minute, chat_burst_limit, daily_budget_usd, monthly_budget_usd)
  select true, true, 2, 2, null, null
  where not exists (select 1 from atlas_private.ai_settings);
update atlas_private.ai_settings
  set enabled = true, chat_requests_per_minute = 2, chat_burst_limit = 2,
      daily_budget_usd = null, monthly_budget_usd = null
  where id;
set local role service_role;
do $t9$
declare allowed int := 0; throttled int := 0; i int;
begin
  for i in 1..5 loop
    begin
      perform public.atlas_ai_run_start(
        'bbbbbbbb-0000-4000-8000-000000000003', 'bartender', null, 'text', '{}'::jsonb);
      allowed := allowed + 1;
    exception when others then
      if sqlstate = '53400' and sqlerrm like 'rate_limited: too many%' then throttled := throttled + 1;
      else raise exception 'T9 FAIL: unexpected error % %', sqlstate, sqlerrm; end if;
    end;
  end loop;
  if allowed <> 2 or throttled <> 3 then
    raise exception 'T9 FAIL: throttle did not fire as configured (% allowed, % throttled)', allowed, throttled;
  end if;
  raise notice 'T9 pass: durable text-chat throttle fires at the configured limit';
end
$t9$;
reset role;

-- ---------------------------------------------------------------------------
-- T10: the cumulative USD budget blocks once recorded spend reaches the cap.
-- ---------------------------------------------------------------------------
update atlas_private.ai_settings
  set chat_requests_per_minute = 600, chat_burst_limit = 200,
      daily_budget_usd = 10.00, monthly_budget_usd = 100.00
  where id;
insert into atlas_private.ai_runs (user_id, role, channel, est_cost_usd, started_at)
  values ('bbbbbbbb-0000-4000-8000-000000000002', 'manager', 'text', 9.50, pg_catalog.now());
set local role service_role;
do $t10$
declare blocked boolean := false;
begin
  -- under the cap: allowed
  perform public.atlas_ai_run_start('bbbbbbbb-0000-4000-8000-000000000002', 'manager', null, 'text', '{}'::jsonb);
  -- push recorded spend to the cap
  insert into atlas_private.ai_runs (user_id, role, channel, est_cost_usd, started_at)
    values ('bbbbbbbb-0000-4000-8000-000000000002', 'manager', 'text', 1.00, pg_catalog.now());
  begin
    perform public.atlas_ai_run_start('bbbbbbbb-0000-4000-8000-000000000002', 'manager', null, 'text', '{}'::jsonb);
  exception when others then
    if sqlstate = '53400' and sqlerrm = 'rate_limited: daily AI budget reached' then blocked := true;
    else raise exception 'T10 FAIL: unexpected error % %', sqlstate, sqlerrm; end if;
  end;
  if not blocked then raise exception 'T10 FAIL: daily USD budget did not block at the cap'; end if;
  raise notice 'T10 pass: cumulative daily USD budget blocks at the cap';
end
$t10$;
reset role;

do $done$
begin
  raise notice 's100_security_cost_hardening: all authorization and integrity checks passed';
end
$done$;

rollback;
