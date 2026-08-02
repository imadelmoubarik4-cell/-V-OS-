-- Recovered from Supabase migration history for project dnefgcmjcgxlynycxkts.
-- This file preserves the SQL already recorded as applied; do not rewrite it.

alter table public.recipes
  add column if not exists glassware text,
  add column if not exists garnish text,
  add column if not exists method text,
  add column if not exists notes text,
  add column if not exists image_url text,
  add column if not exists active boolean not null default true;

grant select, insert, update, delete on public.recipes to authenticated;
grant select, insert, update, delete on public.recipe_ingredients to authenticated;

create index if not exists recipes_type_idx on public.recipes(type);
create index if not exists recipes_active_idx on public.recipes(active);
create index if not exists recipe_ingredients_recipe_id_idx on public.recipe_ingredients(recipe_id);
create index if not exists recipe_ingredients_item_id_idx on public.recipe_ingredients(item_id);
