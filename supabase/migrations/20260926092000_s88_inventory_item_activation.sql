-- S88 inventory item activation.
--
-- Deactivation was a direct browser table update with no reason and no audit
-- event, and there was no way back. This migration adds:
--
-- * an audit trigger on every change of inventory_items.active, whichever path
--   made it (the S87 web's direct update keeps working and is recorded with
--   via = 'direct_update');
-- * a manager-only dependency read (recipes, open purchase orders, supplier,
--   same-name active duplicate, stock evidence) that drives the confirm dialog;
-- * one manager-only command to deactivate or reactivate an item with an
--   optional reason and an optimistic updated_at check. It refuses to
--   deactivate an item that is on an open purchase order (the order would
--   become unreceivable) and refuses to reactivate an item while another
--   active item has the same name.
--
-- Path B: the browser calls the atlas-item-master Edge Function, which verifies
-- the session and the active manager profile and calls the service-role-only
-- public wrappers. The database re-checks the actor's profile. Recipe links,
-- par levels, supplier and quantity are never changed.

alter table atlas_private.item_master_events
  drop constraint if exists item_master_events_event_type_check;
alter table atlas_private.item_master_events
  add constraint item_master_events_event_type_check check (event_type in (
    'draft_saved','publication_prepared','publication_blocked','publication_started',
    'publication_published','publication_failed',
    'item_deactivated','item_reactivated','par_levels_updated'));

-- Audit every active flip. Actor: the authenticated browser user, else the
-- actor recorded by the activation command for this transaction.
create or replace function private.inventory_item_active_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  via text := coalesce(nullif(current_setting('atlas.item_active_via', true), ''), 'direct_update');
  actor uuid := (select auth.uid());
  actor_role text := private.current_profile_role();
  actor_label text;
begin
  if new.active is distinct from old.active then
    if via = 'rpc' then
      actor := nullif(current_setting('atlas.item_active_actor_id', true), '')::uuid;
      actor_role := nullif(current_setting('atlas.item_active_actor_role', true), '');
      actor_label := nullif(current_setting('atlas.item_active_actor_label', true), '');
    elsif actor is not null then
      select coalesce(nullif(btrim(profile.display_name), ''), profile.email) into actor_label
      from public.profiles profile where profile.id = actor;
    end if;

    insert into atlas_private.item_master_events(event_type, external_item_id, actor_id, actor_label, actor_role, payload)
    values (
      case when new.active then 'item_reactivated' else 'item_deactivated' end,
      new.id, actor, actor_label, actor_role,
      jsonb_build_object(
        'reason', case when via = 'rpc' then nullif(current_setting('atlas.item_active_reason', true), '') end,
        'via', via,
        'caller_role', coalesce((select auth.role()), ''),
        'item_name', new.name,
        'active', new.active
      )
    );
  end if;
  return new;
end;
$function$;

revoke all on function private.inventory_item_active_audit() from public, anon, authenticated;

drop trigger if exists inventory_items_s88_active_audit on public.inventory_items;
create trigger inventory_items_s88_active_audit
  after update of active on public.inventory_items
  for each row execute function private.inventory_item_active_audit();

