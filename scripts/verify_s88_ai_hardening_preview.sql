-- S88 preview-only Atlas AI security hardening acceptance
-- (supabase/migrations/20260926106000_s88_ai_hardening.sql).
--
-- Requires an isolated replay database (scripts/verify_full_migration_replay.sh).
-- Seeds users inside one transaction, proves the atomic voice, upload and
-- turn reservations, the actor re-checks, the proposal policy and Brain
-- privacy, prints one JSON verdict and rolls everything back.

begin;

create temporary table s88_hardening (test_name text primary key, passed boolean not null, detail text) on commit drop;
grant all on table s88_hardening to service_role, authenticated, anon;

-- Runs dynamic SQL and returns 'ok' or '<SQLSTATE> <message>'.
create function public.s88h_expect(p_sql text)
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
grant execute on function public.s88h_expect(text) to service_role, authenticated, anon;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000089901'::uuid,'s88h-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000089902'::uuid,'s88h-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000089903'::uuid,'s88h-viewer@example.invalid'),
  ('00000000-0000-4000-8000-000000089904'::uuid,'s88h-gone@example.invalid')) v(id,email);
update public.profiles set role='manager', active=true, display_name='S88H Manager' where id='00000000-0000-4000-8000-000000089901';
update public.profiles set role='bartender', active=true, display_name='S88H Bartender' where id='00000000-0000-4000-8000-000000089902';
update public.profiles set role='viewer', active=true, display_name='S88H Viewer' where id='00000000-0000-4000-8000-000000089903';
update public.profiles set role='manager', active=false, display_name='S88H Former' where id='00000000-0000-4000-8000-000000089904';

-- Static boundary for the new objects ------------------------------------------------

insert into s88_hardening
select 'new ai tables have RLS, a service-role policy and no browser privilege',
  bool_and(c.relrowsecurity
    and not has_table_privilege('anon', c.oid, 'select,insert,update,delete')
    and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
    and exists (select 1 from pg_policies p where p.schemaname = 'atlas_private' and p.tablename = c.relname and p.roles = array['service_role']::name[]))
  and count(*) = 2, string_agg(c.relname, ',')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'atlas_private' and c.relname in ('ai_voice_sessions','ai_rate_events');

insert into s88_hardening
select 'hardening RPCs and helpers are service-role only, invoker and search_path pinned',
  bool_and(not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute')
    and not p.prosecdef
    and coalesce(p.proconfig @> array['search_path=""'], false))
  and count(*) = 13, count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in ('atlas_ai_voice_session_start','atlas_ai_voice_session_touch',
        'atlas_settings_venue_clock','atlas_integration_bind_browser'))
   or (n.nspname = 'atlas_private' and p.proname in ('ai_lock_user','ai_rate_take','ai_turns_used','ai_voice_usage',
        'ai_brain_preview','ai_action_allowed_roles','ai_voice_session_json','integration_assert_actor','integration_bind_browser'));

insert into s88_hardening
select 'role-only signatures are gone (venue clock, integration status/read/consume)',
  to_regprocedure('public.atlas_settings_venue_clock(text)') is null
  and to_regprocedure('public.atlas_integration_status(text)') is null
  and to_regprocedure('public.atlas_integration_read_credential(text,text)') is null
  and to_regprocedure('public.atlas_integration_consume_state(text,text)') is null, null;

set role service_role;

do $service$
declare
  mgr uuid := '00000000-0000-4000-8000-000000089901';
  bar uuid := '00000000-0000-4000-8000-000000089902';
  vwr uuid := '00000000-0000-4000-8000-000000089903';
  gone uuid := '00000000-0000-4000-8000-000000089904';
  mgr_conv uuid; bar_conv uuid; vwr_conv uuid;
  r jsonb; r2 jsonb; v1 jsonb; v2 jsonb;
  s text; s2 text; s3 text;
  i integer;
  ok_count integer;
  a_team uuid; a_ok uuid; rec uuid;
