-- Phase 1 runtime correction: recipe_ingredients has no created_at column.
-- Keep the staff-safe recipe projection deterministic without referencing a
-- column that is absent from the canonical schema.

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
        order by ingredient.id
      )
      from public.recipe_ingredients as ingredient
      where ingredient.recipe_id = recipe.id
    ), '[]'::jsonb)
  from public.recipes as recipe;
end;
$function$;

revoke all on function private.read_recipe_catalog() from public, anon;
grant execute on function private.read_recipe_catalog()
  to authenticated, service_role;

notify pgrst, 'reload schema';
