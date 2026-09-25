-- S89 RELEASE-GATED: revoke direct browser INSERT on public.inventory_items.
--
-- Ship this file ONLY in the same release as the inventory UI switch that
-- creates items through atlas-item-master ?action=create-item (the guarded,
-- duplicate-checked public.atlas_catalog_create_item). Before that switch the
-- legacy "Add item" form in apps/web/index.html inserts directly and would
-- fail with "permission denied". Owner: E3 (inventory UI) + release lead.
--
-- After this migration no browser role can insert inventory items: every new
-- item passes the mandatory duplicate guard, starts at quantity 0 and is
-- audited in atlas_private.catalog_events. Updates and deletes keep their
-- existing manager policies (the item-edit path moves in a later release).
-- Server paths (service_role, migrations) are unaffected.

revoke insert on table public.inventory_items from anon, authenticated;

drop policy if exists "active managers add inventory items" on public.inventory_items;
drop policy if exists "active managers add inventory" on public.inventory_items;
drop policy if exists "authenticated staff add inventory" on public.inventory_items;

comment on table public.inventory_items is
  'Inventory catalogue. S89: browsers cannot insert; new items are created only by atlas_catalog_create_item (duplicate-guarded, quantity 0, audited).';

notify pgrst, 'reload schema';
