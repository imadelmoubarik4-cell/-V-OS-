-- VÁ Bar Inventory — migration: suppliers, cost tracking, restock log
-- Run this in Supabase SQL Editor AFTER your original schema.sql — it only adds new things,
-- it does not touch your existing items.

-- New fields on existing items
alter table inventory_items add column if not exists supplier text;
alter table inventory_items add column if not exists cost_price numeric;       -- what you pay per unit
alter table inventory_items add column if not exists discount_percent numeric default 0;

-- Every restock (new stock coming in) gets logged here — this is what powers the
-- monthly spend dashboard. A restock is created automatically whenever someone
-- raises an item's quantity, and also directly via the "Log a restock" quick action.
create table if not exists restock_log (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references inventory_items(id) on delete set null,
  item_name text not null,          -- kept even if the item is later deleted/renamed
  supplier text,
  quantity_added numeric not null,
  unit_cost numeric,
  discount_percent numeric default 0,
  total_cost numeric,               -- quantity_added * unit_cost * (1 - discount_percent/100)
  logged_by text,
  logged_at timestamptz not null default now()
);

alter table restock_log enable row level security;

drop policy if exists "staff can read restocks" on restock_log;
create policy "staff can read restocks"
  on restock_log for select
  using (auth.role() = 'authenticated');

drop policy if exists "staff can add restocks" on restock_log;
create policy "staff can add restocks"
  on restock_log for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "staff can delete restocks" on restock_log;
create policy "staff can delete restocks"
  on restock_log for delete
  using (auth.role() = 'authenticated');
