-- Checkpoint K closure: remove duplicate manager-only policies left by earlier
-- preview hardening. The canonical policies created by 20260805223000 remain.

-- Inventory keeps authenticated staff read/add/update plus manager-only delete.
drop policy if exists "active managers read inventory" on public.inventory_items;
drop policy if exists "active managers add inventory" on public.inventory_items;
drop policy if exists "active managers update inventory" on public.inventory_items;
drop policy if exists "active managers delete inventory" on public.inventory_items;

-- Supplier access keeps staff read plus one manager-only policy per write action.
drop policy if exists "active managers read suppliers" on public.suppliers;
drop policy if exists "active managers add suppliers" on public.suppliers;
drop policy if exists "active managers update suppliers" on public.suppliers;
drop policy if exists "active managers delete suppliers" on public.suppliers;
