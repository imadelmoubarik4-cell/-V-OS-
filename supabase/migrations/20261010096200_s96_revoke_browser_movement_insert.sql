-- S96 (opsrisk): browsers may not write the stock movement ledger directly.
--
-- public.inventory_movements is the stock audit ledger (restocks feed the
-- par-level usage model in s88 data review). Authenticated managers held
-- INSERT on it through policy "active managers add inventory movements"
-- whose WITH CHECK only tests the caller's role, so a manager session could
-- insert rows with any created_by (another person's id), any created_at
-- (backdated) and any movement_type/quantity_change: forged, misattributed
-- audit history. No Atlas surface uses this grant: apps/web on main
-- (f0f3f40) and on 994fa5f only SELECT from the table, and every server
-- write goes through SECURITY DEFINER RPCs (stock adjust, purchase-order
-- receiving, stock-count publication), which are unaffected.

drop policy if exists "active managers add inventory movements" on public.inventory_movements;
revoke insert on table public.inventory_movements from authenticated, anon;
