-- S88 purchasing: expected delivery date, partial receiving, optional approval.
--
-- Additive and backwards-compatible with the S87 web:
--   * public.purchase_orders gains delivery/approval/short-close columns and
--     the new statuses pending_approval, approved and partially_received;
--   * public.purchase_order_receipts records every received quantity per line
--     (retry-safe through a client request id) and links the stock movement;
--   * public.purchase_order_events is the append-only audit of transitions;
--   * private.purchase_order_command_v2 is the new command. The v1 command
--     keeps its signature, grants and contract and now delegates to v2, so a
--     v1 "receive" receives every remaining quantity and can never receive a
--     line twice after a v2 partial receipt.
--
-- Stock is posted only through public.adjust_inventory ('restock'), exactly as
-- v1 did. Cost rule (unchanged from v1): adjust_inventory overwrites
-- inventory_items.cost_price with the received unit cost; v1 receives at the
-- line cost, v2 at the receipt cost (default: the line cost). The owner may
-- later switch purchase_receipt_cost_mode to 'record_only' in the inventory
-- Settings section; the default 'update_item_cost' keeps today's behaviour.
--
-- Owner decisions are stored as keys of the existing inventory Settings
-- section; every missing key resolves to a default that reproduces v1
-- (no approval, no over-receipt, no short close, cost updated at receipt,
-- managers only, delivery date optional). Single venue: no tenancy column.

alter table public.purchase_orders
  add column if not exists expected_delivery_date date,
  add column if not exists submitted_by uuid references public.profiles(id),
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists ordered_at timestamptz,
  add column if not exists closed_short boolean not null default false,
  add column if not exists close_reason text check (close_reason is null or length(close_reason) <= 1000);

alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check check (status in
  ('draft','pending_approval','approved','ordered','partially_received','received','cancelled'));

create index if not exists purchase_orders_submitted_by_idx on public.purchase_orders(submitted_by);
create index if not exists purchase_orders_approved_by_idx on public.purchase_orders(approved_by);

create table if not exists public.purchase_order_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete restrict,
  request_id text not null check (length(request_id) between 1 and 200),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity numeric not null check (quantity > 0 and quantity <= 1000000),
  unit_cost numeric not null check (unit_cost >= 0 and unit_cost <= 100000000),
  ordered_unit_cost numeric not null check (ordered_unit_cost >= 0 and ordered_unit_cost <= 100000000),
  movement_id uuid references public.inventory_movements(id) on delete restrict,
  note text check (note is null or length(note) <= 1000),
  received_by uuid not null references public.profiles(id),
  received_at timestamptz not null default now(),
  unique (order_id, request_id, item_id)
);
create index if not exists purchase_order_receipts_order_idx on public.purchase_order_receipts(order_id);
create index if not exists purchase_order_receipts_item_idx on public.purchase_order_receipts(item_id);
create index if not exists purchase_order_receipts_movement_idx on public.purchase_order_receipts(movement_id);
create index if not exists purchase_order_receipts_received_by_idx on public.purchase_order_receipts(received_by);

create table if not exists public.purchase_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete restrict,
  event_type text not null check (event_type in ('created','updated','submitted','approved','rejected',
    'ordered','delivery_date_set','received_partial','received','closed_short','cancelled')),
  from_status text,
  to_status text,
  actor_id uuid not null references public.profiles(id),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists purchase_order_events_order_idx on public.purchase_order_events(order_id, created_at);
create index if not exists purchase_order_events_actor_idx on public.purchase_order_events(actor_id);

-- Managers read; nobody writes directly (only the definer command function).
alter table public.purchase_order_receipts enable row level security;
alter table public.purchase_order_events enable row level security;
revoke all on public.purchase_order_receipts, public.purchase_order_events from public, anon, authenticated;
grant select on public.purchase_order_receipts, public.purchase_order_events to authenticated;
grant all on public.purchase_order_receipts, public.purchase_order_events to service_role;
drop policy if exists "active managers read purchase order receipts" on public.purchase_order_receipts;
create policy "active managers read purchase order receipts" on public.purchase_order_receipts
  for select to authenticated using ((select private.is_manager_or_admin()));
drop policy if exists "active managers read purchase order events" on public.purchase_order_events;
create policy "active managers read purchase order events" on public.purchase_order_events
  for select to authenticated using ((select private.is_manager_or_admin()));

