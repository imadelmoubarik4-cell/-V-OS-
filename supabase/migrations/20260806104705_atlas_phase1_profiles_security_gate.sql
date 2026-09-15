-- Phase 1 production security gate: canonical profiles, least-privilege grants,
-- active-role RLS, redacted staff catalogues and server-controlled audit fields.
--
-- This migration is intentionally independent of the isolated Atlas L1/L2 schema.
-- Stock-count evidence projections are installed by a separate guarded migration
-- only in databases that own the verified-balance source relation.

do $phase1_invariants$
begin
  if to_regclass('public.staff') is not null then
    raise exception 'Phase 1 requires public.profiles to remain the single staff registry; public.staff must not coexist';
  end if;

  if exists (select 1 from public.profiles)
     and not exists (
       select 1
       from public.profiles
       where active is true
         and role::text = 'admin'
     ) then
    raise exception 'Phase 1 requires at least one active administrator before RLS is changed';
  end if;
end
$phase1_invariants$;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Business owner maps to admin. New or invited users remain inactive viewers
-- until an administrator explicitly assigns and activates their role.
alter table public.profiles
  alter column role set default 'viewer'::public.staff_role,
  alter column active set default false;

create or replace function private.current_profile_role()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select profile.role::text
  from public.profiles as profile
  where profile.id = (select auth.uid())
    and profile.active is true
  limit 1;
$function$;

create or replace function private.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
        and profile.role::text in ('admin', 'manager', 'bartender', 'viewer')
    );
$function$;

create or replace function private.is_operational_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
        and profile.role::text in ('admin', 'manager', 'bartender')
    );
$function$;

create or replace function private.is_manager_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
        and profile.role::text in ('admin', 'manager')
    );
$function$;

create or replace function private.is_self_or_manager(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (
    private.is_active_staff()
    and (select auth.uid()) = target_user
  ) or private.is_manager_or_admin();
$function$;

revoke all on function private.current_profile_role() from public, anon;
revoke all on function private.is_active_staff() from public, anon;
revoke all on function private.is_operational_staff() from public, anon;
revoke all on function private.is_manager_or_admin() from public, anon;
revoke all on function private.is_self_or_manager(uuid) from public, anon;
grant execute on function private.current_profile_role() to authenticated, service_role;
grant execute on function private.is_active_staff() to authenticated, service_role;
grant execute on function private.is_operational_staff() to authenticated, service_role;
grant execute on function private.is_manager_or_admin() to authenticated, service_role;
grant execute on function private.is_self_or_manager(uuid) to authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (
    id,
    email,
    display_name,
    role,
    active
  )
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    'viewer'::public.staff_role,
    false
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create or replace function private.preserve_active_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  removing_active_admin boolean := false;
  other_admins integer := 0;
begin
  if tg_op = 'DELETE' then
    removing_active_admin := old.active is true and old.role::text = 'admin';
  else
    removing_active_admin :=
      old.active is true
      and old.role::text = 'admin'
      and (new.active is not true or new.role::text <> 'admin');
  end if;

  if removing_active_admin then
    select count(*)
      into other_admins
    from public.profiles as profile
    where profile.id <> old.id
      and profile.active is true
      and profile.role::text = 'admin';

    if other_admins = 0 then
      raise exception 'Atlas must retain at least one active administrator';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.preserve_active_admin() from public, anon, authenticated;
grant execute on function private.preserve_active_admin() to service_role;

drop trigger if exists profiles_preserve_active_admin on public.profiles;
create trigger profiles_preserve_active_admin
before update or delete on public.profiles
for each row execute function private.preserve_active_admin();

-- Browser-supplied audit labels are ignored for authenticated writes.
alter table public.inventory_items
  alter column updated_by set default (auth.uid()::text);

create or replace function private.inventory_item_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_role text := coalesce((select auth.role()), '');
  trusted_server boolean := caller_role = 'service_role' or session_user = 'postgres';
  quantity_path_enabled boolean :=
    coalesce(current_setting('atlas.allow_inventory_quantity_change', true), '') = 'on';
begin
  if not trusted_server and not private.is_manager_or_admin() then
    raise exception 'Inventory master writes require an active manager or administrator'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT'
     and coalesce(new.quantity, 0) <> 0
     and not trusted_server
     and not quantity_path_enabled then
    raise exception 'New inventory items must start at zero; use a controlled stock movement'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE'
     and new.quantity is distinct from old.quantity
     and not trusted_server
     and not quantity_path_enabled then
    raise exception 'Use the controlled inventory adjustment workflow to change quantity'
      using errcode = '42501';
  end if;

  if (select auth.uid()) is not null then
    new.updated_by = (select auth.uid())::text;
  end if;
  new.updated_at = now();
  return new;
end;
$function$;

revoke all on function private.inventory_item_write_guard() from public, anon, authenticated;
grant execute on function private.inventory_item_write_guard() to service_role;

drop trigger if exists inventory_items_phase1_write_guard on public.inventory_items;
create trigger inventory_items_phase1_write_guard
before insert or update on public.inventory_items
for each row execute function private.inventory_item_write_guard();

alter table public.recipes
  alter column updated_by set default auth.uid();

create or replace function private.recipe_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is not null then
    new.updated_by = (select auth.uid());
  end if;
  new.updated_at = now();
  return new;
end;
$function$;

revoke all on function private.recipe_write_audit() from public, anon, authenticated;
grant execute on function private.recipe_write_audit() to service_role;

drop trigger if exists recipes_phase1_write_audit on public.recipes;
create trigger recipes_phase1_write_audit
before insert or update on public.recipes
for each row execute function private.recipe_write_audit();

-- Replace legacy policy overlap with one canonical policy set.
do $drop_public_policies$
declare
  policy_row record;
begin
  for policy_row in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      policy_row.policyname,
      policy_row.tablename
    );
  end loop;
