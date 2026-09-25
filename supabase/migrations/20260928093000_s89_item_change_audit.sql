-- S89 security follow-up (review S88b G4): audit every catalogue change to an
-- inventory item, by any path, and move the controlled stock adjustment behind
-- a private definer so the browser never needs UPDATE on inventory_items.
--
--   * atlas_private.item_master_events gains the event type 'item_changed'.
--     An AFTER UPDATE trigger on public.inventory_items records a change to
--     name, category, par_level, supplier, supplier_id, cost_price or
--     case_cost with the before/after values, the actor and the path. Active
--     changes keep their own S88 events (item_deactivated / item_reactivated).
--     The actor is the signed-in user (auth.uid()), or the actor a governed
--     server path declared (atlas.item_active_actor_id / atlas.audit_actor_id);
--     server-role paths without one are recorded with caller_role
--     'service_role' and their own governed event carries the actor.
--   * public.adjust_inventory keeps its signature, its SECURITY INVOKER wrapper
--     and its manager check, and now applies the change through
--     private.adjust_inventory_apply (SECURITY DEFINER, private schema, not
--     exposed by the API). This is compatible with the current web app and is
--     what lets 20260928095000_s89_revoke_direct_item_update.sql revoke UPDATE.
-- Safe to apply before the new web deploy: nothing is revoked here.

do $s89_item_changed$
declare
  definition text;
  kinds text[];
begin
  select pg_catalog.pg_get_constraintdef(c.oid) into definition
  from pg_catalog.pg_constraint c
  where c.conrelid = 'atlas_private.item_master_events'::regclass and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%event_type%';
  select array_agg(distinct m[1] order by m[1]) into kinds
  from regexp_matches(definition, '''([a-z_]+)''', 'g') as m;
  if not 'item_changed' = any(kinds) then
    kinds := kinds || array['item_changed'];
    execute (
      select format('alter table atlas_private.item_master_events drop constraint %I', c.conname)
      from pg_catalog.pg_constraint c
      where c.conrelid = 'atlas_private.item_master_events'::regclass and c.contype = 'c'
        and pg_catalog.pg_get_constraintdef(c.oid) like '%event_type%');
    execute format(
      'alter table atlas_private.item_master_events add constraint item_master_events_event_type_check check (event_type = any (%L::text[]))',
      kinds);
  end if;
end
$s89_item_changed$;

create or replace function private.inventory_item_change_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  tracked constant text[] := array['name','category','par_level','supplier','supplier_id','cost_price','case_cost'];
  old_row jsonb := to_jsonb(old);
  new_row jsonb := to_jsonb(new);
  changes jsonb := '{}'::jsonb;
  field text;
  actor uuid := (select auth.uid());
  actor_role text;
  actor_label text;
  via text;
begin
  foreach field in array tracked loop
    if old_row->field is distinct from new_row->field then
      changes := changes || jsonb_build_object(field, jsonb_build_object('from', old_row->field, 'to', new_row->field));
    end if;
  end loop;
  if changes = '{}'::jsonb then return null; end if;

  if actor is null then
    begin
      actor := coalesce(
        nullif(current_setting('atlas.audit_actor_id', true), '')::uuid,
        nullif(current_setting('atlas.item_active_actor_id', true), '')::uuid);
    exception when invalid_text_representation then
      actor := null;
    end;
  end if;
  if actor is not null then
    select profile.role, coalesce(nullif(btrim(profile.display_name), ''), profile.email)
    into actor_role, actor_label
    from public.profiles profile where profile.id = actor;
  end if;

  via := coalesce(
    nullif(current_setting('atlas.audit_via', true), ''),
    nullif(current_setting('atlas.catalog_command', true), ''),
    nullif(current_setting('atlas.item_active_via', true), ''),
    case
      when coalesce((select auth.role()), '') = 'service_role' then 'server'
      when (select auth.uid()) is not null then 'user_session'
      else 'database'
    end);

  insert into atlas_private.item_master_events(event_type, external_item_id, actor_id, actor_label, actor_role, payload)
  values ('item_changed', new.id, actor, actor_label, actor_role,
    jsonb_build_object(
      'via', via,
      'caller_role', coalesce((select auth.role()), ''),
      'item_name', new.name,
      'changes', changes));
  return null;
end
$function$;

revoke all on function private.inventory_item_change_audit() from public, anon, authenticated;

drop trigger if exists inventory_items_s89_change_audit on public.inventory_items;
create trigger inventory_items_s89_change_audit
after update of name, category, par_level, supplier, supplier_id, cost_price, case_cost on public.inventory_items
for each row execute function private.inventory_item_change_audit();

-- Controlled stock adjustment, applied by a private definer.
create or replace function private.adjust_inventory_apply(
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_note text default null)
returns public.inventory_items
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item_row public.inventory_items;
begin
  if not private.is_manager_or_admin() then
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
  perform set_config('atlas.audit_via', 'adjust_inventory', true);

  update public.inventory_items
  set quantity = quantity + p_quantity_change,
      supplier_id = coalesce(p_supplier_id, supplier_id),
      cost_price = case when p_unit_cost is not null then p_unit_cost else cost_price end,
      updated_by = coalesce((select auth.uid())::text, updated_by)
  where id = p_item_id
    and quantity + p_quantity_change >= 0
  returning * into item_row;

  perform set_config('atlas.allow_inventory_quantity_change', '', true);
  perform set_config('atlas.audit_via', '', true);

  if item_row.id is null then
    raise exception 'Item not found or resulting quantity would be negative';
  end if;

  insert into public.inventory_movements (
    item_id, item_name, movement_type, quantity_change, unit_cost, total_cost, supplier_id, note, created_by
  ) values (
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
end
$function$;

revoke all on function private.adjust_inventory_apply(uuid, numeric, text, numeric, uuid, text) from public, anon;
grant execute on function private.adjust_inventory_apply(uuid, numeric, text, numeric, uuid, text) to authenticated, service_role;

create or replace function public.adjust_inventory(
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_note text default null)
returns public.inventory_items
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if not private.is_manager_or_admin() then
    raise exception 'Controlled inventory adjustments require an active manager or administrator'
      using errcode = '42501';
  end if;
  return private.adjust_inventory_apply(p_item_id, p_quantity_change, p_movement_type, p_unit_cost, p_supplier_id, p_note);
end
$function$;

notify pgrst, 'reload schema';
