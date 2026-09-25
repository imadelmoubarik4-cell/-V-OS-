-- S91 preview-only acceptance: live voice lease, heartbeat and device handoff
-- (supabase/migrations/20260930092000_s91_voice_lease_and_takeover.sql).
--
-- Requires an isolated replay database (scripts/verify_full_migration_replay.sh).
-- Seeds users inside one transaction and proves:
-- * a client that heartbeats reserves a 2-minute idle lease (hard cap still
--   60 min); without p_lease_seconds the lease stays 10 minutes, and the first
--   heartbeat shortens it (review P2-A); heartbeats are limited to one per
--   15 seconds (review P3-5);
-- * without a heartbeat the lease lapses and the slot is free again;
-- * a heartbeat renews the lease;
-- * takeover ends only the same user's live sessions (end_reason replaced,
--   replaced_by, one audit row) and reserves the new one; another user's
--   session is untouched; the replaced session is told it was replaced, but
--   its last transcript append is kept for 5 minutes (review P3-3);
-- * daily sessions and minutes still count (including replaced sessions) and
--   a refused takeover ends nothing;
-- * grants: service role only, the old 5-argument start is gone.
-- Prints one JSON verdict and rolls everything back. Time is simulated by
-- moving the rows' timestamps (now() is fixed inside a transaction).

begin;

create temporary table s91_voice (test_name text primary key, passed boolean not null, detail text) on commit drop;
grant all on table s91_voice to service_role, authenticated, anon;

-- Runs dynamic SQL and returns 'ok' or '<SQLSTATE> <message>'.
create function public.s91v_expect(p_sql text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function public.s91v_expect(text) to service_role, authenticated, anon;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000091901'::uuid,'s91v-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000091902'::uuid,'s91v-bar@example.invalid')) v(id,email);
update public.profiles set role='manager', active=true, display_name='S91V Manager' where id='00000000-0000-4000-8000-000000091901';
update public.profiles set role='bartender', active=true, display_name='S91V Bartender' where id='00000000-0000-4000-8000-000000091902';

-- Static boundary --------------------------------------------------------------------

insert into s91_voice
select 'the old 5-argument start is gone; the new start and touch are service-role only, invoker, search_path pinned',
  to_regprocedure('public.atlas_ai_voice_session_start(uuid,text,uuid,jsonb,integer)') is null
  and bool_and(not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute')
    and not p.prosecdef
    and coalesce(p.proconfig @> array['search_path=""'], false))
  and count(*) = 3, count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in ('atlas_ai_voice_session_start','atlas_ai_voice_session_touch'))
   or (n.nspname = 'atlas_private' and p.proname = 'ai_voice_session_json');

insert into s91_voice
select 'the handoff audit table has RLS, a service-role policy and no browser privilege',
  c.relrowsecurity
  and not has_table_privilege('anon', c.oid, 'select,insert,update,delete')
  and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
  and exists (select 1 from pg_policies p where p.schemaname = 'atlas_private' and p.tablename = c.relname and p.roles = array['service_role']::name[]),
  null
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'atlas_private' and c.relname = 'ai_voice_session_events';

set role service_role;

do $service$
declare
  mgr uuid := '00000000-0000-4000-8000-000000091901';
  bar uuid := '00000000-0000-4000-8000-000000091902';
  mgr_conv uuid; bar_conv uuid;
  v1 jsonb; v2 jsonb; v3 jsonb; m1 jsonb; r jsonb;
  s text; s2 text; s3 text; s4 text;
  u jsonb;
