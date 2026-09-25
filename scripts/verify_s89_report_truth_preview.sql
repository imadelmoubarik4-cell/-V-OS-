-- S89 preview-only canonical report truth acceptance.
--
-- Runs against an isolated replay database. Checks that the Reports snapshot
-- counts purchasing spend as costed purchase receipts only (the rule shared
-- with atlas-domain purchaseSpend and AtlasStockTruth.purchaseSpend), keeps
-- waste separate, uses the venue clock time zone, and keeps the function's
-- security shape. Writes nothing; everything is rolled back.

begin;

create temporary table s89t_acceptance (
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;

-- Movements: the reviewer's fixture (restock 10 000, purchase 1 x 5 000 with
-- no total, costed waste 2 000) plus a positive adjustment with a cost, an
-- uncosted restock, a negative restock (a correction) and a comparison-period
-- restock. Canonical spend = 15 000 from 2 costed receipts, 1 uncosted.
create temporary table s89t_movements on commit drop as
select pg_catalog.jsonb_build_array(
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000901','item_id','00000000-0000-4000-8000-000000000001','item_name','Gin','movement_type','restock','quantity_change',2,'unit_cost',5000,'total_cost',10000,'supplier_id','00000000-0000-4000-8000-000000000501','created_at',pg_catalog.now() - interval '2 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000902','item_id','00000000-0000-4000-8000-000000000002','item_name','Vodka','movement_type','purchase','quantity_change',1,'unit_cost',5000,'total_cost',null,'supplier_id','00000000-0000-4000-8000-000000000501','created_at',pg_catalog.now() - interval '2 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000903','item_id','00000000-0000-4000-8000-000000000004','item_name','Lime','movement_type','waste','quantity_change',-40,'unit_cost',50,'total_cost',2000,'supplier_id','00000000-0000-4000-8000-000000000501','created_at',pg_catalog.now() - interval '2 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000904','item_id','00000000-0000-4000-8000-000000000004','item_name','Lime','movement_type','adjustment','quantity_change',5,'unit_cost',600,'total_cost',3000,'supplier_id',null,'created_at',pg_catalog.now() - interval '2 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000905','item_id','00000000-0000-4000-8000-000000000006','item_name','Tonic','movement_type','restock','quantity_change',12,'unit_cost',null,'total_cost',null,'supplier_id',null,'created_at',pg_catalog.now() - interval '2 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000906','item_id','00000000-0000-4000-8000-000000000001','item_name','Gin','movement_type','restock','quantity_change',-1,'unit_cost',5000,'total_cost',5000,'supplier_id','00000000-0000-4000-8000-000000000501','created_at',pg_catalog.now() - interval '2 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000907','item_id','00000000-0000-4000-8000-000000000001','item_name','Gin','movement_type','restock','quantity_change',1,'unit_cost',4000,'total_cost',4000,'supplier_id','00000000-0000-4000-8000-000000000501','created_at',pg_catalog.now() - interval '40 days'),
  pg_catalog.jsonb_build_object('id','00000000-0000-4000-8000-000000000908','item_id','00000000-0000-4000-8000-000000000004','item_name','Lime','movement_type','waste','quantity_change',-10,'unit_cost',50,'total_cost',500,'supplier_id',null,'created_at',pg_catalog.now() - interval '40 days')
) as payload;

create temporary table s89t_results on commit drop as
select public.atlas_reports_snapshot_v2(
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
  '[{"id":"00000000-0000-4000-8000-000000000501","name":"Vín","active":true}]'::jsonb,
  (select payload from s89t_movements),
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
  '00000000-0000-4000-8000-000000000001'::uuid, 'admin',
  atlas_private.venue_business_date() - 29, atlas_private.venue_business_date(),
  atlas_private.venue_business_date() - 59, atlas_private.venue_business_date() - 30,
  'previous_period', '{}'::jsonb
) as result;

insert into s89t_acceptance
select 'spend_is_costed_purchase_receipts',
  (result -> 'reports' -> 'purchasing' -> 'summary' ->> 'spend')::numeric = 15000,
  pg_catalog.format('spend=%s (want 15000: restock 10000 + purchase 1 x 5000; waste, adjustment and a negative restock excluded)',
    result -> 'reports' -> 'purchasing' -> 'summary' ->> 'spend')