-- Actor gate for the service-role commands: active admin or manager profile.
create or replace function atlas_private.inventory_activation_actor_role(p_actor_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  actor_role text;
begin
  select profile.role::text into actor_role
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active is true
    and profile.role::text in ('admin', 'manager');
  if p_actor_id is null or actor_role is null then
    raise exception 'Active manager access required' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return actor_role;
end;
$function$;

-- Facts for the confirm dialog. Internal: callers gate the actor first.
create or replace function atlas_private.inventory_item_dependency_facts(p_item_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  item_row public.inventory_items;
  supplier_row public.suppliers;
  recipe_total integer := 0;
  recipe_active integer := 0;
  recipe_names jsonb := '[]'::jsonb;
  open_orders jsonb;
  open_order_count integer := 0;
  duplicate_id uuid;
  duplicate_name text;
  verified_current boolean := false;
begin
  select * into item_row from public.inventory_items where id = p_item_id;
  if not found then
    raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;

  select count(distinct recipe.id), count(distinct recipe.id) filter (where recipe.active)
  into recipe_total, recipe_active
  from public.recipe_ingredients ingredient
  join public.recipes recipe on recipe.id = ingredient.recipe_id
  where ingredient.item_id = p_item_id;

  select coalesce(jsonb_agg(names.name order by names.name), '[]'::jsonb) into recipe_names
  from (
    select distinct recipe.name
    from public.recipe_ingredients ingredient
    join public.recipes recipe on recipe.id = ingredient.recipe_id
    where ingredient.item_id = p_item_id and recipe.active
    order by recipe.name
    limit 10
  ) names;

  -- Any status that is not terminal counts as open, so later purchasing
  -- states (approval, partial receiving) are covered without a list change.
  select coalesce(jsonb_object_agg(counts.status, counts.total), '{}'::jsonb), coalesce(sum(counts.total), 0)
  into open_orders, open_order_count
  from (
    select po.status, count(*)::integer as total
    from public.purchase_orders po
    where po.status not in ('received', 'cancelled', 'closed', 'rejected')
      and exists (
        select 1 from jsonb_array_elements(po.lines) line
        where line->>'item_id' = p_item_id::text
      )
    group by po.status
  ) counts;

  select other.id, other.name into duplicate_id, duplicate_name
  from public.inventory_items other
  where other.active
    and other.id <> p_item_id
    and lower(btrim(other.name)) = lower(btrim(item_row.name))
  order by other.name, other.id
  limit 1;

  if item_row.supplier_id is not null then
    select * into supplier_row from public.suppliers where id = item_row.supplier_id;
  end if;

  select exists (
    select 1 from atlas_private.inventory_verified_balances balance
    where balance.inventory_item_id = p_item_id
      and balance.verification_status = 'current'
      and balance.expires_at > pg_catalog.now()
  ) into verified_current;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', item_row.id, 'name', item_row.name, 'active', item_row.active,
      'unit', item_row.unit, 'category', item_row.category,
      'par_level', item_row.par_level, 'supplier_id', item_row.supplier_id,
      'updated_at', item_row.updated_at),
    'recipes', jsonb_build_object('total', recipe_total, 'active', recipe_active, 'names', recipe_names),
    'open_orders', jsonb_build_object('total', open_order_count, 'by_status', open_orders),
    'supplier', case when item_row.supplier_id is null then null else jsonb_build_object(
      'id', item_row.supplier_id, 'name', supplier_row.name,
      'active', coalesce(supplier_row.active, false)) end,
    'active_name_duplicate', case when duplicate_id is null then null else jsonb_build_object(
      'id', duplicate_id, 'name', duplicate_name) end,
    'stock', jsonb_build_object('verified_current', verified_current),
    'can_deactivate', item_row.active and open_order_count = 0,
    'can_reactivate', not item_row.active and duplicate_id is null,
    'blockers', to_jsonb(array_remove(array[
      case when item_row.active and open_order_count > 0 then 'open_purchase_order' end,
      case when not item_row.active and duplicate_id is not null then 'active_duplicate_name' end
    ], null)),
    'warnings', to_jsonb(array_remove(array[
      case when item_row.supplier_id is not null and not coalesce(supplier_row.active, false) then 'supplier_inactive' end,
      case when not verified_current then 'stock_needs_count' end,
      case when recipe_active > 0 then 'used_by_active_recipes' end
    ], null))
  );
end;
$function$;

