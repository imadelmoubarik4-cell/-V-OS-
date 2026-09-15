-- VÁ Bar Inventory — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query)

create extension if not exists "pgcrypto";

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'other',
  quantity numeric not null default 0,
  unit text not null default 'bottles',
  par_level numeric,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh automatically
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_inventory_items_updated_at on inventory_items;
create trigger trg_inventory_items_updated_at
  before update on inventory_items
  for each row execute function set_updated_at();

-- Lock the table down to signed-in staff only
alter table inventory_items enable row level security;

drop policy if exists "staff can read inventory" on inventory_items;
create policy "staff can read inventory"
  on inventory_items for select
  using (auth.role() = 'authenticated');

drop policy if exists "staff can add items" on inventory_items;
create policy "staff can add items"
  on inventory_items for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "staff can update items" on inventory_items;
create policy "staff can update items"
  on inventory_items for update
  using (auth.role() = 'authenticated');

drop policy if exists "staff can delete items" on inventory_items;
create policy "staff can delete items"
  on inventory_items for delete
  using (auth.role() = 'authenticated');

-- A few starter rows so the app isn't empty on first login (optional — delete anytime)
insert into inventory_items (name, category, quantity, unit, par_level) values
  ('Tanqueray No. TEN', 'spirits', 4, 'bottles', 6),
  ('Reyka Vodka', 'spirits', 8, 'bottles', 6),
  ('Aperol', 'spirits', 3, 'bottles', 4),
  ('Prosecco', 'wine', 12, 'bottles', 10),
  ('House White', 'wine', 6, 'bottles', 10),
  ('Tonic Water', 'mixers', 40, 'cans', 24)
on conflict do nothing;
