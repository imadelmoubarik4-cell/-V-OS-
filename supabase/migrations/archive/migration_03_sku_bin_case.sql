-- VÁ Bar Inventory — migration 03: SKU, bin location, case costing
-- Run in Supabase SQL Editor after migration_02.

alter table inventory_items add column if not exists sku text;
alter table inventory_items add column if not exists bin_location text;
alter table inventory_items add column if not exists units_per_case numeric;
alter table inventory_items add column if not exists case_cost numeric;