end
$drop_public_policies$;

do $enable_all_public_rls$
declare
  relation_row record;
begin
  for relation_row in
    select c.relname
    from pg_class as c
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', relation_row.relname);
  end loop;
end
$enable_all_public_rls$;

-- Reset browser grants first, retain trusted server access, then add only the
-- explicit browser privileges below.
do $reset_public_relation_grants$
declare
  relation_row record;
begin
  for relation_row in
    select c.relname, c.relkind
    from pg_class as c
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'S')
  loop
    if relation_row.relkind = 'S' then
      execute format(
        'revoke all privileges on sequence public.%I from public, anon, authenticated',
        relation_row.relname
      );
      execute format(
        'grant all privileges on sequence public.%I to service_role',
        relation_row.relname
      );
    else
      execute format(
        'revoke all privileges on table public.%I from public, anon, authenticated',
        relation_row.relname
      );
      execute format(
        'grant all privileges on table public.%I to service_role',
        relation_row.relname
      );
    end if;
  end loop;
end
$reset_public_relation_grants$;

do $reset_public_function_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      function_row.signature
    );
    execute format(
      'grant execute on function %s to service_role',
      function_row.signature
    );
  end loop;
end
$reset_public_function_grants$;

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

create or replace procedure private.phase1_grant_table(
  p_table text,
  p_privileges text
)
language plpgsql
security invoker
set search_path = ''
as $procedure$
begin
  if to_regclass(format('public.%I', p_table)) is not null then
    execute format(
      'grant %s on table public.%I to authenticated',
      p_privileges,
      p_table
    );
  end if;
end;
$procedure$;

