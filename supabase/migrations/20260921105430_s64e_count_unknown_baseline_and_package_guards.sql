-- S64E isolated validation only; no production data writes.
alter table atlas_private.inventory_count_lines alter column expected_quantity drop not null;
alter table atlas_private.inventory_count_lines alter column expected_quantity drop default;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_start(p_inventory jsonb, p_title text, p_scope_type text, p_scope_value text, p_notes text, p_actor_id uuid, p_actor_label text, p_actor_role text, p_client_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  session_row atlas_private.inventory_count_sessions;
  inserted_count integer;
  settings_row atlas_private.inventory_count_settings;
begin
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot start stock counts'; end if;
  if p_actor_role='bartender' and not settings_row.allow_staff_start then raise exception 'Staff-started stock counts are disabled'; end if;
  if p_scope_type not in ('all','location','category') then raise exception 'Stock-count scope is invalid'; end if;
  if p_scope_type<>'all' and nullif(trim(coalesce(p_scope_value,'')),'') is null then raise exception 'A scope value is required'; end if;
  if nullif(trim(coalesce(p_client_request_id,'')),'') is null then raise exception 'A client request ID is required'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where client_request_id=p_client_request_id;
  if found then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;

  insert into atlas_private.inventory_count_sessions (
    session_key,client_request_id,title,scope_type,scope_value,notes,inventory_snapshot_at,
    started_by,started_by_label
  ) values (
    'count-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,8),
    trim(p_client_request_id),coalesce(nullif(trim(coalesce(p_title,'')),''),'Current stock count'),
    p_scope_type,case when p_scope_type='all' then null else trim(p_scope_value) end,
    nullif(trim(coalesce(p_notes,'')),''),now(),p_actor_id,p_actor_label
  ) returning * into session_row;

  insert into atlas_private.inventory_count_lines (
    session_id,inventory_item_id,item_name,category,inventory_unit,bin_location,sku,barcode,
    expected_quantity,expected_updated_at,source_updated_at,source_kind,observed_unit,
    units_per_case_snapshot,size_ml_snapshot,package_size_snapshot,package_weight_g_snapshot,
    par_level_snapshot,supplier_snapshot,unit_cost_snapshot,case_cost_snapshot,source_file_snapshot
  )
  select
    session_row.id,(item->>'id')::uuid,coalesce(nullif(item->>'name',''),'Unnamed inventory item'),
    nullif(item->>'category',''),coalesce(nullif(item->>'unit',''),'units'),nullif(item->>'bin_location',''),
    nullif(item->>'sku',''),nullif(item->>'barcode',''),case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end,
    nullif(item->>'updated_at','')::timestamptz,nullif(item->>'source_updated_at','')::date,
    case when nullif(item->>'source_updated_at','')::date<=date '2026-07-31' then 'historical_snapshot' else 'production_observation' end,
    coalesce(nullif(item->>'unit',''),'units'),nullif(item->>'units_per_case','')::numeric,
    nullif(item->>'size_ml','')::numeric,nullif(item->>'package_size',''),
    coalesce(nullif(item->>'package_weight_g','')::numeric,atlas_private.stock_count_package_weight_g(item->>'package_size')),
    nullif(item->>'par_level','')::numeric,nullif(coalesce(item->>'supplier',item->>'supplier_name'),''),
    nullif(item->>'cost_price','')::numeric,nullif(item->>'case_cost','')::numeric,nullif(item->>'source_file','')
  from jsonb_array_elements(p_inventory) item
  where coalesce((item->>'active')::boolean,true)=true
    and (
      p_scope_type='all'
      or (p_scope_type='location' and lower(coalesce(item->>'bin_location',''))=lower(trim(p_scope_value)))
      or (p_scope_type='category' and lower(coalesce(item->>'category',''))=lower(trim(p_scope_value)))
    );

  get diagnostics inserted_count=row_count;
  if inserted_count=0 then
    delete from atlas_private.inventory_count_sessions where id=session_row.id;
    raise exception 'No active inventory items match this stock-count scope';
  end if;
  update atlas_private.inventory_count_sessions set source_record_count=inserted_count where id=session_row.id;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_started',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('scope_type',p_scope_type,'scope_value',case when p_scope_type='all' then null else trim(p_scope_value) end,'source_record_count',inserted_count)
  );
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$function$
;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_verify(p_session_id uuid, p_inventory jsonb, p_acknowledge_conflicts boolean, p_actor_id uuid, p_actor_label text, p_actor_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  conflict_count_value integer := 0;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can verify stock counts'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status='verified' then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;
  if session_row.status<>'submitted' then raise exception 'Only submitted stock counts can be verified'; end if;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  select count(*) into conflict_count_value
  from atlas_private.inventory_count_lines line
  left join current_inventory current on current.inventory_item_id=line.inventory_item_id
  where line.session_id=p_session_id and line.line_status='counted'
    and (
      current.inventory_item_id is null
      or current.quantity is distinct from line.expected_quantity
      or current.updated_at is distinct from line.expected_updated_at
    );

  if conflict_count_value>0 and not coalesce(p_acknowledge_conflicts,false) then
    raise exception 'The production source changed for % counted item(s). Review and acknowledge the conflicts before verification',conflict_count_value;
  end if;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  update atlas_private.inventory_count_lines line
  set source_changed_since_start=(
    current.inventory_item_id is null
    or current.quantity is distinct from line.expected_quantity
    or current.updated_at is distinct from line.expected_updated_at
  )
  from current_inventory current
  where line.session_id=p_session_id and line.inventory_item_id=current.inventory_item_id;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  insert into atlas_private.inventory_verified_balances (
    inventory_item_id,item_name,category,inventory_unit,bin_location,verified_quantity,
    verification_status,verified_at,expires_at,source_session_id,source_line_id,
    verified_by,verified_by_label,production_quantity_at_verification,production_updated_at,variance
  )
  select
    line.inventory_item_id,line.item_name,line.category,line.inventory_unit,line.bin_location,line.observed_quantity,
    'current',now(),now()+make_interval(days=>settings_row.freshness_days),line.session_id,line.id,
    p_actor_id,p_actor_label,current.quantity,current.updated_at,line.observed_quantity-current.quantity
  from atlas_private.inventory_count_lines line
  left join current_inventory current on current.inventory_item_id=line.inventory_item_id
  where line.session_id=p_session_id and line.line_status='counted'
  on conflict (inventory_item_id) do update set
    item_name=excluded.item_name,
    category=excluded.category,
    inventory_unit=excluded.inventory_unit,
    bin_location=excluded.bin_location,
    verified_quantity=excluded.verified_quantity,
    verification_status='current',
    verified_at=excluded.verified_at,
    expires_at=excluded.expires_at,
    source_session_id=excluded.source_session_id,
    source_line_id=excluded.source_line_id,
    verified_by=excluded.verified_by,
    verified_by_label=excluded.verified_by_label,
    production_quantity_at_verification=excluded.production_quantity_at_verification,
    production_updated_at=excluded.production_updated_at,
    variance=excluded.variance,
    source_kind='manager_verified_count',
    historical=false,
    updated_at=now();

  update atlas_private.inventory_count_sessions
  set status='verified',verified_by=p_actor_id,verified_by_label=p_actor_label,verified_at=now(),
      conflict_count=conflict_count_value,conflicts_acknowledged=(conflict_count_value=0 or coalesce(p_acknowledge_conflicts,false)),
      version=version+1
  where id=p_session_id
  returning * into session_row;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_verified',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('conflict_count',conflict_count_value,'conflicts_acknowledged',session_row.conflicts_acknowledged,'freshness_days',settings_row.freshness_days,'production_applied',false)
  );

  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$function$
