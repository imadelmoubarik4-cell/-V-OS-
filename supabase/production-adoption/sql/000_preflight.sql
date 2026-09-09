\set ON_ERROR_STOP on

-- Read-only production-shape checks. The temporary table exists only so the
-- same psql session can prove that the candidate did not change canonical data.
do $production_adoption_preflight$
declare
  actual_versions text[];
  expected_versions constant text[] := array[
    '20260801105516',
    '20260801125810',
    '20260801165947',
    '20260801180202',
    '20260801222046',
    '20260801224004'
  ];
  required_relation text;
begin
  select array_agg(version order by version)
    into actual_versions
  from supabase_migrations.schema_migrations;

  if actual_versions is distinct from expected_versions then
    raise exception 'Production-adoption baseline mismatch. Expected %, found %',
      expected_versions, actual_versions;
  end if;

  foreach required_relation in array array[
    'public.profiles',
    'public.suppliers',
    'public.inventory_items',
    'public.inventory_movements',
    'public.recipe_categories',
    'public.recipes',
    'public.recipe_ingredients',
    'public.import_batches',
    'public.import_review_items'
  ] loop
    if to_regclass(required_relation) is null then
      raise exception 'Required production relation is missing: %', required_relation;
    end if;
  end loop;

  if to_regclass('public.staff') is not null then
    raise exception 'public.staff must not coexist with the canonical public.profiles registry';
  end if;

  if to_regnamespace('atlas_private') is not null then
    raise exception 'Phase 1 adoption expects atlas_private to be absent';
  end if;

  if to_regprocedure('public.rls_auto_enable()') is null then
    raise exception 'Expected public.rls_auto_enable() is missing';
  end if;

  if not exists (
    select 1
    from pg_proc as function_row
    where function_row.oid = 'public.rls_auto_enable()'::regprocedure
      and function_row.prosecdef is true
  ) then
    raise exception 'public.rls_auto_enable() no longer matches the reviewed SECURITY DEFINER shape';
  end if;

  if not exists (
    select 1
    from pg_event_trigger as trigger_row
    where trigger_row.evtname = 'ensure_rls'
      and trigger_row.evtfoid = 'public.rls_auto_enable()'::regprocedure
      and trigger_row.evtenabled <> 'D'
  ) then
    raise exception 'The enabled ensure_rls event trigger is missing or points elsewhere';
  end if;
end
$production_adoption_preflight$;

create temp table atlas_adoption_before on commit preserve rows as
select
  (select count(*) from auth.users) as auth_users,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.suppliers) as suppliers,
  (select count(*) from public.inventory_items) as inventory_items,
  (select coalesce(sum(quantity), 0) from public.inventory_items) as inventory_quantity,
  (select count(*) from public.inventory_movements) as inventory_movements,
  (select count(*) from public.recipe_categories) as recipe_categories,
  (select count(*) from public.recipes) as recipes,
  (select count(*) from public.recipe_ingredients) as recipe_ingredients,
  (select count(*) from public.import_batches) as import_batches,
  (select count(*) from public.import_review_items) as import_review_items;

select jsonb_build_object(
  'phase', 'preflight',
  'migration_versions', (
    select jsonb_agg(version order by version)
    from supabase_migrations.schema_migrations
  ),
  'fingerprint', to_jsonb(snapshot)
)
from atlas_adoption_before as snapshot;