-- Venue calendar date. Uses the S88 venue clock when it is installed, else the
-- validated venue Settings time zone, else the documented default.
create or replace function private.purchase_order_venue_date()
returns date
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  zone text;
  result date;
begin
  if pg_catalog.to_regprocedure('atlas_private.venue_date(timestamp with time zone)') is not null then
    execute 'select atlas_private.venue_date(pg_catalog.now())' into result;
    if result is not null then return result; end if;
  end if;
  select s.settings_value->>'timezone' into zone
  from atlas_private.settings_sections s where s.section_key = 'venue';
  if zone is null or not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = zone) then
    zone := 'Atlantic/Reykjavik';
  end if;
  return (pg_catalog.now() at time zone zone)::date;
end
$function$;
revoke all on function private.purchase_order_venue_date() from public, anon, authenticated;

-- Owner-decision policy. Every key is optional; defaults reproduce v1.
create or replace function private.purchase_order_policy_values()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v jsonb := '{}'::jsonb;
  threshold numeric;
  tolerance numeric := 0;
begin
  select coalesce(s.settings_value, '{}'::jsonb) into v
  from atlas_private.settings_sections s where s.section_key = 'inventory';
  v := coalesce(v, '{}'::jsonb);
  if jsonb_typeof(v->'purchase_approval_threshold_isk') = 'number' then
    threshold := (v->>'purchase_approval_threshold_isk')::numeric;
    if threshold < 0 then threshold := null; end if;
  end if;
  if jsonb_typeof(v->'purchase_over_receipt_tolerance_percent') = 'number' then
    tolerance := least(greatest((v->>'purchase_over_receipt_tolerance_percent')::numeric, 0), 100);
  end if;
  return jsonb_build_object(
    'approval_required', coalesce(v->'purchase_approval_required' = 'true'::jsonb, false),
    'approval_threshold_isk', threshold,
    'approval_separate_approver', coalesce(v->'purchase_approval_separate_approver' = 'true'::jsonb, false),
    'approval_approver_role', case when v->>'purchase_approval_approver_role' = 'admin' then 'admin' else 'manager' end,
    'over_receipt_tolerance_percent', tolerance,
    'short_close_enabled', coalesce(v->'purchase_short_close_enabled' = 'true'::jsonb, false),
    'receipt_cost_mode', case when v->>'purchase_receipt_cost_mode' = 'record_only' then 'record_only' else 'update_item_cost' end,
    'delivery_date_required_on_place', coalesce(v->'purchase_delivery_date_required_on_place' = 'true'::jsonb, false),
    'staff_receiving_enabled', false
  );
end
$function$;
revoke all on function private.purchase_order_policy_values() from public, anon, authenticated;

