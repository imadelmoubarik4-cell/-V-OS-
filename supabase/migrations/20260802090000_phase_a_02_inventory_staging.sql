-- Atlas Alpha 0.8.0 / Phase A.2
-- Inventory extraction, review staging, and Release 1 access hardening.
-- Review before applying. This migration does not import or promote source rows.

create extension if not exists "pgcrypto";
create schema if not exists private;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Authorization is anchored to the server-controlled profile row. The helper
-- lives outside exposed schemas, checks the caller explicitly, and can only be
-- executed by authenticated sessions. service_role bypasses RLS and does not
-- need to call it.
create or replace function private.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
    );
$$;

create or replace function private.is_manager_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
        and profile.role::text in ('admin', 'manager')
    );
$$;

revoke execute on function private.is_active_staff() from public, anon, service_role;
revoke execute on function private.is_manager_or_admin() from public, anon, service_role;
grant execute on function private.is_active_staff() to authenticated;
grant execute on function private.is_manager_or_admin() to authenticated;

-- Legacy helper functions are trigger-only or unused authorization internals;
-- they must not remain callable as public RPC endpoints.
revoke execute on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke execute on function private.is_self_or_manager(uuid) from public, anon, authenticated, service_role;

-- New public objects are private until a migration grants a deliberate Data
-- API surface. Every object created below receives explicit grants later.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated, service_role;

alter table public.import_batches
  add column if not exists source_hash text,
  add column if not exists extractor_version text,
  add column if not exists normalizer_version text;

alter table public.inventory_items
  add column if not exists canonical_key text,
  add column if not exists brand text,
  add column if not exists subcategory text,
  add column if not exists source_type text,
  add column if not exists source_confidence smallint,
  add column if not exists needs_review boolean not null default false,
  add column if not exists source_hash text,
  add column if not exists notes text;

alter table public.inventory_items drop constraint if exists inventory_items_source_confidence_check;
alter table public.inventory_items add constraint inventory_items_source_confidence_check
  check (source_confidence is null or source_confidence between 0 and 100) not valid;
alter table public.inventory_items validate constraint inventory_items_source_confidence_check;

create index if not exists inventory_items_canonical_key_idx
  on public.inventory_items(canonical_key)
  where canonical_key is not null;
create index if not exists inventory_items_supplier_id_idx
  on public.inventory_items(supplier_id)
  where supplier_id is not null;

-- Staff may need stock visibility without access to supplier costs, source
-- evidence, or private notes. A private, caller-checking function provides an
-- explicit safe projection; the public view runs as the caller.
create or replace function private.read_inventory_catalog()
returns table (
  id uuid,
  name text,
  category text,
  quantity numeric,
  unit text,
  par_level numeric,
  sku text,
  barcode text,
  bin_location text,
  units_per_case numeric,
  size_ml numeric,
  active boolean,
  image_url text,
  sell_price numeric,
  package_size text,
  canonical_key text,
  brand text,
  subcategory text,
  needs_review boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    item.id,
    item.name,
    item.category,
    item.quantity,
    item.unit,
    item.par_level,
    item.sku,
    item.barcode,
    item.bin_location,
    item.units_per_case,
    item.size_ml,
    item.active,
    item.image_url,
    item.sell_price,
    item.package_size,
    item.canonical_key,
    item.brand,
    item.subcategory,
    item.needs_review,
    item.updated_at
  from public.inventory_items as item
  where (select auth.uid()) is not null
    and (select private.is_active_staff());
$$;

revoke execute on function private.read_inventory_catalog() from public, anon, service_role;
grant execute on function private.read_inventory_catalog() to authenticated;

create or replace view public.inventory_catalog
with (security_invoker = true)
as
select * from private.read_inventory_catalog();

revoke all on table public.inventory_catalog from anon, authenticated, service_role;
grant select on table public.inventory_catalog to authenticated;

comment on view public.inventory_catalog is
  'Active-staff inventory projection without supplier costs, private notes, or source evidence.';

create table if not exists public.inventory_aliases (
  id uuid primary key default gen_random_uuid(),
  alias text not null check (length(trim(alias)) > 0),
  canonical_key text not null check (length(trim(canonical_key)) > 0),
  item_id uuid references public.inventory_items(id) on delete set null,
  source_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists inventory_aliases_alias_key
  on public.inventory_aliases(lower(trim(alias)));
create index if not exists inventory_aliases_item_idx
  on public.inventory_aliases(item_id)
  where item_id is not null;
create index if not exists inventory_aliases_created_by_idx
  on public.inventory_aliases(created_by)
  where created_by is not null;

create table if not exists public.import_inventory_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  source_page integer check (source_page is null or source_page > 0),
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  canonical_key text,
  source_hash text not null,
  matched_item_id uuid references public.inventory_items(id) on delete set null,
  match_strategy text,
  match_score numeric check (match_score is null or match_score between 0 and 1),
  proposed_action text not null default 'review'
    check (proposed_action in ('create', 'merge', 'skip', 'review')),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'imported')),
  issues text[] not null default '{}'::text[],
  decision_notes text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create index if not exists import_inventory_rows_batch_status_idx
  on public.import_inventory_rows(batch_id, review_status, row_number);
