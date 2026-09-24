-- S86.1 Reports package-size parser.
--
-- atlas_private.reports_snapshot_v2 derived pack sizes with
--   regexp_replace(text, '.*?(<n>)\s*kg.*', '\1')::numeric
-- A leading non-greedy quantifier makes the whole PostgreSQL regex
-- non-greedy, so the trailing `.*` matched nothing and text after the measure
-- survived ("1 kg / 1 unit" -> "1 / 1 unit"), aborting every Reports
-- request. All four package casts (ml, l, kg, g) had the same flaw.
--
-- This migration:
--   * adds a guarded private parser that returns a measure only for a
--     complete "<number> <unit>" text and null for anything else;
--   * replaces the four casts in reports_snapshot_v2 (nothing else changes);
--   * scrubs non-numeric text from the numeric recordset fields in the
--     public wrapper so typed recordset columns cannot abort the snapshot.
-- Signatures, owners, SECURITY INVOKER, search_path and grants are kept.
-- No table, row or policy is modified.

create or replace function atlas_private.reports_parse_pack_measure(p_value text)
returns table (measure_quantity numeric, measure_unit text)
language plpgsql
immutable
set search_path = ''
as $function$
declare
  parts text[];
  amount numeric;
begin
  parts := pg_catalog.regexp_match(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))),
    '^([0-9]{1,12})(?:([.,])([0-9]{1,12}))?[[:space:]]*(ml|millilit(?:er|re)s?|l|lt|ltr|lit(?:er|re)s?|g|gr|grams?|kg|kilograms?)$'
  );
  if parts is null then
    return query select null::numeric, null::text;
    return;
  end if;
  -- "1,000" is either a thousands separator or a decimal comma: ambiguous.
  if parts[2] = ',' and pg_catalog.length(parts[3]) = 3 and parts[1] <> '0' then
    return query select null::numeric, null::text;
    return;
  end if;
  -- Both captures are digit-only, so this cast cannot fail.
  amount := (parts[1] || coalesce('.' || parts[3], ''))::numeric;
  if amount <= 0 then
    return query select null::numeric, null::text;
    return;
  end if;
  if parts[4] in ('ml') or parts[4] ~ '^millilit' then
    return query select amount, 'ml'::text;
  elsif parts[4] in ('l', 'lt', 'ltr') or parts[4] ~ '^lit' then
    return query select amount * 1000, 'ml'::text;
  elsif parts[4] in ('kg') or parts[4] ~ '^kilogram' then
    return query select amount * 1000, 'g'::text;
  else
    return query select amount, 'g'::text;
  end if;
end;
$function$;