from s89t_results;

insert into s89t_acceptance
select 'spend_counts_costed_and_uncosted_receipts',
  (result -> 'reports' -> 'purchasing' -> 'summary' ->> 'movement_count')::integer = 2
    and (result -> 'reports' -> 'purchasing' -> 'summary' ->> 'uncosted_receipts')::integer = 1
    and pg_catalog.jsonb_array_length(result -> 'reports' -> 'purchasing' -> 'rows') = 3,
  pg_catalog.format('costed=%s uncosted=%s rows=%s',
    result -> 'reports' -> 'purchasing' -> 'summary' ->> 'movement_count',
    result -> 'reports' -> 'purchasing' -> 'summary' ->> 'uncosted_receipts',
    pg_catalog.jsonb_array_length(result -> 'reports' -> 'purchasing' -> 'rows'))
from s89t_results;

insert into s89t_acceptance
select 'comparison_spend_uses_the_same_rule',
  (result -> 'reports' -> 'purchasing' -> 'comparison' ->> 'spend')::numeric = 4000,
  pg_catalog.format('comparison spend=%s (want 4000; comparison waste excluded)', result -> 'reports' -> 'purchasing' -> 'comparison' ->> 'spend')
from s89t_results;

insert into s89t_acceptance
select 'purchasing_kpi_matches_the_report',
  (select (kpi ->> 'value')::numeric from pg_catalog.jsonb_array_elements(result -> 'kpis') kpi where kpi ->> 'key' = 'purchasing_spend') = 15000,
  'The purchasing_spend KPI is the canonical spend.'
from s89t_results;

insert into s89t_acceptance
select 'supplier_spend_excludes_waste',
  coalesce((select (row_data ->> 'spend')::numeric from pg_catalog.jsonb_array_elements(result -> 'reports' -> 'suppliers' -> 'rows') row_data where row_data ->> 'supplier' = 'Vín'), -1) = 15000,
  pg_catalog.format('Vín spend=%s (want 15000)', (select row_data ->> 'spend' from pg_catalog.jsonb_array_elements(result -> 'reports' -> 'suppliers' -> 'rows') row_data where row_data ->> 'supplier' = 'Vín'))
from s89t_results;

insert into s89t_acceptance
select 'waste_stays_separate',
  (result -> 'reports' -> 'waste' -> 'summary' ->> 'recorded_waste_count')::integer = 1,
  pg_catalog.format('waste entries=%s', result -> 'reports' -> 'waste' -> 'summary' ->> 'recorded_waste_count')
from s89t_results;

insert into s89t_acceptance
select 'reporting_zone_is_the_venue_clock',
  result ->> 'timezone' = atlas_private.venue_timezone()
    and result -> 'trust' ->> 'venue_reporting_timezone' = atlas_private.venue_timezone(),
  pg_catalog.format('timezone=%s venue=%s', result ->> 'timezone', atlas_private.venue_timezone())
from s89t_results;

insert into s89t_acceptance
select 'snapshot_security_shape_unchanged',
  bool_and(not proc.prosecdef and proc.proconfig @> array['search_path=""']),
  pg_catalog.string_agg(proc.oid::regprocedure::text || ' secdef=' || proc.prosecdef, '; ')
from pg_catalog.pg_proc proc
join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
where (ns.nspname = 'atlas_private' and proc.proname = 'reports_snapshot_v2')
   or (ns.nspname = 'public' and proc.proname = 'atlas_reports_snapshot_v2');

insert into s89t_acceptance
select 'reports_rpc_stays_service_role_only',
  not pg_catalog.has_function_privilege('anon', 'public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute')
  and pg_catalog.has_function_privilege('service_role', 'public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'atlas_private.reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute'),
  'The Reports RPC and the private snapshot are not callable by browser roles.';

do $verdict$
begin
  if exists (select 1 from s89t_acceptance where not passed) then
    raise exception 'S89 canonical report truth acceptance failed: %',
      (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)) from s89t_acceptance row_data where not passed);
  end if;
end
$verdict$;

select pg_catalog.jsonb_build_object(
  'tests', (select count(*) from s89t_acceptance),
  'rolled_back', true,
  's89_canonical_report_truth', 'passed'
);

rollback;
