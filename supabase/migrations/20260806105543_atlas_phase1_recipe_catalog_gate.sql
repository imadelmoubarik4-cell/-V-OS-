-- Phase 1 recipe hardening: staff receive an operational projection while
-- commercial recipe cost fields remain manager-only.

drop policy if exists "active staff read recipes" on public.recipes;
drop policy if exists "active managers read recipes" on public.recipes;
create policy "active managers read recipes"
  on public.recipes
  for select
  to authenticated
  using (private.is_manager_or_admin());

drop policy if exists "active staff read recipe ingredients" on public.recipe_ingredients;
drop policy if exists "active managers read recipe ingredients" on public.recipe_ingredients;
create policy "active managers read recipe ingredients"
  on public.recipe_ingredients
  for select
  to authenticated
  using (private.is_manager_or_admin());

create or replace function private.read_recipe_catalog()
returns table (
  id uuid,
  category_id uuid,
  name text,
  type text,
  method text,
  yield_quantity numeric,
  yield_unit text,
  menu_price numeric,
  active boolean,
  show_on_menu boolean,
  glassware text,
  garnish text,
  notes text,
  image_url text,
  updated_at timestamptz,
  recipe_ingredients jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres'
     and not private.is_active_staff() then
    raise exception 'An active Atlas profile is required'
      using errcode = '42501';
  end if;

  return query
  select
    recipe.id,
    recipe.category_id,
    recipe.name,
    recipe.type,
    recipe.method,
    recipe.yield_quantity,
    recipe.yield_unit,
    recipe.menu_price,
    recipe.active,
    recipe.show_on_menu,
    recipe.glassware,
    recipe.garnish,
    recipe.notes,
    recipe.image_url,
    recipe.updated_at,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', ingredient.id,
          'recipe_id', ingredient.recipe_id,
          'item_id', ingredient.item_id,
          'item_name', ingredient.item_name,
          'quantity', ingredient.quantity,
          'unit', ingredient.unit
        )
        order by ingredient.created_at, ingredient.id
      )
      from public.recipe_ingredients as ingredient
      where ingredient.recipe_id = recipe.id
    ), '[]'::jsonb)
  from public.recipes as recipe;
end;
$function$;

drop view if exists public.recipe_catalog;
create view public.recipe_catalog
with (security_invoker = true)
as
select *
from private.read_recipe_catalog();

revoke all on function private.read_recipe_catalog() from public, anon;
grant execute on function private.read_recipe_catalog()
  to authenticated, service_role;
revoke all on table public.recipe_catalog from public, anon;
grant select on table public.recipe_catalog
  to authenticated, service_role;

comment on view public.recipe_catalog is
  'Active-staff operational recipe projection. Ingredient and recipe cost fields are intentionally omitted.';

notify pgrst, 'reload schema';