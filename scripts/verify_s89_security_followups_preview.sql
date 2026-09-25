-- S89 preview-only acceptance for the security review S88b follow-ups.
-- Rolled back.
--
-- G4: browsers have no direct UPDATE on public.inventory_items (release-gated
--     20260928095000); every server/RPC path the UI uses still works
--     (adjust_inventory, atlas_apply_par_levels, atlas_set_inventory_item_active,
--     server-role catalogue writes); name/category/par/supplier/cost changes
--     are audited in atlas_private.item_master_events ('item_changed') with the
--     actor (20260928093000).
-- G7: atlas_stock_count_add_line resolves the actor's role from the profile
--     and refuses a claimed role that does not match (20260928094000).

begin;

create temporary table s89_sec (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s89_sec to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-000000089f01','s89-sec-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000089f02','s89-sec-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000089f03','s89-sec-view@example.invalid'),
  ('00000000-0000-4000-8000-000000089f04','s89-sec-old@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-000000089f01','s89-sec-mgr@example.invalid','S89 sec manager','manager',true),
  ('00000000-0000-4000-8000-000000089f02','s89-sec-bar@example.invalid','S89 sec bartender','bartender',true),
  ('00000000-0000-4000-8000-000000089f03','s89-sec-view@example.invalid','S89 sec viewer','viewer',true),
  ('00000000-0000-4000-8000-000000089f04','s89-sec-old@example.invalid','S89 sec former manager','manager',false)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-000000089f51','S89 sec supplier',true);
insert into public.inventory_items (id,name,category,unit,active,quantity,par_level,cost_price) values
  ('00000000-0000-4000-8000-000000089f11','S89 sec Campari 1L','Liqueurs','bottles',true,5,4,1000),
  ('00000000-0000-4000-8000-000000089f12','S89 sec Aperol 1L','Liqueurs','bottles',true,5,4,1000),
  ('00000000-0000-4000-8000-000000089f13','S89 sec Cynar 1L','Liqueurs','bottles',true,0,2,900);

create temporary view s89_changes as
select e.external_item_id, e.actor_id, e.actor_role, e.payload
from atlas_private.item_master_events e where e.event_type = 'item_changed';
grant select on s89_changes to public;

-- ---------- G4: grant model ----------
insert into s89_sec select 'G4 browsers hold no UPDATE (table or column) on inventory_items',
  not has_table_privilege('authenticated','public.inventory_items','update')
  and not has_table_privilege('anon','public.inventory_items','update')
  and not has_any_column_privilege('authenticated','public.inventory_items','update')
  and not has_any_column_privilege('anon','public.inventory_items','update');
insert into s89_sec select 'G4 no UPDATE policy remains for browsers',
  not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_items' and cmd in ('UPDATE','ALL')
    and roles && array['authenticated','anon','public']::name[]);
insert into s89_sec select 'G4 reads and the guarded delete are unchanged',
  has_table_privilege('authenticated','public.inventory_items','select')
  and has_table_privilege('authenticated','public.inventory_items','delete');
insert into s89_sec select 'G4 adjust_inventory stays a SECURITY INVOKER wrapper; its private definer is not for anon',
  (select not prosecdef from pg_proc where oid='public.adjust_inventory(uuid,numeric,text,numeric,uuid,text)'::regprocedure)
  and (select prosecdef from pg_proc where oid='private.adjust_inventory_apply(uuid,numeric,text,numeric,uuid,text)'::regprocedure)
  and not has_function_privilege('anon','private.adjust_inventory_apply(uuid,numeric,text,numeric,uuid,text)','execute')
  and not has_function_privilege('authenticated','private.inventory_item_change_audit()','execute');

-- ---------- G4: the manager browser session ----------
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),
       set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000089f01',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000089f01","role":"authenticated"}',true);

do $probe$
declare
  blocked integer := 0;