create or replace function atlas_private.reports_safe_numeric(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then 'null'::jsonb
    when pg_catalog.jsonb_typeof(p_value) = 'number' then p_value
    -- The text is validated as a plain decimal before the cast.
    when pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ '^[[:space:]]*[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)[[:space:]]*$'
      then pg_catalog.to_jsonb(pg_catalog.btrim(p_value #>> '{}')::numeric)
    else 'null'::jsonb
  end;
$function$;

create or replace function atlas_private.reports_scrub_numeric_fields(p_rows jsonb, p_fields text[])
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(
    case
      when pg_catalog.jsonb_typeof(entry.value) = 'object' then entry.value || coalesce((
        select pg_catalog.jsonb_object_agg(field, atlas_private.reports_safe_numeric(entry.value -> field))
        from pg_catalog.unnest(p_fields) as field
        where entry.value ? field
      ), '{}'::jsonb)
      else entry.value
    end
    order by entry.ordinality
  ), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
  ) with ordinality as entry(value, ordinality);
$function$;

revoke all on function atlas_private.reports_parse_pack_measure(text) from public, anon, authenticated;
revoke all on function atlas_private.reports_safe_numeric(jsonb) from public, anon, authenticated;
revoke all on function atlas_private.reports_scrub_numeric_fields(jsonb, text[]) from public, anon, authenticated;
grant execute on function atlas_private.reports_parse_pack_measure(text) to service_role;
grant execute on function atlas_private.reports_safe_numeric(jsonb) to service_role;
grant execute on function atlas_private.reports_scrub_numeric_fields(jsonb, text[]) to service_role;

-- Live definition with the inventory_norm pack-size block replaced.
CREATE OR REPLACE FUNCTION atlas_private.reports_snapshot_v2(p_inventory jsonb, p_recipes jsonb, p_recipe_ingredients jsonb, p_suppliers jsonb, p_movements jsonb, p_profiles jsonb, p_tasks jsonb, p_progress jsonb, p_actor_id uuid, p_actor_role text, p_period_start date, p_period_end date, p_comparison_start date, p_comparison_end date, p_comparison_key text DEFAULT 'previous_period'::text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  period_start date := coalesce(p_period_start,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
  period_end date := coalesce(p_period_end,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
  start_inclusive timestamptz;
  end_exclusive timestamptz;
  comparison_start_inclusive timestamptz;
  comparison_end_exclusive timestamptz;
  generated_at_value timestamptz := pg_catalog.now();
  category_filter text := nullif(trim(coalesce(p_filters->>'category','')),'');
  supplier_filter text := nullif(trim(coalesce(p_filters->>'supplier','')),'');
  status_filter text := nullif(trim(coalesce(p_filters->>'status','')),'');
  employee_filter text := nullif(trim(coalesce(p_filters->>'employee','')),'');
  search_filter text := nullif(trim(coalesce(p_filters->>'search','')),'');

  inv_active integer := 0;
  inv_value numeric := 0;
  inv_below_par integer := 0;
  inv_out_stock integer := 0;
  inv_missing_cost integer := 0;
  inv_missing_supplier integer := 0;
  inv_missing_par integer := 0;
  inv_recently_updated integer := 0;
  inv_rows jsonb := '[]'::jsonb;
  inv_categories jsonb := '[]'::jsonb;

  recipe_active integer := 0;
  recipe_showing integer := 0;
  recipe_incomplete integer := 0;
  recipe_unavailable integer := 0;
  recipe_attention integer := 0;
  recipe_ready integer := 0;
  recipe_rows jsonb := '[]'::jsonb;

  supplier_total integer := 0;
  purchase_movements integer := 0;
  purchase_spend numeric := 0;
  purchase_rows jsonb := '[]'::jsonb;
  supplier_rows jsonb := '[]'::jsonb;
  price_rows jsonb := '[]'::jsonb;
  compare_purchase_movements integer := 0;
  compare_purchase_spend numeric := 0;

  waste_count integer := 0;
  waste_value numeric := 0;
  waste_rows jsonb := '[]'::jsonb;
  compare_waste_count integer := 0;
  compare_waste_value numeric := 0;

  shift_count integer := 0;
  shift_hours numeric := 0;
  shift_unpublished integer := 0;
  shift_rows jsonb := '[]'::jsonb;
  compare_shift_count integer := 0;
  compare_shift_hours numeric := 0;

  routine_count integer := 0;
  routine_completed integer := 0;
  routine_overdue integer := 0;
  routine_percent numeric := null;
  routine_rows jsonb := '[]'::jsonb;
  compare_routine_count integer := 0;
  compare_routine_completed integer := 0;
  compare_routine_percent numeric := null;
  temp_points integer := 0;
  temp_logs integer := 0;
  temp_out_of_range integer := 0;
  compare_temp_logs integer := 0;
  compare_temp_out_of_range integer := 0;

  knowledge_required integer := 0;
  knowledge_published integer := 0;
  knowledge_acknowledged integer := 0;
  knowledge_due integer := 0;
  training_required integer := 0;
  training_completed integer := 0;
  training_team jsonb := '[]'::jsonb;

  brain_open integer := 0;
  marketing_due integer := 0;

  sections jsonb := '[]'::jsonb;
  kpis jsonb := '[]'::jsonb;
  attention jsonb := '[]'::jsonb;
  sources jsonb := '[]'::jsonb;
  reports jsonb := '{}'::jsonb;
  filter_options jsonb := '{}'::jsonb;
begin
  if period_end < period_start then raise exception 'Report period end cannot be before period start'; end if;
  if period_end-period_start > 1095 then raise exception 'Report range cannot exceed three years'; end if;

  start_inclusive := period_start::timestamp at time zone 'Atlantic/Reykjavik';
  end_exclusive := (period_end+1)::timestamp at time zone 'Atlantic/Reykjavik';
  comparison_start_inclusive := case when p_comparison_start is null then null else p_comparison_start::timestamp at time zone 'Atlantic/Reykjavik' end;
  comparison_end_exclusive := case when p_comparison_end is null then null else (p_comparison_end+1)::timestamp at time zone 'Atlantic/Reykjavik' end;

  with raw_inventory as (
    select *
    from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,
      updated_at timestamptz,supplier_id uuid,supplier text,cost_price numeric,sku text,
      barcode text,bin_location text,size_ml numeric,active boolean,sell_price numeric,
      package_size text,brand text,subcategory text,needs_review boolean
    )
  ),
  classified as (
    select item.*,
      case
        when coalesce(quantity,0)<=0 then 'out_of_stock'
        when par_level is not null and par_level>0 and quantity<par_level then 'below_par'
        when cost_price is null or cost_price<=0 then 'missing_cost'
        when coalesce(nullif(trim(supplier),''),supplier_id::text) is null then 'missing_supplier'
        when par_level is null or par_level<=0 then 'missing_par'
        else 'ok'
      end as report_status
    from raw_inventory item
    where coalesce(active,true)=true
  ),
  filtered as (
    select * from classified item
    where (category_filter is null or lower(coalesce(item.category,''))=lower(category_filter))
      and (supplier_filter is null or lower(coalesce(item.supplier,''))=lower(supplier_filter))
      and (status_filter is null or item.report_status=status_filter)
      and (search_filter is null or concat_ws(' ',item.name,item.category,item.brand,item.subcategory,item.supplier,item.sku,item.barcode,item.bin_location) ilike '%'||search_filter||'%')
  )
  select
    count(*)::integer,
    coalesce(sum(case when quantity is not null and quantity>0 and cost_price is not null and cost_price>0 then quantity*cost_price else 0 end),0),
    count(*) filter (where report_status='below_par')::integer,
    count(*) filter (where report_status='out_of_stock')::integer,
    count(*) filter (where cost_price is null or cost_price<=0)::integer,
    count(*) filter (where coalesce(nullif(trim(supplier),''),supplier_id::text) is null)::integer,
    count(*) filter (where par_level is null or par_level<=0)::integer,
    count(*) filter (where updated_at>=generated_at_value-interval '7 days')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'name',name,'category',category,'brand',brand,'subcategory',subcategory,
      'quantity',quantity,'unit',unit,'par_level',par_level,'supplier',coalesce(supplier,'Unassigned'),
      'cost_price',cost_price,'estimated_value',case when cost_price>0 then greatest(quantity,0)*cost_price else null end,
      'status',report_status,'bin_location',bin_location,'needs_review',coalesce(needs_review,false),'updated_at',updated_at
    ) order by case report_status when 'out_of_stock' then 0 when 'below_par' then 1 when 'missing_cost' then 2 when 'missing_supplier' then 3 when 'missing_par' then 4 else 5 end,name),'[]'::jsonb)
  into inv_active,inv_value,inv_below_par,inv_out_stock,inv_missing_cost,inv_missing_supplier,inv_missing_par,inv_recently_updated,inv_rows
  from filtered;

  with raw_inventory as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,
      updated_at timestamptz,supplier_id uuid,supplier text,cost_price numeric,sku text,
      barcode text,bin_location text,size_ml numeric,active boolean,sell_price numeric,
      package_size text,brand text,subcategory text,needs_review boolean
    )
    where coalesce(active,true)=true
  )
  select coalesce(jsonb_agg(jsonb_build_object('category',category,'item_count',item_count,'estimated_value',estimated_value) order by estimated_value desc,category),'[]'::jsonb)
  into inv_categories
  from (
    select coalesce(nullif(trim(category),''),'Uncategorised') as category,
      count(*)::integer as item_count,
      coalesce(sum(case when cost_price>0 and quantity>0 then quantity*cost_price else 0 end),0) as estimated_value
    from raw_inventory
    group by coalesce(nullif(trim(category),''),'Uncategorised')
  ) category_rows;

  with inventory_raw as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,
      updated_at timestamptz,supplier_id uuid,supplier text,cost_price numeric,sku text,
      barcode text,bin_location text,size_ml numeric,active boolean,sell_price numeric,
      package_size text,brand text,subcategory text,needs_review boolean
    )
    where coalesce(active,true)=true
  ),
  inventory_norm as (
    -- S86.1: package text is parsed by a guarded helper. Only a complete
    -- "<number> <unit>" measurement becomes a pack size; free text, multi-pack
    -- descriptions and ambiguous separators fall back to a counted unit.
    select item.*,
      lower(coalesce(package_size,unit,'')) as pack_text,
      case
        when size_ml is not null and size_ml>0 then size_ml
        when measure.measure_quantity is not null then measure.measure_quantity
        else 1
      end as pack_quantity,
      case
        when size_ml is not null and size_ml>0 then 'ml'
        when measure.measure_quantity is not null then measure.measure_unit
        else 'each'
      end as pack_unit
    from inventory_raw item
    cross join lateral atlas_private.reports_parse_pack_measure(coalesce(item.package_size,item.unit,'')) as measure
  ),
  recipe_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_recipes,'[]'::jsonb)) as recipe(
      id uuid,name text,type text,yield_quantity numeric,yield_unit text,menu_price numeric,
      show_on_menu boolean,updated_at timestamptz,active boolean,category_id uuid,
      happy_hour_price numeric,glass_price numeric,bottle_price numeric
    )
    where coalesce(active,true)=true
  ),
  ingredient_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_recipe_ingredients,'[]'::jsonb)) as ingredient(
      id uuid,recipe_id uuid,item_id uuid,item_name text,quantity numeric,unit text
    )
  ),
  ingredient_calc as (
    select ingredient.*,
      item.name as linked_item_name,item.quantity as item_stock,item.par_level,item.cost_price,item.pack_quantity,item.pack_unit,
      case lower(coalesce(ingredient.unit,''))
        when 'l' then ingredient.quantity*1000 when 'lt' then ingredient.quantity*1000
        when 'liter' then ingredient.quantity*1000 when 'litre' then ingredient.quantity*1000
        when 'kg' then ingredient.quantity*1000 else ingredient.quantity
      end as ingredient_base_quantity,
      case lower(coalesce(ingredient.unit,''))
        when 'l' then 'ml' when 'lt' then 'ml' when 'liter' then 'ml' when 'litre' then 'ml'
        when 'ml' then 'ml' when 'kg' then 'g' when 'g' then 'g' else 'each'
      end as ingredient_base_unit
    from ingredient_input ingredient
    left join inventory_norm item on item.id=ingredient.item_id
  ),
  recipe_calc as (
    select recipe.id,recipe.name,recipe.type,recipe.show_on_menu,recipe.menu_price,recipe.happy_hour_price,
      recipe.glass_price,recipe.bottle_price,recipe.updated_at,greatest(coalesce(recipe.yield_quantity,1),0.0001) as yield_quantity,
      count(ingredient.id)::integer as ingredient_count,
      count(ingredient.id) filter (where ingredient.item_id is null or ingredient.linked_item_name is null)::integer as missing_links,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and (ingredient.cost_price is null or ingredient.cost_price<=0))::integer as missing_costs,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and ingredient.item_stock<=0)::integer as out_items,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and ingredient.par_level>0 and ingredient.item_stock<ingredient.par_level)::integer as below_par_items,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and ingredient.pack_unit<>ingredient.ingredient_base_unit)::integer as incompatible_units,
      sum(case when ingredient.cost_price>0 and ingredient.pack_quantity>0 and ingredient.pack_unit=ingredient.ingredient_base_unit
        then ingredient.cost_price*(ingredient.ingredient_base_quantity/ingredient.pack_quantity) else 0 end) as batch_cost,
      min(case when ingredient.item_stock is not null and ingredient.pack_quantity>0 and ingredient.ingredient_base_quantity>0 and ingredient.pack_unit=ingredient.ingredient_base_unit
        then floor((ingredient.item_stock*ingredient.pack_quantity/ingredient.ingredient_base_quantity)*greatest(coalesce(recipe.yield_quantity,1),0.0001)) else null end) as servings_available,
      min(case when ingredient.item_stock is not null and ingredient.pack_quantity>0 and ingredient.ingredient_base_quantity>0 and ingredient.pack_unit=ingredient.ingredient_base_unit
        then (ingredient.item_stock*ingredient.pack_quantity/ingredient.ingredient_base_quantity) end) as limiting_ratio
    from recipe_input recipe
    left join ingredient_calc ingredient on ingredient.recipe_id=recipe.id
    group by recipe.id,recipe.name,recipe.type,recipe.show_on_menu,recipe.menu_price,recipe.happy_hour_price,recipe.glass_price,recipe.bottle_price,recipe.updated_at,recipe.yield_quantity
  ),
  classified as (
    select recipe.*,
      case
        when ingredient_count=0 or missing_links>0 or incompatible_units>0 then 'incomplete_setup'
        when out_items>0 or coalesce(servings_available,0)<=0 then 'unavailable'
        when missing_costs>0 or below_par_items>0 then 'needs_attention'
        else 'ready'
      end as availability_state,
      case when ingredient_count>0 and missing_costs=0 and missing_links=0 and incompatible_units=0 then batch_cost/yield_quantity else null end as estimated_cost_per_serving,
      case when menu_price>0 and ingredient_count>0 and missing_costs=0 and missing_links=0 and incompatible_units=0
        then menu_price-(batch_cost/yield_quantity) else null end as estimated_gross_profit,
      case when menu_price>0 and ingredient_count>0 and missing_costs=0 and missing_links=0 and incompatible_units=0
        then ((menu_price-(batch_cost/yield_quantity))/menu_price)*100 else null end as estimated_margin_percent
    from recipe_calc recipe
  ),
  filtered as (
    select * from classified recipe
    where (category_filter is null or lower(coalesce(recipe.type,''))=lower(category_filter))
      and (status_filter is null or recipe.availability_state=status_filter)
      and (search_filter is null or concat_ws(' ',recipe.name,recipe.type) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    count(*) filter (where show_on_menu=true)::integer,
    count(*) filter (where availability_state='incomplete_setup')::integer,
    count(*) filter (where availability_state='unavailable')::integer,
    count(*) filter (where availability_state='needs_attention')::integer,
    count(*) filter (where availability_state='ready')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'name',name,'type',type,'show_on_menu',show_on_menu,'menu_price',menu_price,
      'happy_hour_price',happy_hour_price,'glass_price',glass_price,'bottle_price',bottle_price,
      'availability_state',availability_state,'ingredient_count',ingredient_count,'missing_links',missing_links,
      'missing_costs',missing_costs,'incompatible_units',incompatible_units,'below_par_items',below_par_items,
      'out_items',out_items,'estimated_cost_per_serving',estimated_cost_per_serving,
      'estimated_gross_profit',estimated_gross_profit,'estimated_margin_percent',estimated_margin_percent,
      'estimated_servings_available',servings_available,'updated_at',updated_at
    ) order by case availability_state when 'unavailable' then 0 when 'incomplete_setup' then 1 when 'needs_attention' then 2 else 3 end,name),'[]'::jsonb)
  into recipe_active,recipe_showing,recipe_incomplete,recipe_unavailable,recipe_attention,recipe_ready,recipe_rows
  from filtered;

  with suppliers_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_suppliers,'[]'::jsonb)) as supplier(
      id uuid,name text,contact_name text,email text,phone text,notes text,active boolean,created_at timestamptz,updated_at timestamptz
    )
  )
  select count(*)::integer into supplier_total from suppliers_input where coalesce(active,true)=true;

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  supplier_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_suppliers,'[]'::jsonb)) as supplier(
      id uuid,name text,contact_name text,email text,phone text,notes text,active boolean,created_at timestamptz,updated_at timestamptz
    )
  ),
  period_rows as (
    select movement.*,supplier.name as supplier_name
    from movement_input movement
    left join supplier_input supplier on supplier.id=movement.supplier_id
    where movement.created_at>=start_inclusive and movement.created_at<end_exclusive
      and (supplier_filter is null or lower(coalesce(supplier.name,''))=lower(supplier_filter))
      and (search_filter is null or concat_ws(' ',movement.item_name,movement.movement_type,movement.note,supplier.name) ilike '%'||search_filter||'%')
  )
  select count(*) filter (where coalesce(total_cost,0)>0)::integer,
    coalesce(sum(greatest(coalesce(total_cost,0),0)),0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'item_id',item_id,'item_name',item_name,'movement_type',movement_type,
      'quantity_change',quantity_change,'unit_cost',unit_cost,'total_cost',total_cost,
      'supplier',coalesce(supplier_name,'Unassigned'),'created_at',created_at,'note',note
    ) order by created_at desc),'[]'::jsonb)
  into purchase_movements,purchase_spend,purchase_rows
  from period_rows;

  if comparison_start_inclusive is not null and comparison_end_exclusive is not null then
    with movement_input as (
      select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
        id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
        supplier_id uuid,note text,created_by uuid,created_at timestamptz
      )
    )
    select count(*) filter (where coalesce(total_cost,0)>0)::integer,
      coalesce(sum(greatest(coalesce(total_cost,0),0)),0)
    into compare_purchase_movements,compare_purchase_spend
    from movement_input
    where created_at>=comparison_start_inclusive and created_at<comparison_end_exclusive;
  end if;

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  supplier_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_suppliers,'[]'::jsonb)) as supplier(
      id uuid,name text,contact_name text,email text,phone text,notes text,active boolean,created_at timestamptz,updated_at timestamptz
    )
  ),
  inventory_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,updated_at timestamptz,
      supplier_id uuid,supplier text,cost_price numeric,sku text,barcode text,bin_location text,size_ml numeric,
      active boolean,sell_price numeric,package_size text,brand text,subcategory text,needs_review boolean
    )
  ),
  supplier_names as (
    select supplier.id,supplier.name from supplier_input supplier
    union all
    select distinct item.supplier_id,item.supplier from inventory_input item where item.supplier_id is not null and item.supplier is not null
  ),
  grouped as (
    select coalesce(name,'Unassigned') as supplier_name,
      count(movement.id) filter (where movement.created_at>=start_inclusive and movement.created_at<end_exclusive)::integer as movement_count,
      coalesce(sum(greatest(coalesce(movement.total_cost,0),0)) filter (where movement.created_at>=start_inclusive and movement.created_at<end_exclusive),0) as spend,
      max(movement.created_at) as last_movement_at,
      (select count(*)::integer from inventory_input item where item.active=true and (item.supplier_id=supplier_names.id or lower(coalesce(item.supplier,''))=lower(coalesce(supplier_names.name,'')))) as active_item_count
    from supplier_names
    left join movement_input movement on movement.supplier_id=supplier_names.id
    group by supplier_names.id,supplier_names.name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplier',supplier_name,'movement_count',movement_count,'spend',spend,
    'active_item_count',active_item_count,'last_movement_at',last_movement_at
  ) order by spend desc,active_item_count desc,supplier_name),'[]'::jsonb)
  into supplier_rows
  from grouped
  where (supplier_filter is null or lower(supplier_name)=lower(supplier_filter))
    and (search_filter is null or supplier_name ilike '%'||search_filter||'%');

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  ranked as (
    select movement.*,
      lag(unit_cost) over (partition by item_id order by created_at) as previous_unit_cost
    from movement_input movement
    where unit_cost is not null and unit_cost>0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_id',item_id,'item_name',item_name,'current_unit_cost',unit_cost,'previous_unit_cost',previous_unit_cost,
    'absolute_change',case when previous_unit_cost is null then null else unit_cost-previous_unit_cost end,
    'percentage_change',case when previous_unit_cost>0 then ((unit_cost-previous_unit_cost)/previous_unit_cost)*100 else null end,
    'effective_at',created_at
  ) order by abs(coalesce(unit_cost-previous_unit_cost,0)) desc,created_at desc),'[]'::jsonb)
  into price_rows
  from ranked
  where created_at>=start_inclusive and created_at<end_exclusive
    and previous_unit_cost is not null;

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  period_waste as (
    select * from movement_input movement
    where created_at>=start_inclusive and created_at<end_exclusive
      and lower(movement_type) in ('waste','variance','spoilage','breakage','loss')
      and (search_filter is null or concat_ws(' ',item_name,movement_type,note) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    coalesce(sum(coalesce(abs(total_cost),abs(quantity_change)*coalesce(unit_cost,0))),0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'item_id',item_id,'item_name',item_name,'movement_type',movement_type,
      'quantity_change',quantity_change,'estimated_value',coalesce(abs(total_cost),abs(quantity_change)*coalesce(unit_cost,0)),
      'created_at',created_at,'note',note
    ) order by created_at desc),'[]'::jsonb)
  into waste_count,waste_value,waste_rows
  from period_waste;

  if comparison_start_inclusive is not null and comparison_end_exclusive is not null then
    with movement_input as (
      select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
        id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
        supplier_id uuid,note text,created_by uuid,created_at timestamptz
      )
    )
    select count(*)::integer,
      coalesce(sum(coalesce(abs(total_cost),abs(quantity_change)*coalesce(unit_cost,0))),0)
    into compare_waste_count,compare_waste_value
    from movement_input
    where created_at>=comparison_start_inclusive and created_at<comparison_end_exclusive
      and lower(movement_type) in ('waste','variance','spoilage','breakage','loss');
  end if;

  with shifts as (
    select entry.*,person.display_name,person.profile_id
    from atlas_private.shift_entries entry
    join atlas_private.shift_people person on person.id=entry.person_id
    where entry.active=true and entry.starts_at>=start_inclusive and entry.starts_at<end_exclusive
      and (is_manager or person.profile_id=p_actor_id)
      and (employee_filter is null or person.id::text=employee_filter or person.profile_id::text=employee_filter or lower(person.display_name)=lower(employee_filter))
      and (status_filter is null or (status_filter='published' and entry.last_published_revision is not null) or (status_filter='draft' and entry.last_published_revision is null))
      and (search_filter is null or concat_ws(' ',person.display_name,entry.role_name,entry.note) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    coalesce(sum(greatest(0,extract(epoch from (ends_at-starts_at))/3600-(break_minutes::numeric/60))),0),
    count(*) filter (where last_published_revision is null)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'person_id',person_id,'profile_id',profile_id,
      'person_label',case when is_manager then display_name else 'Your shift' end,
      'role_name',role_name,'starts_at',starts_at,'ends_at',ends_at,'break_minutes',break_minutes,
      'planned_hours',greatest(0,extract(epoch from (ends_at-starts_at))/3600-(break_minutes::numeric/60)),
      'published',last_published_revision is not null,'note',case when is_manager then note else null end
    ) order by starts_at),'[]'::jsonb)
  into shift_count,shift_hours,shift_unpublished,shift_rows
  from shifts;

  if comparison_start_inclusive is not null and comparison_end_exclusive is not null then
    with shifts as (
      select entry.* from atlas_private.shift_entries entry
      join atlas_private.shift_people person on person.id=entry.person_id
      where entry.active=true and entry.starts_at>=comparison_start_inclusive and entry.starts_at<comparison_end_exclusive
        and (is_manager or person.profile_id=p_actor_id)
    )
    select count(*)::integer,
      coalesce(sum(greatest(0,extract(epoch from (ends_at-starts_at))/3600-(break_minutes::numeric/60))),0)
    into compare_shift_count,compare_shift_hours
    from shifts;
  end if;

  with routines as (
    select instance.*,template.name as template_name,template.routine_type,template.requires_manager_signoff
    from atlas_private.routine_instances instance
    join atlas_private.routine_templates template on template.id=instance.template_id
    where instance.scheduled_date between period_start and period_end
      and (status_filter is null or instance.status=status_filter)
      and (search_filter is null or concat_ws(' ',template.name,template.routine_type,instance.status,instance.assigned_to_label) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    count(*) filter (where status='completed' or completed_at is not null)::integer,
    count(*) filter (where status='overdue')::integer,
    case when count(*)=0 then null else round((count(*) filter (where status='completed' or completed_at is not null))::numeric/count(*)::numeric*100,1) end,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'template_name',template_name,'routine_type',routine_type,'scheduled_date',scheduled_date,
      'status',status,'assigned_to_label',assigned_to_label,'completed_at',completed_at,
      'completed_by_label',case when is_manager then completed_by_label else null end,
      'requires_manager_signoff',requires_manager_signoff,'manager_signed_off_at',manager_signed_off_at
    ) order by scheduled_date desc,template_name),'[]'::jsonb)
  into routine_count,routine_completed,routine_overdue,routine_percent,routine_rows
  from routines;

  if p_comparison_start is not null and p_comparison_end is not null then
    with routines as (
      select instance.* from atlas_private.routine_instances instance
      where instance.scheduled_date between p_comparison_start and p_comparison_end
    )
    select count(*)::integer,
      count(*) filter (where status='completed' or completed_at is not null)::integer,
      case when count(*)=0 then null else round((count(*) filter (where status='completed' or completed_at is not null))::numeric/count(*)::numeric*100,1) end
    into compare_routine_count,compare_routine_completed,compare_routine_percent
    from routines;
  end if;

  select count(*)::integer into temp_points from atlas_private.temperature_points where active=true;
  select count(*)::integer,count(*) filter (where range_status<>'in_range')::integer
  into temp_logs,temp_out_of_range
  from atlas_private.temperature_logs where reading_date between period_start and period_end;

  if p_comparison_start is not null and p_comparison_end is not null then
    select count(*)::integer,count(*) filter (where range_status<>'in_range')::integer
    into compare_temp_logs,compare_temp_out_of_range
    from atlas_private.temperature_logs where reading_date between p_comparison_start and p_comparison_end;
  end if;

  select count(*)::integer,count(*) filter (where required=true)::integer
  into knowledge_published,knowledge_required
  from atlas_private.knowledge_articles article
  where status='published' and (is_manager or 'all'=any(target_roles) or p_actor_role=any(target_roles));

  select count(*)::integer into knowledge_acknowledged
  from atlas_private.knowledge_acknowledgements acknowledgement
  join atlas_private.knowledge_articles article on article.id=acknowledgement.article_id
  where article.status='published' and (is_manager or acknowledgement.user_id=p_actor_id);

  select count(*)::integer into knowledge_due
  from atlas_private.knowledge_articles article
  join atlas_private.knowledge_article_versions version on version.id=article.current_version_id
  where article.status='published' and article.required=true
    and (is_manager or 'all'=any(article.target_roles) or p_actor_role=any(article.target_roles))
    and not exists (
      select 1 from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.article_id=article.id and acknowledgement.version_id=version.id and acknowledgement.user_id=p_actor_id
    );

  with tasks_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_tasks,'[]'::jsonb)) as task(
      id uuid,title text,description text,category text,sort_order integer,required boolean,active boolean
    )
  ),
  progress_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_progress,'[]'::jsonb)) as progress(
      id uuid,task_id uuid,user_id uuid,completed_at timestamptz,completed_by uuid,note text
    )
  ),
  profiles_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,email text,display_name text,role text,active boolean
    )
  )
  select
    (select count(*)::integer from tasks_input where active=true and required=true),
    (select count(*)::integer from tasks_input task where task.active=true and task.required=true and exists (
      select 1 from progress_input progress where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
    )),
    case when is_manager then coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id',profile.id,'name',coalesce(nullif(trim(profile.display_name),''),nullif(split_part(coalesce(profile.email,''),'@',1),''),'Team member'),
        'role',profile.role,'required_total',(select count(*)::integer from tasks_input where active=true and required=true),
        'required_completed',(select count(*)::integer from tasks_input task where task.active=true and task.required=true and exists (
          select 1 from progress_input progress where progress.task_id=task.id and progress.user_id=profile.id and progress.completed_at is not null
        ))
      ) order by coalesce(profile.display_name,profile.email)) from profiles_input profile where profile.active=true
    ),'[]'::jsonb) else '[]'::jsonb end
  into training_required,training_completed,training_team;

  select count(*)::integer into brain_open from atlas_private.brain_recommendations
  where status in ('active','new','open') and generated_at>=start_inclusive and generated_at<end_exclusive;

  select count(*)::integer into marketing_due from atlas_private.marketing_content_items
  where status not in ('published','completed','cancelled','archived')
    and coalesce(scheduled_for,reminder_at,event_starts_at)>=start_inclusive
    and coalesce(scheduled_for,reminder_at,event_starts_at)<end_exclusive;

  kpis := jsonb_build_array(
    jsonb_build_object('key','inventory_value','label','Estimated inventory value','value',case when inv_active=0 then null else inv_value end,'unit','ISK','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when inv_active=0 then 'unavailable' when inv_missing_cost>0 then 'partial' else 'complete' end,'detail','Active quantity × current item cost. Missing costs are excluded.','section','inventory'),
    jsonb_build_object('key','stock_alerts','label','Stock alerts','value',case when inv_active=0 then null else inv_below_par+inv_out_stock end,'unit','count','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when inv_active=0 then 'unavailable' else 'complete' end,'detail','Out-of-stock and below-par active items.','section','inventory'),
    jsonb_build_object('key','recipes_attention','label','Recipes needing attention','value',case when recipe_active=0 then null else recipe_unavailable+recipe_incomplete+recipe_attention end,'unit','count','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when recipe_active=0 then 'unavailable' else 'partial' end,'detail','Unavailable, incomplete, missing-cost or below-par ingredient recipes.','section','recipes'),
    jsonb_build_object('key','purchasing_spend','label','Purchasing spend','value',purchase_spend,'unit','ISK','comparison_value',case when comparison_start_inclusive is null then null else compare_purchase_spend end,'change_value',case when comparison_start_inclusive is null then null else purchase_spend-compare_purchase_spend end,'change_percent',case when comparison_start_inclusive is null or compare_purchase_spend=0 then null else ((purchase_spend-compare_purchase_spend)/compare_purchase_spend)*100 end,'trend',case when comparison_start_inclusive is null then 'none' when purchase_spend>compare_purchase_spend then 'up' when purchase_spend<compare_purchase_spend then 'down' else 'flat' end,'status',case when purchase_movements=0 then 'no_data_for_period' else 'complete' end,'detail','Costed inventory movement totals; not a purchase-order ledger.','section','purchasing'),
    jsonb_build_object('key','scheduled_hours','label',case when is_manager then 'Scheduled labour hours' else 'Your scheduled hours' end,'value',round(shift_hours,2),'unit','hours','comparison_value',case when comparison_start_inclusive is null then null else round(compare_shift_hours,2) end,'change_value',case when comparison_start_inclusive is null then null else round(shift_hours-compare_shift_hours,2) end,'change_percent',case when comparison_start_inclusive is null or compare_shift_hours=0 then null else ((shift_hours-compare_shift_hours)/compare_shift_hours)*100 end,'trend',case when comparison_start_inclusive is null then 'none' when shift_hours>compare_shift_hours then 'up' when shift_hours<compare_shift_hours then 'down' else 'flat' end,'status',case when shift_count=0 then 'no_data_for_period' else 'complete' end,'detail',case when is_manager then 'Active scheduled shift entries.' else 'Only shifts linked to your profile.' end,'section','labour'),
    jsonb_build_object('key','checklist_completion','label','Checklist completion','value',routine_percent,'unit','percent','comparison_value',compare_routine_percent,'change_value',case when routine_percent is null or compare_routine_percent is null then null else routine_percent-compare_routine_percent end,'change_percent',null,'trend',case when routine_percent is null or compare_routine_percent is null then 'none' when routine_percent>compare_routine_percent then 'up' when routine_percent<compare_routine_percent then 'down' else 'flat' end,'status',case when routine_count=0 then 'no_data_for_period' else 'complete' end,'detail','Completed routines ÷ scheduled routines.','section','operations'),
    jsonb_build_object('key','required_reading_due','label','Required reading due','value',knowledge_due,'unit','count','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when knowledge_required=0 then 'no_data_for_period' else 'complete' end,'detail','Current published versions requiring your acknowledgement.','section','knowledge')
  );

  sections := jsonb_build_array(
    jsonb_build_object('key','overview','name','Overview','status','connected','description','Operational overview across connected Atlas modules.'),
    jsonb_build_object('key','sales','name','Sales','status','not_connected','description','Sales integration is not available. No revenue or order values are invented.'),
    jsonb_build_object('key','inventory','name','Inventory','status',case when inv_active=0 then 'no_records' when inv_missing_cost>0 or inv_missing_par>0 then 'partial' else 'connected' end,'description','Live inventory quantities, par levels and valuation readiness.'),
    jsonb_build_object('key','recipes','name','Menu & Recipes','status',case when recipe_active=0 then 'no_records' when recipe_incomplete>0 or recipe_attention>0 then 'partial' else 'connected' end,'description','Recipe availability, costing and setup quality.'),
    jsonb_build_object('key','purchasing','name','Purchasing','status',case when purchase_movements=0 then 'no_records' else 'partial' end,'description','Costed inventory movement spend; purchase orders are not connected.'),
    jsonb_build_object('key','suppliers','name','Suppliers','status',case when supplier_total=0 then 'no_records' else 'connected' end,'description','Supplier profiles, linked inventory, spend and price movements.'),
    jsonb_build_object('key','waste','name','Waste & Variance','status',case when waste_count=0 then 'no_records' else 'connected' end,'description','Only explicitly recorded waste and variance movements.'),
    jsonb_build_object('key','labour','name','Labour & Shifts','status',case when shift_count=0 then 'no_records' else 'connected' end,'description',case when is_manager then 'Scheduled hours and shift coverage.' else 'Your scheduled shift information only.' end),
    jsonb_build_object('key','operations','name','Operations','status',case when routine_count=0 and temp_logs=0 then 'no_records' else 'connected' end,'description','Routines, checklist completion and temperature evidence.'),
    jsonb_build_object('key','knowledge','name','Knowledge & Training','status',case when knowledge_published=0 and training_required=0 then 'no_records' else 'connected' end,'description','Required reading and onboarding progress.'),
    jsonb_build_object('key','saved','name','Saved Reports','status','not_connected','description','Saved report persistence is not enabled yet.'),
    jsonb_build_object('key','exports','name','Exports','status','connected','description','CSV, print view and copy summary for visible rows.')
  );

  select coalesce(jsonb_agg(item),'[]'::jsonb) into attention
  from (values
    (case when inv_out_stock>0 then jsonb_build_object('key','inventory-out-stock','tone','danger','title',inv_out_stock::text||' items are out of stock','detail','Review quantity, par and supplier assignment.','section','inventory','source','Inventory') end),
    (case when inv_below_par>0 then jsonb_build_object('key','inventory-below-par','tone','warn','title',inv_below_par::text||' items are below par','detail','Below-par stock may create service and purchasing risk.','section','inventory','source','Inventory') end),
    (case when inv_missing_cost>0 then jsonb_build_object('key','inventory-missing-cost','tone','warn','title',inv_missing_cost::text||' inventory items are missing costs','detail','Those items are excluded from valuation.','section','inventory','source','Inventory') end),
    (case when recipe_unavailable>0 then jsonb_build_object('key','recipes-unavailable','tone','danger','title',recipe_unavailable::text||' recipes appear unavailable','detail','Linked ingredients currently have no available stock.','section','recipes','source','Recipes') end),
    (case when recipe_incomplete>0 then jsonb_build_object('key','recipes-incomplete','tone','warn','title',recipe_incomplete::text||' recipes need setup completion','detail','Missing links or incompatible units prevent full analysis.','section','recipes','source','Recipes') end),
    (case when routine_overdue>0 then jsonb_build_object('key','operations-overdue','tone','danger','title',routine_overdue::text||' operational routines are overdue','detail','Reports is read-only; complete work in Operations.','section','operations','source','Operations') end),
    (case when temp_points>0 and temp_logs=0 then jsonb_build_object('key','temperature-missing','tone','warn','title','No temperature logs recorded in this period','detail','Daily temperature records are required for safety evidence.','section','operations','source','Operations') end),
    (case when shift_unpublished>0 and is_manager then jsonb_build_object('key','shifts-unpublished','tone','warn','title',shift_unpublished::text||' shift entries are not published','detail','Staff see only published schedule revisions.','section','labour','source','Shifts') end),
    (case when knowledge_due>0 then jsonb_build_object('key','knowledge-due','tone','warn','title',knowledge_due::text||' Knowledge acknowledgements are due','detail','Acknowledgements are version-specific.','section','knowledge','source','Knowledge') end),
    (case when brain_open>0 and is_manager then jsonb_build_object('key','brain-open','tone','neutral','title',brain_open::text||' Atlas Brain recommendations are open','detail','Review their evidence and confidence in Atlas Brain.','section','overview','source','Atlas Brain') end),
    (case when marketing_due>0 and is_manager then jsonb_build_object('key','marketing-due','tone','neutral','title',marketing_due::text||' marketing items are due in this period','detail','Review content planning and approvals in Marketing.','section','overview','source','Marketing') end)
  ) as attention_items(item) where item is not null;

  sources := jsonb_build_array(
    jsonb_build_object('key','sales','name','Sales integration','status','not_connected','last_refreshed_at',null,'records_included',0,'records_excluded',0,'note','Sales integration is unavailable. Revenue and order values are not invented.'),
    jsonb_build_object('key','inventory','name','Inventory','status',case when jsonb_array_length(coalesce(p_inventory,'[]'::jsonb))=0 then 'no_records' when inv_missing_cost>0 then 'partial' else 'connected' end,'last_refreshed_at',(select max((item->>'updated_at')::timestamptz) from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item),'records_included',jsonb_array_length(coalesce(p_inventory,'[]'::jsonb)),'records_excluded',inv_missing_cost,'note','Valuation excludes records missing current cost.'),
    jsonb_build_object('key','recipes','name','Recipes','status',case when jsonb_array_length(coalesce(p_recipes,'[]'::jsonb))=0 then 'no_records' when recipe_incomplete>0 then 'partial' else 'connected' end,'last_refreshed_at',(select max((item->>'updated_at')::timestamptz) from jsonb_array_elements(coalesce(p_recipes,'[]'::jsonb)) item),'records_included',jsonb_array_length(coalesce(p_recipes,'[]'::jsonb)),'records_excluded',recipe_incomplete,'note','Availability uses linked ingredients and current stock.'),
    jsonb_build_object('key','purchasing','name','Purchasing / receiving','status',case when jsonb_array_length(coalesce(p_movements,'[]'::jsonb))=0 then 'no_records' else 'partial' end,'last_refreshed_at',(select max((item->>'created_at')::timestamptz) from jsonb_array_elements(coalesce(p_movements,'[]'::jsonb)) item),'records_included',purchase_movements,'records_excluded',0,'note','Purchase-order tables are not connected; spend is from costed inventory movements.'),
    jsonb_build_object('key','shifts','name','Shifts','status',case when shift_count=0 then 'no_records' else 'connected' end,'last_refreshed_at',(select max(updated_at) from atlas_private.shift_entries),'records_included',shift_count,'records_excluded',case when is_manager then 0 else (select count(*) from atlas_private.shift_entries entry join atlas_private.shift_people person on person.id=entry.person_id where entry.active=true and entry.starts_at>=start_inclusive and entry.starts_at<end_exclusive and person.profile_id is distinct from p_actor_id) end,'note',case when is_manager then 'Manager view includes visible schedule rows.' else 'Other employees are excluded by permission.' end),
    jsonb_build_object('key','operations','name','Operations','status',case when routine_count=0 and temp_logs=0 then 'no_records' else 'connected' end,'last_refreshed_at',greatest(coalesce((select max(updated_at) from atlas_private.routine_instances),'1970-01-01'::timestamptz),coalesce((select max(created_at) from atlas_private.temperature_logs),'1970-01-01'::timestamptz)),'records_included',routine_count+temp_logs,'records_excluded',0,'note','Reports cannot complete checklist steps.'),
    jsonb_build_object('key','knowledge','name','Knowledge & Training','status',case when knowledge_published=0 and training_required=0 then 'no_records' else 'connected' end,'last_refreshed_at',(select max(updated_at) from atlas_private.knowledge_articles),'records_included',knowledge_published+training_required,'records_excluded',0,'note','Employee detail remains permission-controlled.')
  );

  reports := jsonb_build_object(
    'overview',jsonb_build_object('summary',jsonb_build_object(
      'business_performance','Sales integration is not connected, so Reports avoids revenue, order and product-sales claims.',
      'service_readiness',case when routine_count=0 then 'No operational routines in this period.' else routine_completed::text||' of '||routine_count::text||' routines completed.' end,
      'stock_risk',case when inv_active=0 then 'No active inventory records.' else (inv_below_par+inv_out_stock)::text||' inventory alerts.' end,
      'data_complete_enough',jsonb_array_length(coalesce(p_inventory,'[]'::jsonb))>0 or routine_count>0 or shift_count>0 or knowledge_published>0
    )),
    'sales',jsonb_build_object('status','not_connected','message','Sales integration is not available. No sample revenue, tax, discounts, refunds, payment methods or product-sales charts are displayed.'),
    'inventory',jsonb_build_object('summary',jsonb_build_object('active_items',inv_active,'estimated_value',inv_value,'below_par',inv_below_par,'out_of_stock',inv_out_stock,'missing_cost',inv_missing_cost,'missing_supplier',inv_missing_supplier,'missing_par',inv_missing_par,'recently_updated',inv_recently_updated),'formula','Estimated inventory value = sum of active item quantity × current item cost. Missing-cost items are excluded and counted separately.','rows',inv_rows,'categories',inv_categories),
    'recipes',jsonb_build_object('summary',jsonb_build_object('active_recipes',recipe_active,'shown_on_menu',recipe_showing,'ready',recipe_ready,'needs_attention',recipe_attention,'unavailable',recipe_unavailable,'incomplete_setup',recipe_incomplete),'formula','Recipe cost uses linked ingredient quantity ÷ package quantity × current item cost, divided by recipe yield. Availability uses current stock and compatible units.','rows',recipe_rows),
    'purchasing',jsonb_build_object('summary',jsonb_build_object('spend',purchase_spend,'movement_count',purchase_movements,'open_purchase_orders',null,'overdue_orders',null,'receiving_differences',null),'comparison',jsonb_build_object('spend',compare_purchase_spend,'movement_count',compare_purchase_movements),'formula','Purchasing spend is positive total_cost on inventory movement records. Purchase-order metrics remain unavailable.','rows',purchase_rows,'price_changes',price_rows),
    'suppliers',jsonb_build_object('summary',jsonb_build_object('active_suppliers',supplier_total,'supplier_rows',jsonb_array_length(supplier_rows)),'rows',supplier_rows,'permission_note',case when is_manager then 'Manager view includes costed movement spend.' else 'Confidential commercial terms are not loaded.' end),
    'waste',jsonb_build_object('summary',jsonb_build_object('recorded_waste_count',waste_count,'estimated_waste_value',waste_value),'comparison',jsonb_build_object('recorded_waste_count',compare_waste_count,'estimated_waste_value',compare_waste_value),'formula','Only movements explicitly labelled waste, variance, spoilage, breakage or loss are included. Reports does not infer waste from sales.','rows',waste_rows),
    'labour',jsonb_build_object('summary',jsonb_build_object('shift_count',shift_count,'scheduled_hours',round(shift_hours,2),'unpublished_shift_entries',case when is_manager then shift_unpublished else null end),'comparison',jsonb_build_object('shift_count',compare_shift_count,'scheduled_hours',round(compare_shift_hours,2)),'rows',shift_rows,'permission_note',case when is_manager then 'Employee-level schedule rows are manager-only.' else 'Only your shifts are loaded.' end),
    'operations',jsonb_build_object('summary',jsonb_build_object('routine_count',routine_count,'completed_routines',routine_completed,'overdue_routines',routine_overdue,'completion_percent',routine_percent,'temperature_points',temp_points,'temperature_logs',temp_logs,'temperature_out_of_range',temp_out_of_range),'comparison',jsonb_build_object('routine_count',compare_routine_count,'completed_routines',compare_routine_completed,'completion_percent',compare_routine_percent,'temperature_logs',compare_temp_logs,'temperature_out_of_range',compare_temp_out_of_range),'formula','Checklist completion = completed routine instances ÷ scheduled routine instances.','rows',routine_rows),
    'knowledge',jsonb_build_object('summary',jsonb_build_object('published_articles',knowledge_published,'required_articles',knowledge_required,'acknowledgements',knowledge_acknowledged,'required_due_for_current_user',knowledge_due,'training_required_total',training_required,'training_completed_for_current_user',training_completed),'team',training_team,'permission_note',case when is_manager then 'Managers can view team completion.' else 'Staff see only their own training state.' end),
    'saved',jsonb_build_object('status','not_connected','message','Saved Reports persistence is not enabled in this checkpoint.'),
    'exports',jsonb_build_object('status','connected','formats',jsonb_build_array('CSV','Print','Copy summary'),'message','Exports use visible rows and include period, filters, currency and data-quality notes.')
  );

  filter_options := jsonb_build_object(
    'categories',coalesce((select jsonb_agg(value order by value) from (select distinct nullif(trim(item->>'category'),'') as value from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item where nullif(trim(item->>'category'),'') is not null) valueset),'[]'::jsonb),
    'suppliers',coalesce((select jsonb_agg(value order by value) from (select distinct nullif(trim(item->>'name'),'') as value from jsonb_array_elements(coalesce(p_suppliers,'[]'::jsonb)) item where nullif(trim(item->>'name'),'') is not null) valueset),'[]'::jsonb),
    'employees',case when is_manager then coalesce((select jsonb_agg(jsonb_build_object('id',person.id,'name',person.display_name) order by person.display_name) from atlas_private.shift_people person where person.active=true),'[]'::jsonb) else '[]'::jsonb end,
    'statuses',jsonb_build_array('ok','below_par','out_of_stock','missing_cost','missing_supplier','missing_par','ready','needs_attention','unavailable','incomplete_setup','published','draft','completed','overdue')
  );

  return jsonb_build_object(
    'version','atlas-reports/0.2.0','generated_at',generated_at_value,'timezone','Atlantic/Reykjavik','currency','ISK',
    'period',jsonb_build_object('start',period_start,'end',period_end,'label',to_char(period_start,'DD Mon YYYY')||' – '||to_char(period_end,'DD Mon YYYY')),
    'comparison',jsonb_build_object('key',coalesce(p_comparison_key,'previous_period'),'start',p_comparison_start,'end',p_comparison_end,'enabled',p_comparison_start is not null and p_comparison_end is not null),
    'filters',coalesce(p_filters,'{}'::jsonb),'filter_options',filter_options,'sections',sections,'kpis',kpis,
    'attention',attention,'data_sources',sources,'reports',reports,
    'permissions',jsonb_build_object('can_view_manager_reports',is_manager,'can_view_employee_detail',is_manager,'can_export',true,'can_ask_atlas',true,'read_only',true),
    'trust',jsonb_build_object('reports_are_read_only',true,'sales_values_invented',false,'source_data_modified',false,'permission_sensitive_data_loaded_for_staff',false,'reykjavik_reporting_timezone',true,'currency','ISK')
  );
end;
$function$;

-- Live definition with numeric recordset fields scrubbed before the private call.
CREATE OR REPLACE FUNCTION public.atlas_reports_snapshot_v2(p_inventory jsonb, p_recipes jsonb, p_recipe_ingredients jsonb, p_suppliers jsonb, p_movements jsonb, p_profiles jsonb, p_tasks jsonb, p_progress jsonb, p_actor_id uuid, p_actor_role text, p_period_start date, p_period_end date, p_comparison_start date, p_comparison_end date, p_comparison_key text, p_filters jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with normalized_inputs as (
    select
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))='array'
            then coalesce(p_inventory,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as inventory,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipes,'[]'::jsonb))='array'
            then coalesce(p_recipes,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipes,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipe_ingredients,'[]'::jsonb))='array'
            then coalesce(p_recipe_ingredients,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipe_ingredients,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_suppliers,'[]'::jsonb))='array'
            then coalesce(p_suppliers,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as suppliers,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_movements,'[]'::jsonb))='array'
            then coalesce(p_movements,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as movements,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))='array'
            then coalesce(p_profiles,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as profiles,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_tasks,'[]'::jsonb))='array'
            then coalesce(p_tasks,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as tasks,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_progress,'[]'::jsonb))='array'
            then coalesce(p_progress,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as progress
  ),
  numeric_inputs as (
    -- S86.1: typed recordset columns in the private function cast JSON to
    -- numeric. Non-numeric text in these fields becomes null instead of an error.
    select
      atlas_private.reports_scrub_numeric_fields(normalized_inputs.inventory,
        array['quantity','par_level','cost_price','size_ml','sell_price']) as inventory,
      atlas_private.reports_scrub_numeric_fields(normalized_inputs.recipes,
        array['yield_quantity','menu_price','happy_hour_price','glass_price','bottle_price']) as recipes,
      atlas_private.reports_scrub_numeric_fields(normalized_inputs.recipe_ingredients,
        array['quantity']) as recipe_ingredients,
      atlas_private.reports_scrub_numeric_fields(normalized_inputs.movements,
        array['quantity_change','unit_cost','total_cost']) as movements
    from normalized_inputs
  ),
  normalized_inventory as (
    select coalesce(jsonb_agg(
      case
        when item ? 'package_size' then jsonb_set(
          item,
          '{package_size}',
          coalesce(
            to_jsonb(atlas_private.reports_normalize_package_size(item->>'package_size')),
            'null'::jsonb
          ),
          true
        )
        else item
      end
    ),'[]'::jsonb) as payload
    from numeric_inputs
    cross join lateral jsonb_array_elements(numeric_inputs.inventory) as rows(item)
  )
  select atlas_private.reports_snapshot_v2(
    normalized_inventory.payload,
    numeric_inputs.recipes,
    numeric_inputs.recipe_ingredients,
    normalized_inputs.suppliers,
    numeric_inputs.movements,
    normalized_inputs.profiles,
    normalized_inputs.tasks,
    normalized_inputs.progress,
    p_actor_id,
    p_actor_role,
    p_period_start,
    p_period_end,
    p_comparison_start,
    p_comparison_end,
    p_comparison_key,
    p_filters
  )
  from normalized_inputs
  cross join numeric_inputs
  cross join normalized_inventory;
$function$;