call private.phase1_grant_table('profiles', 'select, update');
call private.phase1_grant_table('inventory_items', 'select, insert, update, delete');
call private.phase1_grant_table('inventory_movements', 'select');
call private.phase1_grant_table('recipes', 'select, insert, update, delete');
call private.phase1_grant_table('recipe_categories', 'select, insert, update, delete');
call private.phase1_grant_table('recipe_ingredients', 'select, insert, update, delete');
call private.phase1_grant_table('suppliers', 'select, insert, update, delete');
call private.phase1_grant_table('atlas_media', 'select, insert, update, delete');
call private.phase1_grant_table('import_batches', 'select, insert, update, delete');
call private.phase1_grant_table('import_review_items', 'select, insert, update, delete');
call private.phase1_grant_table('import_inventory_rows', 'select, insert, update, delete');
call private.phase1_grant_table('inventory_aliases', 'select');
call private.phase1_grant_table('shifts', 'select, insert, update, delete');
call private.phase1_grant_table('staff_availability', 'select, insert, update, delete');
call private.phase1_grant_table('staff_details', 'select, insert, update, delete');
call private.phase1_grant_table('staff_documents', 'select, insert, update, delete');
call private.phase1_grant_table('onboarding_tasks', 'select, insert, update, delete');
call private.phase1_grant_table('onboarding_progress', 'select, insert, update, delete');
call private.phase1_grant_table('document_acknowledgements', 'select, insert');

drop procedure private.phase1_grant_table(text, text);

create or replace procedure private.phase1_create_policy(
  p_table text,
  p_policy text,
  p_command text,
  p_using text default null,
  p_check text default null
)
language plpgsql
security invoker
set search_path = ''
as $procedure$
declare
  statement text;
begin
  if to_regclass(format('public.%I', p_table)) is null then
    return;
  end if;

  statement := format(
    'create policy %I on public.%I for %s to authenticated',
    p_policy,
    p_table,
    p_command
  );
  if p_using is not null then
    statement := statement || format(' using (%s)', p_using);
  end if;
  if p_check is not null then
    statement := statement || format(' with check (%s)', p_check);
  end if;
  execute statement;
end;
$procedure$;

call private.phase1_create_policy(
  'profiles',
  'active staff read profiles',
  'select',
  'private.is_manager_or_admin() or (private.is_active_staff() and (active is true or id = (select auth.uid())))'
);
call private.phase1_create_policy(
  'profiles',
  'active administrators update profiles',
  'update',
  'private.current_profile_role() = ''admin''',
  'private.current_profile_role() = ''admin'''
);

call private.phase1_create_policy(
  'inventory_items',
  'active managers read inventory items',
  'select',
  'private.is_manager_or_admin()'
);
call private.phase1_create_policy(
  'inventory_items',
  'active managers add inventory items',
  'insert',
  null,
  'private.is_manager_or_admin() and quantity = 0'
);
call private.phase1_create_policy(
  'inventory_items',
  'active managers update inventory items',
  'update',
  'private.is_manager_or_admin()',
  'private.is_manager_or_admin()'
);
call private.phase1_create_policy(
  'inventory_items',
  'active managers delete inventory items',
  'delete',
  'private.is_manager_or_admin()'
);
call private.phase1_create_policy(
  'inventory_movements',
  'active managers read inventory movements',
  'select',
  'private.is_manager_or_admin()'
);

-- Recipes are operational knowledge before the recipe-catalogue hardening
-- migration replaces these reads with manager-only canonical access.
do $recipe_policies$
declare
  table_name text;
begin
  foreach table_name in array array['recipes', 'recipe_categories', 'recipe_ingredients']
  loop
    call private.phase1_create_policy(
      table_name,
      'active staff read ' || table_name,
      'select',
      'private.is_active_staff()'
    );
    call private.phase1_create_policy(
      table_name,
      'active managers add ' || table_name,
      'insert',
      null,
      'private.is_manager_or_admin()'
    );
    call private.phase1_create_policy(
      table_name,
      'active managers update ' || table_name,
      'update',
      'private.is_manager_or_admin()',
      'private.is_manager_or_admin()'
    );
    call private.phase1_create_policy(
      table_name,
      'active managers delete ' || table_name,
      'delete',
      'private.is_manager_or_admin()'
    );
  end loop;
end
$recipe_policies$;

do $manager_only_tables$
declare
  table_name text;
