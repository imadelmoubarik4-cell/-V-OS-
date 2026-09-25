-- S90 workflow integrity (engineering acceptance P2-2, P2-8).
--
-- P2-2: recording waste and a delivery without an order were not idempotent.
-- public.adjust_inventory has no request id, so a retry after a timeout that
-- did commit recorded the waste or restock twice.
--   * public.adjust_inventory_v2 is a SECURITY INVOKER wrapper (manager check,
--     search_path '') over private.adjust_inventory_request (SECURITY DEFINER,
--     manager-gated, not executable by anon). It takes a request id that is
--     unique per actor (atlas_private.stock_adjustment_requests, primary key
--     (actor_id, request_id)). A replay with the same id and the same change
--     returns the stored movement and writes nothing; the same id with a
--     different change is refused. Only 'waste' (negative) and 'restock'
--     (positive) are accepted: the browser flows that use it.
--   * Refusals carry fixed messages and SQLSTATEs so the browser can tell a
--     refusal (nothing was written) from an unconfirmed network failure.
--   * public.adjust_inventory keeps its signature and behaviour.
--
-- P2-8: "Verify anyway" erased deliveries received between a line's count and
-- the manager's verification. The verified balance was stamped verified_at =
-- now() at verification, and the canonical projection (AtlasStockTruth,
-- _shared/atlas-domain.mjs, stock-provenance) adds only movements after
-- verified_at, so a delivery recorded after the bartender counted but before
-- the manager verified vanished from stock.
--   * atlas_private.stock_count_verify now stamps each verified balance at the
--     line's counted_at (the moment the quantity was observed, never later
--     than now()). Movements after the count apply on top through the same
--     canonical projection; movements before it were physically counted and
--     stay excluded. The session keeps verified_at = now() and the expiry
--     still runs from verification.
--   * A count observed before the item's current verified balance no longer
--     overwrites the newer balance.
-- Safe to apply before the new web deploy: the old web app keeps calling
-- adjust_inventory; the verify signature is unchanged.

create table if not exists atlas_private.stock_adjustment_requests (
  actor_id uuid not null,
  request_id text not null check (length(request_id) between 8 and 200),
  item_id uuid not null,
  movement_type text not null check (movement_type in ('waste', 'restock')),
  quantity_change numeric not null check (quantity_change <> 0),
  unit_cost numeric,
  supplier_id uuid,
  note text,
  movement_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, request_id)
);
create index if not exists stock_adjustment_requests_movement_idx
  on atlas_private.stock_adjustment_requests(movement_id);
alter table atlas_private.stock_adjustment_requests enable row level security;
revoke all on table atlas_private.stock_adjustment_requests from public, anon, authenticated;

