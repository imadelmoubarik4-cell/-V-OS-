-- S89 preview-only catalog governance acceptance. Rolled back.
--
-- Covers: the mandatory duplicate guard on the design's fixture cases
-- (recall 100 %, false merges 0, active and inactive items, codes, aliases,
-- legacy canonical key, Icelandic/English pairs); guarded creation (manager
-- only, acknowledgement with a reason per candidate, identity/code/alias
-- conflicts not overridable, quantity 0, audited, idempotent); the approval
-- queue (bartender and viewer limits, definer-inserted requests forced to
-- pending, approve/reject/withdraw, self-approval flagged, stale versions);
-- alias, code, metadata and duplicate-resolution effects with no stock
-- change; append-only audit; media retention; reactivation by identity;
-- Item Master publication of the S89 columns; backfill proposals only as
-- pending requests; the S89 Data review issue codes.

begin;

create temporary table s89_gov (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s89_gov to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-000000089c01','s89-gov-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000089c02','s89-gov-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000089c03','s89-gov-view@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-000000089c01','s89-gov-mgr@example.invalid','S89 manager','manager',true),
  ('00000000-0000-4000-8000-000000089c02','s89-gov-bar@example.invalid','S89 bartender','bartender',true),
  ('00000000-0000-4000-8000-000000089c03','s89-gov-view@example.invalid','S89 viewer','viewer',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-000000089c51','S89 gov supplier',true);

-- Fixture catalogue (product data only).
insert into public.inventory_items (id,name,category,quantity,unit,size_ml,package_weight_g,package_size,sku,canonical_key,active) values
  ('00000000-0000-4000-8000-000000089d01','Giffard Vanille Syrup','Syrups',0,'bottles',1000,null,null,null,'giffard-vanilla',true),
  ('00000000-0000-4000-8000-000000089d02','Giffard Salted Caramel Syrup','Syrups',0,'bottles',1000,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d03','Giffard Caramel','Syrups',0,'bottles',1000,null,null,null,null,false),
  ('00000000-0000-4000-8000-000000089d04','Giffard Banana Syrup 1L','Syrups',0,'bottles',null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d05','Giffard Peach Syrup','Syrups',0,'bottles',1000,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d06','Lemons 15 kg','Fresh Fruit',0,'boxes',null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d07','Haframjólk Natrue Barista 1L','Coffee & Hot Drinks',0,'cartons',null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d08','BOTANICA Dried Pineapple','Bar Ingredients',0,'packs',null,150,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d09','Demerara Sugar Cube','Bar Ingredients',0,'boxes',null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d10','Sykur 1kg','Bar Ingredients',0,'kg',null,null,null,null,'sugar',true),
  ('00000000-0000-4000-8000-000000089d11','Britvic Tonic 200ml','Soda & Mixer',0,'bottles',null,null,null,null,'tonic-water',true),
  ('00000000-0000-4000-8000-000000089d12','Fever-Tree Pink Grapefruit 200ml','Soda & Mixer',0,'cans',null,null,null,null,'grapefruit-tonic',true),
  ('00000000-0000-4000-8000-000000089d13','Don Simon Cranberry Juice 1L','Soda & Mixer',0,'cartons',null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089d14','Straws','Consumables',0,'packs',null,null,'1250 pcs','STRAW-1250',null,true),
  ('00000000-0000-4000-8000-000000089d15','Giffard Mango Syrup','Syrups',0,'bottles',1000,null,null,null,null,true);
-- A pre-S89 owner alias (status null = legacy, unclassified).
insert into public.inventory_aliases (alias, canonical_key, item_id, source_note)
values ('Giffard Vanilla', 'giffard-vanilla', '00000000-0000-4000-8000-000000089d01', 'Owner-provided inventory snapshot name');

-- 1. Duplicate guard on the design fixture cases.
create temporary table s89_cases (case_id text, draft jsonb, codes jsonb, expected uuid, must_not uuid[]) on commit drop;
insert into s89_cases values
  ('G-01','{"name":"Giffard Vanilla"}','[]', '00000000-0000-4000-8000-000000089d01', array['00000000-0000-4000-8000-000000089d02','00000000-0000-4000-8000-000000089d05']::uuid[]),
  ('G-02','{"name":"Giffard Vanille"}','[]', '00000000-0000-4000-8000-000000089d01', array['00000000-0000-4000-8000-000000089d02']::uuid[]),
  ('G-03','{"name":"Giffard Vanille Syrup","size_ml":1000}','[]', '00000000-0000-4000-8000-000000089d01', array['00000000-0000-4000-8000-000000089d15']::uuid[]),
  ('G-04','{"name":"Giffard Vanille Syrup 1L"}','[]', '00000000-0000-4000-8000-000000089d01', '{}'),
  ('G-05','{"name":"GIFFARD SIROP VANILLE 1L"}','[]', '00000000-0000-4000-8000-000000089d01', array['00000000-0000-4000-8000-000000089d04']::uuid[]),
  ('G-07','{"name":"Giffard Caramel","size_ml":1000}','[]', '00000000-0000-4000-8000-000000089d03', array['00000000-0000-4000-8000-000000089d01','00000000-0000-4000-8000-000000089d02']::uuid[]),
  ('G-08','{"name":"Giffard Banane du Brésil","size_ml":700,"item_class":"liqueur"}','[]', null, array['00000000-0000-4000-8000-000000089d04']::uuid[]),
  ('I-01','{"name":"Sítrónur 15kg","category":"Fresh Fruit"}','[]', '00000000-0000-4000-8000-000000089d06', '{}'),
  ('I-01b','{"name":"Sitronur 15 kg"}','[]', '00000000-0000-4000-8000-000000089d06', '{}'),
  ('I-02','{"name":"Haframjólk Natrue Barista","size_ml":1000}','[]', '00000000-0000-4000-8000-000000089d07', '{}'),
  ('I-02b','{"name":"Natrue Barista Oat Milk","package_size":"6 x 1 L","unit":"cases"}','[]', '00000000-0000-4000-8000-000000089d07', '{}'),
  ('I-03','{"name":"BOTANICA Þurrkaður Ananas 150g"}','[]', '00000000-0000-4000-8000-000000089d08', '{}'),
  ('I-04','{"name":"Don Simon trönuberjasafi 1L"}','[]', '00000000-0000-4000-8000-000000089d13', '{}'),
  ('T-01','{"name":"Fever-Tree Pink Grapefruit","size_ml":200}','[]', '00000000-0000-4000-8000-000000089d12', array['00000000-0000-4000-8000-000000089d11']::uuid[]),
  ('T-02','{"name":"Tonic water"}','[]', '00000000-0000-4000-8000-000000089d11', '{}'),
  ('O-01','{"name":"Plastic straws black"}','[{"kind":"sku","code":"straw-1250"}]', '00000000-0000-4000-8000-000000089d14', '{}'),
  ('N-01','{"name":"Demerara raw sugar","package_weight_g":1000,"category":"Bar Ingredients"}','[]', null,
    array['00000000-0000-4000-8000-000000089d09','00000000-0000-4000-8000-000000089d10']::uuid[]);
create temporary table s89_results on commit drop as
select c.case_id, c.expected, c.must_not,
       atlas_private.catalog_find_duplicates_core(c.draft, c.codes, '[]'::jsonb, null, 25) as result
from s89_cases c;
create temporary view s89_scores as
select r.case_id, r.expected, r.must_not, (x->>'item_id')::uuid as item_id, (x->>'score')::numeric as score,
       (x->>'requires_ack')::boolean as requires_ack, ordinality as rank
from s89_results r cross join lateral jsonb_array_elements(r.result->'candidates') with ordinality as t(x, ordinality);

insert into s89_gov select 'duplicate guard recall is 100 % on the fixture cases',
  bool_and(exists (select 1 from s89_scores s where s.case_id = r.case_id and s.item_id = r.expected and s.requires_ack))
from s89_results r where r.expected is not null;
insert into s89_gov select 'duplicate guard false merges are 0 on the fixture cases',
  not exists (
    select 1 from s89_scores s
    where s.item_id = any(s.must_not)
      and (s.score >= 0.85
           or (s.expected is not null and s.rank < coalesce((select e.rank from s89_scores e where e.case_id = s.case_id and e.item_id = s.expected), 999))));
insert into s89_gov select 'the Giffard siblings are kept apart by variant and size',
  coalesce((select max(score) from s89_scores where case_id in ('G-01','G-02','G-05') and item_id in
    ('00000000-0000-4000-8000-000000089d02','00000000-0000-4000-8000-000000089d05','00000000-0000-4000-8000-000000089d15')), 0) < 0.6
  and coalesce((select max(score) from s89_scores where case_id = 'G-08'), 0) < 0.6;
insert into s89_gov select 'the inactive historical item is found (Giffard Caramel)',
  exists (select 1 from s89_scores s join public.inventory_items i on i.id = s.item_id
          where s.case_id = 'G-07' and s.item_id = s.expected and not i.active and s.score >= 0.85);
insert into s89_gov select 'Demerara raw sugar lists its neighbours below the acknowledgement line',
  not exists (select 1 from s89_scores where case_id = 'N-01' and requires_ack)
  and exists (select 1 from s89_scores where case_id = 'N-01' and item_id = '00000000-0000-4000-8000-000000089d09');
insert into s89_gov select 'a shared SKU is a code collision (score 1)',
  exists (select 1 from s89_results r, jsonb_array_elements(r.result->'candidates') c
          where r.case_id = 'O-01' and (c->>'code_collision')::boolean and (c->>'score')::numeric = 1)
  and jsonb_array_length((select result->'code_conflicts' from s89_results where case_id = 'O-01')) = 1;
insert into s89_gov select 'the legacy alias and canonical key count as evidence',
  exists (select 1 from s89_results r, jsonb_array_elements(r.result->'candidates') c, jsonb_array_elements(c->'evidence') e
          where r.case_id = 'G-01' and c->>'item_id' = '00000000-0000-4000-8000-000000089d01' and e->>'signal' in ('alias','legacy_key'))
  and exists (select 1 from s89_results r, jsonb_array_elements(r.result->'candidates') c, jsonb_array_elements(c->'evidence') e
          where r.case_id = 'T-02' and e->>'signal' = 'legacy_key');

-- 2. Guarded creation.
do $probe$ begin
  perform public.atlas_catalog_create_item('{"name":"Giffard Vanilla"}','[]','[]',null,null,null,'s89-create-1',
    '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('creation without acknowledgement is refused with the candidates', false);
exception when others then
  insert into s89_gov values ('creation without acknowledgement is refused with the candidates',
    sqlerrm like 'Possible existing matches found%');
end $probe$;
do $probe$ begin
  perform public.atlas_catalog_create_item('{"name":"Giffard Vanilla"}','[]','[]',null,
    '{"acknowledged":[{"item_id":"00000000-0000-4000-8000-000000089d01","reason":""}]}',null,'s89-create-2',
    '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('an acknowledgement needs a reason', false);
exception when others then
  insert into s89_gov values ('an acknowledgement needs a reason', sqlerrm like 'Possible existing matches found%');
end $probe$;
do $probe$ begin
  perform public.atlas_catalog_create_item('{"name":"New gin"}','[]','[]',null,null,null,'s89-create-3',
    '00000000-0000-4000-8000-000000089c02','S89 bartender');
  insert into s89_gov values ('bartenders cannot create items', false);
exception when insufficient_privilege then
  insert into s89_gov values ('bartenders cannot create items', true);
end $probe$;
do $probe$ begin
  perform public.atlas_catalog_create_item('{"name":"Giffard Vanille Syrup","size_ml":1000}','[]','[]',null,
    '{"acknowledged":[{"item_id":"00000000-0000-4000-8000-000000089d01","reason":"testing override"}]}',null,'s89-create-4',
    '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('an identical active identity cannot be acknowledged away', false);
exception when unique_violation then
  insert into s89_gov values ('an identical active identity cannot be acknowledged away', true);
end $probe$;
do $probe$ begin
  perform public.atlas_catalog_create_item('{"name":"Straw special"}','[{"kind":"sku","code":"STRAW-1250"}]','[]',null,
    '{"acknowledged":[{"item_id":"00000000-0000-4000-8000-000000089d14","reason":"testing override"}]}',null,'s89-create-5',
    '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('a code collision cannot be acknowledged away', false);
exception when unique_violation then
  insert into s89_gov values ('a code collision cannot be acknowledged away', true);
end $probe$;
create temporary table s89_created on commit drop as
select public.atlas_catalog_create_item(
  '{"name":"Demerara Raw Sugar","brand":"Tate & Lyle","category":"Bar Ingredients","subcategory":"Sugar","unit":"kg","packaging_type":"bag","unit_size_quantity":1000,"unit_size_base":"g","item_class":"bar_ingredient"}',
  '[{"kind":"gtin","code":"96385074"}]', '["Demerara hrásykur"]', null, null, null, 's89-create-6',
  '00000000-0000-4000-8000-000000089c01','S89 manager') as r;
insert into s89_gov select 'a checked new item is created at quantity 0 with its code and Icelandic alias',
  i.quantity = 0 and i.active and i.package_weight_g = 1000 and i.unit_size_base = 'g' and i.item_class = 'bar_ingredient'
  and exists (select 1 from atlas_private.inventory_item_codes c where c.item_id = i.id and c.code_normalized = '00000096385074')
  and exists (select 1 from public.inventory_aliases a where a.item_id = i.id and a.alias = 'Demerara hrásykur' and a.status = 'approved')
  and exists (select 1 from atlas_private.catalog_events e where e.item_id = i.id and e.event_type = 'item_created')
  and (r->>'stock_changed')::boolean = false
from s89_created, public.inventory_items i where i.id = (r->>'item_id')::uuid;
insert into s89_gov select 'creation is idempotent on the request id',
  (public.atlas_catalog_create_item('{"name":"Demerara Raw Sugar"}','[]','[]',null,null,null,'s89-create-6',
    '00000000-0000-4000-8000-000000089c01','S89 manager')->>'replayed')::boolean
  and (select count(*) from public.inventory_items where name = 'Demerara Raw Sugar') = 1;
create temporary table s89_created_ack on commit drop as
select public.atlas_catalog_create_item('{"name":"Giffard Vanilla Syrup Special","category":"Syrups"}','[]','[]',null,
  jsonb_build_object('acknowledged', (select jsonb_agg(jsonb_build_object('item_id', c->'item_id', 'reason', 'Different size'))
    from jsonb_array_elements(atlas_private.catalog_find_duplicates_core('{"name":"Giffard Vanilla Syrup Special","category":"Syrups"}',
      '[]','[]',null,25)->'candidates') c where (c->>'requires_ack')::boolean)),
  null,'s89-create-7','00000000-0000-4000-8000-000000089c01','S89 manager') as r;
insert into s89_gov select '"Create anyway" with a reason per candidate is audited',
  exists (select 1 from atlas_private.catalog_events e where e.item_id = (r->>'item_id')::uuid and e.event_type = 'duplicate_acknowledged'
          and jsonb_array_length(e.payload->'acknowledged') >= 1)
from s89_created_ack;

-- 3. Queue: staff proposals, definer-forced pending, decisions.
create temporary table s89_req on commit drop as
select 'alias'::text as label, public.atlas_recognition_propose('alias',
  '{"item_id":"00000000-0000-4000-8000-000000089d06","alias":"Sítrónur 15kg","alias_kind":"product_name","language":"is"}',
  '{}', null, null, 's89-req-alias', '00000000-0000-4000-8000-000000089c02','S89 bartender','bartender')->'request' as r;
insert into s89_req select 'code', public.atlas_recognition_propose('code',
  '{"item_id":"00000000-0000-4000-8000-000000089d12","kind":"gtin","code":"5010677850209","pack_level":"unit"}',
  '{}', null, null, 's89-req-code', '00000000-0000-4000-8000-000000089c02','S89 bartender','bartender')->'request';
insert into s89_req select 'new_item', public.atlas_recognition_propose('new_item',
  '{"values":{"name":"Giffard Vanille","category":"Syrups"}}',
  '{}', null, null, 's89-req-new', '00000000-0000-4000-8000-000000089c02','S89 bartender','bartender')->'request';
insert into s89_req select 'meta', public.atlas_recognition_propose('metadata_correction',
  '{"item_id":"00000000-0000-4000-8000-000000089d01","values":{"brand":"Giffard","variant":"Vanille","item_class":"syrup"},"expected":{"brand":null}}',
  '{}', null, null, 's89-req-meta', '00000000-0000-4000-8000-000000089c02','S89 bartender','bartender')->'request';
insert into s89_req select 'wrong', public.atlas_recognition_propose('wrong_match_report',
  '{"item_id":"00000000-0000-4000-8000-000000089d02","note":"Label reads Vanille"}',
  '{}', null, null, 's89-req-wrong', '00000000-0000-4000-8000-000000089c03','S89 viewer','viewer')->'request';
insert into s89_gov select 'staff proposals are pending; the new-item draft carries its duplicate check',
  (select bool_and(r->>'status' = 'pending') from s89_req)
  and (select jsonb_array_length(r->'duplicate_check'->'requires_ack') > 0 from s89_req where label = 'new_item');
do $probe$ begin
  perform public.atlas_recognition_propose('alias','{"item_id":"00000000-0000-4000-8000-000000089d06","alias":"x lemons"}','{}',null,null,
    's89-req-view', '00000000-0000-4000-8000-000000089c03','S89 viewer','viewer');
  insert into s89_gov values ('viewers may only report a wrong match', false);
exception when insufficient_privilege then
  insert into s89_gov values ('viewers may only report a wrong match', true);
end $probe$;
do $probe$ begin
  set local role atlas_recognition_definer;
  insert into atlas_private.catalog_change_requests (kind,status,payload,source,requested_by,requested_by_label,requested_by_role,decided_at,decided_by)
  values ('alias','applied','{}','recognition','00000000-0000-4000-8000-000000089c02','x','bartender',now(),'00000000-0000-4000-8000-000000089c02');
  reset role;
  insert into s89_gov select 'a definer insert is forced to pending and undecided',
    exists (select 1 from atlas_private.catalog_change_requests where payload = '{}'::jsonb and status = 'pending' and decided_at is null);
exception when others then
  reset role;
  insert into s89_gov values ('a definer insert is forced to pending and undecided', false);
end $probe$;
do $probe$ begin
  set local role atlas_recognition_definer;
  update atlas_private.catalog_change_requests set status = 'approved';
  reset role;
  insert into s89_gov values ('the definer cannot approve anything', false);
exception when insufficient_privilege then
  reset role;
  insert into s89_gov values ('the definer cannot approve anything', true);
end $probe$;
do $probe$ begin
  perform public.atlas_catalog_request_decide((select (r->>'id')::uuid from s89_req where label='alias'), 'approve', null, null, null,
    '00000000-0000-4000-8000-000000089c02','S89 bartender');
  insert into s89_gov values ('bartenders cannot decide', false);
exception when insufficient_privilege then
  insert into s89_gov values ('bartenders cannot decide', true);
end $probe$;

select public.atlas_catalog_request_decide((select (r->>'id')::uuid from s89_req where label='alias'), 'approve', 'ok', 1, null,
  '00000000-0000-4000-8000-000000089c01','S89 manager');
select public.atlas_catalog_request_decide((select (r->>'id')::uuid from s89_req where label='code'), 'approve', 'ok', 1, null,
  '00000000-0000-4000-8000-000000089c01','S89 manager');
select public.atlas_catalog_request_decide((select (r->>'id')::uuid from s89_req where label='meta'), 'approve', 'ok', 1, null,
  '00000000-0000-4000-8000-000000089c01','S89 manager');
select public.atlas_catalog_request_decide((select (r->>'id')::uuid from s89_req where label='new_item'), 'reject', 'Use Giffard Vanille Syrup', 1, null,
  '00000000-0000-4000-8000-000000089c01','S89 manager');
insert into s89_gov select 'approved alias, code and metadata are applied and audited',
  exists (select 1 from public.inventory_aliases where item_id='00000000-0000-4000-8000-000000089d06' and alias='Sítrónur 15kg' and status='approved' and source='recognition')
  and exists (select 1 from atlas_private.inventory_item_codes where item_id='00000000-0000-4000-8000-000000089d12' and code_normalized='05010677850209' and source='recognition_confirmed')
  and exists (select 1 from public.inventory_items where id='00000000-0000-4000-8000-000000089d01' and brand='Giffard' and variant='Vanille' and item_class='syrup'
              and attributes_source->'brand'->>'source' = 'recognition')
  and (select count(*) from atlas_private.catalog_change_requests where request_id in ('s89-req-alias','s89-req-code','s89-req-meta') and status='applied') = 3
  and (select status from atlas_private.catalog_change_requests where request_id='s89-req-new') = 'rejected'
  and (select count(*) from atlas_private.catalog_events e join atlas_private.catalog_change_requests r on r.id = e.change_request_id
       where r.request_id in ('s89-req-alias','s89-req-code','s89-req-meta') and e.event_type = 'request_applied') = 3;
do $probe$ begin
  perform public.atlas_catalog_request_decide((select (r->>'id')::uuid from s89_req where label='alias'), 'approve', null, null, null,
    '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('a decided request cannot be decided again', false);
exception when others then
  insert into s89_gov values ('a decided request cannot be decided again', sqlerrm = 'This request was already decided');
end $probe$;
create temporary table s89_t1 on commit drop as select public.atlas_catalog_request_create('alias', null,
  '{"item_id":"00000000-0000-4000-8000-000000089d01","alias":"Vanilla syrup Giffard"}', '{}', 'manager', null, null, null,
  's89-req-self', true, '00000000-0000-4000-8000-000000089c01','S89 manager') as r;
insert into s89_gov select 'a manager self-approval is applied and flagged',
  (r->>'status') = 'applied' and (r->>'self_approved')::boolean
  and exists (select 1 from public.inventory_aliases a where a.alias = 'Vanilla syrup Giffard' and a.status='approved')
from s89_t1;
do $probe$ begin
  perform public.atlas_catalog_request_create('alias', null,
    '{"item_id":"00000000-0000-4000-8000-000000089d02","alias":"Giffard Peach Syrup"}', '{}', 'manager', null, null, null,
    's89-req-conflict', true, '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('an alias that names another item is refused', false);
exception when unique_violation then
  insert into s89_gov values ('an alias that names another item is refused', true);
end $probe$;
insert into s89_gov select 'a request can be withdrawn only by its author',
  (public.atlas_catalog_request_withdraw((select (r->>'id')::uuid from s89_req where label='wrong'),
    '00000000-0000-4000-8000-000000089c03','S89 viewer')->>'status') = 'withdrawn';

-- 4. Duplicate resolution: no stock transfer, preconditions enforced.
insert into public.recipes (id,name,active) values ('00000000-0000-4000-8000-000000089e01','S89 Sour',true);
insert into public.inventory_items (id,name,category,quantity,unit,active) values
  ('00000000-0000-4000-8000-000000089d20','Sítrónusafi ferskur','Soda & Mixer',3,'bottles',true);
insert into public.recipe_ingredients (id,recipe_id,item_id,item_name,quantity,unit) values
  ('00000000-0000-4000-8000-000000089e11','00000000-0000-4000-8000-000000089e01','00000000-0000-4000-8000-000000089d20','Sítrónusafi',30,'ml');
insert into atlas_private.inventory_item_codes (item_id,kind,code_raw,code_normalized,source)
values ('00000000-0000-4000-8000-000000089d20','gtin','4006381333931','x','manager');
create temporary table s89_stock on commit drop as
  select (select coalesce(sum(quantity),0) from public.inventory_items) as total,
         (select count(*) from public.inventory_movements) as movements;
create temporary table s89_t2 on commit drop as select public.atlas_catalog_request_create('duplicate_resolution', null,
  '{"keep_item_id":"00000000-0000-4000-8000-000000089d13","retire_item_id":"00000000-0000-4000-8000-000000089d20","reason":"same juice"}',
  '{}', 'data_review', null, null, null, 's89-dup-1', true, '00000000-0000-4000-8000-000000089c01','S89 manager') as r;
insert into s89_gov select 'duplicate resolution retires B into A without moving stock',
  (r->>'status') = 'applied'
  and not (select active from public.inventory_items where id='00000000-0000-4000-8000-000000089d20')
  and (select quantity from public.inventory_items where id='00000000-0000-4000-8000-000000089d20') = 3
  and (select item_id from public.recipe_ingredients where id='00000000-0000-4000-8000-000000089e11') = '00000000-0000-4000-8000-000000089d13'
  and exists (select 1 from atlas_private.inventory_item_codes where item_id='00000000-0000-4000-8000-000000089d13' and code_normalized='04006381333931' and status='active')
  and exists (select 1 from public.inventory_aliases where item_id='00000000-0000-4000-8000-000000089d13' and alias='Sítrónusafi ferskur' and alias_kind='legacy_name')
  and (select coalesce(sum(quantity),0) from public.inventory_items) = (select total from s89_stock)
  and (select count(*) from public.inventory_movements) = (select movements from s89_stock)
  and (r->'applied_result'->>'quantity_transferred')::boolean = false
from s89_t2;
insert into public.purchase_orders (id, supplier_id, status, lines, created_by, updated_by) values
  ('00000000-0000-4000-8000-000000089f01', '00000000-0000-4000-8000-000000089c51', 'draft',
   '[{"item_id":"00000000-0000-4000-8000-000000089d05","quantity":1}]',
   '00000000-0000-4000-8000-000000089c01', '00000000-0000-4000-8000-000000089c01');
do $probe$ begin
  perform public.atlas_catalog_request_create('duplicate_resolution', null,
    '{"keep_item_id":"00000000-0000-4000-8000-000000089d15","retire_item_id":"00000000-0000-4000-8000-000000089d05"}',
    '{}', 'manager', null, null, null, 's89-dup-2', true, '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('an item on an open purchase order cannot be retired', false);
exception when others then
  insert into s89_gov values ('an item on an open purchase order cannot be retired', sqlerrm like 'The duplicate is on an open purchase order%'
    and (select active from public.inventory_items where id='00000000-0000-4000-8000-000000089d05'));
end $probe$;
create temporary table s89_t3 on commit drop as select public.atlas_catalog_request_create('duplicate_resolution', null,
  '{"keep_item_id":"00000000-0000-4000-8000-000000089d02","retire_item_id":"00000000-0000-4000-8000-000000089d03","mode":"not_duplicates","reason":"salted is a different syrup"}',
  '{}', 'manager', null, null, null, 's89-dup-3', true, '00000000-0000-4000-8000-000000089c01','S89 manager') as r;
insert into s89_gov select '"Not duplicates" is remembered',
  exists (select 1 from atlas_private.catalog_distinct_pairs where
    item_a = least('00000000-0000-4000-8000-000000089d02'::uuid,'00000000-0000-4000-8000-000000089d03'::uuid))
from s89_t3;

-- 5. Audit, media retention, reactivation, Item Master, backfill, Data review.
do $probe$ begin
  update atlas_private.catalog_events set payload = '{}'::jsonb;
  insert into s89_gov values ('the catalogue audit is append-only', false);
exception when insufficient_privilege then
  insert into s89_gov values ('the catalogue audit is append-only', not has_table_privilege('service_role','atlas_private.catalog_events','UPDATE')
    and not has_table_privilege('service_role','atlas_private.catalog_events','DELETE'));
end $probe$;

insert into atlas_private.ai_media (id,user_id,path,mime,bytes,kind,expires_at,purpose) values
  ('00000000-0000-4000-8000-000000089a91','00000000-0000-4000-8000-000000089c02',
   '00000000-0000-4000-8000-000000089c02/unsorted/00000000-0000-4000-8000-000000089a92.jpg','image/jpeg',1000,'image',now() + interval '30 days','recognition');
select public.atlas_recognition_propose('wrong_match_report','{"item_id":"00000000-0000-4000-8000-000000089d02","note":"wrong"}','{}',
  null,'00000000-0000-4000-8000-000000089a91','s89-media-1','00000000-0000-4000-8000-000000089c02','S89 bartender','bartender');
insert into s89_gov select 'a disputed-match image is kept (no expiry) for the audit record',
  expires_at is null and retention_reason = 'disputed_match'
from atlas_private.ai_media where id = '00000000-0000-4000-8000-000000089a91';

insert into public.inventory_items (id,name,category,quantity,unit,size_ml,active) values
  ('00000000-0000-4000-8000-000000089d21','Vanille Giffard Syrup','Syrups',0,'bottles',1000,false);
insert into s89_gov select 'the S88 reactivation guard now uses the identity key',
  (public.atlas_inventory_item_dependencies('00000000-0000-4000-8000-000000089d21','00000000-0000-4000-8000-000000089c01')
     ->'active_name_duplicate'->>'id') = '00000000-0000-4000-8000-000000089d01';
do $probe$ begin
  perform public.atlas_set_inventory_item_active('00000000-0000-4000-8000-000000089d21', true, null, null,
    '00000000-0000-4000-8000-000000089c01','S89 manager');
  insert into s89_gov values ('the S88 reactivation command refuses a same-identity item', false);
exception when others then
  insert into s89_gov values ('the S88 reactivation command refuses a same-identity item', sqlerrm like 'An active item with the same name exists%');
end $probe$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000089c01',true);
create temporary table s89_im on commit drop as select public.atlas_apply_item_master_update('00000000-0000-4000-8000-000000089d05',
  '{"product_name":"Peach Syrup","unit_size_quantity":1000,"unit_size_base":"ml"}', '{}',
  (select jsonb_build_object('par_level',par_level,'critical_minimum',critical_minimum,'supplier_id',supplier_id,'supplier',supplier,
     'supplier_product_reference',supplier_product_reference,'units_per_case',units_per_case,'size_ml',size_ml,
     'package_weight_g',package_weight_g,'package_size',package_size,'cost_price',cost_price,'case_cost',case_cost,
     'bin_location',bin_location,'lead_time_days',lead_time_days,'minimum_order_quantity',minimum_order_quantity,'product_name',null)
   from public.inventory_items where id='00000000-0000-4000-8000-000000089d05'), 's89-im-1') as r;
insert into s89_gov select 'Item Master publication accepts the S89 attribute columns',
  (r->>'quantity_mutated')::boolean = false
  and (select product_name = 'Peach Syrup' and unit_size_quantity = 1000 and unit_size_base = 'ml' from public.inventory_items where id='00000000-0000-4000-8000-000000089d05')
from s89_im;
select set_config('request.jwt.claim.sub','',true);

create temporary table s89_before on commit drop as
  select id, item_class, unit_size_quantity from public.inventory_items;
create temporary table s89_t4 on commit drop as select public.atlas_catalog_propose_backfill(500, '00000000-0000-4000-8000-000000089c01','S89 manager') as r;
insert into s89_gov select 'backfill proposals only create pending requests',
  (r->>'created')::integer > 0
  and not exists (select 1 from public.inventory_items i join s89_before b using (id)
                  where i.item_class is distinct from b.item_class or i.unit_size_quantity is distinct from b.unit_size_quantity)
  and exists (select 1 from atlas_private.catalog_change_requests where source = 'backfill' and status = 'pending'
              and subject_item_id = '00000000-0000-4000-8000-000000089d06' and payload->'values'->>'item_class' = 'produce'
              and (payload->'values'->>'unit_size_quantity')::numeric = 15000)
from s89_t4;

insert into public.inventory_items (id,name,category,quantity,unit,active) values
  ('00000000-0000-4000-8000-000000089d22','Sítrónur 15kg','S89 Unknown shelf',0,'boxes',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000089c01',true);
create temporary table s89_summary on commit drop as select public.atlas_data_review_summary() as s;
insert into s89_gov select 'Data review lists the S89 issue codes with counts',
  (select count(*) from jsonb_array_elements(s->'issues') i where i->>'code' in
    ('inventory.possible_duplicate','catalog.pending_approval','catalog.code_collision','inventory.category_unmapped')) = 4
  and (select (i->>'count')::integer from jsonb_array_elements(s->'issues') i where i->>'code' = 'catalog.pending_approval') > 0
from s89_summary;
insert into s89_gov select 'possible duplicates pair Sítrónur/Lemons-style items and skip distinct pairs',
  exists (select 1 from jsonb_array_elements(public.atlas_data_review_rows('inventory.possible_duplicate', 500, 0)->'rows') r
          where r->>'entity_id' = '00000000-0000-4000-8000-000000089d22'
            and r->'detail'->>'other_item_id' = '00000000-0000-4000-8000-000000089d06')
  and not exists (select 1 from atlas_private.catalog_possible_duplicate_pairs(0.75) p
                  where least(p.item_a, p.item_b) = least('00000000-0000-4000-8000-000000089d02'::uuid,'00000000-0000-4000-8000-000000089d03'::uuid)
                    and greatest(p.item_a, p.item_b) = greatest('00000000-0000-4000-8000-000000089d02'::uuid,'00000000-0000-4000-8000-000000089d03'::uuid));
insert into s89_gov select 'category_unmapped flags categories outside the taxonomy',
  exists (select 1 from jsonb_array_elements(public.atlas_data_review_rows('inventory.category_unmapped', 500, 0)->'rows') r
          where r->>'entity_id' = '00000000-0000-4000-8000-000000089d22')
  and not exists (select 1 from jsonb_array_elements(public.atlas_data_review_rows('inventory.category_unmapped', 500, 0)->'rows') r
                  where r->>'entity_id' = '00000000-0000-4000-8000-000000089d01');
select set_config('request.jwt.claim.sub','',true);

insert into s89_gov select 'no catalogue command is executable by anon or authenticated',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','atlas_private') and (p.proname like '%catalog%' or p.proname like '%recognition%')
      and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')));

select jsonb_build_object(
  's89_catalog_governance', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s89_gov;

rollback;
