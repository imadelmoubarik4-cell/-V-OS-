-- S39 production snapshot. SELECT-only; keep output outside public Git.
with inventory_items_snapshot as (
  select jsonb_build_object(
    'count', count(*),
    'active_count', count(*) filter (where active),
    'zero_quantity_count', count(*) filter (where quantity = 0),
    'negative_quantity_count', count(*) filter (where quantity < 0),
    'fingerprint', md5(coalesce(string_agg(
      jsonb_build_array(
        id, name, category, quantity, unit, par_level, updated_by, updated_at,
        supplier_id, supplier, cost_price, discount_percent, sku, barcode,
        bin_location, units_per_case, case_cost, size_ml, active, image_url,
        sell_price, source_key, source_file, source_updated_at, imported_at,
        package_size, source_page, import_note
      )::text,
      '|' order by id
    ), ''))
  ) value
  from public.inventory_items
), inventory_movements_snapshot as (
  select jsonb_build_object(
    'count', count(*),
    'fingerprint', md5(coalesce(string_agg(
      jsonb_build_array(
        id, item_id, item_name, movement_type, quantity_change, unit_cost,
        total_cost, supplier_id, note, created_by, created_at
      )::text,
      '|' order by id
    ), ''))
  ) value
  from public.inventory_movements
), suppliers_snapshot as (
  select jsonb_build_object(
    'count', count(*),
    'fingerprint', md5(coalesce(string_agg(
      jsonb_build_array(
        id, name, contact_name, email, phone, notes, active, created_at, updated_at
      )::text,
      '|' order by id
    ), ''))
  ) value
  from public.suppliers
), recipes_snapshot as (
  select jsonb_build_object(
    'count', count(*),
    'fingerprint', md5(coalesce(string_agg(
      jsonb_build_array(
        id, name, type, yield_quantity, yield_unit, menu_price, show_on_menu,
        updated_by, created_at, updated_at, glassware, garnish, method, notes,
        image_url, active, category_id, happy_hour_price, glass_price,
        bottle_price, source_key, source_file, imported_at
      )::text,
      '|' order by id
    ), ''))
  ) value
  from public.recipes
), profiles_snapshot as (
  select jsonb_build_object(
    'count', count(*),
    'fingerprint', md5(coalesce(string_agg(
      jsonb_build_array(id, email, display_name, role, active, created_at, updated_at)::text,
      '|' order by id
    ), ''))
  ) value
  from public.profiles
), public_rls as (
  select coalesce(
    jsonb_agg(c.relname order by c.relname) filter (where not c.relrowsecurity),
    '[]'::jsonb
  ) missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
), migrations as (
  select coalesce(jsonb_agg(version order by version), '[]'::jsonb) versions
  from supabase_migrations.schema_migrations
), required_tables as (
  select jsonb_object_agg(name, to_regclass(name) is not null) value
  from (values
    ('public.purchase_orders'),
    ('atlas_private.team_conversation_stars'),
    ('atlas_private.push_subscriptions'),
    ('atlas_private.push_notification_queue'),
    ('atlas_private.report_events')
  ) required(name)
), report_events as (
  select jsonb_build_object(
    'exists', to_regclass('atlas_private.report_events') is not null,
    'rls_enabled', coalesce((
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'atlas_private' and c.relname = 'report_events'
    ), false)
  ) value
), rls_auto_enable as (
  select jsonb_build_object(
    'exists', count(*) > 0,
    'security_definer', coalesce(bool_or(p.prosecdef), false),
    'anon_execute', coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')), false),
    'authenticated_execute', coalesce(bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')), false)
  ) value
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rls_auto_enable'
)
select jsonb_build_object(
  'snapshot_version', 1,
  'protected', jsonb_build_object(
    'inventory_items', inventory_items_snapshot.value,
    'inventory_movements', inventory_movements_snapshot.value,
    'suppliers', suppliers_snapshot.value,
    'recipes', recipes_snapshot.value,
    'profiles', profiles_snapshot.value,
    'auth_user_count', (select count(*) from auth.users)
  ),
  'migration_versions', migrations.versions,
  'required_tables', required_tables.value,
  'public_tables_without_rls', public_rls.missing,
  'report_events', report_events.value,
  'rls_auto_enable', rls_auto_enable.value
) as s39_snapshot
from inventory_items_snapshot, inventory_movements_snapshot, suppliers_snapshot,
  recipes_snapshot, profiles_snapshot, public_rls, migrations, required_tables,
  report_events, rls_auto_enable;