create or replace function private.purchase_order_total(p_lines jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $function$
  select coalesce(sum((l->>'quantity')::numeric * (l->>'unit_cost')::numeric), 0)
  from pg_catalog.jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l;
$function$;
revoke all on function private.purchase_order_total(jsonb) from public, anon, authenticated;

create or replace function private.purchase_order_approval_needed(p_lines jsonb, p_policy jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce((p_policy->>'approval_required')::boolean, false)
    and (p_policy->'approval_threshold_isk' is null
         or jsonb_typeof(p_policy->'approval_threshold_isk') = 'null'
         or private.purchase_order_total(p_lines) >= (p_policy->>'approval_threshold_isk')::numeric);
$function$;
revoke all on function private.purchase_order_approval_needed(jsonb, jsonb) from public, anon, authenticated;

create or replace function private.purchase_order_log_event(
  p_order_id uuid, p_event_type text, p_from text, p_to text, p_actor uuid, p_payload jsonb)
returns void
language sql
security definer
set search_path = ''
as $function$
  -- clock_timestamp keeps several events of one transaction in order.
  insert into public.purchase_order_events(order_id, event_type, from_status, to_status, actor_id, payload, created_at)
  values (p_order_id, p_event_type, p_from, p_to, p_actor, coalesce(p_payload, '{}'::jsonb), pg_catalog.clock_timestamp());
$function$;
revoke all on function private.purchase_order_log_event(uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;

create or replace function private.purchase_order_command_v2(
  p_id uuid, p_action text, p_version integer,
  p_supplier_id uuid, p_lines jsonb, p_note text,
  p_expected_delivery_date date, p_receipt jsonb, p_request_id text, p_reason text
) returns public.purchase_orders
language plpgsql security definer set search_path = ''
as $function$
declare
  result public.purchase_orders;
  line jsonb;
  entry jsonb;
  item public.inventory_items;
  normalized jsonb := '[]'::jsonb;
  requested jsonb := '[]'::jsonb;
  qty numeric;
  price numeric;
  line_qty numeric;
  received numeric;
  allowance numeric;
  prev_cost numeric;
  receipt_id uuid;
  movement uuid;
  receipt_log jsonb := '[]'::jsonb;
  policy jsonb;
  actor uuid := auth.uid();
  actor_role text;
  venue_today date;
  request_key text;
  entry_note text;
  complete boolean;
  next_status text;
  from_status text;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  if p_id is null or p_action is null or p_action not in (
    'create','update','set_delivery_date','submit','approve','reject','place',
    'receive','receive_lines','close_short','cancel') then
    raise exception 'Invalid purchase order command';
  end if;
  -- Same order ID serializes creation retries as well as later transitions.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  select * into result from public.purchase_orders where id=p_id for update;
  policy := private.purchase_order_policy_values();

  if p_expected_delivery_date is not null and p_action in ('create','update','set_delivery_date') then
    venue_today := private.purchase_order_venue_date();
    if p_expected_delivery_date < venue_today then
      raise exception 'Expected delivery date cannot be in the past';
    end if;
  end if;

  if p_action in ('create','update') then
    if p_supplier_id is null or not exists(select 1 from public.suppliers where id=p_supplier_id and active is true) then
      raise exception 'Choose an active supplier';
    end if;
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'Order lines must be an array'; end if;
    if jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Use 1 to 100 order lines'; end if;
    if length(coalesce(p_note,'')) > 2000 then raise exception 'Order note is too long'; end if;
    for line in select value from jsonb_array_elements(p_lines) loop
      select * into item from public.inventory_items where id=(line->>'item_id')::uuid and active is true;
      if item.id is null then raise exception 'Order item is unavailable'; end if;
      qty := (line->>'quantity')::numeric; price := (line->>'unit_cost')::numeric;
      if qty is null or not(qty > 0 and qty <= 1000000) or price is null or not(price >= 0 and price <= 100000000) then
        raise exception 'Invalid order quantity or unit cost';
      end if;
      if exists(select 1 from jsonb_array_elements(normalized) x where x->>'item_id'=item.id::text) then
        raise exception 'Use one line per inventory item';
      end if;
      normalized := normalized || jsonb_build_array(jsonb_build_object(
        'item_id',item.id,'item_name',item.name,'unit',item.unit,'quantity',qty,'unit_cost',price));
    end loop;
    if p_action='create' then
      if result.id is not null then
        if result.created_by=actor and result.supplier_id=p_supplier_id and result.lines=normalized
           and result.note=coalesce(p_note,'')
           and (p_expected_delivery_date is null or result.expected_delivery_date is not distinct from p_expected_delivery_date) then
          return result;
        end if;
        raise exception 'This order ID already belongs to a different request';
      end if;
      insert into public.purchase_orders(id,supplier_id,lines,note,created_by,updated_by,expected_delivery_date)
      values(p_id,p_supplier_id,normalized,coalesce(p_note,''),actor,actor,p_expected_delivery_date) returning * into result;
      perform private.purchase_order_log_event(p_id,'created',null,'draft',actor,jsonb_build_object(
        'supplier_id',p_supplier_id,'lines',jsonb_array_length(normalized),
        'total',private.purchase_order_total(normalized),'expected_delivery_date',p_expected_delivery_date));
      return result;
    end if;
  end if;
  if result.id is null then raise exception 'Order not found'; end if;
  from_status := result.status;

  -- Retry-safe replies: a repeated request never applies a second movement.
  if (p_action='receive' and result.status='received') or
     (p_action='cancel' and result.status='cancelled') or
     (p_action='place' and result.status='ordered') or
     (p_action='submit' and result.status='pending_approval') or
     (p_action='approve' and result.status='approved') or
     (p_action='close_short' and result.status='received' and result.closed_short) then
    return result;
  end if;
  if p_action='receive_lines' then
    request_key := nullif(btrim(coalesce(p_request_id,'')),'');
    if request_key is null or length(request_key) > 200 then
      raise exception 'A receipt request ID is required';
    end if;
    if p_receipt is null or jsonb_typeof(p_receipt) <> 'array' or jsonb_array_length(p_receipt) not between 1 and 100 then
      raise exception 'Receipt must list 1 to 100 lines';
    end if;
    -- Normalise the request so a retry can be compared with what was stored.
    for entry in select value from jsonb_array_elements(p_receipt) loop
      if jsonb_typeof(entry) <> 'object' or (entry->>'item_id') is null
         or (entry->>'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Each receipt line needs an item';
      end if;
      if jsonb_typeof(entry->'quantity') <> 'number' then raise exception 'Invalid receipt quantity or unit cost'; end if;
      qty := (entry->>'quantity')::numeric;
      if not(qty > 0 and qty <= 1000000) then raise exception 'Invalid receipt quantity or unit cost'; end if;
      if entry ? 'unit_cost' and jsonb_typeof(entry->'unit_cost') <> 'null' then
        if jsonb_typeof(entry->'unit_cost') <> 'number' then raise exception 'Invalid receipt quantity or unit cost'; end if;
        price := (entry->>'unit_cost')::numeric;
        if not(price >= 0 and price <= 100000000) then raise exception 'Invalid receipt quantity or unit cost'; end if;
      else
        price := null;
      end if;
      entry_note := nullif(btrim(coalesce(entry->>'note','')),'');
      if length(coalesce(entry_note,'')) > 1000 then raise exception 'Receipt note is too long'; end if;
      if exists(select 1 from jsonb_array_elements(requested) x where x->>'item_id'=lower(entry->>'item_id')) then
        raise exception 'Use one receipt line per inventory item';
      end if;
      requested := requested || jsonb_build_array(jsonb_build_object(
        'item_id',lower(entry->>'item_id'),'quantity',qty,'unit_cost',price,'note',entry_note));
    end loop;
    if exists(select 1 from public.purchase_order_receipts r where r.order_id=p_id and r.request_id=request_key) then
      if (select count(*) from public.purchase_order_receipts r where r.order_id=p_id and r.request_id=request_key)
           = jsonb_array_length(requested)
         and not exists (
           select 1 from jsonb_array_elements(requested) x
           where not exists (select 1 from public.purchase_order_receipts r
             where r.order_id=p_id and r.request_id=request_key
               and r.item_id=(x->>'item_id')::uuid and r.quantity=(x->>'quantity')::numeric)) then
        return result;
      end if;
      raise exception 'This receipt request ID was already used for different quantities';
    end if;
  end if;

  if p_version is null or result.version <> p_version then raise exception 'Order changed. Refresh before continuing'; end if;

  if p_action='update' and result.status='draft' then
    update public.purchase_orders set supplier_id=p_supplier_id,lines=normalized,note=coalesce(p_note,''),
      expected_delivery_date=coalesce(p_expected_delivery_date,expected_delivery_date)
    where id=p_id;
    perform private.purchase_order_log_event(p_id,'updated',from_status,'draft',actor,jsonb_build_object(
      'supplier_id',p_supplier_id,'lines',jsonb_array_length(normalized),'total',private.purchase_order_total(normalized),
      'expected_delivery_date',coalesce(p_expected_delivery_date,result.expected_delivery_date)));

  elsif p_action='set_delivery_date' and result.status in ('draft','pending_approval','approved','ordered','partially_received') then
    update public.purchase_orders set expected_delivery_date=p_expected_delivery_date where id=p_id;
    perform private.purchase_order_log_event(p_id,'delivery_date_set',from_status,from_status,actor,
      jsonb_build_object('from',result.expected_delivery_date,'to',p_expected_delivery_date));

  elsif p_action='submit' and result.status='draft' then
    if not private.purchase_order_approval_needed(result.lines, policy) then
      raise exception 'This order does not need approval. Mark it as ordered instead';
    end if;
    update public.purchase_orders set status='pending_approval',submitted_by=actor,submitted_at=now(),
      approved_by=null,approved_at=null where id=p_id;
    perform private.purchase_order_log_event(p_id,'submitted',from_status,'pending_approval',actor,
      jsonb_build_object('total',private.purchase_order_total(result.lines)));

  elsif p_action='approve' and result.status='pending_approval' then
    select profile.role::text into actor_role from public.profiles profile where profile.id=actor;
    if policy->>'approval_approver_role'='admin' and actor_role is distinct from 'admin' then
      raise exception 'Only an administrator can approve purchase orders' using errcode='42501';
    end if;
    if (policy->>'approval_separate_approver')::boolean and result.submitted_by=actor then
      raise exception 'Another manager must approve this order' using errcode='42501';
    end if;
    update public.purchase_orders set status='approved',approved_by=actor,approved_at=now() where id=p_id;
    perform private.purchase_order_log_event(p_id,'approved',from_status,'approved',actor,
      jsonb_build_object('total',private.purchase_order_total(result.lines)));

  elsif p_action='reject' and result.status='pending_approval' then
    if nullif(btrim(coalesce(p_reason,'')),'') is null or length(p_reason) > 1000 then
      raise exception 'A reason (up to 1000 characters) is required';
    end if;
    update public.purchase_orders set status='draft',submitted_by=null,submitted_at=null where id=p_id;
    perform private.purchase_order_log_event(p_id,'rejected',from_status,'draft',actor,
      jsonb_build_object('reason',btrim(p_reason)));

  elsif p_action='place' and result.status in ('draft','approved') then
    if result.status='draft' and private.purchase_order_approval_needed(result.lines, policy) then
      raise exception 'This order needs approval before it is placed';
    end if;
    if (policy->>'delivery_date_required_on_place')::boolean and result.expected_delivery_date is null then
      raise exception 'Set an expected delivery date before placing the order';
    end if;
    update public.purchase_orders set status='ordered',ordered_at=now() where id=p_id;
    perform private.purchase_order_log_event(p_id,'ordered',from_status,'ordered',actor,
      jsonb_build_object('expected_delivery_date',result.expected_delivery_date,
        'total',private.purchase_order_total(result.lines)));

  elsif p_action='cancel' and result.status in ('draft','pending_approval','approved','ordered') then
    if exists(select 1 from public.purchase_order_receipts r where r.order_id=p_id) then
      raise exception 'This order has received lines and cannot be cancelled';
    end if;
    update public.purchase_orders set status='cancelled' where id=p_id;
    perform private.purchase_order_log_event(p_id,'cancelled',from_status,'cancelled',actor,
      jsonb_build_object('reason',nullif(btrim(coalesce(p_reason,'')),'')));

  elsif p_action='close_short' and result.status='partially_received' then
    if not (policy->>'short_close_enabled')::boolean then
      raise exception 'Closing an order with missing lines is not enabled';
    end if;
    if nullif(btrim(coalesce(p_reason,'')),'') is null or length(p_reason) > 1000 then
      raise exception 'A reason (up to 1000 characters) is required';
    end if;
    update public.purchase_orders set status='received',received_at=now(),closed_short=true,close_reason=btrim(p_reason)
    where id=p_id;
    perform private.purchase_order_log_event(p_id,'closed_short',from_status,'received',actor,jsonb_build_object(
      'reason',btrim(p_reason),
      'missing',(select coalesce(jsonb_agg(jsonb_build_object('item_id',l->>'item_id',
          'remaining',(l->>'quantity')::numeric - coalesce((select sum(r.quantity) from public.purchase_order_receipts r
             where r.order_id=p_id and r.item_id=(l->>'item_id')::uuid),0))),'[]'::jsonb)
        from jsonb_array_elements(result.lines) l)));

  elsif p_action in ('receive','receive_lines') and result.status in ('ordered','partially_received') then
    if p_action='receive' then
      -- v1 "receive all": every remaining quantity at the line cost.
      request_key := 'receive-all:'||result.version::text;
      requested := '[]'::jsonb;
      for line in select value from jsonb_array_elements(result.lines) loop
        qty := (line->>'quantity')::numeric - coalesce((select sum(r.quantity) from public.purchase_order_receipts r
          where r.order_id=p_id and r.item_id=(line->>'item_id')::uuid),0);
        if qty > 0 then
          requested := requested || jsonb_build_array(jsonb_build_object(
            'item_id',line->>'item_id','quantity',qty,'unit_cost',null,'note',null));
        end if;
      end loop;
      if jsonb_array_length(requested) = 0 then raise exception 'Nothing remains to be received'; end if;
    end if;
    -- Lock inventory in a stable order. Every movement and the transition
    -- share this transaction: either the whole receipt is recorded or none.
    for entry in select value from jsonb_array_elements(requested) order by value->>'item_id' loop
      line := null;
      select l.value into line from jsonb_array_elements(result.lines) l where l.value->>'item_id'=entry->>'item_id';
      if line is null then raise exception 'Receipt item is not on this order'; end if;
      select * into item from public.inventory_items where id=(entry->>'item_id')::uuid for update;
      if item.id is null or item.active is not true or item.unit is distinct from line->>'unit' then
        raise exception 'Order item changed. Review the order before receiving';
      end if;
      qty := (entry->>'quantity')::numeric;
      line_qty := (line->>'quantity')::numeric;
      received := coalesce((select sum(r.quantity) from public.purchase_order_receipts r
        where r.order_id=p_id and r.item_id=item.id),0);
      allowance := line_qty * (1 + (policy->>'over_receipt_tolerance_percent')::numeric / 100) - received;
      if qty > allowance then
        raise exception 'Received quantity is more than was ordered for %', item.name;
      end if;
      price := coalesce((entry->>'unit_cost')::numeric,(line->>'unit_cost')::numeric);
      prev_cost := item.cost_price;
      insert into public.purchase_order_receipts(order_id,request_id,item_id,quantity,unit_cost,ordered_unit_cost,note,received_by)
      values (p_id,request_key,item.id,qty,price,(line->>'unit_cost')::numeric,entry->>'note',actor)
      returning id into receipt_id;
      perform public.adjust_inventory(item.id,qty,'restock',price,result.supplier_id,
        'Purchase order '||p_id::text||' receipt '||receipt_id::text);
      select m.id into movement from public.inventory_movements m
      where m.item_id=item.id and m.note='Purchase order '||p_id::text||' receipt '||receipt_id::text
      order by m.created_at desc limit 1;
      update public.purchase_order_receipts set movement_id=movement where id=receipt_id;
      if policy->>'receipt_cost_mode'='record_only' then
        update public.inventory_items set cost_price=prev_cost where id=item.id and cost_price is distinct from prev_cost;
      end if;
      receipt_log := receipt_log || jsonb_build_array(jsonb_build_object(
        'receipt_id',receipt_id,'item_id',item.id,'quantity',qty,'unit_cost',price,
        'ordered_unit_cost',(line->>'unit_cost')::numeric,'movement_id',movement));
    end loop;
    select bool_and(coalesce((select sum(r.quantity) from public.purchase_order_receipts r
        where r.order_id=p_id and r.item_id=(l->>'item_id')::uuid),0) >= (l->>'quantity')::numeric)
      into complete from jsonb_array_elements(result.lines) l;
    next_status := case when complete then 'received' else 'partially_received' end;
    update public.purchase_orders set status=next_status,
      received_at=case when complete then now() else received_at end
    where id=p_id;
    perform private.purchase_order_log_event(p_id,case when complete then 'received' else 'received_partial' end,
      from_status,next_status,actor,jsonb_build_object('request_id',request_key,'receipts',receipt_log,
        'cost_mode',policy->>'receipt_cost_mode','via',p_action));
  else
    raise exception 'This transition is not allowed for the current order state';
  end if;
  update public.purchase_orders set version=version+1,updated_at=now(),updated_by=actor
  where id=p_id returning * into result;
  return result;
end
$function$;
revoke all on function private.purchase_order_command_v2(uuid,text,integer,uuid,jsonb,text,date,jsonb,text,text) from public,anon;
grant execute on function private.purchase_order_command_v2(uuid,text,integer,uuid,jsonb,text,date,jsonb,text,text) to authenticated;

create or replace function public.atlas_purchase_order_command_v2(
  p_id uuid, p_action text, p_version integer default null,
  p_supplier_id uuid default null, p_lines jsonb default null, p_note text default '',
  p_expected_delivery_date date default null, p_receipt jsonb default null,
  p_request_id text default null, p_reason text default null
) returns public.purchase_orders language sql security invoker set search_path = ''
as $function$
  select private.purchase_order_command_v2(p_id,p_action,p_version,p_supplier_id,p_lines,p_note,
    p_expected_delivery_date,p_receipt,p_request_id,p_reason);
$function$;
revoke all on function public.atlas_purchase_order_command_v2(uuid,text,integer,uuid,jsonb,text,date,jsonb,text,text) from public,anon;
grant execute on function public.atlas_purchase_order_command_v2(uuid,text,integer,uuid,jsonb,text,date,jsonb,text,text) to authenticated;

-- v1 keeps its signature, grants and action list; it now shares the v2 rules
-- (receive = receive every remaining quantity; approval, when enabled, applies).
create or replace function private.purchase_order_command(
  p_id uuid, p_action text, p_version integer,
  p_supplier_id uuid, p_lines jsonb, p_note text
) returns public.purchase_orders
language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  if p_id is null or p_action is null or p_action not in ('create','update','place','receive','cancel') then
    raise exception 'Invalid purchase order command';
  end if;
  return private.purchase_order_command_v2(p_id,p_action,p_version,p_supplier_id,p_lines,p_note,
    null,null,null,null);
end
$function$;
revoke all on function private.purchase_order_command(uuid,text,integer,uuid,jsonb,text) from public,anon;
grant execute on function private.purchase_order_command(uuid,text,integer,uuid,jsonb,text) to authenticated;

-- Policy flags for the UI (the server still enforces them).
create or replace function private.purchase_order_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  return private.purchase_order_policy_values()
    || jsonb_build_object('venue_date', private.purchase_order_venue_date());
end
$function$;
revoke all on function private.purchase_order_policy() from public,anon;
grant execute on function private.purchase_order_policy() to authenticated;

create or replace function public.atlas_purchase_order_policy()
returns jsonb language sql stable security invoker set search_path = ''
as $function$ select private.purchase_order_policy(); $function$;
revoke all on function public.atlas_purchase_order_policy() from public,anon;
grant execute on function public.atlas_purchase_order_policy() to authenticated;

-- One order with per-line received/remaining quantities, receipts and history.
create or replace function private.purchase_order_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result public.purchase_orders;
  policy jsonb;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  select * into result from public.purchase_orders where id=p_id;
  if result.id is null then raise exception 'Order not found'; end if;
  policy := private.purchase_order_policy_values();
  return jsonb_build_object(
    'order', to_jsonb(result),
    'total', private.purchase_order_total(result.lines),
    'approval_needed', private.purchase_order_approval_needed(result.lines, policy),
    'lines', (select coalesce(jsonb_agg(l || jsonb_build_object(
        'received_quantity', rec.received,
        'remaining_quantity', greatest((l->>'quantity')::numeric - rec.received, 0)) order by ord),'[]'::jsonb)
      from jsonb_array_elements(result.lines) with ordinality as x(l, ord)
      cross join lateral (select coalesce(sum(r.quantity),0) as received from public.purchase_order_receipts r
        where r.order_id=p_id and r.item_id=(l->>'item_id')::uuid) rec),
    'receipts', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',r.id,'request_id',r.request_id,'item_id',r.item_id,'quantity',r.quantity,'unit_cost',r.unit_cost,
        'ordered_unit_cost',r.ordered_unit_cost,'movement_id',r.movement_id,'note',r.note,
        'received_by',r.received_by,'received_at',r.received_at) order by r.received_at, r.item_id),'[]'::jsonb)
      from public.purchase_order_receipts r where r.order_id=p_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',e.id,'event_type',e.event_type,'from_status',e.from_status,'to_status',e.to_status,
        'actor_id',e.actor_id,'payload',e.payload,'created_at',e.created_at) order by e.created_at, e.id),'[]'::jsonb)
      from public.purchase_order_events e where e.order_id=p_id),
    'policy', policy || jsonb_build_object('venue_date', private.purchase_order_venue_date())
  );
end
$function$;
revoke all on function private.purchase_order_detail(uuid) from public,anon;
grant execute on function private.purchase_order_detail(uuid) to authenticated;

create or replace function public.atlas_purchase_order_detail(p_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $function$ select private.purchase_order_detail(p_id); $function$;
revoke all on function public.atlas_purchase_order_detail(uuid) from public,anon;
grant execute on function public.atlas_purchase_order_detail(uuid) to authenticated;

notify pgrst, 'reload schema';