begin
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"enabled":true,"daily_turn_limit_per_user":200,"voice_sessions_per_day":20,"voice_minutes_per_day":60,"max_concurrent_voice_sessions":1}');
  mgr_conv := (public.atlas_ai_conversation_create(mgr, 'manager', 'Voice', '{}'::jsonb)->>'id')::uuid;
  bar_conv := (public.atlas_ai_conversation_create(bar, 'bartender', 'Voice', '{}'::jsonb)->>'id')::uuid;

  -- Lease -----------------------------------------------------------------------------
  -- Without p_lease_seconds (an older atlas-ai or a client that does not
  -- heartbeat) the lease stays 10 minutes; a first heartbeat shortens it.
  m1 := public.atlas_ai_voice_session_start(mgr, 'manager', mgr_conv, '{}'::jsonb, 60);
  s := (select (lease_expires_at - started_at)::text from atlas_private.ai_voice_sessions where id = (m1->>'voice_session_id')::uuid);
  r := public.atlas_ai_voice_session_touch(m1->>'voice_session_id', mgr, 'manager', 'heartbeat');
  insert into s91_voice values ('without the heartbeat flag the lease stays 10 minutes; the first heartbeat makes it 2 minutes',
    (m1->>'lease_seconds')::int = 600 and s = '00:10:00'
    and (r->>'lease_seconds')::int = 120
    and (select lease_expires_at from atlas_private.ai_voice_sessions where id = (m1->>'voice_session_id')::uuid) = now() + interval '2 minutes',
    s || ' ' || r::text);
  perform public.atlas_ai_voice_session_touch(m1->>'voice_session_id', mgr, 'manager', 'end');

  v1 := public.atlas_ai_voice_session_start(bar, 'bartender', bar_conv, '{}'::jsonb, 60, false, 120);
  insert into s91_voice values ('a session is reserved with a 2-minute idle lease and the 60-minute hard cap',
    (v1->>'live')::boolean and (v1->>'lease_seconds')::int = 120 and (v1->>'replaced_sessions')::int = 0
    and (select lease_expires_at - started_at from atlas_private.ai_voice_sessions where id = (v1->>'voice_session_id')::uuid) = interval '2 minutes'
    and (select hard_expires_at - started_at from atlas_private.ai_voice_sessions where id = (v1->>'voice_session_id')::uuid) = interval '60 minutes',
    v1::text);

  s := public.s91v_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L,%L::jsonb,60)', bar, 'bartender', bar_conv, '{}'));
  insert into s91_voice values ('without takeover a second live session is still refused (concurrent)',
    s = '53400 voice_quota_exceeded: concurrent', s);

  -- Heartbeat: 10 seconds left on the lease, renewed to a full 2 minutes.
  update atlas_private.ai_voice_sessions
  set started_at = now() - interval '110 seconds', last_activity_at = now() - interval '110 seconds',
      lease_expires_at = now() + interval '10 seconds', hard_expires_at = now() + interval '3490 seconds', created_at = now() - interval '110 seconds'
  where id = (v1->>'voice_session_id')::uuid;
  r := public.atlas_ai_voice_session_touch(v1->>'voice_session_id', bar, 'bartender', 'heartbeat');
  insert into s91_voice values ('a heartbeat renews the lease to 2 minutes from now and is counted',
    (r->>'live')::boolean and (r->>'heartbeats')::int = 1
    and (select lease_expires_at from atlas_private.ai_voice_sessions where id = (v1->>'voice_session_id')::uuid) = now() + interval '2 minutes',
    r::text);
  s := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'heartbeat'));
  insert into s91_voice values ('heartbeats are limited to one per 15 seconds per session',
    s = '53400 rate_limited: too many voice heartbeats'
    and (select heartbeats from atlas_private.ai_voice_sessions where id = (v1->>'voice_session_id')::uuid) = 1, s);

  -- No heartbeat for longer than the lease: the session is no longer live, its
  -- slot is free and it cannot be renewed.
  update atlas_private.ai_voice_sessions
  set started_at = now() - interval '5 minutes', last_activity_at = now() - interval '3 minutes',
      lease_expires_at = now() - interval '1 minute', hard_expires_at = now() + interval '55 minutes', created_at = now() - interval '5 minutes'
  where id = (v1->>'voice_session_id')::uuid;
  u := atlas_private.ai_voice_usage(bar);
  s := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'heartbeat'));
  s2 := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'tool'));
  v2 := public.atlas_ai_voice_session_start(bar, 'bartender', bar_conv, '{}'::jsonb, 60, false, 120);
  insert into s91_voice values ('without a heartbeat the lease lapses: the slot is free and the old session cannot be renewed',
    (u->>'live_sessions')::int = 0
    and s = '55000 voice_session_inactive: the voice session has ended'
    and s2 = '55000 voice_session_inactive: the voice session has ended'
    and (v2->>'live')::boolean and (v2->>'replaced_sessions')::int = 0,
    u::text || ' | ' || s || ' | ' || s2);

  -- Takeover ----------------------------------------------------------------------------
  m1 := public.atlas_ai_voice_session_start(mgr, 'manager', mgr_conv, '{}'::jsonb, 60);
  v3 := public.atlas_ai_voice_session_start(bar, 'bartender', bar_conv, '{}'::jsonb, 60, true, 120);
  insert into s91_voice values ('takeover ends the same user''s live session (replaced, audited) and reserves the new one',
    (v3->>'live')::boolean and (v3->>'replaced_sessions')::int = 1
    and exists (select 1 from atlas_private.ai_voice_sessions s where s.id = (v2->>'voice_session_id')::uuid
      and s.ended_at = now() and s.end_reason = 'replaced' and s.replaced_by = (v3->>'voice_session_id')::uuid)
    and (select count(*) from atlas_private.ai_voice_session_events e
         where e.voice_session_id = (v2->>'voice_session_id')::uuid and e.user_id = bar and e.event = 'replaced'
           and e.replaced_by = (v3->>'voice_session_id')::uuid and e.actor_role = 'bartender') = 1
    and (atlas_private.ai_voice_usage(bar)->>'live_sessions')::int = 1,
    v3::text);
  insert into s91_voice values ('takeover never touches another user''s session',
    exists (select 1 from atlas_private.ai_voice_sessions s where s.id = (m1->>'voice_session_id')::uuid
      and s.ended_at is null and s.end_reason is null and s.replaced_by is null)
    and (public.atlas_ai_voice_session_touch(m1->>'voice_session_id', mgr, 'manager', 'heartbeat')->>'live')::boolean
    and not exists (select 1 from atlas_private.ai_voice_session_events e where e.user_id = mgr), null);
  -- A bartender cannot end the manager's session by guessing its id.
  s := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', m1->>'voice_session_id', bar, 'bartender', 'end'));
  insert into s91_voice values ('a session is only reachable by its owner',
    s = '55000 voice_session_inactive: unknown voice session'
    and (atlas_private.ai_voice_usage(mgr)->>'live_sessions')::int = 1, s);

  s := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v2->>'voice_session_id', bar, 'bartender', 'tool'));
  s3 := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v2->>'voice_session_id', bar, 'bartender', 'heartbeat'));
  r := public.atlas_ai_voice_session_touch(v2->>'voice_session_id', bar, 'bartender', 'end');
  insert into s91_voice values ('the replaced session is told it was replaced; end stays idempotent',
    s = '55000 voice_session_replaced: live voice moved to another device'
    and s3 = s
    and r->>'end_reason' = 'replaced' and (r->>'replaced')::boolean and not (r->>'live')::boolean,
    s || ' | ' || s3);
  -- Its final transcript lines are kept for 5 minutes, then refused.
  r := public.atlas_ai_voice_session_touch(v2->>'voice_session_id', bar, 'bartender', 'append');
  update atlas_private.ai_voice_sessions set started_at = now() - interval '7 minutes', ended_at = now() - interval '6 minutes'
  where id = (v2->>'voice_session_id')::uuid;
  s2 := public.s91v_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v2->>'voice_session_id', bar, 'bartender', 'append'));
  update atlas_private.ai_voice_sessions set ended_at = now(), started_at = now() where id = (v2->>'voice_session_id')::uuid;
  insert into s91_voice values ('a replaced device may save its last transcript lines for 5 minutes, then it is told it was replaced',
    (r->>'replaced')::boolean and (r->>'appended_turns')::int = 1
    and s2 = '55000 voice_session_replaced: live voice moved to another device', r::text || ' | ' || s2);

  -- Quotas --------------------------------------------------------------------------------
  u := atlas_private.ai_voice_usage(bar);
  insert into s91_voice values ('replaced and lapsed sessions still count towards the daily sessions',
    (u->>'sessions_used')::int = 3, u::text);

  -- Daily sessions: the cap refuses a takeover and the live session is kept.
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"voice_sessions_per_day":3}');
  s := public.s91v_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L,%L::jsonb,60,true)', bar, 'bartender', bar_conv, '{}'));
  insert into s91_voice values ('the daily session cap refuses a takeover and nothing is ended',
    s = '53400 voice_quota_exceeded: daily_sessions'
    and exists (select 1 from atlas_private.ai_voice_sessions x where x.id = (v3->>'voice_session_id')::uuid and x.ended_at is null)
    and (atlas_private.ai_voice_usage(bar)->>'live_sessions')::int = 1
    and (select count(*) from atlas_private.ai_voice_session_events e where e.user_id = bar) = 1, s);
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"voice_sessions_per_day":20}');

  -- Daily minutes: a replaced session's minutes count up to the handoff.
  update atlas_private.ai_voice_sessions
  set started_at = now() - interval '40 minutes', last_activity_at = now() - interval '1 minute', created_at = now() - interval '40 minutes',
      lease_expires_at = now() + interval '1 minute', hard_expires_at = now() + interval '20 minutes'
  where id = (v3->>'voice_session_id')::uuid;
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"voice_minutes_per_day":45}');
  -- 4 minutes (lapsed v1) + 40 (v3, live) = 44 of 45: the takeover is allowed.
  s := public.s91v_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L,%L::jsonb,60,true)', bar, 'bartender', bar_conv, '{}'));
  u := atlas_private.ai_voice_usage(bar);
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"voice_minutes_per_day":44}');
  s2 := public.s91v_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L,%L::jsonb,60,true)', bar, 'bartender', bar_conv, '{}'));
  insert into s91_voice values ('minutes of a replaced session count up to the handoff; the minutes budget still refuses a takeover',
    s = 'ok' and (u->>'minutes_used_estimate')::int = 44
    and s2 = '53400 voice_quota_exceeded: daily_minutes'
    and exists (select 1 from atlas_private.ai_voice_sessions x where x.id = (v3->>'voice_session_id')::uuid
      and x.end_reason = 'replaced' and x.ended_at = now())
    and (atlas_private.ai_voice_usage(bar)->>'live_sessions')::int = 1,
    s || ' | ' || s2 || ' | ' || u::text);

  -- Constraint: only known end reasons.
  s4 := public.s91v_expect(format('update atlas_private.ai_voice_sessions set end_reason = %L where id = %L', 'kicked', v3->>'voice_session_id'));
  insert into s91_voice values ('end_reason accepts only client_end, mint_failed and replaced', s4 like '23514%', s4);
end
$service$;

reset role;

-- Browser roles cannot call the voice RPCs or read the audit ----------------------------

create role s91v_probe nologin;
grant authenticated, anon to s91v_probe;
set session authorization s91v_probe;

do $browser$
declare
  v_role text;
  v_all boolean := true;
  v_state text;
begin
  foreach v_role in array array['authenticated','anon'] loop
    execute format('set local role %I', v_role);
    foreach v_state in array array[
      public.s91v_expect('select public.atlas_ai_voice_session_start(null,null,null,null,null,true,null)'),
      public.s91v_expect('select public.atlas_ai_voice_session_touch(null,null,null,null)'),
      public.s91v_expect('select count(*) from atlas_private.ai_voice_session_events')
    ] loop
      if v_state not like '42501%' then v_all := false; raise notice '% -> %', v_role, v_state; end if;
    end loop;
  end loop;
  insert into s91_voice values ('browser roles cannot start, take over, touch or read voice sessions', v_all, null);
end
$browser$;

reset role;
reset session authorization;

select jsonb_build_object(
  's91_voice_preview', case when bool_and(passed) and count(*) = 18 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed)
    || case when passed then '{}'::jsonb else jsonb_build_object('detail', detail) end order by test_name)
) from s91_voice;

rollback;
