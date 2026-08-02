-- Recovered from Supabase migration history for project dnefgcmjcgxlynycxkts.
-- This file preserves the SQL already recorded as applied; do not rewrite it.

alter table public.inventory_items
  add column if not exists package_size text,
  add column if not exists source_page integer,
  add column if not exists import_note text;

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  source_files text[] not null default '{}',
  status text not null default 'prepared' check (status in ('prepared','importing','completed','completed_with_review','failed')),
  record_counts jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.import_review_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  entity_type text not null default 'inventory_item',
  source_key text not null,
  severity text not null default 'review' check (severity in ('info','review','warning','error')),
  issue text not null,
  source_data jsonb not null default '{}'::jsonb,
  resolved boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(batch_id, entity_type, source_key, issue)
);

alter table public.import_batches enable row level security;
alter table public.import_review_items enable row level security;

grant select on public.import_batches to authenticated;
grant select, update on public.import_review_items to authenticated;

drop policy if exists "authenticated staff can read import batches" on public.import_batches;
create policy "authenticated staff can read import batches"
  on public.import_batches for select
  to authenticated
  using ((select auth.uid()) is not null);

drop policy if exists "authenticated staff can read import reviews" on public.import_review_items;
create policy "authenticated staff can read import reviews"
  on public.import_review_items for select
  to authenticated
  using ((select auth.uid()) is not null);

drop policy if exists "authenticated staff can update import reviews" on public.import_review_items;
create policy "authenticated staff can update import reviews"
  on public.import_review_items for update
  to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);