begin
  mgr_conv := (public.atlas_ai_conversation_create(mgr, 'manager', 'Hardening', '{}'::jsonb)->>'id')::uuid;
  bar_conv := (public.atlas_ai_conversation_create(bar, 'bartender', 'Hardening', '{}'::jsonb)->>'id')::uuid;
  vwr_conv := (public.atlas_ai_conversation_create(vwr, 'viewer', 'Hardening', '{}'::jsonb)->>'id')::uuid;

  -- F1/F3: Atlas AI disabled (the default) refuses interactive runs and voice
  s := public.s88h_expect(format('select public.atlas_ai_run_start(%L,%L,null,%L)', bar, 'bartender', 'text'));
  s2 := public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', bar, 'bartender', bar_conv));
  insert into s88_hardening values ('disabled Atlas AI refuses turns and voice sessions atomically (not_configured)',
    s like '55000 not_configured:%' and s2 like '55000 not_configured:%'
    and public.s88h_expect(format('select public.atlas_ai_run_start(%L,%L,null,%L)', mgr, 'manager', 'background')) = 'ok', s || ' | ' || s2);

  perform public.atlas_ai_settings_set(mgr, 'manager', '{"enabled":true,"daily_turn_limit_per_user":50}');

  -- Settings: new quota fields
  r := public.atlas_ai_settings_get(bar, 'bartender');
  insert into s88_hardening values ('settings expose voice and upload quotas with safe defaults',
    (r->>'voice_sessions_per_day')::int = 20 and (r->>'voice_minutes_per_day')::int = 60
    and (r->>'max_concurrent_voice_sessions')::int = 1 and (r->>'upload_bytes_per_day')::bigint = 262144000
    and (r->>'upload_files_per_day')::int = 100, r::text);
  insert into s88_hardening values ('quota settings are validated and manager-only',
    public.s88h_expect(format('select public.atlas_ai_settings_set(%L,%L,%L)', mgr, 'manager', '{"max_concurrent_voice_sessions":0}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_settings_set(%L,%L,%L)', mgr, 'manager', '{"upload_bytes_per_day":1}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_settings_set(%L,%L,%L)', mgr, 'manager', '{"voice_seconds":5}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_settings_set(%L,%L,%L)', bar, 'bartender', '{"voice_sessions_per_day":999}')) like '42501%'
    and (public.atlas_ai_settings_set(mgr, 'manager', '{"voice_sessions_per_day":3,"voice_minutes_per_day":30}')->>'voice_sessions_per_day')::int = 3, null);

  -- F1: voice session reservation
  v1 := public.atlas_ai_voice_session_start(bar, 'bartender', bar_conv, '{"realtime":"configured"}'::jsonb, 6);
  insert into s88_hardening values ('a mint reserves a live voice session and a voice run in one transaction',
    (v1->>'live')::boolean and v1->>'conversation_id' = bar_conv::text
    and exists (select 1 from atlas_private.ai_runs r where r.id = (v1->>'run_id')::uuid and r.channel = 'voice' and r.user_id = bar)
    and (select hard_expires_at - started_at from atlas_private.ai_voice_sessions where id = (v1->>'voice_session_id')::uuid) = interval '60 minutes'
    and (v1->'limits'->>'sessions_used')::int = 1, v1::text);

  s := public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', bar, 'bartender', bar_conv));
  insert into s88_hardening values ('a second live session is refused by the concurrency cap', s = '53400 voice_quota_exceeded: concurrent', s);

  insert into s88_hardening values ('voice sessions are owner-scoped and conversations owner-checked',
    public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', vwr, 'viewer', 'tool')) = '55000 voice_session_inactive: unknown voice session'
    and public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', vwr, 'viewer', bar_conv)) like 'P0002%'
    and public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', gone, 'manager', null)) like '42501%', null);

  r := public.atlas_ai_voice_session_touch(v1->>'voice_session_id', bar, 'bartender', 'activate', 'sess_s88h_provider');
  r2 := public.atlas_ai_voice_session_touch('sess_s88h_provider', bar, 'bartender', 'tool');
  insert into s88_hardening values ('the provider session id resolves to the same owned session; tools extend the lease',
    r->>'provider_session_id' = 'sess_s88h_provider' and r2->>'voice_session_id' = v1->>'voice_session_id'
    and (r2->>'tool_calls')::int = 1, r2::text);

  -- F11: per-minute limits on voice tools
  ok_count := 1;
  for i in 1..30 loop
    if public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'tool')) = 'ok' then
      ok_count := ok_count + 1;
    end if;
  end loop;
  s := public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'tool'));
  insert into s88_hardening values ('voice tool calls are limited to 30 per user per minute (durable)',
    ok_count = 30 and s like '53400 rate_limited:%', ok_count::text || ' ' || s);

  -- End: tools refused, final append allowed, slot freed
  r := public.atlas_ai_voice_session_touch(v1->>'voice_session_id', bar, 'bartender', 'end');
  r2 := public.atlas_ai_voice_session_touch(v1->>'voice_session_id', bar, 'bartender', 'end');
  insert into s88_hardening values ('ending is idempotent, stops tools, keeps a short append grace and frees the slot',
    not (r->>'live')::boolean and r->>'end_reason' = 'client_end' and r2->>'ended_at' = r->>'ended_at'
    and public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'tool')) = '55000 voice_session_inactive: the voice session has ended'
    and public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'append')) = 'ok'
    and public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', bar, 'bartender', bar_conv)) = 'ok', r::text);

  update atlas_private.ai_voice_sessions set ended_at = started_at + interval '1 second', end_reason = 'client_end'
  where user_id = bar and ended_at is null;
  -- Ended long ago: no more appends.
  update atlas_private.ai_voice_sessions set started_at = now() - interval '20 minutes', ended_at = now() - interval '10 minutes'
  where id = (v1->>'voice_session_id')::uuid;
  insert into s88_hardening values ('appends are refused once the grace period after the end has passed',
    public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v1->>'voice_session_id', bar, 'bartender', 'append')) = '55000 voice_session_inactive: the voice session has ended', null);

  -- Daily session cap (3): two sessions used so far
  v2 := public.atlas_ai_voice_session_start(bar, 'bartender', bar_conv);
  perform public.atlas_ai_voice_session_touch(v2->>'voice_session_id', bar, 'bartender', 'end');
  s := public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', bar, 'bartender', bar_conv));
  insert into s88_hardening values ('the daily voice-session cap refuses further mints',
    s = '53400 voice_quota_exceeded: daily_sessions', s);

  -- A failed mint does not count against the cap
  update atlas_private.ai_voice_sessions set end_reason = 'mint_failed' where id = (v2->>'voice_session_id')::uuid;
  insert into s88_hardening values ('a released (mint_failed) reservation does not count',
    public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', bar, 'bartender', bar_conv)) = 'ok', null);

  -- Estimated minutes budget (30): a manager session open for 45 minutes
  v2 := public.atlas_ai_voice_session_start(mgr, 'manager', mgr_conv);
  update atlas_private.ai_voice_sessions
  set started_at = now() - interval '45 minutes', last_activity_at = now() - interval '1 minute',
      lease_expires_at = now() + interval '5 minutes', hard_expires_at = now() + interval '15 minutes'
  where id = (v2->>'voice_session_id')::uuid;
  perform public.atlas_ai_voice_session_touch(v2->>'voice_session_id', mgr, 'manager', 'end');
  s := public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', mgr, 'manager', mgr_conv));
  r := public.atlas_ai_rate_check(mgr, 'manager');
  insert into s88_hardening values ('the estimated daily minutes budget refuses further mints and is shown in rate_check',
    s = '53400 voice_quota_exceeded: daily_minutes' and (r->'voice'->>'minutes_used_estimate')::int >= 45
    and (r->'voice'->>'minutes_limit')::int = 30, s || ' ' || r::text);

  -- Durable mint throttle (per minute)
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"voice_sessions_per_day":100,"max_concurrent_voice_sessions":10,"voice_minutes_per_day":1440}');
  ok_count := 0;
  for i in 1..3 loop
    if public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L,%L,2)', vwr, 'viewer', vwr_conv, '{}')) = 'ok' then
      ok_count := ok_count + 1;
    end if;
  end loop;
  insert into s88_hardening values ('the mint throttle is durable per user per minute',
    ok_count = 2 and public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L,%L,2)', vwr, 'viewer', vwr_conv, '{}')) like '53400 rate_limited:%', ok_count::text);

  -- F11: transcript appends are limited per user per minute
  v2 := (select atlas_private.ai_voice_session_json(vs) from atlas_private.ai_voice_sessions vs
         where vs.user_id = vwr and vs.ended_at is null order by vs.started_at desc limit 1);
  ok_count := 0;
  for i in 1..31 loop
    if public.s88h_expect(format('select public.atlas_ai_voice_session_touch(%L,%L,%L,%L)', v2->>'voice_session_id', vwr, 'viewer', 'append')) = 'ok' then
      ok_count := ok_count + 1;
    end if;
  end loop;
  insert into s88_hardening values ('voice transcript appends are limited to 30 per user per minute (durable)', ok_count = 30, ok_count::text);

  -- F10: the OAuth callback re-checks the initiating user
  perform public.atlas_integration_begin('google-drive', repeat('9a', 32), null, null, null, '#settings', mgr, 'S88H Manager', 'manager');
  perform public.atlas_integration_bind_browser('google-drive', repeat('9a', 32), repeat('9b', 32));
  perform public.atlas_integration_begin('tiktok', repeat('9c', 32), null, null, null, '#settings', mgr, 'S88H Manager', 'manager');
  perform public.atlas_integration_bind_browser('tiktok', repeat('9c', 32), repeat('9d', 32));
  update public.profiles set role = 'bartender' where id = mgr;
  r := public.atlas_integration_consume_state('google-drive', repeat('9a', 32), repeat('9b', 32));
  update public.profiles set role = 'manager', active = false where id = mgr;
  r2 := public.atlas_integration_consume_state('tiktok', repeat('9c', 32), repeat('9d', 32));
  update public.profiles set active = true where id = mgr;
  insert into s88_hardening values ('an OAuth state started by a manager who was demoted or deactivated is consumed but refused',
    (r->>'actor_allowed')::boolean is false and not (r ? 'actor_id') and not (r ? 'verifier_ciphertext')
    and (r2->>'actor_allowed')::boolean is false
    and public.atlas_integration_consume_state('google-drive', repeat('9a', 32), repeat('9b', 32)) is null
    and public.s88h_expect(format('select public.atlas_integration_begin(%L,%L,null,null,null,%L,%L,%L,%L)', 'google-drive', repeat('9e', 32), '#settings', gone, 'x', 'manager')) like '42501%',
    r::text || ' ' || r2::text);

  -- F3: atomic turn reservation, including voice mints
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"daily_turn_limit_per_user":3}');
  -- The viewer has used 2 turns (two voice mints).
  s := public.s88h_expect(format('select public.atlas_ai_run_start(%L,%L,%L,%L)', vwr, 'viewer', vwr_conv, 'text'));
  s2 := public.s88h_expect(format('select public.atlas_ai_run_start(%L,%L,%L,%L)', vwr, 'viewer', vwr_conv, 'voice_note'));
  s3 := public.s88h_expect(format('select public.atlas_ai_run_start(%L,%L,%L,%L)', vwr, 'viewer', vwr_conv, 'voice_tool'));
  insert into s88_hardening values ('run start reserves the last turn, then refuses; voice tools are not counted',
    s = 'ok' and s2 = '53400 rate_limited: daily Atlas AI limit reached' and s3 = 'ok'
    and atlas_private.ai_turns_used(vwr) = 3
    and public.s88h_expect(format('select public.atlas_ai_voice_session_start(%L,%L,%L)', vwr, 'viewer', vwr_conv)) like '53400 rate_limited:%', s || ' | ' || s2);
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"daily_turn_limit_per_user":200}');

  -- F2: upload quotas at registration
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"upload_files_per_day":2,"upload_bytes_per_day":2097152}');
  s := public.s88h_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,1048576,%L)', vwr, 'viewer', vwr || '/unsorted/00000000-0000-4000-8000-000000089a01.pdf', 'application/pdf', 'pdf'));
  s2 := public.s88h_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,1500000,%L)', vwr, 'viewer', vwr || '/unsorted/00000000-0000-4000-8000-000000089a02.pdf', 'application/pdf', 'pdf'));
  perform public.atlas_ai_media_register(vwr, 'viewer', null, vwr || '/unsorted/00000000-0000-4000-8000-000000089a03.pdf', 'application/pdf', 1000, 'pdf');
  update atlas_private.ai_media set deleted_at = now() where user_id = vwr;
  s3 := public.s88h_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,10,%L)', vwr, 'viewer', vwr || '/unsorted/00000000-0000-4000-8000-000000089a04.pdf', 'application/pdf', 'pdf'));
  insert into s88_hardening values ('per-user daily upload bytes and files are enforced atomically; deleted media still counts',
    s = 'ok' and s2 = '53400 upload_quota_exceeded: daily_bytes' and s3 = '53400 upload_quota_exceeded: daily_files'
    and public.s88h_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,10,%L)', bar, 'bartender', bar || '/unsorted/00000000-0000-4000-8000-000000089a05.pdf', 'application/pdf', 'pdf')) = 'ok'
    and (public.atlas_ai_rate_check(vwr, 'viewer')->'uploads'->>'files_used')::int = 2, s || ' | ' || s2 || ' | ' || s3);

  -- F7: decision memory needs a verified actor
  insert into s88_hardening values ('decision memory search refuses a missing or mismatched actor',
    public.s88h_expect(format('select public.atlas_ai_memory_search(%L,5,%L,null)', 'x', 'manager')) like '42501%'
    and public.s88h_expect(format('select public.atlas_ai_memory_search(%L,5,%L)', 'x', 'admin')) like '42501%'
    and public.s88h_expect(format('select public.atlas_ai_memory_search(%L,5,%L,%L)', 'x', 'manager', bar)) like '42501%'
    and public.s88h_expect(format('select public.atlas_ai_memory_search(%L,5,%L,%L)', 'x', 'manager', gone)) like '42501%'
    and jsonb_typeof(public.atlas_ai_memory_search('x', 5, 'manager', mgr)) = 'array', null);

  -- F7: venue clock re-checks the profile
  insert into s88_hardening values ('the venue clock re-checks the actor profile',
    public.atlas_settings_venue_clock('viewer', vwr) ? 'timezone'
    and public.s88h_expect(format('select public.atlas_settings_venue_clock(%L,%L)', 'admin', vwr)) like '42501%'
    and public.s88h_expect(format('select public.atlas_settings_venue_clock(%L,%L)', 'manager', gone)) like '42501%', null);

  -- F7: proposal kinds and required roles
  insert into s88_hardening values ('action_create accepts only known kinds and required roles within the kind policy (always admin + manager)',
    public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'x.y', 't', '{}', '{"a":1}', '{admin,manager}')) = '22023 invalid_arguments: unknown proposal kind'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'stock_count.draft', 't', '{}', '{"a":1}', '{viewer}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'stock_count.draft', 't', '{}', '{"a":1}', '{bartender}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'stock_count.draft', 't', '{}', '{"a":1}', '{admin,manager,viewer}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'purchase_order.create', 't', '{}', '{"a":1}', '{admin,manager,bartender}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'team_message.send', 't', '{}', '{"channel_key":"announcements","body":"x"}', '{admin,manager,bartender}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'purchase_order.create', 't', '{}', '{"a":1}', '{}')) like '22023%'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'team_message.send', 't', '{}', '{"channel_key":"general","body":"x"}', '{admin,manager,bartender}')) = 'ok'
    and public.s88h_expect(format('select public.atlas_ai_action_create(%L,%L,%L,null,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, 'settings.suggestion', 't', '{}', '{"a":1}', '{admin,manager}')) = 'ok', null);

  -- F12: team message drafts are not copied to Brain
  a_team := (public.atlas_ai_action_create(bar, 'bartender', bar_conv, null, 'team_message.send', 'Message to #general',
    '{"headline":"Message to #general","lines":[{"label":"Message","detail":"PRIVATEDRAFTBODY my shift swap with Anna"}],"recipients":["Everyone with access to #general"],"will_change":["posted"],"will_not_change":["nothing else"],"route":"#team?channel=general"}'::jsonb,
    '{"channel_key":"general","body":"PRIVATEDRAFTBODY my shift swap with Anna"}'::jsonb, array['admin','manager','bartender'])->>'id')::uuid;
  r := public.atlas_ai_record_proposal(a_team, bar, 'bartender',
    '[{"tool":"team.prepare_message","label":"Draft message","kind":"interpretation","value":"PRIVATEDRAFTBODY my shift swap with Anna"}]'::jsonb,
    'team_channel', 'general', 'Drafted: PRIVATEDRAFTBODY my shift swap with Anna');
  rec := (r->>'brain_recommendation_id')::uuid;
  insert into s88_hardening values ('Brain keeps a neutral summary of a team message proposal, never the draft text',
    rec is not null
    and (select b.suggested_action::text || b.summary || b.title || b.explanation from atlas_private.brain_recommendations b where b.id = rec) not like '%PRIVATEDRAFTBODY%'
    and not exists (select 1 from atlas_private.brain_recommendation_evidence e where e.recommendation_id = rec and e.value::text like '%PRIVATEDRAFTBODY%')
    and (select (b.suggested_action->'preview'->>'private_content_withheld')::boolean from atlas_private.brain_recommendations b where b.id = rec)
    and (select b.suggested_action->'preview'->>'headline' from atlas_private.brain_recommendations b where b.id = rec) = 'Message to #general'
    and (select a.command->>'body' from atlas_private.ai_actions a where a.id = a_team) like 'PRIVATEDRAFTBODY%', r::text);

  a_ok := (public.atlas_ai_action_create(mgr, 'manager', mgr_conv, null, 'purchase_order.create', 'Order Pinot',
    '{"headline":"Draft purchase order","summary":"3 cases PUBLICPREVIEW"}'::jsonb, '{"p_id":"x"}'::jsonb, array['manager','admin'])->>'id')::uuid;
  r := public.atlas_ai_record_proposal(a_ok, mgr, 'manager', '[]'::jsonb, null, null, null);
  insert into s88_hardening values ('other proposals keep their preview in Brain; required roles are stored normalised',
    (select b.suggested_action->'preview'->>'summary' from atlas_private.brain_recommendations b where b.id = (r->>'brain_recommendation_id')::uuid) = '3 cases PUBLICPREVIEW'
    and (select required_roles from atlas_private.ai_actions where id = a_ok) = array['admin','manager']::text[], r::text);
end
$service$;

reset role;

-- Browser roles cannot call the new RPCs ----------------------------------------------

create role s88h_probe nologin;
grant authenticated, anon to s88h_probe;
set session authorization s88h_probe;

do $browser$
declare
  v_role text;
  v_all boolean := true;
  v_state text;
begin
  foreach v_role in array array['authenticated','anon'] loop
    execute format('set local role %I', v_role);
    foreach v_state in array array[
      public.s88h_expect('select public.atlas_ai_voice_session_start(null,null,null)'),
      public.s88h_expect('select public.atlas_ai_voice_session_touch(null,null,null,null)'),
      public.s88h_expect('select public.atlas_settings_venue_clock(null,null)'),
      public.s88h_expect('select public.atlas_integration_bind_browser(null,null,null)'),
      public.s88h_expect('select count(*) from atlas_private.ai_voice_sessions'),
      public.s88h_expect('select count(*) from atlas_private.ai_rate_events')
    ] loop
      if v_state not like '42501%' then v_all := false; raise notice '% -> %', v_role, v_state; end if;
    end loop;
  end loop;
  insert into s88_hardening values ('browser roles cannot call the hardening RPCs or read the new tables', v_all, null);
end
$browser$;

reset role;
reset session authorization;

select jsonb_build_object(
  's88_ai_hardening_preview', case when bool_and(passed) and count(*) = 27 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed)
    || case when passed then '{}'::jsonb else jsonb_build_object('detail', detail) end order by test_name)
) from s88_hardening;

rollback;