begin
  begin
    update public.inventory_items set name='S89 sec Campari 1L (renamed)' where id='00000000-0000-4000-8000-000000089f12';
  exception when insufficient_privilege then blocked := blocked + 1;
  end;
  begin
    update public.inventory_items set par_level=99 where id='00000000-0000-4000-8000-000000089f12';
  exception when insufficient_privilege then blocked := blocked + 1;
  end;
  begin
    update public.inventory_items set active=false where id='00000000-0000-4000-8000-000000089f12';
  exception when insufficient_privilege then blocked := blocked + 1;
  end;
  begin
    update public.inventory_items set cost_price=1, supplier_id='00000000-0000-4000-8000-000000089f51', category='Other' where id='00000000-0000-4000-8000-000000089f12';
  exception when insufficient_privilege then blocked := blocked + 1;
  end;
  insert into s89_sec values ('G4 a manager PATCH of name, par, active, cost, supplier or category is refused', blocked = 4);

  perform public.adjust_inventory('00000000-0000-4000-8000-000000089f11'::uuid, -2::numeric, 'waste', null, null, 'S89 sec waste');
  perform public.adjust_inventory('00000000-0000-4000-8000-000000089f11'::uuid, 3::numeric, 'restock', 1200::numeric, '00000000-0000-4000-8000-000000089f51'::uuid, 'S89 sec restock');
  insert into s89_sec select 'G4 adjust_inventory still works for a manager (waste and restock with cost)',
    quantity = 6 and cost_price = 1200 and supplier_id = '00000000-0000-4000-8000-000000089f51'
    from public.inventory_items where id='00000000-0000-4000-8000-000000089f11';

  perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000089f13","expected_par_level":2,"par_level":6}]', 's89-sec-par-1');
  insert into s89_sec select 'G4 atlas_apply_par_levels still works for a manager',
    par_level = 6 from public.inventory_items where id='00000000-0000-4000-8000-000000089f13';
end
$probe$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000089f02',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000089f02","role":"authenticated"}',true);
do $probe$
declare denied boolean := false;
begin
  begin
    perform public.adjust_inventory('00000000-0000-4000-8000-000000089f11'::uuid, -1::numeric, 'waste', null, null, 'bartender');
  exception when insufficient_privilege then denied := true;
  end;
  insert into s89_sec values ('G4 a bartender still cannot adjust stock', denied);
end
$probe$;
reset role;
select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','',true), set_config('request.jwt.claim.role','',true);

insert into s89_sec select 'G4 refused PATCHes changed nothing and wrote no audit',
  (select name = 'S89 sec Aperol 1L' and par_level = 4 and active and cost_price = 1000 and supplier_id is null
   from public.inventory_items where id='00000000-0000-4000-8000-000000089f12')
  and not exists (select 1 from s89_changes where external_item_id='00000000-0000-4000-8000-000000089f12');
insert into s89_sec select 'G4 an adjust_inventory cost/supplier change is audited with the actor',
  exists (select 1 from s89_changes
    where external_item_id='00000000-0000-4000-8000-000000089f11'
      and actor_id='00000000-0000-4000-8000-000000089f01' and actor_role='manager'
      and payload->>'via'='adjust_inventory'
      and payload->'changes'->'cost_price'->>'to' = '1200'
      and payload->'changes' ? 'supplier_id')
  and (select count(*) from s89_changes where external_item_id='00000000-0000-4000-8000-000000089f11') = 1;
insert into s89_sec select 'G4 a par level change is audited with the actor',
  exists (select 1 from s89_changes
    where external_item_id='00000000-0000-4000-8000-000000089f13'
      and actor_id='00000000-0000-4000-8000-000000089f01'
      and payload->'changes'->'par_level'->>'from' = '2' and payload->'changes'->'par_level'->>'to' = '6');

-- ---------- G4: server paths ----------
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
update public.inventory_items set name='S89 sec Aperol 700ml', category='Aperitifs' where id='00000000-0000-4000-8000-000000089f12';
update public.inventory_items set bin_location='Shelf 3' where id='00000000-0000-4000-8000-000000089f12';
select null from public.atlas_set_inventory_item_active('00000000-0000-4000-8000-000000089f12', false, 'S89 sec seasonal', null,
  '00000000-0000-4000-8000-000000089f01', 'S89 sec manager');
