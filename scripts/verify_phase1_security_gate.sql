-- Read-only Phase 1 security verification. Safe to run before and after
-- production migration. Any non-empty exception list is a release blocker.

with public_tables as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
), public_views as (
  select c.oid, c.relname, coalesce(c.reloptions, array[]::text[]) as reloptions
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
), browser_functions as (
  select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute')
    )
    and p.proname <> 'adjust_inventory'
), fingerprint as (
  select
    count(*) as inventory_records,
    count(*) filter (where active) as active_inventory_records,
    coalesce(sum(quantity), 0) as total_quantity,
    (select count(*) from public.inventory_movements) as inventory_movements
  from public.inventory_items
)
select jsonb_build_object(
  'checked_at', now(),
  'canonical_registry', jsonb_build_object(
    'profiles_exists', to_regclass('public.profiles') is not null,
    'staff_exists', to_regclass('public.staff') is not null,
    'active_admins', (select count(*) from public.profiles where active and role::text = 'admin')
  ),
  'tables_without_rls', coalesce((
    select jsonb_agg(relname order by relname)
    from public_tables
    where not relrowsecurity
  ), '[]'::jsonb),
  'unsafe_non_public_views', coalesce((
    select jsonb_agg(jsonb_build_object(
      'view', relname,
      'security_invoker', 'security_invoker=true' = any(reloptions),
      'anon_select', has_table_privilege('anon', oid, 'select')
    ) order by relname)
    from public_views
    where relname <> 'public_menu'
      and (
        not ('security_invoker=true' = any(reloptions))
        or has_table_privilege('anon', oid, 'select')
      )
  ), '[]'::jsonb),
  'public_menu', (
    select jsonb_build_object(
      'columns', (select jsonb_agg(column_name order by ordinal_position)
                  from information_schema.columns
                  where table_schema = 'public' and table_name = 'public_menu'),
      'anon_select', has_table_privilege('anon', oid, 'select'),
      'security_invoker', 'security_invoker=true' = any(reloptions)
    )
    from public_views where relname = 'public_menu'
  ),
  'browser_function_exposure', coalesce((
    select jsonb_agg(jsonb_build_object('function', proname, 'args', args) order by proname, args)
    from browser_functions
  ), '[]'::jsonb),
  'redacted_views', jsonb_build_object(
    'inventory_catalog', to_regclass('public.inventory_catalog') is not null,
    'inventory_movement_catalog', to_regclass('public.inventory_movement_catalog') is not null,
    'recipe_catalog', to_regclass('public.recipe_catalog') is not null,
    'stock_count_summary', to_regclass('public.stock_count_summary') is not null,
    'stock_count_manager_summary', to_regclass('public.stock_count_manager_summary') is not null
  ),
  'fingerprint', (select to_jsonb(fingerprint) from fingerprint)
) as phase1_security_gate;
