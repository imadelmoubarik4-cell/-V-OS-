\set ON_ERROR_STOP on

do $production_adoption_verify$
declare
  before_row atlas_adoption_before%rowtype;
  after_row atlas_adoption_before%rowtype;
  relation_without_rls text;
begin
  select * into before_row from atlas_adoption_before;

  select
    (select count(*) from auth.users),
    (select count(*) from public.profiles),
    (select count(*) from public.suppliers),
    (select count(*) from public.inventory_items),
    (select coalesce(sum(quantity), 0) from public.inventory_items),
    (select count(*) from public.inventory_movements),
    (select count(*) from public.recipe_categories),
    (select count(*) from public.recipes),
    (select count(*) from public.recipe_ingredients),
    (select count(*) from public.import_batches),
    (select count(*) from public.import_review_items)
  into after_row;

  if to_jsonb(after_row) is distinct from to_jsonb(before_row) then
    raise exception 'Protected production fingerprint changed. Before %, after %',
      to_jsonb(before_row), to_jsonb(after_row);
  end if;

  if has_function_privilege('anon', 'public.rls_auto_enable()', 'execute')
     or has_function_privilege('authenticated', 'public.rls_auto_enable()', 'execute') then
    raise exception 'Browser roles can still execute public.rls_auto_enable()';
  end if;

  if not exists (
    select 1
    from pg_event_trigger
    where evtname = 'ensure_rls'
      and evtfoid = 'public.rls_auto_enable()'::regprocedure
      and evtenabled <> 'D'
  ) then
    raise exception 'ensure_rls was disabled or detached by the candidate';
  end if;

  select format('%I.%I', namespace_row.nspname, class_row.relname)
    into relation_without_rls
  from pg_class as class_row
  join pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = 'public'
    and class_row.relkind in ('r', 'p')
    and class_row.relrowsecurity is false
  order by 1
  limit 1;

  if relation_without_rls is not null then
    raise exception 'Public relation lacks RLS after adoption: %', relation_without_rls;
  end if;

  if to_regnamespace('atlas_private') is not null then
    raise exception 'Phase 1 candidate unexpectedly created atlas_private';
  end if;
end
$production_adoption_verify$;

select jsonb_build_object(
  'phase', 'verified',
  'protected_fingerprint_unchanged', true,
  'rls_auto_enable_browser_execute', false,
  'ensure_rls_enabled', true,
  'public_tables_without_rls', '[]'::jsonb,
  'atlas_private_created', false
);