;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_prepare_publication(p_session_id uuid, p_inventory jsonb, p_request_id text, p_actor_id uuid, p_actor_label text, p_actor_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  publication_row atlas_private.inventory_count_publications;
  item_total integer := 0;
  adjustment_total integer := 0;
  conflict_total integer := 0;
  blocked_text text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve stock-count publication'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request ID is required'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'verified' then raise exception 'Only a manager-verified count can be prepared for publication'; end if;
  if session_row.production_applied or session_row.publication_status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  insert into atlas_private.inventory_count_publications (
    session_id,request_id,status,production_apply_enabled,approved_by,approved_by_label,evidence
  ) values (
    p_session_id,trim(p_request_id),'ready',coalesce(settings_row.production_apply_enabled,false),
    p_actor_id,p_actor_label,
    jsonb_build_object('verified_at',session_row.verified_at,'prepared_against_inventory_at',now())
  )
  on conflict(session_id) do update set
    request_id=excluded.request_id,
    status=case when atlas_private.inventory_count_publications.status='published' then 'published' else 'ready' end,
    production_apply_enabled=excluded.production_apply_enabled,
    blocked_reason=null,approved_by=excluded.approved_by,approved_by_label=excluded.approved_by_label,
    approved_at=now(),failure_message=null,evidence=excluded.evidence,updated_at=now()
  returning * into publication_row;

  if publication_row.status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;

  delete from atlas_private.inventory_count_publication_lines where publication_id=publication_row.id;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  insert into atlas_private.inventory_count_publication_lines (
    publication_id,session_id,count_line_id,inventory_item_id,item_name,inventory_unit,
    before_quantity,observed_quantity,adjustment_quantity,before_updated_at,
    verified_production_quantity,verified_production_updated_at,conflict_reason,status,movement_note
  )
  select
    publication_row.id,line_row.session_id,line_row.id,line_row.inventory_item_id,line_row.item_name,line_row.inventory_unit,
    current.quantity,line_row.observed_quantity,line_row.observed_quantity-current.quantity,current.updated_at,
    balance_row.production_quantity_at_verification,balance_row.production_updated_at,
    case
      when current.inventory_item_id is null then 'Inventory item is no longer present in the active catalog'
      when current.quantity is null then 'Current stock baseline is unknown; a reviewed opening balance is required'
      when current.quantity is distinct from balance_row.production_quantity_at_verification then 'Production quantity changed after manager verification'
      when current.updated_at is distinct from balance_row.production_updated_at then 'Production record changed after manager verification'
      else null
    end,
    case
      when current.inventory_item_id is null then 'blocked'
      when current.quantity is null then 'blocked'
      when current.quantity is distinct from balance_row.production_quantity_at_verification then 'blocked'
      when current.updated_at is distinct from balance_row.production_updated_at then 'blocked'
      when line_row.observed_quantity=current.quantity then 'skipped'
      else 'pending'
    end,
    'Atlas verified count '||publication_row.request_id||' · session '||line_row.session_id::text||' · line '||line_row.id::text
  from atlas_private.inventory_count_lines line_row
  join atlas_private.inventory_verified_balances balance_row
    on balance_row.source_session_id=line_row.session_id and balance_row.source_line_id=line_row.id
  left join current_inventory current on current.inventory_item_id=line_row.inventory_item_id
  where line_row.session_id=p_session_id and line_row.line_status='counted';

  select count(*),count(*) filter(where adjustment_quantity<>0),count(*) filter(where status='blocked')
  into item_total,adjustment_total,conflict_total
  from atlas_private.inventory_count_publication_lines where publication_id=publication_row.id;

  if item_total=0 then blocked_text := 'No counted lines are available for publication';
  elsif conflict_total>0 then blocked_text := conflict_total||' production conflict(s) require a fresh verification';
  elsif not coalesce(settings_row.production_apply_enabled,false) then blocked_text := 'Production publication is disabled in this environment';
  else blocked_text := null;
  end if;

  update atlas_private.inventory_count_publications
  set item_count=item_total,adjustment_count=adjustment_total,conflict_count=conflict_total,
      status=case when blocked_text is null then 'ready' else 'blocked' end,
      blocked_reason=blocked_text,updated_at=now()
  where id=publication_row.id;

  update atlas_private.inventory_count_sessions
  set publication_status=case when blocked_text is null then 'ready' else 'blocked' end,
      publication_approved_by=p_actor_id,publication_approved_by_label=p_actor_label,
      publication_approved_at=now(),publication_request_id=publication_row.request_id,
      version=version+1,updated_at=now()
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    case when blocked_text is null then 'publication_prepared' else 'publication_blocked' end,
    p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,
      'item_count',item_total,'adjustment_count',adjustment_total,'conflict_count',conflict_total,
      'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false),'blocked_reason',blocked_text)
  );

  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
