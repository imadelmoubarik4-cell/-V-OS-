-- Sprint 3 - Real VÁ Data private staging contract.
-- Public-safe schema only: this file contains no VÁ operational rows.
-- Recorded in the linked Supabase branch as migration 20260802175714.

create extension if not exists pgcrypto;

create schema if not exists atlas_private;
revoke all on schema atlas_private from public, anon, authenticated;
grant usage on schema atlas_private to service_role;

alter default privileges for role postgres in schema atlas_private
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema atlas_private
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema atlas_private
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema atlas_private
  grant all on tables to service_role;
alter default privileges for role postgres in schema atlas_private
  grant all on sequences to service_role;

create or replace function atlas_private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke execute on function atlas_private.touch_updated_at() from public, anon, authenticated;
grant execute on function atlas_private.touch_updated_at() to service_role;

create table if not exists atlas_private.import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  source_files text[] not null default '{}',
  status text not null default 'prepared'
    check (status in ('prepared','staged','review','approved','promoted','failed')),
  record_counts jsonb not null default '{}',
  notes text,
  file_name text,
  file_extension text,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  entity_scope text not null
    check (entity_scope in ('inventory','wine','recipe','coffee','menu','supplier','invoice','delivery','equipment','purchase')),
  current_stage text not null default 'matching',
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  storage_bucket text,
  storage_path text,
  source_hash text,
  extractor_version text,
  normalizer_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists atlas_private.import_inventory_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references atlas_private.import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  source_page integer check (source_page is null or source_page > 0),
  raw_data jsonb not null default '{}',
  normalized_data jsonb not null default '{}',
  canonical_key text,
  source_hash text not null,
  matched_item_id text,
  match_strategy text,
  match_score numeric check (match_score is null or match_score between 0 and 1),
  proposed_action text not null default 'review'
    check (proposed_action in ('create','merge','skip','review')),
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','imported')),
  issues text[] not null default '{}',
  decision_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id,row_number)
);

create table if not exists atlas_private.import_entity_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references atlas_private.import_batches(id) on delete cascade,
  entity_scope text not null
    check (entity_scope in ('recipe','menu','supplier','invoice','delivery','equipment','purchase')),
  row_number integer not null check (row_number > 0),
  source_page integer check (source_page is null or source_page > 0),
  source_key text,
  source_hash text not null,
  raw_data jsonb not null default '{}',
  normalized_data jsonb not null default '{}',
  matched_entity_type text,
  matched_entity_id text,
  match_strategy text,
  match_score numeric check (match_score is null or match_score between 0 and 1),
  proposed_action text not null default 'review'
    check (proposed_action in ('create','merge','link','skip','review')),
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','imported')),
  issues text[] not null default '{}',
  decision_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id,entity_scope,row_number)
);

create table if not exists atlas_private.import_review_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references atlas_private.import_batches(id) on delete cascade,
  entity_type text not null,
  source_key text not null,
  severity text not null default 'review'
    check (severity in ('info','review','warning','error')),
  issue text not null,
  source_data jsonb not null default '{}',
  resolved boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id,entity_type,source_key,issue)
);

create index if not exists sprint3_batches_scope_status_idx
  on atlas_private.import_batches(entity_scope,status,created_at);
create index if not exists sprint3_inventory_batch_status_idx
  on atlas_private.import_inventory_rows(batch_id,review_status,row_number);
create index if not exists sprint3_inventory_canonical_idx
  on atlas_private.import_inventory_rows(canonical_key)
  where canonical_key is not null;
create index if not exists sprint3_inventory_pending_idx
  on atlas_private.import_inventory_rows(proposed_action,created_at)
  where review_status='pending';
create index if not exists sprint3_entity_batch_status_idx
  on atlas_private.import_entity_rows(batch_id,entity_scope,review_status,row_number);
create index if not exists sprint3_entity_source_key_idx
  on atlas_private.import_entity_rows(entity_scope,source_key)
  where source_key is not null;
create index if not exists sprint3_entity_pending_idx
  on atlas_private.import_entity_rows(entity_scope,proposed_action,created_at)
  where review_status='pending';
create index if not exists sprint3_review_open_idx
  on atlas_private.import_review_items(resolved,severity,entity_type,created_at);

drop trigger if exists sprint3_batches_touch on atlas_private.import_batches;
create trigger sprint3_batches_touch
  before update on atlas_private.import_batches
  for each row execute function atlas_private.touch_updated_at();

drop trigger if exists sprint3_inventory_touch on atlas_private.import_inventory_rows;
create trigger sprint3_inventory_touch
  before update on atlas_private.import_inventory_rows
  for each row execute function atlas_private.touch_updated_at();

drop trigger if exists sprint3_entity_touch on atlas_private.import_entity_rows;
create trigger sprint3_entity_touch
  before update on atlas_private.import_entity_rows
  for each row execute function atlas_private.touch_updated_at();

alter table atlas_private.import_batches enable row level security;
alter table atlas_private.import_inventory_rows enable row level security;
alter table atlas_private.import_entity_rows enable row level security;
alter table atlas_private.import_review_items enable row level security;

drop policy if exists "service role manages sprint3 batches" on atlas_private.import_batches;
create policy "service role manages sprint3 batches"
  on atlas_private.import_batches for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages sprint3 inventory" on atlas_private.import_inventory_rows;
create policy "service role manages sprint3 inventory"
  on atlas_private.import_inventory_rows for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages sprint3 entities" on atlas_private.import_entity_rows;
create policy "service role manages sprint3 entities"
  on atlas_private.import_entity_rows for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages sprint3 reviews" on atlas_private.import_review_items;
create policy "service role manages sprint3 reviews"
  on atlas_private.import_review_items for all to service_role
  using (true) with check (true);

revoke all on all tables in schema atlas_private from public, anon, authenticated;
revoke all on all sequences in schema atlas_private from public, anon, authenticated;
grant all on all tables in schema atlas_private to service_role;
grant all on all sequences in schema atlas_private to service_role;

create or replace view atlas_private.data_coverage
with (security_invoker = true)
as
select 'inventory'::text as entity_scope,
       count(*)::bigint as total_rows,
       count(*) filter (where review_status='pending')::bigint as pending_rows,
       count(*) filter (where review_status='approved')::bigint as approved_rows,
       count(*) filter (where review_status='rejected')::bigint as rejected_rows,
       count(*) filter (where review_status='imported')::bigint as imported_rows
from atlas_private.import_inventory_rows
union all
select entity_scope,
       count(*)::bigint,
       count(*) filter (where review_status='pending')::bigint,
       count(*) filter (where review_status='approved')::bigint,
       count(*) filter (where review_status='rejected')::bigint,
       count(*) filter (where review_status='imported')::bigint
from atlas_private.import_entity_rows
group by entity_scope;

create or replace view atlas_private.review_summary
with (security_invoker = true)
as
select entity_type,issue,severity,count(*)::bigint as issue_count
from atlas_private.import_review_items
where resolved is false
group by entity_type,issue,severity;

revoke all on atlas_private.data_coverage from public, anon, authenticated;
revoke all on atlas_private.review_summary from public, anon, authenticated;
grant select on atlas_private.data_coverage to service_role;
grant select on atlas_private.review_summary to service_role;

comment on schema atlas_private is
  'Private Sprint 3 Real VÁ Data staging; never exposed to browser roles.';
comment on table atlas_private.import_inventory_rows is
  'Historical and candidate inventory evidence only. July 2026 quantities are not live stock.';
comment on table atlas_private.import_entity_rows is
  'Review-first recipes, menus, suppliers, invoices, deliveries, equipment and purchase evidence.';
