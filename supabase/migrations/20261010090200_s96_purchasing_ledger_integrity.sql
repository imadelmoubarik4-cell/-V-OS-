-- S96 (security hardening, findings DBRLS-04 and DBRLS-05): server-authoritative purchasing
-- values and an append-only stock ledger for browser roles.
--
-- DBRLS-04  Purchase approval could be bypassed through the receipt price. Approval is decided
--   from the order lines (private.purchase_order_approval_needed), but receive_lines accepts a
--   per-line unit_cost with no bound: a manager could create an order at 1 ISK per unit (under
--   the approval threshold), place it without approval, then receive it at the real price
--   (e.g. 500 ISK), which records the receipt, the stock movement value and - in the default
--   update_item_cost mode - the item cost as if the order had been approved. Proven on the
--   local replay with approval enabled (threshold 1000 ISK, 10 x 500 ISK received unapproved).
--   A BEFORE INSERT trigger on public.purchase_order_receipts now re-prices the order with the
--   highest cost received so far per line; when that re-priced order would need approval and
--   the order was never approved, or its re-priced total exceeds the total that was approved,
--   the receipt is rejected. With approval switched off (production default) the guard is a
--   no-op. Receiving at or below the ordered cost is never affected.
--
-- DBRLS-05  public.inventory_movements is the stock ledger read by Reports, par-level
--   evidence (restock sums) and Atlas AI cost-change answers. Browser managers could INSERT
--   arbitrary rows (any movement_type, quantity_change and total_cost) that never touched
--   stock, fabricating restocks or costs. No client inserts directly: every product path
--   writes through private SECURITY DEFINER functions (adjust_inventory*, purchase receiving)
--   or service-role RPCs. The browser INSERT privilege and policy are removed; SELECT for
--   managers is unchanged; UPDATE/DELETE were never granted.

create or replace function private.purchase_order_receipt_price_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  policy jsonb := private.purchase_order_policy_values();
  ord public.purchase_orders;
  repriced jsonb;
begin
  if new.unit_cost is null or new.ordered_unit_cost is null or new.unit_cost <= new.ordered_unit_cost then
    return new;
  end if;
  select * into ord from public.purchase_orders where id = new.order_id;
  if ord.id is null then
    return new;
  end if;
  select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_set(l, '{unit_cost}', pg_catalog.to_jsonb(greatest(
             (l->>'unit_cost')::numeric,
             coalesce((select max(r.unit_cost) from public.purchase_order_receipts r
                       where r.order_id = new.order_id and r.item_id::text = l->>'item_id'), 0),
             case when l->>'item_id' = new.item_id::text then new.unit_cost else 0 end)))
           order by ord_no), '[]'::jsonb)
    into repriced
  from pg_catalog.jsonb_array_elements(ord.lines) with ordinality as x(l, ord_no);
  if private.purchase_order_approval_needed(repriced, policy)
     and (ord.approved_by is null
          or private.purchase_order_total(repriced) > private.purchase_order_total(ord.lines)) then
    raise exception 'The received unit cost is above the ordered cost and would change an order that needs approval. Update the order and get it approved first.'
      using errcode = '42501';
  end if;
  return new;
end
$function$;

revoke all on function private.purchase_order_receipt_price_guard() from public, anon, authenticated;

drop trigger if exists purchase_order_receipts_s96_price_guard on public.purchase_order_receipts;
create trigger purchase_order_receipts_s96_price_guard
  before insert on public.purchase_order_receipts
  for each row execute function private.purchase_order_receipt_price_guard();

revoke insert on table public.inventory_movements from anon, authenticated;
drop policy if exists "active managers add inventory movements" on public.inventory_movements;

comment on table public.inventory_movements is
  'Stock ledger. S96: browser roles read only (managers); rows are written by private definer functions and service-role RPCs.';

notify pgrst, 'reload schema';
