-- Incremental Phase 1 purchase orders. No backfill and no automatic publication.
-- Browser writes go through the checked command API; direct writes are revoked.
create table public.purchase_orders (
  id uuid primary key,
  supplier_id uuid not null references public.suppliers(id),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  note text not null default '' check (length(note) <= 2000),
  status text not null default 'draft' check (status in ('draft','ordered','received','cancelled')),
  version integer not null default 1,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  received_at timestamptz
);
create index purchase_orders_supplier_idx on public.purchase_orders(supplier_id);
create index purchase_orders_created_by_idx on public.purchase_orders(created_by);
create index purchase_orders_updated_by_idx on public.purchase_orders(updated_by);
alter table public.purchase_orders enable row level security;
revoke all on public.purchase_orders from public, anon, authenticated;
grant select on public.purchase_orders to authenticated;
grant all on public.purchase_orders to service_role;
create policy "active managers read purchase orders" on public.purchase_orders
for select to authenticated using (private.is_manager_or_admin());

create function private.purchase_order_command(
  p_id uuid, p_action text, p_version integer,
  p_supplier_id uuid, p_lines jsonb, p_note text
) returns public.purchase_orders
language plpgsql security definer set search_path = ''
as $function$
declare
  result public.purchase_orders;
  line jsonb;
  item public.inventory_items;
  normalized jsonb := '[]'::jsonb;
  qty numeric;
  price numeric;
  actor uuid := auth.uid();
begin
  if actor is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  if p_id is null or p_action is null or p_action not in ('create','update','place','receive','cancel') then
    raise exception 'Invalid purchase order command';
  end if;
  -- Same order ID serializes creation retries as well as later transitions.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  select * into result from public.purchase_orders where id=p_id for update;

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
        if result.created_by=actor and result.supplier_id=p_supplier_id and result.lines=normalized and result.note=coalesce(p_note,'') then
          return result;
        end if;
        raise exception 'This order ID already belongs to a different request';
      end if;
      insert into public.purchase_orders(id,supplier_id,lines,note,created_by,updated_by)
      values(p_id,p_supplier_id,normalized,coalesce(p_note,''),actor,actor) returning * into result;
      return result;
    end if;
  end if;
  if result.id is null then raise exception 'Order not found'; end if;
  -- A repeated receive/cancel/place request never applies a second movement.
  if (p_action='receive' and result.status='received') or
     (p_action='cancel' and result.status='cancelled') or
     (p_action='place' and result.status='ordered') then return result; end if;
  if p_version is null or result.version <> p_version then raise exception 'Order changed. Refresh before continuing'; end if;
  if p_action='update' and result.status='draft' then
    update public.purchase_orders set supplier_id=p_supplier_id,lines=normalized,note=coalesce(p_note,'') where id=p_id;
  elsif p_action='place' and result.status='draft' then
    update public.purchase_orders set status='ordered' where id=p_id;
  elsif p_action='cancel' and result.status in ('draft','ordered') then
    update public.purchase_orders set status='cancelled' where id=p_id;
  elsif p_action='receive' and result.status='ordered' then
    -- Lock inventory in a stable order. The checked adjustment and transition
    -- share this transaction: either every line is received or none is.
    for line in select value from jsonb_array_elements(result.lines) order by value->>'item_id' loop
      select * into item from public.inventory_items where id=(line->>'item_id')::uuid for update;
      if item.id is null or item.active is not true or item.unit is distinct from line->>'unit' then
        raise exception 'Order item changed. Review the order before receiving';
      end if;
      perform public.adjust_inventory(item.id,(line->>'quantity')::numeric,'restock',
        (line->>'unit_cost')::numeric,result.supplier_id,'Purchase order '||p_id::text);
    end loop;
    update public.purchase_orders set status='received',received_at=now() where id=p_id;
  else
    raise exception 'This transition is not allowed for the current order state';
  end if;
  update public.purchase_orders set version=version+1,updated_at=now(),updated_by=actor
  where id=p_id returning * into result;
  return result;
end
$function$;
revoke all on function private.purchase_order_command(uuid,text,integer,uuid,jsonb,text) from public,anon;
grant execute on function private.purchase_order_command(uuid,text,integer,uuid,jsonb,text) to authenticated;

create function public.atlas_purchase_order_command(
  p_id uuid, p_action text, p_version integer default null,
  p_supplier_id uuid default null, p_lines jsonb default null, p_note text default ''
) returns public.purchase_orders language sql security invoker set search_path = ''
as $function$
  select private.purchase_order_command(p_id,p_action,p_version,p_supplier_id,p_lines,p_note);
$function$;
revoke all on function public.atlas_purchase_order_command(uuid,text,integer,uuid,jsonb,text) from public,anon;
grant execute on function public.atlas_purchase_order_command(uuid,text,integer,uuid,jsonb,text) to authenticated;
notify pgrst, 'reload schema';