create or replace function private.adjust_inventory_request(
  p_request_id text,
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_note text default null)
returns public.inventory_movements
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  request_key text := nullif(btrim(coalesce(p_request_id, '')), '');
  note_text text := left(p_note, 1000);
  existing atlas_private.stock_adjustment_requests;
  item_row public.inventory_items;
  movement_row public.inventory_movements;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Controlled inventory adjustments require an active manager or administrator'
      using errcode='42501';
  end if;
  if request_key is null or length(request_key) not between 8 and 200 then
    raise exception 'A stock request ID is required' using errcode = '22023';
  end if;
  if p_item_id is null then
    raise exception 'Item not found or resulting quantity would be negative' using errcode = '22023';
  end if;
  if p_movement_type is null or p_movement_type not in ('waste', 'restock') then
    raise exception 'Invalid movement type' using errcode = '22023';
  end if;
  if p_quantity_change is null or p_quantity_change = 0 or abs(p_quantity_change) > 1000000 then
    raise exception 'Quantity change must be between 0 and 1000000' using errcode = '22023';
  end if;
  if p_movement_type = 'waste' and p_quantity_change > 0 then
    raise exception 'Waste must lower stock' using errcode = '22023';
  end if;
  if p_movement_type = 'restock' and p_quantity_change < 0 then
    raise exception 'A delivery must add stock' using errcode = '22023';
  end if;
  if p_unit_cost is not null and not (p_unit_cost >= 0 and p_unit_cost <= 100000000) then
    raise exception 'Unit cost must be 0 or more' using errcode = '22023';
  end if;

  -- One request id per actor: retries serialize here and replay the result.
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':' || request_key, 90));
  select * into existing from atlas_private.stock_adjustment_requests r
  where r.actor_id = actor and r.request_id = request_key;
  if found then
    if existing.item_id = p_item_id
       and existing.movement_type = p_movement_type
       and existing.quantity_change = p_quantity_change
       and existing.unit_cost is not distinct from p_unit_cost
       and existing.supplier_id is not distinct from p_supplier_id
       and existing.note is not distinct from note_text then
      select * into movement_row from public.inventory_movements m where m.id = existing.movement_id;
      if movement_row.id is null then
        raise exception 'This stock request was recorded, but its movement is no longer available' using errcode = '22023';
      end if;
      return movement_row;
    end if;
    raise exception 'This stock request ID was already used for a different change' using errcode = '22023';
  end if;

  perform set_config('atlas.allow_inventory_quantity_change', 'on', true);
  perform set_config('atlas.audit_via', 'adjust_inventory', true);

  update public.inventory_items
  set quantity = quantity + p_quantity_change,
      supplier_id = coalesce(p_supplier_id, supplier_id),
      cost_price = case when p_unit_cost is not null and p_movement_type = 'restock' then p_unit_cost else cost_price end,
      updated_by = coalesce(actor::text, updated_by)
  where id = p_item_id
    and active is true
    and quantity + p_quantity_change >= 0
  returning * into item_row;

  perform set_config('atlas.allow_inventory_quantity_change', '', true);
  perform set_config('atlas.audit_via', '', true);

  if item_row.id is null then
    raise exception 'Item not found or resulting quantity would be negative' using errcode = '22023';
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
    note_text,
    actor
  ) returning * into movement_row;

  insert into atlas_private.stock_adjustment_requests (
    actor_id, request_id, item_id, movement_type, quantity_change, unit_cost, supplier_id, note, movement_id
  ) values (
    actor, request_key, p_item_id, p_movement_type, p_quantity_change, p_unit_cost, p_supplier_id, note_text, movement_row.id
  );

  return movement_row;
end
$function$;

revoke all on function private.adjust_inventory_request(text, uuid, numeric, text, numeric, uuid, text) from public, anon;
grant execute on function private.adjust_inventory_request(text, uuid, numeric, text, numeric, uuid, text) to authenticated, service_role;

create or replace function public.adjust_inventory_v2(
  p_request_id text,
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_note text default null)
returns public.inventory_movements
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Controlled inventory adjustments require an active manager or administrator'
      using errcode='42501';
  end if;
  return private.adjust_inventory_request(p_request_id, p_item_id, p_quantity_change, p_movement_type, p_unit_cost, p_supplier_id, p_note);
end
$function$;

revoke all on function public.adjust_inventory_v2(text, uuid, numeric, text, numeric, uuid, text) from public, anon;
grant execute on function public.adjust_inventory_v2(text, uuid, numeric, text, numeric, uuid, text) to authenticated, service_role;

-- P2-8: verified balances are stamped at the moment each line was counted.
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

  -- The baseline is the counted quantity at the moment it was counted
  -- (counted_at, never later than now). Movements recorded after the count
  -- (a delivery that arrived before the manager verified) apply on top in
  -- the canonical projection instead of being erased.
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
    'current',least(coalesce(line.counted_at,now()),now()),now()+make_interval(days=>settings_row.freshness_days),line.session_id,line.id,
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
    updated_at=now()
  where atlas_private.inventory_verified_balances.verification_status<>'current'
     or atlas_private.inventory_verified_balances.verified_at<=excluded.verified_at;

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
    jsonb_build_object('conflict_count',conflict_count_value,'conflicts_acknowledged',session_row.conflicts_acknowledged,'freshness_days',settings_row.freshness_days,'production_applied',false,'baseline','counted_at')
  );

  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$function$
;

notify pgrst, 'reload schema';