begin
  foreach table_name in array array[
    'suppliers',
    'import_batches',
    'import_review_items',
    'import_inventory_rows',
    'inventory_aliases'
  ]
  loop
    call private.phase1_create_policy(
      table_name,
      'active managers read ' || table_name,
      'select',
      'private.is_manager_or_admin()'
    );
    if table_name <> 'inventory_aliases' then
      call private.phase1_create_policy(
        table_name,
        'active managers add ' || table_name,
        'insert',
        null,
        'private.is_manager_or_admin()'
      );
      call private.phase1_create_policy(
        table_name,
        'active managers update ' || table_name,
        'update',
        'private.is_manager_or_admin()',
        'private.is_manager_or_admin()'
      );
      call private.phase1_create_policy(
        table_name,
        'active managers delete ' || table_name,
        'delete',
        'private.is_manager_or_admin()'
      );
    end if;
  end loop;
end
$manager_only_tables$;

call private.phase1_create_policy(
  'atlas_media',
  'active staff read media',
  'select',
  'private.is_active_staff()'
);
call private.phase1_create_policy(
  'atlas_media',
  'operational staff add own media',
  'insert',
  null,
  'private.is_operational_staff() and uploaded_by = (select auth.uid())'
);
call private.phase1_create_policy(
  'atlas_media',
  'owners or managers update media',
  'update',
  'private.is_manager_or_admin() or (private.is_operational_staff() and uploaded_by = (select auth.uid()))',
  'private.is_manager_or_admin() or (private.is_operational_staff() and uploaded_by = (select auth.uid()))'
);
call private.phase1_create_policy(
  'atlas_media',
  'owners or managers delete media',
  'delete',
  'private.is_manager_or_admin() or (private.is_operational_staff() and uploaded_by = (select auth.uid()))'
);

call private.phase1_create_policy('shifts', 'active staff read shifts', 'select', 'private.is_active_staff()');
call private.phase1_create_policy('shifts', 'active managers add shifts', 'insert', null, 'private.is_manager_or_admin()');
call private.phase1_create_policy('shifts', 'active managers update shifts', 'update', 'private.is_manager_or_admin()', 'private.is_manager_or_admin()');
call private.phase1_create_policy('shifts', 'active managers delete shifts', 'delete', 'private.is_manager_or_admin()');

