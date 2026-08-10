-- Checkpoint L1: unit-aware, manager-verifiable stock-count evidence.
--
-- Observations remain private. This migration records both the quantity entered
-- by the counter and the normalized inventory-base quantity, while explicitly
-- classifying every catalog quantity as current, stale, historical or
-- unverified. No production inventory row is changed here.

alter table atlas_private.inventory_count_lines
  add column if not exists observed_input_quantity numeric,
  add column if not exists observed_input_unit text,
  add column if not exists conversion_factor numeric,
  add column if not exists conversion_basis text,
  add column if not exists units_per_case_snapshot numeric,
  add column if not exists size_ml_snapshot numeric,
  add column if not exists package_size_snapshot text,
  add column if not exists package_weight_g_snapshot numeric,
  add column if not exists par_level_snapshot numeric,
  add column if not exists supplier_snapshot text,
  add column if not exists unit_cost_snapshot numeric,
  add column if not exists case_cost_snapshot numeric,
  add column if not exists source_file_snapshot text,
  add column if not exists count_evidence jsonb not null default '{}'::jsonb;

alter table atlas_private.inventory_count_lines
  drop constraint if exists inventory_count_lines_count_evidence_check;
alter table atlas_private.inventory_count_lines
  add constraint inventory_count_lines_count_evidence_check
  check (jsonb_typeof(count_evidence) = 'object');

create or replace function atlas_private.stock_count_package_weight_g(p_package_size text)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when coalesce(p_package_size,'') ~* '^\s*[0-9]+(?:\.[0-9]+)?\s*kg\s*$'
      then regexp_replace(p_package_size,'[^0-9.]','','g')::numeric * 1000
    when coalesce(p_package_size,'') ~* '^\s*[0-9]+(?:\.[0-9]+)?\s*g\s*$'
      then regexp_replace(p_package_size,'[^0-9.]','','g')::numeric
    else null
  end;
$$;

