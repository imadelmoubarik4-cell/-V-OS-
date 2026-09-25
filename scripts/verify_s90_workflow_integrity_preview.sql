-- S90 preview-only acceptance for the workflow-integrity fixes
-- (20260929090000_s90_stock_adjust_idempotency.sql). Rolled back.
--
-- P2-2: public.adjust_inventory_v2 records waste and deliveries without an
--       order at most once per (actor, request id); a replay returns the
--       stored movement; refusals are distinct SQLSTATE errors that write
--       nothing; the security shape matches the reviewed browser RPCs.
-- P2-8: a delivery recorded between a line's count and the manager's
--       "Verify anyway" is not erased: the verified balance is stamped at the
--       line's counted_at and the canonical projection adds later movements.

begin;

create temporary table s90_wfi (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s90_wfi to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-000000090f01','s90-wfi-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000090f02','s90-wfi-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000090f03','s90-wfi-mgr2@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-000000090f01','s90-wfi-mgr@example.invalid','S90 manager','manager',true),
  ('00000000-0000-4000-8000-000000090f02','s90-wfi-bar@example.invalid','S90 bartender','bartender',true),
  ('00000000-0000-4000-8000-000000090f03','s90-wfi-mgr2@example.invalid','S90 second manager','manager',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-000000090f51','S90 supplier',true);
insert into public.inventory_items (id,name,category,unit,active,quantity,par_level,cost_price) values
  ('00000000-0000-4000-8000-000000090f11','S90 Campari 1L','Liqueurs','bottles',true,10,4,1000),
  ('00000000-0000-4000-8000-000000090f12','S90 Aperol 1L','Liqueurs','bottles',true,5,4,1000),
  ('00000000-0000-4000-8000-000000090f13','S90 Cynar 1L','Liqueurs','bottles',true,3,2,900);

-- ---------- P2-2: grant model ----------
insert into s90_wfi select 'P2-2 adjust_inventory_v2 is an invoker wrapper over a manager-gated private definer',
  (select not prosecdef and coalesce('search_path=""' = any(proconfig), false)
     from pg_proc where oid='public.adjust_inventory_v2(text,uuid,numeric,text,numeric,uuid,text)'::regprocedure)
  and (select prosecdef and coalesce('search_path=""' = any(proconfig), false)
         and prosrc like '%auth.uid() is null or not private.is_manager_or_admin()%'
         and prosrc like '%errcode=''42501''%'
     from pg_proc where oid='private.adjust_inventory_request(text,uuid,numeric,text,numeric,uuid,text)'::regprocedure)
  and has_function_privilege('authenticated','public.adjust_inventory_v2(text,uuid,numeric,text,numeric,uuid,text)','execute')
  and not has_function_privilege('anon','public.adjust_inventory_v2(text,uuid,numeric,text,numeric,uuid,text)','execute')
  and not has_function_privilege('anon','private.adjust_inventory_request(text,uuid,numeric,text,numeric,uuid,text)','execute');
insert into s90_wfi select 'P2-2 the request ledger is private and has RLS',
  (select relrowsecurity from pg_class where oid='atlas_private.stock_adjustment_requests'::regclass)
  and not has_table_privilege('authenticated','atlas_private.stock_adjustment_requests','select,insert,update,delete')
  and not has_table_privilege('anon','atlas_private.stock_adjustment_requests','select,insert,update,delete');
insert into s90_wfi select 'P2-2 the legacy adjust_inventory signature is unchanged',
  to_regprocedure('public.adjust_inventory(uuid,numeric,text,numeric,uuid,text)') is not null;

-- ---------- P2-2: the manager browser session ----------
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),
       set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000090f01',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000090f01","role":"authenticated"}',true);

do $probe$
declare
  first_row public.inventory_movements;
  replay_row public.inventory_movements;
  refused integer := 0;
  sqlstates text[] := array[]::text[];
