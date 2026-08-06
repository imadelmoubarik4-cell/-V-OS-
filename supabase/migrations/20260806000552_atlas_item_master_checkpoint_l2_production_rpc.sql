-- Manager-only atomic publication for the approved Checkpoint L2 master fields.
-- Quantity and inventory movement records are deliberately outside this RPC.

create or replace function public.atlas_apply_item_master_update(
  p_item_id uuid,
  p_values jsonb,
  p_recipe_ingredient_ids uuid[],
  p_expected_values jsonb,
  p_request_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  item_row public.inventory_items;
  current_values jsonb;
  unknown_key text;
  ingredient_id uuid;
  conflicting_link uuid;
  linked_count integer := 0;
begin
  if not private.is_manager_or_admin() then raise exception 'Only active managers can publish item-master changes'; end if;
  if p_item_id is null then raise exception 'Inventory item id is required'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request id is required'; end if;
  if jsonb_typeof(coalesce(p_values,'{}'::jsonb)) <> 'object' then raise exception 'Item-master values must be an object'; end if;
  if jsonb_typeof(coalesce(p_expected_values,'{}'::jsonb)) <> 'object' then raise exception 'Expected item-master values must be an object'; end if;

  select item_key into unknown_key
  from jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) as keys(item_key)
  where item_key not in ('par_level','critical_minimum','supplier_id','supplier','supplier_product_reference','units_per_case','size_ml','package_weight_g','package_size','cost_price','case_cost','bin_location','lead_time_days','minimum_order_quantity')
  limit 1;
  if unknown_key is not null then raise exception 'Unsupported item-master field %',unknown_key; end if;

  select * into item_row from public.inventory_items where id=p_item_id for update;
  if not found then raise exception 'Inventory item not found'; end if;

  current_values := jsonb_build_object(
    'par_level',item_row.par_level,'critical_minimum',item_row.critical_minimum,
    'supplier_id',item_row.supplier_id,'supplier',item_row.supplier,
    'supplier_product_reference',item_row.supplier_product_reference,
    'units_per_case',item_row.units_per_case,'size_ml',item_row.size_ml,
    'package_weight_g',item_row.package_weight_g,'package_size',item_row.package_size,
    'cost_price',item_row.cost_price,'case_cost',item_row.case_cost,
    'bin_location',item_row.bin_location,'lead_time_days',item_row.lead_time_days,
    'minimum_order_quantity',item_row.minimum_order_quantity
  );
  if current_values is distinct from p_expected_values then raise exception 'Production item-master fields changed after draft review'; end if;

  if p_values ? 'par_level' and p_values->'par_level' <> 'null'::jsonb and (p_values->>'par_level')::numeric < 0 then raise exception 'Par level cannot be negative'; end if;
  if p_values ? 'critical_minimum' and p_values->'critical_minimum' <> 'null'::jsonb and (p_values->>'critical_minimum')::numeric < 0 then raise exception 'Critical minimum cannot be negative'; end if;
  if p_values ? 'units_per_case' and p_values->'units_per_case' <> 'null'::jsonb and (p_values->>'units_per_case')::numeric <= 0 then raise exception 'Units per case must be greater than zero'; end if;
  if p_values ? 'size_ml' and p_values->'size_ml' <> 'null'::jsonb and (p_values->>'size_ml')::numeric <= 0 then raise exception 'Package volume must be greater than zero'; end if;
  if p_values ? 'package_weight_g' and p_values->'package_weight_g' <> 'null'::jsonb and (p_values->>'package_weight_g')::numeric <= 0 then raise exception 'Package weight must be greater than zero'; end if;
  if p_values ? 'cost_price' and p_values->'cost_price' <> 'null'::jsonb and (p_values->>'cost_price')::numeric < 0 then raise exception 'Unit cost cannot be negative'; end if;
  if p_values ? 'case_cost' and p_values->'case_cost' <> 'null'::jsonb and (p_values->>'case_cost')::numeric < 0 then raise exception 'Case cost cannot be negative'; end if;
  if p_values ? 'lead_time_days' and p_values->'lead_time_days' <> 'null'::jsonb
     and ((p_values->>'lead_time_days')::numeric < 0 or (p_values->>'lead_time_days')::numeric <> trunc((p_values->>'lead_time_days')::numeric)) then
    raise exception 'Lead time must be a non-negative whole number';
  end if;
  if p_values ? 'minimum_order_quantity' and p_values->'minimum_order_quantity' <> 'null'::jsonb and (p_values->>'minimum_order_quantity')::numeric <= 0 then raise exception 'Minimum order quantity must be greater than zero'; end if;

  if coalesce(case when p_values ? 'critical_minimum' then nullif(p_values->>'critical_minimum','')::numeric else item_row.critical_minimum end,0)
     > coalesce(case when p_values ? 'par_level' then nullif(p_values->>'par_level','')::numeric else item_row.par_level end,1e100::numeric) then
    raise exception 'Critical minimum cannot be above par level';
  end if;

  foreach ingredient_id in array coalesce(p_recipe_ingredient_ids,'{}'::uuid[]) loop
    select recipe_ingredient.item_id into conflicting_link
    from public.recipe_ingredients recipe_ingredient
    where recipe_ingredient.id=ingredient_id
    for update;
    if not found then raise exception 'Recipe ingredient % was not found',ingredient_id; end if;
    if conflicting_link is not null and conflicting_link <> p_item_id then raise exception 'Recipe ingredient % is already linked to another inventory item',ingredient_id; end if;
  end loop;

  update public.inventory_items
  set par_level=case when p_values ? 'par_level' then nullif(p_values->>'par_level','')::numeric else par_level end,
      critical_minimum=case when p_values ? 'critical_minimum' then nullif(p_values->>'critical_minimum','')::numeric else critical_minimum end,
      supplier_id=case when p_values ? 'supplier_id' then nullif(p_values->>'supplier_id','')::uuid else supplier_id end,
      supplier=case when p_values ? 'supplier' then nullif(trim(p_values->>'supplier'),'') else supplier end,
      supplier_product_reference=case when p_values ? 'supplier_product_reference' then nullif(trim(p_values->>'supplier_product_reference'),'') else supplier_product_reference end,
      units_per_case=case when p_values ? 'units_per_case' then nullif(p_values->>'units_per_case','')::numeric else units_per_case end,
      size_ml=case when p_values ? 'size_ml' then nullif(p_values->>'size_ml','')::numeric else size_ml end,
      package_weight_g=case when p_values ? 'package_weight_g' then nullif(p_values->>'package_weight_g','')::numeric else package_weight_g end,
      package_size=case when p_values ? 'package_size' then nullif(trim(p_values->>'package_size'),'') else package_size end,
      cost_price=case when p_values ? 'cost_price' then nullif(p_values->>'cost_price','')::numeric else cost_price end,
      case_cost=case when p_values ? 'case_cost' then nullif(p_values->>'case_cost','')::numeric else case_cost end,
      bin_location=case when p_values ? 'bin_location' then nullif(trim(p_values->>'bin_location'),'') else bin_location end,
      lead_time_days=case when p_values ? 'lead_time_days' then nullif(p_values->>'lead_time_days','')::integer else lead_time_days end,
      minimum_order_quantity=case when p_values ? 'minimum_order_quantity' then nullif(p_values->>'minimum_order_quantity','')::numeric else minimum_order_quantity end,
      updated_by=auth.uid()::text,updated_at=now()
  where id=p_item_id returning * into item_row;

  if coalesce(array_length(p_recipe_ingredient_ids,1),0) > 0 then
    update public.recipe_ingredients set item_id=p_item_id
    where id=any(p_recipe_ingredient_ids) and (item_id is null or item_id=p_item_id);
    get diagnostics linked_count = row_count;
    if linked_count <> array_length(p_recipe_ingredient_ids,1) then raise exception 'Not every recipe ingredient could be linked'; end if;
  end if;

  return jsonb_build_object(
    'request_id',p_request_id,'inventory_item_id',item_row.id,'item_name',item_row.name,
    'applied_values',jsonb_build_object(
      'par_level',item_row.par_level,'critical_minimum',item_row.critical_minimum,
      'supplier_id',item_row.supplier_id,'supplier',item_row.supplier,
      'supplier_product_reference',item_row.supplier_product_reference,
      'units_per_case',item_row.units_per_case,'size_ml',item_row.size_ml,
      'package_weight_g',item_row.package_weight_g,'package_size',item_row.package_size,
      'cost_price',item_row.cost_price,'case_cost',item_row.case_cost,
      'bin_location',item_row.bin_location,'lead_time_days',item_row.lead_time_days,
      'minimum_order_quantity',item_row.minimum_order_quantity
    ),
    'linked_recipe_ingredient_ids',to_jsonb(coalesce(p_recipe_ingredient_ids,'{}'::uuid[])),
    'quantity_mutated',false,'inventory_movement_created',false
  );
end;
$$;

revoke execute on function public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) from public,anon;
grant execute on function public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) to authenticated;
comment on function public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) is
  'Manager-only atomic Checkpoint L2 publication. Updates approved master fields and recipe links only; never changes quantity or creates an inventory movement.';
