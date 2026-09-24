-- S88 preview-only Atlas AI background signals acceptance.
--
-- Requires an isolated replay database with the S88 migrations applied
-- (scripts/verify_full_migration_replay.sh). Seeds a manager and a bartender
-- inside one transaction, proves the browser boundary, manager-only access,
-- shadow Brain storage, fingerprint de-duplication and supersession, prints
-- one JSON verdict and rolls everything back.

begin;

create temporary table s88_sig (test_name text primary key, passed boolean not null, detail text) on commit drop;
grant all on table s88_sig to service_role, authenticated, anon;

create function public.s88_sig_expect(p_sql text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;
grant execute on function public.s88_sig_expect(text) to service_role, authenticated, anon;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000088811'::uuid,'s88-sig-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000088812'::uuid,'s88-sig-bar@example.invalid')) v(id,email);
update public.profiles set role='manager', active=true, display_name='S88 Signal Manager' where id='00000000-0000-4000-8000-000000088811';
update public.profiles set role='bartender', active=true, display_name='S88 Signal Bartender' where id='00000000-0000-4000-8000-000000088812';

-- 1. Static boundary -----------------------------------------------------------

insert into s88_sig
select 'atlas_ai_signals_upsert is service-role only, invoker and search_path pinned',
  bool_and(not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee = 0)
    and has_function_privilege('service_role', p.oid, 'execute')
    and not p.prosecdef
    and coalesce(p.proconfig @> array['search_path=""'], false))
  and count(*) = 1,
  count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'atlas_ai_signals_upsert';

create role s88_sig_probe nologin;
grant authenticated, anon to s88_sig_probe;
set session authorization s88_sig_probe;
do $browser$
declare
  v_role text;
  v_state text;
  v_all boolean := true;
begin
  foreach v_role in array array['authenticated','anon'] loop
    execute format('set local role %I', v_role);
    v_state := public.s88_sig_expect($q$select public.atlas_ai_signals_upsert('00000000-0000-4000-8000-000000088811','manager','[{"key":"x","title":"t"}]'::jsonb)$q$);
    if v_state <> '42501' then v_all := false; raise notice '% -> %', v_role, v_state; end if;
    reset role;
  end loop;
  insert into s88_sig values ('browser roles cannot call atlas_ai_signals_upsert', v_all, null);
end
$browser$;
reset session authorization;

-- 2. Behaviour as the service role ---------------------------------------------

set local role service_role;

do $service$
declare
  mgr constant uuid := '00000000-0000-4000-8000-000000088811';
  bar constant uuid := '00000000-0000-4000-8000-000000088812';
  signals jsonb := '[
    {"key":"operations.alerts:below_par:item-2","type":"shortage","severity":"high","audience":"staff",
     "title":"Tanqueray below par","summary":"2 bottles, par 6","subject_type":"inventory_item","subject_key":"item-2",
     "fingerprint":"a1b2c3d4","source_tool":"operations.alerts","evidence":[{"kind":"fact","label":"Stock","value":"2 bottles"}]},
    {"key":"data_quality.missing_par:missing:items-without-a-par-level","type":"data_quality","severity":"medium","audience":"manager",
     "title":"Items without a par level","summary":"234 items","fingerprint":"e5f6a7b8","source_tool":"data_quality.missing_par"}
  ]'::jsonb;
  r1 jsonb;
  r2 jsonb;
  r3 jsonb;
  v_key text := 'atlas-ai:signal:operations.alerts:below_par:item-2';
begin
  r1 := public.atlas_ai_signals_upsert(mgr, 'manager', signals);
  insert into s88_sig values ('manager signals are stored as active shadow Brain recommendations with evidence',
    (r1->>'count')::int = 2 and (r1->>'created')::int = 2 and (r1->>'refreshed')::int = 0
    and (select count(*) from atlas_private.brain_recommendations r
         where r.recommendation_key like 'atlas-ai:signal:%' and r.generated_by = 'atlas-ai/signals'
           and r.shadow_mode and r.status = 'active' and r.valid_until > now()) = 2
    and exists (select 1 from atlas_private.brain_recommendations r where r.recommendation_key = v_key
           and r.recommendation_type = 'shortage' and r.priority = 20 and r.suggested_action->>'audience' = 'staff')
    and exists (select 1 from atlas_private.brain_recommendation_evidence e
           join atlas_private.brain_recommendations r on r.id = e.recommendation_id
           where r.recommendation_key = v_key and e.source_kind = 'atlas_ai_signal' and e.value->>'fingerprint' = 'a1b2c3d4'),
    r1::text);

  r2 := public.atlas_ai_signals_upsert(mgr, 'manager', signals);
  insert into s88_sig values ('the same signal is refreshed, not repeated',
    (r2->>'created')::int = 0 and (r2->>'refreshed')::int = 2
    and (select count(*) from atlas_private.brain_recommendations r where r.recommendation_key = v_key) = 1
    and r2->'recommendation_ids' = r1->'recommendation_ids',
    r2::text);

  r3 := public.atlas_ai_signals_upsert(mgr, 'manager', jsonb_set(signals, '{0,fingerprint}', '"ffff0000"'));
  insert into s88_sig values ('a changed signal becomes a new version and supersedes the previous one',
    (r3->>'created')::int = 1 and (r3->>'refreshed')::int = 1
    and (select count(*) from atlas_private.brain_recommendations r where r.recommendation_key = v_key) = 2
    and (select r.status from atlas_private.brain_recommendations r where r.recommendation_key = v_key and r.version = 1) = 'superseded'
    and (select r.status from atlas_private.brain_recommendations r where r.recommendation_key = v_key and r.version = 2) = 'active',
    r3::text);

  insert into s88_sig values ('staff and invalid payloads are refused with contract error codes',
    public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', bar, 'bartender', signals::text)) = '42501'
    and public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', mgr, 'bartender', signals::text)) = '42501'
    and public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', mgr, 'manager', '[]')) = '22023'
    and public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', mgr, 'manager', '[{"key":"Bad Key!","title":"t"}]')) = '22023'
    and public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', mgr, 'manager', '[{"key":"ok","title":"t","severity":"urgent"}]')) = '22023'
    and public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', mgr, 'manager', '[{"key":"ok","title":"t","type":"assistant"}]')) = '22023'
    and public.s88_sig_expect(format('select public.atlas_ai_signals_upsert(%L,%L,%L::jsonb)', mgr, 'manager', '[{"key":"ok","title":" "}]')) = '22023',
    null);
end
$service$;

reset role;

select jsonb_build_object(
  's88_ai_signals_preview', case when bool_and(passed) and count(*) = 6 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed)
    || case when passed then '{}'::jsonb else jsonb_build_object('detail', detail) end order by test_name)
) from s88_sig;

rollback;