reset role;
select set_config('request.jwt.claim.role','',true);

insert into s89_sec select 'G4 a server-role rename is audited as a server change',
  exists (select 1 from s89_changes
    where external_item_id='00000000-0000-4000-8000-000000089f12'
      and payload->>'via'='server' and payload->>'caller_role'='service_role'
      and payload->'changes'->'name'->>'to' = 'S89 sec Aperol 700ml'
      and payload->'changes' ? 'category');
insert into s89_sec select 'G4 untracked columns and activation do not add item_changed rows',
  (select count(*) from s89_changes where external_item_id='00000000-0000-4000-8000-000000089f12') = 1
  and exists (select 1 from atlas_private.item_master_events where external_item_id='00000000-0000-4000-8000-000000089f12'
    and event_type='item_deactivated' and actor_id='00000000-0000-4000-8000-000000089f01');
insert into s89_sec select 'G4 set_item_active still works on the server path',
  not active from public.inventory_items where id='00000000-0000-4000-8000-000000089f12';

-- ---------- G7: add-line actor role ----------
create temporary table s89_sec_count on commit drop as
select public.atlas_stock_count_start(
  jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000089f11','name','S89 sec Campari 1L','category','Liqueurs','unit','bottles','active',true)),
  'S89 sec count','category','Liqueurs',null,'00000000-0000-4000-8000-000000089f01','S89 sec manager','manager','s89-sec-count-1') as detail;
create temporary table s89_sec_session on commit drop as
select s.id from atlas_private.inventory_count_sessions s where s.client_request_id='s89-sec-count-1';

do $probe$
declare
  v_session uuid := (select id from s89_sec_session);
  item jsonb := '{"id":"00000000-0000-4000-8000-000000089f13","name":"S89 sec Cynar 1L","category":"Liqueurs","unit":"bottles","active":true}';
  refused integer := 0;
  result jsonb;
begin
  -- A bartender claiming manager, a viewer claiming bartender, an inactive
  -- manager and an unknown actor are all refused.
  begin perform public.atlas_stock_count_add_line(v_session, item, '00000000-0000-4000-8000-000000089f02', 'S89 sec bartender', 'manager');
  exception when insufficient_privilege then refused := refused + 1; end;
  begin perform public.atlas_stock_count_add_line(v_session, item, '00000000-0000-4000-8000-000000089f03', 'S89 sec viewer', 'bartender');
  exception when insufficient_privilege then refused := refused + 1; end;
  begin perform public.atlas_stock_count_add_line(v_session, item, '00000000-0000-4000-8000-000000089f04', 'S89 sec former manager', 'manager');
  exception when insufficient_privilege then refused := refused + 1; end;
  begin perform public.atlas_stock_count_add_line(v_session, item, '00000000-0000-4000-8000-000000089fff', 'Nobody', 'admin');
  exception when insufficient_privilege then refused := refused + 1; end;
  begin perform public.atlas_stock_count_add_line(v_session, item, null, 'Nobody', 'admin');
  exception when insufficient_privilege then refused := refused + 1; end;
  insert into s89_sec values ('G7 add-line refuses a claimed role the profile does not hold', refused = 5);
  insert into s89_sec values ('G7 refused add-lines wrote nothing',
    not exists (select 1 from atlas_private.inventory_count_lines where session_id = (select id from s89_sec_session)
      and inventory_item_id = '00000000-0000-4000-8000-000000089f13'));

  result := public.atlas_stock_count_add_line(v_session, item, '00000000-0000-4000-8000-000000089f02', 'S89 sec bartender', 'bartender');
  insert into s89_sec values ('G7 add-line works when the claimed role matches the profile',
    (result->>'added')::boolean
    and exists (select 1 from atlas_private.inventory_count_events e where e.session_id = (select id from s89_sec_session)
      and e.event_type='line_added' and e.actor_id='00000000-0000-4000-8000-000000089f02' and e.actor_role='bartender'));
end
$probe$;

select jsonb_build_object(
  's89_security_followups', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s89_sec;

rollback;
