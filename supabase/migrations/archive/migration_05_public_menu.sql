-- VÁ Bar Inventory — migration 05: public menu
-- Run in Supabase SQL Editor after migration_04.

-- Toggle per recipe: show it on the public menu or not
alter table recipes add column if not exists show_on_menu boolean not null default true;

-- A safe public view — exposes ONLY name, type, and menu price.
-- Never exposes cost, profit, or ingredients — those stay staff-only.
create or replace view public_menu as
  select id, name, type, menu_price
  from recipes
  where show_on_menu = true
  order by type, name;

-- Let anonymous (unauthenticated) visitors read this view only
grant usage on schema public to anon;
grant select on public_menu to anon;
