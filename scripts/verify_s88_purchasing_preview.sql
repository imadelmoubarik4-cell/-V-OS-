-- S88 preview-only purchasing acceptance (expected delivery, partial
-- receiving, optional approval, events). Seeds its own fixtures inside one
-- transaction, prints one JSON verdict and rolls back.

begin;

create temporary table s88_po (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s88_po to authenticated;
create role s88_po_probe nologin;
grant authenticated to s88_po_probe;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-000000088501'::uuid,'s88-po-manager-a@example.invalid'),
  ('00000000-0000-4000-8000-000000088502'::uuid,'s88-po-manager-b@example.invalid'),
  ('00000000-0000-4000-8000-000000088503'::uuid,'s88-po-admin@example.invalid'),
  ('00000000-0000-4000-8000-000000088504'::uuid,'s88-po-bartender@example.invalid'),
  ('00000000-0000-4000-8000-000000088505'::uuid,'s88-po-inactive@example.invalid')
) as u(id, email);
update public.profiles set role='manager', active=true where id in ('00000000-0000-4000-8000-000000088501','00000000-0000-4000-8000-000000088502');
update public.profiles set role='admin', active=true where id='00000000-0000-4000-8000-000000088503';
update public.profiles set role='bartender', active=true where id='00000000-0000-4000-8000-000000088504';
update public.profiles set role='manager', active=false where id='00000000-0000-4000-8000-000000088505';

insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-000000088601','S88 PO supplier',true);
insert into public.inventory_items (id,name,category,quantity,unit,cost_price,active) values
  ('00000000-0000-4000-8000-000000088701','S88 PO gin','Test',0,'bottles',50,true),
  ('00000000-0000-4000-8000-000000088702','S88 PO lemons','Test',0,'kg',null,true),
  ('00000000-0000-4000-8000-000000088704','S88 PO tonic','Test',0,'bottles',50,true),
  ('00000000-0000-4000-8000-000000088705','S88 PO v1 twin','Test',0,'bottles',null,true),
  ('00000000-0000-4000-8000-000000088706','S88 PO v2 twin','Test',0,'bottles',null,true),
  ('00000000-0000-4000-8000-000000088707','S88 PO not ordered','Test',0,'bottles',null,true);
-- Stock enters only through the canonical path; this seeds 10 gin bottles.
select set_config('atlas.allow_inventory_quantity_change','on',true);
update public.inventory_items set quantity=10 where id='00000000-0000-4000-8000-000000088701';
select set_config('atlas.allow_inventory_quantity_change','',true);

-- Owner decisions: start from the defaults (no purchase_* keys).
update atlas_private.settings_sections
set settings_value = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(settings_value) as e(k, v) where k not like 'purchase_%')
where section_key='inventory';

set session authorization s88_po_probe;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088501',true);

-- Policy defaults reproduce v1.
insert into s88_po select 'policy defaults keep v1 behaviour',
  p->>'approval_required'='false' and p->>'approval_separate_approver'='false' and p->'approval_threshold_isk'='null'::jsonb
  and p->>'approval_approver_role'='manager' and (p->>'over_receipt_tolerance_percent')::numeric=0
  and p->>'short_close_enabled'='false' and p->>'receipt_cost_mode'='update_item_cost'
  and p->>'delivery_date_required_on_place'='false' and p->>'staff_receiving_enabled'='false'
  and (p->>'venue_date') is not null
from (select public.atlas_purchase_order_policy() as p) x;

-- O1: create with an expected delivery date, place without approval.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','create',null,
  '00000000-0000-4000-8000-000000088601',
  '[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":10,"unit_cost":100},{"item_id":"00000000-0000-4000-8000-000000088702","quantity":5,"unit_cost":20}]',
  'S88 O1', current_date + 3);
insert into s88_po select 'create stores expected delivery date', status='draft' and expected_delivery_date=current_date+3
from public.purchase_orders where id='00000000-0000-4000-8000-000000088801';

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088899','create',null,
    '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":1,"unit_cost":1}]','', current_date - 30);
  insert into s88_po values ('past delivery date refused', false);
exception when raise_exception then
  insert into s88_po values ('past delivery date refused', sqlerrm='Expected delivery date cannot be in the past');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','submit',1);
  insert into s88_po values ('approval off: submit refused', false);
exception when raise_exception then
  insert into s88_po values ('approval off: submit refused', sqlerrm like 'This order does not need approval%');
end $probe$;

