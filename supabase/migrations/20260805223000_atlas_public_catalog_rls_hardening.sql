-- Checkpoint K closure: make the public catalog RLS contract explicit.
--
-- The browser may contain the Supabase publishable key. Safety therefore depends
-- on both least-privilege table grants and row-level policies. Legacy migrations
-- left broad client grants in place and overlapping permissive recipe policies
-- allowed any authenticated account to write recipes and recipe ingredients.
-- This migration preserves intended staff reads, preserves the existing staff
-- inventory count/update workflow, and makes recipe/supplier writes manager-only.

alter table public.inventory_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.suppliers enable row level security;

-- Client roles need only Data API operations. Do not grant TRUNCATE, TRIGGER or
-- REFERENCES to browser roles.
revoke all privileges on table public.inventory_items from anon, authenticated;
revoke all privileges on table public.recipes from anon, authenticated;
revoke all privileges on table public.recipe_ingredients from anon, authenticated;
revoke all privileges on table public.suppliers from anon, authenticated;

grant select, insert, update, delete on table public.inventory_items to authenticated;
grant select on table public.recipes to anon;
grant select, insert, update, delete on table public.recipes to authenticated;
grant select, insert, update, delete on table public.recipe_ingredients to authenticated;
grant select, insert, update, delete on table public.suppliers to authenticated;

grant all privileges on table public.inventory_items to service_role;
grant all privileges on table public.recipes to service_role;
grant all privileges on table public.recipe_ingredients to service_role;
grant all privileges on table public.suppliers to service_role;

-- Inventory: authenticated staff can read, add and update. Destructive deletion
-- remains manager/admin only.
drop policy if exists "authenticated staff read inventory" on public.inventory_items;
drop policy if exists "authenticated staff add inventory" on public.inventory_items;
drop policy if exists "authenticated staff update inventory" on public.inventory_items;
drop policy if exists "managers delete inventory" on public.inventory_items;

create policy "authenticated staff read inventory"
  on public.inventory_items for select to authenticated
  using ((select auth.uid()) is not null);

create policy "authenticated staff add inventory"
  on public.inventory_items for insert to authenticated
  with check ((select auth.uid()) is not null);

create policy "authenticated staff update inventory"
  on public.inventory_items for update to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

create policy "managers delete inventory"
  on public.inventory_items for delete to authenticated
  using ((select private.is_manager_or_admin()));

-- Recipes: public guests may read only menu-visible recipes. Signed-in staff may
-- read the working catalog. Only managers/admins may mutate it.
drop policy if exists "public reads visible recipes" on public.recipes;
drop policy if exists "staff can read recipes" on public.recipes;
drop policy if exists "staff read recipes" on public.recipes;
drop policy if exists "staff can write recipes" on public.recipes;
drop policy if exists "staff can update recipes" on public.recipes;
drop policy if exists "staff can delete recipes" on public.recipes;
drop policy if exists "managers add recipes" on public.recipes;
drop policy if exists "managers update recipes" on public.recipes;
drop policy if exists "managers delete recipes" on public.recipes;

create policy "public reads visible recipes"
  on public.recipes for select to anon
  using (show_on_menu = true);

create policy "staff read recipes"
  on public.recipes for select to authenticated
  using ((select auth.uid()) is not null);

create policy "managers add recipes"
  on public.recipes for insert to authenticated
  with check ((select private.is_manager_or_admin()));

create policy "managers update recipes"
  on public.recipes for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));

create policy "managers delete recipes"
  on public.recipes for delete to authenticated
  using ((select private.is_manager_or_admin()));

-- Recipe ingredients follow the same manager-write/staff-read boundary.
drop policy if exists "staff can read recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff read recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff can write recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff can update recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff can delete recipe ingredients" on public.recipe_ingredients;
drop policy if exists "managers add recipe ingredients" on public.recipe_ingredients;
drop policy if exists "managers update recipe ingredients" on public.recipe_ingredients;
drop policy if exists "managers delete recipe ingredients" on public.recipe_ingredients;

create policy "staff read recipe ingredients"
  on public.recipe_ingredients for select to authenticated
  using ((select auth.uid()) is not null);

create policy "managers add recipe ingredients"
  on public.recipe_ingredients for insert to authenticated
  with check ((select private.is_manager_or_admin()));

create policy "managers update recipe ingredients"
  on public.recipe_ingredients for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));

create policy "managers delete recipe ingredients"
  on public.recipe_ingredients for delete to authenticated
  using ((select private.is_manager_or_admin()));

-- Supplier data remains available to signed-in operational staff, while all
-- supplier mutations remain manager/admin only.
drop policy if exists "staff read suppliers" on public.suppliers;
drop policy if exists "managers add suppliers" on public.suppliers;
drop policy if exists "managers update suppliers" on public.suppliers;
drop policy if exists "managers delete suppliers" on public.suppliers;

create policy "staff read suppliers"
  on public.suppliers for select to authenticated
  using ((select auth.uid()) is not null);

create policy "managers add suppliers"
  on public.suppliers for insert to authenticated
  with check ((select private.is_manager_or_admin()));

create policy "managers update suppliers"
  on public.suppliers for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));

create policy "managers delete suppliers"
  on public.suppliers for delete to authenticated
  using ((select private.is_manager_or_admin()));

comment on table public.recipes is
  'Recipe catalog: menu-visible rows may be read anonymously; signed-in staff may read all rows; manager/admin role is required for mutation.';
comment on table public.recipe_ingredients is
  'Recipe ingredients: signed-in staff read; manager/admin role required for mutation.';
comment on table public.suppliers is
  'Supplier catalog: signed-in staff read; manager/admin role required for mutation.';
