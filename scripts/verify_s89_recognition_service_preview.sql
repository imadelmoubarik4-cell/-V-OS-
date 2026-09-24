-- S89 preview-only recognition service acceptance. Rolled back.
--
-- Covers: recognition limits (hourly identifications, daily vision reads and
-- the venue vision budget only when Atlas AI is enabled), the upload quota
-- on recognition media, idempotent replay by client_request_id (owner or
-- manager only), Brain decisions for AI-originated catalogue requests
-- (recorded once, only by the deciding manager, never for other sources),
-- and that the recognition definer still cannot write or run writers.

begin;

create temporary table s89_rs (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s89_rs to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-00000008a901','s89-rs-mgr@example.invalid'),
  ('00000000-0000-4000-8000-00000008a902','s89-rs-bar@example.invalid'),
  ('00000000-0000-4000-8000-00000008a903','s89-rs-bar2@example.invalid'),
  ('00000000-0000-4000-8000-00000008a904','s89-rs-mgr2@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-00000008a901','s89-rs-mgr@example.invalid','S89 RS manager','manager',true),
  ('00000000-0000-4000-8000-00000008a902','s89-rs-bar@example.invalid','S89 RS bartender','bartender',true),
  ('00000000-0000-4000-8000-00000008a903','s89-rs-bar2@example.invalid','S89 RS bartender 2','bartender',true),
  ('00000000-0000-4000-8000-00000008a904','s89-rs-mgr2@example.invalid','S89 RS manager 2','manager',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.inventory_items (id,name,category,quantity,unit,size_ml,active) values
  ('00000000-0000-4000-8000-00000008a911','S89 RS Giffard Vanille Syrup','Syrups',0,'bottles',1000,true);
create temporary table s89_rs_stock on commit drop as
  select (select coalesce(sum(quantity),0) from public.inventory_items) as total, (select count(*) from public.inventory_movements) as movements;

insert into atlas_private.ai_settings (id) values (true) on conflict (id) do nothing;
update atlas_private.ai_settings set enabled = false, recognition_identifications_per_hour = 2, recognition_vision_per_day = 1,
  recognition_vision_budget_usd_per_day = 0.01, upload_files_per_day = 100;

-- 1. Limits.
insert into s89_rs select 'limits report the settings and no vision while Atlas AI is off',
  (l->>'vision_enabled')::boolean = false and (l->'identifications'->>'per_hour')::int = 2 and (l->>'stock_changed')::boolean = false
from (select public.atlas_recognition_limits('00000000-0000-4000-8000-00000008a902','bartender', true, null) l) x;
select public.atlas_recognition_record(jsonb_build_object('client_request_id','00000000-0000-4000-8000-00000008ab01','mode','identify',
  'extractor_version','rx-1','scorer_version','rs-1','status','completed','vision_model','test-vision','vision_cost_usd',0.02,
  'detections', jsonb_build_array(jsonb_build_object('detection_index',0,'extracted','{}'::jsonb,'normalized','{}'::jsonb,
    'field_confidence', jsonb_build_object('inventory_match',91),'band','medium',
    'candidates', jsonb_build_array(jsonb_build_object('rank',1,'item_id','00000000-0000-4000-8000-00000008a911','score',0.91,
      'features', jsonb_build_object('evidence', jsonb_build_array()),'explanation','Candidate 1 — S89 RS Giffard Vanille Syrup, 91%'))))),
  '00000000-0000-4000-8000-00000008a902','S89 RS bartender','bartender');
do $probe$
declare
  message text;
begin
  update atlas_private.ai_settings set enabled = true;
  begin
    perform public.atlas_recognition_limits('00000000-0000-4000-8000-00000008a902','bartender', true, null);
    message := 'none';
  exception when others then message := sqlerrm;
  end;
  insert into s89_rs values ('with Atlas AI on, the per-user daily vision limit is enforced', message = 'rate_limited: recognition_vision_daily');
  begin
    perform public.atlas_recognition_limits('00000000-0000-4000-8000-00000008a903','bartender', true, null);
    message := 'none';
  exception when others then message := sqlerrm;
  end;
  insert into s89_rs values ('the venue vision budget applies to everyone', message = 'rate_limited: recognition_budget');
  begin
    perform public.atlas_recognition_limits('00000000-0000-4000-8000-00000008a903','bartender', false, null);
    message := 'none';
  exception when others then message := sqlerrm;
  end;
  insert into s89_rs values ('barcode and search stay available when vision is spent', message = 'none');
  update atlas_private.ai_settings set enabled = false;
end $probe$;
select public.atlas_recognition_record(jsonb_build_object('client_request_id','00000000-0000-4000-8000-00000008ab02','mode','count',
  'extractor_version','none','scorer_version','rs-1','status','barcode_only','detections','[]'::jsonb),
  '00000000-0000-4000-8000-00000008a902','S89 RS bartender','bartender');
do $probe$
declare
  message text;
begin
  perform public.atlas_recognition_limits('00000000-0000-4000-8000-00000008a902','bartender', false, null);
  message := 'none';
exception when others then message := sqlerrm;
  insert into s89_rs values ('the hourly identification limit is enforced', message = 'rate_limited: recognition_hourly');
  return;
end $probe$;
insert into s89_rs select 'the hourly identification limit is enforced', false
where not exists (select 1 from s89_rs where test_name = 'the hourly identification limit is enforced');

-- 2. Upload quota on recognition media.
update atlas_private.ai_settings set upload_files_per_day = 1;
select public.atlas_recognition_register_media(jsonb_build_object('path','00000000-0000-4000-8000-00000008a903/unsorted/00000000-0000-4000-8000-00000008ac01.jpg',
  'mime','image/jpeg','bytes',1000,'kind','image'), '00000000-0000-4000-8000-00000008a903','bartender');
insert into s89_rs select 'recognition media expire within 30 days',
  (select expires_at between now() + interval '29 days' and now() + interval '30 days 1 minute' and purpose = 'recognition'
   from atlas_private.ai_media where path = '00000000-0000-4000-8000-00000008a903/unsorted/00000000-0000-4000-8000-00000008ac01.jpg');
do $probe$
declare
  message text;
begin
  perform public.atlas_recognition_register_media(jsonb_build_object('path','00000000-0000-4000-8000-00000008a903/unsorted/00000000-0000-4000-8000-00000008ac02.jpg',
    'mime','image/jpeg','bytes',1000,'kind','image'), '00000000-0000-4000-8000-00000008a903','bartender');
  message := 'none';
exception when others then message := sqlerrm;
  insert into s89_rs values ('the daily upload quota applies to recognition photos', message = 'upload_quota_exceeded: daily_files');
  return;
end $probe$;
update atlas_private.ai_settings set upload_files_per_day = 100;

-- 3. Replay by client_request_id.
insert into s89_rs select 'a recorded request replays with detections, candidates and item payloads',
  (r->>'mode') = 'identify' and jsonb_array_length(r->'detections') = 1
  and (r->'detections'->0->'candidates'->0->'item'->>'name') = 'S89 RS Giffard Vanille Syrup'
  and (r->'detections'->0->'candidates'->0->>'score')::numeric = 0.91 and (r->>'stock_changed')::boolean = false
from (select public.atlas_recognition_request_get('00000000-0000-4000-8000-00000008ab01','00000000-0000-4000-8000-00000008a902','bartender') r) x;
insert into s89_rs select 'an unknown request id replays nothing',
  public.atlas_recognition_request_get('00000000-0000-4000-8000-00000008abff','00000000-0000-4000-8000-00000008a902','bartender') is null;
insert into s89_rs select 'a manager may replay a staff request',
  public.atlas_recognition_request_get('00000000-0000-4000-8000-00000008ab01','00000000-0000-4000-8000-00000008a901','manager') is not null;
do $probe$ begin
  perform public.atlas_recognition_request_get('00000000-0000-4000-8000-00000008ab01','00000000-0000-4000-8000-00000008a903','bartender');
  insert into s89_rs values ('another bartender cannot replay the request', false);
exception when insufficient_privilege then
  insert into s89_rs values ('another bartender cannot replay the request', true);
end $probe$;

-- 4. Brain decision for an AI-originated catalogue request.
create temporary table s89_rs_ids (name text primary key, id uuid) on commit drop;
insert into s89_rs_ids select 'action', (public.atlas_ai_action_create('00000000-0000-4000-8000-00000008a902','bartender', null, null,
  'catalog.alias', 'Add alias "Giffard Vanille 1L"', '{}'::jsonb, '{"alias":"Giffard Vanille 1L"}'::jsonb,
  array['admin','manager','bartender'])->>'id')::uuid;
select public.atlas_ai_record_proposal((select id from s89_rs_ids where name='action'), '00000000-0000-4000-8000-00000008a902','bartender',
  '[]'::jsonb, 'inventory_item', '00000000-0000-4000-8000-00000008a911', 'Alias proposal');
insert into s89_rs_ids select 'ai_request', (public.atlas_catalog_request_create('alias', '00000000-0000-4000-8000-00000008a911',
  jsonb_build_object('alias','Giffard Vanille 1L','alias_kind','product_name'), '{}'::jsonb, 'ai_proposal',
  (select id from s89_rs_ids where name='action'), null, null, 's89-rs-ai-alias', false,
  '00000000-0000-4000-8000-00000008a902','S89 RS bartender')->>'id')::uuid;
insert into s89_rs_ids select 'plain_request', (public.atlas_catalog_request_create('alias', '00000000-0000-4000-8000-00000008a911',
  jsonb_build_object('alias','Vanille Giffard','alias_kind','product_name'), '{}'::jsonb, 'recognition',
  null, null, null, 's89-rs-plain-alias', false, '00000000-0000-4000-8000-00000008a902','S89 RS bartender')->>'id')::uuid;
insert into s89_rs select 'an undecided AI request is not recorded yet',
  (public.atlas_catalog_record_ai_decision((select id from s89_rs_ids where name='ai_request'),
    '00000000-0000-4000-8000-00000008a901','S89 RS manager')->>'reason') = 'not_decided';
select public.atlas_catalog_request_decide((select id from s89_rs_ids where name='ai_request'), 'approve', 'Same product', null, '{}'::jsonb,
  '00000000-0000-4000-8000-00000008a901','S89 RS manager');
select public.atlas_catalog_request_decide((select id from s89_rs_ids where name='plain_request'), 'reject', 'Not needed', null, '{}'::jsonb,
  '00000000-0000-4000-8000-00000008a901','S89 RS manager');
do $probe$ begin
  perform public.atlas_catalog_record_ai_decision((select id from s89_rs_ids where name='ai_request'),
    '00000000-0000-4000-8000-00000008a904','S89 RS manager 2');
  insert into s89_rs values ('only the deciding manager records the Brain decision', false);
exception when insufficient_privilege then
  insert into s89_rs values ('only the deciding manager records the Brain decision', true);
end $probe$;
do $probe$ begin
  perform public.atlas_catalog_record_ai_decision((select id from s89_rs_ids where name='ai_request'),
    '00000000-0000-4000-8000-00000008a902','S89 RS bartender');
  insert into s89_rs values ('a bartender cannot record a catalogue decision', false);
exception when insufficient_privilege then
  insert into s89_rs values ('a bartender cannot record a catalogue decision', true);
end $probe$;
create temporary table s89_rs_first on commit drop as
  select public.atlas_catalog_record_ai_decision((select id from s89_rs_ids where name='ai_request'),
    '00000000-0000-4000-8000-00000008a901','S89 RS manager') as r;
insert into s89_rs select 'the approval of an AI-originated alias is written to the Brain',
  (r->>'recorded')::boolean and (r->>'idempotent')::boolean = false
  and exists (select 1 from atlas_private.brain_decisions d
              where d.client_request_id = 'catalog-request:' || (select id from s89_rs_ids where name='ai_request') || ':decision'
                and d.decision = 'accept' and d.reason_code = 'catalog_alias_applied'
                and d.decided_by = '00000000-0000-4000-8000-00000008a901')
from s89_rs_first;
insert into s89_rs select 'recording again is idempotent',
  (r->>'idempotent')::boolean
  and (select count(*) from atlas_private.brain_decisions d
       where d.client_request_id = 'catalog-request:' || (select id from s89_rs_ids where name='ai_request') || ':decision') = 1
from (select public.atlas_catalog_record_ai_decision((select id from s89_rs_ids where name='ai_request'),
  '00000000-0000-4000-8000-00000008a901','S89 RS manager') r) x;
insert into s89_rs select 'requests that did not come from Atlas AI are not written to the Brain',
  (public.atlas_catalog_record_ai_decision((select id from s89_rs_ids where name='plain_request'),
    '00000000-0000-4000-8000-00000008a901','S89 RS manager')->>'reason') = 'not_ai_originated';

-- 5. Privileges.
insert into s89_rs select 'the new recognition functions run as the definer',
  (select pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='atlas_private' and p.proname='recognition_limits') = 'atlas_recognition_definer'
  and (select pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='atlas_private' and p.proname='recognition_request_get') = 'atlas_recognition_definer'
  and (select pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='atlas_private' and p.proname='recognition_register_media') = 'atlas_recognition_definer';
insert into s89_rs select 'the definer cannot record Brain decisions or decide requests',
  not has_function_privilege('atlas_recognition_definer','public.atlas_catalog_record_ai_decision(uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('atlas_recognition_definer','atlas_private.decide_phase3_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)','EXECUTE')
  and not has_table_privilege('atlas_recognition_definer','atlas_private.ai_settings','UPDATE')
  and not has_table_privilege('atlas_recognition_definer','public.inventory_items','UPDATE');
insert into s89_rs select 'the new functions are service-role only',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname in ('atlas_recognition_limits','atlas_recognition_request_get','atlas_catalog_record_ai_decision','recognition_limits','recognition_request_get')
      and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')))
  and has_function_privilege('service_role','public.atlas_recognition_limits(uuid,text,boolean,bigint)','EXECUTE');
insert into s89_rs select 'nothing in this script changed stock',
  (select coalesce(sum(quantity),0) from public.inventory_items) = (select total from s89_rs_stock)
  and (select count(*) from public.inventory_movements) = (select movements from s89_rs_stock);

select jsonb_build_object(
  's89_recognition_service', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s89_rs;

rollback;
