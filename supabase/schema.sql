-- Atlas Alpha 0.8.0 reference schema
-- Migrations are authoritative. This file documents the current domain shape for
-- fresh-environment review; do not use it to replace a migration history.

create extension if not exists "pgcrypto";

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  canonical_key text,
  category text not null default 'Other',
  subcategory text,
  brand text,
  quantity numeric not null default 0,
  unit text not null default 'unit',
  package_size text,
  size_ml numeric,
  par_level numeric check (par_level is null or par_level >= 0),
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier text,
  cost_price numeric,
  discount_percent numeric default 0,
  sell_price numeric,
  sku text,
  barcode text,
  source_key text,
  source_type text,
  source_file text,
  source_page integer,
  source_hash text,
  source_confidence smallint check (source_confidence is null or source_confidence between 0 and 100),
  needs_review boolean not null default false,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  source_files text[] not null default '{}'::text[],
  file_name text,
  file_extension text,
  mime_type text,
  file_size bigint,
  entity_scope text not null default 'inventory',
  status text not null default 'uploaded',
  current_stage text not null default 'uploaded',
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  storage_bucket text,
  storage_path text,
  source_hash text,
  extractor_version text,
  normalizer_version text,
  created_by uuid references auth.users(id) on delete set null,
  record_counts jsonb not null default '{}'::jsonb,
  notes text,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_aliases (
  id uuid primary key default gen_random_uuid(),
  alias text not null,
  canonical_key text not null,
  item_id uuid references public.inventory_items(id) on delete set null,
  source_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.import_inventory_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  source_page integer,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  canonical_key text,
  source_hash text not null,
  matched_item_id uuid references public.inventory_items(id) on delete set null,
  match_strategy text,
  match_score numeric check (match_score is null or match_score between 0 and 1),
  proposed_action text not null default 'review',
  review_status text not null default 'pending',
  issues text[] not null default '{}'::text[],
  decision_notes text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

alter table public.inventory_items enable row level security;
alter table public.import_batches enable row level security;
alter table public.inventory_aliases enable row level security;
alter table public.import_inventory_rows enable row level security;
