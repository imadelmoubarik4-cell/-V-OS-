-- S86.1 preview-only Reports package parser acceptance.
--
-- Runs against an isolated replay database. Exercises the guarded package
-- parser, numeric scrubbing, the private and public Reports snapshot functions
-- with every legacy package format seen in production, and the privilege
-- boundaries of the new helpers. Writes nothing; everything is rolled back.

begin;

create temporary table s861_acceptance (
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;

-- 1-10: parser cases. Legacy free text must return null; plain measures parse.
with cases(input, want_quantity, want_unit) as (
  values
    ('1 kg / 1 unit', null::numeric, null::text),
    ('250gr', 250, 'g'),
    ('15 kg case / sold by kg', null, null),
    ('6 x 1 kg (1 kg per bag)', null, null),
    ('4.5 kg box', null, null),
    ('16 kg case', null, null),
    ('25 x 2g tea bags', null, null),
    ('40 x 80 g (3.2 kg)', null, null),
    ('24 x 330ml', null, null),
    ('1 bottle / 1,000 ml', null, null),
    ('1,000 ml', null, null),
    ('2L prep batch', null, null),
    ('1L costing unit', null, null),
    ('25 L keg', null, null),
    ('Pack', null, null),
    ('', null, null),
    ('not a size at all', null, null),
    ('1 / 1 unit', null, null),
    ('0 ml', null, null),
    ('750 ml', 750, 'ml'),
    ('750ml', 750, 'ml'),
    ('1.5 kg', 1500, 'g'),
    ('1,5 kg', 1500, 'g'),
    ('0,750 l', 750, 'ml'),
    ('1.5L', 1500, 'ml'),
    ('1 lt', 1000, 'ml'),
    ('2 liters', 2000, 'ml'),
    ('50 g', 50, 'g'),
    ('1 KG', 1000, 'g')
), results as (
  select cases.*, parsed.measure_quantity, parsed.measure_unit
  from cases cross join lateral atlas_private.reports_parse_pack_measure(cases.input) as parsed
)
insert into s861_acceptance
select 'parser_' || pg_catalog.md5(input),
  measure_quantity is not distinct from want_quantity and measure_unit is not distinct from want_unit,
  pg_catalog.format('%L -> %s %s (want %s %s)', input, coalesce(measure_quantity::text, 'null'), coalesce(measure_unit, ''),
    coalesce(want_quantity::text, 'null'), coalesce(want_unit, ''))
from results;

-- Numeric scrubbing keeps numbers and plain decimals, nulls everything else.
insert into s861_acceptance
select 'safe_numeric_scrubbing',
  atlas_private.reports_scrub_numeric_fields(
    '[{"quantity":"1 / 1 unit","par_level":"2","cost_price":12.5,"size_ml":"750ml","sell_price":null,"name":"x"}]'::jsonb,
    array['quantity','par_level','cost_price','size_ml','sell_price']
  ) = '[{"quantity":null,"par_level":2,"cost_price":12.5,"size_ml":null,"sell_price":null,"name":"x"}]'::jsonb,
  'Text is nulled; numbers and plain decimal strings are kept.';

-- 11-12: full snapshot with production-shaped legacy rows (no size_ml, so the
-- package parser is reached), through the private function directly and
-- through the public wrapper.
create temporary table s861_inventory on commit drop as
select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'id', pg_catalog.format('00000000-0000-4000-8000-%s', pg_catalog.lpad(ordinality::text, 12, '0')),
  'name', 'Legacy item ' || ordinality, 'category', 'Test', 'quantity', 3, 'unit', unit,
  'par_level', 1, 'cost_price', 1000, 'active', true, 'package_size', package_size,
  'updated_at', '2026-09-24T10:00:00Z'
)) as payload
from unnest(
  array['1 kg / 1 unit','250gr','15 kg case / sold by kg','6 x 1 kg (1 kg per bag)','4.5 kg box','16 kg case',
        '25 x 2g tea bags','40 x 80 g (3.2 kg)','6 x 1 kg (1 kg bag)','1,000 ml','Pack','750 ml','1.5 kg'],
  array['units','packs','kg','kg','boxes','pieces','boxes','units','kg','bottles','units','bottles','units']
) with ordinality as legacy(package_size, unit, ordinality);