call private.phase1_create_policy('staff_availability', 'staff read own availability', 'select', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('staff_availability', 'staff add own availability', 'insert', null, 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('staff_availability', 'staff update own availability', 'update', 'private.is_self_or_manager(user_id)', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('staff_availability', 'staff delete own availability', 'delete', 'private.is_self_or_manager(user_id)');

call private.phase1_create_policy('staff_details', 'staff read own details', 'select', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('staff_details', 'staff add own details', 'insert', null, 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('staff_details', 'staff update own details', 'update', 'private.is_self_or_manager(user_id)', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('staff_details', 'active managers delete staff details', 'delete', 'private.is_manager_or_admin()');

call private.phase1_create_policy('staff_documents', 'active staff read published staff documents', 'select', 'private.is_active_staff() and active is true');
call private.phase1_create_policy('staff_documents', 'active managers add staff documents', 'insert', null, 'private.is_manager_or_admin()');
call private.phase1_create_policy('staff_documents', 'active managers update staff documents', 'update', 'private.is_manager_or_admin()', 'private.is_manager_or_admin()');
call private.phase1_create_policy('staff_documents', 'active managers delete staff documents', 'delete', 'private.is_manager_or_admin()');

call private.phase1_create_policy('onboarding_tasks', 'active staff read onboarding tasks', 'select', 'private.is_active_staff() and active is true');
call private.phase1_create_policy('onboarding_tasks', 'active managers add onboarding tasks', 'insert', null, 'private.is_manager_or_admin()');
call private.phase1_create_policy('onboarding_tasks', 'active managers update onboarding tasks', 'update', 'private.is_manager_or_admin()', 'private.is_manager_or_admin()');
call private.phase1_create_policy('onboarding_tasks', 'active managers delete onboarding tasks', 'delete', 'private.is_manager_or_admin()');

call private.phase1_create_policy('onboarding_progress', 'staff read own onboarding progress', 'select', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('onboarding_progress', 'staff add own onboarding progress', 'insert', null, 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('onboarding_progress', 'staff update own onboarding progress', 'update', 'private.is_self_or_manager(user_id)', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('onboarding_progress', 'active managers delete onboarding progress', 'delete', 'private.is_manager_or_admin()');

call private.phase1_create_policy('document_acknowledgements', 'staff read own acknowledgements', 'select', 'private.is_self_or_manager(user_id)');
call private.phase1_create_policy('document_acknowledgements', 'staff add own acknowledgements', 'insert', null, 'private.is_active_staff() and user_id = (select auth.uid())');

drop procedure private.phase1_create_policy(text, text, text, text, text);

-- Controlled live-stock mutation: manager/admin only, immutable movement evidence,
-- and no direct quantity write outside this transaction-local gate.
create or replace function public.adjust_inventory(
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_note text default null
)
returns public.inventory_items
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item_row public.inventory_items;
  caller_role text := coalesce((select auth.role()), '');
begin
  if caller_role <> 'service_role'
     and session_user <> 'postgres'
     and not private.is_manager_or_admin() then
    raise exception 'Controlled inventory adjustments require an active manager or administrator'
      using errcode = '42501';
  end if;

  if p_quantity_change = 0 then
    raise exception 'Quantity change cannot be zero';
  end if;
  if p_movement_type not in ('restock', 'sale', 'waste', 'adjustment', 'count', 'transfer') then
    raise exception 'Invalid movement type';
  end if;

  perform set_config('atlas.allow_inventory_quantity_change', 'on', true);

  update public.inventory_items
  set quantity = quantity + p_quantity_change,
      supplier_id = coalesce(p_supplier_id, supplier_id),
      cost_price = case when p_unit_cost is not null then p_unit_cost else cost_price end,
      updated_by = coalesce((select auth.uid())::text, updated_by)
  where id = p_item_id
    and quantity + p_quantity_change >= 0
  returning * into item_row;

  if item_row.id is null then
    raise exception 'Item not found or resulting quantity would be negative';
  end if;

  insert into public.inventory_movements (
    item_id,
    item_name,
    movement_type,
    quantity_change,
    unit_cost,
    total_cost,
    supplier_id,
    note,
    created_by
  )
  values (
    item_row.id,
    item_row.name,
    p_movement_type,
    p_quantity_change,
    p_unit_cost,
    case when p_unit_cost is null then null else abs(p_quantity_change) * p_unit_cost end,
    p_supplier_id,
    left(p_note, 1000),
    (select auth.uid())
  );

  return item_row;
end;
$function$;

revoke all on function public.adjust_inventory(uuid, numeric, text, numeric, uuid, text)
  from public, anon;
grant execute on function public.adjust_inventory(uuid, numeric, text, numeric, uuid, text)
  to authenticated, service_role;

-- Staff-safe inventory catalogue. Existing catalogue views are accepted only when
-- they expose no commercial, supplier, import-source or browser-supplied audit data.
do $inventory_catalog$
declare
  forbidden_columns text[];
begin
  if to_regclass('public.inventory_catalog') is null then
    execute $create_function$
      create or replace function private.read_inventory_catalog()
      returns table (
        id uuid,
        name text,
        category text,
        quantity numeric,
        unit text,
        par_level numeric,
        sku text,
        barcode text,
        bin_location text,
        units_per_case numeric,
        size_ml numeric,
        active boolean,
        image_url text,
        sell_price numeric,
        package_size text,
        updated_at timestamptz
      )
      language plpgsql
      stable
      security definer
      set search_path = ''
      as $catalog_function$
      begin
        if coalesce((select auth.role()), '') <> 'service_role'
           and session_user <> 'postgres'
           and not private.is_active_staff() then
          raise exception 'An active Atlas profile is required'
            using errcode = '42501';
        end if;

        return query
        select
          item.id,
          item.name,
          item.category,
          item.quantity,
          item.unit,
          item.par_level,
          item.sku,
          item.barcode,
          item.bin_location,
          item.units_per_case,
          item.size_ml,
          item.active,
          item.image_url,
          item.sell_price,
          item.package_size,
          item.updated_at
        from public.inventory_items as item;
      end;
      $catalog_function$;
    $create_function$;

    execute $create_view$
      create view public.inventory_catalog
      with (security_invoker = true)
      as
      select *
      from private.read_inventory_catalog()
    $create_view$;
  else
    select array_agg(column_name order by column_name)
      into forbidden_columns
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_catalog'
      and column_name in (
        'cost_price',
        'case_cost',
        'discount_percent',
        'supplier',
        'supplier_id',
        'supplier_product_reference',
        'source_file',
        'import_note',
        'updated_by'
      );

    if forbidden_columns is not null then
      raise exception 'Existing inventory_catalog exposes forbidden columns: %',
        array_to_string(forbidden_columns, ', ');
    end if;

    execute 'alter view public.inventory_catalog set (security_invoker = true)';
  end if;
end
$inventory_catalog$;

do $inventory_catalog_function_grants$
declare
  catalog_function regprocedure;
begin
  catalog_function := to_regprocedure('private.read_inventory_catalog()');
  if catalog_function is not null then
    execute format('revoke all on function %s from public, anon', catalog_function);
    execute format('grant execute on function %s to authenticated, service_role', catalog_function);
  end if;
end
$inventory_catalog_function_grants$;

revoke all on table public.inventory_catalog from public, anon;
grant select on table public.inventory_catalog to authenticated, service_role;
comment on view public.inventory_catalog is
  'Redacted active-staff inventory catalogue. Commercial cost, supplier and audit fields are intentionally omitted.';

create or replace function private.read_inventory_movement_catalog()
returns table (
  id uuid,
  item_id uuid,
  item_name text,
  movement_type text,
  quantity_change numeric,
  note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres'
     and not private.is_active_staff() then
    raise exception 'An active Atlas profile is required'
      using errcode = '42501';
  end if;

  return query
  select
    movement.id,
    movement.item_id,
    movement.item_name,
    movement.movement_type,
    movement.quantity_change,
    movement.note,
    movement.created_at
  from public.inventory_movements as movement;
end;
$function$;

revoke all on function private.read_inventory_movement_catalog() from public, anon;
grant execute on function private.read_inventory_movement_catalog()
  to authenticated, service_role;

drop view if exists public.inventory_movement_catalog;
create view public.inventory_movement_catalog
with (security_invoker = true)
as
select *
from private.read_inventory_movement_catalog();

revoke all on table public.inventory_movement_catalog from public, anon;
grant select on table public.inventory_movement_catalog to authenticated, service_role;
comment on view public.inventory_movement_catalog is
  'Redacted active-staff inventory movement history. Cost, supplier and employee attribution are omitted.';

-- Deliberate anonymous exception: exactly four approved fields and no ingredients,
-- costs, margins, supplier terms or employee data.
drop view if exists public.public_menu;
create view public.public_menu
with (security_invoker = false)
as
select
  recipe.id,
  recipe.name,
  recipe.type,
  recipe.menu_price
from public.recipes as recipe
where recipe.show_on_menu is true
  and recipe.active is true;

revoke all on table public.public_menu from public, anon, authenticated;
grant select on table public.public_menu to anon, authenticated, service_role;

do $public_menu_shape$
declare
  actual_columns text[];
begin
  select array_agg(column_name order by ordinal_position)
    into actual_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'public_menu';

  if actual_columns is distinct from array['id', 'name', 'type', 'menu_price']::text[] then
    raise exception 'public_menu must expose exactly id, name, type and menu_price';
  end if;
end
$public_menu_shape$;

comment on view public.public_menu is
  'Intentional anonymous menu projection: id, name, type and menu_price only.';

notify pgrst, 'reload schema';
