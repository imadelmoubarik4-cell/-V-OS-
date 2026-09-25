-- S89 security follow-up (review S88b G7): atlas_stock_count_add_line
-- re-checks the actor's role from public.profiles instead of trusting the
-- p_actor_role argument (same fix as S88 F7 / catalog_actor_role).
--
-- The private function is redefined with the same signature and behaviour,
-- except that:
--   * the role is read from the actor's active profile;
--   * an unknown, inactive or non-counting profile is refused (atlas:forbidden);
--   * a claimed p_actor_role that differs from the profile is refused;
--   * events and the returned detail use the profile role.
-- The public wrapper and its grants (service_role only) are unchanged.

create or replace function atlas_private.stock_count_add_line(
  p_session_id uuid, p_item jsonb, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
  item_id uuid;
  actor_role text;
begin
  -- The role comes from the actor's active profile, never from the caller.
  -- A claimed role that differs from the profile is refused.
  select profile.role::text into actor_role from public.profiles profile
  where profile.id = p_actor_id and profile.active is true;
  if p_actor_id is null or actor_role is null or actor_role not in ('admin','manager','bartender')
     or (p_actor_role is not null and p_actor_role is distinct from actor_role) then
    raise exception 'This profile cannot count inventory' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if jsonb_typeof(coalesce(p_item, 'null'::jsonb)) <> 'object' then
    raise exception 'Inventory item is required' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  begin
    item_id := (p_item->>'id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Inventory item is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end;
  if item_id is null then raise exception 'Inventory item is required' using errcode = '22023', hint = 'atlas:invalid_request'; end if;
  if coalesce((p_item->>'active')::boolean, true) is not true then
    raise exception 'Only active items can be counted' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select * into session_row from atlas_private.inventory_count_sessions where id = p_session_id for update;
  if not found then raise exception 'Stock-count session not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if session_row.status <> 'draft' then
    raise exception 'Only draft stock counts can be edited' using errcode = '55000', hint = 'atlas:count_closed';
  end if;

  select * into line_row from atlas_private.inventory_count_lines where session_id = p_session_id and inventory_item_id = item_id;
  if found then
    return jsonb_build_object('added', false, 'line_id', line_row.id, 'line_version', line_row.version,
      'detail', atlas_private.stock_count_detail(p_session_id, p_actor_id, actor_role), 'stock_changed', false);
  end if;

  insert into atlas_private.inventory_count_lines (
    session_id,inventory_item_id,item_name,category,inventory_unit,bin_location,sku,barcode,
    expected_quantity,expected_updated_at,source_updated_at,source_kind,observed_unit,
    units_per_case_snapshot,size_ml_snapshot,package_size_snapshot,package_weight_g_snapshot,
    par_level_snapshot,supplier_snapshot,unit_cost_snapshot,case_cost_snapshot,source_file_snapshot
  )
  select
    p_session_id, item_id, coalesce(nullif(item->>'name',''),'Unnamed inventory item'),
    nullif(item->>'category',''), coalesce(nullif(item->>'unit',''),'units'), nullif(item->>'bin_location',''),
    nullif(item->>'sku',''), nullif(item->>'barcode',''),
    case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end,
    nullif(item->>'updated_at','')::timestamptz, nullif(item->>'source_updated_at','')::date,
    case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then 'historical_snapshot' else 'production_observation' end,
    coalesce(nullif(item->>'unit',''),'units'), nullif(item->>'units_per_case','')::numeric,
    nullif(item->>'size_ml','')::numeric, nullif(item->>'package_size',''),
    coalesce(nullif(item->>'package_weight_g','')::numeric, atlas_private.stock_count_package_weight_g(item->>'package_size')),
    nullif(item->>'par_level','')::numeric, nullif(coalesce(item->>'supplier', item->>'supplier_name'),''),
    nullif(item->>'cost_price','')::numeric, nullif(item->>'case_cost','')::numeric, nullif(item->>'source_file','')
  from (select p_item as item) source
  returning * into line_row;

  update atlas_private.inventory_count_sessions
  set source_record_count = source_record_count + 1, version = version + 1
  where id = p_session_id;
  insert into atlas_private.inventory_count_events (event_type, session_id, line_id, inventory_item_id, actor_id, actor_label, actor_role, payload)
  values ('line_added', p_session_id, line_row.id, item_id, p_actor_id, p_actor_label, actor_role,
    jsonb_build_object('item_name', line_row.item_name, 'reason', 'outside_session_scope'));
  return jsonb_build_object('added', true, 'line_id', line_row.id, 'line_version', line_row.version,
    'detail', atlas_private.stock_count_detail(p_session_id, p_actor_id, actor_role), 'stock_changed', false);
end
$function$;

notify pgrst, 'reload schema';