create index if not exists import_inventory_rows_canonical_idx
  on public.import_inventory_rows(canonical_key)
  where canonical_key is not null;
create index if not exists import_inventory_rows_match_idx
  on public.import_inventory_rows(matched_item_id)
  where matched_item_id is not null;
create index if not exists import_inventory_rows_review_idx
  on public.import_inventory_rows(review_status, proposed_action, created_at)
  where review_status = 'pending';
create index if not exists import_inventory_rows_approved_by_idx
  on public.import_inventory_rows(approved_by)
  where approved_by is not null;

create or replace function public.atlas_touch_import_inventory_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  if new.review_status = 'approved' and old.review_status is distinct from 'approved' then
    new.approved_at = coalesce(new.approved_at, pg_catalog.now());
    new.approved_by = coalesce(new.approved_by, (select auth.uid()));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_import_inventory_rows_touch on public.import_inventory_rows;
create trigger trg_import_inventory_rows_touch
  before update on public.import_inventory_rows
  for each row execute function public.atlas_touch_import_inventory_row();

create or replace function public.atlas_touch_import_batch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  if new.status in ('imported', 'completed', 'completed_with_review')
     and new.completed_at is null then
    new.completed_at = pg_catalog.now();
  end if;
  return new;
end;
$$;

revoke execute on function public.atlas_touch_import_inventory_row() from public, anon, authenticated, service_role;
revoke execute on function public.atlas_touch_import_batch() from public, anon, authenticated, service_role;

alter table public.inventory_items enable row level security;
alter table public.suppliers enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_review_items enable row level security;
alter table public.inventory_aliases enable row level security;
alter table public.import_inventory_rows enable row level security;

-- Reset the target tables to one deterministic policy set. This removes the
-- older "any signed-in user" policies that would otherwise combine with the
-- manager policies permissively and bypass them.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'inventory_items',
        'suppliers',
        'inventory_movements',
        'import_batches',
        'import_review_items',
        'inventory_aliases',
        'import_inventory_rows'
      ])
  loop
    execute pg_catalog.format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end;
$$;

create policy "active managers read inventory"
  on public.inventory_items for select to authenticated
  using ((select private.is_manager_or_admin()));
create policy "active managers add inventory"
  on public.inventory_items for insert to authenticated
  with check ((select private.is_manager_or_admin()));
create policy "active managers update inventory"
  on public.inventory_items for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));
create policy "active managers delete inventory"
  on public.inventory_items for delete to authenticated
  using ((select private.is_manager_or_admin()));

create policy "active managers read suppliers"
  on public.suppliers for select to authenticated
  using ((select private.is_manager_or_admin()));
create policy "active managers add suppliers"
  on public.suppliers for insert to authenticated
  with check ((select private.is_manager_or_admin()));
create policy "active managers update suppliers"
  on public.suppliers for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));
create policy "active managers delete suppliers"
  on public.suppliers for delete to authenticated
  using ((select private.is_manager_or_admin()));

create policy "active managers read inventory movements"
  on public.inventory_movements for select to authenticated
  using ((select private.is_manager_or_admin()));
create policy "active managers add inventory movements"
  on public.inventory_movements for insert to authenticated
  with check (
    (select private.is_manager_or_admin())
    and created_by = (select auth.uid())
  );
create policy "active managers update inventory movements"
  on public.inventory_movements for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));
create policy "active managers delete inventory movements"
  on public.inventory_movements for delete to authenticated
  using ((select private.is_manager_or_admin()));

