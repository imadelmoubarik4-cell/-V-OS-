-- Read-only Phase 1 security verification. Safe to run before and after
-- production migration. Any non-empty exception or security_lint_blockers list
-- is a release blocker.

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
), menu_projection as (
  select c.oid, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public_menu_private'
    and c.relname = 'items'
    and c.relkind in ('r', 'p')
), menu_status as (
  select
    v.oid as view_oid,
    'security_invoker=true' = any(v.reloptions) as security_invoker,
    has_table_privilege('anon', v.oid, 'select') as anon_view_select,
    (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
     where table_schema='public' and table_name='public_menu') as columns,
    projection.oid as projection_oid,
    coalesce(projection.relrowsecurity, false) as projection_rls,
    coalesce(has_table_privilege('anon', projection.oid, 'select'), false) as anon_projection_table_select,
    coalesce(has_column_privilege('anon', projection.oid, 'id', 'select'), false) as anon_projection_id_select,
    coalesce(has_column_privilege('anon', projection.oid, 'name', 'select'), false) as anon_projection_name_select,
    coalesce(has_column_privilege('anon', projection.oid, 'type', 'select'), false) as anon_projection_type_select,
    coalesce(has_column_privilege('anon', projection.oid, 'menu_price', 'select'), false) as anon_projection_price_select,
    coalesce(has_column_privilege('anon', projection.oid, 'updated_at', 'select'), false) as anon_projection_updated_at_select
  from public_views v
  left join menu_projection projection on true
  where v.relname='public_menu'
), menu_final as (
  select *,
    security_invoker
    and anon_view_select
    and columns = array['id','name','type','menu_price']::text[]
    and projection_oid is not null
    and projection_rls
    and not anon_projection_table_select
    and anon_projection_id_select
    and anon_projection_name_select
    and anon_projection_type_select
    and anon_projection_price_select
    and not anon_projection_updated_at_select
    as public_menu_safe
  from menu_status
), adjustment_status as (
  select
    p.oid,
    p.prosecdef as security_definer,
    has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
    has_function_privilege('anon', p.oid, 'execute') as anon_execute,
    exists (
      select 1 from pg_policies policy
      where policy.schemaname='public'
        and policy.tablename='inventory_movements'
        and policy.policyname='active managers add inventory movements'
        and policy.cmd='INSERT'
    ) as manager_movement_insert_policy
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='adjust_inventory'
    and pg_get_function_identity_arguments(p.oid) =
      'p_item_id uuid, p_quantity_change numeric, p_movement_type text, p_unit_cost numeric, p_supplier_id uuid, p_note text'
), adjustment_final as (
  select *,
    not security_definer
    and authenticated_execute
    and not anon_execute
    and manager_movement_insert_policy
    as adjust_inventory_safe
  from adjustment_status
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
  'public_menu', coalesce((
    select to_jsonb(menu_final) - 'view_oid' - 'projection_oid'
    from menu_final
  ), jsonb_build_object('public_menu_safe',false)),
  'controlled_adjustment', coalesce((
    select to_jsonb(adjustment_final) - 'oid'
    from adjustment_final
  ), jsonb_build_object('adjust_inventory_safe',false)),
  'security_lint_blockers', to_jsonb(array_remove(array[
    case when not coalesce((select public_menu_safe from menu_final),false)
      then 'public_menu is not a safe security-invoker four-column projection' end,
    case when not coalesce((select adjust_inventory_safe from adjustment_final),false)
      then 'adjust_inventory is not a caller-evaluated manager-only RPC' end
  ]::text[], null)),
  'browser_function_exposure', coalesce((
    select jsonb_agg(jsonb_build_object('function', proname, 'args', args) order by proname, args)
    from browser_functions
  ), '[]'::jsonb),
  'redacted_views', jsonb_build_object(
    'inventory_catalog', to_regclass('public.inventory_catalog') is not null,
    'inventory_movement_catalog', to_regclass('public.inventory_movement_catalog') is not null,
    'recipe_catalog', to_regclass('public.recipe_catalog') is not null
  ),
  'atlas_stock_count_views', jsonb_build_object(
    'source_available', to_regclass('atlas_private.inventory_verified_balances') is not null,
    'staff_view', to_regclass('public.stock_count_summary') is not null,
    'manager_view', to_regclass('public.stock_count_manager_summary') is not null,
    'expected_in_this_database', to_regclass('atlas_private.inventory_verified_balances') is not null
  ),
  'fingerprint', (select to_jsonb(fingerprint) from fingerprint)
) as phase1_security_gate;
