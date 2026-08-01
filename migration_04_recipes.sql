-- VÁ Bar Inventory — migration 04: recipes
-- Run in Supabase SQL Editor after migration_03.

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'cocktail',   -- cocktail / food / other
  yield_quantity numeric not null default 1,
  yield_unit text not null default 'serving',
  menu_price numeric,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  item_id uuid references inventory_items(id) on delete set null,
  item_name text not null,     -- snapshot, kept even if the item is later renamed/deleted
  quantity numeric not null,
  unit text not null
);

create or replace function set_updated_at_recipes()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_recipes_updated_at on recipes;
create trigger trg_recipes_updated_at
  before update on recipes
  for each row execute function set_updated_at_recipes();

alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;

drop policy if exists "staff can read recipes" on recipes;
create policy "staff can read recipes" on recipes for select using (auth.role() = 'authenticated');
drop policy if exists "staff can write recipes" on recipes;
create policy "staff can write recipes" on recipes for insert with check (auth.role() = 'authenticated');
drop policy if exists "staff can update recipes" on recipes;
create policy "staff can update recipes" on recipes for update using (auth.role() = 'authenticated');
drop policy if exists "staff can delete recipes" on recipes;
create policy "staff can delete recipes" on recipes for delete using (auth.role() = 'authenticated');

drop policy if exists "staff can read recipe ingredients" on recipe_ingredients;
create policy "staff can read recipe ingredients" on recipe_ingredients for select using (auth.role() = 'authenticated');
drop policy if exists "staff can write recipe ingredients" on recipe_ingredients;
create policy "staff can write recipe ingredients" on recipe_ingredients for insert with check (auth.role() = 'authenticated');
drop policy if exists "staff can update recipe ingredients" on recipe_ingredients;
create policy "staff can update recipe ingredients" on recipe_ingredients for update using (auth.role() = 'authenticated');
drop policy if exists "staff can delete recipe ingredients" on recipe_ingredients;
create policy "staff can delete recipe ingredients" on recipe_ingredients for delete using (auth.role() = 'authenticated');