end;
$function$
;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_normalize_quantity(p_input_quantity numeric, p_input_unit text, p_inventory_unit text, p_units_per_case numeric, p_size_ml numeric, p_package_weight_g numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  input_unit text := lower(trim(coalesce(p_input_unit,'inventory')));
  inventory_unit text := lower(trim(coalesce(p_inventory_unit,'units')));
  family text;
  normalized numeric;
  factor numeric;
  basis text;
  amount_ml numeric;
  amount_g numeric;
begin
  if p_input_quantity is null or p_input_quantity < 0 then
    raise exception 'Observed quantity must be zero or more';
  end if;

  input_unit := case
    when input_unit in ('inventory','base','base unit') then 'inventory'
    when input_unit in ('bottle','bottles') then 'bottle'
    when input_unit in ('case','cases') then 'case'
    when input_unit in ('unit','units','each','piece','pieces') then 'unit'
    when input_unit in ('l','ltr','litre','litres','liter','liters') then 'litre'
    when input_unit in ('ml','millilitre','millilitres','milliliter','milliliters') then 'millilitre'
    when input_unit in ('kg','kilogram','kilograms') then 'kilogram'
    when input_unit in ('g','gram','grams') then 'gram'
    else null
  end;
  if input_unit is null then raise exception 'Unsupported count unit'; end if;

  family := case
    when inventory_unit in ('l','ltr','litre','litres','liter','liters') then 'litre'
    when inventory_unit in ('ml','millilitre','millilitres','milliliter','milliliters') then 'millilitre'
    when inventory_unit in ('kg','kilogram','kilograms') then 'kilogram'
    when inventory_unit in ('g','gram','grams') then 'gram'
    when inventory_unit in ('bottle','bottles') then 'bottle'
    else 'unit'
  end;

  -- A box/pack/case is not one individual piece. No content conversion exists here.
  if inventory_unit in ('box','boxes','pack','packs','case','cases') and input_unit <> 'inventory' then
    raise exception 'Count this item in its inventory package unit; individual-content conversion is not configured';
  end if;

  if input_unit = 'inventory' then
    normalized := p_input_quantity;
    factor := 1;
    basis := 'inventory base unit';

  elsif input_unit = 'case' then
    if coalesce(p_units_per_case,0) <= 0 then
      raise exception 'Units per case is required before counting this item by case';
    end if;
    if family in ('unit','bottle') then
      normalized := p_input_quantity * p_units_per_case;
      factor := p_units_per_case;
      basis := 'cases × units per case';
    elsif family in ('litre','millilitre') then
      if coalesce(p_size_ml,0) <= 0 then raise exception 'Package volume is required before counting this item by case'; end if;
      amount_ml := p_input_quantity * p_units_per_case * p_size_ml;
      normalized := case when family='litre' then amount_ml/1000 else amount_ml end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'cases × units per case × package volume';
    else
      if coalesce(p_package_weight_g,0) <= 0 then raise exception 'Package weight is required before counting this item by case'; end if;
      amount_g := p_input_quantity * p_units_per_case * p_package_weight_g;
      normalized := case when family='kilogram' then amount_g/1000 else amount_g end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'cases × units per case × package weight';
    end if;

  elsif input_unit in ('bottle','unit') then
    if family in ('unit','bottle') then
      normalized := p_input_quantity;
      factor := 1;
      basis := case when input_unit='bottle' then 'bottles' else 'individual units' end;
    elsif family in ('litre','millilitre') then
      if coalesce(p_size_ml,0) <= 0 then raise exception 'Package volume is required before counting this item by unit'; end if;
      amount_ml := p_input_quantity * p_size_ml;
      normalized := case when family='litre' then amount_ml/1000 else amount_ml end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'units × package volume';
    else
      if coalesce(p_package_weight_g,0) <= 0 then raise exception 'Package weight is required before counting this item by unit'; end if;
      amount_g := p_input_quantity * p_package_weight_g;
      normalized := case when family='kilogram' then amount_g/1000 else amount_g end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'units × package weight';
    end if;

  elsif input_unit in ('litre','millilitre') then
    amount_ml := case when input_unit='litre' then p_input_quantity*1000 else p_input_quantity end;
    if family='litre' then
      normalized := amount_ml/1000;
    elsif family='millilitre' then
      normalized := amount_ml;
    elsif family in ('unit','bottle') and coalesce(p_size_ml,0)>0 then
      normalized := amount_ml/p_size_ml;
    else
      raise exception 'Volume is not compatible with this inventory unit';
    end if;
    factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
    basis := 'volume converted to inventory base unit';

  elsif input_unit in ('kilogram','gram') then
    amount_g := case when input_unit='kilogram' then p_input_quantity*1000 else p_input_quantity end;
    if family='kilogram' then
      normalized := amount_g/1000;
    elsif family='gram' then
      normalized := amount_g;
    elsif family in ('unit','bottle') and coalesce(p_package_weight_g,0)>0 then
      normalized := amount_g/p_package_weight_g;
    else
      raise exception 'Weight is not compatible with this inventory unit';
    end if;
    factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
    basis := 'weight converted to inventory base unit';
  end if;

  if normalized is null then raise exception 'This count unit cannot be converted to the inventory unit'; end if;
  return jsonb_build_object(
    'input_quantity',p_input_quantity,
    'input_unit',input_unit,
    'normalized_quantity',normalized,
    'conversion_factor',factor,
    'conversion_basis',basis,
    'inventory_unit',p_inventory_unit
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_supported_units(p_inventory_unit text, p_units_per_case numeric, p_size_ml numeric, p_package_weight_g numeric)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  with normalized as (
    select lower(trim(coalesce(p_inventory_unit,'units'))) as inventory_unit
  ), options(sort_order, unit_key, allowed) as (
    values
      (1, 'inventory'::text, true),
      (2, 'bottle'::text, (select inventory_unit in ('bottle','bottles') from normalized) or coalesce(p_size_ml,0) > 0),
      (3, 'case'::text, coalesce(p_units_per_case,0) > 0),
      (4, 'unit'::text, true),
      (5, 'litre'::text, (select inventory_unit in ('l','ltr','litre','litres','liter','liters','ml','millilitre','millilitres','milliliter','milliliters') from normalized) or coalesce(p_size_ml,0) > 0),
      (6, 'millilitre'::text, (select inventory_unit in ('l','ltr','litre','litres','liter','liters','ml','millilitre','millilitres','milliliter','milliliters') from normalized) or coalesce(p_size_ml,0) > 0),
      (7, 'kilogram'::text, (select inventory_unit in ('kg','kilogram','kilograms','g','gram','grams') from normalized) or coalesce(p_package_weight_g,0) > 0),
      (8, 'gram'::text, (select inventory_unit in ('kg','kilogram','kilograms','g','gram','grams') from normalized) or coalesce(p_package_weight_g,0) > 0)
  )
  select coalesce(jsonb_agg(unit_key order by sort_order) filter (where allowed and (unit_key='inventory' or (select inventory_unit not in ('box','boxes','pack','packs','case','cases') from normalized))), '[]'::jsonb)
  from options;
$function$
;