create temporary table s861_results on commit drop as
select
  atlas_private.reports_snapshot_v2(
    (select payload from s861_inventory), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '00000000-0000-4000-8000-000000000001'::uuid, 'admin', current_date - 30, current_date, null, null, 'none', '{}'::jsonb
  ) as private_result,
  public.atlas_reports_snapshot_v2(
    (select payload from s861_inventory)
      || '[{"id":"00000000-0000-4000-8000-000000009999","name":"Malformed numbers","quantity":"1 / 1 unit","par_level":"two","cost_price":"n/a","size_ml":"750ml","active":true,"package_size":"1 kg / 1 unit"}]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[{"id":"00000000-0000-4000-8000-000000008888","quantity_change":"lots","unit_cost":"?","total_cost":"1 / 1 unit","movement_type":"restock","created_at":"2026-09-24T10:00:00Z"}]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '00000000-0000-4000-8000-000000000001'::uuid, 'admin', current_date - 30, current_date, null, null, 'none', '{}'::jsonb
  ) as public_result;

insert into s861_acceptance
select 'private_snapshot_survives_legacy_package_text',
  pg_catalog.jsonb_array_length(private_result -> 'sections') = 12 and pg_catalog.jsonb_array_length(private_result -> 'kpis') = 7,
  pg_catalog.format('sections=%s kpis=%s', pg_catalog.jsonb_array_length(private_result -> 'sections'), pg_catalog.jsonb_array_length(private_result -> 'kpis'))
from s861_results;

insert into s861_acceptance
select 'public_snapshot_survives_malformed_numbers',
  pg_catalog.jsonb_array_length(public_result -> 'sections') = 12 and pg_catalog.jsonb_array_length(public_result -> 'kpis') = 7
    and (public_result -> 'reports' -> 'inventory' -> 'summary' ->> 'active_items')::integer = 14,
  pg_catalog.format('sections=%s kpis=%s inventory=%s', pg_catalog.jsonb_array_length(public_result -> 'sections'),
    pg_catalog.jsonb_array_length(public_result -> 'kpis'), public_result -> 'reports' -> 'inventory' -> 'summary' ->> 'active_items')
from s861_results;

-- Security: helpers are private, invoker-rights, pinned search_path, not browser-callable.
insert into s861_acceptance
select 'helpers_not_callable_by_browser_roles',
  bool_and(not pg_catalog.has_function_privilege('anon', helper, 'execute')
    and not pg_catalog.has_function_privilege('authenticated', helper, 'execute')
    and pg_catalog.has_function_privilege('service_role', helper, 'execute')),
  'anon/authenticated have no EXECUTE; service_role (the Reports caller) does.'
from pg_catalog.unnest(array[
  'atlas_private.reports_parse_pack_measure(text)',
  'atlas_private.reports_safe_numeric(jsonb)',
  'atlas_private.reports_scrub_numeric_fields(jsonb,text[])'
]) as helper;

insert into s861_acceptance
select 'reports_functions_invoker_with_empty_search_path',
  bool_and(not proc.prosecdef and proc.proconfig @> array['search_path=""']),
  pg_catalog.string_agg(proc.oid::regprocedure::text || ' secdef=' || proc.prosecdef, '; ')
from pg_catalog.pg_proc proc
join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
where (ns.nspname = 'atlas_private' and proc.proname in ('reports_snapshot_v2','reports_parse_pack_measure','reports_safe_numeric','reports_scrub_numeric_fields'))
   or (ns.nspname = 'public' and proc.proname = 'atlas_reports_snapshot_v2');

insert into s861_acceptance
select 'public_wrapper_grants_unchanged',
  not pg_catalog.has_function_privilege('anon', 'public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute')
  and pg_catalog.has_function_privilege('service_role', 'public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)', 'execute'),
  'The Reports RPC stays service_role only.';

insert into s861_acceptance
select 'no_text_regexp_numeric_cast_remains',
  pg_catalog.strpos(proc.prosrc, 'regexp_replace') = 0
    and (select count(*) from pg_catalog.regexp_matches(proc.prosrc, '::numeric', 'g')) = 7,
  'reports_snapshot_v2 keeps only integer/count numeric casts.'
from pg_catalog.pg_proc proc
join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
where ns.nspname = 'atlas_private' and proc.proname = 'reports_snapshot_v2';

do $verdict$
begin
  if exists (select 1 from s861_acceptance where not passed) then
    raise exception 'S86.1 package parser acceptance failed: %',
      (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)) from s861_acceptance row_data where not passed);
  end if;
end
$verdict$;

select pg_catalog.jsonb_build_object(
  'rolled_back', true,
  's86_1_reports_package_parser', 'passed',
  'checks', (select count(*) from s861_acceptance)
);

rollback;
