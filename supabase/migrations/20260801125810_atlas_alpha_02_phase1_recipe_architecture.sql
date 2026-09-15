-- Recovered from Supabase migration history for project dnefgcmjcgxlynycxkts.
-- This file preserves the SQL already recorded as applied; do not rewrite it.

create table if not exists public.recipe_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  icon text not null default 'layers-3',
  display_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at_recipe_categories()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_recipe_categories_updated_at on public.recipe_categories;
create trigger trg_recipe_categories_updated_at
before update on public.recipe_categories
for each row execute function public.set_updated_at_recipe_categories();

insert into public.recipe_categories (slug, name, description, icon, display_order)
values
  ('signature-cocktail', 'Signature Cocktails', 'VÁ originals and house signatures.', 'sparkles', 10),
  ('classic-cocktail', 'Classic Cocktails', 'Established classics and modern standards.', 'martini', 20),
  ('frozen-cocktail', 'Frozen Cocktails', 'Blended and frozen service recipes.', 'snowflake', 30),
  ('spritz', 'Spritzes', 'Sparkling, wine-based long drinks.', 'wine', 40),
  ('mocktail', 'Mocktails', 'Alcohol-free cocktails and zero-proof serves.', 'citrus', 50),
  ('coffee', 'Coffee', 'Espresso bar and coffee service recipes.', 'coffee', 60),
  ('hot-cocktail', 'Hot Cocktails', 'Warm cocktails and after-dinner serves.', 'flame', 70),
  ('food', 'Food', 'Kitchen and tapas specifications.', 'utensils', 80),
  ('dessert', 'Dessert', 'Dessert recipes and sweet service items.', 'cake-slice', 90),
  ('other', 'Other', 'Unclassified or operational recipes.', 'layers-3', 100)
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description,
    icon = excluded.icon,
    display_order = excluded.display_order;

alter table public.recipes add column if not exists category_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'recipes_category_id_fkey'
      and conrelid = 'public.recipes'::regclass
  ) then
    alter table public.recipes
      add constraint recipes_category_id_fkey
      foreign key (category_id)
      references public.recipe_categories(id)
      on delete set null;
  end if;
end;
$$;

update public.recipes r
set category_id = c.id
from public.recipe_categories c
where r.category_id is null
  and c.slug = case
    when r.type in ('signature-cocktail', 'classic-cocktail', 'frozen-cocktail', 'spritz', 'mocktail', 'coffee', 'hot-cocktail', 'food', 'dessert', 'other') then r.type
    when r.type = 'cocktail' then 'classic-cocktail'
    else 'other'
  end;

create index if not exists recipes_category_id_idx on public.recipes(category_id);
create index if not exists recipe_categories_active_order_idx on public.recipe_categories(active, display_order);
create index if not exists recipe_ingredients_item_id_idx on public.recipe_ingredients(item_id);
create index if not exists recipe_ingredients_recipe_id_idx on public.recipe_ingredients(recipe_id);

alter table public.recipe_categories enable row level security;

grant select, insert, update, delete on public.recipe_categories to authenticated;
grant select, insert, update, delete on public.recipes to authenticated;
grant select, insert, update, delete on public.recipe_ingredients to authenticated;

drop policy if exists "staff can read recipe categories" on public.recipe_categories;
create policy "staff can read recipe categories" on public.recipe_categories for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists "staff can add recipe categories" on public.recipe_categories;
create policy "staff can add recipe categories" on public.recipe_categories for insert to authenticated with check ((select auth.uid()) is not null);
drop policy if exists "staff can update recipe categories" on public.recipe_categories;
create policy "staff can update recipe categories" on public.recipe_categories for update to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
drop policy if exists "staff can delete recipe categories" on public.recipe_categories;
create policy "staff can delete recipe categories" on public.recipe_categories for delete to authenticated using ((select auth.uid()) is not null);

drop policy if exists "staff can read recipes" on public.recipes;
drop policy if exists "staff can write recipes" on public.recipes;
drop policy if exists "staff can update recipes" on public.recipes;
drop policy if exists "staff can delete recipes" on public.recipes;
create policy "staff can read recipes" on public.recipes for select to authenticated using ((select auth.uid()) is not null);
create policy "staff can write recipes" on public.recipes for insert to authenticated with check ((select auth.uid()) is not null);
create policy "staff can update recipes" on public.recipes for update to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
create policy "staff can delete recipes" on public.recipes for delete to authenticated using ((select auth.uid()) is not null);

drop policy if exists "staff can read recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff can write recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff can update recipe ingredients" on public.recipe_ingredients;
drop policy if exists "staff can delete recipe ingredients" on public.recipe_ingredients;
create policy "staff can read recipe ingredients" on public.recipe_ingredients for select to authenticated using ((select auth.uid()) is not null);
create policy "staff can write recipe ingredients" on public.recipe_ingredients for insert to authenticated with check ((select auth.uid()) is not null);
create policy "staff can update recipe ingredients" on public.recipe_ingredients for update to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
create policy "staff can delete recipe ingredients" on public.recipe_ingredients for delete to authenticated using ((select auth.uid()) is not null);