create or replace function atlas_private.stock_count_quantity_status(
  p_inventory_item_id uuid,
  p_source_updated_at date
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  balance_row atlas_private.inventory_verified_balances;
begin
  select * into balance_row
  from atlas_private.inventory_verified_balances
  where inventory_item_id = p_inventory_item_id
  order by verified_at desc
  limit 1;

  if found and balance_row.verification_status = 'current' and balance_row.expires_at > now() then
    return 'current';
  end if;
  if found then
    return 'stale';
  end if;
  if p_source_updated_at is not null and p_source_updated_at <= date '2026-07-31' then
    return 'historical';
  end if;
  return 'unverified';
end;
$$;

create or replace function atlas_private.stock_count_supported_units(
  p_inventory_unit text,
  p_units_per_case numeric,
  p_size_ml numeric,
  p_package_weight_g numeric
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
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
  select coalesce(jsonb_agg(unit_key order by sort_order) filter (where allowed), '[]'::jsonb)
  from options;
$$;

create or replace function atlas_private.stock_count_normalize_quantity(
  p_input_quantity numeric,
  p_input_unit text,
  p_inventory_unit text,
  p_units_per_case numeric,
  p_size_ml numeric,
  p_package_weight_g numeric
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
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
$$;

create or replace function atlas_private.stock_count_detail(
  p_session_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role='viewer' and session_row.status<>'verified' then
    raise exception 'This stock-count session is not available to viewers';
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'summary',atlas_private.stock_count_session_summary(session_row.id),
    'lines',coalesce((
      select jsonb_agg(
        to_jsonb(line_row)
        || jsonb_build_object(
          'variance',case when line_row.observed_quantity is null then null else line_row.observed_quantity-line_row.expected_quantity end,
          'quantity_status',atlas_private.stock_count_quantity_status(line_row.inventory_item_id,line_row.source_updated_at),
          'supported_count_units',atlas_private.stock_count_supported_units(
            line_row.inventory_unit,line_row.units_per_case_snapshot,line_row.size_ml_snapshot,line_row.package_weight_g_snapshot
          )
        )
        order by coalesce(line_row.bin_location,''),coalesce(line_row.category,''),line_row.item_name
      )
      from atlas_private.inventory_count_lines line_row
      where line_row.session_id=session_row.id
    ),'[]'::jsonb),
    'publication',case when to_regclass('atlas_private.inventory_count_publications') is null then null else (
      select to_jsonb(publication_row)
      from atlas_private.inventory_count_publications publication_row
      where publication_row.session_id=session_row.id
    ) end,
    'permissions',jsonb_build_object(
      'can_edit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_submit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_verify',(is_manager and session_row.status='submitted'),
      'can_reject',(is_manager and session_row.status='submitted'),
      'can_cancel',((is_manager or session_row.started_by=p_actor_id) and session_row.status in ('draft','submitted')),
      'can_prepare_publication',(is_manager and session_row.status='verified' and not session_row.production_applied),
      'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false)
    ),
    'trust',jsonb_build_object(
      'production_inventory_mutated',session_row.production_applied,
      'count_observation_mutates_inventory',false,
      'manager_verification_required',true,
      'manager_publication_required',true,
      'historical_rows_are_current',false,
      'verified_balances_are_private',true
    )
  );
end;
$$;

create or replace function atlas_private.stock_count_start(
  p_inventory jsonb,
  p_title text,
  p_scope_type text,
  p_scope_value text,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_client_request_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
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
    nullif(item->>'sku',''),nullif(item->>'barcode',''),coalesce(nullif(item->>'quantity','')::numeric,0),
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
$$;

create or replace function atlas_private.stock_count_save_line_v2(
  p_session_id uuid,
  p_line_id uuid,
  p_line_status text,
  p_input_quantity numeric,
  p_input_unit text,
  p_count_method text,
  p_note text,
  p_skipped_reason text,
  p_expected_version integer,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
  normalized jsonb;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot count inventory'; end if;
  if p_line_status not in ('pending','counted','skipped') then raise exception 'Count-line status is invalid'; end if;
  if p_count_method is not null and p_count_method not in ('manual','barcode','photo','import') then raise exception 'Count method is invalid'; end if;
  if p_line_status='skipped' and nullif(trim(coalesce(p_skipped_reason,'')),'') is null then raise exception 'A skipped line requires a reason'; end if;
  if jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object' then raise exception 'Count evidence must be an object'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be edited'; end if;
  select * into line_row from atlas_private.inventory_count_lines where id=p_line_id and session_id=p_session_id;
  if not found then raise exception 'Stock-count line not found'; end if;

  if p_line_status='counted' then
    normalized := atlas_private.stock_count_normalize_quantity(
      p_input_quantity,p_input_unit,line_row.inventory_unit,line_row.units_per_case_snapshot,
      line_row.size_ml_snapshot,line_row.package_weight_g_snapshot
    );
  end if;

  update atlas_private.inventory_count_lines
  set line_status=p_line_status,
      observed_quantity=case when p_line_status='counted' then (normalized->>'normalized_quantity')::numeric else null end,
      observed_input_quantity=case when p_line_status='counted' then p_input_quantity else null end,
      observed_input_unit=case when p_line_status='counted' then normalized->>'input_unit' else null end,
      observed_unit=case when p_line_status='counted' then normalized->>'input_unit' else observed_unit end,
      conversion_factor=case when p_line_status='counted' then nullif(normalized->>'conversion_factor','')::numeric else null end,
      conversion_basis=case when p_line_status='counted' then normalized->>'conversion_basis' else null end,
      count_method=case when p_line_status='counted' then coalesce(p_count_method,'manual') else null end,
      note=nullif(trim(coalesce(p_note,'')),''),
      skipped_reason=case when p_line_status='skipped' then trim(p_skipped_reason) else null end,
      counted_by=case when p_line_status='counted' then p_actor_id else null end,
      counted_by_label=case when p_line_status='counted' then p_actor_label else null end,
      counted_at=case when p_line_status='counted' then now() else null end,
      count_evidence=coalesce(p_evidence,'{}'::jsonb),version=version+1
  where id=p_line_id and session_id=p_session_id and version=p_expected_version
  returning * into line_row;
  if not found then raise exception 'This count line changed in another session. Refresh and try again'; end if;

  update atlas_private.inventory_count_sessions set version=version+1 where id=p_session_id;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,line_id,inventory_item_id,actor_id,actor_label,actor_role,payload
  ) values (
    'line_saved',p_session_id,line_row.id,line_row.inventory_item_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'line_status',line_row.line_status,'observed_input_quantity',line_row.observed_input_quantity,
      'observed_input_unit',line_row.observed_input_unit,'normalized_quantity',line_row.observed_quantity,
      'inventory_unit',line_row.inventory_unit,'conversion_basis',line_row.conversion_basis,
      'count_method',line_row.count_method,'line_version',line_row.version
    )
  );
  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_snapshot(
  p_inventory jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  settings_row atlas_private.inventory_count_settings;
  sessions_json jsonb := '[]'::jsonb;
  catalog_json jsonb := '[]'::jsonb;
  balances_json jsonb := '[]'::jsonb;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then raise exception 'This profile cannot access stock counts'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  select coalesce(jsonb_agg(
    to_jsonb(session_row) || jsonb_build_object('summary',atlas_private.stock_count_session_summary(session_row.id))
    order by session_row.started_at desc
  ),'[]'::jsonb)
  into sessions_json
  from atlas_private.inventory_count_sessions session_row
  where p_actor_role<>'viewer' or session_row.status='verified';

  with items as (
    select item from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item
    where coalesce((item->>'active')::boolean,true)=true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item->>'id','name',item->>'name','category',item->>'category',
    'quantity',coalesce(nullif(item->>'quantity','')::numeric,0),'unit',coalesce(nullif(item->>'unit',''),'units'),
    'par_level',nullif(item->>'par_level','')::numeric,'bin_location',nullif(item->>'bin_location',''),
    'sku',nullif(item->>'sku',''),'barcode',nullif(item->>'barcode',''),
    'units_per_case',nullif(item->>'units_per_case','')::numeric,'size_ml',nullif(item->>'size_ml','')::numeric,
    'package_size',nullif(item->>'package_size',''),'supplier',nullif(coalesce(item->>'supplier',item->>'supplier_name'),''),
    'cost_price',nullif(item->>'cost_price','')::numeric,'case_cost',nullif(item->>'case_cost','')::numeric,
    'updated_at',nullif(item->>'updated_at','')::timestamptz,'source_updated_at',nullif(item->>'source_updated_at','')::date,
    'source_kind',case
      when balance.inventory_item_id is not null and balance.verification_status='current' and balance.expires_at>now() then 'manager_verified_count'
      when nullif(item->>'source_updated_at','')::date<=date '2026-07-31' then 'historical_snapshot'
      else 'production_observation' end,
    'quantity_status',atlas_private.stock_count_quantity_status((item->>'id')::uuid,nullif(item->>'source_updated_at','')::date),
    'verified_quantity',balance.verified_quantity,'verified_at',balance.verified_at,'verified_expires_at',balance.expires_at
  ) order by coalesce(item->>'bin_location',''),coalesce(item->>'category',''),item->>'name'),'[]'::jsonb)
  into catalog_json
  from items
  left join atlas_private.inventory_verified_balances balance on balance.inventory_item_id=(item->>'id')::uuid;

  select coalesce(jsonb_agg(to_jsonb(balance_row) || jsonb_build_object(
    'freshness_state',case when balance_row.verification_status<>'current' then 'revoked' when balance_row.expires_at<=now() then 'stale' else 'current' end
  ) order by balance_row.verified_at desc),'[]'::jsonb)
  into balances_json from atlas_private.inventory_verified_balances balance_row;

  return jsonb_build_object(
    'version','atlas-stock-counts/0.2.0','generated_at',now(),'sessions',sessions_json,
    'catalog',catalog_json,'verified_balances',balances_json,'settings',to_jsonb(settings_row),
    'summary',jsonb_build_object(
      'draft_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='draft'),
      'submitted_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='submitted'),
      'verified_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='verified'),
      'current_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at>now()),
      'stale_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at<=now()),
      'current_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='current'),
      'stale_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='stale'),
      'historical_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='historical'),
      'unverified_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='unverified'),
      'catalog_items',jsonb_array_length(catalog_json)
    ),
    'permissions',jsonb_build_object(
      'can_start',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_start)),
      'can_count',(p_actor_role in ('admin','manager','bartender')),
      'can_submit',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_submit)),
      'can_verify',is_manager,'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false)
    ),
    'trust',jsonb_build_object(
      'shadow_mode',not coalesce(settings_row.production_apply_enabled,false),
      'count_observation_mutates_inventory',false,'verification_mutates_inventory',false,
      'publication_is_only_adjustment_boundary',true,'manager_verification_required',true,
      'historical_inventory_used_as_current',false,'verified_balance_source','manager_verified_count'
    )
  );
end;
$$;

create or replace function public.atlas_stock_count_save_line_v2(
  uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.stock_count_save_line_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13);
$$;

revoke all on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text)
  to service_role;

comment on column atlas_private.inventory_count_lines.observed_quantity is
  'Count quantity normalized into the inventory item base unit. The original entry is preserved in observed_input_quantity and observed_input_unit.';
comment on function atlas_private.stock_count_normalize_quantity(numeric,text,text,numeric,numeric,numeric) is
  'Checkpoint L1 unit conversion for bottle, case, unit, litre, millilitre and weight observations.';
