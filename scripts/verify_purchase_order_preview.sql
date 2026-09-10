-- Disposable/empty isolated test database only. No fixture survives this script.
begin;
do $$ begin
  if exists(select 1 from auth.users) or exists(select 1 from public.purchase_orders)
     or exists(select 1 from public.inventory_items) or exists(select 1 from public.profiles) then
    raise exception 'Purchase order tests require an empty isolated database';
  end if;
end $$;
create temporary table po_results(name text primary key, passed boolean not null) on commit drop;
grant select,insert on po_results to authenticated;
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
('00000000-0000-4000-7000-000000000001','authenticated','authenticated','po-manager@example.invalid','{}','{}'),
('00000000-0000-4000-7000-000000000002','authenticated','authenticated','po-staff@example.invalid','{}','{}'),
('00000000-0000-4000-7000-000000000003','authenticated','authenticated','po-inactive@example.invalid','{}','{}');
update public.profiles set role='admin',active=true where id='00000000-0000-4000-7000-000000000001';
update public.profiles set role='bartender',active=true where id='00000000-0000-4000-7000-000000000002';
insert into public.suppliers(id,name,active) values('00000000-0000-4000-7000-000000000101','Synthetic PO supplier',true);
insert into public.inventory_items(id,name,category,unit,quantity,active) values
('00000000-0000-4000-7000-000000000201','Synthetic PO item','test','unit',5,true);
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-7000-000000000001',true);
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','create',null,
 '00000000-0000-4000-7000-000000000101','[{"item_id":"00000000-0000-4000-7000-000000000201","quantity":2,"unit_cost":100}]','Fixture');
insert into po_results select 'create_draft',count(*)=1 and bool_and(status='draft' and version=1) from public.purchase_orders;
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','create',null,
 '00000000-0000-4000-7000-000000000101','[{"item_id":"00000000-0000-4000-7000-000000000201","quantity":2,"unit_cost":100}]','Fixture');
insert into po_results select 'create_retry_is_idempotent',count(*)=1 from public.purchase_orders;
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','update',1,
 '00000000-0000-4000-7000-000000000101','[{"item_id":"00000000-0000-4000-7000-000000000201","quantity":3,"unit_cost":100}]','Fixture');
insert into po_results select 'draft_amendment',version=2 and (lines->0->>'quantity')::numeric=3 from public.purchase_orders;
do $$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','place',1);
  insert into po_results values('stale_version_denied',false);
exception when raise_exception then
  insert into po_results values('stale_version_denied',sqlerrm='Order changed. Refresh before continuing');
end $$;
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','place',2);
insert into po_results select 'place_order',status='ordered' and version=3 from public.purchase_orders;
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','receive',3);
insert into po_results select 'receipt_updates_stock',quantity=8 from public.inventory_items where id='00000000-0000-4000-7000-000000000201';
insert into po_results select 'receipt_records_actor_and_cost',count(*)=1 and bool_and(quantity_change=3 and total_cost=300 and created_by='00000000-0000-4000-7000-000000000001') from public.inventory_movements;
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','receive',3);
insert into po_results select 'repeat_receive_no_double_stock',(select quantity=8 from public.inventory_items where id='00000000-0000-4000-7000-000000000201') and (select count(*)=1 from public.inventory_movements);
do $$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','cancel',4);
  insert into po_results values('received_order_immutable',false);
exception when raise_exception then insert into po_results values('received_order_immutable',sqlerrm='This transition is not allowed for the current order state'); end $$;
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000302','create',null,
 '00000000-0000-4000-7000-000000000101','[{"item_id":"00000000-0000-4000-7000-000000000201","quantity":1,"unit_cost":0}]','Cancel fixture');
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000302','cancel',1);
insert into po_results select 'cancel_draft',status='cancelled' from public.purchase_orders where id='00000000-0000-4000-7000-000000000302';
do $$ begin
  update public.purchase_orders set status='draft';
  insert into po_results values('direct_write_denied',false);
exception when insufficient_privilege then insert into po_results values('direct_write_denied',true); end $$;
do $$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000303','create',null,
   '00000000-0000-4000-7000-000000000101','[{"item_id":"00000000-0000-4000-7000-000000000201","quantity":"NaN","unit_cost":1}]','');
  insert into po_results values('nonfinite_quantity_denied',false);
exception when raise_exception then insert into po_results values('nonfinite_quantity_denied',sqlerrm='Invalid order quantity or unit cost'); end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-7000-000000000002',true);
insert into po_results select 'staff_orders_hidden',count(*)=0 from public.purchase_orders;
do $$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','receive',3);
  insert into po_results values('staff_command_denied',false);
exception when insufficient_privilege then insert into po_results values('staff_command_denied',true); end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-7000-000000000003',true);
do $$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','receive',3);
  insert into po_results values('inactive_command_denied',false);
exception when insufficient_privilege then insert into po_results values('inactive_command_denied',true); end $$;
reset role;
insert into po_results values('anonymous_access_denied',not has_table_privilege('anon','public.purchase_orders','select') and not has_function_privilege('anon','public.atlas_purchase_order_command(uuid,text,integer,uuid,jsonb,text)','execute'));
do $$ begin
  if (select count(*) from po_results)<>16 or exists(select 1 from po_results where not passed) then
    raise exception 'Purchase order acceptance failed: %',(select jsonb_agg(to_jsonb(r)) from po_results r);
  end if;
end $$;
select jsonb_build_object('passed',bool_and(passed),'passed_count',count(*) filter(where passed),'failed_count',count(*) filter(where not passed),'rolled_back',true,'tests',jsonb_agg(to_jsonb(r) order by name)) as purchase_order_acceptance from po_results r;
rollback;