create policy "active managers read import batches"
  on public.import_batches for select to authenticated
  using ((select private.is_manager_or_admin()));
create policy "active managers create import batches"
  on public.import_batches for insert to authenticated
  with check (
    (select private.is_manager_or_admin())
    and created_by = (select auth.uid())
  );
create policy "active managers update import batches"
  on public.import_batches for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));
create policy "active managers delete import batches"
  on public.import_batches for delete to authenticated
  using ((select private.is_manager_or_admin()));

create policy "active managers read import reviews"
  on public.import_review_items for select to authenticated
  using ((select private.is_manager_or_admin()));
create policy "active managers resolve import reviews"
  on public.import_review_items for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));

create policy "active managers read inventory aliases"
  on public.inventory_aliases for select to authenticated
  using ((select private.is_manager_or_admin()));

create policy "active managers read staged inventory"
  on public.import_inventory_rows for select to authenticated
  using ((select private.is_manager_or_admin()));
create policy "active managers review staged inventory"
  on public.import_inventory_rows for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));

-- Remove broad Data API grants before adding the exact browser and worker
-- surface. RLS decides which authenticated people qualify; grants decide what
-- operations the authenticated database role may attempt at all.
revoke all on table public.inventory_items from anon, authenticated;
grant select, insert, update, delete on table public.inventory_items to authenticated;
grant all on table public.inventory_items to service_role;

revoke all on table public.suppliers from anon, authenticated;
grant select, insert, update, delete on table public.suppliers to authenticated;
grant all on table public.suppliers to service_role;

revoke all on table public.inventory_movements from anon, authenticated;
grant select, insert, update, delete on table public.inventory_movements to authenticated;
grant all on table public.inventory_movements to service_role;

revoke all on table public.import_batches from anon, authenticated;
grant select, delete on table public.import_batches to authenticated;
grant insert (
  batch_key,
  source_files,
  file_name,
  file_extension,
  mime_type,
  file_size,
  entity_scope,
  status,
  current_stage,
  progress_percent,
  created_by,
  record_counts,
  notes
) on table public.import_batches to authenticated;
grant update (
  status,
  current_stage,
  progress_percent,
  storage_bucket,
  storage_path,
  record_counts,
  notes,
  last_error,
  started_at,
  completed_at
) on table public.import_batches to authenticated;
grant all on table public.import_batches to service_role;

revoke all on table public.import_review_items from anon, authenticated;
grant select on table public.import_review_items to authenticated;
grant update (resolved, resolved_at) on table public.import_review_items to authenticated;
grant all on table public.import_review_items to service_role;

revoke all on table public.inventory_aliases from anon, authenticated;
grant select on table public.inventory_aliases to authenticated;
grant all on table public.inventory_aliases to service_role;

revoke all on table public.import_inventory_rows from anon, authenticated;
grant select on table public.import_inventory_rows to authenticated;
grant update (
  review_status,
  proposed_action,
  matched_item_id,
  decision_notes
) on table public.import_inventory_rows to authenticated;
grant all on table public.import_inventory_rows to service_role;

drop policy if exists "authenticated staff can view atlas import files" on storage.objects;
drop policy if exists "authenticated staff can upload atlas import files" on storage.objects;
drop policy if exists "authenticated staff can update atlas import files" on storage.objects;
drop policy if exists "authenticated staff can delete atlas import files" on storage.objects;

create policy "active managers view atlas import files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'atlas-imports'
    and (select private.is_manager_or_admin())
  );
create policy "active managers upload atlas import files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'atlas-imports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.is_manager_or_admin())
  );
create policy "active managers update atlas import files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'atlas-imports'
    and (select private.is_manager_or_admin())
  )
  with check (
    bucket_id = 'atlas-imports'
    and (select private.is_manager_or_admin())
  );
create policy "active managers delete atlas import files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'atlas-imports'
    and (select private.is_manager_or_admin())
  );

comment on table public.import_inventory_rows is
  'Source-faithful staging rows. Trusted workers extract; active managers review; a later controlled worker promotes.';
comment on column public.import_inventory_rows.raw_data is
  'Unmodified values extracted from the source row.';
comment on column public.import_inventory_rows.normalized_data is
  'Deterministic normalized proposal; it is not canonical inventory until approved and promoted.';
comment on table public.inventory_aliases is
  'Reviewed alternative names. Write access is reserved for trusted service workflows.';