begin
  -- Waste: the first call records once; a retry with the same id replays.
  first_row := public.adjust_inventory_v2('s90-waste-0001', '00000000-0000-4000-8000-000000090f11', -2, 'waste', 1000, null, 'Breakage: dropped');
  replay_row := public.adjust_inventory_v2('s90-waste-0001', '00000000-0000-4000-8000-000000090f11', -2, 'waste', 1000, null, 'Breakage: dropped');
  insert into s90_wfi values ('P2-2 a waste retry with the same request id returns the stored movement',
    first_row.id is not null and replay_row.id = first_row.id and replay_row.quantity_change = -2 and replay_row.movement_type = 'waste');
  insert into s90_wfi select 'P2-2 a waste retry lowers stock once and writes one movement',
    (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000090f11') = 8
    and (select count(*) from public.inventory_movements where item_id='00000000-0000-4000-8000-000000090f11' and movement_type='waste') = 1;

  -- A delivery without an order: once, with cost and supplier.
  first_row := public.adjust_inventory_v2('s90-restock-0001', '00000000-0000-4000-8000-000000090f12', 6, 'restock', 1200, '00000000-0000-4000-8000-000000090f51', 'Delivery without an order');
  replay_row := public.adjust_inventory_v2('s90-restock-0001', '00000000-0000-4000-8000-000000090f12', 6, 'restock', 1200, '00000000-0000-4000-8000-000000090f51', 'Delivery without an order');
  insert into s90_wfi select 'P2-2 a delivery retry adds stock once and replays the same movement',
    replay_row.id = first_row.id
    and (select quantity = 11 and cost_price = 1200 and supplier_id = '00000000-0000-4000-8000-000000090f51'
         from public.inventory_items where id='00000000-0000-4000-8000-000000090f12')
    and (select count(*) from public.inventory_movements where item_id='00000000-0000-4000-8000-000000090f12' and movement_type='restock') = 1
    and first_row.total_cost = 7200;

  -- The same id for a different change is refused and writes nothing.
  begin
    perform public.adjust_inventory_v2('s90-waste-0001', '00000000-0000-4000-8000-000000090f11', -3, 'waste', 1000, null, 'Breakage: dropped');
  exception when invalid_parameter_value then refused := refused + 1; sqlstates := sqlstates || sqlstate;
  end;
  -- Validation refusals: all 22023, none writes.
  begin perform public.adjust_inventory_v2('s90-waste-0002', '00000000-0000-4000-8000-000000090f11', 2, 'waste', null, null, 'wrong sign');
  exception when invalid_parameter_value then refused := refused + 1; end;
  begin perform public.adjust_inventory_v2('s90-restock-0002', '00000000-0000-4000-8000-000000090f11', -2, 'restock', null, null, 'wrong sign');
  exception when invalid_parameter_value then refused := refused + 1; end;
  begin perform public.adjust_inventory_v2('s90-restock-0003', '00000000-0000-4000-8000-000000090f11', 2, 'restock', -5, null, 'negative cost');
  exception when invalid_parameter_value then refused := refused + 1; end;
  begin perform public.adjust_inventory_v2('s90-waste-0003', '00000000-0000-4000-8000-000000090f13', -4, 'waste', null, null, 'more than on record');
  exception when invalid_parameter_value then refused := refused + 1; end;
  begin perform public.adjust_inventory_v2('   ', '00000000-0000-4000-8000-000000090f13', -1, 'waste', null, null, 'no request id');
  exception when invalid_parameter_value then refused := refused + 1; end;
  begin perform public.adjust_inventory_v2('s90-count-0001', '00000000-0000-4000-8000-000000090f13', 1, 'count', null, null, 'count is not a browser adjustment');
  exception when invalid_parameter_value then refused := refused + 1; end;
  insert into s90_wfi values ('P2-2 a reused request id with a different change is refused as invalid_parameter_value', sqlstates = array['22023']);
  insert into s90_wfi values ('P2-2 wrong sign, negative cost, more than on record, no request id and other types are refused', refused = 7);
  insert into s90_wfi select 'P2-2 refused requests changed no stock and wrote nothing',
    (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000090f11') = 8
    and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000090f13') = 3
    and (select count(*) from public.inventory_movements where item_id in ('00000000-0000-4000-8000-000000090f11','00000000-0000-4000-8000-000000090f13')) = 1;
end
$probe$;

-- Request ids are unique per actor: another manager's identical id is theirs.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000090f03',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000090f03","role":"authenticated"}',true);
do $probe$
declare
  other_row public.inventory_movements;
begin
  other_row := public.adjust_inventory_v2('s90-waste-0001', '00000000-0000-4000-8000-000000090f11', -1, 'waste', 1000, null, 'Spoilage: flat');
  insert into s90_wfi select 'P2-2 request ids are scoped to the actor',
    other_row.created_by = '00000000-0000-4000-8000-000000090f03'
    and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000090f11') = 7;
end
$probe$;

-- A bartender cannot use it.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000090f02',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000090f02","role":"authenticated"}',true);
do $probe$
declare denied boolean := false;
begin
  begin
    perform public.adjust_inventory_v2('s90-bar-0001', '00000000-0000-4000-8000-000000090f11', -1, 'waste', null, null, 'bartender');
  exception when insufficient_privilege then denied := true;
  end;
  insert into s90_wfi values ('P2-2 a bartender cannot record waste or deliveries through v2', denied);
end
$probe$;
reset role;
select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','',true), set_config('request.jwt.claim.role','',true);

insert into s90_wfi select 'P2-2 the ledger holds one row per (actor, request id) pointing at its movement',
  (select count(*) from atlas_private.stock_adjustment_requests r
     join public.inventory_movements m on m.id = r.movement_id
     where r.actor_id in ('00000000-0000-4000-8000-000000090f01','00000000-0000-4000-8000-000000090f03')) = 3;

-- ---------- P2-8: a delivery between a line's count and "Verify anyway" ----------
create temporary table s90_count on commit drop as
select public.atlas_stock_count_start(
  jsonb_build_array(
    jsonb_build_object('id','00000000-0000-4000-8000-000000090f13','name','S90 Cynar 1L','category','S90 count','unit','bottles','active',true,'quantity',3,'updated_at','2026-09-24T10:00:00Z')),
  'S90 count','category','S90 count',null,'00000000-0000-4000-8000-000000090f01','S90 manager','manager','s90-wfi-count-1') as detail;
create temporary table s90_session on commit drop as
select s.id from atlas_private.inventory_count_sessions s where s.client_request_id='s90-wfi-count-1';

-- The bartender counted 2 bottles two hours ago; a movement one hour before
-- that was physically counted; a delivery of 6 arrived one hour ago, after
-- the count and before the manager verifies.
update atlas_private.inventory_count_lines
set line_status='counted', observed_quantity=2, observed_input_quantity=2, counted_at=now() - interval '2 hours'
where session_id=(select id from s90_session);
select public.atlas_stock_count_submit((select id from s90_session), null, '00000000-0000-4000-8000-000000090f02', 'S90 bartender', 'bartender');
insert into public.inventory_movements (id,item_id,item_name,movement_type,quantity_change,note,created_at) values
  ('00000000-0000-4000-8000-000000090e01','00000000-0000-4000-8000-000000090f13','S90 Cynar 1L','waste',-1,'before the count',now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000090e02','00000000-0000-4000-8000-000000090f13','S90 Cynar 1L','restock',6,'delivery after the count',now() - interval '1 hour');

do $probe$
declare conflict boolean := false;
begin
  begin
    perform public.atlas_stock_count_verify((select id from s90_session),
      jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000090f13','quantity',9,'updated_at','2026-09-24T12:00:00Z')),
      false,'00000000-0000-4000-8000-000000090f01','S90 manager','manager');
  exception when others then conflict := sqlerrm like '%acknowledge the conflicts%';
  end;
  insert into s90_wfi values ('P2-8 a count whose stock changed still asks for "Verify anyway"', conflict);
end
$probe$;
select public.atlas_stock_count_verify((select id from s90_session),
  jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000090f13','quantity',9,'updated_at','2026-09-24T12:00:00Z')),
  true,'00000000-0000-4000-8000-000000090f01','S90 manager','manager');

insert into s90_wfi select 'P2-8 the verified balance is stamped at the line''s counted_at, not at verification',
  b.verified_at = l.counted_at and b.verified_at < s.verified_at and b.verified_quantity = 2 and b.expires_at > now()
from atlas_private.inventory_verified_balances b
join atlas_private.inventory_count_lines l on l.id = b.source_line_id
join atlas_private.inventory_count_sessions s on s.id = b.source_session_id
where b.inventory_item_id='00000000-0000-4000-8000-000000090f13';
-- The canonical projection (AtlasStockTruth.effectiveStock /
-- _shared/atlas-domain.mjs): baseline + non-count movements after verified_at.
insert into s90_wfi select 'P2-8 the delivery after the count is not erased: projected stock is 2 counted + 6 delivered',
  b.verified_quantity + coalesce((select sum(m.quantity_change) from public.inventory_movements m
    where m.item_id = b.inventory_item_id and m.movement_type <> 'count'
      and m.created_at > b.verified_at and m.created_at <= now()), 0) = 8
from atlas_private.inventory_verified_balances b where b.inventory_item_id='00000000-0000-4000-8000-000000090f13';

-- An older count verified later never replaces the newer balance.
create temporary table s90_count_old on commit drop as
select public.atlas_stock_count_start(
  jsonb_build_array(
    jsonb_build_object('id','00000000-0000-4000-8000-000000090f13','name','S90 Cynar 1L','category','S90 count','unit','bottles','active',true,'quantity',9,'updated_at','2026-09-24T12:00:00Z')),
  'S90 old count','category','S90 count',null,'00000000-0000-4000-8000-000000090f01','S90 manager','manager','s90-wfi-count-2') as detail;
update atlas_private.inventory_count_lines
set line_status='counted', observed_quantity=40, observed_input_quantity=40, counted_at=now() - interval '5 hours'
where session_id=(select s.id from atlas_private.inventory_count_sessions s where s.client_request_id='s90-wfi-count-2');
select public.atlas_stock_count_submit((select s.id from atlas_private.inventory_count_sessions s where s.client_request_id='s90-wfi-count-2'), null, '00000000-0000-4000-8000-000000090f02', 'S90 bartender', 'bartender');
select public.atlas_stock_count_verify((select s.id from atlas_private.inventory_count_sessions s where s.client_request_id='s90-wfi-count-2'),
  jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000090f13','quantity',9,'updated_at','2026-09-24T12:00:00Z')),
  true,'00000000-0000-4000-8000-000000090f01','S90 manager','manager');
insert into s90_wfi select 'P2-8 a count observed before the current balance does not overwrite it',
  b.verified_quantity = 2 and b.source_session_id = (select id from s90_session)
from atlas_private.inventory_verified_balances b where b.inventory_item_id='00000000-0000-4000-8000-000000090f13';

select jsonb_build_object(
  's90_workflow_integrity', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s90_wfi;

rollback;
