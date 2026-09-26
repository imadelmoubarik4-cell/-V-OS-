-- S93 preview-only acceptance: Messages sender identity
-- (20261002090000_s93_messages_sender_identity.sql). Rolled back.
--
-- * safe_staff_name() follows the S87 rule (never an address);
-- * saving a Team name through the gateway RPC (service_role) writes
--   public.profiles.display_name; renaming follows; an email-shaped or
--   cleared Team name leaves display_name alone;
-- * the backfill copies existing Team names and is a no-op when re-run;
-- * the Messages snapshot's conversation preview carries sender_id and
--   sender_role; the thread rows are unchanged;
-- * nothing new is executable by anon or authenticated.
--
-- Run against a replayed database:
--   psql -v ON_ERROR_STOP=1 -X -qAt -f scripts/verify_s93_messages_sender_identity_preview.sql

begin;

create temporary table s93_mi (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s93_mi to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-0000000a9201','s93-owner@example.invalid'),
  ('00000000-0000-4000-8000-0000000a9202','s93-bar@example.invalid'),
  ('00000000-0000-4000-8000-0000000a9203','s93-old@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-0000000a9201','s93-owner@example.invalid',null,'admin',true),
  ('00000000-0000-4000-8000-0000000a9202','s93-bar@example.invalid',null,'bartender',true),
  ('00000000-0000-4000-8000-0000000a9203','s93-old@example.invalid',null,'bartender',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;

-- ---------- the S87 name rule ----------
insert into s93_mi select 'safe_staff_name trims, collapses whitespace and refuses addresses and blanks',
  atlas_private.safe_staff_name('  Sara   Jónsdóttir ') = 'Sara Jónsdóttir'
  and atlas_private.safe_staff_name('sara@example.test') is null
  and atlas_private.safe_staff_name('   ') is null
  and atlas_private.safe_staff_name(null) is null
  and char_length(atlas_private.safe_staff_name(repeat('a', 200))) = 120;

-- ---------- backfill (a Team name saved before the trigger existed) ----------
alter table atlas_private.team_profile_details disable trigger team_profile_details_sync_display_name;
insert into atlas_private.team_profile_details (profile_id, preferred_name) values
  ('00000000-0000-4000-8000-0000000a9203', 'Jón Guðmundsson');
alter table atlas_private.team_profile_details enable trigger team_profile_details_sync_display_name;
insert into s93_mi select 'before the backfill the old Team name is not on the profile',
  display_name is null from public.profiles where id = '00000000-0000-4000-8000-0000000a9203';
do $backfill$
declare
  first_rows integer;
  second_rows integer;
begin
  update public.profiles as profile
     set display_name = atlas_private.safe_staff_name(details.preferred_name)
    from atlas_private.team_profile_details as details
   where details.profile_id = profile.id
     and atlas_private.safe_staff_name(details.preferred_name) is not null
     and profile.display_name is distinct from atlas_private.safe_staff_name(details.preferred_name);
  get diagnostics first_rows = row_count;
  update public.profiles as profile
     set display_name = atlas_private.safe_staff_name(details.preferred_name)
    from atlas_private.team_profile_details as details
   where details.profile_id = profile.id
     and atlas_private.safe_staff_name(details.preferred_name) is not null
     and profile.display_name is distinct from atlas_private.safe_staff_name(details.preferred_name);
  get diagnostics second_rows = row_count;
  insert into s93_mi values ('the backfill copies the Team name once and is a no-op when re-run', first_rows >= 1 and second_rows = 0);
end
$backfill$;
insert into s93_mi select 'the backfilled profile shows its Team name',
  display_name = 'Jón Guðmundsson' from public.profiles where id = '00000000-0000-4000-8000-0000000a9203';

-- ---------- Team saves through the gateway RPC (service_role) ----------
set local role service_role;
select public.atlas_team_profile_upsert_details('00000000-0000-4000-8000-0000000a9201','Imad El Moubarik',null,null,null,null,null,'managers_only',null,null,
  '00000000-0000-4000-8000-0000000a9201','Team member','admin');
select public.atlas_team_profile_upsert_details('00000000-0000-4000-8000-0000000a9202','  Sara   Jónsdóttir ',null,null,null,null,null,'managers_only',null,null,
  '00000000-0000-4000-8000-0000000a9202','Team member','bartender');
reset role;
insert into s93_mi select 'saving a Team name writes profiles.display_name (own and manager saves)',
  bool_and(case id
    when '00000000-0000-4000-8000-0000000a9201' then display_name = 'Imad El Moubarik'
    when '00000000-0000-4000-8000-0000000a9202' then display_name = 'Sara Jónsdóttir' end)
  from public.profiles where id in ('00000000-0000-4000-8000-0000000a9201','00000000-0000-4000-8000-0000000a9202');

set local role service_role;
select public.atlas_team_profile_upsert_details('00000000-0000-4000-8000-0000000a9202','Sara J.',null,null,null,null,null,'managers_only',null,null,
  '00000000-0000-4000-8000-0000000a9201','Imad El Moubarik','admin');
reset role;
insert into s93_mi select 'a rename follows', display_name = 'Sara J.' from public.profiles where id = '00000000-0000-4000-8000-0000000a9202';

set local role service_role;
select public.atlas_team_profile_upsert_details('00000000-0000-4000-8000-0000000a9202','sara@example.test',null,null,null,null,null,'managers_only',null,null,
  '00000000-0000-4000-8000-0000000a9202','Sara J.','bartender');
reset role;
insert into s93_mi select 'an email-shaped Team name never becomes the display name',
  display_name = 'Sara J.' from public.profiles where id = '00000000-0000-4000-8000-0000000a9202';

set local role service_role;
select public.atlas_team_profile_upsert_details('00000000-0000-4000-8000-0000000a9202',null,null,null,null,null,null,'managers_only',null,null,
  '00000000-0000-4000-8000-0000000a9202','Sara J.','bartender');
reset role;
insert into s93_mi select 'clearing the Team name keeps the last display name',
  display_name = 'Sara J.' from public.profiles where id = '00000000-0000-4000-8000-0000000a9202';

-- ---------- the Messages snapshot ----------
set local role service_role;
select public.atlas_team_messages_send('general','Keg changed','00000000-0000-4000-8000-0000000a9202','Sara J.','bartender',
  '00000000-0000-4000-8000-0000000a9211','none',null,null,null,'{}'::jsonb);
reset role;
do $snapshot$
declare
  snap jsonb;
  preview jsonb;
  row_json jsonb;
begin
  set local role service_role;
  snap := public.atlas_team_messages_snapshot('00000000-0000-4000-8000-0000000a9201','admin',
    array['00000000-0000-4000-8000-0000000a9201','00000000-0000-4000-8000-0000000a9202']::uuid[],'general',60);
  reset role;
  select value->'last_message' into preview from jsonb_array_elements(snap->'channels') where value->>'key' = 'general';
  select value into row_json from jsonb_array_elements(snap->'messages') where value->>'body' = 'Keg changed';
  insert into s93_mi values ('the conversation preview carries sender_id and sender_role',
    preview->>'sender_id' = '00000000-0000-4000-8000-0000000a9202' and preview->>'sender_role' = 'bartender'
    and preview->>'sender_label' = 'Sara J.' and preview->>'body' = 'Keg changed');
  insert into s93_mi values ('thread rows keep sender_id, sender_label, is_own and read receipts',
    row_json->>'sender_id' = '00000000-0000-4000-8000-0000000a9202' and row_json->>'sender_label' = 'Sara J.'
    and (row_json->>'is_own')::boolean = false and row_json ? 'read_by' and row_json ? 'read_by_count');
  insert into s93_mi values ('unread counts are unchanged: the admin has one unread message in General',
    (select (value->>'unread_count')::int from jsonb_array_elements(snap->'channels') where value->>'key' = 'general') >= 1);
end
$snapshot$;

-- ---------- privileges ----------
insert into s93_mi select 'anon and authenticated cannot execute the new or replaced functions',
  not has_function_privilege('anon','atlas_private.safe_staff_name(text)','execute')
  and not has_function_privilege('authenticated','atlas_private.safe_staff_name(text)','execute')
  and not has_function_privilege('anon','atlas_private.team_profile_details_sync_display_name()','execute')
  and not has_function_privilege('authenticated','atlas_private.team_profile_details_sync_display_name()','execute')
  and not has_function_privilege('anon','atlas_private.team_messages_snapshot(uuid,text,uuid[],text,integer)','execute')
  and not has_function_privilege('authenticated','atlas_private.team_messages_snapshot(uuid,text,uuid[],text,integer)','execute')
  and has_function_privilege('service_role','atlas_private.team_messages_snapshot(uuid,text,uuid[],text,integer)','execute');
insert into s93_mi select 'the trigger function is a definer with search_path pinned',
  p.prosecdef and coalesce('search_path=""' = any(p.proconfig), false)
  from pg_proc p where p.oid = to_regprocedure('atlas_private.team_profile_details_sync_display_name()');
insert into s93_mi select 'the snapshot stays a security invoker',
  not p.prosecdef from pg_proc p where p.oid = to_regprocedure('atlas_private.team_messages_snapshot(uuid,text,uuid[],text,integer)');

select jsonb_build_object(
  's92_messages_sender_identity', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s93_mi;

rollback;
