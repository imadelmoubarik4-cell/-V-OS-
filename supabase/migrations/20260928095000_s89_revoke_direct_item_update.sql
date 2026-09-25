-- S89 RELEASE-GATED: revoke direct browser UPDATE on public.inventory_items.
-- (Security review S88b G4.)
--
-- Apply this file ONLY after the new web app is deployed, the same way as
-- 20260927099000_s89_revoke_direct_item_insert.sql. The new app never updates
-- inventory_items directly: item edits go through atlas-item-master
-- (catalog-request metadata_correction, set_item_active, publish), par levels
-- through atlas_apply_par_levels, stock through adjust_inventory, stock count
-- publish and purchasing receive. An older web build that still PATCHes
-- inventory_items would fail with "permission denied".
-- Requires 20260928093000_s89_item_change_audit.sql (adjust_inventory applies
-- through the private definer private.adjust_inventory_apply).
-- Owner: E3 (inventory UI) + release lead.
--
-- After this migration a browser session can no longer rename an item, change
-- its par level, category, supplier, cost or active flag with a PostgREST
-- PATCH, bypassing catalogue governance. Every remaining path is a server or
-- private-definer path and is audited (item_master_events 'item_changed').
-- Reads (SELECT) and the guarded manager DELETE are unchanged. Server paths
-- (service_role, private SECURITY DEFINER functions, migrations) are unaffected.

revoke update on table public.inventory_items from anon, authenticated;

drop policy if exists "active managers update inventory items" on public.inventory_items;
drop policy if exists "active managers update inventory" on public.inventory_items;
drop policy if exists "authenticated staff update inventory" on public.inventory_items;

comment on table public.inventory_items is
  'Inventory catalogue. S89: browsers cannot insert or update; items are created by atlas_catalog_create_item and changed only through governed server/RPC paths (audited in atlas_private.item_master_events and catalog_events).';

notify pgrst, 'reload schema';