create or replace function atlas_private.inventory_item_dependencies(p_item_id uuid, p_actor_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform atlas_private.inventory_activation_actor_role(p_actor_id);
  return atlas_private.inventory_item_dependency_facts(p_item_id);
end;
$function$;

create or replace function atlas_private.set_inventory_item_active(
  p_item_id uuid,
  p_active boolean,
  p_reason text,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_actor_label text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  actor_role text;
  item_row public.inventory_items;
  clean_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  actor_role := atlas_private.inventory_activation_actor_role(p_actor_id);
  if p_item_id is null or p_active is null then
    raise exception 'Item and target state are required' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if length(coalesce(clean_reason, '')) > 500 then
    raise exception 'Reason is limited to 500 characters' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select * into item_row from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if item_row.active = p_active then
    return jsonb_build_object('item_id', p_item_id, 'active', p_active, 'changed', false,
      'updated_at', item_row.updated_at,
      'dependencies', atlas_private.inventory_item_dependency_facts(p_item_id));
  end if;
  if p_expected_updated_at is not null and item_row.updated_at <> p_expected_updated_at then
    raise exception 'Item changed. Refresh before continuing' using hint = 'atlas:stale_item';
  end if;

  if not p_active and exists (
    select 1 from public.purchase_orders po
    where po.status not in ('received', 'cancelled', 'closed', 'rejected')
      and exists (select 1 from jsonb_array_elements(po.lines) line where line->>'item_id' = p_item_id::text)
  ) then
    raise exception 'This item is on an open purchase order. Remove it from the order or receive it first.'
      using hint = 'atlas:open_purchase_order';
  end if;

  if p_active and exists (
    select 1 from public.inventory_items other
    where other.active and other.id <> p_item_id
      and lower(btrim(other.name)) = lower(btrim(item_row.name))
  ) then
    raise exception 'An active item with the same name exists. Review both before reactivating.'
      using hint = 'atlas:active_duplicate_name';
  end if;

  perform set_config('atlas.item_active_via', 'rpc', true);
  perform set_config('atlas.item_active_reason', coalesce(clean_reason, ''), true);
  perform set_config('atlas.item_active_actor_id', p_actor_id::text, true);
  perform set_config('atlas.item_active_actor_role', actor_role, true);
  perform set_config('atlas.item_active_actor_label', coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), ''), true);

  update public.inventory_items
  set active = p_active,
      updated_by = p_actor_id::text
  where id = p_item_id
  returning * into item_row;

  -- Later updates in the same transaction are not attributed to this command.
  perform set_config('atlas.item_active_via', '', true);
  perform set_config('atlas.item_active_reason', '', true);
  perform set_config('atlas.item_active_actor_id', '', true);
  perform set_config('atlas.item_active_actor_role', '', true);
  perform set_config('atlas.item_active_actor_label', '', true);

  return jsonb_build_object(
    'item_id', p_item_id,
    'active', p_active,
    'changed', true,
    'updated_at', item_row.updated_at,
    'dependencies', atlas_private.inventory_item_dependency_facts(p_item_id)
  );
end;
$function$;

create or replace function public.atlas_inventory_item_dependencies(p_item_id uuid, p_actor_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select atlas_private.inventory_item_dependencies(p_item_id, p_actor_id);
$function$;

create or replace function public.atlas_set_inventory_item_active(
  p_item_id uuid,
  p_active boolean,
  p_reason text,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_actor_label text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.set_inventory_item_active(
    p_item_id, p_active, p_reason, p_expected_updated_at, p_actor_id, p_actor_label);
$function$;

do $s88_activation_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'atlas_private' and p.proname in (
        'inventory_activation_actor_role', 'inventory_item_dependency_facts',
        'inventory_item_dependencies', 'set_inventory_item_active'))
       or (n.nspname = 'public' and p.proname in (
        'atlas_inventory_item_dependencies', 'atlas_set_inventory_item_active'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_row.signature);
    execute format('grant execute on function %s to service_role', function_row.signature);
  end loop;
end
$s88_activation_grants$;

comment on function public.atlas_set_inventory_item_active(uuid, boolean, text, timestamptz, uuid, text) is
  'S88 service-role-only manager command to deactivate or reactivate an inventory item. Audited; refuses open-order deactivation and same-name reactivation.';

notify pgrst, 'reload schema';
