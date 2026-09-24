-- S88 preview-only Data review and par levels acceptance. Seeds its own
-- fixtures inside one transaction, prints one JSON verdict and rolls back.

begin;

create temporary table s88_dr (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s88_dr to authenticated;
create temporary table s88_dr_state (key text primary key, value jsonb) on commit drop;
grant all on table s88_dr_state to authenticated;
create role s88_dr_probe nologin;
grant authenticated to s88_dr_probe;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-000000088511'::uuid,'s88-dr-manager@example.invalid'),
  ('00000000-0000-4000-8000-000000088512'::uuid,'s88-dr-bartender@example.invalid'),
  ('00000000-0000-4000-8000-000000088513'::uuid,'s88-dr-inactive@example.invalid')
) as u(id, email);
update public.profiles set role='manager', active=true where id='00000000-0000-4000-8000-000000088511';
update public.profiles set role='bartender', active=true where id='00000000-0000-4000-8000-000000088512';
update public.profiles set role='manager', active=false where id='00000000-0000-4000-8000-000000088513';

insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-000000088611','S88 DR supplier',true);

-- Data review fixtures. Baseline = complete; each row breaks one rule.
insert into public.inventory_items (id,name,category,quantity,unit,active,supplier_id,supplier,cost_price,case_cost,units_per_case,sku,barcode,supplier_product_reference,size_ml,package_weight_g,package_size,par_level,needs_review) values
  ('00000000-0000-4000-8000-000000088901','S88 DR complete','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,'S88-DR-01',null,null,700,null,null,5,false),
  ('00000000-0000-4000-8000-000000088902','S88 DR supplier text','Test',0,'bottles',true,null,'Acme',10,null,null,'S88-DR-02',null,null,700,null,null,5,false),
  ('00000000-0000-4000-8000-000000088903','S88 DR no cost','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,null,null,null,'S88-DR-03',null,null,700,null,null,5,false),
  ('00000000-0000-4000-8000-000000088904','S88 DR case cost only','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,null,60,6,'S88-DR-04',null,null,700,null,null,5,false),
  ('00000000-0000-4000-8000-000000088905','S88 DR alias only','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,null,null,null,700,null,null,5,false),
  ('00000000-0000-4000-8000-000000088906','S88 DR no reference','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,null,null,null,700,null,null,5,false),
  ('00000000-0000-4000-8000-000000088907','S88 DR no package','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,'S88-DR-07',null,null,null,null,null,5,false),
  ('00000000-0000-4000-8000-000000088908','S88 DR multipack','Test',0,'cases',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,'S88-DR-08',null,null,null,null,'24 x 330ml',5,false),
  ('00000000-0000-4000-8000-000000088909','S88 DR readable package','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,'S88-DR-09',null,null,null,null,'700 ml',5,false),
  ('00000000-0000-4000-8000-000000088910','S88 DR no par','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,'S88-DR-10',null,null,700,null,null,null,false),
  ('00000000-0000-4000-8000-000000088911','S88 DR flagged','Test',0,'bottles',true,'00000000-0000-4000-8000-000000088611',null,10,null,null,'S88-DR-11',null,null,700,null,null,5,true),
  ('00000000-0000-4000-8000-000000088912','S88 DR inactive everything','Test',0,'bottles',false,null,'Old',null,null,null,null,null,null,null,null,'24 x 330ml',null,true);
insert into atlas_private.inventory_scan_aliases (normalized_code,raw_code,external_item_id,external_item_name,active)
values ('s88dralias0001','S88DRALIAS0001','00000000-0000-4000-8000-000000088905','S88 DR alias only',true);

insert into public.recipes (id,name,active,menu_price) values
  ('00000000-0000-4000-8000-000000089001','S88 DR recipe complete',true,1500),
  ('00000000-0000-4000-8000-000000089002','S88 DR recipe no price',true,null),
  ('00000000-0000-4000-8000-000000089003','S88 DR recipe empty',true,1500),
  ('00000000-0000-4000-8000-000000089004','S88 DR recipe unlinked',true,1500),
  ('00000000-0000-4000-8000-000000089005','S88 DR recipe inactive item',true,1500),
  ('00000000-0000-4000-8000-000000089006','S88 DR recipe retired',false,null);
insert into public.recipe_ingredients (id,recipe_id,item_id,item_name,quantity,unit) values
  ('00000000-0000-4000-8000-000000089101','00000000-0000-4000-8000-000000089001','00000000-0000-4000-8000-000000088901','S88 DR complete',1,'bottles'),
  ('00000000-0000-4000-8000-000000089102','00000000-0000-4000-8000-000000089002','00000000-0000-4000-8000-000000088901','S88 DR complete',1,'bottles'),
  ('00000000-0000-4000-8000-000000089104','00000000-0000-4000-8000-000000089004',null,'Mystery syrup',1,'ml'),
  ('00000000-0000-4000-8000-000000089105','00000000-0000-4000-8000-000000089005','00000000-0000-4000-8000-000000088912','S88 DR inactive everything',1,'bottles');

-- Par fixtures.
insert into public.inventory_items (id,name,category,quantity,unit,active,par_level,critical_minimum) values
  ('00000000-0000-4000-8000-000000088921','S88 PAR A','Test',0,'bottles',true,5,null),
  ('00000000-0000-4000-8000-000000088922','S88 PAR B','Test',0,'bottles',true,null,null),
  ('00000000-0000-4000-8000-000000088923','S88 PAR C','Test',0,'bottles',true,10,4);

-- Evidence fixtures: items, verified and unverified count sessions, restocks.
insert into public.inventory_items (id,name,category,quantity,unit,active,units_per_case,source_type,source_confidence,source_confirmed_at,source_confirmed_quantity) values
  ('00000000-0000-4000-8000-000000088931','S88 EV eligible','Test',0,'bottles',true,6,null,null,null,null),
  ('00000000-0000-4000-8000-000000088932','S88 EV two counts','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088933','S88 EV negative','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088934','S88 EV unit change','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088935','S88 EV fourteen days','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088936','S88 EV short span','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088937','S88 EV unverified','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088938','S88 EV historical','Test',0,'bottles',true,null,null,null,null,null),
  ('00000000-0000-4000-8000-000000088939','S88 EV owner confirmed','Test',0,'bottles',true,null,'owner_confirmed',100,now()-interval '1 day',4),
  ('00000000-0000-4000-8000-000000088940','S88 EV flat','Test',0,'bottles',true,null,null,null,null,null);

insert into atlas_private.inventory_count_sessions (id,session_key,client_request_id,title,status,started_by,started_by_label,verified_at,submitted_at)
select s.id, 's88-ev-'||s.n, 's88-ev-'||s.n, 'S88 evidence '||s.n, s.status, '00000000-0000-4000-8000-000000088511', 'S88',
       case when s.status='verified' then now() end, case when s.status='submitted' then now() end
from (values
  ('00000000-0000-4000-8000-000000089201'::uuid,1,'verified'),
  ('00000000-0000-4000-8000-000000089202'::uuid,2,'verified'),
  ('00000000-0000-4000-8000-000000089203'::uuid,3,'verified'),
  ('00000000-0000-4000-8000-000000089211'::uuid,11,'submitted'),
  ('00000000-0000-4000-8000-000000089212'::uuid,12,'submitted'),
  ('00000000-0000-4000-8000-000000089213'::uuid,13,'submitted')
) as s(id, n, status);

insert into atlas_private.inventory_count_lines (session_id,inventory_item_id,item_name,inventory_unit,line_status,observed_quantity,counted_at,source_kind)
select ('00000000-0000-4000-8000-0000000892'||l.session)::uuid, ('00000000-0000-4000-8000-0000000889'||l.item)::uuid,
       'S88 EV '||l.item, l.unit, 'counted', l.qty, now() - l.ago, l.kind
from (values
  -- eligible: 20 -> 14 -> (+6 restock) -> 10 over 20 days = 16 / 20 = 0.8 per day
  ('01','31','bottles',20::numeric,interval '30 days','production_observation'),
  ('02','31','bottles',14,interval '20 days','production_observation'),
  ('03','31','bottles',10,interval '10 days','production_observation'),
  ('01','32','bottles',9,interval '30 days','production_observation'),
  ('02','32','bottles',5,interval '10 days','production_observation'),
  -- negative: stock rises with no recorded delivery
  ('01','33','bottles',10,interval '30 days','production_observation'),
  ('02','33','bottles',15,interval '20 days','production_observation'),
  ('03','33','bottles',5,interval '10 days','production_observation'),
  ('01','34','bottles',10,interval '30 days','production_observation'),
  ('02','34','cases',1,interval '20 days','production_observation'),
  ('03','34','bottles',5,interval '10 days','production_observation'),
  -- exactly 14 days
  ('01','35','bottles',14,interval '15 days','production_observation'),
  ('02','35','bottles',7,interval '8 days','production_observation'),
  ('03','35','bottles',0,interval '1 day','production_observation'),
  -- 13.9 days
  ('01','36','bottles',14,interval '14 days','production_observation'),
  ('02','36','bottles',7,interval '7 days','production_observation'),
  ('03','36','bottles',0,interval '0.1 day','production_observation'),
  ('11','37','bottles',20,interval '30 days','production_observation'),
  ('12','37','bottles',10,interval '20 days','production_observation'),
  ('13','37','bottles',5,interval '10 days','production_observation'),
  ('01','38','bottles',20,interval '30 days','historical_snapshot'),
  ('02','38','bottles',10,interval '20 days','historical_snapshot'),
  ('03','38','bottles',5,interval '10 days','historical_snapshot'),
  -- two counts + owner confirmation (4 bottles, 1 day ago)
  ('01','39','bottles',12,interval '21 days','production_observation'),
  ('02','39','bottles',8,interval '11 days','production_observation'),
  ('01','40','bottles',5,interval '30 days','production_observation'),
  ('02','40','bottles',5,interval '20 days','production_observation'),
  ('03','40','bottles',5,interval '10 days','production_observation')
) as l(session, item, unit, qty, ago, kind);

insert into public.inventory_movements (item_id,item_name,movement_type,quantity_change,note,created_at)
values ('00000000-0000-4000-8000-000000088931','S88 EV eligible','restock',6,'S88 evidence restock',now()-interval '15 days');

set session authorization s88_dr_probe;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088511',true);

-- Data review.
insert into s88_dr_state
select 'rows', coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'ids',
  (select coalesce(jsonb_agg(r->>'entity_id'), '[]'::jsonb)
   from jsonb_array_elements(public.atlas_data_review_rows(c.code, 500, 0)->'rows') r
   where r->>'entity_id' like '00000000-0000-4000-8000-00000008%' or r->>'entity_id' like '00000000-0000-4000-8000-00000009%'))), '[]'::jsonb)
from jsonb_to_recordset(public.atlas_data_review_summary()->'issues') as c(code text, count integer);

create temporary view s88_dr_hits as
  select x->>'code' as code, id.value #>> '{}' as entity_id
  from s88_dr_state s, jsonb_array_elements(s.value) x, jsonb_array_elements(x->'ids') id
  where s.key='rows'
    -- S89 catalogue codes have their own acceptance (verify_s89_catalog_governance_preview.sql).
    and x->>'code' not in ('inventory.possible_duplicate','catalog.pending_approval','catalog.code_collision','inventory.category_unmapped');

insert into s88_dr select 'summary lists the full catalogue with counts',
  jsonb_array_length(s->'issues')=16 and (s->>'generated_at') is not null
  and (select bool_and((i->>'count')::int >= 0 and i ? 'label' and i ? 'entity_type') from jsonb_array_elements(s->'issues') i)
from (select public.atlas_data_review_summary() as s) x;

insert into s88_dr select 'each fixture appears exactly under its issue codes',
  (select coalesce(jsonb_object_agg(entity_id, codes), '{}'::jsonb) from (
     select entity_id, jsonb_agg(code order by code) as codes from s88_dr_hits
     where entity_id between '00000000-0000-4000-8000-000000088901' and '00000000-0000-4000-8000-000000088912'
        or entity_id between '00000000-0000-4000-8000-000000089001' and '00000000-0000-4000-8000-000000089199'
     group by entity_id) g)
  = jsonb_build_object(
    '00000000-0000-4000-8000-000000088902', jsonb_build_array('inventory.missing_supplier','inventory.supplier_text_unlinked'),
    '00000000-0000-4000-8000-000000088903', jsonb_build_array('inventory.missing_cost'),
    '00000000-0000-4000-8000-000000088906', jsonb_build_array('inventory.missing_reference'),
    '00000000-0000-4000-8000-000000088907', jsonb_build_array('inventory.package_missing'),
    '00000000-0000-4000-8000-000000088908', jsonb_build_array('inventory.package_unreadable'),
    '00000000-0000-4000-8000-000000088910', jsonb_build_array('inventory.missing_par'),
    '00000000-0000-4000-8000-000000088911', jsonb_build_array('inventory.flagged_needs_review'),
    '00000000-0000-4000-8000-000000089002', jsonb_build_array('recipe.missing_price'),
    '00000000-0000-4000-8000-000000089003', jsonb_build_array('recipe.no_ingredients'),
    '00000000-0000-4000-8000-000000089104', jsonb_build_array('recipe.ingredient_unlinked'),
    '00000000-0000-4000-8000-000000089105', jsonb_build_array('recipe.ingredient_inactive_item'));

insert into s88_dr select '"24 x 330ml" is unreadable, "700 ml" is not flagged',
  exists (select 1 from s88_dr_hits where code='inventory.package_unreadable' and entity_id='00000000-0000-4000-8000-000000088908')
  and not exists (select 1 from s88_dr_hits where entity_id='00000000-0000-4000-8000-000000088909');
insert into s88_dr select 'alias-only item is not missing a reference',
  not exists (select 1 from s88_dr_hits where entity_id='00000000-0000-4000-8000-000000088905');
insert into s88_dr select 'case cost counts as a cost',
  not exists (select 1 from s88_dr_hits where entity_id='00000000-0000-4000-8000-000000088904');
insert into s88_dr select 'inactive items and retired recipes are not reported',
  not exists (select 1 from s88_dr_hits where entity_id in ('00000000-0000-4000-8000-000000088912','00000000-0000-4000-8000-000000089006'));
insert into s88_dr select 'rows carry detail and fix target',
  r->'detail'->>'package_size'='24 x 330ml' and r->>'fix'='item_master' and r->>'entity_type'='inventory_item'
from jsonb_array_elements(public.atlas_data_review_rows('inventory.package_unreadable',500,0)->'rows') r
where r->>'entity_id'='00000000-0000-4000-8000-000000088908';
insert into s88_dr select 'summary count equals rows total',
  bool_and((c.count) = (public.atlas_data_review_rows(c.code, 1, 0)->>'total')::int)
from jsonb_to_recordset(public.atlas_data_review_summary()->'issues') as c(code text, count integer);
insert into s88_dr select 'rows paginate', jsonb_array_length(r->'rows')=1 and (r->>'limit')::int=1 and (r->>'offset')::int=1
from (select public.atlas_data_review_rows('inventory.missing_supplier',1,1) as r) x
where (select (public.atlas_data_review_rows('inventory.missing_supplier',1,0)->>'total')::int) >= 2;
do $probe$ begin
  perform public.atlas_data_review_rows('inventory.everything', 10, 0);
  insert into s88_dr values ('unknown issue code refused', false);
exception when raise_exception then insert into s88_dr values ('unknown issue code refused', sqlerrm='Unknown Data review issue'); end $probe$;
do $probe$ begin
  perform public.atlas_data_review_rows('inventory.missing_par', 501, 0);
  insert into s88_dr values ('row limit above 500 refused', false);
exception when raise_exception then insert into s88_dr values ('row limit above 500 refused', true); end $probe$;

-- Par evidence (read-only; never writes a par).
insert into s88_dr_state select 'evidence', public.atlas_par_level_evidence(array[
  '00000000-0000-4000-8000-000000088931','00000000-0000-4000-8000-000000088932','00000000-0000-4000-8000-000000088933',
  '00000000-0000-4000-8000-000000088934','00000000-0000-4000-8000-000000088935','00000000-0000-4000-8000-000000088936',
  '00000000-0000-4000-8000-000000088937','00000000-0000-4000-8000-000000088938','00000000-0000-4000-8000-000000088939',
  '00000000-0000-4000-8000-000000088940']::uuid[], 7);
create temporary view s88_ev as
  select i->>'item_id' as item_id, i as ev from s88_dr_state s, jsonb_array_elements(s.value->'items') i where s.key='evidence';

insert into s88_dr select 'evidence: 3 verified counts over 20 days with a restock is eligible',
  (ev->>'eligible')::boolean and (ev->>'observations')::int=3 and (ev->>'span_days')::numeric=20
  and (ev->>'avg_daily_usage')::numeric=0.8 and ev->'reason'='null'::jsonb
  and (select array_agg((x->>'usage')::numeric order by x->>'from') from jsonb_array_elements(ev->'intervals') x)=array[6,10]::numeric[]
  and (ev->'intervals'->1->>'restocked')::numeric=6
from s88_ev where item_id='00000000-0000-4000-8000-000000088931';
insert into s88_dr select 'evidence: suggestion = ceil(usage x cover days), never saved',
  (ev->'suggestion'->>'par_level')::numeric=6 and (ev->'suggestion'->>'cases')::numeric=1
  and ev->'suggestion'->>'saved'='false'
  and (select par_level is null from public.inventory_items where id='00000000-0000-4000-8000-000000088931')
from s88_ev where item_id='00000000-0000-4000-8000-000000088931';
insert into s88_dr select 'evidence: 2 counts -> insufficient_observations, no suggestion',
  not (ev->>'eligible')::boolean and ev->>'reason'='insufficient_observations' and ev->'suggestion'='null'::jsonb
  and ev->'avg_daily_usage'='null'::jsonb
from s88_ev where item_id='00000000-0000-4000-8000-000000088932';
insert into s88_dr select 'evidence: negative usage interval -> inconsistent_evidence',
  not (ev->>'eligible')::boolean and ev->>'reason'='inconsistent_evidence' and ev->'suggestion'='null'::jsonb
from s88_ev where item_id='00000000-0000-4000-8000-000000088933';
insert into s88_dr select 'evidence: count in another unit -> unit_changed',
  not (ev->>'eligible')::boolean and ev->>'reason'='unit_changed'
from s88_ev where item_id='00000000-0000-4000-8000-000000088934';
insert into s88_dr select 'evidence: exactly 14 days is eligible',
  (ev->>'eligible')::boolean and (ev->>'span_days')::numeric=14 and (ev->>'avg_daily_usage')::numeric=1
from s88_ev where item_id='00000000-0000-4000-8000-000000088935';
insert into s88_dr select 'evidence: 13.9 days -> span_too_short',
  not (ev->>'eligible')::boolean and ev->>'reason'='span_too_short' and (ev->>'span_days')::numeric=13.9
from s88_ev where item_id='00000000-0000-4000-8000-000000088936';
insert into s88_dr select 'evidence: unverified sessions are ignored',
  (ev->>'observations')::int=0 and ev->>'reason'='insufficient_observations'
from s88_ev where item_id='00000000-0000-4000-8000-000000088937';
insert into s88_dr select 'evidence: historical snapshots are ignored',
  (ev->>'observations')::int=0 and ev->>'reason'='insufficient_observations'
from s88_ev where item_id='00000000-0000-4000-8000-000000088938';
insert into s88_dr select 'evidence: trusted owner confirmation counts as an observation',
  (ev->>'eligible')::boolean and (ev->>'observations')::int=3 and ev->'evidence'->2->>'source'='owner_confirmation'
from s88_ev where item_id='00000000-0000-4000-8000-000000088939';
insert into s88_dr select 'evidence: flat stock -> no_usage',
  not (ev->>'eligible')::boolean and ev->>'reason'='no_usage'
from s88_ev where item_id='00000000-0000-4000-8000-000000088940';
insert into s88_dr select 'evidence without cover days returns no suggestion',
  (i->>'eligible')::boolean and i->'suggestion'='null'::jsonb and (i->>'avg_daily_usage')::numeric=0.8
from jsonb_array_elements(public.atlas_par_level_evidence(array['00000000-0000-4000-8000-000000088931']::uuid[])->'items') i;
do $probe$ begin
  perform public.atlas_par_level_evidence(null, 0);
  insert into s88_dr values ('cover days outside 1..365 refused', false);
exception when raise_exception then insert into s88_dr values ('cover days outside 1..365 refused', true); end $probe$;

-- Bulk par save.
insert into s88_dr_state select 'movements_before', to_jsonb((select count(*) from public.inventory_movements));
insert into s88_dr_state select 'apply1', public.atlas_apply_par_levels(
  '[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":5,"par_level":8,"suggestion":{"shown":true,"value":8,"cover_days":7,"evidence_digest":"abc","extra":"dropped"}},
    {"item_id":"00000000-0000-4000-8000-000000088922","expected_par_level":null,"par_level":3},
    {"item_id":"00000000-0000-4000-8000-000000088923","expected_par_level":10,"par_level":10}]', 's88-par-1');
insert into s88_dr select 'batch applies changed rows and reports unchanged ones',
  s.value->>'status'='applied' and jsonb_array_length(s.value->'changed')=2
  and s.value->'unchanged'=jsonb_build_array('00000000-0000-4000-8000-000000088923')
  and (select par_level from public.inventory_items where id='00000000-0000-4000-8000-000000088921')=8
  and (select par_level from public.inventory_items where id='00000000-0000-4000-8000-000000088922')=3
from s88_dr_state s where s.key='apply1';

select public.atlas_apply_par_levels(
  '[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":5,"par_level":8,"suggestion":{"shown":true,"value":8,"cover_days":7,"evidence_digest":"abc","extra":"dropped"}},
    {"item_id":"00000000-0000-4000-8000-000000088922","expected_par_level":null,"par_level":3},
    {"item_id":"00000000-0000-4000-8000-000000088923","expected_par_level":10,"par_level":10}]', 's88-par-1') ->> 'replayed' as replayed \gset
insert into s88_dr select 'same request id replays without writing', :'replayed'='true';

do $probe$ begin
  perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":8,"par_level":9}]', 's88-par-1');
  insert into s88_dr values ('reused request id with other changes refused', false);
exception when raise_exception then
  insert into s88_dr values ('reused request id with other changes refused', sqlerrm='This request ID was already used for different changes');
end $probe$;

insert into s88_dr_state select 'conflict', public.atlas_apply_par_levels(
  '[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":5,"par_level":9},
    {"item_id":"00000000-0000-4000-8000-000000088923","expected_par_level":10,"par_level":12}]', 's88-par-2');
insert into s88_dr select 'one stale row aborts the whole batch',
  s.value->>'status'='conflict' and jsonb_array_length(s.value->'conflicts')=1
  and s.value->'conflicts'->0->>'item_id'='00000000-0000-4000-8000-000000088921'
  and (s.value->'conflicts'->0->>'current_par_level')::numeric=8
  and (select par_level from public.inventory_items where id='00000000-0000-4000-8000-000000088921')=8
  and (select par_level from public.inventory_items where id='00000000-0000-4000-8000-000000088923')=10
from s88_dr_state s where s.key='conflict';

insert into s88_dr select 'stale updated_at is a conflict',
  r->>'status'='conflict' and (select par_level from public.inventory_items where id='00000000-0000-4000-8000-000000088923')=10
from (select public.atlas_apply_par_levels(
  '[{"item_id":"00000000-0000-4000-8000-000000088923","expected_par_level":10,"par_level":12,"expected_updated_at":"2001-01-01T00:00:00Z"}]', 's88-par-3') as r) x;

do $probe$ begin
  perform public.atlas_apply_par_levels(
    '[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":8,"par_level":20},
      {"item_id":"00000000-0000-4000-8000-000000088923","expected_par_level":10,"par_level":3}]', 's88-par-4');
  insert into s88_dr values ('par below critical minimum refused and batch rolled back', false);
exception when raise_exception then
  insert into s88_dr values ('par below critical minimum refused and batch rolled back',
    sqlerrm like 'Par level for S88 PAR C cannot be below its critical minimum'
    and (select par_level from public.inventory_items where id='00000000-0000-4000-8000-000000088921')=8);
end $probe$;
do $probe$ begin
  perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":8,"par_level":-1}]', 's88-par-5');
  insert into s88_dr values ('negative par refused', false);
exception when raise_exception then insert into s88_dr values ('negative par refused', true); end $probe$;
do $probe$ begin
  perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000088921","par_level":9}]', 's88-par-6');
  insert into s88_dr values ('expected_par_level is required', false);
exception when raise_exception then insert into s88_dr values ('expected_par_level is required', true); end $probe$;

insert into s88_dr select 'par save never touches quantity or movements',
  (select count(*) from public.inventory_movements) = (select (value #>> '{}')::bigint from s88_dr_state where key='movements_before')
  and (select bool_and(quantity=0) from public.inventory_items where id in ('00000000-0000-4000-8000-000000088921','00000000-0000-4000-8000-000000088922','00000000-0000-4000-8000-000000088923'));

reset role;
reset session authorization;

insert into s88_dr select 'one audit event per changed item with suggestion metadata',
  count(*)=2
  and bool_and(e.actor_id='00000000-0000-4000-8000-000000088511' and e.actor_role='manager' and e.payload->>'request_id'='s88-par-1')
  and bool_or(e.external_item_id='00000000-0000-4000-8000-000000088921' and (e.payload->>'from')::numeric=5 and (e.payload->>'to')::numeric=8
              and e.payload->'suggestion'=jsonb_build_object('shown',true,'value',8,'cover_days',7,'evidence_digest','abc'))
  and bool_or(e.external_item_id='00000000-0000-4000-8000-000000088922' and e.payload->'from'='null'::jsonb and e.payload->'suggestion'='null'::jsonb)
from atlas_private.item_master_events e where e.event_type='par_levels_updated'
  and e.external_item_id in ('00000000-0000-4000-8000-000000088921','00000000-0000-4000-8000-000000088922','00000000-0000-4000-8000-000000088923');
insert into s88_dr select 'conflicting requests are not stored', not exists (
  select 1 from atlas_private.par_level_requests where request_id in ('s88-par-2','s88-par-3','s88-par-4'));

set session authorization s88_dr_probe;
set role authenticated;

-- Role probes: bartender and deactivated manager.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088512',true);
do $probe$
declare denied integer := 0;
begin
  begin perform public.atlas_data_review_summary(); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_data_review_rows('inventory.missing_par',10,0); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_par_level_evidence(null,null); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":8,"par_level":1}]','s88-par-b'); exception when insufficient_privilege then denied := denied + 1; end;
  insert into s88_dr values ('bartender: all four RPCs denied', denied = 4);
end $probe$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088513',true);
do $probe$
declare denied integer := 0;
begin
  begin perform public.atlas_data_review_summary(); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_data_review_rows('inventory.missing_par',10,0); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_par_level_evidence(null,null); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":8,"par_level":1}]','s88-par-d'); exception when insufficient_privilege then denied := denied + 1; end;
  insert into s88_dr values ('deactivated manager: all four RPCs denied', denied = 4);
end $probe$;
select set_config('request.jwt.claim.sub','',true);
do $probe$
declare denied integer := 0;
begin
  begin perform public.atlas_data_review_summary(); exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-000000088921","expected_par_level":8,"par_level":1}]','s88-par-n'); exception when insufficient_privilege then denied := denied + 1; end;
  insert into s88_dr values ('no JWT subject: denied', denied = 2);
end $probe$;

reset role;
reset session authorization;

insert into s88_dr values ('anon: no execute on Data review or par RPCs',
  not has_function_privilege('anon','public.atlas_data_review_summary()','execute')
  and not has_function_privilege('anon','public.atlas_data_review_rows(text,integer,integer)','execute')
  and not has_function_privilege('anon','public.atlas_par_level_evidence(uuid[],numeric)','execute')
  and not has_function_privilege('anon','public.atlas_apply_par_levels(jsonb,text)','execute')
  and not has_function_privilege('anon','private.apply_par_levels(jsonb,text)','execute')
  and not has_function_privilege('authenticated','private.data_review_issue_rows()','execute')
  and not has_table_privilege('authenticated','atlas_private.par_level_requests','select'));
insert into s88_dr values ('item master audit type list keeps existing types',
  (select pg_get_constraintdef(oid) from pg_constraint where conname='item_master_events_event_type_check')
    ~ 'publication_started' and
  (select pg_get_constraintdef(oid) from pg_constraint where conname='item_master_events_event_type_check')
    ~ 'par_levels_updated');

select jsonb_build_object(
  's88_data_review', case when bool_and(passed) and count(*)=40 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s88_dr;

rollback;