select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','place',1);
insert into s88_po select 'approval off: draft places straight to ordered', status='ordered' and version=2 and ordered_at is not null
from public.purchase_orders where id='00000000-0000-4000-8000-000000088801';

-- Partial receipt at a different price.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',2,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":4,"unit_cost":110,"note":"first cases"}]',
  p_request_id=>'s88-r1');
insert into s88_po select 'partial receipt -> partially_received', status='partially_received' and version=3 and received_at is null
from public.purchase_orders where id='00000000-0000-4000-8000-000000088801';
insert into s88_po select 'partial receipt posts stock once through adjust_inventory',
  (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088701')=14
  and (select count(*) from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088801%')=1
  and exists (select 1 from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088801%'
              and movement_type='restock' and quantity_change=4 and unit_cost=110 and total_cost=440
              and created_by='00000000-0000-4000-8000-000000088501');
insert into s88_po select 'receipt row links its movement and records both prices',
  count(*)=1 and bool_and(r.movement_id=m.id and r.unit_cost=110 and r.ordered_unit_cost=100 and r.note='first cases')
from public.purchase_order_receipts r join public.inventory_movements m on m.id=r.movement_id
where r.order_id='00000000-0000-4000-8000-000000088801';
insert into s88_po select 'cost rule identical to v1: item cost follows the received cost', cost_price=110
from public.inventory_items where id='00000000-0000-4000-8000-000000088701';

-- Retry with the same idempotency key (stale version, as a network retry would send).
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',2,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":4,"unit_cost":110,"note":"first cases"}]',
  p_request_id=>'s88-r1');
insert into s88_po select 'same request id twice posts stock once',
  (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088701')=14
  and (select count(*) from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088801%')=1
  and (select count(*) from public.purchase_order_receipts where order_id='00000000-0000-4000-8000-000000088801')=1
  and (select version from public.purchase_orders where id='00000000-0000-4000-8000-000000088801')=3;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',3,
    p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":5}]', p_request_id=>'s88-r1');
  insert into s88_po values ('reused request id with other quantities refused', false);
exception when raise_exception then
  insert into s88_po values ('reused request id with other quantities refused', sqlerrm='This receipt request ID was already used for different quantities');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',3,
    p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":7}]', p_request_id=>'s88-r2');
  insert into s88_po values ('over-receipt refused by default', false);
exception when raise_exception then
  insert into s88_po values ('over-receipt refused by default', sqlerrm like 'Received quantity is more than was ordered%');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',3,
    p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088707","quantity":1}]', p_request_id=>'s88-r2b');
  insert into s88_po values ('item not on the order refused', false);
exception when raise_exception then
  insert into s88_po values ('item not on the order refused', sqlerrm='Receipt item is not on this order');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',3,
    p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088702","quantity":"NaN"}]', p_request_id=>'s88-r2c');
  insert into s88_po values ('non-numeric receipt quantity refused', false);
exception when raise_exception then
  insert into s88_po values ('non-numeric receipt quantity refused', sqlerrm='Invalid receipt quantity or unit cost');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',3,
    p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088702","quantity":1}]');
  insert into s88_po values ('receipt without request id refused', false);
exception when raise_exception then
  insert into s88_po values ('receipt without request id refused', sqlerrm='A receipt request ID is required');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','cancel',3);
  insert into s88_po values ('cancel after a receipt refused', false);
exception when raise_exception then
  insert into s88_po values ('cancel after a receipt refused', sqlerrm='This transition is not allowed for the current order state');
end $probe$;

do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','close_short',3,p_reason=>'Supplier out');
  insert into s88_po values ('short close disabled by default', false);
exception when raise_exception then
  insert into s88_po values ('short close disabled by default', sqlerrm='Closing an order with missing lines is not enabled');
end $probe$;

insert into s88_po select 'refused receipts posted nothing',
  (select count(*) from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088801%')=1
  and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088702')=0;

select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088801','receive_lines',3,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088701","quantity":6},{"item_id":"00000000-0000-4000-8000-000000088702","quantity":5}]',
  p_request_id=>'s88-r3');
insert into s88_po select 'second receipt completes the order', status='received' and received_at is not null and version=4
from public.purchase_orders where id='00000000-0000-4000-8000-000000088801';
insert into s88_po select 'completed stock equals ordered quantities',
  (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088701')=20
  and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088702')=5
  and (select cost_price from public.inventory_items where id='00000000-0000-4000-8000-000000088701')=100
  and (select count(*) from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088801%')=3;

select public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088801','receive',4);
insert into s88_po select 'v1 receive on a received order is a no-op',
  (select count(*) from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088801%')=3
  and (select version from public.purchase_orders where id='00000000-0000-4000-8000-000000088801')=4;

insert into s88_po select 'one event per transition',
  array_agg(event_type order by created_at, id)=array['created','ordered','received_partial','received']
  and bool_and(actor_id='00000000-0000-4000-8000-000000088501')
from public.purchase_order_events where order_id='00000000-0000-4000-8000-000000088801';

-- O2: v2 partial receipt, then the v1 command receives only what remains.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088802','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":3,"unit_cost":60}]','S88 O2');
select public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088802','place',1);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088802','receive_lines',2,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":1}]', p_request_id=>'s88-o2-r1');
insert into s88_po select 'detail reports received and remaining per line',
  (d->'lines'->0->>'received_quantity')::numeric=1 and (d->'lines'->0->>'remaining_quantity')::numeric=2
  and jsonb_array_length(d->'receipts')=1 and jsonb_array_length(d->'events')=3 and d->>'approval_needed'='false'
from (select public.atlas_purchase_order_detail('00000000-0000-4000-8000-000000088802') as d) x;
select public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088802','receive',3);
insert into s88_po select 'v1 receive after a partial receipt receives only the remainder',
  (select status from public.purchase_orders where id='00000000-0000-4000-8000-000000088802')='received'
  and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088704')=3
  and (select array_agg(quantity_change order by quantity_change) from public.inventory_movements
       where note like 'Purchase order 00000000-0000-4000-8000-000000088802%')=array[1,2]::numeric[];

-- Approval off: v1 and v2 produce the same stock, cost and movement.
select public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088803','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088705","quantity":2,"unit_cost":30}]','S88 v1 twin');
select public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088803','place',1);
select public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088803','receive',2);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088804','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088706","quantity":2,"unit_cost":30}]','S88 v2 twin');
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088804','place',1);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088804','receive_lines',2,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088706","quantity":2}]', p_request_id=>'s88-twin');
insert into s88_po select 'approval off: v2 path equals v1 path',
  (select (status, version, received_at is not null) from public.purchase_orders where id='00000000-0000-4000-8000-000000088803')
    = (select (status, version, received_at is not null) from public.purchase_orders where id='00000000-0000-4000-8000-000000088804')
  and (select (quantity, cost_price, supplier_id) from public.inventory_items where id='00000000-0000-4000-8000-000000088705')
    = (select (quantity, cost_price, supplier_id) from public.inventory_items where id='00000000-0000-4000-8000-000000088706')
  and (select array_agg((movement_type, quantity_change, unit_cost, total_cost, supplier_id)::text) from public.inventory_movements where item_id='00000000-0000-4000-8000-000000088705')
    = (select array_agg((movement_type, quantity_change, unit_cost, total_cost, supplier_id)::text) from public.inventory_movements where item_id='00000000-0000-4000-8000-000000088706')
  and (select status from public.purchase_orders where id='00000000-0000-4000-8000-000000088803')='received';

-- Role probes.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088504',true);
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088802','receive',4);
  insert into s88_po values ('bartender: v2 command denied', false);
exception when insufficient_privilege then insert into s88_po values ('bartender: v2 command denied', true); end $probe$;
do $probe$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088802','receive',4);
  insert into s88_po values ('bartender: v1 command denied', false);
exception when insufficient_privilege then insert into s88_po values ('bartender: v1 command denied', true); end $probe$;
do $probe$ begin
  perform public.atlas_purchase_order_policy();
  insert into s88_po values ('bartender: policy and detail denied', false);
exception when insufficient_privilege then
  begin
    perform public.atlas_purchase_order_detail('00000000-0000-4000-8000-000000088802');
    insert into s88_po values ('bartender: policy and detail denied', false);
  exception when insufficient_privilege then insert into s88_po values ('bartender: policy and detail denied', true); end;
end $probe$;
insert into s88_po select 'bartender: receipts and events hidden',
  (select count(*) from public.purchase_order_receipts)=0 and (select count(*) from public.purchase_order_events)=0;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088505',true);
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088802','receive',4);
  insert into s88_po values ('deactivated manager: v2 command denied', false);
exception when insufficient_privilege then insert into s88_po values ('deactivated manager: v2 command denied', true); end $probe$;
insert into s88_po select 'deactivated manager: receipts hidden', count(*)=0 from public.purchase_order_receipts;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088501',true);
do $probe$ begin
  insert into public.purchase_order_events(order_id,event_type,actor_id) values ('00000000-0000-4000-8000-000000088801','cancelled','00000000-0000-4000-8000-000000088501');
  insert into s88_po values ('manager cannot write receipts or events directly', false);
exception when insufficient_privilege then
  begin
    insert into public.purchase_order_receipts(order_id,request_id,item_id,quantity,unit_cost,ordered_unit_cost,received_by)
    values ('00000000-0000-4000-8000-000000088801','x','00000000-0000-4000-8000-000000088701',1,1,1,'00000000-0000-4000-8000-000000088501');
    insert into s88_po values ('manager cannot write receipts or events directly', false);
  exception when insufficient_privilege then insert into s88_po values ('manager cannot write receipts or events directly', true); end;
end $probe$;

reset role;
reset session authorization;

insert into s88_po values ('anon: no execute on S88 purchasing RPCs and no table access',
  not has_function_privilege('anon','public.atlas_purchase_order_command_v2(uuid,text,integer,uuid,jsonb,text,date,jsonb,text,text)','execute')
  and not has_function_privilege('anon','public.atlas_purchase_order_policy()','execute')
  and not has_function_privilege('anon','public.atlas_purchase_order_detail(uuid)','execute')
  and not has_function_privilege('anon','private.purchase_order_command_v2(uuid,text,integer,uuid,jsonb,text,date,jsonb,text,text)','execute')
  and not has_table_privilege('anon','public.purchase_order_receipts','select')
  and not has_table_privilege('anon','public.purchase_order_events','select')
  and not has_function_privilege('authenticated','private.purchase_order_policy_values()','execute')
  and not has_function_privilege('authenticated','private.purchase_order_log_event(uuid,text,text,text,uuid,jsonb)','execute'));

-- Owner switches: tolerance 10 %, short close on, cost record-only, approval on.
update atlas_private.settings_sections set settings_value = settings_value || jsonb_build_object(
  'purchase_over_receipt_tolerance_percent', 10, 'purchase_short_close_enabled', true,
  'purchase_receipt_cost_mode', 'record_only')
where section_key='inventory';

set session authorization s88_po_probe;
set role authenticated;

-- O5: over-receipt within tolerance.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088805','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":10,"unit_cost":60}]','S88 O5');
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088805','place',1);
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088805','receive_lines',2,
    p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":12}]', p_request_id=>'s88-o5-a');
  insert into s88_po values ('tolerance 10%: 20% over refused', false);
exception when raise_exception then
  insert into s88_po values ('tolerance 10%: 20% over refused', sqlerrm like 'Received quantity is more than was ordered%');
end $probe$;
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088805','receive_lines',2,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":11,"unit_cost":70}]', p_request_id=>'s88-o5-b');
insert into s88_po select 'tolerance 10%: 10% over accepted and completes',
  (select status from public.purchase_orders where id='00000000-0000-4000-8000-000000088805')='received'
  and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000088704')=14;
insert into s88_po select 'record-only cost mode keeps item cost, records receipt price',
  (select cost_price from public.inventory_items where id='00000000-0000-4000-8000-000000088704')=60
  and exists (select 1 from public.purchase_order_receipts where order_id='00000000-0000-4000-8000-000000088805' and unit_cost=70 and ordered_unit_cost=60)
  and exists (select 1 from public.inventory_movements where note like 'Purchase order 00000000-0000-4000-8000-000000088805%' and unit_cost=70);

-- O6: short close.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088806','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088702","quantity":4,"unit_cost":20}]','S88 O6');
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088806','place',1);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088806','receive_lines',2,
  p_receipt=>'[{"item_id":"00000000-0000-4000-8000-000000088702","quantity":1}]', p_request_id=>'s88-o6');
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088806','close_short',3);
  insert into s88_po values ('short close requires a reason', false);
exception when raise_exception then
  insert into s88_po values ('short close requires a reason', sqlerrm like 'A reason%');
end $probe$;
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088806','close_short',3,p_reason=>'Supplier short');
insert into s88_po select 'short close -> received with closed_short and event',
  po.status='received' and po.closed_short and po.close_reason='Supplier short'
  and exists (select 1 from public.purchase_order_events e where e.order_id=po.id and e.event_type='closed_short'
              and (e.payload->'missing'->0->>'remaining')::numeric=3)
from public.purchase_orders po where po.id='00000000-0000-4000-8000-000000088806';

reset role;
reset session authorization;
update atlas_private.settings_sections set settings_value = settings_value || jsonb_build_object(
  'purchase_approval_required', true, 'purchase_approval_separate_approver', true,
  'purchase_delivery_date_required_on_place', true)
where section_key='inventory';
set session authorization s88_po_probe;
set role authenticated;

-- O7: approval required, separation of duties.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":1,"unit_cost":60}]','S88 O7');
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','place',1);
  insert into s88_po values ('approval on: place from draft refused (v2)', false);
exception when raise_exception then
  insert into s88_po values ('approval on: place from draft refused (v2)', sqlerrm='This order needs approval before it is placed');
end $probe$;
do $probe$ begin
  perform public.atlas_purchase_order_command('00000000-0000-4000-8000-000000088807','place',1);
  insert into s88_po values ('approval on: place from draft refused (v1)', false);
exception when raise_exception then
  insert into s88_po values ('approval on: place from draft refused (v1)', sqlerrm='This order needs approval before it is placed');
end $probe$;
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','submit',1);
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','approve',2);
  insert into s88_po values ('separation on: submitter cannot approve', false);
exception when insufficient_privilege then insert into s88_po values ('separation on: submitter cannot approve', true); end $probe$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088502',true);
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','reject',2);
  insert into s88_po values ('reject requires a reason', false);
exception when raise_exception then insert into s88_po values ('reject requires a reason', sqlerrm like 'A reason%'); end $probe$;
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','approve',2);
insert into s88_po select 'another manager approves', status='approved' and approved_by='00000000-0000-4000-8000-000000088502'
  and submitted_by='00000000-0000-4000-8000-000000088501'
from public.purchase_orders where id='00000000-0000-4000-8000-000000088807';
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','place',3);
  insert into s88_po values ('delivery date required on place when enabled', false);
exception when raise_exception then
  insert into s88_po values ('delivery date required on place when enabled', sqlerrm='Set an expected delivery date before placing the order');
end $probe$;
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','set_delivery_date',3,p_expected_delivery_date=>current_date+7);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088807','place',4);
insert into s88_po select 'approved order places after the date is set',
  po.status='ordered' and po.expected_delivery_date=current_date+7
  and (select array_agg(event_type order by created_at, id) from public.purchase_order_events e where e.order_id=po.id)
      = array['created','submitted','approved','delivery_date_set','ordered']
from public.purchase_orders po where po.id='00000000-0000-4000-8000-000000088807';

-- O8: reject returns to draft; admin-only approver.
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088808','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":1,"unit_cost":60}]','S88 O8');
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088808','submit',1);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088501',true);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088808','reject',2,p_reason=>'Wrong supplier');
insert into s88_po select 'reject returns the order to draft', status='draft' and submitted_by is null
from public.purchase_orders where id='00000000-0000-4000-8000-000000088808';

reset role;
reset session authorization;
update atlas_private.settings_sections set settings_value = settings_value || jsonb_build_object(
  'purchase_approval_approver_role', 'admin', 'purchase_approval_separate_approver', false,
  'purchase_approval_threshold_isk', 1000)
where section_key='inventory';
set session authorization s88_po_probe;
set role authenticated;

select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088809','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":20,"unit_cost":60}]','S88 O9');
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088809','submit',1);
do $probe$ begin
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088809','approve',2);
  insert into s88_po values ('admin-only approver: manager refused', false);
exception when insufficient_privilege then insert into s88_po values ('admin-only approver: manager refused', true); end $probe$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088503',true);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088809','approve',2);
insert into s88_po select 'admin-only approver: admin approves', status='approved'
from public.purchase_orders where id='00000000-0000-4000-8000-000000088809';

-- Below the threshold (1 x 60 < 1000) approval is skipped.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088501',true);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088810','create',null,
  '00000000-0000-4000-8000-000000088601','[{"item_id":"00000000-0000-4000-8000-000000088704","quantity":1,"unit_cost":60}]','S88 O10',current_date+1);
select public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-000000088810','place',1);
insert into s88_po select 'order below the ISK threshold places without approval', status='ordered'
from public.purchase_orders where id='00000000-0000-4000-8000-000000088810';

reset role;
reset session authorization;

select jsonb_build_object(
  's88_purchasing', case when bool_and(passed) and count(*)=49 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s88_po;

rollback;
