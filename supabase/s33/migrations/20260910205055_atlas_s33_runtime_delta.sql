-- S33 isolated runtime delta. Review candidate; no hosted execution authorization.
-- Generated with Supabase CLI 2.117.0. Exact historical statement decisions: runtime-delta-audit.json.
begin;
do $s33_preflight$
begin
 if to_regnamespace('atlas_private') is not null then
  raise exception 'S33 requires an untouched private-runtime baseline';
 end if;
 if (select count(*) from supabase_migrations.schema_migrations) <> 9 then
  raise exception 'S33 requires the reviewed nine-entry migration baseline';
 end if;
 if to_regprocedure('private.preserve_active_admin()') is null then
  raise exception 'S33 requires the retained administrator guard';
 end if;
end;
$s33_preflight$;
-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 0
-- Sprint 3 - Real VÁ Data private staging contract.
-- Public-safe schema only: this file contains no VÁ operational rows.
-- Recorded in the linked Supabase branch as migration 20260802175714.

create extension if not exists pgcrypto;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 1
create schema if not exists atlas_private;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 2
revoke all on schema atlas_private from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 3
grant usage on schema atlas_private to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 4
alter default privileges for role postgres in schema atlas_private
  revoke all on tables from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 5
alter default privileges for role postgres in schema atlas_private
  revoke all on sequences from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 6
alter default privileges for role postgres in schema atlas_private
  revoke execute on functions from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 7
alter default privileges for role postgres in schema atlas_private
  grant all on tables to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 8
alter default privileges for role postgres in schema atlas_private
  grant all on sequences to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 9
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

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 10
revoke execute on function atlas_private.touch_updated_at() from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 11
grant execute on function atlas_private.touch_updated_at() to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 12
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

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 13
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

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 14
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

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 15
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

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 16
create index if not exists sprint3_batches_scope_status_idx
  on atlas_private.import_batches(entity_scope,status,created_at);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 17
create index if not exists sprint3_inventory_batch_status_idx
  on atlas_private.import_inventory_rows(batch_id,review_status,row_number);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 18
create index if not exists sprint3_inventory_canonical_idx
  on atlas_private.import_inventory_rows(canonical_key)
  where canonical_key is not null;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 19
create index if not exists sprint3_inventory_pending_idx
  on atlas_private.import_inventory_rows(proposed_action,created_at)
  where review_status='pending';

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 20
create index if not exists sprint3_entity_batch_status_idx
  on atlas_private.import_entity_rows(batch_id,entity_scope,review_status,row_number);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 21
create index if not exists sprint3_entity_source_key_idx
  on atlas_private.import_entity_rows(entity_scope,source_key)
  where source_key is not null;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 22
create index if not exists sprint3_entity_pending_idx
  on atlas_private.import_entity_rows(entity_scope,proposed_action,created_at)
  where review_status='pending';

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 23
create index if not exists sprint3_review_open_idx
  on atlas_private.import_review_items(resolved,severity,entity_type,created_at);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 24
drop trigger if exists sprint3_batches_touch on atlas_private.import_batches;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 25
create trigger sprint3_batches_touch
  before update on atlas_private.import_batches
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 26
drop trigger if exists sprint3_inventory_touch on atlas_private.import_inventory_rows;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 27
create trigger sprint3_inventory_touch
  before update on atlas_private.import_inventory_rows
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 28
drop trigger if exists sprint3_entity_touch on atlas_private.import_entity_rows;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 29
create trigger sprint3_entity_touch
  before update on atlas_private.import_entity_rows
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 30
alter table atlas_private.import_batches enable row level security;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 31
alter table atlas_private.import_inventory_rows enable row level security;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 32
alter table atlas_private.import_entity_rows enable row level security;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 33
alter table atlas_private.import_review_items enable row level security;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 34
drop policy if exists "service role manages sprint3 batches" on atlas_private.import_batches;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 35
create policy "service role manages sprint3 batches"
  on atlas_private.import_batches for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 36
drop policy if exists "service role manages sprint3 inventory" on atlas_private.import_inventory_rows;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 37
create policy "service role manages sprint3 inventory"
  on atlas_private.import_inventory_rows for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 38
drop policy if exists "service role manages sprint3 entities" on atlas_private.import_entity_rows;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 39
create policy "service role manages sprint3 entities"
  on atlas_private.import_entity_rows for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 40
drop policy if exists "service role manages sprint3 reviews" on atlas_private.import_review_items;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 41
create policy "service role manages sprint3 reviews"
  on atlas_private.import_review_items for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 42
revoke all on all tables in schema atlas_private from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 43
revoke all on all sequences in schema atlas_private from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 44
grant all on all tables in schema atlas_private to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 45
grant all on all sequences in schema atlas_private to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 46
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

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 47
create or replace view atlas_private.review_summary
with (security_invoker = true)
as
select entity_type,issue,severity,count(*)::bigint as issue_count
from atlas_private.import_review_items
where resolved is false
group by entity_type,issue,severity;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 48
revoke all on atlas_private.data_coverage from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 49
revoke all on atlas_private.review_summary from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 50
grant select on atlas_private.data_coverage to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 51
grant select on atlas_private.review_summary to service_role;

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 52
comment on schema atlas_private is
  'Private Sprint 3 Real VÁ Data staging; never exposed to browser roles.';

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 53
comment on table atlas_private.import_inventory_rows is
  'Historical and candidate inventory evidence only. July 2026 quantities are not live stock.';

-- SOURCE supabase/migrations/20260802175714_sprint3_private_staging.sql statement 54
comment on table atlas_private.import_entity_rows is
  'Review-first recipes, menus, suppliers, invoices, deliveries, equipment and purchase evidence.';

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 0
-- Sprint 3 - Real VÁ Data review workflow.
-- Public-safe database contract only. Contains no operational rows.
-- Recorded in the linked Supabase branch as migration 20260802180230.

alter table atlas_private.import_inventory_rows
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_by_label text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists decision_version integer not null default 0;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 1
alter table atlas_private.import_entity_rows
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_by_label text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists decision_version integer not null default 0;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 2
create table if not exists atlas_private.review_decisions (
  id uuid primary key default gen_random_uuid(),
  row_kind text not null check (row_kind in ('inventory','entity')),
  row_id uuid not null,
  batch_id uuid not null references atlas_private.import_batches(id) on delete cascade,
  source_key text,
  decision text not null check (decision in ('approve','reject','reset')),
  previous_status text not null,
  new_status text not null,
  previous_action text,
  new_action text,
  previous_matched_id text,
  new_matched_id text,
  notes text,
  decided_by uuid,
  decided_by_label text,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 3
create index if not exists sprint3_review_decisions_row_idx
  on atlas_private.review_decisions(row_kind,row_id,created_at desc);

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 4
create index if not exists sprint3_review_decisions_batch_idx
  on atlas_private.review_decisions(batch_id,created_at desc);

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 5
alter table atlas_private.review_decisions enable row level security;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 6
drop policy if exists "service role manages sprint3 decisions" on atlas_private.review_decisions;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 7
create policy "service role manages sprint3 decisions"
  on atlas_private.review_decisions for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 8
revoke all on atlas_private.review_decisions from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 9
grant select, insert on atlas_private.review_decisions to service_role;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 10
create or replace function atlas_private.decide_inventory_row(
  p_row_id uuid,
  p_decision text,
  p_action text default null,
  p_matched_item_id text default null,
  p_notes text default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null
)
returns atlas_private.import_inventory_rows
language plpgsql
security invoker
set search_path = ''
as $$
declare
  before_row atlas_private.import_inventory_rows;
  after_row atlas_private.import_inventory_rows;
  new_status text;
  new_action text;
  new_match text;
  row_source_key text;
begin
  if p_decision not in ('approve','reject','reset') then
    raise exception 'Invalid decision: %', p_decision;
  end if;

  select * into before_row
  from atlas_private.import_inventory_rows
  where id = p_row_id
  for update;
  if not found then raise exception 'Inventory staging row not found'; end if;

  new_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    else 'pending'
  end;
  new_action := coalesce(p_action,before_row.proposed_action);
  new_match := coalesce(p_matched_item_id,before_row.matched_item_id);

  if p_decision='approve' and new_action not in ('create','merge','skip') then
    raise exception 'Approved inventory row requires create, merge, or skip action';
  end if;
  if p_decision='approve' and new_action='merge' and new_match is null then
    raise exception 'Merge approval requires a matched inventory item';
  end if;
  if p_decision='reset' then
    new_action := 'review';
    new_match := null;
  end if;

  update atlas_private.import_inventory_rows
  set review_status = new_status,
      proposed_action = new_action,
      matched_item_id = new_match,
      decision_notes = p_notes,
      reviewed_by = p_decided_by,
      reviewed_by_label = p_decided_by_label,
      reviewed_at = case when p_decision='reset' then null else pg_catalog.now() end,
      decision_version = decision_version + 1
  where id = p_row_id
  returning * into after_row;

  row_source_key := coalesce(
    after_row.normalized_data->>'item_id',
    after_row.canonical_key,
    after_row.id::text
  );
  insert into atlas_private.review_decisions (
    row_kind,row_id,batch_id,source_key,decision,
    previous_status,new_status,previous_action,new_action,
    previous_matched_id,new_matched_id,notes,decided_by,decided_by_label
  ) values (
    'inventory',after_row.id,after_row.batch_id,row_source_key,p_decision,
    before_row.review_status,after_row.review_status,
    before_row.proposed_action,after_row.proposed_action,
    before_row.matched_item_id,after_row.matched_item_id,
    p_notes,p_decided_by,p_decided_by_label
  );

  return after_row;
end;
$$;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 11
create or replace function atlas_private.decide_entity_row(
  p_row_id uuid,
  p_decision text,
  p_action text default null,
  p_matched_entity_type text default null,
  p_matched_entity_id text default null,
  p_notes text default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null
)
returns atlas_private.import_entity_rows
language plpgsql
security invoker
set search_path = ''
as $$
declare
  before_row atlas_private.import_entity_rows;
  after_row atlas_private.import_entity_rows;
  new_status text;
  new_action text;
  new_match_type text;
  new_match_id text;
  row_source_key text;
begin
  if p_decision not in ('approve','reject','reset') then
    raise exception 'Invalid decision: %', p_decision;
  end if;

  select * into before_row
  from atlas_private.import_entity_rows
  where id = p_row_id
  for update;
  if not found then raise exception 'Entity staging row not found'; end if;

  new_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    else 'pending'
  end;
  new_action := coalesce(p_action,before_row.proposed_action);
  new_match_type := coalesce(p_matched_entity_type,before_row.matched_entity_type);
  new_match_id := coalesce(p_matched_entity_id,before_row.matched_entity_id);

  if p_decision='approve' and new_action not in ('create','merge','link','skip') then
    raise exception 'Approved entity row requires create, merge, link, or skip action';
  end if;
  if p_decision='approve' and new_action in ('merge','link') and new_match_id is null then
    raise exception 'Merge/link approval requires a matched entity';
  end if;
  if p_decision='reset' then
    new_action := 'review';
    new_match_type := null;
    new_match_id := null;
  end if;

  update atlas_private.import_entity_rows
  set review_status = new_status,
      proposed_action = new_action,
      matched_entity_type = new_match_type,
      matched_entity_id = new_match_id,
      decision_notes = p_notes,
      reviewed_by = p_decided_by,
      reviewed_by_label = p_decided_by_label,
      reviewed_at = case when p_decision='reset' then null else pg_catalog.now() end,
      decision_version = decision_version + 1
  where id = p_row_id
  returning * into after_row;

  row_source_key := coalesce(
    after_row.source_key,
    after_row.normalized_data->>'recipe_key',
    after_row.normalized_data->>'name',
    after_row.id::text
  );
  insert into atlas_private.review_decisions (
    row_kind,row_id,batch_id,source_key,decision,
    previous_status,new_status,previous_action,new_action,
    previous_matched_id,new_matched_id,notes,decided_by,decided_by_label
  ) values (
    'entity',after_row.id,after_row.batch_id,row_source_key,p_decision,
    before_row.review_status,after_row.review_status,
    before_row.proposed_action,after_row.proposed_action,
    before_row.matched_entity_id,after_row.matched_entity_id,
    p_notes,p_decided_by,p_decided_by_label
  );

  return after_row;
end;
$$;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 12
revoke execute on function atlas_private.decide_inventory_row(uuid,text,text,text,text,uuid,text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 13
revoke execute on function atlas_private.decide_entity_row(uuid,text,text,text,text,text,uuid,text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 14
grant execute on function atlas_private.decide_inventory_row(uuid,text,text,text,text,uuid,text)
  to service_role;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 15
grant execute on function atlas_private.decide_entity_row(uuid,text,text,text,text,text,uuid,text)
  to service_role;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 16
create or replace view atlas_private.review_queue
with (security_invoker = true)
as
select
  'inventory'::text as row_kind,
  row.id as row_id,
  row.batch_id,
  batch.batch_key,
  'inventory'::text as entity_scope,
  row.row_number,
  coalesce(row.normalized_data->>'item_id',row.canonical_key,row.id::text) as source_key,
  coalesce(row.normalized_data->>'name',row.canonical_key,'Unnamed inventory item') as display_name,
  coalesce(row.normalized_data->>'source_files',row.raw_data->>'source_files',batch.file_name) as source_file,
  row.source_page,
  row.proposed_action,
  row.review_status,
  row.matched_item_id as matched_id,
  row.match_strategy,
  row.match_score,
  row.issues,
  row.decision_notes,
  row.reviewed_by,
  row.reviewed_by_label,
  row.reviewed_at,
  row.decision_version,
  row.updated_at
from atlas_private.import_inventory_rows row
join atlas_private.import_batches batch on batch.id=row.batch_id
union all
select
  'entity'::text,
  row.id,
  row.batch_id,
  batch.batch_key,
  row.entity_scope,
  row.row_number,
  coalesce(row.source_key,row.normalized_data->>'recipe_key',row.normalized_data->>'name',row.id::text),
  coalesce(row.normalized_data->>'name',row.normalized_data->>'description',row.source_key,'Unnamed source row'),
  coalesce(row.normalized_data->>'source_file',row.raw_data->>'source_file',batch.file_name),
  row.source_page,
  row.proposed_action,
  row.review_status,
  row.matched_entity_id,
  row.match_strategy,
  row.match_score,
  row.issues,
  row.decision_notes,
  row.reviewed_by,
  row.reviewed_by_label,
  row.reviewed_at,
  row.decision_version,
  row.updated_at
from atlas_private.import_entity_rows row
join atlas_private.import_batches batch on batch.id=row.batch_id;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 17
create or replace view atlas_private.review_progress
with (security_invoker = true)
as
select entity_scope,review_status,count(*)::bigint as row_count
from atlas_private.review_queue
group by entity_scope,review_status;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 18
revoke all on atlas_private.review_queue from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 19
revoke all on atlas_private.review_progress from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 20
grant select on atlas_private.review_queue to service_role;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 21
grant select on atlas_private.review_progress to service_role;

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 22
comment on table atlas_private.review_decisions is
  'Immutable audit trail for Sprint 3 staging decisions.';

-- SOURCE supabase/migrations/20260802180230_sprint3_review_workflow.sql statement 23
comment on view atlas_private.review_queue is
  'Unified private review queue. No browser role has direct access.';

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 0
-- Sprint 3 - manager review API contract.
-- Public RPC wrappers are executable only by service_role.
-- Browser authentication and manager authorization are enforced by the Edge Function.
-- Recorded in the linked Supabase branch as migration 20260802181109.

create or replace function public.atlas_sprint3_review_summary()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'rows', (select count(*) from atlas_private.review_queue),
      'pending', (select count(*) from atlas_private.review_queue where review_status='pending'),
      'approved', (select count(*) from atlas_private.review_queue where review_status='approved'),
      'rejected', (select count(*) from atlas_private.review_queue where review_status='rejected'),
      'imported', (select count(*) from atlas_private.review_queue where review_status='imported'),
      'decisions', (select count(*) from atlas_private.review_decisions)
    ),
    'progress', coalesce((
      select jsonb_agg(to_jsonb(progress) order by progress.entity_scope,progress.review_status)
      from atlas_private.review_progress progress
    ), '[]'::jsonb),
    'top_issues', coalesce((
      select jsonb_agg(to_jsonb(issue_row) order by issue_row.issue_count desc,issue_row.entity_type,issue_row.issue)
      from (
        select entity_type,issue,severity,count(*)::bigint as issue_count
        from atlas_private.import_review_items
        where resolved is false
        group by entity_type,issue,severity
        order by count(*) desc,entity_type,issue
        limit 12
      ) issue_row
    ), '[]'::jsonb)
  );
$$;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 1
create or replace function public.atlas_sprint3_review_rows(
  p_scope text default null,
  p_status text default 'pending',
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with controls as (
    select
      case when nullif(trim(p_scope),'') in ('all','*') then null else nullif(trim(p_scope),'') end as scope_filter,
      case when nullif(trim(p_status),'') in ('all','*') then null else coalesce(nullif(trim(p_status),''),'pending') end as status_filter,
      nullif(trim(p_query),'') as query_filter,
      least(greatest(coalesce(p_limit,50),1),100) as row_limit,
      greatest(coalesce(p_offset,0),0) as row_offset
  ),
  filtered as (
    select queue.*
    from atlas_private.review_queue queue
    cross join controls
    where (controls.scope_filter is null or queue.entity_scope=controls.scope_filter)
      and (controls.status_filter is null or queue.review_status=controls.status_filter)
      and (
        controls.query_filter is null
        or queue.display_name ilike '%' || controls.query_filter || '%'
        or queue.source_key ilike '%' || controls.query_filter || '%'
        or queue.source_file ilike '%' || controls.query_filter || '%'
        or array_to_string(queue.issues,' ') ilike '%' || controls.query_filter || '%'
      )
  ),
  page as (
    select filtered.*
    from filtered cross join controls
    order by
      case filtered.entity_scope
        when 'inventory' then 1 when 'recipe' then 2 when 'menu' then 3
        when 'supplier' then 4 when 'invoice' then 5 when 'purchase' then 6
        when 'delivery' then 7 when 'equipment' then 8 else 9
      end,
      filtered.display_name,
      filtered.row_number
    limit (select row_limit from controls)
    offset (select row_offset from controls)
  )
  select jsonb_build_object(
    'total',(select count(*) from filtered),
    'limit',(select row_limit from controls),
    'offset',(select row_offset from controls),
    'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)
  );
$$;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 2
create or replace function public.atlas_sprint3_review_detail(
  p_row_kind text,
  p_row_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  row_data jsonb;
  row_batch_id uuid;
  row_source_key text;
  history_data jsonb;
  issues_data jsonb;
begin
  if p_row_kind='inventory' then
    select
      to_jsonb(row) || jsonb_build_object(
        'batch_key',batch.batch_key,
        'batch_scope',batch.entity_scope,
        'batch_source_files',batch.source_files,
        'batch_file_name',batch.file_name,
        'batch_source_hash',batch.source_hash
      ),
      row.batch_id,
      coalesce(row.normalized_data->>'item_id',row.canonical_key,row.id::text)
    into row_data,row_batch_id,row_source_key
    from atlas_private.import_inventory_rows row
    join atlas_private.import_batches batch on batch.id=row.batch_id
    where row.id=p_row_id;
  elsif p_row_kind='entity' then
    select
      to_jsonb(row) || jsonb_build_object(
        'batch_key',batch.batch_key,
        'batch_scope',batch.entity_scope,
        'batch_source_files',batch.source_files,
        'batch_file_name',batch.file_name,
        'batch_source_hash',batch.source_hash
      ),
      row.batch_id,
      coalesce(row.source_key,row.normalized_data->>'recipe_key',row.normalized_data->>'name',row.id::text)
    into row_data,row_batch_id,row_source_key
    from atlas_private.import_entity_rows row
    join atlas_private.import_batches batch on batch.id=row.batch_id
    where row.id=p_row_id;
  else
    raise exception 'Unsupported row kind: %',p_row_kind;
  end if;

  if row_data is null then raise exception 'Sprint 3 review row not found'; end if;

  select coalesce(jsonb_agg(to_jsonb(decision) order by decision.created_at desc),'[]'::jsonb)
  into history_data
  from atlas_private.review_decisions decision
  where decision.row_kind=p_row_kind and decision.row_id=p_row_id;

  select coalesce(jsonb_agg(to_jsonb(issue) order by issue.severity desc,issue.issue),'[]'::jsonb)
  into issues_data
  from atlas_private.import_review_items issue
  where issue.batch_id=row_batch_id and issue.source_key=row_source_key;

  return jsonb_build_object(
    'row_kind',p_row_kind,
    'row',row_data,
    'history',history_data,
    'issue_records',issues_data
  );
end;
$$;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 3
create or replace function public.atlas_sprint3_review_decide_inventory(
  p_row_id uuid,
  p_decision text,
  p_action text default null,
  p_matched_item_id text default null,
  p_notes text default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  decided atlas_private.import_inventory_rows;
begin
  decided := atlas_private.decide_inventory_row(
    p_row_id,p_decision,p_action,p_matched_item_id,p_notes,p_decided_by,p_decided_by_label
  );
  return jsonb_build_object(
    'row_kind','inventory',
    'row_id',decided.id,
    'review_status',decided.review_status,
    'proposed_action',decided.proposed_action,
    'matched_id',decided.matched_item_id,
    'decision_version',decided.decision_version,
    'reviewed_at',decided.reviewed_at
  );
end;
$$;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 4
create or replace function public.atlas_sprint3_review_decide_entity(
  p_row_id uuid,
  p_decision text,
  p_action text default null,
  p_matched_entity_type text default null,
  p_matched_entity_id text default null,
  p_notes text default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  decided atlas_private.import_entity_rows;
begin
  decided := atlas_private.decide_entity_row(
    p_row_id,p_decision,p_action,p_matched_entity_type,p_matched_entity_id,
    p_notes,p_decided_by,p_decided_by_label
  );
  return jsonb_build_object(
    'row_kind','entity',
    'row_id',decided.id,
    'review_status',decided.review_status,
    'proposed_action',decided.proposed_action,
    'matched_entity_type',decided.matched_entity_type,
    'matched_id',decided.matched_entity_id,
    'decision_version',decided.decision_version,
    'reviewed_at',decided.reviewed_at
  );
end;
$$;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 5
revoke execute on function public.atlas_sprint3_review_summary() from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 6
revoke execute on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 7
revoke execute on function public.atlas_sprint3_review_detail(text,uuid) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 8
revoke execute on function public.atlas_sprint3_review_decide_inventory(uuid,text,text,text,text,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 9
revoke execute on function public.atlas_sprint3_review_decide_entity(uuid,text,text,text,text,text,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 10
grant execute on function public.atlas_sprint3_review_summary() to service_role;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 11
grant execute on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) to service_role;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 12
grant execute on function public.atlas_sprint3_review_detail(text,uuid) to service_role;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 13
grant execute on function public.atlas_sprint3_review_decide_inventory(uuid,text,text,text,text,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 14
grant execute on function public.atlas_sprint3_review_decide_entity(uuid,text,text,text,text,text,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 15
comment on function public.atlas_sprint3_review_summary() is
  'Service-role-only summary for the Sprint 3 manager review Edge Function.';

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 16
comment on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) is
  'Service-role-only paginated review queue for the Sprint 3 manager review Edge Function.';

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 17
comment on function public.atlas_sprint3_review_detail(text,uuid) is
  'Service-role-only evidence detail for the Sprint 3 manager review Edge Function.';

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 18
comment on function public.atlas_sprint3_review_decide_inventory(uuid,text,text,text,text,uuid,text) is
  'Service-role-only inventory decision wrapper for the Sprint 3 manager review Edge Function.';

-- SOURCE supabase/migrations/20260802181109_sprint3_review_api.sql statement 19
comment on function public.atlas_sprint3_review_decide_entity(uuid,text,text,text,text,text,uuid,text) is
  'Service-role-only entity decision wrapper for the Sprint 3 manager review Edge Function.';

-- SOURCE supabase/migrations/20260802192300_sprint4_daily_briefing.sql statement 0
-- Sprint 4 - Atlas Brain Daily Briefing.
-- Deterministic, source-aware and read-only. Contains no VÁ operational rows.
-- Depends on the Sprint 3 private staging and review migrations.

create or replace function public.atlas_sprint4_daily_briefing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_generated_at timestamptz := pg_catalog.now();
  v_venue_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
  v_total bigint := 0;
  v_pending bigint := 0;
  v_approved bigint := 0;
  v_rejected bigint := 0;
  v_imported bigint := 0;
  v_reviewed bigint := 0;
  v_maturity numeric := 0;
  v_batches bigint := 0;
  v_source_files bigint := 0;
  v_hashed_batches bigint := 0;
  v_latest_batch_at timestamptz;
  v_open_issues bigint := 0;
  v_error_issues bigint := 0;
  v_missing_cost bigint := 0;
  v_missing_supplier bigint := 0;
  v_missing_package bigint := 0;
  v_historical_rows bigint := 0;
  v_historical_quantities bigint := 0;
  v_historical_from date;
  v_historical_to date;
  v_coverage jsonb := '[]'::jsonb;
  v_top_issues jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_signals jsonb := '[]'::jsonb;
  v_limitations jsonb := '[]'::jsonb;
  v_promotion_ready boolean := false;
  v_margin_ready boolean := false;
  v_headline text;
  issue_row record;
begin
  select
    coalesce(sum(coverage.total_rows), 0),
    coalesce(sum(coverage.pending_rows), 0),
    coalesce(sum(coverage.approved_rows), 0),
    coalesce(sum(coverage.rejected_rows), 0),
    coalesce(sum(coverage.imported_rows), 0)
  into v_total, v_pending, v_approved, v_rejected, v_imported
  from atlas_private.data_coverage as coverage;

  v_reviewed := v_approved + v_rejected + v_imported;
  if v_total > 0 then
    v_maturity := round((v_reviewed::numeric / v_total::numeric) * 100, 1);
  end if;

  select
    count(*)::bigint,
    count(distinct source_name)::bigint,
    count(*) filter (where source_hash is not null)::bigint,
    max(created_at)
  into v_batches, v_source_files, v_hashed_batches, v_latest_batch_at
  from (
    select
      batch.id,
      batch.source_hash,
      batch.created_at,
      unnest(
        case
          when coalesce(array_length(batch.source_files, 1), 0) > 0 then batch.source_files
          when batch.file_name is not null then array[batch.file_name]
          else array[batch.batch_key]
        end
      ) as source_name
    from atlas_private.import_batches as batch
  ) as sources;

  select
    coalesce(sum(summary.issue_count), 0),
    coalesce(sum(summary.issue_count) filter (where summary.severity = 'error'), 0),
    coalesce(sum(summary.issue_count) filter (where summary.issue = 'missing_cost'), 0),
    coalesce(sum(summary.issue_count) filter (where summary.issue = 'missing_supplier'), 0),
    coalesce(sum(summary.issue_count) filter (
      where summary.issue in ('missing_verified_package_size', 'missing_package_or_unit', 'bottle_size_not_stated')
    ), 0)
  into v_open_issues, v_error_issues, v_missing_cost, v_missing_supplier, v_missing_package
  from atlas_private.review_summary as summary;

  select
    count(*)::bigint,
    count(*) filter (where nullif(row.normalized_data ->> 'quantity', '') is not null)::bigint,
    min(
      case
        when coalesce(row.normalized_data ->> 'snapshot_effective_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'snapshot_effective_at')::date
        when coalesce(row.normalized_data ->> 'source_updated_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'source_updated_at')::date
        else null
      end
    ),
    max(
      case
        when coalesce(row.normalized_data ->> 'snapshot_effective_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'snapshot_effective_at')::date
        when coalesce(row.normalized_data ->> 'source_updated_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'source_updated_at')::date
        else null
      end
    )
  into v_historical_rows, v_historical_quantities, v_historical_from, v_historical_to
  from atlas_private.import_inventory_rows as row
  where row.normalized_data ->> 'quantity_role' = 'historical_opening_snapshot'
     or row.normalized_data ->> 'is_live_quantity' = 'false';

  select coalesce(jsonb_agg(jsonb_build_object(
    'scope', coverage.entity_scope,
    'total', coverage.total_rows,
    'pending', coverage.pending_rows,
    'approved', coverage.approved_rows,
    'rejected', coverage.rejected_rows,
    'imported', coverage.imported_rows,
    'reviewed', coverage.approved_rows + coverage.rejected_rows + coverage.imported_rows,
    'readiness_percent', case
      when coverage.total_rows > 0 then round(
        ((coverage.approved_rows + coverage.rejected_rows + coverage.imported_rows)::numeric
          / coverage.total_rows::numeric) * 100,
        1
      )
      else 0
    end,
    'confidence', case
      when coverage.pending_rows > 0 then jsonb_build_object(
        'state', 'pending',
        'score', 0.45,
        'reason', 'The domain is source-backed but still contains unreviewed records.'
      )
      when coverage.total_rows > 0 then jsonb_build_object(
        'state', 'reviewed',
        'score', 0.90,
        'reason', 'All represented rows in this domain have completed a review decision.'
      )
      else jsonb_build_object(
        'state', 'pending',
        'score', 0.20,
        'reason', 'No staged records are available for this domain.'
      )
    end,
    'source', jsonb_build_object(
      'kind', 'database_view',
      'schema', 'atlas_private',
      'object', 'data_coverage'
    )
  ) order by case coverage.entity_scope
      when 'inventory' then 1
      when 'recipe' then 2
      when 'menu' then 3
      when 'supplier' then 4
      when 'invoice' then 5
      when 'purchase' then 6
      when 'delivery' then 7
      when 'equipment' then 8
      else 99
    end), '[]'::jsonb)
  into v_coverage
  from atlas_private.data_coverage as coverage;

  select coalesce(jsonb_agg(jsonb_build_object(
    'entity_type', ranked.entity_type,
    'issue_key', ranked.issue,
    'title', initcap(replace(ranked.issue, '_', ' ')),
    'severity', ranked.severity,
    'count', ranked.issue_count,
    'confidence', jsonb_build_object(
      'state', 'pending',
      'score', 0.45,
      'reason', 'The issue count is verified, but the affected source records remain unresolved.'
    ),
    'source', jsonb_build_object(
      'kind', 'database_view',
      'schema', 'atlas_private',
      'object', 'review_summary'
    )
  ) order by ranked.severity_rank, ranked.issue_count desc, ranked.issue), '[]'::jsonb)
  into v_top_issues
  from (
    select
      summary.entity_type,
      summary.issue,
      summary.severity,
      summary.issue_count,
      case summary.severity
        when 'error' then 1
        when 'warning' then 2
        when 'review' then 3
        else 4
      end as severity_rank
    from atlas_private.review_summary as summary
    order by severity_rank, summary.issue_count desc, summary.issue
    limit 8
  ) as ranked;

  v_sources := jsonb_build_array(
    jsonb_build_object(
      'key', 'private-import-batches',
      'label', 'Private Sprint 3 import batches',
      'kind', 'database_table',
      'schema', 'atlas_private',
      'object', 'import_batches',
      'records', v_batches,
      'distinct_source_files', v_source_files,
      'hashed_records', v_hashed_batches,
      'latest_recorded_at', v_latest_batch_at,
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'Counts are read directly from the private branch database.'
      )
    ),
    jsonb_build_object(
      'key', 'private-review-queue',
      'label', 'Real VÁ Data review queue',
      'kind', 'database_view',
      'schema', 'atlas_private',
      'object', 'review_queue',
      'records', v_total,
      'pending_records', v_pending,
      'reviewed_records', v_reviewed,
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'Queue totals are computed from the complete private staging graph.'
      )
    ),
    jsonb_build_object(
      'key', 'historical-inventory',
      'label', 'July 2026 inventory evidence',
      'kind', 'historical_snapshot',
      'schema', 'atlas_private',
      'object', 'import_inventory_rows',
      'records', v_historical_rows,
      'effective_from', v_historical_from,
      'effective_to', v_historical_to,
      'is_live_quantity', false,
      'confidence', jsonb_build_object(
        'state', 'historical',
        'score', 0.65,
        'reason', 'The quantities are source-backed but are not current live stock.'
      )
    )
  );

  if v_pending > 0 then
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'review-queue-progress',
      'severity', case when v_maturity = 0 then 'high' else 'medium' end,
      'priority', 10,
      'title', format('%s source records await review', v_pending),
      'detail', format('%s of %s staged records have completed review.', v_reviewed, v_total),
      'domain', 'all',
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'The queue totals are counted directly from the private review graph.'
      ),
      'source', jsonb_build_object(
        'kind', 'database_view',
        'schema', 'atlas_private',
        'object', 'data_coverage'
      ),
      'evidence', jsonb_build_object(
        'total_rows', v_total,
        'pending_rows', v_pending,
        'reviewed_rows', v_reviewed,
        'maturity_percent', v_maturity
      ),
      'action', jsonb_build_object('label', 'Open Data Review', 'target', 'sprint3-review')
    ));
  end if;

  for issue_row in
    select
      summary.entity_type,
      summary.issue,
      summary.severity,
      summary.issue_count,
      case summary.severity
        when 'error' then 1
        when 'warning' then 2
        when 'review' then 3
        else 4
      end as severity_rank
    from atlas_private.review_summary as summary
    order by severity_rank, summary.issue_count desc, summary.issue
    limit 5
  loop
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'issue:' || issue_row.entity_type || ':' || issue_row.issue,
      'severity', case issue_row.severity
        when 'error' then 'critical'
        when 'warning' then 'high'
        when 'review' then 'medium'
        else 'low'
      end,
      'priority', 20 + issue_row.severity_rank,
      'title', initcap(replace(issue_row.issue, '_', ' ')),
      'detail', format('%s %s records carry this unresolved issue.', issue_row.issue_count, replace(issue_row.entity_type, '_', ' ')),
      'domain', issue_row.entity_type,
      'confidence', jsonb_build_object(
        'state', 'pending',
        'score', 0.45,
        'reason', 'The issue count is verified, while the affected rows remain unresolved.'
      ),
      'source', jsonb_build_object(
        'kind', 'database_view',
        'schema', 'atlas_private',
        'object', 'review_summary'
      ),
      'evidence', jsonb_build_object(
        'issue_key', issue_row.issue,
        'issue_count', issue_row.issue_count,
        'entity_type', issue_row.entity_type
      ),
      'action', jsonb_build_object('label', 'Review affected records', 'target', 'sprint3-review')
    ));
  end loop;

  if v_historical_rows > 0 then
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'historical-inventory-snapshot',
      'severity', 'info',
      'priority', 80,
      'title', 'Historical inventory snapshot is available',
      'detail', format(
        '%s inventory rows are preserved from %s through %s and are not treated as current stock.',
        v_historical_rows,
        coalesce(to_char(v_historical_from, 'YYYY-MM-DD'), 'an unknown date'),
        coalesce(to_char(v_historical_to, 'YYYY-MM-DD'), 'an unknown date')
      ),
      'domain', 'inventory',
      'confidence', jsonb_build_object(
        'state', 'historical',
        'score', 0.65,
        'reason', 'The source evidence is preserved, but its age prevents live operational use.'
      ),
      'source', jsonb_build_object(
        'kind', 'historical_snapshot',
        'schema', 'atlas_private',
        'object', 'import_inventory_rows'
      ),
      'evidence', jsonb_build_object(
        'historical_rows', v_historical_rows,
        'rows_with_quantity', v_historical_quantities,
        'effective_from', v_historical_from,
        'effective_to', v_historical_to,
        'is_live_quantity', false
      ),
      'action', jsonb_build_object('label', 'Open inventory evidence', 'target', 'sprint3-review')
    ));
  end if;

  v_promotion_ready := v_total > 0 and v_pending = 0 and v_error_issues = 0;
  v_margin_ready := v_missing_cost = 0 and v_missing_package = 0 and v_pending = 0;

  if not v_promotion_ready then
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'canonical-promotion-gate',
      'severity', 'high',
      'priority', 15,
      'title', 'Canonical promotion remains blocked',
      'detail', 'Pending or unresolved source rows must be reviewed before Atlas can promote the private graph into canonical operations.',
      'domain', 'governance',
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'The promotion gate is computed from review status and unresolved error counts.'
      ),
      'source', jsonb_build_object(
        'kind', 'computed_gate',
        'schema', 'atlas_private',
        'objects', jsonb_build_array('data_coverage', 'review_summary')
      ),
      'evidence', jsonb_build_object(
        'pending_rows', v_pending,
        'error_issue_rows', v_error_issues,
        'promotion_ready', false
      ),
      'action', jsonb_build_object('label', 'Continue review', 'target', 'sprint3-review')
    ));
  end if;

  v_limitations := v_limitations || jsonb_build_array(
    'Validated sales history is not connected to the trusted briefing layer, so demand forecasts remain disabled.'
  );
  if v_historical_rows > 0 then
    v_limitations := v_limitations || jsonb_build_array(
      'July 2026 inventory quantities are historical evidence, not current live stock.'
    );
  end if;
  if v_missing_cost > 0 or v_missing_package > 0 then
    v_limitations := v_limitations || jsonb_build_array(
      'Trusted margin recommendations remain disabled where cost or package data is incomplete.'
    );
  end if;
  if v_pending > 0 then
    v_limitations := v_limitations || jsonb_build_array(
      'Pending rows are surfaced as review work and are not treated as operational facts.'
    );
  end if;
  v_limitations := v_limitations || jsonb_build_array(
    'The Daily Briefing never creates purchase orders or promotes canonical production rows automatically.'
  );

  if v_total = 0 then
    v_headline := 'Atlas has no private source graph to brief from yet.';
  elsif v_pending > 0 then
    v_headline := format('Atlas has %s source records awaiting review.', v_pending);
  elsif v_promotion_ready then
    v_headline := 'The private source graph is reviewed and ready for a separate promotion assessment.';
  else
    v_headline := 'The source graph is reviewed, but unresolved blockers remain.';
  end if;

  return jsonb_build_object(
    'version', 'atlas-daily-briefing/0.1.0',
    'mode', 'deterministic',
    'generated_at', v_generated_at,
    'venue_date', v_venue_date,
    'headline', v_headline,
    'summary', jsonb_build_object(
      'source_batches', v_batches,
      'source_files', v_source_files,
      'hashed_batches', v_hashed_batches,
      'staged_rows', v_total,
      'pending_rows', v_pending,
      'approved_rows', v_approved,
      'rejected_rows', v_rejected,
      'imported_rows', v_imported,
      'reviewed_rows', v_reviewed,
      'maturity_percent', v_maturity,
      'open_issue_rows', v_open_issues,
      'promotion_ready', v_promotion_ready
    ),
    'capabilities', jsonb_build_object(
      'forecasting_enabled', false,
      'automatic_ordering_enabled', false,
      'trusted_margin_recommendations_enabled', v_margin_ready,
      'canonical_promotion_enabled', false
    ),
    'gaps', jsonb_build_object(
      'missing_cost_rows', v_missing_cost,
      'missing_supplier_rows', v_missing_supplier,
      'missing_package_rows', v_missing_package,
      'error_issue_rows', v_error_issues
    ),
    'historical_inventory', jsonb_build_object(
      'rows', v_historical_rows,
      'rows_with_quantity', v_historical_quantities,
      'effective_from', v_historical_from,
      'effective_to', v_historical_to,
      'is_live_quantity', false,
      'confidence', jsonb_build_object(
        'state', 'historical',
        'score', 0.65,
        'reason', 'The snapshot is source-backed, dated evidence and is not current stock.'
      )
    ),
    'coverage', v_coverage,
    'top_issues', v_top_issues,
    'sources', v_sources,
    'signals', v_signals,
    'limitations', v_limitations,
    'trust', jsonb_build_object(
      'source_graph', 'private_branch',
      'browser_direct_access', false,
      'ai_generation_used', false,
      'historical_stock_used_for_reorder', false,
      'automatic_mutation', false
    )
  );
end;
$function$;

-- SOURCE supabase/migrations/20260802192300_sprint4_daily_briefing.sql statement 1
revoke execute on function public.atlas_sprint4_daily_briefing()
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802192300_sprint4_daily_briefing.sql statement 2
grant execute on function public.atlas_sprint4_daily_briefing()
  to service_role;

-- SOURCE supabase/migrations/20260802192300_sprint4_daily_briefing.sql statement 3
comment on function public.atlas_sprint4_daily_briefing() is
  'Service-role-only deterministic Daily Atlas Briefing. Reads private review state and never mutates or promotes canonical rows.';

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 0
-- Sprint 4 - deterministic signal ordering.
-- Preserve the Phase 1 briefing contract as the raw source and expose a wrapper
-- that always orders evidence cards by their numeric priority.

do $migration$
begin
  if to_regprocedure('public.atlas_sprint4_daily_briefing_raw()') is null then
    alter function public.atlas_sprint4_daily_briefing()
      rename to atlas_sprint4_daily_briefing_raw;
  end if;
end
$migration$;

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 1
revoke execute on function public.atlas_sprint4_daily_briefing_raw()
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 2
grant execute on function public.atlas_sprint4_daily_briefing_raw()
  to service_role;

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 3
create or replace function public.atlas_sprint4_daily_briefing()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with source_payload as (
    select public.atlas_sprint4_daily_briefing_raw() as payload
  ),
  ordered_signals as (
    select coalesce(
      jsonb_agg(signal order by
        case
          when coalesce(signal ->> 'priority', '') ~ '^\d+$'
            then (signal ->> 'priority')::integer
          else 9999
        end,
        signal ->> 'key'
      ),
      '[]'::jsonb
    ) as signals
    from source_payload
    cross join lateral jsonb_array_elements(
      coalesce(source_payload.payload -> 'signals', '[]'::jsonb)
    ) as signal
  )
  select jsonb_set(
    source_payload.payload,
    '{signals}',
    ordered_signals.signals,
    true
  )
  from source_payload
  cross join ordered_signals;
$function$;

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 4
revoke execute on function public.atlas_sprint4_daily_briefing()
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 5
grant execute on function public.atlas_sprint4_daily_briefing()
  to service_role;

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 6
comment on function public.atlas_sprint4_daily_briefing() is
  'Service-role-only deterministic Daily Atlas Briefing with evidence cards ordered by numeric priority.';

-- SOURCE supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql statement 7
comment on function public.atlas_sprint4_daily_briefing_raw() is
  'Underlying read-only Sprint 4 briefing payload. Use atlas_sprint4_daily_briefing() for ordered output.';

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 0
-- Sprint 4 Phase 3 - Atlas Brain decision memory and shadow recommendations.
-- Public-safe database contract only. Contains no VÁ operational rows.
-- All Phase 3 writes remain private, manager-reviewed and non-operational.

create table if not exists atlas_private.brain_data_connections (
  connection_key text primary key,
  label text not null,
  status text not null default 'not_connected'
    check (status in ('not_connected','pending_review','connected','verified','degraded')),
  source_ref text,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 1
insert into atlas_private.brain_data_connections (connection_key,label,status,metadata)
values
  ('current_stock','Current verified stock','not_connected','{"required_for":["shortage_prediction","purchase_recommendations"]}'::jsonb),
  ('sales_history','Validated product-level sales history','not_connected','{"required_for":["shortage_prediction","purchase_recommendations","menu_recommendations"]}'::jsonb),
  ('confirmed_deliveries','Confirmed incoming deliveries','not_connected','{"required_for":["shortage_prediction","purchase_recommendations"]}'::jsonb),
  ('supplier_lead_times','Verified supplier lead times','not_connected','{"required_for":["shortage_prediction","purchase_recommendations"]}'::jsonb),
  ('supplier_constraints','Supplier package, minimum and contract constraints','pending_review','{"required_for":["purchase_recommendations"]}'::jsonb),
  ('recipe_costs','Complete verified recipe costs','pending_review','{"required_for":["menu_recommendations"]}'::jsonb),
  ('menu_prices','Verified current menu prices','pending_review','{"required_for":["menu_recommendations"]}'::jsonb),
  ('inventory_movements','Trusted inventory movement history','not_connected','{"required_for":["waste_identification"]}'::jsonb),
  ('stock_counts','Frequent verified stock counts','not_connected','{"required_for":["waste_identification"]}'::jsonb),
  ('waste_events','Waste and expiry event history','not_connected','{"required_for":["waste_identification"]}'::jsonb),
  ('bookings','Bookings and event demand','not_connected','{"optional_for":["shortage_prediction","purchase_recommendations"]}'::jsonb)
on conflict (connection_key) do nothing;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 2
create table if not exists atlas_private.brain_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_key text not null,
  version integer not null check (version > 0),
  fingerprint text not null,
  recommendation_type text not null
    check (recommendation_type in ('data_quality','shortage','purchase','menu','waste','operations','governance')),
  capability_key text not null,
  subject_type text,
  subject_key text,
  title text not null,
  summary text not null,
  explanation text not null,
  suggested_action jsonb not null default '{}'::jsonb,
  alternatives jsonb not null default '[]'::jsonb
    check (jsonb_typeof(alternatives) = 'array'),
  consequence_of_inaction jsonb not null default '{}'::jsonb,
  confidence_state text not null
    check (confidence_state in ('verified','reviewed','pending','historical','modelled')),
  confidence_score numeric(5,4) not null check (confidence_score between 0 and 1),
  confidence_reason text not null,
  limitations text[] not null default '{}',
  priority integer not null default 100,
  shadow_mode boolean not null default true check (shadow_mode is true),
  status text not null default 'active'
    check (status in ('active','accepted','rejected','modified','deferred','expired','superseded')),
  deferred_until timestamptz,
  generated_by text not null default 'atlas-phase3-deterministic/0.1.0',
  generated_at timestamptz not null default now(),
  valid_until timestamptz,
  supersedes_id uuid references atlas_private.brain_recommendations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recommendation_key,version),
  unique (recommendation_key,fingerprint)
);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 3
create table if not exists atlas_private.brain_recommendation_evidence (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.brain_recommendations(id) on delete cascade,
  evidence_key text not null,
  label text not null,
  source_kind text not null,
  source_schema text,
  source_object text,
  source_row_key text,
  source_document text,
  source_page integer check (source_page is null or source_page > 0),
  observed_at timestamptz,
  confidence_state text not null
    check (confidence_state in ('verified','reviewed','pending','historical','modelled')),
  confidence_score numeric(5,4) not null check (confidence_score between 0 and 1),
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (recommendation_id,evidence_key)
);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 4
create table if not exists atlas_private.brain_decisions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.brain_recommendations(id) on delete cascade,
  client_request_id text unique,
  decision text not null check (decision in ('accept','reject','modify','defer','reset')),
  previous_status text not null,
  new_status text not null,
  reason_code text,
  notes text,
  modified_action jsonb,
  deferred_until timestamptz,
  decided_by uuid,
  decided_by_label text,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 5
create table if not exists atlas_private.brain_outcomes (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.brain_recommendations(id) on delete cascade,
  decision_id uuid references atlas_private.brain_decisions(id) on delete set null,
  client_request_id text unique,
  outcome_type text not null,
  outcome_status text not null default 'observed'
    check (outcome_status in ('observed','confirmed','disputed')),
  success_score numeric(5,4) check (success_score is null or success_score between 0 and 1),
  result jsonb not null default '{}'::jsonb,
  source_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_refs) = 'array'),
  notes text,
  observed_at timestamptz not null,
  recorded_by uuid,
  recorded_by_label text,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 6
create index if not exists brain_recommendations_status_priority_idx
  on atlas_private.brain_recommendations(status,priority,generated_at desc);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 7
create index if not exists brain_recommendations_subject_idx
  on atlas_private.brain_recommendations(subject_type,subject_key,generated_at desc);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 8
create index if not exists brain_evidence_recommendation_idx
  on atlas_private.brain_recommendation_evidence(recommendation_id,created_at);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 9
create index if not exists brain_decisions_recommendation_idx
  on atlas_private.brain_decisions(recommendation_id,created_at desc);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 10
create index if not exists brain_outcomes_recommendation_idx
  on atlas_private.brain_outcomes(recommendation_id,observed_at desc);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 11
alter table atlas_private.brain_data_connections enable row level security;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 12
alter table atlas_private.brain_recommendations enable row level security;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 13
alter table atlas_private.brain_recommendation_evidence enable row level security;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 14
alter table atlas_private.brain_decisions enable row level security;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 15
alter table atlas_private.brain_outcomes enable row level security;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 16
drop policy if exists "service role manages brain data connections" on atlas_private.brain_data_connections;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 17
create policy "service role manages brain data connections"
  on atlas_private.brain_data_connections for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 18
drop policy if exists "service role manages brain recommendations" on atlas_private.brain_recommendations;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 19
create policy "service role manages brain recommendations"
  on atlas_private.brain_recommendations for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 20
drop policy if exists "service role manages brain evidence" on atlas_private.brain_recommendation_evidence;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 21
create policy "service role manages brain evidence"
  on atlas_private.brain_recommendation_evidence for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 22
drop policy if exists "service role manages brain decisions" on atlas_private.brain_decisions;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 23
create policy "service role manages brain decisions"
  on atlas_private.brain_decisions for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 24
drop policy if exists "service role manages brain outcomes" on atlas_private.brain_outcomes;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 25
create policy "service role manages brain outcomes"
  on atlas_private.brain_outcomes for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 26
revoke all on atlas_private.brain_data_connections from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 27
revoke all on atlas_private.brain_recommendations from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 28
revoke all on atlas_private.brain_recommendation_evidence from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 29
revoke all on atlas_private.brain_decisions from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 30
revoke all on atlas_private.brain_outcomes from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 31
grant all on atlas_private.brain_data_connections to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 32
grant all on atlas_private.brain_recommendations to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 33
grant all on atlas_private.brain_recommendation_evidence to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 34
grant all on atlas_private.brain_decisions to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 35
grant all on atlas_private.brain_outcomes to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 36
grant usage,select on all sequences in schema atlas_private to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 37
drop trigger if exists brain_data_connections_touch on atlas_private.brain_data_connections;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 38
create trigger brain_data_connections_touch
  before update on atlas_private.brain_data_connections
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 39
drop trigger if exists brain_recommendations_touch on atlas_private.brain_recommendations;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 40
create trigger brain_recommendations_touch
  before update on atlas_private.brain_recommendations
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 41
create or replace view atlas_private.brain_capability_gates
with (security_invoker = true)
as
with connection_map as (
  select coalesce(jsonb_object_agg(connection_key,status),'{}'::jsonb) as states
  from atlas_private.brain_data_connections
), gates as (
  select
    'decision_memory'::text as capability_key,
    'Decision memory'::text as label,
    true as enabled,
    'verified'::text as confidence_state,
    1.00::numeric as confidence_score,
    array[]::text[] as blockers,
    array[]::text[] as required_connections
  union all
  select
    'recommendation_explanations','Recommendation explanations',true,'verified',1.00,
    array[]::text[],array[]::text[]
  union all
  select
    'shortage_prediction','Shortage prediction',
    (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'),
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified') then 'reviewed' else 'pending' end,
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified') then 0.85 else 0.20 end,
    array_remove(array[
      case when coalesce(states->>'current_stock','not_connected')<>'verified' then 'Current stock is not verified.' end,
      case when coalesce(states->>'sales_history','not_connected')<>'verified' then 'Validated product-level sales history is not connected.' end,
      case when coalesce(states->>'confirmed_deliveries','not_connected') not in ('connected','verified') then 'Confirmed incoming deliveries are not connected.' end,
      case when coalesce(states->>'supplier_lead_times','not_connected')<>'verified' then 'Supplier lead times are not verified.' end
    ],null),
    array['current_stock','sales_history','confirmed_deliveries','supplier_lead_times']::text[]
  from connection_map
  union all
  select
    'purchase_recommendations','Purchase recommendations',
    (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'
      and states->>'supplier_constraints'='verified'),
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'
      and states->>'supplier_constraints'='verified') then 'reviewed' else 'pending' end,
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'
      and states->>'supplier_constraints'='verified') then 0.85 else 0.15 end,
    array_remove(array[
      case when coalesce(states->>'current_stock','not_connected')<>'verified' then 'Current stock is not verified.' end,
      case when coalesce(states->>'sales_history','not_connected')<>'verified' then 'Validated sales history is not connected.' end,
      case when coalesce(states->>'confirmed_deliveries','not_connected') not in ('connected','verified') then 'Confirmed deliveries are not connected.' end,
      case when coalesce(states->>'supplier_lead_times','not_connected')<>'verified' then 'Supplier lead times are not verified.' end,
      case when coalesce(states->>'supplier_constraints','not_connected')<>'verified' then 'Supplier package, cost and contract constraints remain unverified.' end
    ],null),
    array['current_stock','sales_history','confirmed_deliveries','supplier_lead_times','supplier_constraints']::text[]
  from connection_map
  union all
  select
    'menu_recommendations','Menu recommendations',
    (states->>'sales_history'='verified'
      and states->>'recipe_costs'='verified'
      and states->>'menu_prices'='verified'),
    case when (states->>'sales_history'='verified'
      and states->>'recipe_costs'='verified'
      and states->>'menu_prices'='verified') then 'reviewed' else 'pending' end,
    case when (states->>'sales_history'='verified'
      and states->>'recipe_costs'='verified'
      and states->>'menu_prices'='verified') then 0.85 else 0.20 end,
    array_remove(array[
      case when coalesce(states->>'sales_history','not_connected')<>'verified' then 'Validated product-level sales history is not connected.' end,
      case when coalesce(states->>'recipe_costs','not_connected')<>'verified' then 'Complete recipe costs remain unverified.' end,
      case when coalesce(states->>'menu_prices','not_connected')<>'verified' then 'Current menu prices remain unverified.' end
    ],null),
    array['sales_history','recipe_costs','menu_prices']::text[]
  from connection_map
  union all
  select
    'waste_identification','Waste identification',
    (states->>'inventory_movements'='verified'
      and states->>'stock_counts'='verified'
      and states->>'waste_events' in ('connected','verified')),
    case when (states->>'inventory_movements'='verified'
      and states->>'stock_counts'='verified'
      and states->>'waste_events' in ('connected','verified')) then 'reviewed' else 'pending' end,
    case when (states->>'inventory_movements'='verified'
      and states->>'stock_counts'='verified'
      and states->>'waste_events' in ('connected','verified')) then 0.85 else 0.15 end,
    array_remove(array[
      case when coalesce(states->>'inventory_movements','not_connected')<>'verified' then 'Trusted inventory movement history is not connected.' end,
      case when coalesce(states->>'stock_counts','not_connected')<>'verified' then 'Frequent verified stock counts are not connected.' end,
      case when coalesce(states->>'waste_events','not_connected') not in ('connected','verified') then 'Waste and expiry events are not connected.' end
    ],null),
    array['inventory_movements','stock_counts','waste_events']::text[]
  from connection_map
)
select
  capability_key,label,enabled,confidence_state,confidence_score,blockers,required_connections,
  'atlas_private.brain_data_connections'::text as source_ref
from gates;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 42
create or replace view atlas_private.brain_decision_memory
with (security_invoker = true)
as
select
  decision.id as memory_id,
  'recommendation_decision'::text as memory_type,
  coalesce(recommendation.subject_type,recommendation.recommendation_type) as subject_type,
  coalesce(recommendation.subject_key,recommendation.recommendation_key) as subject_key,
  decision.decision as action,
  recommendation.title,
  coalesce(decision.notes,
    format('%s changed the recommendation from %s to %s.',coalesce(decision.decided_by_label,'A manager'),decision.previous_status,decision.new_status)) as summary,
  jsonb_build_object(
    'recommendation_id',recommendation.id,
    'recommendation_key',recommendation.recommendation_key,
    'version',recommendation.version,
    'reason_code',decision.reason_code,
    'modified_action',decision.modified_action,
    'previous_status',decision.previous_status,
    'new_status',decision.new_status
  ) as context,
  decision.decided_by as actor_id,
  decision.decided_by_label as actor_label,
  decision.created_at as occurred_at,
  'atlas_private.brain_decisions'::text as source_ref
from atlas_private.brain_decisions decision
join atlas_private.brain_recommendations recommendation on recommendation.id=decision.recommendation_id
union all
select
  decision.id,
  'source_review_decision'::text,
  decision.row_kind,
  coalesce(decision.source_key,decision.row_id::text),
  decision.decision,
  format('Real VÁ Data decision: %s',coalesce(decision.source_key,decision.row_id::text)),
  coalesce(decision.notes,
    format('%s changed this source row from %s to %s.',coalesce(decision.decided_by_label,'A manager'),decision.previous_status,decision.new_status)),
  jsonb_build_object(
    'row_kind',decision.row_kind,
    'row_id',decision.row_id,
    'batch_id',decision.batch_id,
    'previous_status',decision.previous_status,
    'new_status',decision.new_status,
    'previous_action',decision.previous_action,
    'new_action',decision.new_action,
    'previous_matched_id',decision.previous_matched_id,
    'new_matched_id',decision.new_matched_id
  ),
  decision.decided_by,
  decision.decided_by_label,
  decision.created_at,
  'atlas_private.review_decisions'::text
from atlas_private.review_decisions decision
where decision.previous_status is distinct from decision.new_status
   or decision.previous_action is distinct from decision.new_action
   or decision.previous_matched_id is distinct from decision.new_matched_id;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 43
create or replace view atlas_private.brain_recommendation_feed
with (security_invoker = true)
as
select
  recommendation.*,
  coalesce(evidence.items,'[]'::jsonb) as evidence,
  coalesce(decisions.decision_count,0) as decision_count,
  decisions.last_decision,
  coalesce(outcomes.outcome_count,0) as outcome_count,
  outcomes.last_outcome,
  coalesce(memory.previous_decisions,'[]'::jsonb) as previous_decisions
from atlas_private.brain_recommendations recommendation
left join lateral (
  select jsonb_agg(jsonb_build_object(
    'evidence_key',item.evidence_key,
    'label',item.label,
    'source',jsonb_build_object(
      'kind',item.source_kind,
      'schema',item.source_schema,
      'object',item.source_object,
      'row_key',item.source_row_key,
      'document',item.source_document,
      'page',item.source_page
    ),
    'observed_at',item.observed_at,
    'confidence',jsonb_build_object(
      'state',item.confidence_state,
      'score',item.confidence_score
    ),
    'value',item.value
  ) order by item.evidence_key) as items
  from atlas_private.brain_recommendation_evidence item
  where item.recommendation_id=recommendation.id
) evidence on true
left join lateral (
  select
    count(*)::bigint as decision_count,
    (array_agg(jsonb_build_object(
      'id',decision.id,
      'decision',decision.decision,
      'reason_code',decision.reason_code,
      'notes',decision.notes,
      'modified_action',decision.modified_action,
      'deferred_until',decision.deferred_until,
      'decided_by_label',decision.decided_by_label,
      'created_at',decision.created_at
    ) order by decision.created_at desc))[1] as last_decision
  from atlas_private.brain_decisions decision
  where decision.recommendation_id=recommendation.id
) decisions on true
left join lateral (
  select
    count(*)::bigint as outcome_count,
    (array_agg(jsonb_build_object(
      'id',outcome.id,
      'outcome_type',outcome.outcome_type,
      'outcome_status',outcome.outcome_status,
      'success_score',outcome.success_score,
      'result',outcome.result,
      'notes',outcome.notes,
      'observed_at',outcome.observed_at,
      'recorded_by_label',outcome.recorded_by_label
    ) order by outcome.observed_at desc))[1] as last_outcome
  from atlas_private.brain_outcomes outcome
  where outcome.recommendation_id=recommendation.id
) outcomes on true
left join lateral (
  select coalesce(jsonb_agg(jsonb_build_object(
    'decision',decision.decision,
    'reason_code',decision.reason_code,
    'notes',decision.notes,
    'modified_action',decision.modified_action,
    'status',decision.new_status,
    'actor',decision.decided_by_label,
    'occurred_at',decision.created_at,
    'recommendation_version',previous.version
  ) order by decision.created_at desc),'[]'::jsonb) as previous_decisions
  from atlas_private.brain_recommendations previous
  join atlas_private.brain_decisions decision on decision.recommendation_id=previous.id
  where previous.recommendation_key=recommendation.recommendation_key
    and previous.id<>recommendation.id
) memory on true;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 44
revoke all on atlas_private.brain_capability_gates from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 45
revoke all on atlas_private.brain_decision_memory from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 46
revoke all on atlas_private.brain_recommendation_feed from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 47
grant select on atlas_private.brain_capability_gates to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 48
grant select on atlas_private.brain_decision_memory to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 49
grant select on atlas_private.brain_recommendation_feed to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 50
create or replace function atlas_private.upsert_shadow_recommendation(
  p_recommendation_key text,
  p_recommendation_type text,
  p_capability_key text,
  p_subject_type text,
  p_subject_key text,
  p_title text,
  p_summary text,
  p_explanation text,
  p_suggested_action jsonb,
  p_alternatives jsonb,
  p_consequence_of_inaction jsonb,
  p_confidence_state text,
  p_confidence_score numeric,
  p_confidence_reason text,
  p_limitations text[],
  p_priority integer,
  p_source_kind text,
  p_source_schema text,
  p_source_object text,
  p_source_row_key text,
  p_evidence_label text,
  p_evidence_value jsonb,
  p_observed_at timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  calculated_fingerprint text;
  existing_row atlas_private.brain_recommendations;
  previous_row atlas_private.brain_recommendations;
  next_version integer;
  recommendation_id uuid;
begin
  if p_confidence_score < 0 or p_confidence_score > 1 then
    raise exception 'Confidence score must be between 0 and 1';
  end if;
  if jsonb_typeof(coalesce(p_alternatives,'[]'::jsonb)) <> 'array' then
    raise exception 'Alternatives must be a JSON array';
  end if;

  calculated_fingerprint := md5(concat_ws('|',
    p_recommendation_key,
    coalesce(p_subject_key,''),
    coalesce(p_evidence_value,'{}'::jsonb)::text,
    coalesce(p_suggested_action,'{}'::jsonb)::text,
    p_confidence_state,
    p_confidence_score::text,
    coalesce(array_to_string(p_limitations,'|'),'')
  ));

  select * into existing_row
  from atlas_private.brain_recommendations
  where recommendation_key=p_recommendation_key
    and fingerprint=calculated_fingerprint;

  if found then
    if existing_row.status='active' then
      update atlas_private.brain_recommendations
      set updated_at=pg_catalog.now(),generated_at=pg_catalog.now()
      where id=existing_row.id;
    end if;
    recommendation_id := existing_row.id;
  else
    select * into previous_row
    from atlas_private.brain_recommendations
    where recommendation_key=p_recommendation_key
    order by version desc
    limit 1;

    select coalesce(max(version),0)+1 into next_version
    from atlas_private.brain_recommendations
    where recommendation_key=p_recommendation_key;

    if previous_row.id is not null and previous_row.status in ('active','deferred') then
      update atlas_private.brain_recommendations
      set status='superseded',updated_at=pg_catalog.now()
      where id=previous_row.id;
    end if;

    insert into atlas_private.brain_recommendations (
      recommendation_key,version,fingerprint,recommendation_type,capability_key,
      subject_type,subject_key,title,summary,explanation,suggested_action,
      alternatives,consequence_of_inaction,confidence_state,confidence_score,
      confidence_reason,limitations,priority,shadow_mode,status,generated_by,
      generated_at,supersedes_id
    ) values (
      p_recommendation_key,next_version,calculated_fingerprint,p_recommendation_type,p_capability_key,
      p_subject_type,p_subject_key,p_title,p_summary,p_explanation,coalesce(p_suggested_action,'{}'::jsonb),
      coalesce(p_alternatives,'[]'::jsonb),coalesce(p_consequence_of_inaction,'{}'::jsonb),
      p_confidence_state,p_confidence_score,p_confidence_reason,coalesce(p_limitations,'{}'::text[]),
      p_priority,true,'active','atlas-phase3-deterministic/0.1.0',pg_catalog.now(),previous_row.id
    ) returning id into recommendation_id;
  end if;

  insert into atlas_private.brain_recommendation_evidence (
    recommendation_id,evidence_key,label,source_kind,source_schema,source_object,
    source_row_key,observed_at,confidence_state,confidence_score,value
  ) values (
    recommendation_id,'primary',p_evidence_label,p_source_kind,p_source_schema,p_source_object,
    p_source_row_key,p_observed_at,p_confidence_state,p_confidence_score,coalesce(p_evidence_value,'{}'::jsonb)
  )
  on conflict (recommendation_id,evidence_key) do update
  set label=excluded.label,
      source_kind=excluded.source_kind,
      source_schema=excluded.source_schema,
      source_object=excluded.source_object,
      source_row_key=excluded.source_row_key,
      observed_at=excluded.observed_at,
      confidence_state=excluded.confidence_state,
      confidence_score=excluded.confidence_score,
      value=excluded.value;

  return recommendation_id;
end;
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 51
create or replace function atlas_private.refresh_phase3_shadow_recommendations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  total_rows bigint := 0;
  pending_rows bigint := 0;
  reviewed_rows bigint := 0;
  issue_row record;
  gate_row record;
  recommendation_id uuid;
  generated_ids uuid[] := '{}';
begin
  select
    coalesce(sum(total_rows),0),
    coalesce(sum(pending_rows),0),
    coalesce(sum(approved_rows+rejected_rows+imported_rows),0)
  into total_rows,pending_rows,reviewed_rows
  from atlas_private.data_coverage;

  recommendation_id := atlas_private.upsert_shadow_recommendation(
    'data-readiness:review-queue',
    'data_quality',
    'decision_memory',
    'review_queue',
    'all',
    format('Review %s pending source records',pending_rows),
    format('%s of %s staged records have completed a manager decision.',reviewed_rows,total_rows),
    'Atlas cannot safely treat pending source rows as operational facts. Reviewing the highest-volume issue groups improves the evidence available to every later Brain capability.',
    jsonb_build_object('kind','open_review','target','sprint3-review','scope','all','status','pending'),
    jsonb_build_array(jsonb_build_object('label','Review one domain at a time','target','sprint3-review')),
    jsonb_build_object('risk','Shortage, purchase, menu and waste intelligence remain constrained by unresolved source mappings.'),
    'verified',1.00,
    'Queue totals are counted directly from the private review graph.',
    array['This recommendation improves data readiness; it does not change operational inventory.'],
    10,
    'database_view','atlas_private','data_coverage','all',
    'Real VÁ Data review coverage',
    jsonb_build_object('total_rows',total_rows,'pending_rows',pending_rows,'reviewed_rows',reviewed_rows),
    pg_catalog.now()
  );
  generated_ids := array_append(generated_ids,recommendation_id);

  for gate_row in
    select * from atlas_private.brain_capability_gates
    where enabled is false
    order by capability_key
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'capability-blocker:'||gate_row.capability_key,
      'governance',
      gate_row.capability_key,
      'capability',
      gate_row.capability_key,
      'Unlock '||gate_row.label,
      gate_row.label||' remains blocked until its required evidence is connected and verified.',
      'Atlas is intentionally refusing to generate this operational recommendation because one or more required evidence streams are missing or unverified.',
      jsonb_build_object('kind','connect_evidence','capability',gate_row.capability_key,'required_connections',gate_row.required_connections),
      jsonb_build_array(jsonb_build_object('label','Keep capability disabled','safe',true)),
      jsonb_build_object('risk','Enabling this capability early could create false confidence and unsafe operational decisions.'),
      'verified',1.00,
      'The blocker is computed from the explicit Phase 3 data-connection registry.',
      gate_row.blockers,
      15,
      'database_view','atlas_private','brain_capability_gates',gate_row.capability_key,
      gate_row.label||' evidence gate',
      jsonb_build_object('enabled',gate_row.enabled,'blockers',gate_row.blockers,'required_connections',gate_row.required_connections),
      pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  for issue_row in
    select entity_type,issue,severity,issue_count,
      case severity when 'error' then 1 when 'warning' then 2 when 'review' then 3 else 4 end as severity_rank
    from atlas_private.review_summary
    order by severity_rank,issue_count desc,issue
    limit 8
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'data-quality:'||issue_row.entity_type||':'||issue_row.issue,
      'data_quality',
      'recommendation_explanations',
      issue_row.entity_type,
      issue_row.issue,
      initcap(replace(issue_row.issue,'_',' ')),
      format('%s %s records carry this unresolved issue.',issue_row.issue_count,replace(issue_row.entity_type,'_',' ')),
      'Atlas recommends resolving this issue group because it is one of the largest current gaps in the private VÁ source graph. The recommendation is about evidence quality, not current stock or sales performance.',
      jsonb_build_object('kind','open_review','target','sprint3-review','entity_type',issue_row.entity_type,'issue',issue_row.issue),
      jsonb_build_array(jsonb_build_object('label','Defer this issue group','effect','The related Brain capabilities remain constrained.')),
      jsonb_build_object('risk','Unresolved records cannot be promoted into trusted operational context.'),
      'pending',0.45,
      'The issue count is verified, while the affected records remain unresolved.',
      array['Pending records are review work and are not treated as operational facts.'],
      20+issue_row.severity_rank,
      'database_view','atlas_private','review_summary',issue_row.entity_type||':'||issue_row.issue,
      'Unresolved source issue count',
      jsonb_build_object('entity_type',issue_row.entity_type,'issue_key',issue_row.issue,'severity',issue_row.severity,'issue_count',issue_row.issue_count),
      pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  return jsonb_build_object(
    'mode','shadow',
    'generated_at',pg_catalog.now(),
    'generated_recommendation_ids',to_jsonb(generated_ids),
    'recommendation_count',coalesce(array_length(generated_ids,1),0),
    'automatic_mutation',false
  );
end;
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 52
create or replace function atlas_private.decide_phase3_recommendation(
  p_recommendation_id uuid,
  p_decision text,
  p_reason_code text default null,
  p_notes text default null,
  p_modified_action jsonb default null,
  p_deferred_until timestamptz default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  before_row atlas_private.brain_recommendations;
  after_row atlas_private.brain_recommendations;
  existing_decision atlas_private.brain_decisions;
  new_status text;
  decision_id uuid;
begin
  if p_decision not in ('accept','reject','modify','defer','reset') then
    raise exception 'Invalid Phase 3 decision: %',p_decision;
  end if;

  if p_client_request_id is not null then
    select * into existing_decision
    from atlas_private.brain_decisions
    where client_request_id=p_client_request_id;
    if found then
      return jsonb_build_object('idempotent',true,'decision_id',existing_decision.id,'recommendation_id',existing_decision.recommendation_id);
    end if;
  end if;

  select * into before_row
  from atlas_private.brain_recommendations
  where id=p_recommendation_id
  for update;
  if not found then raise exception 'Phase 3 recommendation not found'; end if;

  if before_row.shadow_mode is not true then
    raise exception 'Only shadow recommendations can be decided in this Phase 3 checkpoint';
  end if;

  new_status := case p_decision
    when 'accept' then 'accepted'
    when 'reject' then 'rejected'
    when 'modify' then 'modified'
    when 'defer' then 'deferred'
    else 'active'
  end;

  if p_decision='modify' and (p_modified_action is null or p_modified_action='{}'::jsonb) then
    raise exception 'A modified recommendation requires a replacement action';
  end if;
  if p_decision='defer' and p_deferred_until is null then
    raise exception 'A deferred recommendation requires a deferred-until timestamp';
  end if;

  update atlas_private.brain_recommendations
  set status=new_status,
      suggested_action=case when p_decision='modify' then p_modified_action else suggested_action end,
      deferred_until=case when p_decision='defer' then p_deferred_until else null end,
      updated_at=pg_catalog.now()
  where id=p_recommendation_id
  returning * into after_row;

  insert into atlas_private.brain_decisions (
    recommendation_id,client_request_id,decision,previous_status,new_status,
    reason_code,notes,modified_action,deferred_until,decided_by,decided_by_label
  ) values (
    p_recommendation_id,p_client_request_id,p_decision,before_row.status,after_row.status,
    p_reason_code,p_notes,p_modified_action,p_deferred_until,p_decided_by,p_decided_by_label
  ) returning id into decision_id;

  return jsonb_build_object(
    'idempotent',false,
    'decision_id',decision_id,
    'recommendation_id',after_row.id,
    'recommendation_key',after_row.recommendation_key,
    'previous_status',before_row.status,
    'new_status',after_row.status,
    'automatic_mutation',false
  );
end;
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 53
create or replace function atlas_private.record_phase3_outcome(
  p_recommendation_id uuid,
  p_decision_id uuid default null,
  p_outcome_type text default 'manager_observation',
  p_outcome_status text default 'observed',
  p_success_score numeric default null,
  p_result jsonb default '{}'::jsonb,
  p_source_refs jsonb default '[]'::jsonb,
  p_notes text default null,
  p_observed_at timestamptz default now(),
  p_recorded_by uuid default null,
  p_recorded_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_outcome atlas_private.brain_outcomes;
  outcome_id uuid;
begin
  if p_success_score is not null and (p_success_score<0 or p_success_score>1) then
    raise exception 'Outcome success score must be between 0 and 1';
  end if;
  if p_outcome_status not in ('observed','confirmed','disputed') then
    raise exception 'Invalid outcome status';
  end if;
  if jsonb_typeof(coalesce(p_source_refs,'[]'::jsonb))<>'array' then
    raise exception 'Outcome source references must be a JSON array';
  end if;

  perform 1 from atlas_private.brain_recommendations where id=p_recommendation_id;
  if not found then raise exception 'Phase 3 recommendation not found'; end if;

  if p_client_request_id is not null then
    select * into existing_outcome
    from atlas_private.brain_outcomes
    where client_request_id=p_client_request_id;
    if found then
      return jsonb_build_object('idempotent',true,'outcome_id',existing_outcome.id,'recommendation_id',existing_outcome.recommendation_id);
    end if;
  end if;

  insert into atlas_private.brain_outcomes (
    recommendation_id,decision_id,client_request_id,outcome_type,outcome_status,
    success_score,result,source_refs,notes,observed_at,recorded_by,recorded_by_label
  ) values (
    p_recommendation_id,p_decision_id,p_client_request_id,p_outcome_type,p_outcome_status,
    p_success_score,coalesce(p_result,'{}'::jsonb),coalesce(p_source_refs,'[]'::jsonb),
    p_notes,p_observed_at,p_recorded_by,p_recorded_by_label
  ) returning id into outcome_id;

  return jsonb_build_object(
    'idempotent',false,
    'outcome_id',outcome_id,
    'recommendation_id',p_recommendation_id,
    'automatic_mutation',false
  );
end;
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 54
create or replace function atlas_private.phase3_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
select jsonb_build_object(
  'version','atlas-phase3/0.1.0',
  'mode','shadow',
  'generated_at',pg_catalog.now(),
  'stats',jsonb_build_object(
    'active_recommendations',(select count(*) from atlas_private.brain_recommendations where status='active'),
    'deferred_recommendations',(select count(*) from atlas_private.brain_recommendations where status='deferred'),
    'manager_decisions',(select count(*) from atlas_private.brain_decisions),
    'recorded_outcomes',(select count(*) from atlas_private.brain_outcomes),
    'memory_events',(select count(*) from atlas_private.brain_decision_memory)
  ),
  'capabilities',coalesce((
    select jsonb_agg(jsonb_build_object(
      'key',capability_key,
      'label',label,
      'enabled',enabled,
      'confidence',jsonb_build_object('state',confidence_state,'score',confidence_score),
      'blockers',blockers,
      'required_connections',required_connections,
      'source',source_ref
    ) order by capability_key)
    from atlas_private.brain_capability_gates
  ),'[]'::jsonb),
  'recommendations',coalesce((
    select jsonb_agg(to_jsonb(feed) order by feed.priority,feed.recommendation_key)
    from atlas_private.brain_recommendation_feed feed
    where feed.status in ('active','deferred')
      and (feed.valid_until is null or feed.valid_until>pg_catalog.now())
  ),'[]'::jsonb),
  'memory',coalesce((
    select jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc)
    from (
      select * from atlas_private.brain_decision_memory
      order by occurred_at desc
      limit 30
    ) memory
  ),'[]'::jsonb),
  'trust',jsonb_build_object(
    'ai_generation_used',false,
    'automatic_ordering',false,
    'automatic_menu_changes',false,
    'automatic_operational_mutation',false,
    'historical_stock_used_for_prediction',false,
    'manager_review_required',true
  )
);
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 55
create or replace function public.atlas_phase3_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select atlas_private.phase3_snapshot();
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 56
create or replace function public.atlas_phase3_refresh_shadow_recommendations()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.refresh_phase3_shadow_recommendations();
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 57
create or replace function public.atlas_phase3_decide_recommendation(
  p_recommendation_id uuid,
  p_decision text,
  p_reason_code text default null,
  p_notes text default null,
  p_modified_action jsonb default null,
  p_deferred_until timestamptz default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.decide_phase3_recommendation(
    p_recommendation_id,p_decision,p_reason_code,p_notes,p_modified_action,
    p_deferred_until,p_decided_by,p_decided_by_label,p_client_request_id
  );
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 58
create or replace function public.atlas_phase3_record_outcome(
  p_recommendation_id uuid,
  p_decision_id uuid default null,
  p_outcome_type text default 'manager_observation',
  p_outcome_status text default 'observed',
  p_success_score numeric default null,
  p_result jsonb default '{}'::jsonb,
  p_source_refs jsonb default '[]'::jsonb,
  p_notes text default null,
  p_observed_at timestamptz default now(),
  p_recorded_by uuid default null,
  p_recorded_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.record_phase3_outcome(
    p_recommendation_id,p_decision_id,p_outcome_type,p_outcome_status,p_success_score,
    p_result,p_source_refs,p_notes,p_observed_at,p_recorded_by,p_recorded_by_label,p_client_request_id
  );
$$;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 59
revoke execute on function atlas_private.upsert_shadow_recommendation(text,text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text,numeric,text,text[],integer,text,text,text,text,text,jsonb,timestamptz)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 60
revoke execute on function atlas_private.refresh_phase3_shadow_recommendations()
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 61
revoke execute on function atlas_private.decide_phase3_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 62
revoke execute on function atlas_private.record_phase3_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 63
revoke execute on function atlas_private.phase3_snapshot()
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 64
revoke execute on function public.atlas_phase3_snapshot()
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 65
revoke execute on function public.atlas_phase3_refresh_shadow_recommendations()
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 66
revoke execute on function public.atlas_phase3_decide_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 67
revoke execute on function public.atlas_phase3_record_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 68
grant execute on function atlas_private.upsert_shadow_recommendation(text,text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text,numeric,text,text[],integer,text,text,text,text,text,jsonb,timestamptz)
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 69
grant execute on function atlas_private.refresh_phase3_shadow_recommendations()
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 70
grant execute on function atlas_private.decide_phase3_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 71
grant execute on function atlas_private.record_phase3_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 72
grant execute on function atlas_private.phase3_snapshot()
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 73
grant execute on function public.atlas_phase3_snapshot()
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 74
grant execute on function public.atlas_phase3_refresh_shadow_recommendations()
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 75
grant execute on function public.atlas_phase3_decide_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 76
grant execute on function public.atlas_phase3_record_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 77
comment on table atlas_private.brain_recommendations is
  'Versioned, evidence-backed Atlas Brain recommendations. Phase 3 begins in shadow mode only.';

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 78
comment on table atlas_private.brain_decisions is
  'Immutable manager decisions used by Atlas Decision Memory.';

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 79
comment on table atlas_private.brain_outcomes is
  'Observed outcomes used to measure recommendation usefulness and future accuracy.';

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 80
comment on view atlas_private.brain_decision_memory is
  'Auditable memory of significant Real VÁ Data and Atlas recommendation decisions.';

-- SOURCE supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql statement 81
comment on function public.atlas_phase3_snapshot() is
  'Service-role-only Phase 3 shadow snapshot. Never mutates operational records.';

-- SOURCE supabase/migrations/20260802224500_atlas_brain_phase3_memory_fix.sql statement 0
-- Sprint 4 Phase 3 - qualify PL/pgSQL variables used by memory generation.
-- Public-safe function correction only. Contains no VÁ operational rows.

create or replace function atlas_private.upsert_shadow_recommendation(
  p_recommendation_key text,
  p_recommendation_type text,
  p_capability_key text,
  p_subject_type text,
  p_subject_key text,
  p_title text,
  p_summary text,
  p_explanation text,
  p_suggested_action jsonb,
  p_alternatives jsonb,
  p_consequence_of_inaction jsonb,
  p_confidence_state text,
  p_confidence_score numeric,
  p_confidence_reason text,
  p_limitations text[],
  p_priority integer,
  p_source_kind text,
  p_source_schema text,
  p_source_object text,
  p_source_row_key text,
  p_evidence_label text,
  p_evidence_value jsonb,
  p_observed_at timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  calculated_fingerprint text;
  existing_row atlas_private.brain_recommendations;
  previous_row atlas_private.brain_recommendations;
  next_version integer;
  v_recommendation_id uuid;
begin
  if p_confidence_score < 0 or p_confidence_score > 1 then
    raise exception 'Confidence score must be between 0 and 1';
  end if;
  if jsonb_typeof(coalesce(p_alternatives,'[]'::jsonb)) <> 'array' then
    raise exception 'Alternatives must be a JSON array';
  end if;

  calculated_fingerprint := md5(concat_ws('|',
    p_recommendation_key,
    coalesce(p_subject_key,''),
    coalesce(p_evidence_value,'{}'::jsonb)::text,
    coalesce(p_suggested_action,'{}'::jsonb)::text,
    p_confidence_state,
    p_confidence_score::text,
    coalesce(array_to_string(p_limitations,'|'),'')
  ));

  select * into existing_row
  from atlas_private.brain_recommendations recommendation
  where recommendation.recommendation_key=p_recommendation_key
    and recommendation.fingerprint=calculated_fingerprint;

  if found then
    if existing_row.status='active' then
      update atlas_private.brain_recommendations recommendation
      set updated_at=pg_catalog.now(),generated_at=pg_catalog.now()
      where recommendation.id=existing_row.id;
    end if;
    v_recommendation_id := existing_row.id;
  else
    select * into previous_row
    from atlas_private.brain_recommendations recommendation
    where recommendation.recommendation_key=p_recommendation_key
    order by recommendation.version desc
    limit 1;

    select coalesce(max(recommendation.version),0)+1 into next_version
    from atlas_private.brain_recommendations recommendation
    where recommendation.recommendation_key=p_recommendation_key;

    if previous_row.id is not null and previous_row.status in ('active','deferred') then
      update atlas_private.brain_recommendations recommendation
      set status='superseded',updated_at=pg_catalog.now()
      where recommendation.id=previous_row.id;
    end if;

    insert into atlas_private.brain_recommendations (
      recommendation_key,version,fingerprint,recommendation_type,capability_key,
      subject_type,subject_key,title,summary,explanation,suggested_action,
      alternatives,consequence_of_inaction,confidence_state,confidence_score,
      confidence_reason,limitations,priority,shadow_mode,status,generated_by,
      generated_at,supersedes_id
    ) values (
      p_recommendation_key,next_version,calculated_fingerprint,p_recommendation_type,p_capability_key,
      p_subject_type,p_subject_key,p_title,p_summary,p_explanation,coalesce(p_suggested_action,'{}'::jsonb),
      coalesce(p_alternatives,'[]'::jsonb),coalesce(p_consequence_of_inaction,'{}'::jsonb),
      p_confidence_state,p_confidence_score,p_confidence_reason,coalesce(p_limitations,'{}'::text[]),
      p_priority,true,'active','atlas-phase3-deterministic/0.1.0',pg_catalog.now(),previous_row.id
    ) returning id into v_recommendation_id;
  end if;

  insert into atlas_private.brain_recommendation_evidence (
    recommendation_id,evidence_key,label,source_kind,source_schema,source_object,
    source_row_key,observed_at,confidence_state,confidence_score,value
  ) values (
    v_recommendation_id,'primary',p_evidence_label,p_source_kind,p_source_schema,p_source_object,
    p_source_row_key,p_observed_at,p_confidence_state,p_confidence_score,coalesce(p_evidence_value,'{}'::jsonb)
  )
  on conflict (recommendation_id,evidence_key) do update
  set label=excluded.label,
      source_kind=excluded.source_kind,
      source_schema=excluded.source_schema,
      source_object=excluded.source_object,
      source_row_key=excluded.source_row_key,
      observed_at=excluded.observed_at,
      confidence_state=excluded.confidence_state,
      confidence_score=excluded.confidence_score,
      value=excluded.value;

  return v_recommendation_id;
end;
$$;

-- SOURCE supabase/migrations/20260802224500_atlas_brain_phase3_memory_fix.sql statement 1
create or replace function atlas_private.refresh_phase3_shadow_recommendations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_total_rows bigint := 0;
  v_pending_rows bigint := 0;
  v_reviewed_rows bigint := 0;
  issue_row record;
  gate_row record;
  recommendation_id uuid;
  generated_ids uuid[] := '{}';
begin
  select
    coalesce(sum(coverage.total_rows),0),
    coalesce(sum(coverage.pending_rows),0),
    coalesce(sum(coverage.approved_rows+coverage.rejected_rows+coverage.imported_rows),0)
  into v_total_rows,v_pending_rows,v_reviewed_rows
  from atlas_private.data_coverage coverage;

  recommendation_id := atlas_private.upsert_shadow_recommendation(
    'data-readiness:review-queue','data_quality','decision_memory','review_queue','all',
    format('Review %s pending source records',v_pending_rows),
    format('%s of %s staged records have completed a manager decision.',v_reviewed_rows,v_total_rows),
    'Atlas cannot safely treat pending source rows as operational facts. Reviewing the highest-volume issue groups improves the evidence available to every later Brain capability.',
    jsonb_build_object('kind','open_review','target','sprint3-review','scope','all','status','pending'),
    jsonb_build_array(jsonb_build_object('label','Review one domain at a time','target','sprint3-review')),
    jsonb_build_object('risk','Shortage, purchase, menu and waste intelligence remain constrained by unresolved source mappings.'),
    'verified',1.00,'Queue totals are counted directly from the private review graph.',
    array['This recommendation improves data readiness; it does not change operational inventory.'],
    10,'database_view','atlas_private','data_coverage','all','Real VÁ Data review coverage',
    jsonb_build_object('total_rows',v_total_rows,'pending_rows',v_pending_rows,'reviewed_rows',v_reviewed_rows),pg_catalog.now()
  );
  generated_ids := array_append(generated_ids,recommendation_id);

  for gate_row in
    select * from atlas_private.brain_capability_gates where enabled is false order by capability_key
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'capability-blocker:'||gate_row.capability_key,'governance',gate_row.capability_key,'capability',gate_row.capability_key,
      'Unlock '||gate_row.label,
      gate_row.label||' remains blocked until its required evidence is connected and verified.',
      'Atlas is intentionally refusing to generate this operational recommendation because one or more required evidence streams are missing or unverified.',
      jsonb_build_object('kind','connect_evidence','capability',gate_row.capability_key,'required_connections',gate_row.required_connections),
      jsonb_build_array(jsonb_build_object('label','Keep capability disabled','safe',true)),
      jsonb_build_object('risk','Enabling this capability early could create false confidence and unsafe operational decisions.'),
      'verified',1.00,'The blocker is computed from the explicit Phase 3 data-connection registry.',
      gate_row.blockers,15,'database_view','atlas_private','brain_capability_gates',gate_row.capability_key,
      gate_row.label||' evidence gate',
      jsonb_build_object('enabled',gate_row.enabled,'blockers',gate_row.blockers,'required_connections',gate_row.required_connections),pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  for issue_row in
    select summary.entity_type,summary.issue,summary.severity,summary.issue_count,
      case summary.severity when 'error' then 1 when 'warning' then 2 when 'review' then 3 else 4 end as severity_rank
    from atlas_private.review_summary summary
    order by severity_rank,summary.issue_count desc,summary.issue
    limit 8
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'data-quality:'||issue_row.entity_type||':'||issue_row.issue,'data_quality','recommendation_explanations',
      issue_row.entity_type,issue_row.issue,initcap(replace(issue_row.issue,'_',' ')),
      format('%s %s records carry this unresolved issue.',issue_row.issue_count,replace(issue_row.entity_type,'_',' ')),
      'Atlas recommends resolving this issue group because it is one of the largest current gaps in the private VÁ source graph. The recommendation is about evidence quality, not current stock or sales performance.',
      jsonb_build_object('kind','open_review','target','sprint3-review','entity_type',issue_row.entity_type,'issue',issue_row.issue),
      jsonb_build_array(jsonb_build_object('label','Defer this issue group','effect','The related Brain capabilities remain constrained.')),
      jsonb_build_object('risk','Unresolved records cannot be promoted into trusted operational context.'),
      'pending',0.45,'The issue count is verified, while the affected records remain unresolved.',
      array['Pending records are review work and are not treated as operational facts.'],
      20+issue_row.severity_rank,'database_view','atlas_private','review_summary',issue_row.entity_type||':'||issue_row.issue,
      'Unresolved source issue count',
      jsonb_build_object('entity_type',issue_row.entity_type,'issue_key',issue_row.issue,'severity',issue_row.severity,'issue_count',issue_row.issue_count),pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  return jsonb_build_object(
    'mode','shadow','generated_at',pg_catalog.now(),
    'generated_recommendation_ids',to_jsonb(generated_ids),
    'recommendation_count',coalesce(array_length(generated_ids,1),0),
    'automatic_mutation',false
  );
end;
$$;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 0
-- Sprint 4 Phase 3 - service-role read contracts for recommendation detail and memory.
-- Public-safe database contract only. Contains no VÁ operational rows.

create or replace function public.atlas_phase3_recommendation_detail(p_recommendation_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  recommendation_row atlas_private.brain_recommendation_feed;
  memory_items jsonb;
begin
  select * into recommendation_row
  from atlas_private.brain_recommendation_feed feed
  where feed.id=p_recommendation_id;
  if not found then raise exception 'Phase 3 recommendation not found'; end if;

  select coalesce(jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc),'[]'::jsonb)
  into memory_items
  from (
    select *
    from atlas_private.brain_decision_memory memory
    where (memory.context->>'recommendation_id')::uuid=p_recommendation_id
       or (memory.subject_type=recommendation_row.subject_type
           and memory.subject_key=recommendation_row.subject_key)
    order by memory.occurred_at desc
    limit 50
  ) memory;

  return jsonb_build_object(
    'recommendation',to_jsonb(recommendation_row),
    'memory',memory_items,
    'trust',jsonb_build_object(
      'shadow_mode',recommendation_row.shadow_mode,
      'automatic_operational_mutation',false,
      'manager_review_required',true
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 1
create or replace function public.atlas_phase3_memory_search(
  p_subject_type text default null,
  p_subject_key text default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc),'[]'::jsonb)
  from (
    select *
    from atlas_private.brain_decision_memory memory
    where (p_subject_type is null or memory.subject_type=p_subject_type)
      and (p_subject_key is null or memory.subject_key=p_subject_key)
    order by memory.occurred_at desc
    limit greatest(1,least(coalesce(p_limit,50),100))
  ) memory;
$$;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 2
revoke execute on function public.atlas_phase3_recommendation_detail(uuid)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 3
revoke execute on function public.atlas_phase3_memory_search(text,text,integer)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 4
grant execute on function public.atlas_phase3_recommendation_detail(uuid)
  to service_role;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 5
grant execute on function public.atlas_phase3_memory_search(text,text,integer)
  to service_role;

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 6
comment on function public.atlas_phase3_recommendation_detail(uuid) is
  'Service-role-only evidence, outcome and memory detail for one shadow recommendation.';

-- SOURCE supabase/migrations/20260802225000_atlas_brain_phase3_api.sql statement 7
comment on function public.atlas_phase3_memory_search(text,text,integer) is
  'Service-role-only search over significant Atlas and Real VÁ Data decision memory.';

-- SOURCE supabase/migrations/20260802230000_atlas_brain_phase3_indexes.sql statement 0
-- Sprint 4 Phase 3 - covering indexes for memory relationship lookups.
-- Public-safe performance contract only. Contains no VÁ operational rows.

create index if not exists brain_recommendations_supersedes_idx
  on atlas_private.brain_recommendations(supersedes_id)
  where supersedes_id is not null;

-- SOURCE supabase/migrations/20260802230000_atlas_brain_phase3_indexes.sql statement 1
create index if not exists brain_outcomes_decision_idx
  on atlas_private.brain_outcomes(decision_id)
  where decision_id is not null;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 0
-- Atlas Operations Checkpoint A
-- Weekly routines, daily temperature logs and connection-readiness boundaries.
-- Public-safe schema and default templates only; contains no private operational history.

create table if not exists atlas_private.routine_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  name text not null,
  description text,
  routine_type text not null check (routine_type in ('inventory','deep_cleaning','storage','temperature','other')),
  recurrence text not null check (recurrence in ('daily','weekly')),
  days_of_week smallint[] not null default '{}',
  available_from time,
  due_time time,
  assigned_role text check (assigned_role is null or assigned_role in ('admin','manager','bartender','viewer','any_active_staff')),
  requires_manager_signoff boolean not null default false,
  allow_photo_evidence boolean not null default false,
  active boolean not null default true,
  display_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 1
create table if not exists atlas_private.routine_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references atlas_private.routine_templates(id) on delete cascade,
  item_key text not null,
  section text,
  label text not null,
  description text,
  evidence_type text not null default 'none'
    check (evidence_type in ('none','note','photo','stock_count','temperature','maintenance')),
  required boolean not null default true,
  active boolean not null default true,
  display_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id,item_key)
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 2
create table if not exists atlas_private.routine_instances (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references atlas_private.routine_templates(id) on delete cascade,
  scheduled_date date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','in_progress','completed','overdue','skipped')),
  assigned_to uuid,
  assigned_to_label text,
  started_at timestamptz,
  started_by uuid,
  started_by_label text,
  completed_at timestamptz,
  completed_by uuid,
  completed_by_label text,
  completion_notes text,
  manager_signed_off_at timestamptz,
  manager_signed_off_by uuid,
  manager_signed_off_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id,scheduled_date)
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 3
create table if not exists atlas_private.routine_item_results (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references atlas_private.routine_instances(id) on delete cascade,
  template_item_id uuid not null references atlas_private.routine_template_items(id) on delete cascade,
  completed boolean not null default false,
  note text,
  evidence jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  completed_by uuid,
  completed_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instance_id,template_item_id)
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 4
create table if not exists atlas_private.temperature_points (
  id uuid primary key default gen_random_uuid(),
  point_key text not null unique,
  name text not null,
  location text,
  equipment_type text not null default 'refrigerator'
    check (equipment_type in ('refrigerator','freezer','wine_cooler','cooler_table','other')),
  min_temp_c numeric,
  max_temp_c numeric,
  active boolean not null default true,
  display_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_temp_c is null or max_temp_c is null or min_temp_c <= max_temp_c)
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 5
create table if not exists atlas_private.temperature_logs (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references atlas_private.temperature_points(id) on delete cascade,
  reading_date date not null,
  reading_at timestamptz not null default now(),
  temperature_c numeric not null check (temperature_c between -60 and 120),
  range_status text not null
    check (range_status in ('within_range','outside_range','range_unconfigured')),
  corrective_action text,
  note text,
  logged_by uuid,
  logged_by_label text,
  source text not null default 'manual' check (source in ('manual','sensor','import')),
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 6
create table if not exists atlas_private.operations_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  actor_id uuid,
  actor_label text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 7
create table if not exists atlas_private.integration_connections (
  provider_key text primary key,
  label text not null,
  category text not null check (category in ('social','reputation','business_profile','other')),
  status text not null default 'not_connected'
    check (status in ('not_connected','authorization_required','pending_review','connected','degraded','expired','not_applicable')),
  capabilities jsonb not null default '{}'::jsonb,
  requirements jsonb not null default '{}'::jsonb,
  external_account_id text,
  external_account_label text,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 8
create index if not exists routine_templates_schedule_idx
  on atlas_private.routine_templates(active,display_order);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 9
create index if not exists routine_template_items_order_idx
  on atlas_private.routine_template_items(template_id,active,display_order);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 10
create index if not exists routine_instances_date_status_idx
  on atlas_private.routine_instances(scheduled_date,status,template_id);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 11
create index if not exists routine_item_results_instance_idx
  on atlas_private.routine_item_results(instance_id,completed,template_item_id);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 12
create index if not exists temperature_logs_date_point_idx
  on atlas_private.temperature_logs(reading_date,point_id,reading_at desc);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 13
create index if not exists temperature_logs_point_time_idx
  on atlas_private.temperature_logs(point_id,reading_at desc);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 14
create index if not exists operations_events_entity_idx
  on atlas_private.operations_events(entity_type,entity_id,created_at desc);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 15
alter table atlas_private.routine_templates enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 16
alter table atlas_private.routine_template_items enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 17
alter table atlas_private.routine_instances enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 18
alter table atlas_private.routine_item_results enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 19
alter table atlas_private.temperature_points enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 20
alter table atlas_private.temperature_logs enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 21
alter table atlas_private.operations_events enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 22
alter table atlas_private.integration_connections enable row level security;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 23
drop policy if exists "service role manages routine templates" on atlas_private.routine_templates;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 24
create policy "service role manages routine templates" on atlas_private.routine_templates
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 25
drop policy if exists "service role manages routine template items" on atlas_private.routine_template_items;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 26
create policy "service role manages routine template items" on atlas_private.routine_template_items
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 27
drop policy if exists "service role manages routine instances" on atlas_private.routine_instances;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 28
create policy "service role manages routine instances" on atlas_private.routine_instances
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 29
drop policy if exists "service role manages routine item results" on atlas_private.routine_item_results;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 30
create policy "service role manages routine item results" on atlas_private.routine_item_results
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 31
drop policy if exists "service role manages temperature points" on atlas_private.temperature_points;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 32
create policy "service role manages temperature points" on atlas_private.temperature_points
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 33
drop policy if exists "service role manages temperature logs" on atlas_private.temperature_logs;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 34
create policy "service role manages temperature logs" on atlas_private.temperature_logs
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 35
drop policy if exists "service role manages operations events" on atlas_private.operations_events;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 36
create policy "service role manages operations events" on atlas_private.operations_events
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 37
drop policy if exists "service role manages integration connections" on atlas_private.integration_connections;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 38
create policy "service role manages integration connections" on atlas_private.integration_connections
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 39
revoke all on atlas_private.routine_templates from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 40
revoke all on atlas_private.routine_template_items from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 41
revoke all on atlas_private.routine_instances from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 42
revoke all on atlas_private.routine_item_results from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 43
revoke all on atlas_private.temperature_points from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 44
revoke all on atlas_private.temperature_logs from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 45
revoke all on atlas_private.operations_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 46
revoke all on atlas_private.integration_connections from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 47
grant all on atlas_private.routine_templates to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 48
grant all on atlas_private.routine_template_items to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 49
grant all on atlas_private.routine_instances to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 50
grant all on atlas_private.routine_item_results to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 51
grant all on atlas_private.temperature_points to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 52
grant all on atlas_private.temperature_logs to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 53
grant select,insert on atlas_private.operations_events to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 54
grant all on atlas_private.integration_connections to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 55
drop trigger if exists routine_templates_touch on atlas_private.routine_templates;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 56
create trigger routine_templates_touch before update on atlas_private.routine_templates
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 57
drop trigger if exists routine_template_items_touch on atlas_private.routine_template_items;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 58
create trigger routine_template_items_touch before update on atlas_private.routine_template_items
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 59
drop trigger if exists routine_instances_touch on atlas_private.routine_instances;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 60
create trigger routine_instances_touch before update on atlas_private.routine_instances
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 61
drop trigger if exists routine_item_results_touch on atlas_private.routine_item_results;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 62
create trigger routine_item_results_touch before update on atlas_private.routine_item_results
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 63
drop trigger if exists temperature_points_touch on atlas_private.temperature_points;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 64
create trigger temperature_points_touch before update on atlas_private.temperature_points
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 65
drop trigger if exists integration_connections_touch on atlas_private.integration_connections;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 66
create trigger integration_connections_touch before update on atlas_private.integration_connections
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 72
insert into atlas_private.integration_connections (
  provider_key,label,category,status,capabilities,requirements,metadata
) values
  ('instagram','Instagram','social','not_connected','{"content_planning":"available","draft_generation":"shadow","publishing":"requires_oauth_and_platform_permissions","insights":"requires_oauth_and_permissions"}'::jsonb,'{"business_or_creator_account":true,"meta_app":true,"oauth":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('facebook','Facebook','social','not_connected','{"content_planning":"available","draft_generation":"shadow","publishing":"requires_oauth_and_page_permissions","insights":"requires_oauth_and_permissions"}'::jsonb,'{"facebook_page":true,"meta_app":true,"oauth":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('tiktok','TikTok','social','not_connected','{"content_planning":"available","draft_generation":"shadow","publishing":"requires_platform_approval_and_oauth","analytics":"requires_platform_permissions"}'::jsonb,'{"developer_app":true,"oauth":true,"approved_scopes":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('google-business-profile','Google Business Profile','business_profile','not_connected','{"content_planning":"available","posts":"requires_oauth_and_account_access","reviews_read":"requires_oauth_and_account_access","review_response":"requires_oauth_and_account_access","metrics":"requires_supported_api_access"}'::jsonb,'{"verified_business_profile":true,"google_cloud_project":true,"oauth":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('tripadvisor','Tripadvisor','reputation','not_connected','{"content_read":"available_via_terra_or_content_api_subject_to_plan","reviews_read":"subject_to_api_access_and_terms","response_drafting":"shadow","response_submission":"manual_management_center_until_supported_write_api_is_verified","social_post_publishing":"not_applicable"}'::jsonb,'{"claimed_listing":true,"management_center_access":true,"api_key_and_billing_for_content_api":true}'::jsonb,'{"credentials_stored_outside_table":true,"review_responses_must_follow_tripadvisor_guidelines":true,"no_incentivized_reviews":true,"no_review_gating":true}'::jsonb)
on conflict (provider_key) do update set
  label=excluded.label,category=excluded.category,capabilities=excluded.capabilities,
  requirements=excluded.requirements,metadata=excluded.metadata,updated_at=now();

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 73
create or replace function atlas_private.ensure_routine_instances(p_local_date date)
returns bigint
language plpgsql
security invoker
set search_path=''
as $$
declare inserted_count bigint;
begin
  insert into atlas_private.routine_instances (template_id,scheduled_date,status)
  select template.id,p_local_date,'scheduled'
  from atlas_private.routine_templates template
  where template.active=true
    and extract(dow from p_local_date)::smallint = any(template.days_of_week)
  on conflict (template_id,scheduled_date) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 74
create or replace function atlas_private.operations_today(p_local_date date)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  local_now timestamp := pg_catalog.now() at time zone 'Atlantic/Reykjavik';
  routines_json jsonb := '[]'::jsonb;
  points_json jsonb := '[]'::jsonb;
  temperature_summary jsonb := '{}'::jsonb;
  alerts_json jsonb := '[]'::jsonb;
  connections_json jsonb := '[]'::jsonb;
begin
  perform atlas_private.ensure_routine_instances(p_local_date);

  update atlas_private.routine_instances instance
  set status='overdue'
  from atlas_private.routine_templates template
  where instance.template_id=template.id
    and instance.scheduled_date=p_local_date
    and instance.status in ('scheduled','in_progress')
    and template.due_time is not null
    and p_local_date = local_now::date
    and local_now::time > template.due_time;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',instance.id,'template_id',template.id,'template_key',template.template_key,
    'name',template.name,'description',template.description,'routine_type',template.routine_type,
    'available_from',template.available_from,'due_time',template.due_time,
    'assigned_role',template.assigned_role,'requires_manager_signoff',template.requires_manager_signoff,
    'allow_photo_evidence',template.allow_photo_evidence,'status',instance.status,
    'scheduled_date',instance.scheduled_date,'started_at',instance.started_at,
    'completed_at',instance.completed_at,'completed_by_label',instance.completed_by_label,
    'completion_notes',instance.completion_notes,
    'progress',jsonb_build_object(
      'required',coalesce(counts.required_count,0),'completed',coalesce(counts.completed_count,0),
      'percent',case when coalesce(counts.required_count,0)=0 then
        case when template.routine_type='temperature' then 0 else 100 end
        else round((counts.completed_count::numeric/counts.required_count::numeric)*100) end),
    'items',coalesce(items.items,'[]'::jsonb),'metadata',template.metadata
  ) order by template.display_order,template.name),'[]'::jsonb)
  into routines_json
  from atlas_private.routine_instances instance
  join atlas_private.routine_templates template on template.id=instance.template_id
  left join lateral (
    select count(*) filter (where item.required and item.active)::bigint as required_count,
      count(*) filter (where item.required and item.active and coalesce(result.completed,false))::bigint as completed_count
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance.id
    where item.template_id=template.id
  ) counts on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'id',item.id,'item_key',item.item_key,'section',item.section,'label',item.label,
      'description',item.description,'evidence_type',item.evidence_type,'required',item.required,
      'completed',coalesce(result.completed,false),'note',result.note,
      'evidence',coalesce(result.evidence,'{}'::jsonb),'completed_at',result.completed_at,
      'completed_by_label',result.completed_by_label,'metadata',item.metadata
    ) order by item.display_order,item.label) as items
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance.id
    where item.template_id=template.id and item.active=true
  ) items on true
  where instance.scheduled_date=p_local_date;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',point.id,'point_key',point.point_key,'name',point.name,'location',point.location,
    'equipment_type',point.equipment_type,'min_temp_c',point.min_temp_c,'max_temp_c',point.max_temp_c,
    'range_configured',(point.min_temp_c is not null or point.max_temp_c is not null),
    'logged_today',(latest.id is not null),
    'latest_log',case when latest.id is null then null else jsonb_build_object(
      'id',latest.id,'temperature_c',latest.temperature_c,'range_status',latest.range_status,
      'corrective_action',latest.corrective_action,'note',latest.note,
      'reading_at',latest.reading_at,'logged_by_label',latest.logged_by_label) end,
    'metadata',point.metadata
  ) order by point.display_order,point.name),'[]'::jsonb)
  into points_json
  from atlas_private.temperature_points point
  left join lateral (
    select log.* from atlas_private.temperature_logs log
    where log.point_id=point.id and log.reading_date=p_local_date
    order by log.reading_at desc limit 1
  ) latest on true
  where point.active=true;

  select jsonb_build_object(
    'required_points',count(*)::bigint,
    'logged_points',count(*) filter (where latest.id is not null)::bigint,
    'outstanding_points',count(*) filter (where latest.id is null)::bigint,
    'outside_range_points',count(*) filter (where latest.range_status='outside_range')::bigint,
    'range_unconfigured_points',count(*) filter (where point.min_temp_c is null and point.max_temp_c is null)::bigint,
    'complete',(count(*)>0 and count(*) filter (where latest.id is not null)=count(*))
  ) into temperature_summary
  from atlas_private.temperature_points point
  left join lateral (
    select log.* from atlas_private.temperature_logs log
    where log.point_id=point.id and log.reading_date=p_local_date
    order by log.reading_at desc limit 1
  ) latest on true
  where point.active=true;

  select coalesce(jsonb_agg(alert order by priority,sort_name),'[]'::jsonb)
  into alerts_json
  from (
    select case when instance.status='overdue' then 1 else 10 end as priority,
      template.name as sort_name,
      jsonb_build_object(
        'key','routine:'||instance.id::text,'kind','routine',
        'severity',case when instance.status='overdue' then 'high' else 'medium' end,
        'title',coalesce(template.metadata->>'alert_label',template.name),
        'detail',case when instance.status='overdue' then 'This routine is overdue.' else 'This routine is scheduled for today.' end,
        'routine_id',instance.id,'status',instance.status,'due_time',template.due_time,'target','routines') as alert
    from atlas_private.routine_instances instance
    join atlas_private.routine_templates template on template.id=instance.template_id
    where instance.scheduled_date=p_local_date and template.routine_type<>'temperature'
      and instance.status not in ('completed','skipped')
    union all
    select 5,'Daily temperature log',jsonb_build_object(
      'key','temperature:'||p_local_date::text,'kind','temperature',
      'severity',case when (temperature_summary->>'outside_range_points')::bigint>0 then 'high' else 'medium' end,
      'title','Daily temperature log',
      'detail',format('%s of %s active points logged.',temperature_summary->>'logged_points',temperature_summary->>'required_points'),
      'status',case when (temperature_summary->>'complete')::boolean then 'completed' else 'due' end,
      'target','temperature-log')
    where not (temperature_summary->>'complete')::boolean
       or (temperature_summary->>'outside_range_points')::bigint>0
  ) alerts;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',provider_key,'label',label,'category',category,'status',status,
    'capabilities',capabilities,'requirements',requirements,
    'external_account_label',external_account_label,'last_verified_at',last_verified_at,'metadata',metadata
  ) order by category,label),'[]'::jsonb)
  into connections_json
  from atlas_private.integration_connections;

  return jsonb_build_object(
    'version','atlas-operations-checkpoint-a/0.1.0','venue_date',p_local_date,
    'generated_at',pg_catalog.now(),'routines',routines_json,
    'temperature',jsonb_build_object('summary',temperature_summary,'points',points_json),
    'alerts',alerts_json,'connections',connections_json,
    'trust',jsonb_build_object('private_branch',true,'manager_review_for_settings',true,
      'quantity_mutation',false,'temperature_logs_audited',true,'routine_history_preserved',true));
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 75
create or replace function atlas_private.set_routine_item(
  p_instance_id uuid,p_template_item_id uuid,p_completed boolean,p_note text,p_evidence jsonb,
  p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_item_row atlas_private.routine_template_items;
begin
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  if instance_row.status in ('completed','skipped') then raise exception 'Completed or skipped routines cannot be edited'; end if;
  select * into template_item_row from atlas_private.routine_template_items
  where id=p_template_item_id and template_id=instance_row.template_id and active=true;
  if not found then raise exception 'Routine checklist item not found'; end if;

  insert into atlas_private.routine_item_results (
    instance_id,template_item_id,completed,note,evidence,completed_at,completed_by,completed_by_label
  ) values (
    p_instance_id,p_template_item_id,p_completed,nullif(trim(coalesce(p_note,'')),''),coalesce(p_evidence,'{}'::jsonb),
    case when p_completed then pg_catalog.now() else null end,
    case when p_completed then p_actor_id else null end,
    case when p_completed then p_actor_label else null end)
  on conflict (instance_id,template_item_id) do update set
    completed=excluded.completed,note=excluded.note,evidence=excluded.evidence,
    completed_at=excluded.completed_at,completed_by=excluded.completed_by,
    completed_by_label=excluded.completed_by_label,updated_at=pg_catalog.now();

  update atlas_private.routine_instances
  set status=case when status='scheduled' and p_completed then 'in_progress' else status end,
      started_at=case when started_at is null and p_completed then pg_catalog.now() else started_at end,
      started_by=case when started_at is null and p_completed then p_actor_id else started_by end,
      started_by_label=case when started_at is null and p_completed then p_actor_label else started_by_label end
  where id=p_instance_id;

  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_item_updated','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object('template_item_id',p_template_item_id,'completed',p_completed,'note',p_note));
  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 76
create or replace function atlas_private.complete_routine(
  p_instance_id uuid,p_notes text,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_row atlas_private.routine_templates;
  incomplete_count bigint;
  missing_temperatures bigint;
begin
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  select * into template_row from atlas_private.routine_templates where id=instance_row.template_id;
  if template_row.routine_type='temperature' then
    select count(*) into missing_temperatures
    from atlas_private.temperature_points point
    where point.active=true and not exists (
      select 1 from atlas_private.temperature_logs log
      where log.point_id=point.id and log.reading_date=instance_row.scheduled_date);
    if missing_temperatures>0 then raise exception '% temperature points still need a reading',missing_temperatures; end if;
  else
    select count(*) into incomplete_count
    from atlas_private.routine_template_items item
    where item.template_id=instance_row.template_id and item.active=true and item.required=true
      and not exists (
        select 1 from atlas_private.routine_item_results result
        where result.instance_id=instance_row.id and result.template_item_id=item.id and result.completed=true);
    if incomplete_count>0 then raise exception '% required checklist items are incomplete',incomplete_count; end if;
  end if;
  update atlas_private.routine_instances
  set status='completed',completed_at=pg_catalog.now(),completed_by=p_actor_id,
      completed_by_label=p_actor_label,completion_notes=nullif(trim(coalesce(p_notes,'')),'')
  where id=p_instance_id;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_completed','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object('notes',p_notes,'template_key',template_row.template_key));
  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 77
create or replace function atlas_private.skip_routine(
  p_instance_id uuid,p_reason text,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare instance_row atlas_private.routine_instances;
begin
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A skip reason is required'; end if;
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  update atlas_private.routine_instances
  set status='skipped',completion_notes=p_reason,completed_at=pg_catalog.now(),
      completed_by=p_actor_id,completed_by_label=p_actor_label
  where id=p_instance_id;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_skipped','routine_instance',p_instance_id,p_actor_id,p_actor_label,jsonb_build_object('reason',p_reason));
  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 78
create or replace function atlas_private.log_temperature(
  p_point_id uuid,p_temperature_c numeric,p_note text,p_corrective_action text,
  p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare
  point_row atlas_private.temperature_points;
  local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
  calculated_status text;
  missing_count bigint;
  temperature_template_id uuid;
begin
  select * into point_row from atlas_private.temperature_points where id=p_point_id and active=true;
  if not found then raise exception 'Temperature point not found or inactive'; end if;
  if p_temperature_c < -60 or p_temperature_c > 120 then raise exception 'Temperature reading is outside the accepted input range'; end if;
  calculated_status := case
    when point_row.min_temp_c is null and point_row.max_temp_c is null then 'range_unconfigured'
    when point_row.min_temp_c is not null and p_temperature_c < point_row.min_temp_c then 'outside_range'
    when point_row.max_temp_c is not null and p_temperature_c > point_row.max_temp_c then 'outside_range'
    else 'within_range' end;
  if calculated_status='outside_range' and nullif(trim(coalesce(p_corrective_action,'')),'') is null then
    raise exception 'Corrective action is required for an out-of-range temperature';
  end if;
  insert into atlas_private.temperature_logs (
    point_id,reading_date,temperature_c,range_status,corrective_action,note,logged_by,logged_by_label
  ) values (
    p_point_id,local_date,p_temperature_c,calculated_status,
    nullif(trim(coalesce(p_corrective_action,'')),''),nullif(trim(coalesce(p_note,'')),''),p_actor_id,p_actor_label);
  perform atlas_private.ensure_routine_instances(local_date);
  select id into temperature_template_id from atlas_private.routine_templates where template_key='daily-temperature-log';
  select count(*) into missing_count
  from atlas_private.temperature_points point
  where point.active=true and not exists (
    select 1 from atlas_private.temperature_logs log where log.point_id=point.id and log.reading_date=local_date);
  if missing_count=0 then
    update atlas_private.routine_instances
    set status='completed',completed_at=coalesce(completed_at,pg_catalog.now()),
        completed_by=coalesce(completed_by,p_actor_id),completed_by_label=coalesce(completed_by_label,p_actor_label),
        completion_notes=coalesce(completion_notes,'All active temperature points logged.')
    where template_id=temperature_template_id and scheduled_date=local_date and status<>'skipped';
  else
    update atlas_private.routine_instances
    set status=case when status='scheduled' then 'in_progress' else status end,
        started_at=coalesce(started_at,pg_catalog.now()),started_by=coalesce(started_by,p_actor_id),
        started_by_label=coalesce(started_by_label,p_actor_label)
    where template_id=temperature_template_id and scheduled_date=local_date and status not in ('completed','skipped');
  end if;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('temperature_logged','temperature_point',p_point_id,p_actor_id,p_actor_label,
    jsonb_build_object('temperature_c',p_temperature_c,'range_status',calculated_status,'corrective_action',p_corrective_action));
  return atlas_private.operations_today(local_date);
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 79
create or replace function atlas_private.update_routine_template(
  p_template_id uuid,p_name text,p_description text,p_days_of_week smallint[],
  p_available_from time,p_due_time time,p_assigned_role text,p_active boolean,
  p_requires_manager_signoff boolean,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
begin
  if p_days_of_week is null or cardinality(p_days_of_week)=0 then raise exception 'At least one day of week is required'; end if;
  if exists (select 1 from unnest(p_days_of_week) day_value where day_value<0 or day_value>6) then raise exception 'Days of week must be between 0 and 6'; end if;
  if p_assigned_role is not null and p_assigned_role not in ('admin','manager','bartender','viewer','any_active_staff') then raise exception 'Invalid assigned role'; end if;
  update atlas_private.routine_templates
  set name=coalesce(nullif(trim(p_name),''),name),description=p_description,days_of_week=p_days_of_week,
      available_from=p_available_from,due_time=p_due_time,assigned_role=p_assigned_role,
      active=coalesce(p_active,active),requires_manager_signoff=coalesce(p_requires_manager_signoff,requires_manager_signoff),
      updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=p_template_id;
  if not found then raise exception 'Routine template not found'; end if;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_template_updated','routine_template',p_template_id,p_actor_id,p_actor_label,
    jsonb_build_object('days_of_week',p_days_of_week,'due_time',p_due_time,'active',p_active));
  return atlas_private.operations_today(local_date);
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 80
create or replace function atlas_private.update_temperature_point(
  p_point_id uuid,p_name text,p_location text,p_min_temp_c numeric,p_max_temp_c numeric,
  p_active boolean,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
begin
  if p_min_temp_c is not null and p_max_temp_c is not null and p_min_temp_c>p_max_temp_c then
    raise exception 'Minimum temperature cannot exceed maximum temperature'; end if;
  update atlas_private.temperature_points
  set name=coalesce(nullif(trim(p_name),''),name),location=p_location,min_temp_c=p_min_temp_c,
      max_temp_c=p_max_temp_c,active=coalesce(p_active,active),updated_by=p_actor_id,updated_by_label=p_actor_label,
      metadata=metadata || jsonb_build_object('range_status',case when p_min_temp_c is null and p_max_temp_c is null then 'manager_configuration_required' else 'configured' end)
  where id=p_point_id;
  if not found then raise exception 'Temperature point not found'; end if;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('temperature_point_updated','temperature_point',p_point_id,p_actor_id,p_actor_label,
    jsonb_build_object('min_temp_c',p_min_temp_c,'max_temp_c',p_max_temp_c,'active',p_active));
  return atlas_private.operations_today(local_date);
end;
$$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 81
create or replace function public.atlas_operations_today(p_local_date date)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.operations_today(p_local_date); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 82
create or replace function public.atlas_operations_set_item(
  p_instance_id uuid,p_template_item_id uuid,p_completed boolean,p_note text,p_evidence jsonb,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.set_routine_item(p_instance_id,p_template_item_id,p_completed,p_note,p_evidence,p_actor_id,p_actor_label); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 83
create or replace function public.atlas_operations_complete_routine(
  p_instance_id uuid,p_notes text,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.complete_routine(p_instance_id,p_notes,p_actor_id,p_actor_label); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 84
create or replace function public.atlas_operations_skip_routine(
  p_instance_id uuid,p_reason text,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.skip_routine(p_instance_id,p_reason,p_actor_id,p_actor_label); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 85
create or replace function public.atlas_operations_log_temperature(
  p_point_id uuid,p_temperature_c numeric,p_note text,p_corrective_action text,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.log_temperature(p_point_id,p_temperature_c,p_note,p_corrective_action,p_actor_id,p_actor_label); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 86
create or replace function public.atlas_operations_update_template(
  p_template_id uuid,p_name text,p_description text,p_days_of_week smallint[],p_available_from time,p_due_time time,
  p_assigned_role text,p_active boolean,p_requires_manager_signoff boolean,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.update_routine_template(p_template_id,p_name,p_description,p_days_of_week,p_available_from,p_due_time,p_assigned_role,p_active,p_requires_manager_signoff,p_actor_id,p_actor_label); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 87
create or replace function public.atlas_operations_update_temperature_point(
  p_point_id uuid,p_name text,p_location text,p_min_temp_c numeric,p_max_temp_c numeric,p_active boolean,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.update_temperature_point(p_point_id,p_name,p_location,p_min_temp_c,p_max_temp_c,p_active,p_actor_id,p_actor_label); $$;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 88
revoke execute on function public.atlas_operations_today(date) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 89
revoke execute on function public.atlas_operations_set_item(uuid,uuid,boolean,text,jsonb,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 90
revoke execute on function public.atlas_operations_complete_routine(uuid,text,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 91
revoke execute on function public.atlas_operations_skip_routine(uuid,text,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 92
revoke execute on function public.atlas_operations_log_temperature(uuid,numeric,text,text,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 93
revoke execute on function public.atlas_operations_update_template(uuid,text,text,smallint[],time,time,text,boolean,boolean,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 94
revoke execute on function public.atlas_operations_update_temperature_point(uuid,text,text,numeric,numeric,boolean,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 95
grant execute on function public.atlas_operations_today(date) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 96
grant execute on function public.atlas_operations_set_item(uuid,uuid,boolean,text,jsonb,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 97
grant execute on function public.atlas_operations_complete_routine(uuid,text,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 98
grant execute on function public.atlas_operations_skip_routine(uuid,text,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 99
grant execute on function public.atlas_operations_log_temperature(uuid,numeric,text,text,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 100
grant execute on function public.atlas_operations_update_template(uuid,text,text,smallint[],time,time,text,boolean,boolean,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 101
grant execute on function public.atlas_operations_update_temperature_point(uuid,text,text,numeric,numeric,boolean,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 102
comment on table atlas_private.routine_templates is 'Editable recurring weekly and daily VÁ operational routines.';

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 103
comment on table atlas_private.temperature_logs is 'Audited manual or sensor temperature readings. Target ranges remain manager-configurable.';

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 104
comment on table atlas_private.integration_connections is 'Connection readiness and capability boundaries only. Credentials are never stored in this table.';

-- SOURCE supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql statement 105
comment on function public.atlas_operations_today(date) is 'Service-role-only Checkpoint A snapshot for active Atlas staff.';

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 0
-- Checkpoint A manager settings snapshot.
-- Service-role-only and contains no credentials.

create or replace function atlas_private.operations_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
select jsonb_build_object(
  'version','atlas-operations-settings/0.1.0',
  'templates',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',template.id,
      'template_key',template.template_key,
      'name',template.name,
      'description',template.description,
      'routine_type',template.routine_type,
      'recurrence',template.recurrence,
      'days_of_week',template.days_of_week,
      'available_from',template.available_from,
      'due_time',template.due_time,
      'assigned_role',template.assigned_role,
      'requires_manager_signoff',template.requires_manager_signoff,
      'allow_photo_evidence',template.allow_photo_evidence,
      'active',template.active,
      'display_order',template.display_order,
      'item_count',(select count(*) from atlas_private.routine_template_items item where item.template_id=template.id and item.active=true),
      'metadata',template.metadata
    ) order by template.display_order,template.name)
    from atlas_private.routine_templates template
  ),'[]'::jsonb),
  'temperature_points',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',point.id,
      'point_key',point.point_key,
      'name',point.name,
      'location',point.location,
      'equipment_type',point.equipment_type,
      'min_temp_c',point.min_temp_c,
      'max_temp_c',point.max_temp_c,
      'active',point.active,
      'display_order',point.display_order,
      'metadata',point.metadata
    ) order by point.display_order,point.name)
    from atlas_private.temperature_points point
  ),'[]'::jsonb),
  'connections',coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider_key',connection.provider_key,
      'label',connection.label,
      'category',connection.category,
      'status',connection.status,
      'capabilities',connection.capabilities,
      'requirements',connection.requirements,
      'external_account_id',connection.external_account_id,
      'external_account_label',connection.external_account_label,
      'last_verified_at',connection.last_verified_at,
      'metadata',connection.metadata
    ) order by connection.category,connection.label)
    from atlas_private.integration_connections connection
  ),'[]'::jsonb)
);
$$;

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 1
create or replace function public.atlas_operations_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$ select atlas_private.operations_settings(); $$;

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 2
revoke execute on function atlas_private.operations_settings() from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 3
revoke execute on function public.atlas_operations_settings() from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 4
grant execute on function atlas_private.operations_settings() to service_role;

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 5
grant execute on function public.atlas_operations_settings() to service_role;

-- SOURCE supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql statement 6
comment on function public.atlas_operations_settings() is
  'Service-role-only manager settings snapshot for recurring routines, temperature points and integration boundaries.';

-- SOURCE supabase/migrations/20260803021451_atlas_operations_routine_status_fix.sql statement 0
-- Checkpoint A status correction.
-- Returning the last required checklist item to unchecked must return the
-- routine to scheduled/overdue instead of leaving a misleading 0/N in-progress state.

create or replace function atlas_private.set_routine_item(
  p_instance_id uuid,
  p_template_item_id uuid,
  p_completed boolean,
  p_note text,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_item_row atlas_private.routine_template_items;
  template_row atlas_private.routine_templates;
  completed_required_count bigint;
  local_now timestamp := pg_catalog.now() at time zone 'Atlantic/Reykjavik';
begin
  select * into instance_row
  from atlas_private.routine_instances
  where id=p_instance_id
  for update;
  if not found then raise exception 'Routine instance not found'; end if;
  if instance_row.status in ('completed','skipped') then
    raise exception 'Completed or skipped routines cannot be edited';
  end if;

  select * into template_item_row
  from atlas_private.routine_template_items
  where id=p_template_item_id
    and template_id=instance_row.template_id
    and active=true;
  if not found then raise exception 'Routine checklist item not found'; end if;

  select * into template_row
  from atlas_private.routine_templates
  where id=instance_row.template_id;

  insert into atlas_private.routine_item_results (
    instance_id,template_item_id,completed,note,evidence,
    completed_at,completed_by,completed_by_label
  ) values (
    p_instance_id,p_template_item_id,p_completed,
    nullif(trim(coalesce(p_note,'')),''),coalesce(p_evidence,'{}'::jsonb),
    case when p_completed then pg_catalog.now() else null end,
    case when p_completed then p_actor_id else null end,
    case when p_completed then p_actor_label else null end
  )
  on conflict (instance_id,template_item_id) do update set
    completed=excluded.completed,
    note=excluded.note,
    evidence=excluded.evidence,
    completed_at=excluded.completed_at,
    completed_by=excluded.completed_by,
    completed_by_label=excluded.completed_by_label,
    updated_at=pg_catalog.now();

  select count(*) into completed_required_count
  from atlas_private.routine_template_items item
  join atlas_private.routine_item_results result
    on result.template_item_id=item.id
   and result.instance_id=p_instance_id
   and result.completed=true
  where item.template_id=instance_row.template_id
    and item.active=true
    and item.required=true;

  update atlas_private.routine_instances
  set status=case
        when completed_required_count > 0 then 'in_progress'
        when scheduled_date=local_now::date
          and template_row.due_time is not null
          and local_now::time > template_row.due_time then 'overdue'
        else 'scheduled'
      end,
      started_at=case
        when completed_required_count > 0 then coalesce(started_at,pg_catalog.now())
        else null
      end,
      started_by=case
        when completed_required_count > 0 then coalesce(started_by,p_actor_id)
        else null
      end,
      started_by_label=case
        when completed_required_count > 0 then coalesce(started_by_label,p_actor_label)
        else null
      end
  where id=p_instance_id;

  insert into atlas_private.operations_events (
    event_type,entity_type,entity_id,actor_id,actor_label,payload
  ) values (
    'routine_item_updated','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object(
      'template_item_id',p_template_item_id,
      'completed',p_completed,
      'completed_required_count',completed_required_count,
      'note',p_note
    )
  );

  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

-- SOURCE supabase/migrations/20260803021451_atlas_operations_routine_status_fix.sql statement 1
update atlas_private.routine_instances instance
set status=case
      when instance.scheduled_date=(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date
        and template.due_time is not null
        and (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::time > template.due_time
      then 'overdue'
      else 'scheduled'
    end,
    started_at=null,
    started_by=null,
    started_by_label=null
from atlas_private.routine_templates template
where instance.template_id=template.id
  and instance.status='in_progress'
  and not exists (
    select 1
    from atlas_private.routine_item_results result
    join atlas_private.routine_template_items item on item.id=result.template_item_id
    where result.instance_id=instance.id
      and result.completed=true
      and item.active=true
      and item.required=true
  );

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 0
-- Checkpoint B - Phone bottle scanner.
-- Barcode aliases and scanner audit events remain private. Preview count submissions
-- default to shadow mode so the isolated branch cannot silently change live inventory.

create table if not exists atlas_private.inventory_scanner_settings (
  setting_key text primary key,
  live_apply_enabled boolean not null default false,
  allow_staff_linking boolean not null default false,
  allowed_formats text[] not null default array['ean_13','ean_8','upc_a','upc_e','code_128','code_39']::text[],
  max_observed_quantity numeric not null default 100000 check (max_observed_quantity > 0),
  zxing_version text not null default '0.2.1',
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 1
create table if not exists atlas_private.inventory_scan_aliases (
  id uuid primary key default gen_random_uuid(),
  normalized_code text not null unique,
  raw_code text not null,
  symbology text not null default 'unknown',
  external_item_id uuid not null,
  external_item_name text not null,
  external_item_category text,
  external_item_unit text,
  active boolean not null default true,
  verified boolean not null default true,
  linked_by uuid,
  linked_by_label text,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  scan_count bigint not null default 0 check (scan_count >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(normalized_code) between 3 and 128),
  check (char_length(raw_code) between 1 and 256)
);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 2
create table if not exists atlas_private.inventory_scan_events (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  event_type text not null check (event_type in ('code_linked','count_recorded','count_applied','count_no_change','count_failed','code_unlinked')),
  status text not null check (status in ('linked','shadow_recorded','pending_live','live_applied','no_change','failed','unlinked')),
  alias_id uuid references atlas_private.inventory_scan_aliases(id) on delete set null,
  normalized_code text not null,
  raw_code text not null,
  symbology text not null default 'unknown',
  external_item_id uuid not null,
  external_item_name text not null,
  external_item_category text,
  previous_quantity numeric,
  observed_quantity numeric,
  applied_quantity numeric,
  quantity_delta numeric,
  unit text,
  note text,
  source text not null default 'manual' check (source in ('camera_native','camera_zxing','image_native','image_zxing','manual')),
  actor_id uuid,
  actor_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  check (char_length(normalized_code) between 3 and 128),
  check (observed_quantity is null or observed_quantity >= 0),
  check (previous_quantity is null or previous_quantity >= 0),
  check (applied_quantity is null or applied_quantity >= 0)
);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 3
create index if not exists inventory_scan_aliases_item_idx
  on atlas_private.inventory_scan_aliases(external_item_id,active);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 4
create index if not exists inventory_scan_aliases_seen_idx
  on atlas_private.inventory_scan_aliases(last_seen_at desc nulls last);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 5
create index if not exists inventory_scan_events_created_idx
  on atlas_private.inventory_scan_events(created_at desc);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 6
create index if not exists inventory_scan_events_item_idx
  on atlas_private.inventory_scan_events(external_item_id,created_at desc);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 7
create index if not exists inventory_scan_events_code_idx
  on atlas_private.inventory_scan_events(normalized_code,created_at desc);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 8
alter table atlas_private.inventory_scanner_settings enable row level security;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 9
alter table atlas_private.inventory_scan_aliases enable row level security;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 10
alter table atlas_private.inventory_scan_events enable row level security;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 11
drop policy if exists "service role manages inventory scanner settings" on atlas_private.inventory_scanner_settings;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 12
create policy "service role manages inventory scanner settings"
  on atlas_private.inventory_scanner_settings for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 13
drop policy if exists "service role manages inventory scan aliases" on atlas_private.inventory_scan_aliases;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 14
create policy "service role manages inventory scan aliases"
  on atlas_private.inventory_scan_aliases for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 15
drop policy if exists "service role manages inventory scan events" on atlas_private.inventory_scan_events;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 16
create policy "service role manages inventory scan events"
  on atlas_private.inventory_scan_events for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 17
revoke all on atlas_private.inventory_scanner_settings from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 18
revoke all on atlas_private.inventory_scan_aliases from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 19
revoke all on atlas_private.inventory_scan_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 20
grant all on atlas_private.inventory_scanner_settings to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 21
grant all on atlas_private.inventory_scan_aliases to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 22
grant all on atlas_private.inventory_scan_events to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 23
drop trigger if exists inventory_scanner_settings_touch on atlas_private.inventory_scanner_settings;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 24
create trigger inventory_scanner_settings_touch
  before update on atlas_private.inventory_scanner_settings
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 25
drop trigger if exists inventory_scan_aliases_touch on atlas_private.inventory_scan_aliases;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 26
create trigger inventory_scan_aliases_touch
  before update on atlas_private.inventory_scan_aliases
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 27
insert into atlas_private.inventory_scanner_settings (
  setting_key,live_apply_enabled,allow_staff_linking,allowed_formats,max_observed_quantity,zxing_version,metadata
) values (
  'va',false,false,array['ean_13','ean_8','upc_a','upc_e','code_128','code_39']::text[],100000,'0.2.1',
  '{"preview_safety":"Live inventory mutation remains disabled until browser acceptance and production release approval.","label_recognition":"future_checkpoint","camera_requires_secure_context":true}'::jsonb
)
on conflict (setting_key) do update set
  allowed_formats=excluded.allowed_formats,
  max_observed_quantity=excluded.max_observed_quantity,
  zxing_version=excluded.zxing_version,
  metadata=excluded.metadata,
  updated_at=now();

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 28
create or replace function atlas_private.normalize_scan_code(p_code text)
returns text
language sql
immutable
security invoker
set search_path=''
as $$
  select case
    when nullif(pg_catalog.btrim(p_code),'') is null then null
    when pg_catalog.btrim(p_code) ~ '^[0-9[:space:]-]+$'
      then pg_catalog.regexp_replace(pg_catalog.btrim(p_code),'[^0-9]','','g')
    else pg_catalog.upper(pg_catalog.regexp_replace(pg_catalog.btrim(p_code),'[[:space:]]+','','g'))
  end;
$$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 29
create or replace function atlas_private.inventory_scanner_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'version','atlas-inventory-scanner/0.1.0',
    'settings',jsonb_build_object(
      'live_apply_enabled',settings.live_apply_enabled,
      'allow_staff_linking',settings.allow_staff_linking,
      'allowed_formats',settings.allowed_formats,
      'max_observed_quantity',settings.max_observed_quantity,
      'zxing_version',settings.zxing_version,
      'metadata',settings.metadata
    ),
    'summary',jsonb_build_object(
      'active_aliases',(select count(*) from atlas_private.inventory_scan_aliases where active=true),
      'count_events',(select count(*) from atlas_private.inventory_scan_events where event_type in ('count_recorded','count_applied','count_no_change')),
      'last_scan_at',(select max(created_at) from atlas_private.inventory_scan_events)
    ),
    'recent_events',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',event.id,
        'event_type',event.event_type,
        'status',event.status,
        'code',event.raw_code,
        'symbology',event.symbology,
        'item_id',event.external_item_id,
        'item_name',event.external_item_name,
        'previous_quantity',event.previous_quantity,
        'observed_quantity',event.observed_quantity,
        'applied_quantity',event.applied_quantity,
        'unit',event.unit,
        'actor_label',event.actor_label,
        'created_at',event.created_at
      ) order by event.created_at desc)
      from (
        select * from atlas_private.inventory_scan_events
        order by created_at desc
        limit 20
      ) event
    ),'[]'::jsonb),
    'trust',jsonb_build_object(
      'private_branch',true,
      'direct_browser_table_access',false,
      'live_inventory_mutation_enabled',settings.live_apply_enabled,
      'uncertain_image_match_auto_apply',false,
      'audit_events_preserved',true
    )
  )
  from atlas_private.inventory_scanner_settings settings
  where settings.setting_key='va';
$$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 30
create or replace function atlas_private.inventory_scanner_lookup(p_code text)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  with normalized as (
    select atlas_private.normalize_scan_code(p_code) as code
  ), matched as (
    select alias.*
    from atlas_private.inventory_scan_aliases alias, normalized
    where alias.normalized_code=normalized.code and alias.active=true
    limit 1
  )
  select jsonb_build_object(
    'normalized_code',(select code from normalized),
    'matched',exists(select 1 from matched),
    'alias',case when exists(select 1 from matched) then (
      select jsonb_build_object(
        'id',id,
        'normalized_code',normalized_code,
        'raw_code',raw_code,
        'symbology',symbology,
        'item_id',external_item_id,
        'item_name',external_item_name,
        'item_category',external_item_category,
        'item_unit',external_item_unit,
        'verified',verified,
        'linked_by_label',linked_by_label,
        'linked_at',linked_at,
        'last_seen_at',last_seen_at,
        'scan_count',scan_count
      ) from matched
    ) else null end
  );
$$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 31
create or replace function atlas_private.inventory_scanner_link_code(
  p_raw_code text,
  p_symbology text,
  p_item_id uuid,
  p_item_name text,
  p_item_category text,
  p_item_unit text,
  p_actor_id uuid,
  p_actor_label text,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  normalized text := atlas_private.normalize_scan_code(p_raw_code);
  alias_row atlas_private.inventory_scan_aliases;
  existing_item uuid;
begin
  if normalized is null or char_length(normalized) < 3 or char_length(normalized) > 128 then
    raise exception 'Barcode or SKU must contain between 3 and 128 characters';
  end if;
  if p_item_id is null or nullif(trim(coalesce(p_item_name,'')),'') is null then
    raise exception 'A valid inventory item is required';
  end if;

  select external_item_id into existing_item
  from atlas_private.inventory_scan_aliases
  where normalized_code=normalized and active=true;
  if existing_item is not null and existing_item<>p_item_id then
    raise exception 'This code is already linked to another inventory item';
  end if;

  insert into atlas_private.inventory_scan_aliases (
    normalized_code,raw_code,symbology,external_item_id,external_item_name,
    external_item_category,external_item_unit,active,verified,linked_by,linked_by_label,last_seen_at
  ) values (
    normalized,p_raw_code,coalesce(nullif(trim(p_symbology),''),'unknown'),p_item_id,p_item_name,
    p_item_category,p_item_unit,true,true,p_actor_id,p_actor_label,now()
  )
  on conflict (normalized_code) do update set
    raw_code=excluded.raw_code,
    symbology=excluded.symbology,
    external_item_id=excluded.external_item_id,
    external_item_name=excluded.external_item_name,
    external_item_category=excluded.external_item_category,
    external_item_unit=excluded.external_item_unit,
    active=true,
    verified=true,
    linked_by=excluded.linked_by,
    linked_by_label=excluded.linked_by_label,
    linked_at=now(),
    last_seen_at=now()
  returning * into alias_row;

  if p_client_request_id is null or not exists (
    select 1 from atlas_private.inventory_scan_events where client_request_id=p_client_request_id
  ) then
    insert into atlas_private.inventory_scan_events (
      client_request_id,event_type,status,alias_id,normalized_code,raw_code,symbology,
      external_item_id,external_item_name,external_item_category,unit,source,actor_id,actor_label,metadata
    ) values (
      p_client_request_id,'code_linked','linked',alias_row.id,normalized,p_raw_code,alias_row.symbology,
      p_item_id,p_item_name,p_item_category,p_item_unit,'manual',p_actor_id,p_actor_label,
      jsonb_build_object('verified',true)
    );
  end if;

  return atlas_private.inventory_scanner_lookup(p_raw_code);
end;
$$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 32
create or replace function atlas_private.inventory_scanner_record_count(
  p_client_request_id uuid,
  p_raw_code text,
  p_symbology text,
  p_item_id uuid,
  p_item_name text,
  p_item_category text,
  p_previous_quantity numeric,
  p_observed_quantity numeric,
  p_applied_quantity numeric,
  p_unit text,
  p_note text,
  p_source text,
  p_status text,
  p_actor_id uuid,
  p_actor_label text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  normalized text := atlas_private.normalize_scan_code(p_raw_code);
  alias_row atlas_private.inventory_scan_aliases;
  event_row atlas_private.inventory_scan_events;
  max_quantity numeric;
  derived_event_type text;
begin
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;

  select * into event_row
  from atlas_private.inventory_scan_events
  where client_request_id=p_client_request_id;
  if found then
    return jsonb_build_object('duplicate',true,'event',to_jsonb(event_row));
  end if;

  select max_observed_quantity into max_quantity
  from atlas_private.inventory_scanner_settings where setting_key='va';
  if p_observed_quantity is null or p_observed_quantity<0 or p_observed_quantity>coalesce(max_quantity,100000) then
    raise exception 'Observed quantity is outside the accepted range';
  end if;
  if p_previous_quantity is not null and p_previous_quantity<0 then
    raise exception 'Previous quantity cannot be negative';
  end if;
  if p_status not in ('shadow_recorded','pending_live','live_applied','no_change','failed') then
    raise exception 'Invalid scanner count status';
  end if;
  if p_source not in ('camera_native','camera_zxing','image_native','image_zxing','manual') then
    raise exception 'Invalid scanner source';
  end if;

  select * into alias_row
  from atlas_private.inventory_scan_aliases
  where normalized_code=normalized and active=true;
  if found and alias_row.external_item_id<>p_item_id then
    raise exception 'Scanned code is linked to a different inventory item';
  end if;

  derived_event_type := case
    when p_status='live_applied' then 'count_applied'
    when p_status='no_change' then 'count_no_change'
    when p_status='failed' then 'count_failed'
    else 'count_recorded'
  end;

  insert into atlas_private.inventory_scan_events (
    client_request_id,event_type,status,alias_id,normalized_code,raw_code,symbology,
    external_item_id,external_item_name,external_item_category,previous_quantity,
    observed_quantity,applied_quantity,quantity_delta,unit,note,source,actor_id,actor_label,metadata,finalized_at
  ) values (
    p_client_request_id,derived_event_type,p_status,alias_row.id,normalized,p_raw_code,
    coalesce(nullif(trim(p_symbology),''),'unknown'),p_item_id,p_item_name,p_item_category,
    p_previous_quantity,p_observed_quantity,p_applied_quantity,
    case when p_previous_quantity is null then null else p_observed_quantity-p_previous_quantity end,
    p_unit,nullif(trim(coalesce(p_note,'')),''),p_source,p_actor_id,p_actor_label,
    coalesce(p_metadata,'{}'::jsonb),
    case when p_status in ('live_applied','no_change','failed','shadow_recorded') then now() else null end
  ) returning * into event_row;

  if alias_row.id is not null then
    update atlas_private.inventory_scan_aliases
    set last_seen_at=now(),scan_count=scan_count+1
    where id=alias_row.id;
  end if;

  return jsonb_build_object('duplicate',false,'event',to_jsonb(event_row));
end;
$$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 33
create or replace function atlas_private.inventory_scanner_finalize_count(
  p_event_id uuid,
  p_status text,
  p_applied_quantity numeric,
  p_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare event_row atlas_private.inventory_scan_events;
begin
  if p_status not in ('live_applied','no_change','failed') then
    raise exception 'Invalid final scanner status';
  end if;
  update atlas_private.inventory_scan_events
  set status=p_status,
      event_type=case when p_status='live_applied' then 'count_applied' when p_status='no_change' then 'count_no_change' else 'count_failed' end,
      applied_quantity=p_applied_quantity,
      metadata=metadata || coalesce(p_metadata,'{}'::jsonb),
      finalized_at=now()
  where id=p_event_id and status='pending_live'
  returning * into event_row;
  if not found then
    select * into event_row from atlas_private.inventory_scan_events where id=p_event_id;
  end if;
  if event_row.id is null then raise exception 'Scanner count event not found'; end if;
  return to_jsonb(event_row);
end;
$$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 34
create or replace function public.atlas_inventory_scanner_snapshot()
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_snapshot(); $$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 35
create or replace function public.atlas_inventory_scanner_lookup(p_code text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_lookup(p_code); $$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 36
create or replace function public.atlas_inventory_scanner_link_code(
  p_raw_code text,p_symbology text,p_item_id uuid,p_item_name text,p_item_category text,p_item_unit text,
  p_actor_id uuid,p_actor_label text,p_client_request_id uuid
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_link_code(p_raw_code,p_symbology,p_item_id,p_item_name,p_item_category,p_item_unit,p_actor_id,p_actor_label,p_client_request_id); $$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 37
create or replace function public.atlas_inventory_scanner_record_count(
  p_client_request_id uuid,p_raw_code text,p_symbology text,p_item_id uuid,p_item_name text,p_item_category text,
  p_previous_quantity numeric,p_observed_quantity numeric,p_applied_quantity numeric,p_unit text,p_note text,p_source text,
  p_status text,p_actor_id uuid,p_actor_label text,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_record_count(p_client_request_id,p_raw_code,p_symbology,p_item_id,p_item_name,p_item_category,p_previous_quantity,p_observed_quantity,p_applied_quantity,p_unit,p_note,p_source,p_status,p_actor_id,p_actor_label,p_metadata); $$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 38
create or replace function public.atlas_inventory_scanner_finalize_count(
  p_event_id uuid,p_status text,p_applied_quantity numeric,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_finalize_count(p_event_id,p_status,p_applied_quantity,p_metadata); $$;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 39
revoke execute on function public.atlas_inventory_scanner_snapshot() from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 40
revoke execute on function public.atlas_inventory_scanner_lookup(text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 41
revoke execute on function public.atlas_inventory_scanner_link_code(text,text,uuid,text,text,text,uuid,text,uuid) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 42
revoke execute on function public.atlas_inventory_scanner_record_count(uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,text,text,text,uuid,text,jsonb) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 43
revoke execute on function public.atlas_inventory_scanner_finalize_count(uuid,text,numeric,jsonb) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 44
grant execute on function public.atlas_inventory_scanner_snapshot() to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 45
grant execute on function public.atlas_inventory_scanner_lookup(text) to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 46
grant execute on function public.atlas_inventory_scanner_link_code(text,text,uuid,text,text,text,uuid,text,uuid) to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 47
grant execute on function public.atlas_inventory_scanner_record_count(uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,text,text,text,uuid,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 48
grant execute on function public.atlas_inventory_scanner_finalize_count(uuid,text,numeric,jsonb) to service_role;

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 49
comment on table atlas_private.inventory_scan_aliases is 'Private barcode/SKU aliases linked to production inventory item IDs; no direct browser access.';

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 50
comment on table atlas_private.inventory_scan_events is 'Audited scanner links and count observations. Preview defaults to shadow recording rather than live inventory mutation.';

-- SOURCE supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql statement 51
comment on function public.atlas_inventory_scanner_snapshot() is 'Service-role-only scanner configuration and audit summary.';

-- SOURCE supabase/migrations/20260803102130_atlas_inventory_scanner_indexes.sql statement 0
-- Cover the scanner event -> barcode alias foreign key used by audit/history queries.
create index if not exists inventory_scan_events_alias_idx
  on atlas_private.inventory_scan_events(alias_id)
  where alias_id is not null;

-- SOURCE supabase/migrations/20260803102333_atlas_inventory_scanner_alias_index_fix.sql statement 0
-- Supabase's foreign-key linter requires a complete covering index.
drop index if exists atlas_private.inventory_scan_events_alias_idx;

-- SOURCE supabase/migrations/20260803102333_atlas_inventory_scanner_alias_index_fix.sql statement 1
create index inventory_scan_events_alias_idx
  on atlas_private.inventory_scan_events(alias_id);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 0
-- Checkpoint C - private VÁ team messages.
-- Active profile authorization is enforced by the Edge Function on every request.
-- Browser roles have no direct access to these tables or RPCs.

create table if not exists atlas_private.team_channels (
  id uuid primary key default gen_random_uuid(),
  channel_key text not null unique,
  name text not null,
  description text,
  icon text not null default 'message-circle',
  tone text not null default 'neutral'
    check (tone in ('neutral','operations','handover','announcement','marketing')),
  manager_post_only boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(channel_key) between 2 and 64),
  check (char_length(name) between 1 and 80)
);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 1
create table if not exists atlas_private.team_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references atlas_private.team_channels(id) on delete cascade,
  client_request_id uuid unique,
  system_event_key text unique,
  message_type text not null default 'user'
    check (message_type in ('user','system')),
  sender_id uuid,
  sender_label text not null,
  sender_role text not null,
  body text not null,
  link_type text not null default 'none'
    check (link_type in ('none','inventory_item','routine','shift','brain_recommendation')),
  link_key text,
  link_label text,
  link_route text,
  link_metadata jsonb not null default '{}'::jsonb,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_label text,
  delete_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(body) <= 4000),
  check (
    (link_type='none' and link_key is null and link_label is null)
    or
    (link_type<>'none' and link_key is not null and link_label is not null)
  ),
  check (
    (message_type='system' and client_request_id is null)
    or
    (message_type='user' and client_request_id is not null and sender_id is not null)
  )
);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 2
create table if not exists atlas_private.team_message_revisions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references atlas_private.team_messages(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  previous_body text not null,
  new_body text,
  change_type text not null check (change_type in ('edit','delete')),
  changed_by uuid,
  changed_by_label text not null,
  changed_by_role text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (message_id,revision_number)
);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 3
create table if not exists atlas_private.team_channel_reads (
  channel_id uuid not null references atlas_private.team_channels(id) on delete cascade,
  user_id uuid not null,
  user_label text not null,
  user_role text not null,
  last_read_at timestamptz not null default now(),
  last_read_message_id uuid references atlas_private.team_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (channel_id,user_id)
);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 4
create table if not exists atlas_private.team_message_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('message_sent','message_edited','message_deleted','system_message_sent')),
  message_id uuid references atlas_private.team_messages(id) on delete set null,
  channel_id uuid references atlas_private.team_channels(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 5
create index if not exists team_channels_active_order_idx
  on atlas_private.team_channels(active,sort_order);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 6
create index if not exists team_messages_channel_created_idx
  on atlas_private.team_messages(channel_id,created_at desc);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 7
create index if not exists team_messages_sender_created_idx
  on atlas_private.team_messages(sender_id,created_at desc)
  where sender_id is not null;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 8
create index if not exists team_messages_visible_idx
  on atlas_private.team_messages(channel_id,created_at desc)
  where deleted_at is null;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 9
create index if not exists team_message_revisions_message_idx
  on atlas_private.team_message_revisions(message_id,revision_number desc);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 10
create index if not exists team_channel_reads_user_idx
  on atlas_private.team_channel_reads(user_id,updated_at desc);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 11
create index if not exists team_channel_reads_last_message_idx
  on atlas_private.team_channel_reads(last_read_message_id)
  where last_read_message_id is not null;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 12
create index if not exists team_message_events_message_idx
  on atlas_private.team_message_events(message_id,created_at desc)
  where message_id is not null;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 13
create index if not exists team_message_events_channel_idx
  on atlas_private.team_message_events(channel_id,created_at desc)
  where channel_id is not null;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 14
alter table atlas_private.team_channels enable row level security;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 15
alter table atlas_private.team_messages enable row level security;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 16
alter table atlas_private.team_message_revisions enable row level security;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 17
alter table atlas_private.team_channel_reads enable row level security;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 18
alter table atlas_private.team_message_events enable row level security;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 19
drop policy if exists "service role manages team channels" on atlas_private.team_channels;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 20
create policy "service role manages team channels"
  on atlas_private.team_channels for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 21
drop policy if exists "service role manages team messages" on atlas_private.team_messages;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 22
create policy "service role manages team messages"
  on atlas_private.team_messages for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 23
drop policy if exists "service role manages message revisions" on atlas_private.team_message_revisions;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 24
create policy "service role manages message revisions"
  on atlas_private.team_message_revisions for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 25
drop policy if exists "service role manages channel reads" on atlas_private.team_channel_reads;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 26
create policy "service role manages channel reads"
  on atlas_private.team_channel_reads for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 27
drop policy if exists "service role manages message events" on atlas_private.team_message_events;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 28
create policy "service role manages message events"
  on atlas_private.team_message_events for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 29
revoke all on atlas_private.team_channels from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 30
revoke all on atlas_private.team_messages from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 31
revoke all on atlas_private.team_message_revisions from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 32
revoke all on atlas_private.team_channel_reads from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 33
revoke all on atlas_private.team_message_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 34
grant all on atlas_private.team_channels to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 35
grant all on atlas_private.team_messages to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 36
grant all on atlas_private.team_message_revisions to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 37
grant all on atlas_private.team_channel_reads to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 38
grant all on atlas_private.team_message_events to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 39
drop trigger if exists team_channels_touch on atlas_private.team_channels;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 40
create trigger team_channels_touch before update on atlas_private.team_channels
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 41
drop trigger if exists team_messages_touch on atlas_private.team_messages;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 42
create trigger team_messages_touch before update on atlas_private.team_messages
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 43
drop trigger if exists team_channel_reads_touch on atlas_private.team_channel_reads;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 44
create trigger team_channel_reads_touch before update on atlas_private.team_channel_reads
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 45
insert into atlas_private.team_channels (
  channel_key,name,description,icon,tone,manager_post_only,active,sort_order
) values
  ('general','General','Everyday team communication and shared updates.','messages-square','neutral',false,true,10),
  ('operations','Operations','Cleaning, inventory, maintenance and service operations.','gauge','operations',false,true,20),
  ('shift-handover','Shift handover','What the next shift needs to know before taking over.','repeat-2','handover',false,true,30),
  ('announcements','Announcements','Official management notices for the whole active team.','megaphone','announcement',true,true,40),
  ('marketing','Marketing','Content ideas, campaigns, events and social-media coordination.','send','marketing',false,true,50)
on conflict (channel_key) do update set
  name=excluded.name,
  description=excluded.description,
  icon=excluded.icon,
  tone=excluded.tone,
  manager_post_only=excluded.manager_post_only,
  active=excluded.active,
  sort_order=excluded.sort_order,
  updated_at=now();

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 46
create or replace function atlas_private.team_messages_snapshot(
  p_user_id uuid,
  p_user_role text,
  p_active_user_ids uuid[],
  p_channel_key text,
  p_limit integer default 60
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  selected_channel atlas_private.team_channels;
  channels_json jsonb := '[]'::jsonb;
  messages_json jsonb := '[]'::jsonb;
  total_unread bigint := 0;
  safe_limit integer := greatest(1,least(coalesce(p_limit,60),100));
begin
  select * into selected_channel
  from atlas_private.team_channels
  where active=true and channel_key=coalesce(nullif(trim(p_channel_key),''),'general')
  limit 1;

  if not found then
    select * into selected_channel
    from atlas_private.team_channels
    where active=true
    order by sort_order,channel_key
    limit 1;
  end if;

  select coalesce(jsonb_agg(row_data.channel_json order by row_data.sort_order),'[]'::jsonb),
         coalesce(sum(row_data.unread_count),0)
  into channels_json,total_unread
  from (
    select
      channel.sort_order,
      (
        select count(*)
        from atlas_private.team_messages message
        where message.channel_id=channel.id
          and message.deleted_at is null
          and message.sender_id is distinct from p_user_id
          and message.created_at > coalesce(read_state.last_read_at,'epoch'::timestamptz)
      )::bigint as unread_count,
      jsonb_build_object(
        'id',channel.id,
        'key',channel.channel_key,
        'name',channel.name,
        'description',channel.description,
        'icon',channel.icon,
        'tone',channel.tone,
        'manager_post_only',channel.manager_post_only,
        'can_post',(not channel.manager_post_only or p_user_role in ('admin','manager')),
        'unread_count',(
          select count(*)
          from atlas_private.team_messages message
          where message.channel_id=channel.id
            and message.deleted_at is null
            and message.sender_id is distinct from p_user_id
            and message.created_at > coalesce(read_state.last_read_at,'epoch'::timestamptz)
        ),
        'last_read_at',read_state.last_read_at,
        'last_message',(
          select jsonb_build_object(
            'id',message.id,
            'sender_label',message.sender_label,
            'body',case when message.deleted_at is null then left(message.body,140) else 'Message deleted' end,
            'message_type',message.message_type,
            'created_at',message.created_at,
            'deleted',message.deleted_at is not null
          )
          from atlas_private.team_messages message
          where message.channel_id=channel.id
          order by message.created_at desc
          limit 1
        )
      ) as channel_json
    from atlas_private.team_channels channel
    left join atlas_private.team_channel_reads read_state
      on read_state.channel_id=channel.id and read_state.user_id=p_user_id
    where channel.active=true
  ) row_data;

  if selected_channel.id is not null then
    select coalesce(jsonb_agg(row_data.message_json order by row_data.created_at),'[]'::jsonb)
    into messages_json
    from (
      select
        message.created_at,
        jsonb_build_object(
          'id',message.id,
          'channel_id',message.channel_id,
          'message_type',message.message_type,
          'sender_id',message.sender_id,
          'sender_label',message.sender_label,
          'sender_role',message.sender_role,
          'body',case when message.deleted_at is null then message.body else null end,
          'deleted',message.deleted_at is not null,
          'delete_reason',case when p_user_role in ('admin','manager') then message.delete_reason else null end,
          'created_at',message.created_at,
          'edited_at',message.edited_at,
          'is_own',message.sender_id=p_user_id,
          'can_edit',(
            message.message_type='user'
            and message.deleted_at is null
            and message.sender_id=p_user_id
            and message.created_at >= pg_catalog.now()-interval '15 minutes'
          ),
          'can_delete',(
            message.deleted_at is null
            and (
              (message.sender_id=p_user_id and message.created_at >= pg_catalog.now()-interval '15 minutes')
              or p_user_role in ('admin','manager')
            )
          ),
          'link',case when message.link_type='none' then null else jsonb_build_object(
            'type',message.link_type,
            'key',message.link_key,
            'label',message.link_label,
            'route',message.link_route,
            'metadata',message.link_metadata
          ) end,
          'read_by',coalesce((
            select jsonb_agg(jsonb_build_object(
              'user_id',reader.user_id,
              'user_label',reader.user_label,
              'user_role',reader.user_role,
              'read_at',reader.last_read_at
            ) order by reader.last_read_at)
            from atlas_private.team_channel_reads reader
            where reader.channel_id=message.channel_id
              and reader.user_id is distinct from message.sender_id
              and reader.last_read_at >= message.created_at
              and (
                p_active_user_ids is null
                or cardinality(p_active_user_ids)=0
                or reader.user_id=any(p_active_user_ids)
              )
          ),'[]'::jsonb),
          'read_by_count',(
            select count(*)
            from atlas_private.team_channel_reads reader
            where reader.channel_id=message.channel_id
              and reader.user_id is distinct from message.sender_id
              and reader.last_read_at >= message.created_at
              and (
                p_active_user_ids is null
                or cardinality(p_active_user_ids)=0
                or reader.user_id=any(p_active_user_ids)
              )
          )
        ) as message_json
      from (
        select *
        from atlas_private.team_messages
        where channel_id=selected_channel.id
        order by created_at desc
        limit safe_limit
      ) message
    ) row_data;
  end if;

  return jsonb_build_object(
    'version','atlas-team-messages/0.1.0',
    'generated_at',pg_catalog.now(),
    'selected_channel_key',selected_channel.channel_key,
    'channels',channels_json,
    'messages',messages_json,
    'summary',jsonb_build_object(
      'total_unread',total_unread,
      'active_channels',jsonb_array_length(channels_json),
      'active_members',coalesce(cardinality(p_active_user_ids),0)
    ),
    'policy',jsonb_build_object(
      'delivery_mode','secure_polling',
      'poll_after_ms',6000,
      'inactive_profiles_denied_by_gateway',true,
      'announcement_posting','manager_or_admin',
      'author_edit_window_minutes',15,
      'soft_delete_with_audit',true,
      'direct_browser_table_access',false
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 47
create or replace function atlas_private.team_messages_send(
  p_channel_key text,
  p_body text,
  p_sender_id uuid,
  p_sender_label text,
  p_sender_role text,
  p_client_request_id uuid,
  p_link_type text,
  p_link_key text,
  p_link_label text,
  p_link_route text,
  p_link_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  existing_row atlas_private.team_messages;
  message_row atlas_private.team_messages;
  clean_body text := trim(coalesce(p_body,''));
  clean_link_type text := coalesce(nullif(trim(p_link_type),''),'none');
  recent_message_count bigint;
begin
  if p_sender_id is null or p_client_request_id is null then
    raise exception 'Sender and client request ID are required';
  end if;
  if p_sender_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Sender role is invalid';
  end if;
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'Message must contain between 1 and 4000 characters';
  end if;

  select * into existing_row
  from atlas_private.team_messages
  where client_request_id=p_client_request_id;
  if found then
    return jsonb_build_object('duplicate',true,'message_id',existing_row.id,'created_at',existing_row.created_at);
  end if;

  select count(*) into recent_message_count
  from atlas_private.team_messages
  where sender_id=p_sender_id and message_type='user'
    and created_at>pg_catalog.now()-interval '1 minute';
  if recent_message_count>=20 then
    raise exception 'Message rate limit reached. Wait a moment and try again';
  end if;

  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'Channel not found or inactive'; end if;
  if channel_row.manager_post_only and p_sender_role not in ('admin','manager') then
    raise exception 'Only managers can post in Announcements';
  end if;

  if clean_link_type not in ('none','inventory_item','routine','shift','brain_recommendation') then
    raise exception 'Message link type is invalid';
  end if;
  if clean_link_type='none' then
    p_link_key := null;
    p_link_label := null;
    p_link_route := null;
    p_link_metadata := '{}'::jsonb;
  elsif nullif(trim(coalesce(p_link_key,'')),'') is null
     or nullif(trim(coalesce(p_link_label,'')),'') is null then
    raise exception 'Linked messages require a verified target and label';
  end if;

  insert into atlas_private.team_messages (
    channel_id,client_request_id,message_type,sender_id,sender_label,sender_role,body,
    link_type,link_key,link_label,link_route,link_metadata
  ) values (
    channel_row.id,p_client_request_id,'user',p_sender_id,p_sender_label,p_sender_role,clean_body,
    clean_link_type,p_link_key,p_link_label,p_link_route,coalesce(p_link_metadata,'{}'::jsonb)
  ) returning * into message_row;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_sent',message_row.id,channel_row.id,p_sender_id,p_sender_label,p_sender_role,
    jsonb_build_object('channel_key',channel_row.channel_key,'link_type',clean_link_type)
  );

  return jsonb_build_object('duplicate',false,'message_id',message_row.id,'created_at',message_row.created_at);
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 48
create or replace function atlas_private.team_messages_edit(
  p_message_id uuid,
  p_body text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  message_row atlas_private.team_messages;
  revision_no integer;
  clean_body text := trim(coalesce(p_body,''));
begin
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'Message must contain between 1 and 4000 characters';
  end if;

  select * into message_row from atlas_private.team_messages where id=p_message_id for update;
  if not found then raise exception 'Message not found'; end if;
  if message_row.deleted_at is not null then raise exception 'Deleted messages cannot be edited'; end if;
  if message_row.message_type<>'user' then raise exception 'System messages cannot be edited'; end if;
  if message_row.sender_id<>p_actor_id then raise exception 'Only the original author can edit this message'; end if;
  if message_row.created_at < pg_catalog.now()-interval '15 minutes' then
    raise exception 'The 15-minute edit window has closed';
  end if;
  if message_row.body=clean_body then
    return jsonb_build_object('message_id',message_row.id,'unchanged',true);
  end if;

  select coalesce(max(revision_number),0)+1 into revision_no
  from atlas_private.team_message_revisions where message_id=message_row.id;

  insert into atlas_private.team_message_revisions (
    message_id,revision_number,previous_body,new_body,change_type,
    changed_by,changed_by_label,changed_by_role
  ) values (
    message_row.id,revision_no,message_row.body,clean_body,'edit',
    p_actor_id,p_actor_label,p_actor_role
  );

  update atlas_private.team_messages
  set body=clean_body,edited_at=pg_catalog.now()
  where id=message_row.id;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_edited',message_row.id,message_row.channel_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('revision_number',revision_no)
  );

  return jsonb_build_object('message_id',message_row.id,'edited',true,'revision_number',revision_no);
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 49
create or replace function atlas_private.team_messages_delete(
  p_message_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  message_row atlas_private.team_messages;
  revision_no integer;
  is_manager boolean := p_actor_role in ('admin','manager');
  clean_reason text := nullif(trim(coalesce(p_reason,'')),'');
begin
  select * into message_row from atlas_private.team_messages where id=p_message_id for update;
  if not found then raise exception 'Message not found'; end if;
  if message_row.deleted_at is not null then
    return jsonb_build_object('message_id',message_row.id,'already_deleted',true);
  end if;
  if message_row.message_type='system' and not is_manager then
    raise exception 'Only managers can remove a system message';
  end if;
  if message_row.sender_id is distinct from p_actor_id and not is_manager then
    raise exception 'Only the author or a manager can delete this message';
  end if;
  if message_row.sender_id=p_actor_id and not is_manager
     and message_row.created_at < pg_catalog.now()-interval '15 minutes' then
    raise exception 'The 15-minute delete window has closed';
  end if;
  if message_row.sender_id is distinct from p_actor_id and clean_reason is null then
    raise exception 'A manager reason is required when deleting another person''s message';
  end if;

  select coalesce(max(revision_number),0)+1 into revision_no
  from atlas_private.team_message_revisions where message_id=message_row.id;

  insert into atlas_private.team_message_revisions (
    message_id,revision_number,previous_body,new_body,change_type,
    changed_by,changed_by_label,changed_by_role,reason
  ) values (
    message_row.id,revision_no,message_row.body,null,'delete',
    p_actor_id,p_actor_label,p_actor_role,clean_reason
  );

  update atlas_private.team_messages
  set body='',deleted_at=pg_catalog.now(),deleted_by=p_actor_id,
      deleted_by_label=p_actor_label,delete_reason=clean_reason
  where id=message_row.id;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_deleted',message_row.id,message_row.channel_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('revision_number',revision_no,'reason',clean_reason,'author_deleted',message_row.sender_id=p_actor_id)
  );

  return jsonb_build_object('message_id',message_row.id,'deleted',true,'revision_number',revision_no);
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 50
create or replace function atlas_private.team_messages_mark_read(
  p_channel_key text,
  p_user_id uuid,
  p_user_label text,
  p_user_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  latest_message atlas_private.team_messages;
  read_time timestamptz := pg_catalog.now();
begin
  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'Channel not found or inactive'; end if;

  select * into latest_message
  from atlas_private.team_messages
  where channel_id=channel_row.id
  order by created_at desc
  limit 1;

  insert into atlas_private.team_channel_reads (
    channel_id,user_id,user_label,user_role,last_read_at,last_read_message_id
  ) values (
    channel_row.id,p_user_id,p_user_label,p_user_role,read_time,latest_message.id
  )
  on conflict (channel_id,user_id) do update set
    user_label=excluded.user_label,
    user_role=excluded.user_role,
    last_read_at=greatest(atlas_private.team_channel_reads.last_read_at,excluded.last_read_at),
    last_read_message_id=excluded.last_read_message_id,
    updated_at=pg_catalog.now();

  return jsonb_build_object(
    'channel_key',channel_row.channel_key,
    'last_read_at',read_time,
    'last_read_message_id',latest_message.id
  );
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 51
create or replace function atlas_private.team_messages_post_system(
  p_channel_key text,
  p_system_event_key text,
  p_body text,
  p_link_type text,
  p_link_key text,
  p_link_label text,
  p_link_route text,
  p_link_metadata jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  message_id uuid;
  clean_body text := trim(coalesce(p_body,''));
begin
  if nullif(trim(coalesce(p_system_event_key,'')),'') is null then
    raise exception 'System event key is required';
  end if;
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'System message must contain between 1 and 4000 characters';
  end if;

  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'System message channel not found'; end if;

  insert into atlas_private.team_messages (
    channel_id,system_event_key,message_type,sender_id,sender_label,sender_role,body,
    link_type,link_key,link_label,link_route,link_metadata
  ) values (
    channel_row.id,p_system_event_key,'system',null,'Atlas Operations','system',clean_body,
    p_link_type,p_link_key,p_link_label,p_link_route,coalesce(p_link_metadata,'{}'::jsonb)
  )
  on conflict (system_event_key) do nothing
  returning id into message_id;

  if message_id is null then
    select id into message_id
    from atlas_private.team_messages
    where system_event_key=p_system_event_key;
    return message_id;
  end if;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_label,actor_role,payload
  ) values (
    'system_message_sent',message_id,channel_row.id,'Atlas Operations','system',
    jsonb_build_object('system_event_key',p_system_event_key,'link_type',p_link_type)
  );

  return message_id;
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 52
-- A completed operational routine posts one idempotent, linked system update.
create or replace function atlas_private.complete_routine(
  p_instance_id uuid,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_row atlas_private.routine_templates;
  incomplete_count bigint;
  missing_temperatures bigint;
  required_count bigint := 0;
  completed_count bigint := 0;
  maintenance_count bigint := 0;
  system_body text;
begin
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  select * into template_row from atlas_private.routine_templates where id=instance_row.template_id;

  if template_row.routine_type='temperature' then
    select count(*) into missing_temperatures
    from atlas_private.temperature_points point
    where point.active=true and not exists (
      select 1 from atlas_private.temperature_logs log
      where log.point_id=point.id and log.reading_date=instance_row.scheduled_date
    );
    if missing_temperatures>0 then
      raise exception '% temperature points still need a reading',missing_temperatures;
    end if;
    select count(*) into required_count from atlas_private.temperature_points where active=true;
    completed_count := required_count;
  else
    select count(*) into incomplete_count
    from atlas_private.routine_template_items item
    where item.template_id=instance_row.template_id and item.active=true and item.required=true
      and not exists (
        select 1 from atlas_private.routine_item_results result
        where result.instance_id=instance_row.id
          and result.template_item_id=item.id
          and result.completed=true
      );
    if incomplete_count>0 then
      raise exception '% required checklist items are incomplete',incomplete_count;
    end if;

    select
      count(*) filter (where item.required and item.active),
      count(*) filter (where item.required and item.active and coalesce(result.completed,false)),
      count(*) filter (
        where item.evidence_type='maintenance'
          and nullif(trim(coalesce(result.note,'')),'') is not null
      )
    into required_count,completed_count,maintenance_count
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance_row.id
    where item.template_id=instance_row.template_id;
  end if;

  update atlas_private.routine_instances
  set status='completed',completed_at=pg_catalog.now(),completed_by=p_actor_id,
      completed_by_label=p_actor_label,completion_notes=nullif(trim(coalesce(p_notes,'')),'')
  where id=p_instance_id;

  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_completed','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object('notes',p_notes,'template_key',template_row.template_key));

  system_body := template_row.name || ' completed' || E'\n'
    || coalesce(nullif(trim(p_actor_label),''),'A team member') || ' completed '
    || completed_count || ' of ' || required_count || ' items.';
  if maintenance_count>0 then
    system_body := system_body || E'\n' || maintenance_count || ' maintenance item'
      || case when maintenance_count=1 then '' else 's' end || ' require manager review.';
  end if;

  begin
    perform atlas_private.team_messages_post_system(
      'operations',
      'routine-completed:'||p_instance_id::text,
      system_body,
      'routine',
      p_instance_id::text,
      template_row.name,
      'operations',
      jsonb_build_object(
        'scheduled_date',instance_row.scheduled_date,
        'completed_count',completed_count,
        'required_count',required_count,
        'maintenance_count',maintenance_count,
        'completed_by',p_actor_label
      )
    );
  exception when others then
    insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
    values ('team_message_failed','routine_instance',p_instance_id,p_actor_id,p_actor_label,
      jsonb_build_object('error',sqlerrm,'template_key',template_row.template_key));
  end;

  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 53
create or replace function public.atlas_team_messages_snapshot(
  p_user_id uuid,p_user_role text,p_active_user_ids uuid[],p_channel_key text,p_limit integer
)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.team_messages_snapshot(p_user_id,p_user_role,p_active_user_ids,p_channel_key,p_limit); $$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 54
create or replace function public.atlas_team_messages_send(
  p_channel_key text,p_body text,p_sender_id uuid,p_sender_label text,p_sender_role text,
  p_client_request_id uuid,p_link_type text,p_link_key text,p_link_label text,p_link_route text,p_link_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_send(p_channel_key,p_body,p_sender_id,p_sender_label,p_sender_role,p_client_request_id,p_link_type,p_link_key,p_link_label,p_link_route,p_link_metadata); $$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 55
create or replace function public.atlas_team_messages_edit(
  p_message_id uuid,p_body text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_edit(p_message_id,p_body,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 56
create or replace function public.atlas_team_messages_delete(
  p_message_id uuid,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_delete(p_message_id,p_reason,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 57
create or replace function public.atlas_team_messages_mark_read(
  p_channel_key text,p_user_id uuid,p_user_label text,p_user_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_mark_read(p_channel_key,p_user_id,p_user_label,p_user_role); $$;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 58
revoke execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 59
revoke execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 60
revoke execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 61
revoke execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 62
revoke execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 63
grant execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 64
grant execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 65
grant execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 66
grant execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 67
grant execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 68
comment on table atlas_private.team_channels is
  'Private VÁ staff channels. Announcement posting is manager-only.';

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 69
comment on table atlas_private.team_messages is
  'Private staff messages with soft deletion, verified links and immutable audit history.';

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 70
comment on table atlas_private.team_channel_reads is
  'Per-user channel read cursor used for unread counts and message read status.';

-- SOURCE supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql statement 71
comment on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) is
  'Service-role-only messaging snapshot; active-profile authorization is enforced by the gateway.';

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 0
-- Checkpoint C defense-in-depth hardening.
-- The authoritative authorization decision remains the active production profile
-- verified by the Edge Function on every request. These statements keep the
-- private branch inaccessible to browser roles even if Data API exposure changes.

alter table atlas_private.team_channels enable row level security;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 1
alter table atlas_private.team_messages enable row level security;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 2
alter table atlas_private.team_message_revisions enable row level security;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 3
alter table atlas_private.team_channel_reads enable row level security;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 4
alter table atlas_private.team_message_events enable row level security;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 5
revoke all on atlas_private.team_channels from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 6
revoke all on atlas_private.team_messages from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 7
revoke all on atlas_private.team_message_revisions from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 8
revoke all on atlas_private.team_channel_reads from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 9
revoke all on atlas_private.team_message_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 10
grant all on atlas_private.team_channels to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 11
grant all on atlas_private.team_messages to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 12
grant all on atlas_private.team_message_revisions to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 13
grant all on atlas_private.team_channel_reads to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 14
grant all on atlas_private.team_message_events to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 15
create index if not exists team_messages_channel_created_idx
  on atlas_private.team_messages(channel_id,created_at desc);

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 16
create index if not exists team_messages_sender_created_idx
  on atlas_private.team_messages(sender_id,created_at desc)
  where sender_id is not null;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 17
create index if not exists team_message_revisions_message_idx
  on atlas_private.team_message_revisions(message_id,revision_number desc);

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 18
create index if not exists team_channel_reads_last_message_idx
  on atlas_private.team_channel_reads(last_read_message_id)
  where last_read_message_id is not null;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 19
create index if not exists team_message_events_message_idx
  on atlas_private.team_message_events(message_id,created_at desc)
  where message_id is not null;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 20
create index if not exists team_message_events_channel_idx
  on atlas_private.team_message_events(channel_id,created_at desc)
  where channel_id is not null;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 21
revoke execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 22
revoke execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 23
revoke execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 24
revoke execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 25
revoke execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 26
grant execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 27
grant execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 28
grant execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 29
grant execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803125530_atlas_team_messages_hardening.sql statement 30
grant execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803132222_atlas_team_messages_idempotency.sql statement 0
-- Checkpoint C idempotency and lightweight abuse protection.
-- Repeated system events must not create duplicate messages or audit events.
-- User messages keep client-request idempotency and a conservative rate limit.

create or replace function atlas_private.team_messages_post_system(
  p_channel_key text,
  p_system_event_key text,
  p_body text,
  p_link_type text,
  p_link_key text,
  p_link_label text,
  p_link_route text,
  p_link_metadata jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  message_id uuid;
  clean_body text := trim(coalesce(p_body,''));
begin
  if nullif(trim(coalesce(p_system_event_key,'')),'') is null then
    raise exception 'System event key is required';
  end if;
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'System message must contain between 1 and 4000 characters';
  end if;

  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'System message channel not found'; end if;

  insert into atlas_private.team_messages (
    channel_id,system_event_key,message_type,sender_id,sender_label,sender_role,body,
    link_type,link_key,link_label,link_route,link_metadata
  ) values (
    channel_row.id,p_system_event_key,'system',null,'Atlas Operations','system',clean_body,
    p_link_type,p_link_key,p_link_label,p_link_route,coalesce(p_link_metadata,'{}'::jsonb)
  )
  on conflict (system_event_key) do nothing
  returning id into message_id;

  if message_id is null then
    select id into message_id
    from atlas_private.team_messages
    where system_event_key=p_system_event_key;
    return message_id;
  end if;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_label,actor_role,payload
  ) values (
    'system_message_sent',message_id,channel_row.id,'Atlas Operations','system',
    jsonb_build_object('system_event_key',p_system_event_key,'link_type',p_link_type)
  );

  return message_id;
end;
$$;

-- SOURCE supabase/migrations/20260803132222_atlas_team_messages_idempotency.sql statement 1
create or replace function atlas_private.team_messages_send(
  p_channel_key text,
  p_body text,
  p_sender_id uuid,
  p_sender_label text,
  p_sender_role text,
  p_client_request_id uuid,
  p_link_type text,
  p_link_key text,
  p_link_label text,
  p_link_route text,
  p_link_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  existing_row atlas_private.team_messages;
  message_row atlas_private.team_messages;
  clean_body text := trim(coalesce(p_body,''));
  clean_link_type text := coalesce(nullif(trim(p_link_type),''),'none');
  recent_message_count bigint;
begin
  if p_sender_id is null or p_client_request_id is null then
    raise exception 'Sender and client request ID are required';
  end if;
  if p_sender_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Sender role is invalid';
  end if;
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'Message must contain between 1 and 4000 characters';
  end if;

  select * into existing_row
  from atlas_private.team_messages
  where client_request_id=p_client_request_id;
  if found then
    return jsonb_build_object('duplicate',true,'message_id',existing_row.id,'created_at',existing_row.created_at);
  end if;

  select count(*) into recent_message_count
  from atlas_private.team_messages
  where sender_id=p_sender_id
    and message_type='user'
    and created_at>pg_catalog.now()-interval '1 minute';
  if recent_message_count>=20 then
    raise exception 'Message rate limit reached. Wait a moment and try again';
  end if;

  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'Channel not found or inactive'; end if;
  if channel_row.manager_post_only and p_sender_role not in ('admin','manager') then
    raise exception 'Only managers can post in Announcements';
  end if;

  if clean_link_type not in ('none','inventory_item','routine','shift','brain_recommendation') then
    raise exception 'Message link type is invalid';
  end if;
  if clean_link_type='none' then
    p_link_key := null;
    p_link_label := null;
    p_link_route := null;
    p_link_metadata := '{}'::jsonb;
  elsif nullif(trim(coalesce(p_link_key,'')),'') is null
     or nullif(trim(coalesce(p_link_label,'')),'') is null then
    raise exception 'Linked messages require a verified target and label';
  end if;

  insert into atlas_private.team_messages (
    channel_id,client_request_id,message_type,sender_id,sender_label,sender_role,body,
    link_type,link_key,link_label,link_route,link_metadata
  ) values (
    channel_row.id,p_client_request_id,'user',p_sender_id,p_sender_label,p_sender_role,clean_body,
    clean_link_type,p_link_key,p_link_label,p_link_route,coalesce(p_link_metadata,'{}'::jsonb)
  ) returning * into message_row;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_sent',message_row.id,channel_row.id,p_sender_id,p_sender_label,p_sender_role,
    jsonb_build_object('channel_key',channel_row.channel_key,'link_type',clean_link_type)
  );

  return jsonb_build_object('duplicate',false,'message_id',message_row.id,'created_at',message_row.created_at);
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 0
create table if not exists atlas_private.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  campaign_type text not null default 'always_on'
    check (campaign_type in ('promotion','event','seasonal','always_on','brand','other')),
  status text not null default 'draft'
    check (status in ('draft','active','paused','completed','cancelled')),
  objective text,
  target_audience text,
  platforms text[] not null default '{}'::text[],
  start_date date,
  end_date date,
  created_by uuid,
  created_by_label text,
  created_by_role text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 1
create table if not exists atlas_private.marketing_content_items (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  campaign_id uuid references atlas_private.marketing_campaigns(id) on delete set null,
  title text not null,
  content_type text not null
    check (content_type in ('post','story','reel','campaign_task','event_promotion','content_idea','google_post')),
  status text not null default 'idea'
    check (status in ('idea','draft','pending_approval','changes_requested','approved','scheduled','published','completed','rejected','cancelled')),
  priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  platforms text[] not null default '{}'::text[],
  scheduled_for timestamptz,
  reminder_at timestamptz,
  event_starts_at timestamptz,
  event_ends_at timestamptz,
  suggested_format text,
  caption_draft text,
  creative_brief text,
  frames jsonb not null default '[]'::jsonb,
  media_requirements jsonb not null default '{}'::jsonb,
  owner_id uuid,
  owner_label text,
  created_by uuid,
  created_by_label text,
  created_by_role text,
  published_at timestamptz,
  completed_at timestamptz,
  external_publication_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(title) between 1 and 180),
  check (caption_draft is null or char_length(caption_draft) <= 10000),
  check (creative_brief is null or char_length(creative_brief) <= 10000),
  check (event_ends_at is null or event_starts_at is null or event_ends_at >= event_starts_at),
  check (jsonb_typeof(frames)='array'),
  check (jsonb_typeof(media_requirements)='object'),
  check (jsonb_typeof(external_publication_ids)='object'),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 2
create table if not exists atlas_private.marketing_content_revisions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  change_type text not null
    check (change_type in ('create','edit','status','approval','publication','completion','cancellation')),
  previous_payload jsonb,
  new_payload jsonb,
  changed_by uuid,
  changed_by_label text not null,
  changed_by_role text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (content_id,revision_number)
);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 3
create table if not exists atlas_private.marketing_content_approvals (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete cascade,
  decision text not null
    check (decision in ('submitted','approved','changes_requested','rejected','cancelled')),
  actor_id uuid,
  actor_label text not null,
  actor_role text not null,
  note text,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 4
create table if not exists atlas_private.marketing_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_key text not null unique,
  title text not null,
  summary text not null,
  content_type text not null
    check (content_type in ('post','story','reel','campaign_task','event_promotion','content_idea','google_post')),
  platforms text[] not null default '{}'::text[],
  recurrence text not null default 'one_off'
    check (recurrence in ('one_off','daily','weekly')),
  day_of_week smallint,
  active_from date,
  active_to date,
  suggested_time time,
  suggested_format text,
  caption_draft text,
  creative_brief text,
  frames jsonb not null default '[]'::jsonb,
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,
  confidence_score numeric not null default 0.5
    check (confidence_score between 0 and 1),
  status text not null default 'active'
    check (status in ('active','converted','dismissed','expired')),
  converted_content_id uuid references atlas_private.marketing_content_items(id) on delete set null,
  converted_at timestamptz,
  converted_by uuid,
  converted_by_label text,
  dismissed_at timestamptz,
  dismissed_by uuid,
  dismissed_by_label text,
  dismiss_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (day_of_week is null or day_of_week between 0 and 6),
  check (active_to is null or active_from is null or active_to >= active_from),
  check (jsonb_typeof(frames)='array'),
  check (jsonb_typeof(evidence)='array'),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 5
create table if not exists atlas_private.marketing_workspace_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('campaign_created','content_created','content_updated','approval_submitted','approval_decided','content_published','content_completed','content_cancelled','recommendation_converted','recommendation_dismissed','connection_state_changed')),
  campaign_id uuid references atlas_private.marketing_campaigns(id) on delete set null,
  content_id uuid references atlas_private.marketing_content_items(id) on delete set null,
  recommendation_id uuid references atlas_private.marketing_recommendations(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 6
alter table atlas_private.integration_connections
  add column if not exists authorization_state text not null default 'not_connected',
  add column if not exists publishing_permission_state text not null default 'not_requested',
  add column if not exists analytics_permission_state text not null default 'not_requested',
  add column if not exists token_expires_at timestamptz,
  add column if not exists last_connection_error text;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 7
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='integration_connections_authorization_state_check'
      and conrelid='atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_authorization_state_check
      check (authorization_state in ('not_connected','waiting_authorization','authorized','expired'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='integration_connections_publishing_permission_state_check'
      and conrelid='atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_publishing_permission_state_check
      check (publishing_permission_state in ('not_requested','pending','granted','missing','not_supported'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='integration_connections_analytics_permission_state_check'
      and conrelid='atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_analytics_permission_state_check
      check (analytics_permission_state in ('not_requested','pending','granted','missing','not_supported'));
  end if;
end $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 8
create index if not exists marketing_campaigns_status_dates_idx
  on atlas_private.marketing_campaigns(status,start_date,end_date);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 9
create index if not exists marketing_content_calendar_idx
  on atlas_private.marketing_content_items(scheduled_for,status);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 10
create index if not exists marketing_content_reminder_idx
  on atlas_private.marketing_content_items(reminder_at,status)
  where reminder_at is not null;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 11
create index if not exists marketing_content_campaign_idx
  on atlas_private.marketing_content_items(campaign_id,status)
  where campaign_id is not null;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 12
create index if not exists marketing_content_owner_idx
  on atlas_private.marketing_content_items(owner_id,status)
  where owner_id is not null;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 13
create index if not exists marketing_revisions_content_idx
  on atlas_private.marketing_content_revisions(content_id,revision_number desc);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 14
create index if not exists marketing_approvals_content_idx
  on atlas_private.marketing_content_approvals(content_id,created_at desc);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 15
create index if not exists marketing_recommendations_due_idx
  on atlas_private.marketing_recommendations(status,recurrence,day_of_week,active_from,active_to);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 16
create index if not exists marketing_events_created_idx
  on atlas_private.marketing_workspace_events(created_at desc);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 17
create index if not exists marketing_events_content_idx
  on atlas_private.marketing_workspace_events(content_id,created_at desc)
  where content_id is not null;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 18
alter table atlas_private.marketing_campaigns enable row level security;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 19
alter table atlas_private.marketing_content_items enable row level security;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 20
alter table atlas_private.marketing_content_revisions enable row level security;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 21
alter table atlas_private.marketing_content_approvals enable row level security;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 22
alter table atlas_private.marketing_recommendations enable row level security;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 23
alter table atlas_private.marketing_workspace_events enable row level security;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 24
drop policy if exists "service role manages marketing campaigns" on atlas_private.marketing_campaigns;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 25
create policy "service role manages marketing campaigns"
  on atlas_private.marketing_campaigns for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 26
drop policy if exists "service role manages marketing content" on atlas_private.marketing_content_items;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 27
create policy "service role manages marketing content"
  on atlas_private.marketing_content_items for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 28
drop policy if exists "service role manages marketing revisions" on atlas_private.marketing_content_revisions;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 29
create policy "service role manages marketing revisions"
  on atlas_private.marketing_content_revisions for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 30
drop policy if exists "service role manages marketing approvals" on atlas_private.marketing_content_approvals;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 31
create policy "service role manages marketing approvals"
  on atlas_private.marketing_content_approvals for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 32
drop policy if exists "service role manages marketing recommendations" on atlas_private.marketing_recommendations;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 33
create policy "service role manages marketing recommendations"
  on atlas_private.marketing_recommendations for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 34
drop policy if exists "service role manages marketing events" on atlas_private.marketing_workspace_events;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 35
create policy "service role manages marketing events"
  on atlas_private.marketing_workspace_events for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 36
revoke all on atlas_private.marketing_campaigns from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 37
revoke all on atlas_private.marketing_content_items from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 38
revoke all on atlas_private.marketing_content_revisions from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 39
revoke all on atlas_private.marketing_content_approvals from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 40
revoke all on atlas_private.marketing_recommendations from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 41
revoke all on atlas_private.marketing_workspace_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 42
grant all on atlas_private.marketing_campaigns to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 43
grant all on atlas_private.marketing_content_items to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 44
grant all on atlas_private.marketing_content_revisions to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 45
grant all on atlas_private.marketing_content_approvals to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 46
grant all on atlas_private.marketing_recommendations to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 47
grant all on atlas_private.marketing_workspace_events to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 48
drop trigger if exists marketing_campaigns_touch on atlas_private.marketing_campaigns;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 49
create trigger marketing_campaigns_touch before update on atlas_private.marketing_campaigns
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 50
drop trigger if exists marketing_content_items_touch on atlas_private.marketing_content_items;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 51
create trigger marketing_content_items_touch before update on atlas_private.marketing_content_items
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 52
drop trigger if exists marketing_recommendations_touch on atlas_private.marketing_recommendations;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 53
create trigger marketing_recommendations_touch before update on atlas_private.marketing_recommendations
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 54
update atlas_private.integration_connections
set authorization_state=case
      when status='connected' then 'authorized'
      when status='expired' then 'expired'
      when status in ('authorization_required','pending_review') then 'waiting_authorization'
      else 'not_connected'
    end,
    publishing_permission_state=case
      when status='connected' then 'granted'
      when provider_key='tripadvisor' then 'not_supported'
      else 'not_requested'
    end,
    analytics_permission_state=case
      when status='connected' then 'granted'
      when provider_key='tripadvisor' then 'not_supported'
      else 'not_requested'
    end,
    metadata=metadata || jsonb_build_object(
      'marketing_checkpoint','D',
      'tokens_stored_server_side_only',true,
      'automatic_publishing_enabled',false,
      'automatic_analytics_enabled',false
    ),
    updated_at=now();

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 55
update atlas_private.integration_connections
set requirements=requirements || case provider_key
      when 'instagram' then jsonb_build_object(
        'professional_account',true,
        'meta_app_review',true,
        'publishing_permission_required',true,
        'insights_permission_required',true
      )
      when 'facebook' then jsonb_build_object(
        'facebook_page',true,
        'meta_app_review',true,
        'page_publishing_permission_required',true,
        'page_insights_permission_required',true
      )
      when 'tiktok' then jsonb_build_object(
        'content_posting_api',true,
        'developer_app_review',true,
        'url_property_verification',true,
        'publishing_scopes',jsonb_build_array('video.publish','video.upload'),
        'analytics_scope','video.list'
      )
      when 'google-business-profile' then jsonb_build_object(
        'business_profile_api_access',true,
        'google_cloud_project',true,
        'oauth_scope','https://www.googleapis.com/auth/business.manage',
        'location_access',true
      )
      else '{}'::jsonb
    end,
    updated_at=now()
where provider_key in ('instagram','facebook','tiktok','google-business-profile');

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 57
create or replace function atlas_private.marketing_connection_display_status(
  p_authorization_state text,
  p_publishing_state text,
  p_analytics_state text,
  p_token_expires_at timestamptz
)
returns text
language sql
stable
security invoker
set search_path=''
as $$
  select case
    when p_authorization_state='expired'
      or (p_token_expires_at is not null and p_token_expires_at<=pg_catalog.now())
      then 'connection_expired'
    when p_authorization_state='not_connected' then 'not_connected'
    when p_authorization_state='waiting_authorization' then 'waiting_for_authorization'
    when p_publishing_state='missing' then 'missing_publishing_permission'
    when p_analytics_state='missing' then 'missing_analytics_permission'
    when p_authorization_state='authorized'
      and p_publishing_state in ('granted','not_supported')
      and p_analytics_state in ('granted','not_supported','not_requested')
      then 'connected'
    else 'waiting_for_authorization'
  end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 58
create or replace function atlas_private.marketing_record_revision(
  p_content_id uuid,
  p_change_type text,
  p_previous_payload jsonb,
  p_new_payload jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_note text
)
returns integer
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare revision_no integer;
begin
  select coalesce(max(revision_number),0)+1 into revision_no
  from atlas_private.marketing_content_revisions
  where content_id=p_content_id;

  insert into atlas_private.marketing_content_revisions (
    content_id,revision_number,change_type,previous_payload,new_payload,
    changed_by,changed_by_label,changed_by_role,note
  ) values (
    p_content_id,revision_no,p_change_type,p_previous_payload,p_new_payload,
    p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),'')
  );
  return revision_no;
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 59
create or replace function atlas_private.marketing_workspace_snapshot(
  p_user_id uuid,
  p_user_role text,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
  start_date date := coalesce(p_start_date,date_trunc('month',local_date)::date);
  end_date date := coalesce(p_end_date,(date_trunc('month',local_date)+interval '1 month - 1 day')::date);
  content_json jsonb := '[]'::jsonb;
  recommendations_json jsonb := '[]'::jsonb;
  campaigns_json jsonb := '[]'::jsonb;
  connections_json jsonb := '[]'::jsonb;
  history_json jsonb := '[]'::jsonb;
  reminders_json jsonb := '[]'::jsonb;
  stats_json jsonb := '{}'::jsonb;
begin
  if start_date>end_date or end_date-start_date>92 then
    raise exception 'Marketing calendar range must be between 1 and 93 days';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',campaign.id,
    'name',campaign.name,
    'description',campaign.description,
    'campaign_type',campaign.campaign_type,
    'status',campaign.status,
    'objective',campaign.objective,
    'target_audience',campaign.target_audience,
    'platforms',campaign.platforms,
    'start_date',campaign.start_date,
    'end_date',campaign.end_date,
    'created_by_label',campaign.created_by_label,
    'created_at',campaign.created_at,
    'updated_at',campaign.updated_at
  ) order by campaign.start_date nulls last,campaign.name),'[]'::jsonb)
  into campaigns_json
  from atlas_private.marketing_campaigns campaign
  where campaign.status<>'cancelled';

  select coalesce(jsonb_agg(row_data.item order by row_data.sort_time,row_data.title),'[]'::jsonb)
  into content_json
  from (
    select
      coalesce(content.scheduled_for,content.reminder_at,content.created_at) as sort_time,
      content.title,
      jsonb_build_object(
        'id',content.id,
        'campaign_id',content.campaign_id,
        'campaign_name',campaign.name,
        'title',content.title,
        'content_type',content.content_type,
        'status',content.status,
        'priority',content.priority,
        'platforms',content.platforms,
        'scheduled_for',content.scheduled_for,
        'reminder_at',content.reminder_at,
        'event_starts_at',content.event_starts_at,
        'event_ends_at',content.event_ends_at,
        'suggested_format',content.suggested_format,
        'caption_draft',content.caption_draft,
        'creative_brief',content.creative_brief,
        'frames',content.frames,
        'media_requirements',content.media_requirements,
        'owner_id',content.owner_id,
        'owner_label',content.owner_label,
        'created_by',content.created_by,
        'created_by_label',content.created_by_label,
        'created_by_role',content.created_by_role,
        'published_at',content.published_at,
        'completed_at',content.completed_at,
        'external_publication_ids',content.external_publication_ids,
        'metadata',content.metadata,
        'created_at',content.created_at,
        'updated_at',content.updated_at,
        'can_edit',(
          content.status not in ('published','completed','cancelled')
          and (p_user_role in ('admin','manager') or content.created_by=p_user_id or content.owner_id=p_user_id)
        ),
        'can_approve',(p_user_role in ('admin','manager') and content.status='pending_approval'),
        'approval_history',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',approval.id,
            'decision',approval.decision,
            'actor_label',approval.actor_label,
            'actor_role',approval.actor_role,
            'note',approval.note,
            'created_at',approval.created_at
          ) order by approval.created_at)
          from atlas_private.marketing_content_approvals approval
          where approval.content_id=content.id
        ),'[]'::jsonb)
      ) as item
    from atlas_private.marketing_content_items content
    left join atlas_private.marketing_campaigns campaign on campaign.id=content.campaign_id
    where (
      content.scheduled_for::date between start_date and end_date
      or content.reminder_at::date between start_date and end_date
      or content.event_starts_at::date between start_date and end_date
      or (content.scheduled_for is null and content.status in ('idea','draft','pending_approval','changes_requested','approved'))
    )
  ) row_data;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',recommendation.id,
    'recommendation_key',recommendation.recommendation_key,
    'title',recommendation.title,
    'summary',recommendation.summary,
    'content_type',recommendation.content_type,
    'platforms',recommendation.platforms,
    'recurrence',recommendation.recurrence,
    'day_of_week',recommendation.day_of_week,
    'suggested_time',recommendation.suggested_time,
    'suggested_format',recommendation.suggested_format,
    'caption_draft',recommendation.caption_draft,
    'creative_brief',recommendation.creative_brief,
    'frames',recommendation.frames,
    'reason',recommendation.reason,
    'evidence',recommendation.evidence,
    'confidence_score',recommendation.confidence_score,
    'status',recommendation.status,
    'is_due_today',case
      when recommendation.recurrence='daily' then true
      when recommendation.recurrence='weekly' then recommendation.day_of_week=extract(dow from local_date)::smallint
      when recommendation.recurrence='one_off' then recommendation.active_from=local_date
      else false
    end,
    'metadata',recommendation.metadata
  ) order by
    case
      when recommendation.recurrence='daily' then 0
      when recommendation.recurrence='weekly' and recommendation.day_of_week=extract(dow from local_date)::smallint then 0
      else 1
    end,
    recommendation.suggested_time nulls last,
    recommendation.title),'[]'::jsonb)
  into recommendations_json
  from atlas_private.marketing_recommendations recommendation
  where recommendation.status='active'
    and (recommendation.active_from is null or recommendation.active_from<=local_date)
    and (recommendation.active_to is null or recommendation.active_to>=local_date);

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',connection.provider_key,
    'label',connection.label,
    'category',connection.category,
    'display_status',atlas_private.marketing_connection_display_status(
      connection.authorization_state,
      connection.publishing_permission_state,
      connection.analytics_permission_state,
      connection.token_expires_at
    ),
    'authorization_state',connection.authorization_state,
    'publishing_permission_state',connection.publishing_permission_state,
    'analytics_permission_state',connection.analytics_permission_state,
    'external_account_label',connection.external_account_label,
    'last_verified_at',connection.last_verified_at,
    'token_expires_at',connection.token_expires_at,
    'last_connection_error',connection.last_connection_error,
    'capabilities',connection.capabilities,
    'requirements',connection.requirements,
    'metadata',connection.metadata
  ) order by connection.label),'[]'::jsonb)
  into connections_json
  from atlas_private.integration_connections connection
  where connection.provider_key in ('instagram','facebook','tiktok','google-business-profile');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',content.id,
    'title',content.title,
    'content_type',content.content_type,
    'status',content.status,
    'reminder_at',content.reminder_at,
    'scheduled_for',content.scheduled_for,
    'platforms',content.platforms,
    'priority',content.priority
  ) order by content.reminder_at nulls last,content.scheduled_for nulls last),'[]'::jsonb)
  into reminders_json
  from atlas_private.marketing_content_items content
  where content.status not in ('published','completed','rejected','cancelled')
    and content.reminder_at is not null
    and content.reminder_at <= pg_catalog.now()+interval '14 days';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',event.id,
    'event_type',event.event_type,
    'campaign_id',event.campaign_id,
    'content_id',event.content_id,
    'recommendation_id',event.recommendation_id,
    'actor_label',event.actor_label,
    'actor_role',event.actor_role,
    'payload',event.payload,
    'created_at',event.created_at
  ) order by event.created_at desc),'[]'::jsonb)
  into history_json
  from (
    select * from atlas_private.marketing_workspace_events
    order by created_at desc
    limit 40
  ) event;

  select jsonb_build_object(
    'total_items',count(*)::bigint,
    'ideas',count(*) filter (where status='idea')::bigint,
    'drafts',count(*) filter (where status in ('draft','changes_requested'))::bigint,
    'awaiting_approval',count(*) filter (where status='pending_approval')::bigint,
    'approved',count(*) filter (where status in ('approved','scheduled'))::bigint,
    'published',count(*) filter (where status='published')::bigint,
    'completed',count(*) filter (where status='completed')::bigint,
    'overdue_reminders',count(*) filter (
      where reminder_at is not null
        and reminder_at<pg_catalog.now()
        and status not in ('published','completed','rejected','cancelled')
    )::bigint
  ) into stats_json
  from atlas_private.marketing_content_items;

  return jsonb_build_object(
    'version','atlas-marketing-workspace/0.1.0',
    'generated_at',pg_catalog.now(),
    'venue_date',local_date,
    'range',jsonb_build_object('start_date',start_date,'end_date',end_date),
    'stats',stats_json,
    'campaigns',campaigns_json,
    'content_items',content_json,
    'recommendations',recommendations_json,
    'reminders',reminders_json,
    'connections',connections_json,
    'history',history_json,
    'permissions',jsonb_build_object(
      'can_create',p_user_role in ('admin','manager','bartender'),
      'can_approve',p_user_role in ('admin','manager'),
      'can_mark_published',p_user_role in ('admin','manager'),
      'can_manage_connections',p_user_role in ('admin','manager')
    ),
    'trust',jsonb_build_object(
      'actual_publishing_enabled',false,
      'analytics_ingestion_enabled',false,
      'oauth_tokens_in_browser',false,
      'recommendations_shadow_only',true,
      'manager_approval_required',true,
      'history_preserved',true
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 60
create or replace function atlas_private.marketing_create_campaign(
  p_name text,
  p_description text,
  p_campaign_type text,
  p_objective text,
  p_target_audience text,
  p_platforms text[],
  p_start_date date,
  p_end_date date,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare campaign_row atlas_private.marketing_campaigns;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can create campaigns'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Campaign name is required'; end if;
  if p_campaign_type not in ('promotion','event','seasonal','always_on','brand','other') then raise exception 'Campaign type is invalid'; end if;
  if p_end_date is not null and p_start_date is not null and p_end_date<p_start_date then raise exception 'Campaign end date cannot precede its start date'; end if;

  insert into atlas_private.marketing_campaigns (
    name,description,campaign_type,status,objective,target_audience,platforms,
    start_date,end_date,created_by,created_by_label,created_by_role,updated_by,updated_by_label
  ) values (
    trim(p_name),nullif(trim(coalesce(p_description,'')),''),p_campaign_type,'draft',
    nullif(trim(coalesce(p_objective,'')),''),nullif(trim(coalesce(p_target_audience,'')),''),coalesce(p_platforms,'{}'::text[]),
    p_start_date,p_end_date,p_actor_id,p_actor_label,p_actor_role,p_actor_id,p_actor_label
  ) returning * into campaign_row;

  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,actor_id,actor_label,actor_role,payload
  ) values (
    'campaign_created',campaign_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('name',campaign_row.name,'campaign_type',campaign_row.campaign_type)
  );
  return to_jsonb(campaign_row);
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 61
create or replace function atlas_private.marketing_create_content(
  p_client_request_id uuid,
  p_campaign_id uuid,
  p_title text,
  p_content_type text,
  p_priority text,
  p_platforms text[],
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,
  p_suggested_format text,
  p_caption_draft text,
  p_creative_brief text,
  p_frames jsonb,
  p_media_requirements jsonb,
  p_owner_id uuid,
  p_owner_label text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  content_row atlas_private.marketing_content_items;
  initial_status text;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot create marketing content'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;
  select * into content_row from atlas_private.marketing_content_items where client_request_id=p_client_request_id;
  if found then return jsonb_build_object('duplicate',true,'content',to_jsonb(content_row)); end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Content title is required'; end if;
  if p_content_type not in ('post','story','reel','campaign_task','event_promotion','content_idea','google_post') then raise exception 'Content type is invalid'; end if;
  if p_priority not in ('low','normal','high','urgent') then raise exception 'Priority is invalid'; end if;
  if p_event_ends_at is not null and p_event_starts_at is not null and p_event_ends_at<p_event_starts_at then raise exception 'Event end cannot precede event start'; end if;

  initial_status := case when p_content_type='content_idea' then 'idea' else 'draft' end;
  insert into atlas_private.marketing_content_items (
    client_request_id,campaign_id,title,content_type,status,priority,platforms,
    scheduled_for,reminder_at,event_starts_at,event_ends_at,suggested_format,
    caption_draft,creative_brief,frames,media_requirements,owner_id,owner_label,
    created_by,created_by_label,created_by_role,metadata
  ) values (
    p_client_request_id,p_campaign_id,trim(p_title),p_content_type,initial_status,p_priority,coalesce(p_platforms,'{}'::text[]),
    p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,nullif(trim(coalesce(p_suggested_format,'')),''),
    nullif(trim(coalesce(p_caption_draft,'')),''),nullif(trim(coalesce(p_creative_brief,'')),''),
    coalesce(p_frames,'[]'::jsonb),coalesce(p_media_requirements,'{}'::jsonb),p_owner_id,p_owner_label,
    p_actor_id,p_actor_label,p_actor_role,coalesce(p_metadata,'{}'::jsonb)
  ) returning * into content_row;

  perform atlas_private.marketing_record_revision(
    content_row.id,'create',null,to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,'Initial content draft'
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_created',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('title',content_row.title,'content_type',content_row.content_type,'status',content_row.status)
  );
  return jsonb_build_object('duplicate',false,'content',to_jsonb(content_row));
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 62
create or replace function atlas_private.marketing_update_content(
  p_content_id uuid,
  p_campaign_id uuid,
  p_title text,
  p_priority text,
  p_platforms text[],
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,
  p_suggested_format text,
  p_caption_draft text,
  p_creative_brief text,
  p_frames jsonb,
  p_media_requirements jsonb,
  p_owner_id uuid,
  p_owner_label text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_note text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot edit marketing content'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status in ('published','completed','cancelled') then raise exception 'Published, completed or cancelled content cannot be edited'; end if;
  if p_actor_role not in ('admin','manager') and previous_row.created_by is distinct from p_actor_id and previous_row.owner_id is distinct from p_actor_id then
    raise exception 'Only the owner, creator or a manager can edit this content';
  end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Content title is required'; end if;
  if p_priority not in ('low','normal','high','urgent') then raise exception 'Priority is invalid'; end if;
  if p_event_ends_at is not null and p_event_starts_at is not null and p_event_ends_at<p_event_starts_at then raise exception 'Event end cannot precede event start'; end if;

  update atlas_private.marketing_content_items
  set campaign_id=p_campaign_id,
      title=trim(p_title),
      priority=p_priority,
      platforms=coalesce(p_platforms,'{}'::text[]),
      scheduled_for=p_scheduled_for,
      reminder_at=p_reminder_at,
      event_starts_at=p_event_starts_at,
      event_ends_at=p_event_ends_at,
      suggested_format=nullif(trim(coalesce(p_suggested_format,'')),''),
      caption_draft=nullif(trim(coalesce(p_caption_draft,'')),''),
      creative_brief=nullif(trim(coalesce(p_creative_brief,'')),''),
      frames=coalesce(p_frames,'[]'::jsonb),
      media_requirements=coalesce(p_media_requirements,'{}'::jsonb),
      owner_id=p_owner_id,
      owner_label=p_owner_label,
      status=case when status='changes_requested' then 'draft' else status end
  where id=p_content_id
  returning * into content_row;

  perform atlas_private.marketing_record_revision(
    content_row.id,'edit',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_updated',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('title',content_row.title,'status',content_row.status,'note',p_note)
  );
  return to_jsonb(content_row);
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 63
create or replace function atlas_private.marketing_submit_approval(
  p_content_id uuid,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  approval_row atlas_private.marketing_content_approvals;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot submit marketing content'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status not in ('idea','draft','changes_requested','approved') then raise exception 'This content cannot be submitted from its current state'; end if;
  if p_actor_role not in ('admin','manager') and previous_row.created_by is distinct from p_actor_id and previous_row.owner_id is distinct from p_actor_id then
    raise exception 'Only the owner, creator or a manager can submit this content';
  end if;

  update atlas_private.marketing_content_items set status='pending_approval' where id=p_content_id returning * into content_row;
  insert into atlas_private.marketing_content_approvals (content_id,decision,actor_id,actor_label,actor_role,note)
  values (p_content_id,'submitted',p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),''))
  returning * into approval_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'approval',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'approval_submitted',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('approval_id',approval_row.id,'note',p_note)
  );
  return jsonb_build_object('content',to_jsonb(content_row),'approval',to_jsonb(approval_row));
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 64
create or replace function atlas_private.marketing_decide_approval(
  p_content_id uuid,
  p_decision text,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  approval_row atlas_private.marketing_content_approvals;
  next_status text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve marketing content'; end if;
  if p_decision not in ('approved','changes_requested','rejected') then raise exception 'Approval decision is invalid'; end if;
  if p_decision<>'approved' and nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'A note is required for changes or rejection'; end if;

  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status<>'pending_approval' then raise exception 'Content is not awaiting approval'; end if;

  next_status := case
    when p_decision='approved' and previous_row.scheduled_for is not null then 'scheduled'
    when p_decision='approved' then 'approved'
    when p_decision='changes_requested' then 'changes_requested'
    else 'rejected'
  end;

  update atlas_private.marketing_content_items set status=next_status where id=p_content_id returning * into content_row;
  insert into atlas_private.marketing_content_approvals (content_id,decision,actor_id,actor_label,actor_role,note)
  values (p_content_id,p_decision,p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),''))
  returning * into approval_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'approval',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'approval_decided',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('decision',p_decision,'approval_id',approval_row.id,'note',p_note)
  );
  return jsonb_build_object('content',to_jsonb(content_row),'approval',to_jsonb(approval_row));
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 65
create or replace function atlas_private.marketing_mark_published(
  p_content_id uuid,
  p_published_at timestamptz,
  p_external_publication_ids jsonb,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can mark content published'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status not in ('approved','scheduled') then raise exception 'Only approved or scheduled content can be marked published'; end if;

  update atlas_private.marketing_content_items
  set status='published',published_at=coalesce(p_published_at,pg_catalog.now()),
      external_publication_ids=coalesce(p_external_publication_ids,'{}'::jsonb)
  where id=p_content_id returning * into content_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'publication',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_published',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('published_at',content_row.published_at,'platforms',content_row.platforms,'note',p_note)
  );
  return to_jsonb(content_row);
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 66
create or replace function atlas_private.marketing_mark_completed(
  p_content_id uuid,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot complete marketing tasks'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status in ('completed','cancelled','rejected') then raise exception 'This content is already final'; end if;
  if previous_row.content_type not in ('campaign_task','event_promotion') and p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can complete non-task content';
  end if;

  update atlas_private.marketing_content_items
  set status='completed',completed_at=pg_catalog.now()
  where id=p_content_id returning * into content_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'completion',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_completed',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('note',p_note)
  );
  return to_jsonb(content_row);
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 67
create or replace function atlas_private.marketing_convert_recommendation(
  p_recommendation_id uuid,
  p_client_request_id uuid,
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  recommendation_row atlas_private.marketing_recommendations;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot convert a recommendation'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;

  select * into content_row from atlas_private.marketing_content_items where client_request_id=p_client_request_id;
  if found then return jsonb_build_object('duplicate',true,'content',to_jsonb(content_row)); end if;

  select * into recommendation_row
  from atlas_private.marketing_recommendations
  where id=p_recommendation_id
  for update;
  if not found then raise exception 'Marketing recommendation not found'; end if;
  if recommendation_row.status<>'active' then raise exception 'Marketing recommendation is no longer active'; end if;

  insert into atlas_private.marketing_content_items (
    client_request_id,title,content_type,status,priority,platforms,scheduled_for,reminder_at,
    suggested_format,caption_draft,creative_brief,frames,media_requirements,owner_id,owner_label,
    created_by,created_by_label,created_by_role,metadata
  ) values (
    p_client_request_id,recommendation_row.title,recommendation_row.content_type,'draft','normal',recommendation_row.platforms,
    p_scheduled_for,p_reminder_at,recommendation_row.suggested_format,recommendation_row.caption_draft,
    recommendation_row.creative_brief,recommendation_row.frames,'{}'::jsonb,p_actor_id,p_actor_label,
    p_actor_id,p_actor_label,p_actor_role,
    recommendation_row.metadata || jsonb_build_object('source_recommendation_id',recommendation_row.id,'source_recommendation_key',recommendation_row.recommendation_key)
  ) returning * into content_row;

  update atlas_private.marketing_recommendations
  set status='converted',converted_content_id=content_row.id,converted_at=pg_catalog.now(),
      converted_by=p_actor_id,converted_by_label=p_actor_label
  where id=recommendation_row.id;

  perform atlas_private.marketing_record_revision(
    content_row.id,'create',null,to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,'Converted from Atlas recommendation'
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,content_id,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_converted',content_row.id,recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'scheduled_for',p_scheduled_for)
  );
  return jsonb_build_object('duplicate',false,'content',to_jsonb(content_row),'recommendation',to_jsonb(recommendation_row));
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 68
create or replace function atlas_private.marketing_dismiss_recommendation(
  p_recommendation_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare recommendation_row atlas_private.marketing_recommendations;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can dismiss marketing recommendations'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A dismiss reason is required'; end if;
  update atlas_private.marketing_recommendations
  set status='dismissed',dismissed_at=pg_catalog.now(),dismissed_by=p_actor_id,
      dismissed_by_label=p_actor_label,dismiss_reason=trim(p_reason)
  where id=p_recommendation_id and status='active'
  returning * into recommendation_row;
  if not found then raise exception 'Marketing recommendation is not active'; end if;

  insert into atlas_private.marketing_workspace_events (
    event_type,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_dismissed',recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'reason',p_reason)
  );
  return to_jsonb(recommendation_row);
end;
$$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 69
create or replace function public.atlas_marketing_workspace_snapshot(
  p_user_id uuid,p_user_role text,p_start_date date,p_end_date date
)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.marketing_workspace_snapshot(p_user_id,p_user_role,p_start_date,p_end_date); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 70
create or replace function public.atlas_marketing_create_campaign(
  p_name text,p_description text,p_campaign_type text,p_objective text,p_target_audience text,p_platforms text[],p_start_date date,p_end_date date,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_create_campaign(p_name,p_description,p_campaign_type,p_objective,p_target_audience,p_platforms,p_start_date,p_end_date,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 71
create or replace function public.atlas_marketing_create_content(
  p_client_request_id uuid,p_campaign_id uuid,p_title text,p_content_type text,p_priority text,p_platforms text[],p_scheduled_for timestamptz,p_reminder_at timestamptz,
  p_event_starts_at timestamptz,p_event_ends_at timestamptz,p_suggested_format text,p_caption_draft text,p_creative_brief text,p_frames jsonb,p_media_requirements jsonb,
  p_owner_id uuid,p_owner_label text,p_actor_id uuid,p_actor_label text,p_actor_role text,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_create_content(p_client_request_id,p_campaign_id,p_title,p_content_type,p_priority,p_platforms,p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,p_suggested_format,p_caption_draft,p_creative_brief,p_frames,p_media_requirements,p_owner_id,p_owner_label,p_actor_id,p_actor_label,p_actor_role,p_metadata); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 72
create or replace function public.atlas_marketing_update_content(
  p_content_id uuid,p_campaign_id uuid,p_title text,p_priority text,p_platforms text[],p_scheduled_for timestamptz,p_reminder_at timestamptz,p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,p_suggested_format text,p_caption_draft text,p_creative_brief text,p_frames jsonb,p_media_requirements jsonb,p_owner_id uuid,p_owner_label text,
  p_actor_id uuid,p_actor_label text,p_actor_role text,p_note text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_update_content(p_content_id,p_campaign_id,p_title,p_priority,p_platforms,p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,p_suggested_format,p_caption_draft,p_creative_brief,p_frames,p_media_requirements,p_owner_id,p_owner_label,p_actor_id,p_actor_label,p_actor_role,p_note); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 73
create or replace function public.atlas_marketing_submit_approval(
  p_content_id uuid,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_submit_approval(p_content_id,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 74
create or replace function public.atlas_marketing_decide_approval(
  p_content_id uuid,p_decision text,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_decide_approval(p_content_id,p_decision,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 75
create or replace function public.atlas_marketing_mark_published(
  p_content_id uuid,p_published_at timestamptz,p_external_publication_ids jsonb,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_mark_published(p_content_id,p_published_at,p_external_publication_ids,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 76
create or replace function public.atlas_marketing_mark_completed(
  p_content_id uuid,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_mark_completed(p_content_id,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 77
create or replace function public.atlas_marketing_convert_recommendation(
  p_recommendation_id uuid,p_client_request_id uuid,p_scheduled_for timestamptz,p_reminder_at timestamptz,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_convert_recommendation(p_recommendation_id,p_client_request_id,p_scheduled_for,p_reminder_at,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 78
create or replace function public.atlas_marketing_dismiss_recommendation(
  p_recommendation_id uuid,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_dismiss_recommendation(p_recommendation_id,p_reason,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 79
revoke execute on function public.atlas_marketing_workspace_snapshot(uuid,text,date,date) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 80
revoke execute on function public.atlas_marketing_create_campaign(text,text,text,text,text,text[],date,date,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 81
revoke execute on function public.atlas_marketing_create_content(uuid,uuid,text,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,jsonb) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 82
revoke execute on function public.atlas_marketing_update_content(uuid,uuid,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 83
revoke execute on function public.atlas_marketing_submit_approval(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 84
revoke execute on function public.atlas_marketing_decide_approval(uuid,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 85
revoke execute on function public.atlas_marketing_mark_published(uuid,timestamptz,jsonb,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 86
revoke execute on function public.atlas_marketing_mark_completed(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 87
revoke execute on function public.atlas_marketing_convert_recommendation(uuid,uuid,timestamptz,timestamptz,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 88
revoke execute on function public.atlas_marketing_dismiss_recommendation(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 89
grant execute on function public.atlas_marketing_workspace_snapshot(uuid,text,date,date) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 90
grant execute on function public.atlas_marketing_create_campaign(text,text,text,text,text,text[],date,date,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 91
grant execute on function public.atlas_marketing_create_content(uuid,uuid,text,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 92
grant execute on function public.atlas_marketing_update_content(uuid,uuid,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 93
grant execute on function public.atlas_marketing_submit_approval(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 94
grant execute on function public.atlas_marketing_decide_approval(uuid,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 95
grant execute on function public.atlas_marketing_mark_published(uuid,timestamptz,jsonb,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 96
grant execute on function public.atlas_marketing_mark_completed(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 97
grant execute on function public.atlas_marketing_convert_recommendation(uuid,uuid,timestamptz,timestamptz,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 98
grant execute on function public.atlas_marketing_dismiss_recommendation(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 99
comment on table atlas_private.marketing_content_items is 'Private VÁ content calendar, draft, reminder, approval and publication history.';

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 100
comment on table atlas_private.marketing_recommendations is 'Deterministic shadow recommendations that must be converted and approved by staff before use.';

-- SOURCE supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql statement 101
comment on function public.atlas_marketing_workspace_snapshot(uuid,text,date,date) is 'Service-role-only Marketing workspace snapshot. Browser publishing and analytics remain disabled.';

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 0
create table if not exists atlas_private.marketing_recommendation_occurrences (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.marketing_recommendations(id) on delete cascade,
  occurrence_date date not null,
  state text not null check (state in ('converted','dismissed')),
  content_id uuid references atlas_private.marketing_content_items(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recommendation_id,occurrence_date)
);

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 1
create index if not exists marketing_recommendation_occurrences_date_idx
  on atlas_private.marketing_recommendation_occurrences(occurrence_date,state,recommendation_id);

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 2
create index if not exists marketing_recommendation_occurrences_content_idx
  on atlas_private.marketing_recommendation_occurrences(content_id)
  where content_id is not null;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 3
alter table atlas_private.marketing_recommendation_occurrences enable row level security;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 4
drop policy if exists "service role manages marketing recommendation occurrences" on atlas_private.marketing_recommendation_occurrences;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 5
create policy "service role manages marketing recommendation occurrences"
  on atlas_private.marketing_recommendation_occurrences for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 6
revoke all on atlas_private.marketing_recommendation_occurrences from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 7
grant all on atlas_private.marketing_recommendation_occurrences to service_role;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 8
drop trigger if exists marketing_recommendation_occurrences_touch on atlas_private.marketing_recommendation_occurrences;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 9
create trigger marketing_recommendation_occurrences_touch
  before update on atlas_private.marketing_recommendation_occurrences
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 10
create or replace function atlas_private.marketing_recommendations_for_date(p_local_date date)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',recommendation.id,
    'recommendation_key',recommendation.recommendation_key,
    'title',recommendation.title,
    'summary',recommendation.summary,
    'content_type',recommendation.content_type,
    'platforms',recommendation.platforms,
    'recurrence',recommendation.recurrence,
    'day_of_week',recommendation.day_of_week,
    'suggested_time',recommendation.suggested_time,
    'suggested_format',recommendation.suggested_format,
    'caption_draft',recommendation.caption_draft,
    'creative_brief',recommendation.creative_brief,
    'frames',recommendation.frames,
    'reason',recommendation.reason,
    'evidence',recommendation.evidence,
    'confidence_score',recommendation.confidence_score,
    'status',recommendation.status,
    'is_due_today',case
      when recommendation.recurrence='daily' then true
      when recommendation.recurrence='weekly' then recommendation.day_of_week=extract(dow from p_local_date)::smallint
      when recommendation.recurrence='one_off' then recommendation.active_from=p_local_date
      else false
    end,
    'occurrence_state',occurrence.state,
    'occurrence_content_id',occurrence.content_id,
    'occurrence_date',occurrence.occurrence_date,
    'available_for_today',(occurrence.id is null),
    'metadata',recommendation.metadata
  ) order by
    case
      when recommendation.recurrence='daily' then 0
      when recommendation.recurrence='weekly' and recommendation.day_of_week=extract(dow from p_local_date)::smallint then 0
      when recommendation.recurrence='one_off' and recommendation.active_from=p_local_date then 0
      else 1
    end,
    recommendation.suggested_time nulls last,
    recommendation.title),'[]'::jsonb)
  from atlas_private.marketing_recommendations recommendation
  left join atlas_private.marketing_recommendation_occurrences occurrence
    on occurrence.recommendation_id=recommendation.id
   and occurrence.occurrence_date=p_local_date
  where recommendation.status='active'
    and (recommendation.active_from is null or recommendation.active_from<=p_local_date)
    and (recommendation.active_to is null or recommendation.active_to>=p_local_date);
$$;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 11
create or replace function atlas_private.marketing_convert_recommendation_occurrence(
  p_recommendation_id uuid,
  p_occurrence_date date,
  p_client_request_id uuid,
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  recommendation_row atlas_private.marketing_recommendations;
  existing_occurrence atlas_private.marketing_recommendation_occurrences;
  content_row atlas_private.marketing_content_items;
  occurrence_row atlas_private.marketing_recommendation_occurrences;
  occurrence_date date := coalesce(p_occurrence_date,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot convert a recommendation'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;

  select * into content_row from atlas_private.marketing_content_items where client_request_id=p_client_request_id;
  if found then return jsonb_build_object('duplicate',true,'content',to_jsonb(content_row)); end if;

  select * into recommendation_row
  from atlas_private.marketing_recommendations
  where id=p_recommendation_id
  for update;
  if not found then raise exception 'Marketing recommendation not found'; end if;
  if recommendation_row.status<>'active' then raise exception 'Marketing recommendation is no longer active'; end if;
  if recommendation_row.active_from is not null and occurrence_date<recommendation_row.active_from then raise exception 'Recommendation is not active on this date'; end if;
  if recommendation_row.active_to is not null and occurrence_date>recommendation_row.active_to then raise exception 'Recommendation is not active on this date'; end if;
  if recommendation_row.recurrence='weekly'
     and recommendation_row.day_of_week is distinct from extract(dow from occurrence_date)::smallint then
    raise exception 'This weekly recommendation is not scheduled for the selected date';
  end if;
  if recommendation_row.recurrence='one_off'
     and recommendation_row.active_from is not null
     and recommendation_row.active_from<>occurrence_date then
    raise exception 'This one-off recommendation belongs to another date';
  end if;

  select * into existing_occurrence
  from atlas_private.marketing_recommendation_occurrences
  where recommendation_id=recommendation_row.id and occurrence_date=occurrence_date;
  if found then
    return jsonb_build_object(
      'duplicate',true,
      'occurrence',to_jsonb(existing_occurrence),
      'content',case when existing_occurrence.content_id is null then null else (
        select to_jsonb(content) from atlas_private.marketing_content_items content where content.id=existing_occurrence.content_id
      ) end
    );
  end if;

  insert into atlas_private.marketing_content_items (
    client_request_id,title,content_type,status,priority,platforms,scheduled_for,reminder_at,
    suggested_format,caption_draft,creative_brief,frames,media_requirements,owner_id,owner_label,
    created_by,created_by_label,created_by_role,metadata
  ) values (
    p_client_request_id,recommendation_row.title,recommendation_row.content_type,'draft','normal',recommendation_row.platforms,
    p_scheduled_for,p_reminder_at,recommendation_row.suggested_format,recommendation_row.caption_draft,
    recommendation_row.creative_brief,recommendation_row.frames,'{}'::jsonb,p_actor_id,p_actor_label,
    p_actor_id,p_actor_label,p_actor_role,
    recommendation_row.metadata || jsonb_build_object(
      'source_recommendation_id',recommendation_row.id,
      'source_recommendation_key',recommendation_row.recommendation_key,
      'source_occurrence_date',occurrence_date
    )
  ) returning * into content_row;

  insert into atlas_private.marketing_recommendation_occurrences (
    recommendation_id,occurrence_date,state,content_id,actor_id,actor_label,actor_role
  ) values (
    recommendation_row.id,occurrence_date,'converted',content_row.id,p_actor_id,p_actor_label,p_actor_role
  ) returning * into occurrence_row;

  if recommendation_row.recurrence='one_off' then
    update atlas_private.marketing_recommendations
    set status='converted',converted_content_id=content_row.id,converted_at=pg_catalog.now(),
        converted_by=p_actor_id,converted_by_label=p_actor_label
    where id=recommendation_row.id;
  end if;

  perform atlas_private.marketing_record_revision(
    content_row.id,'create',null,to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,'Converted from Atlas recommendation'
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,content_id,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_converted',content_row.id,recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'occurrence_date',occurrence_date,'scheduled_for',p_scheduled_for)
  );

  return jsonb_build_object('duplicate',false,'content',to_jsonb(content_row),'occurrence',to_jsonb(occurrence_row));
end;
$$;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 12
create or replace function atlas_private.marketing_dismiss_recommendation_occurrence(
  p_recommendation_id uuid,
  p_occurrence_date date,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  recommendation_row atlas_private.marketing_recommendations;
  occurrence_row atlas_private.marketing_recommendation_occurrences;
  occurrence_date date := coalesce(p_occurrence_date,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can dismiss marketing recommendations'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A dismiss reason is required'; end if;

  select * into recommendation_row from atlas_private.marketing_recommendations where id=p_recommendation_id for update;
  if not found or recommendation_row.status<>'active' then raise exception 'Marketing recommendation is not active'; end if;

  insert into atlas_private.marketing_recommendation_occurrences (
    recommendation_id,occurrence_date,state,actor_id,actor_label,actor_role,reason
  ) values (
    recommendation_row.id,occurrence_date,'dismissed',p_actor_id,p_actor_label,p_actor_role,trim(p_reason)
  )
  on conflict (recommendation_id,occurrence_date) do update set
    state='dismissed',content_id=null,actor_id=excluded.actor_id,actor_label=excluded.actor_label,
    actor_role=excluded.actor_role,reason=excluded.reason,updated_at=pg_catalog.now()
  returning * into occurrence_row;

  if recommendation_row.recurrence='one_off' then
    update atlas_private.marketing_recommendations
    set status='dismissed',dismissed_at=pg_catalog.now(),dismissed_by=p_actor_id,
        dismissed_by_label=p_actor_label,dismiss_reason=trim(p_reason)
    where id=recommendation_row.id;
  end if;

  insert into atlas_private.marketing_workspace_events (
    event_type,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_dismissed',recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'occurrence_date',occurrence_date,'reason',p_reason)
  );
  return to_jsonb(occurrence_row);
end;
$$;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 13
create or replace function public.atlas_marketing_recommendations(p_local_date date)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.marketing_recommendations_for_date(p_local_date); $$;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 14
create or replace function public.atlas_marketing_convert_recommendation_occurrence(
  p_recommendation_id uuid,p_occurrence_date date,p_client_request_id uuid,p_scheduled_for timestamptz,p_reminder_at timestamptz,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_convert_recommendation_occurrence(p_recommendation_id,p_occurrence_date,p_client_request_id,p_scheduled_for,p_reminder_at,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 15
create or replace function public.atlas_marketing_dismiss_recommendation_occurrence(
  p_recommendation_id uuid,p_occurrence_date date,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_dismiss_recommendation_occurrence(p_recommendation_id,p_occurrence_date,p_reason,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 16
revoke execute on function public.atlas_marketing_recommendations(date) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 17
revoke execute on function public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 18
revoke execute on function public.atlas_marketing_dismiss_recommendation_occurrence(uuid,date,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 19
grant execute on function public.atlas_marketing_recommendations(date) to service_role;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 20
grant execute on function public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 21
grant execute on function public.atlas_marketing_dismiss_recommendation_occurrence(uuid,date,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql statement 22
comment on table atlas_private.marketing_recommendation_occurrences is 'Per-date conversion or dismissal state for recurring Atlas marketing recommendations.';

-- SOURCE supabase/migrations/20260803145746_atlas_marketing_recommendation_occurrence_fix.sql statement 0
-- Fix PL/pgSQL name ambiguity between the occurrence_date column and the
-- occurrence date local variable. The qualified query keeps recurring Atlas
-- recommendations idempotent without changing the public RPC contract.

create or replace function atlas_private.marketing_convert_recommendation_occurrence(
  p_recommendation_id uuid,
  p_occurrence_date date,
  p_client_request_id uuid,
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  recommendation_row atlas_private.marketing_recommendations;
  existing_occurrence atlas_private.marketing_recommendation_occurrences;
  content_row atlas_private.marketing_content_items;
  occurrence_row atlas_private.marketing_recommendation_occurrences;
  v_occurrence_date date := coalesce(p_occurrence_date,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot convert a recommendation'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;

  select * into content_row
  from atlas_private.marketing_content_items
  where client_request_id=p_client_request_id;
  if found then return jsonb_build_object('duplicate',true,'content',to_jsonb(content_row)); end if;

  select * into recommendation_row
  from atlas_private.marketing_recommendations
  where id=p_recommendation_id
  for update;
  if not found then raise exception 'Marketing recommendation not found'; end if;
  if recommendation_row.status<>'active' then raise exception 'Marketing recommendation is no longer active'; end if;
  if recommendation_row.active_from is not null and v_occurrence_date<recommendation_row.active_from then raise exception 'Recommendation is not active on this date'; end if;
  if recommendation_row.active_to is not null and v_occurrence_date>recommendation_row.active_to then raise exception 'Recommendation is not active on this date'; end if;
  if recommendation_row.recurrence='weekly'
     and recommendation_row.day_of_week is distinct from extract(dow from v_occurrence_date)::smallint then
    raise exception 'This weekly recommendation is not scheduled for the selected date';
  end if;
  if recommendation_row.recurrence='one_off'
     and recommendation_row.active_from is not null
     and recommendation_row.active_from<>v_occurrence_date then
    raise exception 'This one-off recommendation belongs to another date';
  end if;

  select occurrence.* into existing_occurrence
  from atlas_private.marketing_recommendation_occurrences occurrence
  where occurrence.recommendation_id=recommendation_row.id
    and occurrence.occurrence_date=v_occurrence_date;
  if found then
    return jsonb_build_object(
      'duplicate',true,
      'occurrence',to_jsonb(existing_occurrence),
      'content',case when existing_occurrence.content_id is null then null else (
        select to_jsonb(content)
        from atlas_private.marketing_content_items content
        where content.id=existing_occurrence.content_id
      ) end
    );
  end if;

  insert into atlas_private.marketing_content_items (
    client_request_id,title,content_type,status,priority,platforms,scheduled_for,reminder_at,
    suggested_format,caption_draft,creative_brief,frames,media_requirements,owner_id,owner_label,
    created_by,created_by_label,created_by_role,metadata
  ) values (
    p_client_request_id,recommendation_row.title,recommendation_row.content_type,'draft','normal',recommendation_row.platforms,
    p_scheduled_for,p_reminder_at,recommendation_row.suggested_format,recommendation_row.caption_draft,
    recommendation_row.creative_brief,recommendation_row.frames,'{}'::jsonb,p_actor_id,p_actor_label,
    p_actor_id,p_actor_label,p_actor_role,
    recommendation_row.metadata || jsonb_build_object(
      'source_recommendation_id',recommendation_row.id,
      'source_recommendation_key',recommendation_row.recommendation_key,
      'source_occurrence_date',v_occurrence_date
    )
  ) returning * into content_row;

  insert into atlas_private.marketing_recommendation_occurrences (
    recommendation_id,occurrence_date,state,content_id,actor_id,actor_label,actor_role
  ) values (
    recommendation_row.id,v_occurrence_date,'converted',content_row.id,p_actor_id,p_actor_label,p_actor_role
  ) returning * into occurrence_row;

  if recommendation_row.recurrence='one_off' then
    update atlas_private.marketing_recommendations
    set status='converted',converted_content_id=content_row.id,converted_at=pg_catalog.now(),
        converted_by=p_actor_id,converted_by_label=p_actor_label
    where id=recommendation_row.id;
  end if;

  perform atlas_private.marketing_record_revision(
    content_row.id,'create',null,to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,'Converted from Atlas recommendation'
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,content_id,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_converted',content_row.id,recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'occurrence_date',v_occurrence_date,'scheduled_for',p_scheduled_for)
  );

  return jsonb_build_object('duplicate',false,'content',to_jsonb(content_row),'occurrence',to_jsonb(occurrence_row));
end;
$$;

-- SOURCE supabase/migrations/20260803150024_atlas_marketing_recommendation_dismiss_occurrence_fix.sql statement 0
-- Qualify the per-date dismissal state so the PL/pgSQL local date cannot be
-- confused with the occurrence_date column during insert/upsert operations.

create or replace function atlas_private.marketing_dismiss_recommendation_occurrence(
  p_recommendation_id uuid,
  p_occurrence_date date,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  recommendation_row atlas_private.marketing_recommendations;
  occurrence_row atlas_private.marketing_recommendation_occurrences;
  v_occurrence_date date := coalesce(p_occurrence_date,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can dismiss marketing recommendations'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A dismiss reason is required'; end if;

  select * into recommendation_row
  from atlas_private.marketing_recommendations
  where id=p_recommendation_id
  for update;
  if not found or recommendation_row.status<>'active' then raise exception 'Marketing recommendation is not active'; end if;
  if recommendation_row.active_from is not null and v_occurrence_date<recommendation_row.active_from then raise exception 'Recommendation is not active on this date'; end if;
  if recommendation_row.active_to is not null and v_occurrence_date>recommendation_row.active_to then raise exception 'Recommendation is not active on this date'; end if;
  if recommendation_row.recurrence='weekly'
     and recommendation_row.day_of_week is distinct from extract(dow from v_occurrence_date)::smallint then
    raise exception 'This weekly recommendation is not scheduled for the selected date';
  end if;
  if recommendation_row.recurrence='one_off'
     and recommendation_row.active_from is not null
     and recommendation_row.active_from<>v_occurrence_date then
    raise exception 'This one-off recommendation belongs to another date';
  end if;

  insert into atlas_private.marketing_recommendation_occurrences (
    recommendation_id,occurrence_date,state,actor_id,actor_label,actor_role,reason
  ) values (
    recommendation_row.id,v_occurrence_date,'dismissed',p_actor_id,p_actor_label,p_actor_role,trim(p_reason)
  )
  on conflict (recommendation_id,occurrence_date) do update set
    state='dismissed',content_id=null,actor_id=excluded.actor_id,actor_label=excluded.actor_label,
    actor_role=excluded.actor_role,reason=excluded.reason,updated_at=pg_catalog.now()
  returning * into occurrence_row;

  if recommendation_row.recurrence='one_off' then
    update atlas_private.marketing_recommendations
    set status='dismissed',dismissed_at=pg_catalog.now(),dismissed_by=p_actor_id,
        dismissed_by_label=p_actor_label,dismiss_reason=trim(p_reason)
    where id=recommendation_row.id;
  end if;

  insert into atlas_private.marketing_workspace_events (
    event_type,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_dismissed',recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'occurrence_date',v_occurrence_date,'reason',p_reason)
  );
  return to_jsonb(occurrence_row);
end;
$$;

-- SOURCE supabase/migrations/20260803150212_atlas_marketing_snapshot_variable_conflict_fix.sql statement 0
-- The initial Marketing snapshot uses local start_date/end_date variables that
-- share names with campaign columns. Recompile the existing versioned function
-- with PL/pgSQL's use-variable directive so its calendar range remains
-- unambiguous without duplicating the large snapshot definition.

do $migration$
declare
  function_definition text;
begin
  select pg_get_functiondef('atlas_private.marketing_workspace_snapshot(uuid,text,date,date)'::regprocedure)
  into function_definition;

  if function_definition not like '%#variable_conflict use_variable%' then
    function_definition := replace(
      function_definition,
      E'AS $function$\ndeclare',
      E'AS $function$\n#variable_conflict use_variable\ndeclare'
    );
    execute function_definition;
  end if;
end;
$migration$;

-- SOURCE supabase/migrations/20260803150824_atlas_marketing_foreign_key_indexes.sql statement 0
-- Cover the remaining Marketing foreign keys used by history and
-- recommendation lookups. These are intentionally partial where null is the
-- common case.

create index if not exists marketing_recommendations_converted_content_idx
  on atlas_private.marketing_recommendations(converted_content_id)
  where converted_content_id is not null;

-- SOURCE supabase/migrations/20260803150824_atlas_marketing_foreign_key_indexes.sql statement 1
create index if not exists marketing_events_campaign_idx
  on atlas_private.marketing_workspace_events(campaign_id,created_at desc)
  where campaign_id is not null;

-- SOURCE supabase/migrations/20260803150824_atlas_marketing_foreign_key_indexes.sql statement 2
create index if not exists marketing_events_recommendation_idx
  on atlas_private.marketing_workspace_events(recommendation_id,created_at desc)
  where recommendation_id is not null;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 0
-- Checkpoint E — private Team Profiles data and service-role RPC surface.
-- Production Auth profiles and onboarding records remain the authority for
-- identity, role, active access and training; this branch stores private
-- employment details, emergency contacts and immutable audit events.

create table if not exists atlas_private.team_profile_details (
  profile_id uuid primary key,
  preferred_name text,
  job_title text,
  department text check (department is null or department in ('management','bar','kitchen','service','operations','marketing','other')),
  employment_type text check (employment_type is null or employment_type in ('owner','full_time','part_time','temporary','contractor','other')),
  start_date date,
  phone text check (phone is null or char_length(phone) between 3 and 40),
  phone_visibility text not null default 'managers_only' check (phone_visibility in ('team','managers_only')),
  preferred_language text,
  manager_notes text,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (preferred_name is null or char_length(preferred_name) between 1 and 120),
  check (job_title is null or char_length(job_title) <= 160),
  check (preferred_language is null or char_length(preferred_language) <= 80),
  check (manager_notes is null or char_length(manager_notes) <= 5000)
);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 1
create table if not exists atlas_private.team_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  contact_name text not null check (char_length(contact_name) between 1 and 160),
  relationship text check (relationship is null or char_length(relationship) <= 120),
  phone text not null check (char_length(phone) between 3 and 40),
  note text check (note is null or char_length(note) <= 2000),
  priority smallint not null default 1 check (priority between 1 and 5),
  active boolean not null default true,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 2
create table if not exists atlas_private.team_profile_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'profile_details_updated','display_name_changed','role_changed',
    'active_status_changed','emergency_contact_saved',
    'emergency_contact_removed','onboarding_status_changed'
  )),
  profile_id uuid not null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 3
create index if not exists team_profile_details_department_idx
  on atlas_private.team_profile_details(department,employment_type);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 4
create index if not exists team_emergency_contacts_profile_idx
  on atlas_private.team_emergency_contacts(profile_id,active,priority);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 5
create unique index if not exists team_emergency_contacts_active_priority_uidx
  on atlas_private.team_emergency_contacts(profile_id,priority) where active=true;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 6
create index if not exists team_profile_events_profile_created_idx
  on atlas_private.team_profile_events(profile_id,created_at desc);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 7
create index if not exists team_profile_events_created_idx
  on atlas_private.team_profile_events(created_at desc);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 8
alter table atlas_private.team_profile_details enable row level security;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 9
alter table atlas_private.team_emergency_contacts enable row level security;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 10
alter table atlas_private.team_profile_events enable row level security;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 11
drop policy if exists "service role manages team profile details" on atlas_private.team_profile_details;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 12
create policy "service role manages team profile details" on atlas_private.team_profile_details
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 13
drop policy if exists "service role manages team emergency contacts" on atlas_private.team_emergency_contacts;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 14
create policy "service role manages team emergency contacts" on atlas_private.team_emergency_contacts
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 15
drop policy if exists "service role manages team profile events" on atlas_private.team_profile_events;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 16
create policy "service role manages team profile events" on atlas_private.team_profile_events
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 17
revoke all on atlas_private.team_profile_details from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 18
revoke all on atlas_private.team_emergency_contacts from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 19
revoke all on atlas_private.team_profile_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 20
grant all on atlas_private.team_profile_details to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 21
grant all on atlas_private.team_emergency_contacts to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 22
grant all on atlas_private.team_profile_events to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 23
drop trigger if exists team_profile_details_touch on atlas_private.team_profile_details;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 24
create trigger team_profile_details_touch before update on atlas_private.team_profile_details
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 25
drop trigger if exists team_emergency_contacts_touch on atlas_private.team_emergency_contacts;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 26
create trigger team_emergency_contacts_touch before update on atlas_private.team_emergency_contacts
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 27
create or replace function atlas_private.team_profiles_snapshot(
  p_profiles jsonb,p_tasks jsonb,p_progress jsonb,p_actor_id uuid,p_actor_role text
) returns jsonb
language sql stable security invoker set search_path=''
as $$
with profiles_input as (
  select * from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as p(
    id uuid,email text,display_name text,role text,active boolean,
    created_at timestamptz,updated_at timestamptz
  )
), tasks_input as (
  select * from jsonb_to_recordset(coalesce(p_tasks,'[]'::jsonb)) as t(
    id uuid,title text,description text,category text,sort_order integer,
    required boolean,active boolean
  )
), progress_input as (
  select * from jsonb_to_recordset(coalesce(p_progress,'[]'::jsonb)) as x(
    id uuid,task_id uuid,user_id uuid,completed_at timestamptz,
    completed_by uuid,note text
  )
), visible as (
  select p.* from profiles_input p
  where p_actor_role in ('admin','manager') or p.active=true or p.id=p_actor_id
), rows as (
  select p.id,p.active,
    coalesce(nullif(trim(d.preferred_name),''),nullif(trim(p.display_name),''),split_part(coalesce(p.email,''),'@',1),'Team member') sort_name,
    jsonb_build_object(
      'id',p.id,'email',p.email,'display_name',p.display_name,
      'preferred_name',d.preferred_name,
      'name',coalesce(nullif(trim(d.preferred_name),''),nullif(trim(p.display_name),''),split_part(coalesce(p.email,''),'@',1),'Team member'),
      'role',p.role,'active',coalesce(p.active,false),'job_title',d.job_title,
      'department',d.department,'employment_type',d.employment_type,
      'start_date',d.start_date,
      'phone',case when p_actor_role in ('admin','manager') or p.id=p_actor_id or d.phone_visibility='team' then d.phone end,
      'phone_visibility',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then coalesce(d.phone_visibility,'managers_only') end,
      'preferred_language',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then d.preferred_language end,
      'manager_notes',case when p_actor_role in ('admin','manager') then d.manager_notes end,
      'created_at',p.created_at,'updated_at',greatest(p.updated_at,d.updated_at),
      'can_view_sensitive',(p_actor_role in ('admin','manager') or p.id=p_actor_id),
      'can_edit_profile',(p_actor_role in ('admin','manager') or p.id=p_actor_id),
      'can_manage_access',(p_actor_role in ('admin','manager') and p.id<>p_actor_id),
      'can_manage_training',(p_actor_role in ('admin','manager')),
      'emergency_contact_count',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then (
        select count(*)::bigint from atlas_private.team_emergency_contacts c
        where c.profile_id=p.id and c.active=true
      ) end,
      'emergency_contacts',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',c.id,'contact_name',c.contact_name,'relationship',c.relationship,
          'phone',c.phone,'note',c.note,'priority',c.priority,'active',c.active,
          'updated_at',c.updated_at
        ) order by c.priority,c.contact_name)
        from atlas_private.team_emergency_contacts c
        where c.profile_id=p.id and c.active=true
      ),'[]'::jsonb) else '[]'::jsonb end,
      'profile_completion_percent',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then 20 * (
        (coalesce(nullif(trim(d.preferred_name),''),nullif(trim(p.display_name),'')) is not null)::integer
        + (nullif(trim(d.job_title),'') is not null)::integer
        + (nullif(trim(d.phone),'') is not null)::integer
        + (d.start_date is not null)::integer
        + case when exists(select 1 from atlas_private.team_emergency_contacts c where c.profile_id=p.id and c.active=true) then 1 else 0 end
      ) end,
      'training',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then jsonb_build_object(
        'total_required',(select count(*)::bigint from tasks_input t where t.active and t.required),
        'completed_required',(select count(*)::bigint from tasks_input t where t.active and t.required and exists(
          select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
        )),
        'percent',case when (select count(*) from tasks_input t where t.active and t.required)=0 then 100 else round(100 *
          (select count(*) from tasks_input t where t.active and t.required and exists(
            select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
          ))::numeric / (select count(*) from tasks_input t where t.active and t.required)::numeric) end,
        'complete',not exists(select 1 from tasks_input t where t.active and t.required and not exists(
          select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
        )),
        'tasks',coalesce((select jsonb_agg(jsonb_build_object(
          'id',t.id,'title',t.title,'description',t.description,'category',t.category,
          'sort_order',t.sort_order,'required',t.required,'completed',(x.completed_at is not null),
          'completed_at',x.completed_at,'completed_by',x.completed_by,'note',x.note
        ) order by t.sort_order,t.title)
        from tasks_input t left join progress_input x on x.task_id=t.id and x.user_id=p.id
        where t.active),'[]'::jsonb)
      ) else jsonb_build_object('private',true) end
    ) payload
  from visible p left join atlas_private.team_profile_details d on d.profile_id=p.id
)
select jsonb_build_object(
  'version','atlas-team-profiles/0.1.0','generated_at',pg_catalog.now(),
  'profiles',coalesce((select jsonb_agg(payload order by active desc,sort_name) from rows),'[]'::jsonb),
  'summary',jsonb_build_object(
    'total_profiles',(select count(*)::bigint from visible),
    'active_profiles',(select count(*)::bigint from visible where active),
    'inactive_profiles',case when p_actor_role in ('admin','manager') then (select count(*)::bigint from visible where not active) end,
    'managers',(select count(*)::bigint from visible where active and role in ('admin','manager')),
    'training_complete',case when p_actor_role in ('admin','manager') then (select count(*)::bigint from visible p where not exists(
      select 1 from tasks_input t where t.active and t.required and not exists(
        select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
      ))) end,
    'emergency_contacts_complete',case when p_actor_role in ('admin','manager') then (select count(*)::bigint from visible p where exists(
      select 1 from atlas_private.team_emergency_contacts c where c.profile_id=p.id and c.active=true
    )) end,
    'required_onboarding_tasks',(select count(*)::bigint from tasks_input where active and required)
  ),
  'events',case when p_actor_role in ('admin','manager') then coalesce((select jsonb_agg(jsonb_build_object(
    'id',e.id,'event_type',e.event_type,'profile_id',e.profile_id,'actor_id',e.actor_id,
    'actor_label',e.actor_label,'actor_role',e.actor_role,'payload',e.payload,'created_at',e.created_at
  ) order by e.created_at desc) from (select * from atlas_private.team_profile_events order by created_at desc limit 60) e),'[]'::jsonb) else '[]'::jsonb end,
  'policy',jsonb_build_object(
    'inactive_profile_access','denied_by_gateway','emergency_contacts','self_or_manager',
    'training_management','manager_or_admin','role_and_active_controls','manager_or_admin_except_self',
    'email_change','not_supported_in_checkpoint_e','auth_invitation','not_connected',
    'direct_browser_table_access',false,'audit_history_preserved',true
  )
);
$$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 28
create or replace function atlas_private.team_profile_upsert_details(
  p_profile_id uuid,p_preferred_name text,p_job_title text,p_department text,
  p_employment_type text,p_start_date date,p_phone text,p_phone_visibility text,
  p_preferred_language text,p_manager_notes text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb
language plpgsql volatile security invoker set search_path=''
as $$
declare old_row atlas_private.team_profile_details; saved atlas_private.team_profile_details; manager boolean:=p_actor_role in ('admin','manager');
begin
  if p_profile_id is null or p_actor_id is null then raise exception 'Profile and actor are required'; end if;
  if not manager and p_profile_id<>p_actor_id then raise exception 'Staff may edit only their own contact details'; end if;
  if p_department is not null and p_department not in ('management','bar','kitchen','service','operations','marketing','other') then raise exception 'Department is invalid'; end if;
  if p_employment_type is not null and p_employment_type not in ('owner','full_time','part_time','temporary','contractor','other') then raise exception 'Employment type is invalid'; end if;
  if coalesce(p_phone_visibility,'managers_only') not in ('team','managers_only') then raise exception 'Phone visibility is invalid'; end if;
  select * into old_row from atlas_private.team_profile_details where profile_id=p_profile_id;
  insert into atlas_private.team_profile_details(profile_id,preferred_name,job_title,department,employment_type,start_date,phone,phone_visibility,preferred_language,manager_notes,created_by,created_by_label,updated_by,updated_by_label)
  values(p_profile_id,nullif(trim(coalesce(p_preferred_name,'')),''),case when manager then nullif(trim(coalesce(p_job_title,'')),'') end,case when manager then p_department end,case when manager then p_employment_type end,case when manager then p_start_date end,nullif(trim(coalesce(p_phone,'')),''),coalesce(p_phone_visibility,'managers_only'),nullif(trim(coalesce(p_preferred_language,'')),''),case when manager then nullif(trim(coalesce(p_manager_notes,'')),'') end,p_actor_id,p_actor_label,p_actor_id,p_actor_label)
  on conflict(profile_id) do update set
    preferred_name=excluded.preferred_name,
    job_title=case when manager then excluded.job_title else atlas_private.team_profile_details.job_title end,
    department=case when manager then excluded.department else atlas_private.team_profile_details.department end,
    employment_type=case when manager then excluded.employment_type else atlas_private.team_profile_details.employment_type end,
    start_date=case when manager then excluded.start_date else atlas_private.team_profile_details.start_date end,
    phone=excluded.phone,phone_visibility=excluded.phone_visibility,preferred_language=excluded.preferred_language,
    manager_notes=case when manager then excluded.manager_notes else atlas_private.team_profile_details.manager_notes end,
    updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  returning * into saved;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values('profile_details_updated',p_profile_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object(
    'preferred_name_changed',old_row.preferred_name is distinct from saved.preferred_name,
    'job_title_changed',old_row.job_title is distinct from saved.job_title,
    'department_changed',old_row.department is distinct from saved.department,
    'employment_type_changed',old_row.employment_type is distinct from saved.employment_type,
    'start_date_changed',old_row.start_date is distinct from saved.start_date,
    'phone_changed',old_row.phone is distinct from saved.phone,
    'phone_visibility',saved.phone_visibility,'preferred_language_changed',old_row.preferred_language is distinct from saved.preferred_language,
    'manager_notes_changed',manager and old_row.manager_notes is distinct from saved.manager_notes
  ));
  return to_jsonb(saved);
end; $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 29
create or replace function atlas_private.team_profile_save_emergency_contact(
  p_contact_id uuid,p_profile_id uuid,p_contact_name text,p_relationship text,p_phone text,
  p_note text,p_priority smallint,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb
language plpgsql volatile security invoker set search_path=''
as $$
declare contact_id uuid:=p_contact_id; saved atlas_private.team_emergency_contacts; manager boolean:=p_actor_role in ('admin','manager');
begin
  if not manager and p_profile_id<>p_actor_id then raise exception 'Staff may edit only their own emergency contacts'; end if;
  if nullif(trim(coalesce(p_contact_name,'')),'') is null or nullif(trim(coalesce(p_phone,'')),'') is null then raise exception 'Emergency contact name and phone are required'; end if;
  if coalesce(p_priority,1) not between 1 and 5 then raise exception 'Emergency contact priority must be between 1 and 5'; end if;
  if contact_id is null then select id into contact_id from atlas_private.team_emergency_contacts where profile_id=p_profile_id and priority=coalesce(p_priority,1) and active limit 1; end if;
  update atlas_private.team_emergency_contacts set active=false,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  where profile_id=p_profile_id and priority=coalesce(p_priority,1) and active and (contact_id is null or id<>contact_id);
  if contact_id is null then
    insert into atlas_private.team_emergency_contacts(profile_id,contact_name,relationship,phone,note,priority,active,created_by,created_by_label,updated_by,updated_by_label)
    values(p_profile_id,trim(p_contact_name),nullif(trim(coalesce(p_relationship,'')),''),trim(p_phone),nullif(trim(coalesce(p_note,'')),''),coalesce(p_priority,1),true,p_actor_id,p_actor_label,p_actor_id,p_actor_label)
    returning * into saved;
  else
    update atlas_private.team_emergency_contacts set contact_name=trim(p_contact_name),relationship=nullif(trim(coalesce(p_relationship,'')),''),phone=trim(p_phone),note=nullif(trim(coalesce(p_note,'')),''),priority=coalesce(p_priority,1),active=true,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
    where id=contact_id and profile_id=p_profile_id returning * into saved;
    if not found then raise exception 'Emergency contact not found'; end if;
  end if;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values('emergency_contact_saved',p_profile_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('contact_id',saved.id,'priority',saved.priority));
  return to_jsonb(saved);
end; $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 30
create or replace function atlas_private.team_profile_remove_emergency_contact(
  p_contact_id uuid,p_profile_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb
language plpgsql volatile security invoker set search_path=''
as $$
declare removed atlas_private.team_emergency_contacts; manager boolean:=p_actor_role in ('admin','manager');
begin
  if not manager and p_profile_id<>p_actor_id then raise exception 'Staff may edit only their own emergency contacts'; end if;
  update atlas_private.team_emergency_contacts set active=false,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  where id=p_contact_id and profile_id=p_profile_id and active returning * into removed;
  if not found then raise exception 'Emergency contact not found'; end if;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values('emergency_contact_removed',p_profile_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('contact_id',removed.id,'priority',removed.priority));
  return to_jsonb(removed);
end; $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 31
create or replace function atlas_private.team_profile_log_external_event(
  p_event_type text,p_profile_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text,p_payload jsonb
) returns uuid
language plpgsql volatile security invoker set search_path=''
as $$ declare event_id uuid; begin
  if p_event_type not in ('display_name_changed','role_changed','active_status_changed','onboarding_status_changed') then raise exception 'External team-profile event type is invalid'; end if;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values(p_event_type,p_profile_id,p_actor_id,p_actor_label,p_actor_role,coalesce(p_payload,'{}'::jsonb)) returning id into event_id;
  return event_id;
end; $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 32
create or replace function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.team_profiles_snapshot($1,$2,$3,$4,$5); $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 33
create or replace function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_upsert_details($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13); $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 34
create or replace function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_save_emergency_contact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10); $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 35
create or replace function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_remove_emergency_contact($1,$2,$3,$4,$5); $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 36
create or replace function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb)
returns uuid language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_log_external_event($1,$2,$3,$4,$5,$6); $$;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 37
revoke execute on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 38
revoke execute on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 39
revoke execute on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 40
revoke execute on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 41
revoke execute on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 42
grant execute on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 43
grant execute on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 44
grant execute on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 45
grant execute on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 46
grant execute on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 47
comment on table atlas_private.team_profile_details is 'Private employment and contact details keyed to production VÁ profile IDs.';

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 48
comment on table atlas_private.team_emergency_contacts is 'Emergency contacts visible only to the profile owner and managers through the Team Profiles gateway.';

-- SOURCE supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql statement 49
comment on table atlas_private.team_profile_events is 'Immutable audit history for Team Profile, access, emergency-contact and onboarding changes.';

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 0
-- Checkpoint E.1 — private profile portraits.
-- Images are stored in a dedicated non-public bucket. Browser clients never
-- receive direct object permissions; the authenticated gateway issues short-
-- lived signed display URLs after revalidating the active VÁ profile.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'atlas-profile-photos',
  'atlas-profile-photos',
  false,
  2097152,
  array['image/webp','image/jpeg','image/png']::text[]
)
on conflict (id) do update set
  name=excluded.name,
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types,
  updated_at=now();

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 1
create table if not exists atlas_private.team_profile_photos (
  profile_id uuid primary key,
  bucket_id text not null default 'atlas-profile-photos',
  storage_path text not null unique,
  mime_type text not null,
  byte_size integer not null,
  width integer,
  height integer,
  version uuid not null default gen_random_uuid(),
  uploaded_by uuid,
  uploaded_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (bucket_id='atlas-profile-photos'),
  check (storage_path ~ '^profiles/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|jpeg|png)$'),
  check (mime_type in ('image/webp','image/jpeg','image/png')),
  check (byte_size between 1 and 2097152),
  check (width is null or width between 64 and 2048),
  check (height is null or height between 64 and 2048)
);

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 2
create index if not exists team_profile_photos_updated_idx
  on atlas_private.team_profile_photos(updated_at desc);

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 3
alter table atlas_private.team_profile_photos enable row level security;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 4
drop policy if exists "service role manages team profile photos" on atlas_private.team_profile_photos;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 5
create policy "service role manages team profile photos"
  on atlas_private.team_profile_photos
  for all
  to service_role
  using (true)
  with check (true);

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 6
revoke all on atlas_private.team_profile_photos from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 7
grant all on atlas_private.team_profile_photos to service_role;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 8
drop trigger if exists team_profile_photos_touch on atlas_private.team_profile_photos;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 9
create trigger team_profile_photos_touch
before update on atlas_private.team_profile_photos
for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 10
alter table atlas_private.team_profile_events
  drop constraint if exists team_profile_events_event_type_check;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 11
alter table atlas_private.team_profile_events
  add constraint team_profile_events_event_type_check
  check (event_type in (
    'profile_details_updated',
    'display_name_changed',
    'role_changed',
    'active_status_changed',
    'emergency_contact_saved',
    'emergency_contact_removed',
    'onboarding_status_changed',
    'profile_photo_updated',
    'profile_photo_removed'
  ));

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 12
create or replace function atlas_private.team_profile_photos_snapshot(
  p_profile_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'profile_id',photo.profile_id,
    'bucket_id',photo.bucket_id,
    'storage_path',photo.storage_path,
    'mime_type',photo.mime_type,
    'byte_size',photo.byte_size,
    'width',photo.width,
    'height',photo.height,
    'version',photo.version,
    'updated_at',photo.updated_at
  ) order by photo.updated_at desc),'[]'::jsonb)
  from atlas_private.team_profile_photos photo
  where coalesce(cardinality(p_profile_ids),0)>0
    and photo.profile_id=any(p_profile_ids);
$$;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 13
create or replace function atlas_private.team_profile_photo_upsert(
  p_profile_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_mime_type text,
  p_byte_size integer,
  p_width integer,
  p_height integer,
  p_version uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  existing_row atlas_private.team_profile_photos;
  saved_row atlas_private.team_profile_photos;
begin
  if p_profile_id is null or p_actor_id is null then
    raise exception 'Profile and actor are required';
  end if;
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Actor role is invalid';
  end if;
  if p_actor_role not in ('admin','manager') and p_profile_id<>p_actor_id then
    raise exception 'Staff may change only their own profile photo';
  end if;
  if p_bucket_id<>'atlas-profile-photos' then
    raise exception 'Profile photo bucket is invalid';
  end if;
  if p_storage_path !~ ('^profiles/'||p_profile_id::text||'/[0-9a-f-]{36}\.(webp|jpg|jpeg|png)$') then
    raise exception 'Profile photo path is invalid';
  end if;
  if p_mime_type not in ('image/webp','image/jpeg','image/png') then
    raise exception 'Profile photo type is invalid';
  end if;
  if p_byte_size is null or p_byte_size<1 or p_byte_size>2097152 then
    raise exception 'Profile photo must be no larger than 2 MB';
  end if;
  if p_width is not null and (p_width<64 or p_width>2048) then
    raise exception 'Profile photo width is invalid';
  end if;
  if p_height is not null and (p_height<64 or p_height>2048) then
    raise exception 'Profile photo height is invalid';
  end if;

  select * into existing_row
  from atlas_private.team_profile_photos
  where profile_id=p_profile_id
  for update;

  insert into atlas_private.team_profile_photos (
    profile_id,bucket_id,storage_path,mime_type,byte_size,width,height,version,
    uploaded_by,uploaded_by_label
  ) values (
    p_profile_id,p_bucket_id,p_storage_path,p_mime_type,p_byte_size,p_width,p_height,
    coalesce(p_version,gen_random_uuid()),p_actor_id,p_actor_label
  )
  on conflict (profile_id) do update set
    bucket_id=excluded.bucket_id,
    storage_path=excluded.storage_path,
    mime_type=excluded.mime_type,
    byte_size=excluded.byte_size,
    width=excluded.width,
    height=excluded.height,
    version=excluded.version,
    uploaded_by=excluded.uploaded_by,
    uploaded_by_label=excluded.uploaded_by_label,
    updated_at=pg_catalog.now()
  returning * into saved_row;

  insert into atlas_private.team_profile_events (
    event_type,profile_id,actor_id,actor_label,actor_role,payload
  ) values (
    'profile_photo_updated',p_profile_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'previous_storage_path',existing_row.storage_path,
      'storage_path',saved_row.storage_path,
      'mime_type',saved_row.mime_type,
      'byte_size',saved_row.byte_size,
      'width',saved_row.width,
      'height',saved_row.height,
      'version',saved_row.version
    )
  );

  return jsonb_build_object(
    'photo',to_jsonb(saved_row),
    'previous_storage_path',existing_row.storage_path
  );
end;
$$;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 14
create or replace function atlas_private.team_profile_photo_remove(
  p_profile_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  removed_row atlas_private.team_profile_photos;
begin
  if p_profile_id is null or p_actor_id is null then
    raise exception 'Profile and actor are required';
  end if;
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Actor role is invalid';
  end if;
  if p_actor_role not in ('admin','manager') and p_profile_id<>p_actor_id then
    raise exception 'Staff may remove only their own profile photo';
  end if;

  delete from atlas_private.team_profile_photos
  where profile_id=p_profile_id
  returning * into removed_row;

  if not found then
    return jsonb_build_object('removed',false,'profile_id',p_profile_id);
  end if;

  insert into atlas_private.team_profile_events (
    event_type,profile_id,actor_id,actor_label,actor_role,payload
  ) values (
    'profile_photo_removed',p_profile_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'storage_path',removed_row.storage_path,
      'mime_type',removed_row.mime_type,
      'byte_size',removed_row.byte_size,
      'version',removed_row.version
    )
  );

  return jsonb_build_object(
    'removed',true,
    'photo',to_jsonb(removed_row)
  );
end;
$$;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 15
create or replace function public.atlas_team_profile_photos_snapshot(
  p_profile_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.team_profile_photos_snapshot(p_profile_ids);
$$;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 16
create or replace function public.atlas_team_profile_photo_upsert(
  p_profile_id uuid,p_bucket_id text,p_storage_path text,p_mime_type text,
  p_byte_size integer,p_width integer,p_height integer,p_version uuid,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.team_profile_photo_upsert(
    p_profile_id,p_bucket_id,p_storage_path,p_mime_type,p_byte_size,p_width,p_height,
    p_version,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 17
create or replace function public.atlas_team_profile_photo_remove(
  p_profile_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.team_profile_photo_remove(
    p_profile_id,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 18
revoke execute on function public.atlas_team_profile_photos_snapshot(uuid[]) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 19
revoke execute on function public.atlas_team_profile_photo_upsert(uuid,text,text,text,integer,integer,integer,uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 20
revoke execute on function public.atlas_team_profile_photo_remove(uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 21
grant execute on function public.atlas_team_profile_photos_snapshot(uuid[]) to service_role;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 22
grant execute on function public.atlas_team_profile_photo_upsert(uuid,text,text,text,integer,integer,integer,uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 23
grant execute on function public.atlas_team_profile_photo_remove(uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 24
comment on table atlas_private.team_profile_photos is 'Private metadata for staff profile photos stored in the atlas-profile-photos bucket.';

-- SOURCE supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql statement 25
comment on function public.atlas_team_profile_photos_snapshot(uuid[]) is 'Service-role-only profile-photo metadata lookup. The gateway supplies only profile IDs visible to the caller.';

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 0
-- Checkpoint F — private weekly shift planning.
-- Draft schedules, availability, time off, publications and confirmations live
-- in the isolated branch. Production public.shifts remains unchanged while
-- live_publish_enabled is false.

create table if not exists atlas_private.shift_settings (
  setting_key text primary key,
  timezone text not null default 'Atlantic/Reykjavik',
  week_starts_on smallint not null default 1,
  live_publish_enabled boolean not null default false,
  confirmation_required boolean not null default true,
  default_break_minutes integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (week_starts_on between 0 and 6),
  check (default_break_minutes between 0 and 720),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 1
create table if not exists atlas_private.shift_people (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique,
  display_name text not null,
  email text,
  default_role text,
  active boolean not null default true,
  login_enabled boolean not null default false,
  source text not null default 'manual' check (source in ('profile','manual')),
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(display_name) between 1 and 160),
  check (email is null or char_length(email) <= 320),
  check (default_role is null or char_length(default_role) <= 120),
  check ((source='profile' and profile_id is not null and login_enabled=true) or source='manual')
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 2
create table if not exists atlas_private.shift_weeks (
  week_start date primary key,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  revision integer not null default 0 check (revision >= 0),
  has_unpublished_changes boolean not null default false,
  note text,
  published_at timestamptz,
  published_by uuid,
  published_by_label text,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (extract(isodow from week_start)=1),
  check (note is null or char_length(note) <= 3000)
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 3
create table if not exists atlas_private.shift_entries (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references atlas_private.shift_weeks(week_start) on delete cascade,
  person_id uuid not null references atlas_private.shift_people(id) on delete restrict,
  role_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  break_minutes integer not null default 0,
  note text,
  source text not null default 'manual' check (source in ('manual','copied','imported')),
  active boolean not null default true,
  last_published_revision integer,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at-starts_at <= interval '24 hours'),
  check (break_minutes between 0 and 720),
  check ((extract(epoch from (ends_at-starts_at))/60) > break_minutes),
  check (role_name is null or char_length(role_name) <= 120),
  check (note is null or char_length(note) <= 3000)
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 4
create table if not exists atlas_private.shift_publications (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references atlas_private.shift_weeks(week_start) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null,
  shift_count integer not null,
  planned_hours numeric(10,2) not null,
  published_by uuid,
  published_by_label text,
  published_at timestamptz not null default now(),
  unique (week_start,revision),
  check (jsonb_typeof(snapshot)='object'),
  check (shift_count >= 0),
  check (planned_hours >= 0)
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 5
create table if not exists atlas_private.shift_availability (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references atlas_private.shift_people(id) on delete cascade,
  weekday smallint not null,
  available_from time,
  available_to time,
  unavailable boolean not null default false,
  note text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (person_id,weekday),
  check (weekday between 0 and 6),
  check (note is null or char_length(note) <= 2000),
  check (not unavailable or (available_from is null and available_to is null))
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 6
create table if not exists atlas_private.shift_time_off (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references atlas_private.shift_people(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  request_type text not null default 'unavailable' check (request_type in ('unavailable','vacation','sick','other')),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  note text,
  manager_note text,
  requested_by uuid,
  requested_by_label text,
  decided_by uuid,
  decided_by_label text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (ends_on-starts_on <= 366),
  check (note is null or char_length(note) <= 3000),
  check (manager_note is null or char_length(manager_note) <= 3000)
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 7
create table if not exists atlas_private.shift_responses (
  shift_id uuid not null references atlas_private.shift_entries(id) on delete cascade,
  person_id uuid not null references atlas_private.shift_people(id) on delete cascade,
  response text not null default 'pending' check (response in ('pending','confirmed','change_requested','declined')),
  note text,
  responded_at timestamptz,
  manager_status text not null default 'none' check (manager_status in ('none','open','resolved','rejected')),
  manager_note text,
  decided_by uuid,
  decided_by_label text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shift_id,person_id),
  check (note is null or char_length(note) <= 3000),
  check (manager_note is null or char_length(manager_note) <= 3000)
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 8
create table if not exists atlas_private.shift_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'profiles_synced','person_created','person_updated','shift_created','shift_updated','shift_cancelled',
    'week_copied','week_published','availability_updated','time_off_requested','time_off_decided',
    'shift_response_updated','shift_response_decided'
  )),
  week_start date,
  shift_id uuid references atlas_private.shift_entries(id) on delete set null,
  person_id uuid references atlas_private.shift_people(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 9
create unique index if not exists shift_people_email_uidx on atlas_private.shift_people(lower(email)) where email is not null and active=true;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 10
create index if not exists shift_people_active_name_idx on atlas_private.shift_people(active,display_name);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 11
create index if not exists shift_entries_week_start_idx on atlas_private.shift_entries(week_start,starts_at) where active=true;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 12
create index if not exists shift_entries_person_time_idx on atlas_private.shift_entries(person_id,starts_at,ends_at) where active=true;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 13
create index if not exists shift_publications_latest_idx on atlas_private.shift_publications(week_start,revision desc);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 14
create index if not exists shift_availability_person_idx on atlas_private.shift_availability(person_id,weekday);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 15
create index if not exists shift_time_off_person_dates_idx on atlas_private.shift_time_off(person_id,starts_on,ends_on,status);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 16
create index if not exists shift_time_off_pending_idx on atlas_private.shift_time_off(status,starts_on) where status='pending';

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 17
create index if not exists shift_responses_person_idx on atlas_private.shift_responses(person_id,response,updated_at desc);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 18
create index if not exists shift_responses_open_idx on atlas_private.shift_responses(manager_status,updated_at desc) where manager_status='open';

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 19
create index if not exists shift_events_week_created_idx on atlas_private.shift_events(week_start,created_at desc) where week_start is not null;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 20
create index if not exists shift_events_person_created_idx on atlas_private.shift_events(person_id,created_at desc) where person_id is not null;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 21
alter table atlas_private.shift_settings enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 22
alter table atlas_private.shift_people enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 23
alter table atlas_private.shift_weeks enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 24
alter table atlas_private.shift_entries enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 25
alter table atlas_private.shift_publications enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 26
alter table atlas_private.shift_availability enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 27
alter table atlas_private.shift_time_off enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 28
alter table atlas_private.shift_responses enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 29
alter table atlas_private.shift_events enable row level security;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 30
drop policy if exists "service role manages shift settings" on atlas_private.shift_settings;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 31
create policy "service role manages shift settings" on atlas_private.shift_settings for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 32
drop policy if exists "service role manages shift people" on atlas_private.shift_people;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 33
create policy "service role manages shift people" on atlas_private.shift_people for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 34
drop policy if exists "service role manages shift weeks" on atlas_private.shift_weeks;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 35
create policy "service role manages shift weeks" on atlas_private.shift_weeks for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 36
drop policy if exists "service role manages shift entries" on atlas_private.shift_entries;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 37
create policy "service role manages shift entries" on atlas_private.shift_entries for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 38
drop policy if exists "service role manages shift publications" on atlas_private.shift_publications;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 39
create policy "service role manages shift publications" on atlas_private.shift_publications for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 40
drop policy if exists "service role manages shift availability" on atlas_private.shift_availability;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 41
create policy "service role manages shift availability" on atlas_private.shift_availability for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 42
drop policy if exists "service role manages shift time off" on atlas_private.shift_time_off;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 43
create policy "service role manages shift time off" on atlas_private.shift_time_off for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 44
drop policy if exists "service role manages shift responses" on atlas_private.shift_responses;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 45
create policy "service role manages shift responses" on atlas_private.shift_responses for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 46
drop policy if exists "service role manages shift events" on atlas_private.shift_events;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 47
create policy "service role manages shift events" on atlas_private.shift_events for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 48
revoke all on atlas_private.shift_settings from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 49
revoke all on atlas_private.shift_people from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 50
revoke all on atlas_private.shift_weeks from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 51
revoke all on atlas_private.shift_entries from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 52
revoke all on atlas_private.shift_publications from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 53
revoke all on atlas_private.shift_availability from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 54
revoke all on atlas_private.shift_time_off from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 55
revoke all on atlas_private.shift_responses from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 56
revoke all on atlas_private.shift_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 57
grant all on atlas_private.shift_settings to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 58
grant all on atlas_private.shift_people to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 59
grant all on atlas_private.shift_weeks to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 60
grant all on atlas_private.shift_entries to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 61
grant all on atlas_private.shift_publications to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 62
grant all on atlas_private.shift_availability to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 63
grant all on atlas_private.shift_time_off to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 64
grant all on atlas_private.shift_responses to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 65
grant all on atlas_private.shift_events to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 66
drop trigger if exists shift_settings_touch on atlas_private.shift_settings;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 67
create trigger shift_settings_touch before update on atlas_private.shift_settings for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 68
drop trigger if exists shift_people_touch on atlas_private.shift_people;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 69
create trigger shift_people_touch before update on atlas_private.shift_people for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 70
drop trigger if exists shift_weeks_touch on atlas_private.shift_weeks;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 71
create trigger shift_weeks_touch before update on atlas_private.shift_weeks for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 72
drop trigger if exists shift_entries_touch on atlas_private.shift_entries;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 73
create trigger shift_entries_touch before update on atlas_private.shift_entries for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 74
drop trigger if exists shift_availability_touch on atlas_private.shift_availability;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 75
create trigger shift_availability_touch before update on atlas_private.shift_availability for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 76
drop trigger if exists shift_time_off_touch on atlas_private.shift_time_off;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 77
create trigger shift_time_off_touch before update on atlas_private.shift_time_off for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 78
drop trigger if exists shift_responses_touch on atlas_private.shift_responses;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 79
create trigger shift_responses_touch before update on atlas_private.shift_responses for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 80
insert into atlas_private.shift_settings (
  setting_key,timezone,week_starts_on,live_publish_enabled,confirmation_required,default_break_minutes,metadata
) values (
  'va','Atlantic/Reykjavik',1,false,true,0,
  jsonb_build_object(
    'checkpoint','F',
    'planning_mode','isolated_branch',
    'publish_to_team_enabled',true,
    'production_shift_sync_enabled',false,
    'labour_cost_state','not_configured'
  )
)
on conflict (setting_key) do update set
  timezone=excluded.timezone,
  week_starts_on=excluded.week_starts_on,
  live_publish_enabled=false,
  confirmation_required=excluded.confirmation_required,
  metadata=excluded.metadata,
  updated_at=now();

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 81
create or replace function atlas_private.shift_normalize_week(p_date date)
returns date language sql immutable security invoker set search_path='' as $$
  select (p_date - (extract(isodow from p_date)::integer - 1))::date;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 82
create or replace function atlas_private.shift_ensure_week(
  p_week_start date,p_actor_id uuid,p_actor_label text
)
returns atlas_private.shift_weeks
language plpgsql volatile security invoker set search_path='' as $$
declare week_row atlas_private.shift_weeks;
begin
  if p_week_start is null or extract(isodow from p_week_start)<>1 then raise exception 'Week start must be a Monday'; end if;
  insert into atlas_private.shift_weeks (week_start,created_by,created_by_label)
  values (p_week_start,p_actor_id,p_actor_label)
  on conflict (week_start) do nothing;
  select * into week_row from atlas_private.shift_weeks where week_start=p_week_start;
  return week_row;
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 83
create or replace function atlas_private.shift_sync_profiles(
  p_profiles jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns bigint language plpgsql volatile security invoker set search_path='' as $$
declare changed_count bigint:=0;
begin
  insert into atlas_private.shift_people (
    id,profile_id,display_name,email,default_role,active,login_enabled,source,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select profile.id,profile.id,
    coalesce(nullif(trim(profile.display_name),''),nullif(split_part(coalesce(profile.email,''),'@',1),''),'Team member'),
    nullif(trim(profile.email),''),
    case profile.role when 'admin' then 'Manager' when 'manager' then 'Manager' when 'bartender' then 'Bartender' else 'Team' end,
    coalesce(profile.active,false),true,'profile',p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
    id uuid,email text,display_name text,role text,active boolean
  )
  where profile.id is not null
  on conflict (id) do update set
    profile_id=excluded.profile_id,
    display_name=excluded.display_name,
    email=excluded.email,
    default_role=excluded.default_role,
    active=excluded.active,
    login_enabled=true,
    source='profile',
    updated_by=p_actor_id,
    updated_by_label=p_actor_label,
    updated_at=pg_catalog.now();
  get diagnostics changed_count=row_count;

  insert into atlas_private.shift_events (event_type,actor_id,actor_label,actor_role,payload)
  values ('profiles_synced',p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('changed_count',changed_count));
  return changed_count;
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 84
create or replace function atlas_private.shift_workspace_snapshot(
  p_week_start date,p_actor_id uuid,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  settings_row atlas_private.shift_settings;
  week_row atlas_private.shift_weeks;
  publication_row atlas_private.shift_publications;
  is_manager boolean := p_actor_role in ('admin','manager');
  actor_person_id uuid;
  people_json jsonb:='[]'::jsonb;
  shifts_json jsonb:='[]'::jsonb;
  availability_json jsonb:='[]'::jsonb;
  time_off_json jsonb:='[]'::jsonb;
  responses_json jsonb:='[]'::jsonb;
  events_json jsonb:='[]'::jsonb;
begin
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  week_row := atlas_private.shift_ensure_week(p_week_start,p_actor_id,null);
  select id into actor_person_id from atlas_private.shift_people where profile_id=p_actor_id limit 1;
  select * into publication_row from atlas_private.shift_publications where week_start=p_week_start order by revision desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',person.id,'profile_id',person.profile_id,'display_name',person.display_name,
    'email',person.email,'default_role',person.default_role,'active',person.active,
    'login_enabled',person.login_enabled,'source',person.source,
    'can_edit_availability',(is_manager or person.profile_id=p_actor_id)
  ) order by person.active desc,person.display_name),'[]'::jsonb)
  into people_json
  from atlas_private.shift_people person
  where is_manager or person.active=true or person.profile_id=p_actor_id;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',shift.id,'week_start',shift.week_start,'person_id',shift.person_id,
      'person_name',person.display_name,'profile_id',person.profile_id,
      'login_enabled',person.login_enabled,'role_name',shift.role_name,
      'starts_at',shift.starts_at,'ends_at',shift.ends_at,
      'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'break_minutes',shift.break_minutes,'note',shift.note,'source',shift.source,
      'active',shift.active,'updated_at',shift.updated_at,
      'last_published_revision',shift.last_published_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb)
    into shifts_json
    from atlas_private.shift_entries shift
    join atlas_private.shift_people person on person.id=shift.person_id
    where shift.week_start=p_week_start and shift.active=true;
  elsif publication_row.id is not null then
    shifts_json := coalesce(publication_row.snapshot->'shifts','[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',availability.id,'person_id',availability.person_id,'weekday',availability.weekday,
    'available_from',availability.available_from,'available_to',availability.available_to,
    'unavailable',availability.unavailable,'note',availability.note,
    'updated_at',availability.updated_at
  ) order by availability.person_id,availability.weekday),'[]'::jsonb)
  into availability_json
  from atlas_private.shift_availability availability
  join atlas_private.shift_people person on person.id=availability.person_id
  where is_manager or person.profile_id=p_actor_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',request.id,'person_id',request.person_id,'person_name',person.display_name,
    'starts_on',request.starts_on,'ends_on',request.ends_on,
    'request_type',request.request_type,'status',request.status,'note',request.note,
    'manager_note',case when is_manager then request.manager_note else null end,
    'requested_by_label',request.requested_by_label,
    'decided_by_label',case when is_manager then request.decided_by_label else null end,
    'created_at',request.created_at,'updated_at',request.updated_at
  ) order by request.starts_on,person.display_name),'[]'::jsonb)
  into time_off_json
  from atlas_private.shift_time_off request
  join atlas_private.shift_people person on person.id=request.person_id
  where request.ends_on>=p_week_start-interval '14 days'
    and request.starts_on<=p_week_start+interval '42 days'
    and (is_manager or person.profile_id=p_actor_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id',response.shift_id,'person_id',response.person_id,
    'response',response.response,'note',response.note,'responded_at',response.responded_at,
    'manager_status',case when is_manager then response.manager_status else null end,
    'manager_note',case when is_manager then response.manager_note else null end,
    'decided_by_label',case when is_manager then response.decided_by_label else null end,
    'decided_at',case when is_manager then response.decided_at else null end,
    'updated_at',response.updated_at
  ) order by response.updated_at desc),'[]'::jsonb)
  into responses_json
  from atlas_private.shift_responses response
  join atlas_private.shift_entries shift on shift.id=response.shift_id
  join atlas_private.shift_people person on person.id=response.person_id
  where shift.week_start=p_week_start and (is_manager or person.profile_id=p_actor_id);

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,'event_type',event.event_type,'week_start',event.week_start,
      'shift_id',event.shift_id,'person_id',event.person_id,
      'actor_label',event.actor_label,'actor_role',event.actor_role,
      'payload',event.payload,'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into events_json
    from (
      select * from atlas_private.shift_events
      where week_start=p_week_start or week_start is null
      order by created_at desc limit 80
    ) event;
  end if;

  return jsonb_build_object(
    'version','atlas-shifts/0.1.0',
    'generated_at',pg_catalog.now(),
    'venue_date',(pg_catalog.now() at time zone settings_row.timezone)::date,
    'settings',jsonb_build_object(
      'timezone',settings_row.timezone,
      'week_starts_on',settings_row.week_starts_on,
      'live_publish_enabled',settings_row.live_publish_enabled,
      'confirmation_required',settings_row.confirmation_required,
      'default_break_minutes',settings_row.default_break_minutes,
      'metadata',settings_row.metadata
    ),
    'week',jsonb_build_object(
      'week_start',week_row.week_start,'status',week_row.status,'revision',week_row.revision,
      'has_unpublished_changes',week_row.has_unpublished_changes,'note',week_row.note,
      'published_at',week_row.published_at,'published_by_label',week_row.published_by_label,
      'latest_publication',case when publication_row.id is null then null else jsonb_build_object(
        'id',publication_row.id,'revision',publication_row.revision,
        'shift_count',publication_row.shift_count,'planned_hours',publication_row.planned_hours,
        'published_at',publication_row.published_at,'published_by_label',publication_row.published_by_label
      ) end
    ),
    'people',people_json,'shifts',shifts_json,'availability',availability_json,
    'time_off',time_off_json,'responses',responses_json,'events',events_json,
    'actor_person_id',actor_person_id,
    'permissions',jsonb_build_object(
      'can_manage_schedule',is_manager,'can_add_people',is_manager,
      'can_publish_week',is_manager,'can_manage_all_availability',is_manager,
      'can_decide_time_off',is_manager,'can_respond_to_shifts',(actor_person_id is not null)
    ),
    'trust',jsonb_build_object(
      'planning_environment','isolated_branch',
      'production_shift_sync_enabled',settings_row.live_publish_enabled,
      'publish_to_team_enabled',true,'direct_browser_table_access',false,
      'audit_history_preserved',true,'labour_costs_configured',false,
      'coverage_targets_configured',false
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 85
create or replace function atlas_private.shift_person_create(
  p_display_name text,p_email text,p_default_role text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare person_row atlas_private.shift_people;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can add schedule-only people'; end if;
  if nullif(trim(coalesce(p_display_name,'')),'') is null then raise exception 'Display name is required'; end if;
  insert into atlas_private.shift_people (
    display_name,email,default_role,active,login_enabled,source,
    created_by,created_by_label,updated_by,updated_by_label
  ) values (
    trim(p_display_name),nullif(trim(coalesce(p_email,'')),''),
    nullif(trim(coalesce(p_default_role,'')),''),true,false,'manual',
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  ) returning * into person_row;
  insert into atlas_private.shift_events (
    event_type,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'person_created',person_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('display_name',person_row.display_name)
  );
  return to_jsonb(person_row);
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 86
create or replace function atlas_private.shift_save(
  p_shift_id uuid,p_week_start date,p_person_id uuid,p_role_name text,
  p_starts_local timestamp,p_ends_local timestamp,p_break_minutes integer,p_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  settings_row atlas_private.shift_settings;
  shift_row atlas_private.shift_entries;
  starts_utc timestamptz;
  ends_utc timestamptz;
  event_name text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can create or edit shifts'; end if;
  perform atlas_private.shift_ensure_week(p_week_start,p_actor_id,p_actor_label);
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  if not exists (select 1 from atlas_private.shift_people where id=p_person_id and active=true) then raise exception 'The selected team member is inactive or missing'; end if;
  if p_starts_local is null or p_ends_local is null then raise exception 'Start and end times are required'; end if;
  if atlas_private.shift_normalize_week(p_starts_local::date)<>p_week_start then raise exception 'Shift start is outside the selected week'; end if;
  if p_ends_local<=p_starts_local then raise exception 'Shift end must be after shift start'; end if;
  starts_utc := p_starts_local at time zone settings_row.timezone;
  ends_utc := p_ends_local at time zone settings_row.timezone;

  if p_shift_id is null then
    insert into atlas_private.shift_entries (
      week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
      created_by,created_by_label,updated_by,updated_by_label
    ) values (
      p_week_start,p_person_id,nullif(trim(coalesce(p_role_name,'')),''),starts_utc,ends_utc,
      coalesce(p_break_minutes,0),nullif(trim(coalesce(p_note,'')),''),'manual',true,
      p_actor_id,p_actor_label,p_actor_id,p_actor_label
    ) returning * into shift_row;
    event_name := 'shift_created';
  else
    update atlas_private.shift_entries set
      person_id=p_person_id,
      role_name=nullif(trim(coalesce(p_role_name,'')),''),
      starts_at=starts_utc,
      ends_at=ends_utc,
      break_minutes=coalesce(p_break_minutes,0),
      note=nullif(trim(coalesce(p_note,'')),''),
      active=true,
      updated_by=p_actor_id,
      updated_by_label=p_actor_label
    where id=p_shift_id and week_start=p_week_start
    returning * into shift_row;
    if not found then raise exception 'Shift not found in the selected week'; end if;
    event_name := 'shift_updated';
  end if;

  update atlas_private.shift_weeks
  set has_unpublished_changes=true,status=case when status='archived' then 'draft' else status end
  where week_start=p_week_start;

  insert into atlas_private.shift_events (
    event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    event_name,p_week_start,shift_row.id,shift_row.person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('starts_at',shift_row.starts_at,'ends_at',shift_row.ends_at,'role_name',shift_row.role_name)
  );
  return to_jsonb(shift_row);
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 87
create or replace function atlas_private.shift_cancel(
  p_shift_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare shift_row atlas_private.shift_entries;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can remove shifts'; end if;
  update atlas_private.shift_entries
  set active=false,updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=p_shift_id and active=true
  returning * into shift_row;
  if not found then raise exception 'Shift not found'; end if;
  update atlas_private.shift_weeks set has_unpublished_changes=true where week_start=shift_row.week_start;
  insert into atlas_private.shift_events (
    event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'shift_cancelled',shift_row.week_start,shift_row.id,shift_row.person_id,
    p_actor_id,p_actor_label,p_actor_role,'{}'::jsonb
  );
  return to_jsonb(shift_row);
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 88
create or replace function atlas_private.shift_publish_week(
  p_week_start date,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  settings_row atlas_private.shift_settings;
  week_row atlas_private.shift_weeks;
  next_revision integer;
  shift_count integer;
  planned_hours numeric(10,2);
  shifts_json jsonb;
  publication_row atlas_private.shift_publications;
  overlap_count bigint;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish schedules'; end if;
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  week_row := atlas_private.shift_ensure_week(p_week_start,p_actor_id,p_actor_label);
  select count(*) into shift_count from atlas_private.shift_entries where week_start=p_week_start and active=true;
  if shift_count=0 then raise exception 'Add at least one shift before publishing'; end if;

  select count(*) into overlap_count
  from atlas_private.shift_entries first_shift
  join atlas_private.shift_entries second_shift
    on first_shift.person_id=second_shift.person_id
   and first_shift.id<second_shift.id
   and tstzrange(first_shift.starts_at,first_shift.ends_at,'[)') && tstzrange(second_shift.starts_at,second_shift.ends_at,'[)')
  where first_shift.week_start=p_week_start and second_shift.week_start=p_week_start
    and first_shift.active=true and second_shift.active=true;
  if overlap_count>0 then raise exception 'Resolve overlapping shifts before publishing'; end if;

  next_revision := week_row.revision+1;
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',shift.id,'week_start',shift.week_start,'person_id',shift.person_id,
      'person_name',person.display_name,'profile_id',person.profile_id,
      'login_enabled',person.login_enabled,'role_name',shift.role_name,
      'starts_at',shift.starts_at,'ends_at',shift.ends_at,
      'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'break_minutes',shift.break_minutes,'note',shift.note,'active',true,
      'publication_revision',next_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb),
    coalesce(round(sum((extract(epoch from (shift.ends_at-shift.starts_at))/3600)-(shift.break_minutes::numeric/60)),2),0)
  into shifts_json,planned_hours
  from atlas_private.shift_entries shift
  join atlas_private.shift_people person on person.id=shift.person_id
  where shift.week_start=p_week_start and shift.active=true;

  insert into atlas_private.shift_publications (
    week_start,revision,snapshot,shift_count,planned_hours,published_by,published_by_label
  ) values (
    p_week_start,next_revision,
    jsonb_build_object('week_start',p_week_start,'revision',next_revision,'shifts',shifts_json,'note',nullif(trim(coalesce(p_note,'')),'')),
    shift_count,planned_hours,p_actor_id,p_actor_label
  ) returning * into publication_row;

  update atlas_private.shift_weeks set
    status='published',revision=next_revision,has_unpublished_changes=false,
    note=nullif(trim(coalesce(p_note,'')),''),published_at=publication_row.published_at,
    published_by=p_actor_id,published_by_label=p_actor_label
  where week_start=p_week_start;

  update atlas_private.shift_entries
  set last_published_revision=next_revision
  where week_start=p_week_start and active=true;

  insert into atlas_private.shift_responses (
    shift_id,person_id,response,manager_status
  )
  select shift.id,shift.person_id,'pending','none'
  from atlas_private.shift_entries shift
  join atlas_private.shift_people person on person.id=shift.person_id
  where shift.week_start=p_week_start and shift.active=true
    and person.login_enabled=true and person.profile_id is not null
  on conflict (shift_id,person_id) do update set
    response='pending',note=null,responded_at=null,manager_status='none',manager_note=null,
    decided_by=null,decided_by_label=null,decided_at=null,updated_at=pg_catalog.now();

  system_body := 'Schedule published' || E'\n'
    || 'Week of ' || to_char(p_week_start,'DD Mon YYYY') || ' · ' || shift_count
    || ' shifts · ' || planned_hours || ' planned hours.' || E'\n'
    || 'Please review and confirm your assigned shifts.';
  begin
    perform atlas_private.team_messages_post_system(
      'announcements','shift-week-published:'||p_week_start::text||':'||next_revision::text,
      system_body,'shift',p_week_start::text,
      'Week of '||to_char(p_week_start,'DD Mon YYYY'),'shifts',
      jsonb_build_object('week_start',p_week_start,'revision',next_revision,'shift_count',shift_count,'planned_hours',planned_hours)
    );
  exception when others then null;
  end;

  insert into atlas_private.shift_events (
    event_type,week_start,actor_id,actor_label,actor_role,payload
  ) values (
    'week_published',p_week_start,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('revision',next_revision,'shift_count',shift_count,'planned_hours',planned_hours)
  );
  return to_jsonb(publication_row);
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 89
create or replace function atlas_private.shift_save_availability(
  p_person_id uuid,p_weekday smallint,p_available_from time,p_available_to time,
  p_unavailable boolean,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  person_row atlas_private.shift_people;
  availability_row atlas_private.shift_availability;
begin
  if p_weekday not between 0 and 6 then raise exception 'Weekday is invalid'; end if;
  select * into person_row from atlas_private.shift_people where id=p_person_id;
  if not found then raise exception 'Team member not found'; end if;
  if p_actor_role not in ('admin','manager') and person_row.profile_id<>p_actor_id then raise exception 'Staff may edit only their own availability'; end if;

  insert into atlas_private.shift_availability (
    person_id,weekday,available_from,available_to,unavailable,note,updated_by,updated_by_label
  ) values (
    p_person_id,p_weekday,
    case when coalesce(p_unavailable,false) then null else p_available_from end,
    case when coalesce(p_unavailable,false) then null else p_available_to end,
    coalesce(p_unavailable,false),nullif(trim(coalesce(p_note,'')),''),p_actor_id,p_actor_label
  )
  on conflict (person_id,weekday) do update set
    available_from=excluded.available_from,available_to=excluded.available_to,
    unavailable=excluded.unavailable,note=excluded.note,
    updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  returning * into availability_row;

  insert into atlas_private.shift_events (
    event_type,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'availability_updated',p_person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('weekday',p_weekday,'unavailable',availability_row.unavailable)
  );
  return to_jsonb(availability_row);
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 90
create or replace function atlas_private.shift_respond(
  p_shift_id uuid,p_response text,p_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  shift_row atlas_private.shift_entries;
  person_row atlas_private.shift_people;
  week_row atlas_private.shift_weeks;
  response_row atlas_private.shift_responses;
begin
  if p_response not in ('confirmed','change_requested','declined') then raise exception 'Shift response is invalid'; end if;
  if p_response<>'confirmed' and nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'A note is required when requesting a change or declining'; end if;
  select * into shift_row from atlas_private.shift_entries where id=p_shift_id and active=true;
  if not found then raise exception 'Shift not found'; end if;
  select * into person_row from atlas_private.shift_people where id=shift_row.person_id;
  if person_row.profile_id<>p_actor_id then raise exception 'You can respond only to your own shift'; end if;
  select * into week_row from atlas_private.shift_weeks where week_start=shift_row.week_start;
  if week_row.status<>'published' or shift_row.last_published_revision<>week_row.revision then raise exception 'This shift is not part of the latest published schedule'; end if;

  insert into atlas_private.shift_responses (
    shift_id,person_id,response,note,responded_at,manager_status
  ) values (
    shift_row.id,shift_row.person_id,p_response,nullif(trim(coalesce(p_note,'')),''),
    pg_catalog.now(),case when p_response='confirmed' then 'none' else 'open' end
  )
  on conflict (shift_id,person_id) do update set
    response=excluded.response,note=excluded.note,responded_at=excluded.responded_at,
    manager_status=excluded.manager_status,manager_note=null,decided_by=null,
    decided_by_label=null,decided_at=null,updated_at=pg_catalog.now()
  returning * into response_row;

  insert into atlas_private.shift_events (
    event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'shift_response_updated',shift_row.week_start,shift_row.id,shift_row.person_id,
    p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('response',p_response)
  );
  return to_jsonb(response_row);
end;
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 91
create or replace function public.atlas_shifts_sync_profiles(
  p_profiles jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns bigint language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_sync_profiles(p_profiles,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 92
create or replace function public.atlas_shifts_snapshot(
  p_week_start date,p_actor_id uuid,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_workspace_snapshot(p_week_start,p_actor_id,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 93
create or replace function public.atlas_shifts_create_person(
  p_display_name text,p_email text,p_default_role text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_person_create(p_display_name,p_email,p_default_role,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 94
create or replace function public.atlas_shifts_save_shift(
  p_shift_id uuid,p_week_start date,p_person_id uuid,p_role_name text,p_starts_local timestamp,
  p_ends_local timestamp,p_break_minutes integer,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_save(p_shift_id,p_week_start,p_person_id,p_role_name,p_starts_local,p_ends_local,p_break_minutes,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 95
create or replace function public.atlas_shifts_cancel_shift(
  p_shift_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_cancel(p_shift_id,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 96
create or replace function public.atlas_shifts_publish_week(
  p_week_start date,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_publish_week(p_week_start,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 97
create or replace function public.atlas_shifts_save_availability(
  p_person_id uuid,p_weekday smallint,p_available_from time,p_available_to time,p_unavailable boolean,
  p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_save_availability(p_person_id,p_weekday,p_available_from,p_available_to,p_unavailable,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 98
create or replace function public.atlas_shifts_respond(
  p_shift_id uuid,p_response text,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_respond(p_shift_id,p_response,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 99
revoke execute on function public.atlas_shifts_sync_profiles(jsonb,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 100
revoke execute on function public.atlas_shifts_snapshot(date,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 101
revoke execute on function public.atlas_shifts_create_person(text,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 102
revoke execute on function public.atlas_shifts_save_shift(uuid,date,uuid,text,timestamp,timestamp,integer,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 103
revoke execute on function public.atlas_shifts_cancel_shift(uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 104
revoke execute on function public.atlas_shifts_publish_week(date,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 105
revoke execute on function public.atlas_shifts_save_availability(uuid,smallint,time,time,boolean,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 106
revoke execute on function public.atlas_shifts_respond(uuid,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 107
grant execute on function public.atlas_shifts_sync_profiles(jsonb,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 108
grant execute on function public.atlas_shifts_snapshot(date,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 109
grant execute on function public.atlas_shifts_create_person(text,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 110
grant execute on function public.atlas_shifts_save_shift(uuid,date,uuid,text,timestamp,timestamp,integer,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 111
grant execute on function public.atlas_shifts_cancel_shift(uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 112
grant execute on function public.atlas_shifts_publish_week(date,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 113
grant execute on function public.atlas_shifts_save_availability(uuid,smallint,time,time,boolean,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 114
grant execute on function public.atlas_shifts_respond(uuid,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 115
comment on table atlas_private.shift_entries is 'Private Checkpoint F schedule drafts. Production public.shifts is not changed while live publish is disabled.';

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 116
comment on table atlas_private.shift_publications is 'Immutable team-visible weekly schedule snapshots and revision history.';

-- SOURCE supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql statement 117
comment on function public.atlas_shifts_snapshot(date,uuid,text) is 'Service-role-only Shifts workspace snapshot after production-profile authorization.';

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 0
-- Checkpoint F workflow completion: roster editing, week copy, time-off
-- decisions and manager resolution of shift response requests.

create or replace function atlas_private.shift_person_update(
  p_person_id uuid,
  p_display_name text,
  p_email text,
  p_default_role text,
  p_active boolean,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare person_row atlas_private.shift_people;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can update the shift roster'; end if;
  if nullif(trim(coalesce(p_display_name,'')),'') is null then raise exception 'Display name is required'; end if;
  update atlas_private.shift_people
  set display_name=trim(p_display_name),
      email=nullif(trim(coalesce(p_email,'')),''),
      default_role=nullif(trim(coalesce(p_default_role,'')),''),
      active=coalesce(p_active,active),
      updated_by=p_actor_id,
      updated_by_label=p_actor_label
  where id=p_person_id
  returning * into person_row;
  if not found then raise exception 'Roster person not found'; end if;
  insert into atlas_private.shift_events (event_type,person_id,actor_id,actor_label,actor_role,payload)
  values ('person_updated',person_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('display_name',person_row.display_name,'active',person_row.active,'default_role',person_row.default_role));
  return to_jsonb(person_row);
end;
$$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 1
create or replace function atlas_private.shift_copy_week(
  p_source_week date,
  p_target_week date,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare copied_count bigint;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can copy schedules'; end if;
  if extract(isodow from p_source_week)<>1 or extract(isodow from p_target_week)<>1 then raise exception 'Week dates must be Mondays'; end if;
  if p_source_week=p_target_week then raise exception 'Source and target weeks must differ'; end if;
  perform atlas_private.shift_ensure_week(p_target_week,p_actor_id,p_actor_label);
  if exists (select 1 from atlas_private.shift_entries where week_start=p_target_week and active=true) then
    raise exception 'The target week already contains shifts';
  end if;

  insert into atlas_private.shift_entries (
    week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select
    p_target_week,shift.person_id,shift.role_name,
    shift.starts_at+(p_target_week-p_source_week),
    shift.ends_at+(p_target_week-p_source_week),
    shift.break_minutes,shift.note,'copied',true,
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from atlas_private.shift_entries shift
  where shift.week_start=p_source_week and shift.active=true;
  get diagnostics copied_count=row_count;
  if copied_count=0 then raise exception 'The source week has no shifts to copy'; end if;

  update atlas_private.shift_weeks set has_unpublished_changes=true where week_start=p_target_week;
  insert into atlas_private.shift_events (event_type,week_start,actor_id,actor_label,actor_role,payload)
  values ('week_copied',p_target_week,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_week',p_source_week,'copied_count',copied_count));
  return jsonb_build_object('source_week',p_source_week,'target_week',p_target_week,'copied_count',copied_count);
end;
$$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 2
create or replace function atlas_private.shift_request_time_off(
  p_person_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_request_type text,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare person_row atlas_private.shift_people; request_row atlas_private.shift_time_off; initial_status text;
begin
  select * into person_row from atlas_private.shift_people where id=p_person_id;
  if not found then raise exception 'Team member not found'; end if;
  if p_actor_role not in ('admin','manager') and person_row.profile_id<>p_actor_id then
    raise exception 'Staff may request time off only for themselves';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on<p_starts_on then raise exception 'Time-off dates are invalid'; end if;
  if p_ends_on-p_starts_on>366 then raise exception 'Time-off request is too long'; end if;
  if p_request_type not in ('unavailable','vacation','sick','other') then raise exception 'Time-off type is invalid'; end if;
  initial_status := case when p_actor_role in ('admin','manager') then 'approved' else 'pending' end;

  insert into atlas_private.shift_time_off (
    person_id,starts_on,ends_on,request_type,status,note,requested_by,requested_by_label,
    decided_by,decided_by_label,decided_at
  ) values (
    p_person_id,p_starts_on,p_ends_on,p_request_type,initial_status,
    nullif(trim(coalesce(p_note,'')),''),p_actor_id,p_actor_label,
    case when initial_status='approved' then p_actor_id else null end,
    case when initial_status='approved' then p_actor_label else null end,
    case when initial_status='approved' then pg_catalog.now() else null end
  ) returning * into request_row;

  insert into atlas_private.shift_events (event_type,person_id,actor_id,actor_label,actor_role,payload)
  values ('time_off_requested',p_person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',request_row.id,'starts_on',p_starts_on,'ends_on',p_ends_on,'status',initial_status,'request_type',p_request_type));
  return to_jsonb(request_row);
end;
$$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 3
create or replace function atlas_private.shift_decide_time_off(
  p_request_id uuid,
  p_status text,
  p_manager_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare request_row atlas_private.shift_time_off;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can decide time-off requests'; end if;
  if p_status not in ('approved','rejected','cancelled') then raise exception 'Decision status is invalid'; end if;
  update atlas_private.shift_time_off
  set status=p_status,
      manager_note=nullif(trim(coalesce(p_manager_note,'')),''),
      decided_by=p_actor_id,
      decided_by_label=p_actor_label,
      decided_at=pg_catalog.now()
  where id=p_request_id and status='pending'
  returning * into request_row;
  if not found then raise exception 'Pending time-off request not found'; end if;
  insert into atlas_private.shift_events (event_type,person_id,actor_id,actor_label,actor_role,payload)
  values ('time_off_decided',request_row.person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',request_row.id,'status',p_status,'manager_note',p_manager_note));
  return to_jsonb(request_row);
end;
$$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 4
create or replace function atlas_private.shift_decide_response(
  p_shift_id uuid,
  p_person_id uuid,
  p_manager_status text,
  p_manager_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare response_row atlas_private.shift_responses; shift_row atlas_private.shift_entries;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can decide shift requests'; end if;
  if p_manager_status not in ('resolved','rejected') then raise exception 'Manager status is invalid'; end if;
  if nullif(trim(coalesce(p_manager_note,'')),'') is null then raise exception 'A manager note is required'; end if;
  update atlas_private.shift_responses
  set manager_status=p_manager_status,
      manager_note=trim(p_manager_note),
      decided_by=p_actor_id,
      decided_by_label=p_actor_label,
      decided_at=pg_catalog.now()
  where shift_id=p_shift_id and person_id=p_person_id and manager_status='open'
  returning * into response_row;
  if not found then raise exception 'Open shift request not found'; end if;
  select * into shift_row from atlas_private.shift_entries where id=p_shift_id;
  insert into atlas_private.shift_events (event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload)
  values ('shift_response_decided',shift_row.week_start,p_shift_id,p_person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('manager_status',p_manager_status,'manager_note',p_manager_note));
  return to_jsonb(response_row);
end;
$$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 5
create or replace function public.atlas_shifts_update_person(
  p_person_id uuid,p_display_name text,p_email text,p_default_role text,p_active boolean,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_person_update(p_person_id,p_display_name,p_email,p_default_role,p_active,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 6
create or replace function public.atlas_shifts_copy_week(
  p_source_week date,p_target_week date,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_copy_week(p_source_week,p_target_week,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 7
create or replace function public.atlas_shifts_request_time_off(
  p_person_id uuid,p_starts_on date,p_ends_on date,p_request_type text,p_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_request_time_off(p_person_id,p_starts_on,p_ends_on,p_request_type,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 8
create or replace function public.atlas_shifts_decide_time_off(
  p_request_id uuid,p_status text,p_manager_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_decide_time_off(p_request_id,p_status,p_manager_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 9
create or replace function public.atlas_shifts_decide_response(
  p_shift_id uuid,p_person_id uuid,p_manager_status text,p_manager_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_decide_response(p_shift_id,p_person_id,p_manager_status,p_manager_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 10
revoke execute on function public.atlas_shifts_update_person(uuid,text,text,text,boolean,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 11
revoke execute on function public.atlas_shifts_copy_week(date,date,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 12
revoke execute on function public.atlas_shifts_request_time_off(uuid,date,date,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 13
revoke execute on function public.atlas_shifts_decide_time_off(uuid,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 14
revoke execute on function public.atlas_shifts_decide_response(uuid,uuid,text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 15
grant execute on function public.atlas_shifts_update_person(uuid,text,text,text,boolean,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 16
grant execute on function public.atlas_shifts_copy_week(date,date,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 17
grant execute on function public.atlas_shifts_request_time_off(uuid,date,date,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 18
grant execute on function public.atlas_shifts_decide_time_off(uuid,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql statement 19
grant execute on function public.atlas_shifts_decide_response(uuid,uuid,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803201746_atlas_shifts_checkpoint_f_hardening.sql statement 0
-- Avoid writing a profile-sync audit event on every Shifts snapshot when the
-- production staff roster has not changed. Also cover the shift-event foreign
-- key path reported by the database advisor.

create index if not exists shift_events_shift_created_idx
  on atlas_private.shift_events(shift_id,created_at desc)
  where shift_id is not null;

-- SOURCE supabase/migrations/20260803201746_atlas_shifts_checkpoint_f_hardening.sql statement 1
create or replace function atlas_private.shift_sync_profiles(
  p_profiles jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns bigint
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  changed_count bigint := 0;
begin
  if jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))<>'array' then
    raise exception 'Profiles payload must be an array';
  end if;

  insert into atlas_private.shift_people (
    id,profile_id,display_name,email,default_role,active,login_enabled,source,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select
    profile.id,
    profile.id,
    coalesce(
      nullif(trim(profile.display_name),''),
      nullif(split_part(coalesce(profile.email,''),'@',1),''),
      'Team member'
    ),
    nullif(trim(profile.email),''),
    case profile.role
      when 'admin' then 'Manager'
      when 'manager' then 'Manager'
      when 'bartender' then 'Bartender'
      else 'Team'
    end,
    coalesce(profile.active,false),
    true,
    'profile',
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
    id uuid,email text,display_name text,role text,active boolean
  )
  where profile.id is not null
  on conflict (id) do update set
    profile_id=excluded.profile_id,
    display_name=excluded.display_name,
    email=excluded.email,
    default_role=excluded.default_role,
    active=excluded.active,
    login_enabled=true,
    source='profile',
    updated_by=p_actor_id,
    updated_by_label=p_actor_label,
    updated_at=pg_catalog.now()
  where (
    atlas_private.shift_people.profile_id,
    atlas_private.shift_people.display_name,
    atlas_private.shift_people.email,
    atlas_private.shift_people.default_role,
    atlas_private.shift_people.active,
    atlas_private.shift_people.login_enabled,
    atlas_private.shift_people.source
  ) is distinct from (
    excluded.profile_id,
    excluded.display_name,
    excluded.email,
    excluded.default_role,
    excluded.active,
    excluded.login_enabled,
    excluded.source
  );
  get diagnostics changed_count=row_count;

  if changed_count>0 then
    insert into atlas_private.shift_events (
      event_type,actor_id,actor_label,actor_role,payload
    ) values (
      'profiles_synced',p_actor_id,p_actor_label,p_actor_role,
      jsonb_build_object(
        'profile_count',jsonb_array_length(coalesce(p_profiles,'[]'::jsonb)),
        'changed_count',changed_count
      )
    );
  end if;

  return changed_count;
end;
$$;

-- SOURCE supabase/migrations/20260803202056_atlas_shifts_copy_week_interval_fix.sql statement 0
-- PostgreSQL dates subtract to an integer day count. Convert that count to an
-- interval before adding it to timestamptz shift boundaries.

create or replace function atlas_private.shift_copy_week(
  p_source_week date,
  p_target_week date,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  copied_count bigint;
  week_offset interval := (p_target_week-p_source_week) * interval '1 day';
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can copy schedules';
  end if;
  if extract(isodow from p_source_week)<>1 or extract(isodow from p_target_week)<>1 then
    raise exception 'Week dates must be Mondays';
  end if;
  if p_source_week=p_target_week then
    raise exception 'Source and target weeks must differ';
  end if;

  perform atlas_private.shift_ensure_week(p_target_week,p_actor_id,p_actor_label);
  if exists (
    select 1 from atlas_private.shift_entries
    where week_start=p_target_week and active=true
  ) then
    raise exception 'The target week already contains shifts';
  end if;

  insert into atlas_private.shift_entries (
    week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select
    p_target_week,
    shift.person_id,
    shift.role_name,
    shift.starts_at+week_offset,
    shift.ends_at+week_offset,
    shift.break_minutes,
    shift.note,
    'copied',
    true,
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from atlas_private.shift_entries shift
  where shift.week_start=p_source_week and shift.active=true;
  get diagnostics copied_count=row_count;

  if copied_count=0 then
    raise exception 'The source week has no shifts to copy';
  end if;

  update atlas_private.shift_weeks
  set has_unpublished_changes=true
  where week_start=p_target_week;

  insert into atlas_private.shift_events (
    event_type,week_start,actor_id,actor_label,actor_role,payload
  ) values (
    'week_copied',p_target_week,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_week',p_source_week,'copied_count',copied_count)
  );

  return jsonb_build_object(
    'source_week',p_source_week,
    'target_week',p_target_week,
    'copied_count',copied_count
  );
end;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 0
-- Checkpoint F.2: make the full month the primary schedule-planning and
-- publication unit while preserving weekly drill-down and staff confirmations.

create table if not exists atlas_private.shift_months (
  month_start date primary key,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  revision integer not null default 0 check (revision >= 0),
  has_unpublished_changes boolean not null default false,
  note text,
  published_at timestamptz,
  published_by uuid,
  published_by_label text,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_trunc('month',month_start)::date=month_start),
  check (note is null or char_length(note)<=3000)
);

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 1
create table if not exists atlas_private.shift_month_publications (
  id uuid primary key default gen_random_uuid(),
  month_start date not null references atlas_private.shift_months(month_start) on delete cascade,
  revision integer not null check (revision>0),
  snapshot jsonb not null,
  week_revisions jsonb not null default '[]'::jsonb,
  shift_count integer not null,
  planned_hours numeric(10,2) not null,
  published_by uuid,
  published_by_label text,
  published_at timestamptz not null default now(),
  unique (month_start,revision),
  check (jsonb_typeof(snapshot)='object'),
  check (jsonb_typeof(week_revisions)='array'),
  check (shift_count>=0),
  check (planned_hours>=0)
);

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 2
create index if not exists shift_month_publications_latest_idx
  on atlas_private.shift_month_publications(month_start,revision desc);

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 3
alter table atlas_private.shift_months enable row level security;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 4
alter table atlas_private.shift_month_publications enable row level security;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 5
drop policy if exists "service role manages shift months" on atlas_private.shift_months;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 6
create policy "service role manages shift months"
  on atlas_private.shift_months for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 7
drop policy if exists "service role manages shift month publications" on atlas_private.shift_month_publications;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 8
create policy "service role manages shift month publications"
  on atlas_private.shift_month_publications for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 9
revoke all on atlas_private.shift_months from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 10
revoke all on atlas_private.shift_month_publications from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 11
grant all on atlas_private.shift_months to service_role;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 12
grant all on atlas_private.shift_month_publications to service_role;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 13
drop trigger if exists shift_months_touch on atlas_private.shift_months;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 14
create trigger shift_months_touch before update on atlas_private.shift_months
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 15
alter table atlas_private.shift_events
  add column if not exists month_start date;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 16
create index if not exists shift_events_month_created_idx
  on atlas_private.shift_events(month_start,created_at desc)
  where month_start is not null;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 17
alter table atlas_private.shift_events
  drop constraint if exists shift_events_event_type_check;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 18
alter table atlas_private.shift_events
  add constraint shift_events_event_type_check
  check (event_type in (
    'profiles_synced','person_created','person_updated','shift_created','shift_updated','shift_cancelled',
    'week_copied','week_published','month_published','availability_updated','time_off_requested',
    'time_off_decided','shift_response_updated','shift_response_decided'
  ));

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 19
create or replace function atlas_private.shift_month_start(p_date date)
returns date
language sql
immutable
security invoker
set search_path=''
as $$
  select date_trunc('month',p_date)::date;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 20
create or replace function atlas_private.shift_ensure_month(
  p_month_start date,
  p_actor_id uuid,
  p_actor_label text
)
returns atlas_private.shift_months
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare month_row atlas_private.shift_months;
begin
  if p_month_start is null or date_trunc('month',p_month_start)::date<>p_month_start then
    raise exception 'Month start must be the first day of a month';
  end if;

  insert into atlas_private.shift_months (
    month_start,created_by,created_by_label
  ) values (
    p_month_start,p_actor_id,p_actor_label
  )
  on conflict (month_start) do nothing;

  select * into month_row
  from atlas_private.shift_months
  where month_start=p_month_start;
  return month_row;
end;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 21
create or replace function atlas_private.shift_mark_month_unpublished()
returns trigger
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  timezone_name text;
  old_month date;
  new_month date;
  actor_id uuid;
  actor_label text;
  operational_change boolean := true;
begin
  select timezone into timezone_name
  from atlas_private.shift_settings
  where setting_key='va';
  timezone_name := coalesce(timezone_name,'Atlantic/Reykjavik');

  if tg_op='UPDATE' then
    operational_change := (
      old.week_start,old.person_id,old.role_name,old.starts_at,old.ends_at,
      old.break_minutes,old.note,old.active
    ) is distinct from (
      new.week_start,new.person_id,new.role_name,new.starts_at,new.ends_at,
      new.break_minutes,new.note,new.active
    );
    if not operational_change then return new; end if;
    old_month := date_trunc('month',old.starts_at at time zone timezone_name)::date;
  end if;

  new_month := date_trunc('month',new.starts_at at time zone timezone_name)::date;
  actor_id := coalesce(new.updated_by,new.created_by);
  actor_label := coalesce(new.updated_by_label,new.created_by_label);

  insert into atlas_private.shift_months (
    month_start,status,has_unpublished_changes,created_by,created_by_label
  ) values (
    new_month,'draft',true,actor_id,actor_label
  )
  on conflict (month_start) do update set
    has_unpublished_changes=true,
    status=case when atlas_private.shift_months.status='archived' then 'draft' else atlas_private.shift_months.status end,
    updated_at=pg_catalog.now();

  if old_month is not null and old_month<>new_month then
    insert into atlas_private.shift_months (
      month_start,status,has_unpublished_changes,created_by,created_by_label
    ) values (
      old_month,'draft',true,actor_id,actor_label
    )
    on conflict (month_start) do update set
      has_unpublished_changes=true,
      status=case when atlas_private.shift_months.status='archived' then 'draft' else atlas_private.shift_months.status end,
      updated_at=pg_catalog.now();
  end if;

  return new;
end;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 22
drop trigger if exists shift_entries_mark_month_unpublished on atlas_private.shift_entries;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 23
create trigger shift_entries_mark_month_unpublished
  after insert or update of week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,active
  on atlas_private.shift_entries
  for each row execute function atlas_private.shift_mark_month_unpublished();

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 24
create or replace function atlas_private.shift_save(
  p_shift_id uuid,
  p_week_start date,
  p_person_id uuid,
  p_role_name text,
  p_starts_local timestamp,
  p_ends_local timestamp,
  p_break_minutes integer,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.shift_settings;
  shift_row atlas_private.shift_entries;
  previous_row atlas_private.shift_entries;
  starts_utc timestamptz;
  ends_utc timestamptz;
  event_name text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can create or edit shifts'; end if;
  perform atlas_private.shift_ensure_week(p_week_start,p_actor_id,p_actor_label);
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  if not exists (select 1 from atlas_private.shift_people where id=p_person_id and active=true) then
    raise exception 'The selected team member is inactive or missing';
  end if;
  if p_starts_local is null or p_ends_local is null then raise exception 'Start and end times are required'; end if;
  if atlas_private.shift_normalize_week(p_starts_local::date)<>p_week_start then
    raise exception 'Shift start is outside the selected week';
  end if;
  if p_ends_local<=p_starts_local then raise exception 'Shift end must be after shift start'; end if;
  if p_ends_local-p_starts_local>interval '24 hours' then raise exception 'A shift cannot exceed 24 hours'; end if;
  if coalesce(p_break_minutes,0)<0
     or coalesce(p_break_minutes,0)>=extract(epoch from (p_ends_local-p_starts_local))/60 then
    raise exception 'Break duration is invalid';
  end if;

  starts_utc := p_starts_local at time zone settings_row.timezone;
  ends_utc := p_ends_local at time zone settings_row.timezone;

  if p_shift_id is null then
    insert into atlas_private.shift_entries (
      week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
      created_by,created_by_label,updated_by,updated_by_label
    ) values (
      p_week_start,p_person_id,nullif(trim(coalesce(p_role_name,'')),''),starts_utc,ends_utc,
      coalesce(p_break_minutes,0),nullif(trim(coalesce(p_note,'')),''),'manual',true,
      p_actor_id,p_actor_label,p_actor_id,p_actor_label
    ) returning * into shift_row;
    event_name := 'shift_created';
  else
    select * into previous_row
    from atlas_private.shift_entries
    where id=p_shift_id
    for update;
    if not found then raise exception 'Shift not found'; end if;

    update atlas_private.shift_entries
    set week_start=p_week_start,
        person_id=p_person_id,
        role_name=nullif(trim(coalesce(p_role_name,'')),''),
        starts_at=starts_utc,
        ends_at=ends_utc,
        break_minutes=coalesce(p_break_minutes,0),
        note=nullif(trim(coalesce(p_note,'')),''),
        active=true,
        updated_by=p_actor_id,
        updated_by_label=p_actor_label
    where id=p_shift_id
    returning * into shift_row;
    event_name := 'shift_updated';

    if previous_row.week_start<>p_week_start then
      update atlas_private.shift_weeks
      set has_unpublished_changes=true
      where week_start=previous_row.week_start;
    end if;
  end if;

  update atlas_private.shift_weeks
  set has_unpublished_changes=true,
      status=case when status='archived' then 'draft' else status end
  where week_start=p_week_start;

  insert into atlas_private.shift_events (
    event_type,week_start,month_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    event_name,p_week_start,atlas_private.shift_month_start(p_starts_local::date),
    shift_row.id,shift_row.person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'previous_week_start',previous_row.week_start,
      'starts_at',shift_row.starts_at,
      'ends_at',shift_row.ends_at,
      'role_name',shift_row.role_name,
      'break_minutes',shift_row.break_minutes
    )
  );
  return to_jsonb(shift_row);
end;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 25
create or replace function atlas_private.shift_month_snapshot(
  p_month_start date,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.shift_settings;
  month_row atlas_private.shift_months;
  publication_row atlas_private.shift_month_publications;
  is_manager boolean := p_actor_role in ('admin','manager');
  actor_person_id uuid;
  month_end date;
  grid_start date;
  grid_end date;
  people_json jsonb := '[]'::jsonb;
  shifts_json jsonb := '[]'::jsonb;
  availability_json jsonb := '[]'::jsonb;
  time_off_json jsonb := '[]'::jsonb;
  responses_json jsonb := '[]'::jsonb;
  weeks_json jsonb := '[]'::jsonb;
  events_json jsonb := '[]'::jsonb;
begin
  if p_month_start is null or date_trunc('month',p_month_start)::date<>p_month_start then
    raise exception 'Month start must be the first day of a month';
  end if;

  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  month_row := atlas_private.shift_ensure_month(p_month_start,p_actor_id,null);
  month_end := (p_month_start+interval '1 month - 1 day')::date;
  grid_start := atlas_private.shift_normalize_week(p_month_start);
  grid_end := atlas_private.shift_normalize_week(month_end);
  select id into actor_person_id from atlas_private.shift_people where profile_id=p_actor_id limit 1;

  select * into publication_row
  from atlas_private.shift_month_publications
  where month_start=p_month_start
  order by revision desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',person.id,
    'profile_id',person.profile_id,
    'display_name',person.display_name,
    'email',person.email,
    'default_role',person.default_role,
    'active',person.active,
    'login_enabled',person.login_enabled,
    'source',person.source,
    'can_edit_availability',(is_manager or person.profile_id=p_actor_id)
  ) order by person.active desc,person.display_name),'[]'::jsonb)
  into people_json
  from atlas_private.shift_people person
  where is_manager or person.active=true or person.profile_id=p_actor_id;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',shift.id,
      'week_start',shift.week_start,
      'person_id',shift.person_id,
      'person_name',person.display_name,
      'profile_id',person.profile_id,
      'login_enabled',person.login_enabled,
      'role_name',shift.role_name,
      'starts_at',shift.starts_at,
      'ends_at',shift.ends_at,
      'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'break_minutes',shift.break_minutes,
      'note',shift.note,
      'source',shift.source,
      'active',shift.active,
      'updated_at',shift.updated_at,
      'last_published_revision',shift.last_published_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb)
    into shifts_json
    from atlas_private.shift_entries shift
    join atlas_private.shift_people person on person.id=shift.person_id
    where shift.active=true
      and (shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end;
  elsif publication_row.id is not null then
    shifts_json := coalesce(publication_row.snapshot->'shifts','[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',availability.id,
    'person_id',availability.person_id,
    'weekday',availability.weekday,
    'available_from',availability.available_from,
    'available_to',availability.available_to,
    'unavailable',availability.unavailable,
    'note',availability.note,
    'updated_at',availability.updated_at
  ) order by availability.person_id,availability.weekday),'[]'::jsonb)
  into availability_json
  from atlas_private.shift_availability availability
  join atlas_private.shift_people person on person.id=availability.person_id
  where is_manager or person.profile_id=p_actor_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',request.id,
    'person_id',request.person_id,
    'person_name',person.display_name,
    'starts_on',request.starts_on,
    'ends_on',request.ends_on,
    'request_type',request.request_type,
    'status',request.status,
    'note',request.note,
    'manager_note',case when is_manager then request.manager_note else null end,
    'requested_by_label',request.requested_by_label,
    'decided_by_label',case when is_manager then request.decided_by_label else null end,
    'created_at',request.created_at,
    'updated_at',request.updated_at
  ) order by request.starts_on,person.display_name),'[]'::jsonb)
  into time_off_json
  from atlas_private.shift_time_off request
  join atlas_private.shift_people person on person.id=request.person_id
  where request.ends_on>=p_month_start
    and request.starts_on<=month_end
    and (is_manager or person.profile_id=p_actor_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id',response.shift_id,
    'person_id',response.person_id,
    'response',response.response,
    'note',response.note,
    'responded_at',response.responded_at,
    'manager_status',case when is_manager then response.manager_status else null end,
    'manager_note',case when is_manager then response.manager_note else null end,
    'decided_by_label',case when is_manager then response.decided_by_label else null end,
    'decided_at',case when is_manager then response.decided_at else null end,
    'updated_at',response.updated_at
  ) order by response.updated_at desc),'[]'::jsonb)
  into responses_json
  from atlas_private.shift_responses response
  join atlas_private.shift_entries shift on shift.id=response.shift_id
  join atlas_private.shift_people person on person.id=response.person_id
  where (shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end
    and (is_manager or person.profile_id=p_actor_id);

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'week_start',series.week_start,
      'status',coalesce(week.status,'draft'),
      'revision',coalesce(week.revision,0),
      'has_unpublished_changes',coalesce(week.has_unpublished_changes,false),
      'published_at',week.published_at,
      'published_by_label',week.published_by_label,
      'latest_publication',case when publication.id is null then null else jsonb_build_object(
        'id',publication.id,
        'revision',publication.revision,
        'shift_count',publication.shift_count,
        'planned_hours',publication.planned_hours,
        'published_at',publication.published_at,
        'published_by_label',publication.published_by_label
      ) end
    ) order by series.week_start),'[]'::jsonb)
    into weeks_json
    from (
      select generate_series(grid_start,grid_end,interval '7 days')::date as week_start
    ) series
    left join atlas_private.shift_weeks week on week.week_start=series.week_start
    left join lateral (
      select * from atlas_private.shift_publications publication
      where publication.week_start=series.week_start
      order by publication.revision desc
      limit 1
    ) publication on true;
  elsif publication_row.id is not null then
    weeks_json := coalesce(publication_row.week_revisions,'[]'::jsonb);
  end if;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,
      'event_type',event.event_type,
      'month_start',event.month_start,
      'week_start',event.week_start,
      'shift_id',event.shift_id,
      'person_id',event.person_id,
      'actor_label',event.actor_label,
      'actor_role',event.actor_role,
      'payload',event.payload,
      'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into events_json
    from (
      select * from atlas_private.shift_events
      where month_start=p_month_start
         or week_start between grid_start and grid_end
      order by created_at desc
      limit 120
    ) event;
  end if;

  return jsonb_build_object(
    'version','atlas-shifts-month/0.1.0',
    'generated_at',pg_catalog.now(),
    'venue_date',(pg_catalog.now() at time zone settings_row.timezone)::date,
    'settings',jsonb_build_object(
      'timezone',settings_row.timezone,
      'live_publish_enabled',settings_row.live_publish_enabled,
      'confirmation_required',settings_row.confirmation_required,
      'metadata',settings_row.metadata
    ),
    'month',jsonb_build_object(
      'month_start',month_row.month_start,
      'month_end',month_end,
      'status',case when is_manager then month_row.status when publication_row.id is not null then 'published' else 'draft' end,
      'revision',case when is_manager then month_row.revision else coalesce(publication_row.revision,0) end,
      'has_unpublished_changes',case when is_manager then month_row.has_unpublished_changes else false end,
      'note',case when is_manager then month_row.note else publication_row.snapshot->>'note' end,
      'published_at',coalesce(publication_row.published_at,month_row.published_at),
      'published_by_label',coalesce(publication_row.published_by_label,month_row.published_by_label),
      'latest_publication',case when publication_row.id is null then null else jsonb_build_object(
        'id',publication_row.id,
        'revision',publication_row.revision,
        'shift_count',publication_row.shift_count,
        'planned_hours',publication_row.planned_hours,
        'published_at',publication_row.published_at,
        'published_by_label',publication_row.published_by_label
      ) end
    ),
    'people',people_json,
    'shifts',shifts_json,
    'availability',availability_json,
    'time_off',time_off_json,
    'responses',responses_json,
    'weeks',weeks_json,
    'events',events_json,
    'actor_person_id',actor_person_id,
    'permissions',jsonb_build_object(
      'can_manage_schedule',is_manager,
      'can_publish_month',is_manager,
      'can_respond_to_shifts',(actor_person_id is not null)
    ),
    'trust',jsonb_build_object(
      'planning_environment','isolated_branch',
      'production_shift_sync_enabled',false,
      'month_publish_to_team_enabled',true,
      'staff_visibility','latest_published_month_revision',
      'direct_browser_table_access',false,
      'audit_history_preserved',true
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 26
-- This initial definition is intentionally replaced by the following migration,
-- which also republishes empty affected weeks so deletions are visible in weekly
-- staff views. Keeping the function here makes this migration independently valid.
create or replace function atlas_private.shift_publish_month(
  p_month_start date,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
begin
  raise exception 'Complete-month publishing requires migration 20260803225245';
end;
$$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 27
create or replace function public.atlas_shifts_month_snapshot(
  p_month_start date,p_actor_id uuid,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$ select atlas_private.shift_month_snapshot(p_month_start,p_actor_id,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 28
create or replace function public.atlas_shifts_publish_month(
  p_month_start date,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$ select atlas_private.shift_publish_month(p_month_start,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 29
revoke execute on function public.atlas_shifts_month_snapshot(date,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 30
revoke execute on function public.atlas_shifts_publish_month(date,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 31
grant execute on function public.atlas_shifts_month_snapshot(date,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 32
grant execute on function public.atlas_shifts_publish_month(date,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 33
comment on table atlas_private.shift_months is 'Private manager month-plan state. Staff visibility is controlled by immutable month publications.';

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 34
comment on table atlas_private.shift_month_publications is 'Immutable monthly schedule revisions published to active staff.';

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 35
comment on function public.atlas_shifts_month_snapshot(date,uuid,text) is 'Service-role-only monthly Shifts snapshot: managers receive drafts, staff receive only the latest published month revision.';

-- SOURCE supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql statement 36
comment on function public.atlas_shifts_publish_month(date,text,uuid,text,text) is 'Service-role-only atomic month publication that also refreshes team-visible weekly revisions.';

-- SOURCE supabase/migrations/20260803225245_atlas_shifts_month_publish_complete_weeks.sql statement 0
-- Publish every week touched by a month, including an empty week after a shift
-- is removed. This keeps staff month and weekly views consistent after a monthly
-- revision while preserving adjacent-month dates in each weekly snapshot.

create or replace function atlas_private.shift_publish_month(
  p_month_start date,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.shift_settings;
  month_row atlas_private.shift_months;
  publication_row atlas_private.shift_month_publications;
  month_end date;
  grid_start date;
  grid_end date;
  next_month_revision integer;
  month_shift_count integer;
  month_planned_hours numeric(10,2);
  month_shifts_json jsonb;
  week_revisions_json jsonb := '[]'::jsonb;
  week_start_value date;
  week_row atlas_private.shift_weeks;
  week_publication atlas_private.shift_publications;
  week_revision integer;
  week_shift_count integer;
  week_planned_hours numeric(10,2);
  week_shifts_json jsonb;
  overlap_count bigint;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can publish monthly schedules';
  end if;
  if p_month_start is null or date_trunc('month',p_month_start)::date<>p_month_start then
    raise exception 'Month start must be the first day of a month';
  end if;

  select * into settings_row
  from atlas_private.shift_settings
  where setting_key='va';

  month_row := atlas_private.shift_ensure_month(p_month_start,p_actor_id,p_actor_label);
  month_end := (p_month_start+interval '1 month - 1 day')::date;
  grid_start := atlas_private.shift_normalize_week(p_month_start);
  grid_end := atlas_private.shift_normalize_week(month_end);

  select count(*) into month_shift_count
  from atlas_private.shift_entries shift
  where shift.active=true
    and (shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end;

  if month_shift_count=0 then
    raise exception 'Add at least one shift before publishing the month';
  end if;

  select count(*) into overlap_count
  from atlas_private.shift_entries first_shift
  join atlas_private.shift_entries second_shift
    on first_shift.person_id=second_shift.person_id
   and first_shift.id<second_shift.id
   and tstzrange(first_shift.starts_at,first_shift.ends_at,'[)')
       && tstzrange(second_shift.starts_at,second_shift.ends_at,'[)')
  where first_shift.active=true
    and second_shift.active=true
    and (first_shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end
    and (second_shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end;

  if overlap_count>0 then
    raise exception 'Resolve overlapping shifts before publishing the month';
  end if;

  next_month_revision := month_row.revision+1;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',shift.id,
      'week_start',shift.week_start,
      'person_id',shift.person_id,
      'person_name',person.display_name,
      'profile_id',person.profile_id,
      'login_enabled',person.login_enabled,
      'role_name',shift.role_name,
      'starts_at',shift.starts_at,
      'ends_at',shift.ends_at,
      'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'break_minutes',shift.break_minutes,
      'note',shift.note,
      'source',shift.source,
      'active',true,
      'month_publication_revision',next_month_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb),
    coalesce(round(sum(
      (extract(epoch from (shift.ends_at-shift.starts_at))/3600)
      -(shift.break_minutes::numeric/60)
    ),2),0)
  into month_shifts_json,month_planned_hours
  from atlas_private.shift_entries shift
  join atlas_private.shift_people person on person.id=shift.person_id
  where shift.active=true
    and (shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end;

  for week_start_value in
    select generate_series(grid_start,grid_end,interval '7 days')::date
  loop
    week_row := atlas_private.shift_ensure_week(week_start_value,p_actor_id,p_actor_label);
    week_revision := week_row.revision+1;

    select count(*) into overlap_count
    from atlas_private.shift_entries first_shift
    join atlas_private.shift_entries second_shift
      on first_shift.person_id=second_shift.person_id
     and first_shift.id<second_shift.id
     and tstzrange(first_shift.starts_at,first_shift.ends_at,'[)')
         && tstzrange(second_shift.starts_at,second_shift.ends_at,'[)')
    where first_shift.week_start=week_start_value
      and second_shift.week_start=week_start_value
      and first_shift.active=true
      and second_shift.active=true;

    if overlap_count>0 then
      raise exception 'Resolve overlapping shifts in the week of % before publishing the month',week_start_value;
    end if;

    select count(*) into week_shift_count
    from atlas_private.shift_entries
    where week_start=week_start_value and active=true;

    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id',shift.id,
        'week_start',shift.week_start,
        'person_id',shift.person_id,
        'person_name',person.display_name,
        'profile_id',person.profile_id,
        'login_enabled',person.login_enabled,
        'role_name',shift.role_name,
        'starts_at',shift.starts_at,
        'ends_at',shift.ends_at,
        'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
        'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
        'break_minutes',shift.break_minutes,
        'note',shift.note,
        'source',shift.source,
        'active',true,
        'publication_revision',week_revision,
        'month_publication_revision',next_month_revision
      ) order by shift.starts_at,person.display_name),'[]'::jsonb),
      coalesce(round(sum(
        (extract(epoch from (shift.ends_at-shift.starts_at))/3600)
        -(shift.break_minutes::numeric/60)
      ),2),0)
    into week_shifts_json,week_planned_hours
    from atlas_private.shift_entries shift
    join atlas_private.shift_people person on person.id=shift.person_id
    where shift.week_start=week_start_value and shift.active=true;

    insert into atlas_private.shift_publications (
      week_start,revision,snapshot,shift_count,planned_hours,published_by,published_by_label
    ) values (
      week_start_value,week_revision,
      jsonb_build_object(
        'week_start',week_start_value,
        'revision',week_revision,
        'month_start',p_month_start,
        'month_revision',next_month_revision,
        'shifts',week_shifts_json,
        'note',nullif(trim(coalesce(p_note,'')),'')
      ),
      week_shift_count,week_planned_hours,p_actor_id,p_actor_label
    ) returning * into week_publication;

    update atlas_private.shift_weeks
    set status='published',
        revision=week_revision,
        has_unpublished_changes=false,
        note=nullif(trim(coalesce(p_note,'')),''),
        published_at=week_publication.published_at,
        published_by=p_actor_id,
        published_by_label=p_actor_label
    where week_start=week_start_value;

    update atlas_private.shift_entries
    set last_published_revision=week_revision
    where week_start=week_start_value and active=true;

    delete from atlas_private.shift_responses response
    using atlas_private.shift_entries shift
    where response.shift_id=shift.id
      and shift.week_start=week_start_value
      and (
        shift.active=false
        or shift.last_published_revision is distinct from week_revision
      );

    insert into atlas_private.shift_responses (
      shift_id,person_id,response,manager_status
    )
    select shift.id,shift.person_id,'pending','none'
    from atlas_private.shift_entries shift
    join atlas_private.shift_people person on person.id=shift.person_id
    where shift.week_start=week_start_value
      and shift.active=true
      and person.login_enabled=true
      and person.profile_id is not null
    on conflict (shift_id,person_id) do update set
      response='pending',note=null,responded_at=null,manager_status='none',manager_note=null,
      decided_by=null,decided_by_label=null,decided_at=null,updated_at=pg_catalog.now();

    week_revisions_json := week_revisions_json || jsonb_build_array(jsonb_build_object(
      'week_start',week_start_value,
      'status','published',
      'revision',week_revision,
      'has_unpublished_changes',false,
      'shift_count',week_shift_count,
      'planned_hours',week_planned_hours,
      'published_at',week_publication.published_at,
      'published_by_label',p_actor_label,
      'latest_publication',jsonb_build_object(
        'id',week_publication.id,
        'revision',week_revision,
        'shift_count',week_shift_count,
        'planned_hours',week_planned_hours,
        'published_at',week_publication.published_at,
        'published_by_label',p_actor_label
      )
    ));
  end loop;

  insert into atlas_private.shift_month_publications (
    month_start,revision,snapshot,week_revisions,shift_count,planned_hours,published_by,published_by_label
  ) values (
    p_month_start,next_month_revision,
    jsonb_build_object(
      'month_start',p_month_start,
      'month_end',month_end,
      'revision',next_month_revision,
      'shifts',month_shifts_json,
      'note',nullif(trim(coalesce(p_note,'')),'')
    ),
    week_revisions_json,month_shift_count,month_planned_hours,p_actor_id,p_actor_label
  ) returning * into publication_row;

  update atlas_private.shift_months
  set status='published',revision=next_month_revision,has_unpublished_changes=false,
      note=nullif(trim(coalesce(p_note,'')),''),published_at=publication_row.published_at,
      published_by=p_actor_id,published_by_label=p_actor_label
  where month_start=p_month_start;

  system_body := 'Monthly schedule published' || E'\n'
    || to_char(p_month_start,'FMMonth YYYY') || ' · '
    || month_shift_count || ' shifts · ' || month_planned_hours || ' planned hours.' || E'\n'
    || 'Please review the full month and confirm your assigned shifts.';

  begin
    perform atlas_private.team_messages_post_system(
      'announcements',
      'shift-month-published:'||p_month_start::text||':'||next_month_revision::text,
      system_body,
      'shift',
      p_month_start::text,
      to_char(p_month_start,'FMMonth YYYY')||' schedule',
      'shifts',
      jsonb_build_object(
        'month_start',p_month_start,
        'revision',next_month_revision,
        'shift_count',month_shift_count,
        'planned_hours',month_planned_hours,
        'week_revisions',week_revisions_json
      )
    );
  exception when others then
    null;
  end;

  insert into atlas_private.shift_events (
    event_type,month_start,actor_id,actor_label,actor_role,payload
  ) values (
    'month_published',p_month_start,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'revision',next_month_revision,
      'shift_count',month_shift_count,
      'planned_hours',month_planned_hours,
      'week_revisions',week_revisions_json
    )
  );

  return jsonb_build_object(
    'publication',to_jsonb(publication_row),
    'week_revisions',week_revisions_json
  );
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 0
-- Checkpoint G — Knowledge
-- Private, role-aware, versioned staff guidance. Source documents and source
-- URLs are deliberately not seeded in this public repository migration.

create table if not exists atlas_private.knowledge_settings (
  setting_key text primary key,
  google_drive_connection_status text not null default 'not_connected'
    check (google_drive_connection_status in ('not_connected','waiting_authorization','connected','degraded','expired')),
  automatic_drive_sync_enabled boolean not null default false,
  browser_notifications_enabled boolean not null default false,
  staff_source_urls_visible boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 1
create table if not exists atlas_private.knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  category_key text not null unique,
  name text not null,
  description text,
  icon text not null default 'book-open',
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (category_key ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  check (char_length(name) between 1 and 100),
  check (description is null or char_length(description)<=1000)
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 2
create table if not exists atlas_private.knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  article_key text not null unique,
  category_id uuid not null references atlas_private.knowledge_categories(id) on delete restrict,
  article_type text not null default 'reference'
    check (article_type in ('policy','sop','checklist','training','reference','live_resource')),
  status text not null default 'draft'
    check (status in ('draft','published','retired')),
  required boolean not null default false,
  target_roles text[] not null default array['all']::text[],
  live_route text,
  current_version integer not null default 0,
  current_version_id uuid,
  draft_version_id uuid,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (article_key ~ '^[a-z0-9][a-z0-9-]{1,119}$'),
  check (cardinality(target_roles)>0),
  check (target_roles <@ array['all','admin','manager','bartender','viewer']::text[]),
  check (live_route is null or char_length(live_route)<=160),
  check (current_version>=0)
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 3
create table if not exists atlas_private.knowledge_article_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  version_number integer not null check (version_number>0),
  state text not null default 'draft' check (state in ('draft','published','superseded')),
  title text not null,
  summary text,
  content text not null,
  content_format text not null default 'markdown' check (content_format in ('markdown','plain_text')),
  change_note text,
  created_by uuid,
  created_by_label text,
  published_at timestamptz,
  published_by uuid,
  published_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (article_id,version_number),
  check (char_length(title) between 1 and 220),
  check (summary is null or char_length(summary)<=3000),
  check (char_length(content) between 1 and 250000),
  check (change_note is null or char_length(change_note)<=3000),
  check ((state='published' and published_at is not null) or state<>'published')
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 4
alter table atlas_private.knowledge_articles
  drop constraint if exists knowledge_articles_current_version_id_fkey;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 5
alter table atlas_private.knowledge_articles
  add constraint knowledge_articles_current_version_id_fkey
  foreign key (current_version_id) references atlas_private.knowledge_article_versions(id) on delete set null;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 6
alter table atlas_private.knowledge_articles
  drop constraint if exists knowledge_articles_draft_version_id_fkey;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 7
alter table atlas_private.knowledge_articles
  add constraint knowledge_articles_draft_version_id_fkey
  foreign key (draft_version_id) references atlas_private.knowledge_article_versions(id) on delete set null;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 8
create unique index if not exists knowledge_one_draft_per_article_uidx
  on atlas_private.knowledge_article_versions(article_id) where state='draft';

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 9
create unique index if not exists knowledge_one_current_published_uidx
  on atlas_private.knowledge_article_versions(article_id) where state='published';

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 10
create index if not exists knowledge_articles_category_status_idx
  on atlas_private.knowledge_articles(category_id,status,required);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 11
create index if not exists knowledge_versions_article_state_idx
  on atlas_private.knowledge_article_versions(article_id,state,version_number desc);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 12
create table if not exists atlas_private.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  source_type text not null
    check (source_type in ('google_drive','atlas_module','sprint3_import','manual','external')),
  source_label text not null,
  source_reference text,
  source_url text,
  source_version text,
  connection_status text not null default 'manual_reference'
    check (connection_status in ('manual_reference','not_connected','current','stale','error')),
  visible_to_staff boolean not null default false,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(source_label) between 1 and 220),
  check (source_reference is null or char_length(source_reference)<=1000),
  check (source_url is null or char_length(source_url)<=3000),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 13
create index if not exists knowledge_sources_article_idx
  on atlas_private.knowledge_sources(article_id,source_type,updated_at desc);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 14
create table if not exists atlas_private.knowledge_task_links (
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  onboarding_task_id uuid not null,
  required_for_task boolean not null default true,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  primary key (article_id,onboarding_task_id)
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 15
create index if not exists knowledge_task_links_task_idx
  on atlas_private.knowledge_task_links(onboarding_task_id,article_id);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 16
create table if not exists atlas_private.knowledge_reads (
  version_id uuid not null references atlas_private.knowledge_article_versions(id) on delete cascade,
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  user_id uuid not null,
  user_label text not null,
  first_read_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  read_count integer not null default 1 check (read_count>0),
  primary key (version_id,user_id)
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 17
create index if not exists knowledge_reads_user_idx
  on atlas_private.knowledge_reads(user_id,last_read_at desc);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 18
create table if not exists atlas_private.knowledge_acknowledgements (
  version_id uuid not null references atlas_private.knowledge_article_versions(id) on delete cascade,
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  user_id uuid not null,
  user_label text not null,
  user_role text not null,
  acknowledged_at timestamptz not null default now(),
  primary key (version_id,user_id)
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 19
create index if not exists knowledge_acknowledgements_user_idx
  on atlas_private.knowledge_acknowledgements(user_id,acknowledged_at desc);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 20
create index if not exists knowledge_acknowledgements_article_idx
  on atlas_private.knowledge_acknowledgements(article_id,version_id);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 21
create table if not exists atlas_private.knowledge_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'article_created','draft_saved','version_published','article_retired',
    'article_read','article_acknowledged','source_saved','source_removed','task_links_updated'
  )),
  article_id uuid references atlas_private.knowledge_articles(id) on delete set null,
  version_id uuid references atlas_private.knowledge_article_versions(id) on delete set null,
  source_id uuid references atlas_private.knowledge_sources(id) on delete set null,
  user_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 22
create index if not exists knowledge_events_article_created_idx
  on atlas_private.knowledge_events(article_id,created_at desc) where article_id is not null;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 23
create index if not exists knowledge_events_created_idx
  on atlas_private.knowledge_events(created_at desc);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 24
alter table atlas_private.knowledge_settings enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 25
alter table atlas_private.knowledge_categories enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 26
alter table atlas_private.knowledge_articles enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 27
alter table atlas_private.knowledge_article_versions enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 28
alter table atlas_private.knowledge_sources enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 29
alter table atlas_private.knowledge_task_links enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 30
alter table atlas_private.knowledge_reads enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 31
alter table atlas_private.knowledge_acknowledgements enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 32
alter table atlas_private.knowledge_events enable row level security;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 33
drop policy if exists "service role manages knowledge settings" on atlas_private.knowledge_settings;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 34
create policy "service role manages knowledge settings" on atlas_private.knowledge_settings for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 35
drop policy if exists "service role manages knowledge categories" on atlas_private.knowledge_categories;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 36
create policy "service role manages knowledge categories" on atlas_private.knowledge_categories for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 37
drop policy if exists "service role manages knowledge articles" on atlas_private.knowledge_articles;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 38
create policy "service role manages knowledge articles" on atlas_private.knowledge_articles for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 39
drop policy if exists "service role manages knowledge versions" on atlas_private.knowledge_article_versions;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 40
create policy "service role manages knowledge versions" on atlas_private.knowledge_article_versions for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 41
drop policy if exists "service role manages knowledge sources" on atlas_private.knowledge_sources;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 42
create policy "service role manages knowledge sources" on atlas_private.knowledge_sources for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 43
drop policy if exists "service role manages knowledge task links" on atlas_private.knowledge_task_links;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 44
create policy "service role manages knowledge task links" on atlas_private.knowledge_task_links for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 45
drop policy if exists "service role manages knowledge reads" on atlas_private.knowledge_reads;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 46
create policy "service role manages knowledge reads" on atlas_private.knowledge_reads for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 47
drop policy if exists "service role manages knowledge acknowledgements" on atlas_private.knowledge_acknowledgements;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 48
create policy "service role manages knowledge acknowledgements" on atlas_private.knowledge_acknowledgements for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 49
drop policy if exists "service role manages knowledge events" on atlas_private.knowledge_events;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 50
create policy "service role manages knowledge events" on atlas_private.knowledge_events for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 51
revoke all on atlas_private.knowledge_settings from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 52
revoke all on atlas_private.knowledge_categories from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 53
revoke all on atlas_private.knowledge_articles from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 54
revoke all on atlas_private.knowledge_article_versions from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 55
revoke all on atlas_private.knowledge_sources from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 56
revoke all on atlas_private.knowledge_task_links from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 57
revoke all on atlas_private.knowledge_reads from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 58
revoke all on atlas_private.knowledge_acknowledgements from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 59
revoke all on atlas_private.knowledge_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 60
grant all on atlas_private.knowledge_settings to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 61
grant all on atlas_private.knowledge_categories to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 62
grant all on atlas_private.knowledge_articles to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 63
grant all on atlas_private.knowledge_article_versions to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 64
grant all on atlas_private.knowledge_sources to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 65
grant all on atlas_private.knowledge_task_links to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 66
grant all on atlas_private.knowledge_reads to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 67
grant all on atlas_private.knowledge_acknowledgements to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 68
grant all on atlas_private.knowledge_events to service_role;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 69
drop trigger if exists knowledge_settings_touch on atlas_private.knowledge_settings;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 70
create trigger knowledge_settings_touch before update on atlas_private.knowledge_settings for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 71
drop trigger if exists knowledge_categories_touch on atlas_private.knowledge_categories;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 72
create trigger knowledge_categories_touch before update on atlas_private.knowledge_categories for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 73
drop trigger if exists knowledge_articles_touch on atlas_private.knowledge_articles;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 74
create trigger knowledge_articles_touch before update on atlas_private.knowledge_articles for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 75
drop trigger if exists knowledge_versions_touch on atlas_private.knowledge_article_versions;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 76
create trigger knowledge_versions_touch before update on atlas_private.knowledge_article_versions for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 77
drop trigger if exists knowledge_sources_touch on atlas_private.knowledge_sources;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 78
create trigger knowledge_sources_touch before update on atlas_private.knowledge_sources for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 79
insert into atlas_private.knowledge_settings (
  setting_key,google_drive_connection_status,automatic_drive_sync_enabled,
  browser_notifications_enabled,staff_source_urls_visible,metadata
) values (
  'va','not_connected',false,false,false,
  jsonb_build_object(
    'checkpoint','G',
    'publishing_model','manager_draft_then_immutable_version',
    'drive_import_mode','manual_private_import',
    'source_text_in_public_repository',false,
    'sensitive_credentials_allowed',false
  )
)
on conflict (setting_key) do update set
  google_drive_connection_status='not_connected',
  automatic_drive_sync_enabled=false,
  browser_notifications_enabled=false,
  staff_source_urls_visible=false,
  metadata=excluded.metadata,
  updated_at=now();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 80
insert into atlas_private.knowledge_categories (
  category_key,name,description,icon,sort_order,active
) values
  ('company-policies','Company policies','Employment rules, conduct, safety and company-wide standards.','shield-check',10,true),
  ('operations-sops','Operations & SOPs','Daily operational standards and role responsibilities.','workflow',20,true),
  ('opening-closing','Opening & closing','Service preparation, handover, closing and venue security.','door-open',30,true),
  ('service-standards','Service standards','Hospitality, communication and guest-experience guidance.','hand-heart',40,true),
  ('bar-beverage','Bar & beverage knowledge','Recipes, beverage preparation, wine, beer and coffee knowledge.','martini',50,true),
  ('cleaning-safety','Cleaning & safety','Hygiene, temperatures, incidents and equipment safety.','sparkles',60,true),
  ('management','Management','Leadership, scheduling, financial controls and manager responsibilities.','briefcase-business',70,true),
  ('checklists','Checklists','Operational checklists linked to live Atlas routines.','list-checks',80,true),
  ('training-onboarding','Training & onboarding','Required learning, role paths and manager sign-off.','graduation-cap',90,true)
on conflict (category_key) do update set
  name=excluded.name,description=excluded.description,icon=excluded.icon,
  sort_order=excluded.sort_order,active=excluded.active,updated_at=now();

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 81
create or replace function atlas_private.knowledge_article_visible(
  p_article atlas_private.knowledge_articles,
  p_actor_role text,
  p_is_manager boolean
)
returns boolean
language sql
stable
security invoker
set search_path=''
as $$
  select p_is_manager or (
    p_article.status='published'
    and ('all'=any(p_article.target_roles) or p_actor_role=any(p_article.target_roles))
  );
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 82
create or replace function atlas_private.knowledge_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  settings_row atlas_private.knowledge_settings;
  categories_json jsonb := '[]'::jsonb;
  articles_json jsonb := '[]'::jsonb;
  training_json jsonb := '{}'::jsonb;
  events_json jsonb := '[]'::jsonb;
  summary_json jsonb := '{}'::jsonb;
begin
  select * into settings_row from atlas_private.knowledge_settings where setting_key='va';

  with visible_articles as (
    select article.* from atlas_private.knowledge_articles article
    where atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',category.id,'key',category.category_key,'name',category.name,
    'description',category.description,'icon',category.icon,'sort_order',category.sort_order,
    'article_count',(select count(*)::bigint from visible_articles article where article.category_id=category.id)
  ) order by category.sort_order,category.name),'[]'::jsonb)
  into categories_json
  from atlas_private.knowledge_categories category where category.active=true;

  select coalesce(jsonb_agg(row_data.payload order by row_data.sort_required,row_data.sort_updated desc,row_data.sort_title),'[]'::jsonb)
  into articles_json
  from (
    select
      case when article.required then 0 else 1 end as sort_required,
      greatest(article.updated_at,coalesce(display_version.updated_at,article.updated_at)) as sort_updated,
      coalesce(display_version.title,published_version.title,article.article_key) as sort_title,
      jsonb_build_object(
        'id',article.id,'article_key',article.article_key,
        'category_id',article.category_id,'category_key',category.category_key,
        'category_name',category.name,'category_icon',category.icon,
        'article_type',article.article_type,'status',article.status,
        'required',article.required,'target_roles',article.target_roles,
        'live_route',article.live_route,
        'title',coalesce(display_version.title,published_version.title,article.article_key),
        'summary',coalesce(display_version.summary,published_version.summary),
        'display_version_id',display_version.id,
        'display_version_number',display_version.version_number,
        'display_version_state',display_version.state,
        'published_version_id',published_version.id,
        'published_version_number',published_version.version_number,
        'published_at',published_version.published_at,
        'published_by_label',published_version.published_by_label,
        'draft_available',(draft_version.id is not null),
        'draft_version_id',draft_version.id,
        'draft_version_number',draft_version.version_number,
        'updated_at',greatest(article.updated_at,coalesce(display_version.updated_at,article.updated_at)),
        'read',case when published_version.id is null then false else exists (
          select 1 from atlas_private.knowledge_reads reading
          where reading.version_id=published_version.id and reading.user_id=p_actor_id
        ) end,
        'acknowledged',case when published_version.id is null then false else exists (
          select 1 from atlas_private.knowledge_acknowledgements acknowledgement
          where acknowledgement.version_id=published_version.id and acknowledgement.user_id=p_actor_id
        ) end,
        'required_due',(
          not is_manager and article.required and published_version.id is not null
          and not exists (
            select 1 from atlas_private.knowledge_acknowledgements acknowledgement
            where acknowledgement.version_id=published_version.id and acknowledgement.user_id=p_actor_id
          )
        ),
        'acknowledgement_count',case when is_manager and published_version.id is not null then (
          select count(*)::bigint from atlas_private.knowledge_acknowledgements acknowledgement
          where acknowledgement.version_id=published_version.id
        ) else null end,
        'source_count',(select count(*)::bigint from atlas_private.knowledge_sources source where source.article_id=article.id),
        'task_count',(select count(*)::bigint from atlas_private.knowledge_task_links task_link where task_link.article_id=article.id),
        'can_edit',is_manager,
        'can_publish',(is_manager and draft_version.id is not null),
        'can_acknowledge',(
          article.required and published_version.id is not null
          and not exists (
            select 1 from atlas_private.knowledge_acknowledgements acknowledgement
            where acknowledgement.version_id=published_version.id and acknowledgement.user_id=p_actor_id
          )
        )
      ) as payload
    from atlas_private.knowledge_articles article
    join atlas_private.knowledge_categories category on category.id=article.category_id
    left join lateral (
      select * from atlas_private.knowledge_article_versions version
      where version.article_id=article.id and version.state='published'
      order by version.version_number desc limit 1
    ) published_version on true
    left join lateral (
      select * from atlas_private.knowledge_article_versions version
      where version.article_id=article.id and version.state='draft'
      order by version.version_number desc limit 1
    ) draft_version on true
    left join lateral (
      select version.* from atlas_private.knowledge_article_versions version
      where version.id=case when is_manager and draft_version.id is not null then draft_version.id else published_version.id end
    ) display_version on true
    where atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
  ) row_data;

  with profiles_input as (
    select * from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,email text,display_name text,role text,active boolean
    )
  ), tasks_input as (
    select * from jsonb_to_recordset(coalesce(p_tasks,'[]'::jsonb)) as task(
      id uuid,title text,description text,category text,sort_order integer,required boolean,active boolean
    )
  ), progress_input as (
    select * from jsonb_to_recordset(coalesce(p_progress,'[]'::jsonb)) as progress(
      id uuid,task_id uuid,user_id uuid,completed_at timestamptz,completed_by uuid,note text
    )
  )
  select jsonb_build_object(
    'tasks',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',task.id,'title',task.title,'description',task.description,
        'category',task.category,'sort_order',task.sort_order,'required',task.required,
        'completed',exists (
          select 1 from progress_input progress
          where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
        ),
        'completed_at',(
          select progress.completed_at from progress_input progress
          where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
          order by progress.completed_at desc limit 1
        ),
        'note',(
          select progress.note from progress_input progress
          where progress.task_id=task.id and progress.user_id=p_actor_id
          order by progress.completed_at desc nulls last limit 1
        ),
        'linked_articles',coalesce((
          select jsonb_agg(jsonb_build_object(
            'article_id',article.id,'article_key',article.article_key,
            'title',version.title,'required_for_task',link.required_for_task
          ) order by version.title)
          from atlas_private.knowledge_task_links link
          join atlas_private.knowledge_articles article on article.id=link.article_id
          join atlas_private.knowledge_article_versions version
            on version.article_id=article.id and version.state='published'
          where link.onboarding_task_id=task.id
            and atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
        ),'[]'::jsonb)
      ) order by task.sort_order,task.title)
      from tasks_input task where task.active=true
    ),'[]'::jsonb),
    'own_progress',jsonb_build_object(
      'required_total',(select count(*)::bigint from tasks_input task where task.active=true and task.required=true),
      'required_completed',(
        select count(*)::bigint from tasks_input task
        where task.active=true and task.required=true
          and exists (
            select 1 from progress_input progress
            where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
          )
      )
    ),
    'team',case when is_manager then coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id',profile.id,
        'name',coalesce(nullif(trim(profile.display_name),''),nullif(split_part(coalesce(profile.email,''),'@',1),''),'Team member'),
        'role',profile.role,'active',profile.active,
        'required_total',(select count(*)::bigint from tasks_input task where task.active=true and task.required=true),
        'required_completed',(
          select count(*)::bigint from tasks_input task
          where task.active=true and task.required=true
            and exists (
              select 1 from progress_input progress
              where progress.task_id=task.id and progress.user_id=profile.id and progress.completed_at is not null
            )
        )
      ) order by profile.active desc,coalesce(profile.display_name,profile.email))
      from profiles_input profile where profile.active=true
    ),'[]'::jsonb) else '[]'::jsonb end
  ) into training_json;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,'event_type',event.event_type,'article_id',event.article_id,
      'version_id',event.version_id,'source_id',event.source_id,'user_id',event.user_id,
      'actor_label',event.actor_label,'actor_role',event.actor_role,
      'payload',event.payload,'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into events_json
    from (select * from atlas_private.knowledge_events order by created_at desc limit 80) event;
  end if;

  select jsonb_build_object(
    'visible_articles',jsonb_array_length(articles_json),
    'published_articles',(
      select count(*)::bigint from atlas_private.knowledge_articles article
      where article.status='published'
        and atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
    ),
    'draft_articles',case when is_manager then (
      select count(*)::bigint from atlas_private.knowledge_article_versions version where version.state='draft'
    ) else null end,
    'required_due',(
      select count(*)::bigint
      from atlas_private.knowledge_articles article
      join atlas_private.knowledge_article_versions version
        on version.article_id=article.id and version.state='published'
      where article.required=true
        and atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
        and not exists (
          select 1 from atlas_private.knowledge_acknowledgements acknowledgement
          where acknowledgement.version_id=version.id and acknowledgement.user_id=p_actor_id
        )
    ),
    'acknowledged',(
      select count(*)::bigint from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.user_id=p_actor_id
    ),
    'source_references',case when is_manager then (
      select count(*)::bigint from atlas_private.knowledge_sources
    ) else (
      select count(*)::bigint from atlas_private.knowledge_sources source where source.visible_to_staff=true
    ) end
  ) into summary_json;

  return jsonb_build_object(
    'version','atlas-knowledge/0.1.0','generated_at',pg_catalog.now(),
    'categories',categories_json,'articles',articles_json,'training',training_json,
    'events',events_json,'summary',summary_json,
    'settings',jsonb_build_object(
      'google_drive_connection_status',settings_row.google_drive_connection_status,
      'automatic_drive_sync_enabled',settings_row.automatic_drive_sync_enabled,
      'browser_notifications_enabled',settings_row.browser_notifications_enabled,
      'staff_source_urls_visible',settings_row.staff_source_urls_visible,
      'metadata',settings_row.metadata
    ),
    'permissions',jsonb_build_object(
      'can_manage_articles',is_manager,'can_publish',is_manager,
      'can_manage_sources',is_manager,'can_acknowledge',true
    ),
    'trust',jsonb_build_object(
      'only_published_versions_visible_to_staff',true,
      'published_versions_immutable',true,
      'drive_automatic_sync_enabled',false,
      'source_urls_manager_only',not settings_row.staff_source_urls_visible,
      'direct_browser_table_access',false,
      'sensitive_credentials_imported',false
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 83
create or replace function atlas_private.knowledge_article_detail(
  p_article_id uuid,p_actor_id uuid,p_actor_role text,p_prefer_draft boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  article_row atlas_private.knowledge_articles;
  category_row atlas_private.knowledge_categories;
  version_row atlas_private.knowledge_article_versions;
begin
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id;
  if not found then raise exception 'Knowledge article not found'; end if;
  if not atlas_private.knowledge_article_visible(article_row,p_actor_role,is_manager) then
    raise exception 'Knowledge article is not available to this profile';
  end if;
  select * into category_row from atlas_private.knowledge_categories where id=article_row.category_id;

  if is_manager and coalesce(p_prefer_draft,false) then
    select * into version_row from atlas_private.knowledge_article_versions
    where article_id=article_row.id and state='draft' order by version_number desc limit 1;
  end if;
  if version_row.id is null then
    select * into version_row from atlas_private.knowledge_article_versions
    where article_id=article_row.id and state='published' order by version_number desc limit 1;
  end if;
  if version_row.id is null and is_manager then
    select * into version_row from atlas_private.knowledge_article_versions
    where article_id=article_row.id order by version_number desc limit 1;
  end if;
  if version_row.id is null then raise exception 'Knowledge article has no readable version'; end if;

  return jsonb_build_object(
    'article',jsonb_build_object(
      'id',article_row.id,'article_key',article_row.article_key,
      'category_id',article_row.category_id,'category_key',category_row.category_key,
      'category_name',category_row.name,'category_icon',category_row.icon,
      'article_type',article_row.article_type,'status',article_row.status,
      'required',article_row.required,'target_roles',article_row.target_roles,
      'live_route',article_row.live_route,'current_version',article_row.current_version,
      'created_at',article_row.created_at,'updated_at',article_row.updated_at
    ),
    'version',jsonb_build_object(
      'id',version_row.id,'version_number',version_row.version_number,'state',version_row.state,
      'title',version_row.title,'summary',version_row.summary,'content',version_row.content,
      'content_format',version_row.content_format,'change_note',version_row.change_note,
      'created_by_label',version_row.created_by_label,'published_at',version_row.published_at,
      'published_by_label',version_row.published_by_label,'created_at',version_row.created_at,
      'updated_at',version_row.updated_at
    ),
    'sources',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',source.id,'source_type',source.source_type,'source_label',source.source_label,
        'source_reference',case when is_manager or source.visible_to_staff then source.source_reference else null end,
        'source_url',case when is_manager then source.source_url else null end,
        'source_version',source.source_version,'connection_status',source.connection_status,
        'visible_to_staff',source.visible_to_staff,'last_verified_at',source.last_verified_at,
        'metadata',case when is_manager then source.metadata else '{}'::jsonb end,
        'updated_at',source.updated_at
      ) order by source.updated_at desc)
      from atlas_private.knowledge_sources source
      where source.article_id=article_row.id and (is_manager or source.visible_to_staff=true)
    ),'[]'::jsonb),
    'task_links',coalesce((
      select jsonb_agg(jsonb_build_object(
        'onboarding_task_id',link.onboarding_task_id,'required_for_task',link.required_for_task
      ) order by link.onboarding_task_id)
      from atlas_private.knowledge_task_links link where link.article_id=article_row.id
    ),'[]'::jsonb),
    'read',exists (
      select 1 from atlas_private.knowledge_reads reading
      where reading.version_id=version_row.id and reading.user_id=p_actor_id
    ),
    'acknowledged',exists (
      select 1 from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.version_id=version_row.id and acknowledgement.user_id=p_actor_id
    ),
    'can_acknowledge',(version_row.state='published' and article_row.required and not exists (
      select 1 from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.version_id=version_row.id and acknowledgement.user_id=p_actor_id
    )),
    'version_history',case when is_manager then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',version.id,'version_number',version.version_number,'state',version.state,
        'title',version.title,'change_note',version.change_note,
        'created_by_label',version.created_by_label,'published_at',version.published_at,
        'published_by_label',version.published_by_label,'created_at',version.created_at,
        'updated_at',version.updated_at
      ) order by version.version_number desc)
      from atlas_private.knowledge_article_versions version where version.article_id=article_row.id
    ),'[]'::jsonb) else '[]'::jsonb end,
    'acknowledgements',case when is_manager and version_row.state='published' then coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id',acknowledgement.user_id,'user_label',acknowledgement.user_label,
        'user_role',acknowledgement.user_role,'acknowledged_at',acknowledgement.acknowledged_at
      ) order by acknowledgement.acknowledged_at desc)
      from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.version_id=version_row.id
    ),'[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 84
create or replace function atlas_private.knowledge_save_draft(
  p_article_id uuid,p_article_key text,p_category_id uuid,p_article_type text,p_title text,
  p_summary text,p_content text,p_required boolean,p_target_roles text[],p_live_route text,
  p_change_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  draft_row atlas_private.knowledge_article_versions;
  next_version integer;
  created_article boolean := false;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can edit Knowledge'; end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Article title is required'; end if;
  if nullif(trim(coalesce(p_content,'')),'') is null then raise exception 'Article content is required'; end if;
  if p_article_type not in ('policy','sop','checklist','training','reference','live_resource') then raise exception 'Article type is invalid'; end if;
  if coalesce(cardinality(p_target_roles),0)=0 or not (p_target_roles <@ array['all','admin','manager','bartender','viewer']::text[]) then raise exception 'Target roles are invalid'; end if;
  if not exists (select 1 from atlas_private.knowledge_categories where id=p_category_id and active=true) then raise exception 'Knowledge category is invalid'; end if;

  if p_article_id is null then
    if nullif(trim(coalesce(p_article_key,'')),'') is null or p_article_key !~ '^[a-z0-9][a-z0-9-]{1,119}$' then raise exception 'Article key is invalid'; end if;
    insert into atlas_private.knowledge_articles (
      article_key,category_id,article_type,status,required,target_roles,live_route,
      created_by,created_by_label,updated_by,updated_by_label
    ) values (
      p_article_key,p_category_id,p_article_type,'draft',coalesce(p_required,false),p_target_roles,
      nullif(trim(coalesce(p_live_route,'')),''),p_actor_id,p_actor_label,p_actor_id,p_actor_label
    ) returning * into article_row;
    created_article := true;
    insert into atlas_private.knowledge_events (event_type,article_id,actor_id,actor_label,actor_role,payload)
    values ('article_created',article_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('article_key',article_row.article_key));
  else
    select * into article_row from atlas_private.knowledge_articles where id=p_article_id for update;
    if not found then raise exception 'Knowledge article not found'; end if;
    update atlas_private.knowledge_articles
    set category_id=p_category_id,article_type=p_article_type,required=coalesce(p_required,false),
        target_roles=p_target_roles,live_route=nullif(trim(coalesce(p_live_route,'')),''),
        status=case when status='retired' then 'draft' else status end,
        updated_by=p_actor_id,updated_by_label=p_actor_label
    where id=article_row.id returning * into article_row;
  end if;

  select * into draft_row from atlas_private.knowledge_article_versions
  where article_id=article_row.id and state='draft' for update;

  if not found then
    select coalesce(max(version_number),0)+1 into next_version
    from atlas_private.knowledge_article_versions where article_id=article_row.id;
    insert into atlas_private.knowledge_article_versions (
      article_id,version_number,state,title,summary,content,content_format,change_note,
      created_by,created_by_label
    ) values (
      article_row.id,next_version,'draft',trim(p_title),nullif(trim(coalesce(p_summary,'')),''),
      p_content,'markdown',nullif(trim(coalesce(p_change_note,'')),''),p_actor_id,p_actor_label
    ) returning * into draft_row;
  else
    update atlas_private.knowledge_article_versions
    set title=trim(p_title),summary=nullif(trim(coalesce(p_summary,'')),''),content=p_content,
        change_note=nullif(trim(coalesce(p_change_note,'')),''),created_by=p_actor_id,
        created_by_label=p_actor_label,updated_at=pg_catalog.now()
    where id=draft_row.id returning * into draft_row;
  end if;

  update atlas_private.knowledge_articles
  set draft_version_id=draft_row.id,updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=article_row.id;

  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,actor_id,actor_label,actor_role,payload
  ) values (
    'draft_saved',article_row.id,draft_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('version_number',draft_row.version_number,'created_article',created_article)
  );

  return jsonb_build_object('article',to_jsonb(article_row),'draft',to_jsonb(draft_row));
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 85
create or replace function atlas_private.knowledge_publish(
  p_article_id uuid,p_change_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  draft_row atlas_private.knowledge_article_versions;
  published_row atlas_private.knowledge_article_versions;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish Knowledge'; end if;
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id for update;
  if not found then raise exception 'Knowledge article not found'; end if;
  select * into draft_row from atlas_private.knowledge_article_versions
  where article_id=article_row.id and state='draft' for update;
  if not found then raise exception 'This article has no draft to publish'; end if;

  update atlas_private.knowledge_article_versions
  set state='superseded',updated_at=pg_catalog.now()
  where article_id=article_row.id and state='published';

  update atlas_private.knowledge_article_versions
  set state='published',change_note=coalesce(nullif(trim(coalesce(p_change_note,'')),''),change_note),
      published_at=pg_catalog.now(),published_by=p_actor_id,published_by_label=p_actor_label,
      updated_at=pg_catalog.now()
  where id=draft_row.id returning * into published_row;

  update atlas_private.knowledge_articles
  set status='published',current_version=published_row.version_number,
      current_version_id=published_row.id,draft_version_id=null,
      updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=article_row.id returning * into article_row;

  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,actor_id,actor_label,actor_role,payload
  ) values (
    'version_published',article_row.id,published_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('version_number',published_row.version_number,'required',article_row.required,'target_roles',article_row.target_roles)
  );

  system_body := 'Knowledge article published' || E'\n' || published_row.title
    || ' · Version ' || published_row.version_number::text
    || case when article_row.required then E'\nRequired reading for assigned staff.' else '' end;
  begin
    perform atlas_private.team_messages_post_system(
      'announcements','knowledge-published:'||article_row.id::text||':'||published_row.version_number::text,
      system_body,'knowledge_article',article_row.id::text,published_row.title,'knowledge',
      jsonb_build_object('article_id',article_row.id,'version_id',published_row.id,
        'version_number',published_row.version_number,'required',article_row.required)
    );
  exception when others then null;
  end;

  return jsonb_build_object('article',to_jsonb(article_row),'version',to_jsonb(published_row));
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 86
create or replace function atlas_private.knowledge_retire(
  p_article_id uuid,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare article_row atlas_private.knowledge_articles;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can retire Knowledge'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A retirement reason is required'; end if;
  update atlas_private.knowledge_articles
  set status='retired',draft_version_id=null,updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=p_article_id returning * into article_row;
  if not found then raise exception 'Knowledge article not found'; end if;
  update atlas_private.knowledge_article_versions set state='superseded'
  where article_id=article_row.id and state='draft';
  insert into atlas_private.knowledge_events (event_type,article_id,actor_id,actor_label,actor_role,payload)
  values ('article_retired',article_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('reason',trim(p_reason)));
  return to_jsonb(article_row);
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 87
create or replace function atlas_private.knowledge_mark_read(
  p_article_id uuid,p_version_id uuid,p_user_id uuid,p_user_label text,p_user_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  version_row atlas_private.knowledge_article_versions;
  read_row atlas_private.knowledge_reads;
begin
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id;
  if not found or not atlas_private.knowledge_article_visible(article_row,p_user_role,p_user_role in ('admin','manager')) then
    raise exception 'Knowledge article is not available';
  end if;
  select * into version_row from atlas_private.knowledge_article_versions
  where id=p_version_id and article_id=article_row.id and state='published';
  if not found then raise exception 'Published Knowledge version not found'; end if;
  insert into atlas_private.knowledge_reads (version_id,article_id,user_id,user_label)
  values (version_row.id,article_row.id,p_user_id,p_user_label)
  on conflict (version_id,user_id) do update set
    last_read_at=pg_catalog.now(),
    read_count=atlas_private.knowledge_reads.read_count+1,
    user_label=excluded.user_label
  returning * into read_row;
  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,user_id,actor_id,actor_label,actor_role,payload
  ) values (
    'article_read',article_row.id,version_row.id,p_user_id,p_user_id,p_user_label,p_user_role,
    jsonb_build_object('read_count',read_row.read_count)
  );
  return to_jsonb(read_row);
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 88
create or replace function atlas_private.knowledge_acknowledge(
  p_article_id uuid,p_version_id uuid,p_user_id uuid,p_user_label text,p_user_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  version_row atlas_private.knowledge_article_versions;
  acknowledgement_row atlas_private.knowledge_acknowledgements;
begin
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id;
  if not found or not atlas_private.knowledge_article_visible(article_row,p_user_role,p_user_role in ('admin','manager')) then
    raise exception 'Knowledge article is not available';
  end if;
  if not article_row.required then raise exception 'This article does not require acknowledgement'; end if;
  select * into version_row from atlas_private.knowledge_article_versions
  where id=p_version_id and article_id=article_row.id and state='published';
  if not found or version_row.id is distinct from article_row.current_version_id then
    raise exception 'Only the current published version can be acknowledged';
  end if;
  insert into atlas_private.knowledge_acknowledgements (
    version_id,article_id,user_id,user_label,user_role
  ) values (
    version_row.id,article_row.id,p_user_id,p_user_label,p_user_role
  )
  on conflict (version_id,user_id) do update set
    user_label=excluded.user_label,user_role=excluded.user_role,
    acknowledged_at=least(atlas_private.knowledge_acknowledgements.acknowledged_at,excluded.acknowledged_at)
  returning * into acknowledgement_row;
  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,user_id,actor_id,actor_label,actor_role,payload
  ) values (
    'article_acknowledged',article_row.id,version_row.id,p_user_id,p_user_id,p_user_label,p_user_role,
    jsonb_build_object('version_number',version_row.version_number)
  );
  return to_jsonb(acknowledgement_row);
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 89
create or replace function atlas_private.knowledge_save_source(
  p_source_id uuid,p_article_id uuid,p_source_type text,p_source_label text,
  p_source_reference text,p_source_url text,p_source_version text,p_connection_status text,
  p_visible_to_staff boolean,p_metadata jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare source_row atlas_private.knowledge_sources;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can manage Knowledge sources'; end if;
  if not exists (select 1 from atlas_private.knowledge_articles where id=p_article_id) then raise exception 'Knowledge article not found'; end if;
  if p_source_type not in ('google_drive','atlas_module','sprint3_import','manual','external') then raise exception 'Source type is invalid'; end if;
  if p_connection_status not in ('manual_reference','not_connected','current','stale','error') then raise exception 'Source status is invalid'; end if;
  if nullif(trim(coalesce(p_source_label,'')),'') is null then raise exception 'Source label is required'; end if;

  if p_source_id is null then
    insert into atlas_private.knowledge_sources (
      article_id,source_type,source_label,source_reference,source_url,source_version,
      connection_status,visible_to_staff,last_verified_at,metadata,created_by,created_by_label
    ) values (
      p_article_id,p_source_type,trim(p_source_label),nullif(trim(coalesce(p_source_reference,'')),''),
      nullif(trim(coalesce(p_source_url,'')),''),nullif(trim(coalesce(p_source_version,'')),''),
      p_connection_status,coalesce(p_visible_to_staff,false),
      case when p_connection_status='current' then pg_catalog.now() else null end,
      coalesce(p_metadata,'{}'::jsonb),p_actor_id,p_actor_label
    ) returning * into source_row;
  else
    update atlas_private.knowledge_sources
    set source_type=p_source_type,source_label=trim(p_source_label),
        source_reference=nullif(trim(coalesce(p_source_reference,'')),''),
        source_url=nullif(trim(coalesce(p_source_url,'')),''),
        source_version=nullif(trim(coalesce(p_source_version,'')),''),
        connection_status=p_connection_status,visible_to_staff=coalesce(p_visible_to_staff,false),
        last_verified_at=case when p_connection_status='current' then pg_catalog.now() else last_verified_at end,
        metadata=coalesce(p_metadata,'{}'::jsonb)
    where id=p_source_id and article_id=p_article_id returning * into source_row;
    if not found then raise exception 'Knowledge source not found'; end if;
  end if;

  insert into atlas_private.knowledge_events (
    event_type,article_id,source_id,actor_id,actor_label,actor_role,payload
  ) values (
    'source_saved',p_article_id,source_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_type',source_row.source_type,'connection_status',source_row.connection_status)
  );
  return to_jsonb(source_row);
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 90
create or replace function atlas_private.knowledge_remove_source(
  p_source_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare source_row atlas_private.knowledge_sources;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can remove Knowledge sources'; end if;
  delete from atlas_private.knowledge_sources where id=p_source_id returning * into source_row;
  if not found then raise exception 'Knowledge source not found'; end if;
  insert into atlas_private.knowledge_events (
    event_type,article_id,source_id,actor_id,actor_label,actor_role,payload
  ) values (
    'source_removed',source_row.article_id,null,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_id',source_row.id,'source_label',source_row.source_label,'source_type',source_row.source_type)
  );
  return to_jsonb(source_row);
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 91
create or replace function atlas_private.knowledge_set_task_links(
  p_article_id uuid,p_task_ids uuid[],p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can link Knowledge to onboarding'; end if;
  if not exists (select 1 from atlas_private.knowledge_articles where id=p_article_id) then raise exception 'Knowledge article not found'; end if;
  delete from atlas_private.knowledge_task_links where article_id=p_article_id;
  insert into atlas_private.knowledge_task_links (
    article_id,onboarding_task_id,created_by,created_by_label
  )
  select p_article_id,task_id,p_actor_id,p_actor_label
  from unnest(coalesce(p_task_ids,'{}'::uuid[])) as task_id
  on conflict do nothing;
  insert into atlas_private.knowledge_events (
    event_type,article_id,actor_id,actor_label,actor_role,payload
  ) values (
    'task_links_updated',p_article_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('task_ids',coalesce(to_jsonb(p_task_ids),'[]'::jsonb))
  );
  return jsonb_build_object('article_id',p_article_id,'task_ids',coalesce(to_jsonb(p_task_ids),'[]'::jsonb));
end;
$$;

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 92
comment on table atlas_private.knowledge_articles is 'Private Knowledge article metadata. Staff only receive manager-published role-targeted versions through the gateway.';

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 93
comment on table atlas_private.knowledge_article_versions is 'Versioned Knowledge content. Published versions are immutable and prior acknowledgements remain attached to their original version.';

-- SOURCE supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql statement 94
comment on table atlas_private.knowledge_acknowledgements is 'Per-user acknowledgement of a specific published Knowledge version.';

-- SOURCE supabase/migrations/20260804005004_atlas_knowledge_checkpoint_g_hardening.sql statement 0
-- Checkpoint G hardening: make Knowledge publications first-class Team links
-- and preserve source-removal audit events after the source row is deleted.

alter table atlas_private.team_messages
  drop constraint if exists team_messages_link_type_check;

-- SOURCE supabase/migrations/20260804005004_atlas_knowledge_checkpoint_g_hardening.sql statement 1
alter table atlas_private.team_messages
  add constraint team_messages_link_type_check
  check (link_type in (
    'none','inventory_item','routine','shift','brain_recommendation','knowledge_article'
  ));

-- SOURCE supabase/migrations/20260804005004_atlas_knowledge_checkpoint_g_hardening.sql statement 2
create or replace function atlas_private.knowledge_publish(
  p_article_id uuid,
  p_change_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  draft_row atlas_private.knowledge_article_versions;
  published_row atlas_private.knowledge_article_versions;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish Knowledge'; end if;
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id for update;
  if not found then raise exception 'Knowledge article not found'; end if;
  select * into draft_row from atlas_private.knowledge_article_versions
  where article_id=article_row.id and state='draft' for update;
  if not found then raise exception 'This article has no draft to publish'; end if;

  update atlas_private.knowledge_article_versions
  set state='superseded',updated_at=pg_catalog.now()
  where article_id=article_row.id and state='published';

  update atlas_private.knowledge_article_versions
  set state='published',
      change_note=coalesce(nullif(trim(coalesce(p_change_note,'')),''),change_note),
      published_at=pg_catalog.now(),
      published_by=p_actor_id,
      published_by_label=p_actor_label,
      updated_at=pg_catalog.now()
  where id=draft_row.id
  returning * into published_row;

  update atlas_private.knowledge_articles
  set status='published',
      current_version=published_row.version_number,
      current_version_id=published_row.id,
      draft_version_id=null,
      updated_by=p_actor_id,
      updated_by_label=p_actor_label
  where id=article_row.id
  returning * into article_row;

  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,actor_id,actor_label,actor_role,payload
  ) values (
    'version_published',article_row.id,published_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'version_number',published_row.version_number,
      'required',article_row.required,
      'target_roles',article_row.target_roles
    )
  );

  system_body := 'Knowledge article published' || E'\n'
    || published_row.title || ' · Version ' || published_row.version_number::text
    || case when article_row.required then E'\nRequired reading for assigned staff.' else '' end;

  begin
    perform atlas_private.team_messages_post_system(
      'announcements',
      'knowledge-published:'||article_row.id::text||':'||published_row.version_number::text,
      system_body,
      'knowledge_article',
      article_row.id::text,
      published_row.title,
      'knowledge',
      jsonb_build_object(
        'article_id',article_row.id,
        'version_id',published_row.id,
        'version_number',published_row.version_number,
        'required',article_row.required
      )
    );
  exception when others then
    null;
  end;

  return jsonb_build_object('article',to_jsonb(article_row),'version',to_jsonb(published_row));
end;
$$;

-- SOURCE supabase/migrations/20260804005004_atlas_knowledge_checkpoint_g_hardening.sql statement 3
create or replace function atlas_private.knowledge_remove_source(
  p_source_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare source_row atlas_private.knowledge_sources;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can remove Knowledge sources'; end if;
  delete from atlas_private.knowledge_sources where id=p_source_id returning * into source_row;
  if not found then raise exception 'Knowledge source not found'; end if;

  insert into atlas_private.knowledge_events (
    event_type,article_id,source_id,actor_id,actor_label,actor_role,payload
  ) values (
    'source_removed',source_row.article_id,null,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'source_id',source_row.id,
      'source_label',source_row.source_label,
      'source_type',source_row.source_type
    )
  );
  return to_jsonb(source_row);
end;
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 0
-- PostgREST resolves RPC payloads by argument name. Recreate the service-role-only
-- wrappers with explicit names so the Knowledge Edge Function can call them.

drop function if exists public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 1
drop function if exists public.atlas_knowledge_article_detail(uuid,uuid,text,boolean);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 2
drop function if exists public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 3
drop function if exists public.atlas_knowledge_publish(uuid,text,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 4
drop function if exists public.atlas_knowledge_retire(uuid,text,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 5
drop function if exists public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 6
drop function if exists public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 7
drop function if exists public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 8
drop function if exists public.atlas_knowledge_remove_source(uuid,uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 9
drop function if exists public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text);

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 10
create function public.atlas_knowledge_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_snapshot(
    p_profiles,p_tasks,p_progress,p_actor_id,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 11
create function public.atlas_knowledge_article_detail(
  p_article_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_prefer_draft boolean
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_article_detail(
    p_article_id,p_actor_id,p_actor_role,p_prefer_draft
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 12
create function public.atlas_knowledge_save_draft(
  p_article_id uuid,
  p_article_key text,
  p_category_id uuid,
  p_article_type text,
  p_title text,
  p_summary text,
  p_content text,
  p_required boolean,
  p_target_roles text[],
  p_live_route text,
  p_change_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_save_draft(
    p_article_id,p_article_key,p_category_id,p_article_type,p_title,p_summary,p_content,
    p_required,p_target_roles,p_live_route,p_change_note,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 13
create function public.atlas_knowledge_publish(
  p_article_id uuid,
  p_change_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_publish(
    p_article_id,p_change_note,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 14
create function public.atlas_knowledge_retire(
  p_article_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_retire(
    p_article_id,p_reason,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 15
create function public.atlas_knowledge_mark_read(
  p_article_id uuid,
  p_version_id uuid,
  p_user_id uuid,
  p_user_label text,
  p_user_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_mark_read(
    p_article_id,p_version_id,p_user_id,p_user_label,p_user_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 16
create function public.atlas_knowledge_acknowledge(
  p_article_id uuid,
  p_version_id uuid,
  p_user_id uuid,
  p_user_label text,
  p_user_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_acknowledge(
    p_article_id,p_version_id,p_user_id,p_user_label,p_user_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 17
create function public.atlas_knowledge_save_source(
  p_source_id uuid,
  p_article_id uuid,
  p_source_type text,
  p_source_label text,
  p_source_reference text,
  p_source_url text,
  p_source_version text,
  p_connection_status text,
  p_visible_to_staff boolean,
  p_metadata jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_save_source(
    p_source_id,p_article_id,p_source_type,p_source_label,p_source_reference,
    p_source_url,p_source_version,p_connection_status,p_visible_to_staff,p_metadata,
    p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 18
create function public.atlas_knowledge_remove_source(
  p_source_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_remove_source(
    p_source_id,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 19
create function public.atlas_knowledge_set_task_links(
  p_article_id uuid,
  p_task_ids uuid[],
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_set_task_links(
    p_article_id,p_task_ids,p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 20
revoke execute on function public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 21
revoke execute on function public.atlas_knowledge_article_detail(uuid,uuid,text,boolean) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 22
revoke execute on function public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 23
revoke execute on function public.atlas_knowledge_publish(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 24
revoke execute on function public.atlas_knowledge_retire(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 25
revoke execute on function public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 26
revoke execute on function public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 27
revoke execute on function public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 28
revoke execute on function public.atlas_knowledge_remove_source(uuid,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 29
revoke execute on function public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 30
grant execute on function public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 31
grant execute on function public.atlas_knowledge_article_detail(uuid,uuid,text,boolean) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 32
grant execute on function public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 33
grant execute on function public.atlas_knowledge_publish(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 34
grant execute on function public.atlas_knowledge_retire(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 35
grant execute on function public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 36
grant execute on function public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 37
grant execute on function public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 38
grant execute on function public.atlas_knowledge_remove_source(uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 39
grant execute on function public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql statement 40
comment on function public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text)
  is 'Service-role-only Knowledge workspace snapshot assembled after production profile authorization.';

-- SOURCE supabase/migrations/20260804011727_atlas_knowledge_foreign_key_indexes.sql statement 0
-- Cover Knowledge foreign-key paths used by article/version lookup and audit history.

create index if not exists knowledge_articles_current_version_idx
  on atlas_private.knowledge_articles(current_version_id)
  where current_version_id is not null;

-- SOURCE supabase/migrations/20260804011727_atlas_knowledge_foreign_key_indexes.sql statement 1
create index if not exists knowledge_articles_draft_version_idx
  on atlas_private.knowledge_articles(draft_version_id)
  where draft_version_id is not null;

-- SOURCE supabase/migrations/20260804011727_atlas_knowledge_foreign_key_indexes.sql statement 2
create index if not exists knowledge_events_source_idx
  on atlas_private.knowledge_events(source_id,created_at desc)
  where source_id is not null;

-- SOURCE supabase/migrations/20260804011727_atlas_knowledge_foreign_key_indexes.sql statement 3
create index if not exists knowledge_events_version_idx
  on atlas_private.knowledge_events(version_id,created_at desc)
  where version_id is not null;

-- SOURCE supabase/migrations/20260804011727_atlas_knowledge_foreign_key_indexes.sql statement 4
create index if not exists knowledge_reads_article_idx
  on atlas_private.knowledge_reads(article_id,last_read_at desc);

-- SOURCE supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql statement 0
-- Checkpoint H foundation.
--
-- This first contract established the service-role-only Reports RPC while the
-- live-source hand-off was being added. The following migration replaces it
-- with atlas_reports_snapshot_v2, which accepts production records only after
-- the authenticated gateway has applied role-based data minimisation.

create or replace function atlas_private.reports_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text default 'previous_period',
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'version','atlas-reports/0.1.0',
    'generated_at',pg_catalog.now(),
    'timezone','Atlantic/Reykjavik',
    'currency','ISK',
    'period',jsonb_build_object(
      'start',p_period_start,
      'end',p_period_end
    ),
    'comparison',jsonb_build_object(
      'key',coalesce(p_comparison_key,'previous_period'),
      'start',p_comparison_start,
      'end',p_comparison_end,
      'enabled',p_comparison_start is not null and p_comparison_end is not null
    ),
    'filters',coalesce(p_filters,'{}'::jsonb),
    'sections','[]'::jsonb,
    'kpis','[]'::jsonb,
    'attention','[]'::jsonb,
    'data_sources',jsonb_build_array(jsonb_build_object(
      'key','foundation',
      'name','Reports live-source gateway',
      'status','waiting_for_live_sources',
      'note','The next versioned migration supplies production records through the authenticated gateway.'
    )),
    'reports','{}'::jsonb,
    'permissions',jsonb_build_object(
      'can_view_manager_reports',p_actor_role in ('admin','manager'),
      'can_view_employee_detail',p_actor_role in ('admin','manager'),
      'can_export',true,
      'can_ask_atlas',true,
      'read_only',true
    ),
    'trust',jsonb_build_object(
      'reports_are_read_only',true,
      'sales_values_invented',false,
      'source_data_modified',false,
      'permission_sensitive_data_loaded_for_staff',false,
      'reykjavik_reporting_timezone',true,
      'currency','ISK'
    )
  );
$$;

-- SOURCE supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql statement 1
create or replace function public.atlas_reports_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.reports_snapshot(
    p_profiles,p_tasks,p_progress,p_actor_id,p_actor_role,p_period_start,p_period_end,
    p_comparison_start,p_comparison_end,p_comparison_key,p_filters
  );
$$;

-- SOURCE supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql statement 2
revoke execute on function public.atlas_reports_snapshot(jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql statement 3
grant execute on function public.atlas_reports_snapshot(jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

-- SOURCE supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql statement 4
comment on function public.atlas_reports_snapshot(jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  is 'Checkpoint H Reports foundation. Superseded by atlas_reports_snapshot_v2 after live-source role filtering.';

-- SOURCE supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql statement 0
-- Checkpoint H live-source Reports contract.
--
-- The function is stored below as a pgcrypto-compressed, versioned DDL payload
-- because the connector used to publish this branch has a practical single-file
-- payload limit. The decoded text is the readable CREATE OR REPLACE FUNCTION
-- definition returned by pg_get_functiondef after database validation. It creates
-- atlas_private.reports_snapshot_v2, whose formulas are also surfaced in the
-- Reports UI and covered by repository contract tests.
--
-- No credential, operational record or private source value is contained in the
-- payload; it contains SQL definition text only.

create extension if not exists pgcrypto with schema extensions;

-- SOURCE supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql statement 1
CREATE OR REPLACE FUNCTION atlas_private.reports_snapshot_v2(p_inventory jsonb, p_recipes jsonb, p_recipe_ingredients jsonb, p_suppliers jsonb, p_movements jsonb, p_profiles jsonb, p_tasks jsonb, p_progress jsonb, p_actor_id uuid, p_actor_role text, p_period_start date, p_period_end date, p_comparison_start date, p_comparison_end date, p_comparison_key text DEFAULT 'previous_period'::text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  period_start date := coalesce(p_period_start,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
  period_end date := coalesce(p_period_end,(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date);
  start_inclusive timestamptz;
  end_exclusive timestamptz;
  comparison_start_inclusive timestamptz;
  comparison_end_exclusive timestamptz;
  generated_at_value timestamptz := pg_catalog.now();
  category_filter text := nullif(trim(coalesce(p_filters->>'category','')),'');
  supplier_filter text := nullif(trim(coalesce(p_filters->>'supplier','')),'');
  status_filter text := nullif(trim(coalesce(p_filters->>'status','')),'');
  employee_filter text := nullif(trim(coalesce(p_filters->>'employee','')),'');
  search_filter text := nullif(trim(coalesce(p_filters->>'search','')),'');

  inv_active integer := 0;
  inv_value numeric := 0;
  inv_below_par integer := 0;
  inv_out_stock integer := 0;
  inv_missing_cost integer := 0;
  inv_missing_supplier integer := 0;
  inv_missing_par integer := 0;
  inv_recently_updated integer := 0;
  inv_rows jsonb := '[]'::jsonb;
  inv_categories jsonb := '[]'::jsonb;

  recipe_active integer := 0;
  recipe_showing integer := 0;
  recipe_incomplete integer := 0;
  recipe_unavailable integer := 0;
  recipe_attention integer := 0;
  recipe_ready integer := 0;
  recipe_rows jsonb := '[]'::jsonb;

  supplier_total integer := 0;
  purchase_movements integer := 0;
  purchase_spend numeric := 0;
  purchase_rows jsonb := '[]'::jsonb;
  supplier_rows jsonb := '[]'::jsonb;
  price_rows jsonb := '[]'::jsonb;
  compare_purchase_movements integer := 0;
  compare_purchase_spend numeric := 0;

  waste_count integer := 0;
  waste_value numeric := 0;
  waste_rows jsonb := '[]'::jsonb;
  compare_waste_count integer := 0;
  compare_waste_value numeric := 0;

  shift_count integer := 0;
  shift_hours numeric := 0;
  shift_unpublished integer := 0;
  shift_rows jsonb := '[]'::jsonb;
  compare_shift_count integer := 0;
  compare_shift_hours numeric := 0;

  routine_count integer := 0;
  routine_completed integer := 0;
  routine_overdue integer := 0;
  routine_percent numeric := null;
  routine_rows jsonb := '[]'::jsonb;
  compare_routine_count integer := 0;
  compare_routine_completed integer := 0;
  compare_routine_percent numeric := null;
  temp_points integer := 0;
  temp_logs integer := 0;
  temp_out_of_range integer := 0;
  compare_temp_logs integer := 0;
  compare_temp_out_of_range integer := 0;

  knowledge_required integer := 0;
  knowledge_published integer := 0;
  knowledge_acknowledged integer := 0;
  knowledge_due integer := 0;
  training_required integer := 0;
  training_completed integer := 0;
  training_team jsonb := '[]'::jsonb;

  brain_open integer := 0;
  marketing_due integer := 0;

  sections jsonb := '[]'::jsonb;
  kpis jsonb := '[]'::jsonb;
  attention jsonb := '[]'::jsonb;
  sources jsonb := '[]'::jsonb;
  reports jsonb := '{}'::jsonb;
  filter_options jsonb := '{}'::jsonb;
begin
  if period_end < period_start then raise exception 'Report period end cannot be before period start'; end if;
  if period_end-period_start > 1095 then raise exception 'Report range cannot exceed three years'; end if;

  start_inclusive := period_start::timestamp at time zone 'Atlantic/Reykjavik';
  end_exclusive := (period_end+1)::timestamp at time zone 'Atlantic/Reykjavik';
  comparison_start_inclusive := case when p_comparison_start is null then null else p_comparison_start::timestamp at time zone 'Atlantic/Reykjavik' end;
  comparison_end_exclusive := case when p_comparison_end is null then null else (p_comparison_end+1)::timestamp at time zone 'Atlantic/Reykjavik' end;

  with raw_inventory as (
    select *
    from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,
      updated_at timestamptz,supplier_id uuid,supplier text,cost_price numeric,sku text,
      barcode text,bin_location text,size_ml numeric,active boolean,sell_price numeric,
      package_size text,brand text,subcategory text,needs_review boolean
    )
  ),
  classified as (
    select item.*,
      case
        when coalesce(quantity,0)<=0 then 'out_of_stock'
        when par_level is not null and par_level>0 and quantity<par_level then 'below_par'
        when cost_price is null or cost_price<=0 then 'missing_cost'
        when coalesce(nullif(trim(supplier),''),supplier_id::text) is null then 'missing_supplier'
        when par_level is null or par_level<=0 then 'missing_par'
        else 'ok'
      end as report_status
    from raw_inventory item
    where coalesce(active,true)=true
  ),
  filtered as (
    select * from classified item
    where (category_filter is null or lower(coalesce(item.category,''))=lower(category_filter))
      and (supplier_filter is null or lower(coalesce(item.supplier,''))=lower(supplier_filter))
      and (status_filter is null or item.report_status=status_filter)
      and (search_filter is null or concat_ws(' ',item.name,item.category,item.brand,item.subcategory,item.supplier,item.sku,item.barcode,item.bin_location) ilike '%'||search_filter||'%')
  )
  select
    count(*)::integer,
    coalesce(sum(case when quantity is not null and quantity>0 and cost_price is not null and cost_price>0 then quantity*cost_price else 0 end),0),
    count(*) filter (where report_status='below_par')::integer,
    count(*) filter (where report_status='out_of_stock')::integer,
    count(*) filter (where cost_price is null or cost_price<=0)::integer,
    count(*) filter (where coalesce(nullif(trim(supplier),''),supplier_id::text) is null)::integer,
    count(*) filter (where par_level is null or par_level<=0)::integer,
    count(*) filter (where updated_at>=generated_at_value-interval '7 days')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'name',name,'category',category,'brand',brand,'subcategory',subcategory,
      'quantity',quantity,'unit',unit,'par_level',par_level,'supplier',coalesce(supplier,'Unassigned'),
      'cost_price',cost_price,'estimated_value',case when cost_price>0 then greatest(quantity,0)*cost_price else null end,
      'status',report_status,'bin_location',bin_location,'needs_review',coalesce(needs_review,false),'updated_at',updated_at
    ) order by case report_status when 'out_of_stock' then 0 when 'below_par' then 1 when 'missing_cost' then 2 when 'missing_supplier' then 3 when 'missing_par' then 4 else 5 end,name),'[]'::jsonb)
  into inv_active,inv_value,inv_below_par,inv_out_stock,inv_missing_cost,inv_missing_supplier,inv_missing_par,inv_recently_updated,inv_rows
  from filtered;

  with raw_inventory as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,
      updated_at timestamptz,supplier_id uuid,supplier text,cost_price numeric,sku text,
      barcode text,bin_location text,size_ml numeric,active boolean,sell_price numeric,
      package_size text,brand text,subcategory text,needs_review boolean
    )
    where coalesce(active,true)=true
  )
  select coalesce(jsonb_agg(jsonb_build_object('category',category,'item_count',item_count,'estimated_value',estimated_value) order by estimated_value desc,category),'[]'::jsonb)
  into inv_categories
  from (
    select coalesce(nullif(trim(category),''),'Uncategorised') as category,
      count(*)::integer as item_count,
      coalesce(sum(case when cost_price>0 and quantity>0 then quantity*cost_price else 0 end),0) as estimated_value
    from raw_inventory
    group by coalesce(nullif(trim(category),''),'Uncategorised')
  ) category_rows;

  with inventory_raw as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,
      updated_at timestamptz,supplier_id uuid,supplier text,cost_price numeric,sku text,
      barcode text,bin_location text,size_ml numeric,active boolean,sell_price numeric,
      package_size text,brand text,subcategory text,needs_review boolean
    )
    where coalesce(active,true)=true
  ),
  inventory_norm as (
    select item.*,
      lower(coalesce(package_size,unit,'')) as pack_text,
      case
        when size_ml is not null and size_ml>0 then size_ml
        when lower(coalesce(package_size,unit,'')) ~ '[0-9]+([.,][0-9]+)?[[:space:]]*ml' then replace(regexp_replace(lower(coalesce(package_size,unit,'')),'.*?([0-9]+([.,][0-9]+)?)[[:space:]]*ml.*','\1'),',','.')::numeric
        when lower(coalesce(package_size,unit,'')) ~ '[0-9]+([.,][0-9]+)?[[:space:]]*l([^a-z]|$)' then replace(regexp_replace(lower(coalesce(package_size,unit,'')),'.*?([0-9]+([.,][0-9]+)?)[[:space:]]*l([^a-z]|$).*','\1'),',','.')::numeric*1000
        when lower(coalesce(package_size,unit,'')) ~ '[0-9]+([.,][0-9]+)?[[:space:]]*kg' then replace(regexp_replace(lower(coalesce(package_size,unit,'')),'.*?([0-9]+([.,][0-9]+)?)[[:space:]]*kg.*','\1'),',','.')::numeric*1000
        when lower(coalesce(package_size,unit,'')) ~ '[0-9]+([.,][0-9]+)?[[:space:]]*g' then replace(regexp_replace(lower(coalesce(package_size,unit,'')),'.*?([0-9]+([.,][0-9]+)?)[[:space:]]*g.*','\1'),',','.')::numeric
        else 1
      end as pack_quantity,
      case
        when size_ml is not null and size_ml>0 then 'ml'
        when lower(coalesce(package_size,unit,'')) ~ '[0-9]+([.,][0-9]+)?[[:space:]]*(ml|l([^a-z]|$))' then 'ml'
        when lower(coalesce(package_size,unit,'')) ~ '[0-9]+([.,][0-9]+)?[[:space:]]*(g|kg)' then 'g'
        else 'each'
      end as pack_unit
    from inventory_raw item
  ),
  recipe_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_recipes,'[]'::jsonb)) as recipe(
      id uuid,name text,type text,yield_quantity numeric,yield_unit text,menu_price numeric,
      show_on_menu boolean,updated_at timestamptz,active boolean,category_id uuid,
      happy_hour_price numeric,glass_price numeric,bottle_price numeric
    )
    where coalesce(active,true)=true
  ),
  ingredient_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_recipe_ingredients,'[]'::jsonb)) as ingredient(
      id uuid,recipe_id uuid,item_id uuid,item_name text,quantity numeric,unit text
    )
  ),
  ingredient_calc as (
    select ingredient.*,
      item.name as linked_item_name,item.quantity as item_stock,item.par_level,item.cost_price,item.pack_quantity,item.pack_unit,
      case lower(coalesce(ingredient.unit,''))
        when 'l' then ingredient.quantity*1000 when 'lt' then ingredient.quantity*1000
        when 'liter' then ingredient.quantity*1000 when 'litre' then ingredient.quantity*1000
        when 'kg' then ingredient.quantity*1000 else ingredient.quantity
      end as ingredient_base_quantity,
      case lower(coalesce(ingredient.unit,''))
        when 'l' then 'ml' when 'lt' then 'ml' when 'liter' then 'ml' when 'litre' then 'ml'
        when 'ml' then 'ml' when 'kg' then 'g' when 'g' then 'g' else 'each'
      end as ingredient_base_unit
    from ingredient_input ingredient
    left join inventory_norm item on item.id=ingredient.item_id
  ),
  recipe_calc as (
    select recipe.id,recipe.name,recipe.type,recipe.show_on_menu,recipe.menu_price,recipe.happy_hour_price,
      recipe.glass_price,recipe.bottle_price,recipe.updated_at,greatest(coalesce(recipe.yield_quantity,1),0.0001) as yield_quantity,
      count(ingredient.id)::integer as ingredient_count,
      count(ingredient.id) filter (where ingredient.item_id is null or ingredient.linked_item_name is null)::integer as missing_links,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and (ingredient.cost_price is null or ingredient.cost_price<=0))::integer as missing_costs,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and ingredient.item_stock<=0)::integer as out_items,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and ingredient.par_level>0 and ingredient.item_stock<ingredient.par_level)::integer as below_par_items,
      count(ingredient.id) filter (where ingredient.linked_item_name is not null and ingredient.pack_unit<>ingredient.ingredient_base_unit)::integer as incompatible_units,
      sum(case when ingredient.cost_price>0 and ingredient.pack_quantity>0 and ingredient.pack_unit=ingredient.ingredient_base_unit
        then ingredient.cost_price*(ingredient.ingredient_base_quantity/ingredient.pack_quantity) else 0 end) as batch_cost,
      min(case when ingredient.item_stock is not null and ingredient.pack_quantity>0 and ingredient.ingredient_base_quantity>0 and ingredient.pack_unit=ingredient.ingredient_base_unit
        then floor((ingredient.item_stock*ingredient.pack_quantity/ingredient.ingredient_base_quantity)*greatest(coalesce(recipe.yield_quantity,1),0.0001)) else null end) as servings_available,
      min(case when ingredient.item_stock is not null and ingredient.pack_quantity>0 and ingredient.ingredient_base_quantity>0 and ingredient.pack_unit=ingredient.ingredient_base_unit
        then (ingredient.item_stock*ingredient.pack_quantity/ingredient.ingredient_base_quantity) end) as limiting_ratio
    from recipe_input recipe
    left join ingredient_calc ingredient on ingredient.recipe_id=recipe.id
    group by recipe.id,recipe.name,recipe.type,recipe.show_on_menu,recipe.menu_price,recipe.happy_hour_price,recipe.glass_price,recipe.bottle_price,recipe.updated_at,recipe.yield_quantity
  ),
  classified as (
    select recipe.*,
      case
        when ingredient_count=0 or missing_links>0 or incompatible_units>0 then 'incomplete_setup'
        when out_items>0 or coalesce(servings_available,0)<=0 then 'unavailable'
        when missing_costs>0 or below_par_items>0 then 'needs_attention'
        else 'ready'
      end as availability_state,
      case when ingredient_count>0 and missing_costs=0 and missing_links=0 and incompatible_units=0 then batch_cost/yield_quantity else null end as estimated_cost_per_serving,
      case when menu_price>0 and ingredient_count>0 and missing_costs=0 and missing_links=0 and incompatible_units=0
        then menu_price-(batch_cost/yield_quantity) else null end as estimated_gross_profit,
      case when menu_price>0 and ingredient_count>0 and missing_costs=0 and missing_links=0 and incompatible_units=0
        then ((menu_price-(batch_cost/yield_quantity))/menu_price)*100 else null end as estimated_margin_percent
    from recipe_calc recipe
  ),
  filtered as (
    select * from classified recipe
    where (category_filter is null or lower(coalesce(recipe.type,''))=lower(category_filter))
      and (status_filter is null or recipe.availability_state=status_filter)
      and (search_filter is null or concat_ws(' ',recipe.name,recipe.type) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    count(*) filter (where show_on_menu=true)::integer,
    count(*) filter (where availability_state='incomplete_setup')::integer,
    count(*) filter (where availability_state='unavailable')::integer,
    count(*) filter (where availability_state='needs_attention')::integer,
    count(*) filter (where availability_state='ready')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'name',name,'type',type,'show_on_menu',show_on_menu,'menu_price',menu_price,
      'happy_hour_price',happy_hour_price,'glass_price',glass_price,'bottle_price',bottle_price,
      'availability_state',availability_state,'ingredient_count',ingredient_count,'missing_links',missing_links,
      'missing_costs',missing_costs,'incompatible_units',incompatible_units,'below_par_items',below_par_items,
      'out_items',out_items,'estimated_cost_per_serving',estimated_cost_per_serving,
      'estimated_gross_profit',estimated_gross_profit,'estimated_margin_percent',estimated_margin_percent,
      'estimated_servings_available',servings_available,'updated_at',updated_at
    ) order by case availability_state when 'unavailable' then 0 when 'incomplete_setup' then 1 when 'needs_attention' then 2 else 3 end,name),'[]'::jsonb)
  into recipe_active,recipe_showing,recipe_incomplete,recipe_unavailable,recipe_attention,recipe_ready,recipe_rows
  from filtered;

  with suppliers_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_suppliers,'[]'::jsonb)) as supplier(
      id uuid,name text,contact_name text,email text,phone text,notes text,active boolean,created_at timestamptz,updated_at timestamptz
    )
  )
  select count(*)::integer into supplier_total from suppliers_input where coalesce(active,true)=true;

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  supplier_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_suppliers,'[]'::jsonb)) as supplier(
      id uuid,name text,contact_name text,email text,phone text,notes text,active boolean,created_at timestamptz,updated_at timestamptz
    )
  ),
  period_rows as (
    select movement.*,supplier.name as supplier_name
    from movement_input movement
    left join supplier_input supplier on supplier.id=movement.supplier_id
    where movement.created_at>=start_inclusive and movement.created_at<end_exclusive
      and (supplier_filter is null or lower(coalesce(supplier.name,''))=lower(supplier_filter))
      and (search_filter is null or concat_ws(' ',movement.item_name,movement.movement_type,movement.note,supplier.name) ilike '%'||search_filter||'%')
  )
  select count(*) filter (where coalesce(total_cost,0)>0)::integer,
    coalesce(sum(greatest(coalesce(total_cost,0),0)),0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'item_id',item_id,'item_name',item_name,'movement_type',movement_type,
      'quantity_change',quantity_change,'unit_cost',unit_cost,'total_cost',total_cost,
      'supplier',coalesce(supplier_name,'Unassigned'),'created_at',created_at,'note',note
    ) order by created_at desc),'[]'::jsonb)
  into purchase_movements,purchase_spend,purchase_rows
  from period_rows;

  if comparison_start_inclusive is not null and comparison_end_exclusive is not null then
    with movement_input as (
      select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
        id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
        supplier_id uuid,note text,created_by uuid,created_at timestamptz
      )
    )
    select count(*) filter (where coalesce(total_cost,0)>0)::integer,
      coalesce(sum(greatest(coalesce(total_cost,0),0)),0)
    into compare_purchase_movements,compare_purchase_spend
    from movement_input
    where created_at>=comparison_start_inclusive and created_at<comparison_end_exclusive;
  end if;

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  supplier_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_suppliers,'[]'::jsonb)) as supplier(
      id uuid,name text,contact_name text,email text,phone text,notes text,active boolean,created_at timestamptz,updated_at timestamptz
    )
  ),
  inventory_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_inventory,'[]'::jsonb)) as item(
      id uuid,name text,category text,quantity numeric,unit text,par_level numeric,updated_at timestamptz,
      supplier_id uuid,supplier text,cost_price numeric,sku text,barcode text,bin_location text,size_ml numeric,
      active boolean,sell_price numeric,package_size text,brand text,subcategory text,needs_review boolean
    )
  ),
  supplier_names as (
    select supplier.id,supplier.name from supplier_input supplier
    union all
    select distinct item.supplier_id,item.supplier from inventory_input item where item.supplier_id is not null and item.supplier is not null
  ),
  grouped as (
    select coalesce(name,'Unassigned') as supplier_name,
      count(movement.id) filter (where movement.created_at>=start_inclusive and movement.created_at<end_exclusive)::integer as movement_count,
      coalesce(sum(greatest(coalesce(movement.total_cost,0),0)) filter (where movement.created_at>=start_inclusive and movement.created_at<end_exclusive),0) as spend,
      max(movement.created_at) as last_movement_at,
      (select count(*)::integer from inventory_input item where item.active=true and (item.supplier_id=supplier_names.id or lower(coalesce(item.supplier,''))=lower(coalesce(supplier_names.name,'')))) as active_item_count
    from supplier_names
    left join movement_input movement on movement.supplier_id=supplier_names.id
    group by supplier_names.id,supplier_names.name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplier',supplier_name,'movement_count',movement_count,'spend',spend,
    'active_item_count',active_item_count,'last_movement_at',last_movement_at
  ) order by spend desc,active_item_count desc,supplier_name),'[]'::jsonb)
  into supplier_rows
  from grouped
  where (supplier_filter is null or lower(supplier_name)=lower(supplier_filter))
    and (search_filter is null or supplier_name ilike '%'||search_filter||'%');

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  ranked as (
    select movement.*,
      lag(unit_cost) over (partition by item_id order by created_at) as previous_unit_cost
    from movement_input movement
    where unit_cost is not null and unit_cost>0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_id',item_id,'item_name',item_name,'current_unit_cost',unit_cost,'previous_unit_cost',previous_unit_cost,
    'absolute_change',case when previous_unit_cost is null then null else unit_cost-previous_unit_cost end,
    'percentage_change',case when previous_unit_cost>0 then ((unit_cost-previous_unit_cost)/previous_unit_cost)*100 else null end,
    'effective_at',created_at
  ) order by abs(coalesce(unit_cost-previous_unit_cost,0)) desc,created_at desc),'[]'::jsonb)
  into price_rows
  from ranked
  where created_at>=start_inclusive and created_at<end_exclusive
    and previous_unit_cost is not null;

  with movement_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
      id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
      supplier_id uuid,note text,created_by uuid,created_at timestamptz
    )
  ),
  period_waste as (
    select * from movement_input movement
    where created_at>=start_inclusive and created_at<end_exclusive
      and lower(movement_type) in ('waste','variance','spoilage','breakage','loss')
      and (search_filter is null or concat_ws(' ',item_name,movement_type,note) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    coalesce(sum(coalesce(abs(total_cost),abs(quantity_change)*coalesce(unit_cost,0))),0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'item_id',item_id,'item_name',item_name,'movement_type',movement_type,
      'quantity_change',quantity_change,'estimated_value',coalesce(abs(total_cost),abs(quantity_change)*coalesce(unit_cost,0)),
      'created_at',created_at,'note',note
    ) order by created_at desc),'[]'::jsonb)
  into waste_count,waste_value,waste_rows
  from period_waste;

  if comparison_start_inclusive is not null and comparison_end_exclusive is not null then
    with movement_input as (
      select * from pg_catalog.jsonb_to_recordset(coalesce(p_movements,'[]'::jsonb)) as movement(
        id uuid,item_id uuid,item_name text,movement_type text,quantity_change numeric,unit_cost numeric,total_cost numeric,
        supplier_id uuid,note text,created_by uuid,created_at timestamptz
      )
    )
    select count(*)::integer,
      coalesce(sum(coalesce(abs(total_cost),abs(quantity_change)*coalesce(unit_cost,0))),0)
    into compare_waste_count,compare_waste_value
    from movement_input
    where created_at>=comparison_start_inclusive and created_at<comparison_end_exclusive
      and lower(movement_type) in ('waste','variance','spoilage','breakage','loss');
  end if;

  with shifts as (
    select entry.*,person.display_name,person.profile_id
    from atlas_private.shift_entries entry
    join atlas_private.shift_people person on person.id=entry.person_id
    where entry.active=true and entry.starts_at>=start_inclusive and entry.starts_at<end_exclusive
      and (is_manager or person.profile_id=p_actor_id)
      and (employee_filter is null or person.id::text=employee_filter or person.profile_id::text=employee_filter or lower(person.display_name)=lower(employee_filter))
      and (status_filter is null or (status_filter='published' and entry.last_published_revision is not null) or (status_filter='draft' and entry.last_published_revision is null))
      and (search_filter is null or concat_ws(' ',person.display_name,entry.role_name,entry.note) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    coalesce(sum(greatest(0,extract(epoch from (ends_at-starts_at))/3600-(break_minutes::numeric/60))),0),
    count(*) filter (where last_published_revision is null)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'person_id',person_id,'profile_id',profile_id,
      'person_label',case when is_manager then display_name else 'Your shift' end,
      'role_name',role_name,'starts_at',starts_at,'ends_at',ends_at,'break_minutes',break_minutes,
      'planned_hours',greatest(0,extract(epoch from (ends_at-starts_at))/3600-(break_minutes::numeric/60)),
      'published',last_published_revision is not null,'note',case when is_manager then note else null end
    ) order by starts_at),'[]'::jsonb)
  into shift_count,shift_hours,shift_unpublished,shift_rows
  from shifts;

  if comparison_start_inclusive is not null and comparison_end_exclusive is not null then
    with shifts as (
      select entry.* from atlas_private.shift_entries entry
      join atlas_private.shift_people person on person.id=entry.person_id
      where entry.active=true and entry.starts_at>=comparison_start_inclusive and entry.starts_at<comparison_end_exclusive
        and (is_manager or person.profile_id=p_actor_id)
    )
    select count(*)::integer,
      coalesce(sum(greatest(0,extract(epoch from (ends_at-starts_at))/3600-(break_minutes::numeric/60))),0)
    into compare_shift_count,compare_shift_hours
    from shifts;
  end if;

  with routines as (
    select instance.*,template.name as template_name,template.routine_type,template.requires_manager_signoff
    from atlas_private.routine_instances instance
    join atlas_private.routine_templates template on template.id=instance.template_id
    where instance.scheduled_date between period_start and period_end
      and (status_filter is null or instance.status=status_filter)
      and (search_filter is null or concat_ws(' ',template.name,template.routine_type,instance.status,instance.assigned_to_label) ilike '%'||search_filter||'%')
  )
  select count(*)::integer,
    count(*) filter (where status='completed' or completed_at is not null)::integer,
    count(*) filter (where status='overdue')::integer,
    case when count(*)=0 then null else round((count(*) filter (where status='completed' or completed_at is not null))::numeric/count(*)::numeric*100,1) end,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'template_name',template_name,'routine_type',routine_type,'scheduled_date',scheduled_date,
      'status',status,'assigned_to_label',assigned_to_label,'completed_at',completed_at,
      'completed_by_label',case when is_manager then completed_by_label else null end,
      'requires_manager_signoff',requires_manager_signoff,'manager_signed_off_at',manager_signed_off_at
    ) order by scheduled_date desc,template_name),'[]'::jsonb)
  into routine_count,routine_completed,routine_overdue,routine_percent,routine_rows
  from routines;

  if p_comparison_start is not null and p_comparison_end is not null then
    with routines as (
      select instance.* from atlas_private.routine_instances instance
      where instance.scheduled_date between p_comparison_start and p_comparison_end
    )
    select count(*)::integer,
      count(*) filter (where status='completed' or completed_at is not null)::integer,
      case when count(*)=0 then null else round((count(*) filter (where status='completed' or completed_at is not null))::numeric/count(*)::numeric*100,1) end
    into compare_routine_count,compare_routine_completed,compare_routine_percent
    from routines;
  end if;

  select count(*)::integer into temp_points from atlas_private.temperature_points where active=true;
  select count(*)::integer,count(*) filter (where range_status<>'in_range')::integer
  into temp_logs,temp_out_of_range
  from atlas_private.temperature_logs where reading_date between period_start and period_end;

  if p_comparison_start is not null and p_comparison_end is not null then
    select count(*)::integer,count(*) filter (where range_status<>'in_range')::integer
    into compare_temp_logs,compare_temp_out_of_range
    from atlas_private.temperature_logs where reading_date between p_comparison_start and p_comparison_end;
  end if;

  select count(*)::integer,count(*) filter (where required=true)::integer
  into knowledge_published,knowledge_required
  from atlas_private.knowledge_articles article
  where status='published' and (is_manager or 'all'=any(target_roles) or p_actor_role=any(target_roles));

  select count(*)::integer into knowledge_acknowledged
  from atlas_private.knowledge_acknowledgements acknowledgement
  join atlas_private.knowledge_articles article on article.id=acknowledgement.article_id
  where article.status='published' and (is_manager or acknowledgement.user_id=p_actor_id);

  select count(*)::integer into knowledge_due
  from atlas_private.knowledge_articles article
  join atlas_private.knowledge_article_versions version on version.id=article.current_version_id
  where article.status='published' and article.required=true
    and (is_manager or 'all'=any(article.target_roles) or p_actor_role=any(article.target_roles))
    and not exists (
      select 1 from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.article_id=article.id and acknowledgement.version_id=version.id and acknowledgement.user_id=p_actor_id
    );

  with tasks_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_tasks,'[]'::jsonb)) as task(
      id uuid,title text,description text,category text,sort_order integer,required boolean,active boolean
    )
  ),
  progress_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_progress,'[]'::jsonb)) as progress(
      id uuid,task_id uuid,user_id uuid,completed_at timestamptz,completed_by uuid,note text
    )
  ),
  profiles_input as (
    select * from pg_catalog.jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,email text,display_name text,role text,active boolean
    )
  )
  select
    (select count(*)::integer from tasks_input where active=true and required=true),
    (select count(*)::integer from tasks_input task where task.active=true and task.required=true and exists (
      select 1 from progress_input progress where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
    )),
    case when is_manager then coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id',profile.id,'name',coalesce(nullif(trim(profile.display_name),''),nullif(split_part(coalesce(profile.email,''),'@',1),''),'Team member'),
        'role',profile.role,'required_total',(select count(*)::integer from tasks_input where active=true and required=true),
        'required_completed',(select count(*)::integer from tasks_input task where task.active=true and task.required=true and exists (
          select 1 from progress_input progress where progress.task_id=task.id and progress.user_id=profile.id and progress.completed_at is not null
        ))
      ) order by coalesce(profile.display_name,profile.email)) from profiles_input profile where profile.active=true
    ),'[]'::jsonb) else '[]'::jsonb end
  into training_required,training_completed,training_team;

  select count(*)::integer into brain_open from atlas_private.brain_recommendations
  where status in ('active','new','open') and generated_at>=start_inclusive and generated_at<end_exclusive;

  select count(*)::integer into marketing_due from atlas_private.marketing_content_items
  where status not in ('published','completed','cancelled','archived')
    and coalesce(scheduled_for,reminder_at,event_starts_at)>=start_inclusive
    and coalesce(scheduled_for,reminder_at,event_starts_at)<end_exclusive;

  kpis := jsonb_build_array(
    jsonb_build_object('key','inventory_value','label','Estimated inventory value','value',case when inv_active=0 then null else inv_value end,'unit','ISK','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when inv_active=0 then 'unavailable' when inv_missing_cost>0 then 'partial' else 'complete' end,'detail','Active quantity × current item cost. Missing costs are excluded.','section','inventory'),
    jsonb_build_object('key','stock_alerts','label','Stock alerts','value',case when inv_active=0 then null else inv_below_par+inv_out_stock end,'unit','count','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when inv_active=0 then 'unavailable' else 'complete' end,'detail','Out-of-stock and below-par active items.','section','inventory'),
    jsonb_build_object('key','recipes_attention','label','Recipes needing attention','value',case when recipe_active=0 then null else recipe_unavailable+recipe_incomplete+recipe_attention end,'unit','count','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when recipe_active=0 then 'unavailable' else 'partial' end,'detail','Unavailable, incomplete, missing-cost or below-par ingredient recipes.','section','recipes'),
    jsonb_build_object('key','purchasing_spend','label','Purchasing spend','value',purchase_spend,'unit','ISK','comparison_value',case when comparison_start_inclusive is null then null else compare_purchase_spend end,'change_value',case when comparison_start_inclusive is null then null else purchase_spend-compare_purchase_spend end,'change_percent',case when comparison_start_inclusive is null or compare_purchase_spend=0 then null else ((purchase_spend-compare_purchase_spend)/compare_purchase_spend)*100 end,'trend',case when comparison_start_inclusive is null then 'none' when purchase_spend>compare_purchase_spend then 'up' when purchase_spend<compare_purchase_spend then 'down' else 'flat' end,'status',case when purchase_movements=0 then 'no_data_for_period' else 'complete' end,'detail','Costed inventory movement totals; not a purchase-order ledger.','section','purchasing'),
    jsonb_build_object('key','scheduled_hours','label',case when is_manager then 'Scheduled labour hours' else 'Your scheduled hours' end,'value',round(shift_hours,2),'unit','hours','comparison_value',case when comparison_start_inclusive is null then null else round(compare_shift_hours,2) end,'change_value',case when comparison_start_inclusive is null then null else round(shift_hours-compare_shift_hours,2) end,'change_percent',case when comparison_start_inclusive is null or compare_shift_hours=0 then null else ((shift_hours-compare_shift_hours)/compare_shift_hours)*100 end,'trend',case when comparison_start_inclusive is null then 'none' when shift_hours>compare_shift_hours then 'up' when shift_hours<compare_shift_hours then 'down' else 'flat' end,'status',case when shift_count=0 then 'no_data_for_period' else 'complete' end,'detail',case when is_manager then 'Active scheduled shift entries.' else 'Only shifts linked to your profile.' end,'section','labour'),
    jsonb_build_object('key','checklist_completion','label','Checklist completion','value',routine_percent,'unit','percent','comparison_value',compare_routine_percent,'change_value',case when routine_percent is null or compare_routine_percent is null then null else routine_percent-compare_routine_percent end,'change_percent',null,'trend',case when routine_percent is null or compare_routine_percent is null then 'none' when routine_percent>compare_routine_percent then 'up' when routine_percent<compare_routine_percent then 'down' else 'flat' end,'status',case when routine_count=0 then 'no_data_for_period' else 'complete' end,'detail','Completed routines ÷ scheduled routines.','section','operations'),
    jsonb_build_object('key','required_reading_due','label','Required reading due','value',knowledge_due,'unit','count','comparison_value',null,'change_value',null,'change_percent',null,'trend','not_comparable','status',case when knowledge_required=0 then 'no_data_for_period' else 'complete' end,'detail','Current published versions requiring your acknowledgement.','section','knowledge')
  );

  sections := jsonb_build_array(
    jsonb_build_object('key','overview','name','Overview','status','connected','description','Operational overview across connected Atlas modules.'),
    jsonb_build_object('key','sales','name','Sales','status','not_connected','description','Sales integration is not available. No revenue or order values are invented.'),
    jsonb_build_object('key','inventory','name','Inventory','status',case when inv_active=0 then 'no_records' when inv_missing_cost>0 or inv_missing_par>0 then 'partial' else 'connected' end,'description','Live inventory quantities, par levels and valuation readiness.'),
    jsonb_build_object('key','recipes','name','Menu & Recipes','status',case when recipe_active=0 then 'no_records' when recipe_incomplete>0 or recipe_attention>0 then 'partial' else 'connected' end,'description','Recipe availability, costing and setup quality.'),
    jsonb_build_object('key','purchasing','name','Purchasing','status',case when purchase_movements=0 then 'no_records' else 'partial' end,'description','Costed inventory movement spend; purchase orders are not connected.'),
    jsonb_build_object('key','suppliers','name','Suppliers','status',case when supplier_total=0 then 'no_records' else 'connected' end,'description','Supplier profiles, linked inventory, spend and price movements.'),
    jsonb_build_object('key','waste','name','Waste & Variance','status',case when waste_count=0 then 'no_records' else 'connected' end,'description','Only explicitly recorded waste and variance movements.'),
    jsonb_build_object('key','labour','name','Labour & Shifts','status',case when shift_count=0 then 'no_records' else 'connected' end,'description',case when is_manager then 'Scheduled hours and shift coverage.' else 'Your scheduled shift information only.' end),
    jsonb_build_object('key','operations','name','Operations','status',case when routine_count=0 and temp_logs=0 then 'no_records' else 'connected' end,'description','Routines, checklist completion and temperature evidence.'),
    jsonb_build_object('key','knowledge','name','Knowledge & Training','status',case when knowledge_published=0 and training_required=0 then 'no_records' else 'connected' end,'description','Required reading and onboarding progress.'),
    jsonb_build_object('key','saved','name','Saved Reports','status','not_connected','description','Saved report persistence is not enabled yet.'),
    jsonb_build_object('key','exports','name','Exports','status','connected','description','CSV, print view and copy summary for visible rows.')
  );

  select coalesce(jsonb_agg(item),'[]'::jsonb) into attention
  from (values
    (case when inv_out_stock>0 then jsonb_build_object('key','inventory-out-stock','tone','danger','title',inv_out_stock::text||' items are out of stock','detail','Review quantity, par and supplier assignment.','section','inventory','source','Inventory') end),
    (case when inv_below_par>0 then jsonb_build_object('key','inventory-below-par','tone','warn','title',inv_below_par::text||' items are below par','detail','Below-par stock may create service and purchasing risk.','section','inventory','source','Inventory') end),
    (case when inv_missing_cost>0 then jsonb_build_object('key','inventory-missing-cost','tone','warn','title',inv_missing_cost::text||' inventory items are missing costs','detail','Those items are excluded from valuation.','section','inventory','source','Inventory') end),
    (case when recipe_unavailable>0 then jsonb_build_object('key','recipes-unavailable','tone','danger','title',recipe_unavailable::text||' recipes appear unavailable','detail','Linked ingredients currently have no available stock.','section','recipes','source','Recipes') end),
    (case when recipe_incomplete>0 then jsonb_build_object('key','recipes-incomplete','tone','warn','title',recipe_incomplete::text||' recipes need setup completion','detail','Missing links or incompatible units prevent full analysis.','section','recipes','source','Recipes') end),
    (case when routine_overdue>0 then jsonb_build_object('key','operations-overdue','tone','danger','title',routine_overdue::text||' operational routines are overdue','detail','Reports is read-only; complete work in Operations.','section','operations','source','Operations') end),
    (case when temp_points>0 and temp_logs=0 then jsonb_build_object('key','temperature-missing','tone','warn','title','No temperature logs recorded in this period','detail','Daily temperature records are required for safety evidence.','section','operations','source','Operations') end),
    (case when shift_unpublished>0 and is_manager then jsonb_build_object('key','shifts-unpublished','tone','warn','title',shift_unpublished::text||' shift entries are not published','detail','Staff see only published schedule revisions.','section','labour','source','Shifts') end),
    (case when knowledge_due>0 then jsonb_build_object('key','knowledge-due','tone','warn','title',knowledge_due::text||' Knowledge acknowledgements are due','detail','Acknowledgements are version-specific.','section','knowledge','source','Knowledge') end),
    (case when brain_open>0 and is_manager then jsonb_build_object('key','brain-open','tone','neutral','title',brain_open::text||' Atlas Brain recommendations are open','detail','Review their evidence and confidence in Atlas Brain.','section','overview','source','Atlas Brain') end),
    (case when marketing_due>0 and is_manager then jsonb_build_object('key','marketing-due','tone','neutral','title',marketing_due::text||' marketing items are due in this period','detail','Review content planning and approvals in Marketing.','section','overview','source','Marketing') end)
  ) as attention_items(item) where item is not null;

  sources := jsonb_build_array(
    jsonb_build_object('key','sales','name','Sales integration','status','not_connected','last_refreshed_at',null,'records_included',0,'records_excluded',0,'note','Sales integration is unavailable. Revenue and order values are not invented.'),
    jsonb_build_object('key','inventory','name','Inventory','status',case when jsonb_array_length(coalesce(p_inventory,'[]'::jsonb))=0 then 'no_records' when inv_missing_cost>0 then 'partial' else 'connected' end,'last_refreshed_at',(select max((item->>'updated_at')::timestamptz) from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item),'records_included',jsonb_array_length(coalesce(p_inventory,'[]'::jsonb)),'records_excluded',inv_missing_cost,'note','Valuation excludes records missing current cost.'),
    jsonb_build_object('key','recipes','name','Recipes','status',case when jsonb_array_length(coalesce(p_recipes,'[]'::jsonb))=0 then 'no_records' when recipe_incomplete>0 then 'partial' else 'connected' end,'last_refreshed_at',(select max((item->>'updated_at')::timestamptz) from jsonb_array_elements(coalesce(p_recipes,'[]'::jsonb)) item),'records_included',jsonb_array_length(coalesce(p_recipes,'[]'::jsonb)),'records_excluded',recipe_incomplete,'note','Availability uses linked ingredients and current stock.'),
    jsonb_build_object('key','purchasing','name','Purchasing / receiving','status',case when jsonb_array_length(coalesce(p_movements,'[]'::jsonb))=0 then 'no_records' else 'partial' end,'last_refreshed_at',(select max((item->>'created_at')::timestamptz) from jsonb_array_elements(coalesce(p_movements,'[]'::jsonb)) item),'records_included',purchase_movements,'records_excluded',0,'note','Purchase-order tables are not connected; spend is from costed inventory movements.'),
    jsonb_build_object('key','shifts','name','Shifts','status',case when shift_count=0 then 'no_records' else 'connected' end,'last_refreshed_at',(select max(updated_at) from atlas_private.shift_entries),'records_included',shift_count,'records_excluded',case when is_manager then 0 else (select count(*) from atlas_private.shift_entries entry join atlas_private.shift_people person on person.id=entry.person_id where entry.active=true and entry.starts_at>=start_inclusive and entry.starts_at<end_exclusive and person.profile_id is distinct from p_actor_id) end,'note',case when is_manager then 'Manager view includes visible schedule rows.' else 'Other employees are excluded by permission.' end),
    jsonb_build_object('key','operations','name','Operations','status',case when routine_count=0 and temp_logs=0 then 'no_records' else 'connected' end,'last_refreshed_at',greatest(coalesce((select max(updated_at) from atlas_private.routine_instances),'1970-01-01'::timestamptz),coalesce((select max(created_at) from atlas_private.temperature_logs),'1970-01-01'::timestamptz)),'records_included',routine_count+temp_logs,'records_excluded',0,'note','Reports cannot complete checklist steps.'),
    jsonb_build_object('key','knowledge','name','Knowledge & Training','status',case when knowledge_published=0 and training_required=0 then 'no_records' else 'connected' end,'last_refreshed_at',(select max(updated_at) from atlas_private.knowledge_articles),'records_included',knowledge_published+training_required,'records_excluded',0,'note','Employee detail remains permission-controlled.')
  );

  reports := jsonb_build_object(
    'overview',jsonb_build_object('summary',jsonb_build_object(
      'business_performance','Sales integration is not connected, so Reports avoids revenue, order and product-sales claims.',
      'service_readiness',case when routine_count=0 then 'No operational routines in this period.' else routine_completed::text||' of '||routine_count::text||' routines completed.' end,
      'stock_risk',case when inv_active=0 then 'No active inventory records.' else (inv_below_par+inv_out_stock)::text||' inventory alerts.' end,
      'data_complete_enough',jsonb_array_length(coalesce(p_inventory,'[]'::jsonb))>0 or routine_count>0 or shift_count>0 or knowledge_published>0
    )),
    'sales',jsonb_build_object('status','not_connected','message','Sales integration is not available. No sample revenue, tax, discounts, refunds, payment methods or product-sales charts are displayed.'),
    'inventory',jsonb_build_object('summary',jsonb_build_object('active_items',inv_active,'estimated_value',inv_value,'below_par',inv_below_par,'out_of_stock',inv_out_stock,'missing_cost',inv_missing_cost,'missing_supplier',inv_missing_supplier,'missing_par',inv_missing_par,'recently_updated',inv_recently_updated),'formula','Estimated inventory value = sum of active item quantity × current item cost. Missing-cost items are excluded and counted separately.','rows',inv_rows,'categories',inv_categories),
    'recipes',jsonb_build_object('summary',jsonb_build_object('active_recipes',recipe_active,'shown_on_menu',recipe_showing,'ready',recipe_ready,'needs_attention',recipe_attention,'unavailable',recipe_unavailable,'incomplete_setup',recipe_incomplete),'formula','Recipe cost uses linked ingredient quantity ÷ package quantity × current item cost, divided by recipe yield. Availability uses current stock and compatible units.','rows',recipe_rows),
    'purchasing',jsonb_build_object('summary',jsonb_build_object('spend',purchase_spend,'movement_count',purchase_movements,'open_purchase_orders',null,'overdue_orders',null,'receiving_differences',null),'comparison',jsonb_build_object('spend',compare_purchase_spend,'movement_count',compare_purchase_movements),'formula','Purchasing spend is positive total_cost on inventory movement records. Purchase-order metrics remain unavailable.','rows',purchase_rows,'price_changes',price_rows),
    'suppliers',jsonb_build_object('summary',jsonb_build_object('active_suppliers',supplier_total,'supplier_rows',jsonb_array_length(supplier_rows)),'rows',supplier_rows,'permission_note',case when is_manager then 'Manager view includes costed movement spend.' else 'Confidential commercial terms are not loaded.' end),
    'waste',jsonb_build_object('summary',jsonb_build_object('recorded_waste_count',waste_count,'estimated_waste_value',waste_value),'comparison',jsonb_build_object('recorded_waste_count',compare_waste_count,'estimated_waste_value',compare_waste_value),'formula','Only movements explicitly labelled waste, variance, spoilage, breakage or loss are included. Reports does not infer waste from sales.','rows',waste_rows),
    'labour',jsonb_build_object('summary',jsonb_build_object('shift_count',shift_count,'scheduled_hours',round(shift_hours,2),'unpublished_shift_entries',case when is_manager then shift_unpublished else null end),'comparison',jsonb_build_object('shift_count',compare_shift_count,'scheduled_hours',round(compare_shift_hours,2)),'rows',shift_rows,'permission_note',case when is_manager then 'Employee-level schedule rows are manager-only.' else 'Only your shifts are loaded.' end),
    'operations',jsonb_build_object('summary',jsonb_build_object('routine_count',routine_count,'completed_routines',routine_completed,'overdue_routines',routine_overdue,'completion_percent',routine_percent,'temperature_points',temp_points,'temperature_logs',temp_logs,'temperature_out_of_range',temp_out_of_range),'comparison',jsonb_build_object('routine_count',compare_routine_count,'completed_routines',compare_routine_completed,'completion_percent',compare_routine_percent,'temperature_logs',compare_temp_logs,'temperature_out_of_range',compare_temp_out_of_range),'formula','Checklist completion = completed routine instances ÷ scheduled routine instances.','rows',routine_rows),
    'knowledge',jsonb_build_object('summary',jsonb_build_object('published_articles',knowledge_published,'required_articles',knowledge_required,'acknowledgements',knowledge_acknowledged,'required_due_for_current_user',knowledge_due,'training_required_total',training_required,'training_completed_for_current_user',training_completed),'team',training_team,'permission_note',case when is_manager then 'Managers can view team completion.' else 'Staff see only their own training state.' end),
    'saved',jsonb_build_object('status','not_connected','message','Saved Reports persistence is not enabled in this checkpoint.'),
    'exports',jsonb_build_object('status','connected','formats',jsonb_build_array('CSV','Print','Copy summary'),'message','Exports use visible rows and include period, filters, currency and data-quality notes.')
  );

  filter_options := jsonb_build_object(
    'categories',coalesce((select jsonb_agg(value order by value) from (select distinct nullif(trim(item->>'category'),'') as value from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item where nullif(trim(item->>'category'),'') is not null) valueset),'[]'::jsonb),
    'suppliers',coalesce((select jsonb_agg(value order by value) from (select distinct nullif(trim(item->>'name'),'') as value from jsonb_array_elements(coalesce(p_suppliers,'[]'::jsonb)) item where nullif(trim(item->>'name'),'') is not null) valueset),'[]'::jsonb),
    'employees',case when is_manager then coalesce((select jsonb_agg(jsonb_build_object('id',person.id,'name',person.display_name) order by person.display_name) from atlas_private.shift_people person where person.active=true),'[]'::jsonb) else '[]'::jsonb end,
    'statuses',jsonb_build_array('ok','below_par','out_of_stock','missing_cost','missing_supplier','missing_par','ready','needs_attention','unavailable','incomplete_setup','published','draft','completed','overdue')
  );

  return jsonb_build_object(
    'version','atlas-reports/0.2.0','generated_at',generated_at_value,'timezone','Atlantic/Reykjavik','currency','ISK',
    'period',jsonb_build_object('start',period_start,'end',period_end,'label',to_char(period_start,'DD Mon YYYY')||' – '||to_char(period_end,'DD Mon YYYY')),
    'comparison',jsonb_build_object('key',coalesce(p_comparison_key,'previous_period'),'start',p_comparison_start,'end',p_comparison_end,'enabled',p_comparison_start is not null and p_comparison_end is not null),
    'filters',coalesce(p_filters,'{}'::jsonb),'filter_options',filter_options,'sections',sections,'kpis',kpis,
    'attention',attention,'data_sources',sources,'reports',reports,
    'permissions',jsonb_build_object('can_view_manager_reports',is_manager,'can_view_employee_detail',is_manager,'can_export',true,'can_ask_atlas',true,'read_only',true),
    'trust',jsonb_build_object('reports_are_read_only',true,'sales_values_invented',false,'source_data_modified',false,'permission_sensitive_data_loaded_for_staff',false,'reykjavik_reporting_timezone',true,'currency','ISK')
  );
end;
$function$;

-- SOURCE supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql statement 2
create or replace function public.atlas_reports_snapshot_v2(
  p_inventory jsonb,
  p_recipes jsonb,
  p_recipe_ingredients jsonb,
  p_suppliers jsonb,
  p_movements jsonb,
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.reports_snapshot_v2(
    p_inventory,p_recipes,p_recipe_ingredients,p_suppliers,p_movements,
    p_profiles,p_tasks,p_progress,p_actor_id,p_actor_role,p_period_start,
    p_period_end,p_comparison_start,p_comparison_end,p_comparison_key,p_filters
  );
$$;

-- SOURCE supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql statement 3
revoke execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql statement 4
grant execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

-- SOURCE supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql statement 5
comment on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  is 'Service-role-only Checkpoint H snapshot. Production records are supplied only after the Edge gateway revalidates the active profile and removes restricted fields.';

-- SOURCE supabase/migrations/20260804095939_atlas_reports_snapshot_variable_fix.sql statement 0
-- The first live-source draft used the local name `generated_at`, which could
-- collide with brain_recommendations.generated_at in PL/pgSQL. The versioned
-- function stored by the preceding migration already uses
-- `generated_at_value`. Keep this migration as an explicit history checkpoint
-- and fail clearly if the corrected function is ever missing on a fresh branch.

do $migration$
begin
  if pg_catalog.to_regprocedure(
    'atlas_private.reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)'
  ) is null then
    raise exception 'Corrected Reports snapshot function is missing';
  end if;
end;
$migration$;

-- SOURCE supabase/migrations/20260804125547_atlas_reports_package_size_normalization.sql statement 0
-- Reports receives production source rows as JSON. Some historical inventory
-- package labels use "gr" (for example "250gr"). The private Reports parser
-- expects a canonical gram suffix and previously attempted to cast the
-- remaining "250r" string to numeric. Normalize the JSON copy used for
-- reporting without changing the production inventory record.

create or replace function atlas_private.reports_normalize_package_size(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path=''
as $$
declare
  normalized text := lower(trim(coalesce(p_value,'')));
  number_text text;
begin
  if normalized='' then return p_value; end if;

  number_text := substring(normalized from '([0-9]+([.,][0-9]+)?)');
  if number_text is null then return p_value; end if;
  number_text := replace(number_text,',','.');

  if normalized ~ '(^|[^a-z])(gr|gram|grams)([^a-z]|$)'
     or normalized ~ '[0-9][[:space:]]*(gr|gram|grams)([^a-z]|$)' then
    return number_text||' g';
  end if;

  return p_value;
end;
$$;

-- SOURCE supabase/migrations/20260804125547_atlas_reports_package_size_normalization.sql statement 1
create or replace function public.atlas_reports_snapshot_v2(
  p_inventory jsonb,
  p_recipes jsonb,
  p_recipe_ingredients jsonb,
  p_suppliers jsonb,
  p_movements jsonb,
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  with normalized_inventory as (
    select coalesce(jsonb_agg(
      case
        when jsonb_typeof(item)='object' and item ? 'package_size'
          then jsonb_set(
            item,
            '{package_size}',
            to_jsonb(atlas_private.reports_normalize_package_size(item->>'package_size')),
            true
          )
        else item
      end
    ),'[]'::jsonb) as payload
    from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item
  )
  select atlas_private.reports_snapshot_v2(
    normalized_inventory.payload,
    p_recipes,
    p_recipe_ingredients,
    p_suppliers,
    p_movements,
    p_profiles,
    p_tasks,
    p_progress,
    p_actor_id,
    p_actor_role,
    p_period_start,
    p_period_end,
    p_comparison_start,
    p_comparison_end,
    p_comparison_key,
    p_filters
  )
  from normalized_inventory;
$$;

-- SOURCE supabase/migrations/20260804125547_atlas_reports_package_size_normalization.sql statement 2
revoke execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804125547_atlas_reports_package_size_normalization.sql statement 3
grant execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

-- SOURCE supabase/migrations/20260804125547_atlas_reports_package_size_normalization.sql statement 4
comment on function atlas_private.reports_normalize_package_size(text) is
  'Normalizes known imported package-size abbreviations before Reports numeric parsing without changing source records.';

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 0
-- Checkpoint I — Atlas System control room
--
-- This migration creates a private, manager-only registry for services, data
-- sources, jobs, incidents, release checkpoints and audit evidence. Checkpoint
-- I is deliberately view-only: retries, incident mutation, rollback,
-- destructive actions and production promotion remain disabled.

create table if not exists atlas_private.system_settings (
  setting_key text primary key,
  environment text not null default 'preview'
    check (environment in ('preview','production')),
  production_sync_enabled boolean not null default false,
  destructive_actions_enabled boolean not null default false,
  automatic_retries_enabled boolean not null default false,
  rollback_actions_enabled boolean not null default false,
  secrets_visible_in_ui boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 1
create table if not exists atlas_private.system_services (
  service_key text primary key,
  label text not null,
  category text not null
    check (category in ('application','authentication','database','storage','edge_function','integration','module','safeguard')),
  status text not null default 'unknown'
    check (status in ('healthy','degraded','down','not_connected','disabled_by_policy','waiting_authorization','missing_permission','expired','unknown')),
  environment text not null default 'preview'
    check (environment in ('preview','production','external','shared')),
  version_label text,
  check_strategy text not null default 'registry'
    check (check_strategy in ('registry','runtime','client','incident','database')),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_code text,
  failure_message text,
  production_impact text not null default 'none'
    check (production_impact in ('none','limited','degraded','outage','unknown')),
  preview_impact text not null default 'none'
    check (preview_impact in ('none','limited','degraded','outage','unknown')),
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(label) between 1 and 160),
  check (failure_message is null or char_length(failure_message)<=5000),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 2
create table if not exists atlas_private.system_data_sources (
  source_key text primary key,
  label text not null,
  domain text not null,
  source_type text not null
    check (source_type in ('live','historical_snapshot','private_import','integration','manual')),
  status text not null default 'unknown'
    check (status in ('connected','partial','stale','not_connected','no_records','historical','blocked','unknown')),
  is_live boolean not null default false,
  is_historical boolean not null default false,
  trusted_for_brain boolean not null default false,
  record_count bigint,
  last_successful_at timestamptz,
  last_attempted_at timestamptz,
  freshness_hours integer,
  freshness_state text not null default 'unknown'
    check (freshness_state in ('current','stale','historical','not_connected','unknown')),
  source_scope text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (record_count is null or record_count>=0),
  check (freshness_hours is null or freshness_hours>=0),
  check (error_message is null or char_length(error_message)<=5000),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 3
create table if not exists atlas_private.system_jobs (
  job_key text primary key,
  label text not null,
  category text not null,
  schedule_description text,
  status text not null default 'idle'
    check (status in ('healthy','running','waiting','failed','disabled_by_policy','not_connected','idle')),
  is_automatic boolean not null default false,
  retry_enabled boolean not null default false,
  write_scope text not null default 'none',
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  next_run_at timestamptz,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_error_message is null or char_length(last_error_message)<=5000),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 4
create table if not exists atlas_private.system_incidents (
  id uuid primary key default gen_random_uuid(),
  incident_key text not null unique,
  service_key text references atlas_private.system_services(service_key) on delete set null,
  title text not null,
  severity text not null check (severity in ('info','warning','degraded','critical')),
  status text not null default 'open' check (status in ('open','monitoring','resolved','dismissed')),
  summary text not null,
  production_impact text not null default 'none'
    check (production_impact in ('none','limited','degraded','outage','unknown')),
  preview_impact text not null default 'degraded'
    check (preview_impact in ('none','limited','degraded','outage','unknown')),
  first_occurred_at timestamptz not null default now(),
  last_occurred_at timestamptz not null default now(),
  occurrence_count integer not null default 1 check (occurrence_count>0),
  opened_by uuid,
  opened_by_label text,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_label text,
  resolution_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(title) between 1 and 220),
  check (char_length(summary) between 1 and 10000),
  check (resolution_note is null or char_length(resolution_note)<=10000),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 5
create table if not exists atlas_private.system_release_checkpoints (
  checkpoint_key text primary key,
  label text not null,
  environment text not null check (environment in ('preview','production')),
  status text not null check (status in ('healthy','degraded','blocked','ready','unknown')),
  repository text,
  branch text,
  base_branch text,
  pull_request_number integer,
  commit_sha text,
  deployment_url text,
  migration_status text,
  functions_status text,
  production_sync_state text not null default 'disabled'
    check (production_sync_state in ('disabled','preview_only','enabled','unknown')),
  last_known_healthy_reference text,
  rollback_reference text,
  release_blockers jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(release_blockers)='array'),
  check (jsonb_typeof(metadata)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 6
create table if not exists atlas_private.system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'checkpoint_created','health_check_completed','service_status_changed','source_status_changed',
    'job_status_changed','incident_opened','incident_updated','incident_resolved',
    'release_checkpoint_updated','security_check_completed','recovery_reference_updated'
  )),
  domain text not null default 'system',
  entity_key text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 7
create index if not exists system_services_status_idx
  on atlas_private.system_services(status,sort_order);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 8
create index if not exists system_sources_status_idx
  on atlas_private.system_data_sources(status,sort_order);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 9
create index if not exists system_jobs_status_idx
  on atlas_private.system_jobs(status,sort_order);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 10
create index if not exists system_incidents_status_idx
  on atlas_private.system_incidents(status,severity,last_occurred_at desc);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 11
create index if not exists system_incidents_service_idx
  on atlas_private.system_incidents(service_key,status);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 12
create index if not exists system_events_created_idx
  on atlas_private.system_events(created_at desc);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 13
create index if not exists system_events_entity_idx
  on atlas_private.system_events(domain,entity_key,created_at desc);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 14
alter table atlas_private.system_settings enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 15
alter table atlas_private.system_services enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 16
alter table atlas_private.system_data_sources enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 17
alter table atlas_private.system_jobs enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 18
alter table atlas_private.system_incidents enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 19
alter table atlas_private.system_release_checkpoints enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 20
alter table atlas_private.system_events enable row level security;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 21
drop policy if exists "service role manages system settings" on atlas_private.system_settings;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 22
create policy "service role manages system settings" on atlas_private.system_settings
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 23
drop policy if exists "service role manages system services" on atlas_private.system_services;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 24
create policy "service role manages system services" on atlas_private.system_services
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 25
drop policy if exists "service role manages system sources" on atlas_private.system_data_sources;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 26
create policy "service role manages system sources" on atlas_private.system_data_sources
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 27
drop policy if exists "service role manages system jobs" on atlas_private.system_jobs;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 28
create policy "service role manages system jobs" on atlas_private.system_jobs
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 29
drop policy if exists "service role manages system incidents" on atlas_private.system_incidents;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 30
create policy "service role manages system incidents" on atlas_private.system_incidents
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 31
drop policy if exists "service role manages system releases" on atlas_private.system_release_checkpoints;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 32
create policy "service role manages system releases" on atlas_private.system_release_checkpoints
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 33
drop policy if exists "service role manages system events" on atlas_private.system_events;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 34
create policy "service role manages system events" on atlas_private.system_events
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 35
revoke all on atlas_private.system_settings from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 36
revoke all on atlas_private.system_services from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 37
revoke all on atlas_private.system_data_sources from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 38
revoke all on atlas_private.system_jobs from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 39
revoke all on atlas_private.system_incidents from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 40
revoke all on atlas_private.system_release_checkpoints from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 41
revoke all on atlas_private.system_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 42
grant all on atlas_private.system_settings to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 43
grant all on atlas_private.system_services to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 44
grant all on atlas_private.system_data_sources to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 45
grant all on atlas_private.system_jobs to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 46
grant all on atlas_private.system_incidents to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 47
grant all on atlas_private.system_release_checkpoints to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 48
grant all on atlas_private.system_events to service_role;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 49
drop trigger if exists system_settings_touch on atlas_private.system_settings;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 50
create trigger system_settings_touch before update on atlas_private.system_settings
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 51
drop trigger if exists system_services_touch on atlas_private.system_services;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 52
create trigger system_services_touch before update on atlas_private.system_services
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 53
drop trigger if exists system_sources_touch on atlas_private.system_data_sources;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 54
create trigger system_sources_touch before update on atlas_private.system_data_sources
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 55
drop trigger if exists system_jobs_touch on atlas_private.system_jobs;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 56
create trigger system_jobs_touch before update on atlas_private.system_jobs
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 57
drop trigger if exists system_incidents_touch on atlas_private.system_incidents;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 58
create trigger system_incidents_touch before update on atlas_private.system_incidents
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 59
drop trigger if exists system_releases_touch on atlas_private.system_release_checkpoints;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 60
create trigger system_releases_touch before update on atlas_private.system_release_checkpoints
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 61
alter table atlas_private.integration_connections
  drop constraint if exists integration_connections_category_check;

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 62
alter table atlas_private.integration_connections
  add constraint integration_connections_category_check
  check (category in (
    'social','reputation','business_profile','other','infrastructure','development',
    'hosting','email','storage','operations','payments'
  ));

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 63
insert into atlas_private.system_settings (
  setting_key,environment,production_sync_enabled,destructive_actions_enabled,
  automatic_retries_enabled,rollback_actions_enabled,secrets_visible_in_ui,metadata
) values (
  'va','preview',false,false,false,false,false,
  jsonb_build_object(
    'checkpoint','I','system_mode','view_only','production_source_mutation',false,
    'incident_retry_controls','not_enabled','secrets_and_tokens_returned',false
  )
)
on conflict (setting_key) do update set
  environment='preview',production_sync_enabled=false,destructive_actions_enabled=false,
  automatic_retries_enabled=false,rollback_actions_enabled=false,secrets_visible_in_ui=false,
  metadata=excluded.metadata,updated_at=now();

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 71
comment on table atlas_private.system_incidents is
  'View-only Atlas incident registry. Resolution and retry controls are intentionally disabled in Checkpoint I.';

-- SOURCE supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql statement 72
comment on table atlas_private.system_release_checkpoints is
  'Preview and production release checkpoints, blockers and recovery references without destructive controls.';

-- SOURCE supabase/migrations/20260804134510_atlas_system_snapshot.sql statement 0
-- Checkpoint I manager-only System snapshot.
--
-- The gateway supplies role-validated production profile and source metadata.
-- The database adds private service, job, incident, release, security and audit
-- evidence. No secret, access token or destructive control is returned.

create or replace function atlas_private.system_snapshot(
  p_profiles jsonb,
  p_production_sources jsonb,
  p_runtime jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.system_settings;
  services_json jsonb := '[]'::jsonb;
  integrations_json jsonb := '[]'::jsonb;
  sources_json jsonb := '[]'::jsonb;
  jobs_json jsonb := '[]'::jsonb;
  incidents_json jsonb := '[]'::jsonb;
  releases_json jsonb := '[]'::jsonb;
  audit_json jsonb := '[]'::jsonb;
  security_json jsonb := '{}'::jsonb;
  summary_json jsonb := '{}'::jsonb;
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'System is available only to managers and administrators';
  end if;

  select * into settings_row
  from atlas_private.system_settings
  where setting_key='va';

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_key',service.service_key,
    'label',service.label,
    'category',service.category,
    'status',case
      when service.service_key='production-auth'
        and coalesce((p_runtime->>'auth_verified')::boolean,false)=false then 'degraded'
      when service.service_key='private-storage'
        and not exists (
          select 1 from storage.buckets bucket
          where bucket.id='atlas-profile-photos' and bucket.public=false
        ) then 'degraded'
      when service.service_key='reports-service'
        and exists (
          select 1 from atlas_private.system_incidents incident
          where incident.service_key=service.service_key
            and incident.status in ('open','monitoring')
        ) then 'degraded'
      else service.status
    end,
    'environment',service.environment,
    'version_label',service.version_label,
    'check_strategy',service.check_strategy,
    'last_checked_at',case
      when service.check_strategy in ('runtime','client','database','incident') then pg_catalog.now()
      else service.last_checked_at
    end,
    'last_success_at',service.last_success_at,
    'last_failure_at',service.last_failure_at,
    'failure_code',service.failure_code,
    'failure_message',service.failure_message,
    'production_impact',service.production_impact,
    'preview_impact',service.preview_impact,
    'metadata',service.metadata || case service.service_key
      when 'web-app' then jsonb_build_object('client_hostname',p_runtime->>'client_hostname')
      when 'edge-functions' then jsonb_build_object(
        'system_gateway',p_runtime->>'function_version',
        'runtime_region',p_runtime->>'runtime_region',
        'deployment_id',p_runtime->>'deployment_id'
      )
      else '{}'::jsonb
    end
  ) order by service.sort_order,service.label),'[]'::jsonb)
  into services_json
  from atlas_private.system_services service;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',connection.provider_key,
    'label',connection.label,
    'category',connection.category,
    'status',connection.status,
    'display_status',case
      when connection.status='connected' then 'connected'
      when connection.status='degraded' then 'degraded'
      when connection.status='expired' or connection.authorization_state='expired' then 'connection_expired'
      when connection.authorization_state='waiting_authorization'
        or connection.status in ('authorization_required','pending_review') then 'waiting_for_authorization'
      when connection.publishing_permission_state='missing' then 'missing_publishing_permission'
      when connection.analytics_permission_state='missing' then 'missing_analytics_permission'
      when connection.status='not_applicable' then 'disabled_by_policy'
      else 'not_connected'
    end,
    'authorization_state',connection.authorization_state,
    'publishing_permission_state',connection.publishing_permission_state,
    'analytics_permission_state',connection.analytics_permission_state,
    'external_account_label',connection.external_account_label,
    'last_verified_at',connection.last_verified_at,
    'token_expires_at',connection.token_expires_at,
    'last_connection_error',connection.last_connection_error,
    'capabilities',connection.capabilities,
    'requirements',connection.requirements,
    'metadata',connection.metadata
  ) order by connection.category,connection.label),'[]'::jsonb)
  into integrations_json
  from atlas_private.integration_connections connection;

  with production_input as (
    select *
    from jsonb_to_recordset(coalesce(p_production_sources,'[]'::jsonb)) as source(
      source_key text,
      label text,
      status text,
      record_count bigint,
      last_record_at timestamptz,
      is_live boolean,
      is_historical boolean,
      trusted_for_brain boolean,
      note text
    )
  ), source_values as (
    select registry.*,
      production.status as production_status,
      production.record_count as production_record_count,
      production.last_record_at as production_last_record_at,
      production.note as production_note
    from atlas_private.system_data_sources registry
    left join production_input production on production.source_key=registry.source_key
  ), computed as (
    select source.*,
      case
        when source.production_status is not null then source.production_status
        when source.source_key='sprint3-private-import' then
          case when exists (select 1 from atlas_private.import_batches) then 'partial' else 'no_records' end
        when source.source_key='sprint3-review' then
          case when coalesce((select sum(pending_rows) from atlas_private.data_coverage),0)>0 then 'partial' else 'connected' end
        when source.source_key='july-2026-inventory' then 'historical'
        when source.source_key='operations-routines' then
          case when exists (select 1 from atlas_private.routine_instances) then 'connected' else 'no_records' end
        when source.source_key='temperature-logs' then
          case when exists (select 1 from atlas_private.temperature_logs) then 'connected' else 'no_records' end
        when source.source_key='shift-publications' then
          case when exists (select 1 from atlas_private.shift_publications)
                 or exists (select 1 from atlas_private.shift_month_publications)
            then 'connected' else 'no_records' end
        when source.source_key='knowledge-library' then
          case when exists (select 1 from atlas_private.knowledge_articles where status='published') then 'connected' else 'no_records' end
        when source.source_key='marketing-planning' then
          case when exists (select 1 from atlas_private.marketing_content_items) then 'connected' else 'no_records' end
        else source.status
      end as effective_status,
      case
        when source.production_record_count is not null then source.production_record_count
        when source.source_key='sprint3-private-import' then (select count(*)::bigint from atlas_private.import_batches)
        when source.source_key='sprint3-review' then coalesce((select sum(total_rows) from atlas_private.data_coverage),0)
        when source.source_key='july-2026-inventory' then (select count(*)::bigint from atlas_private.import_inventory_rows)
        when source.source_key='operations-routines' then (select count(*)::bigint from atlas_private.routine_instances)
        when source.source_key='temperature-logs' then (select count(*)::bigint from atlas_private.temperature_logs)
        when source.source_key='shift-publications' then
          (select count(*)::bigint from atlas_private.shift_publications)
          +(select count(*)::bigint from atlas_private.shift_month_publications)
        when source.source_key='knowledge-library' then
          (select count(*)::bigint from atlas_private.knowledge_articles where status='published')
        when source.source_key='marketing-planning' then
          (select count(*)::bigint from atlas_private.marketing_content_items)
        else coalesce(source.record_count,0)
      end as effective_count,
      case
        when source.production_last_record_at is not null then source.production_last_record_at
        when source.source_key='sprint3-private-import' then (select max(updated_at) from atlas_private.import_batches)
        when source.source_key='sprint3-review' then (select max(updated_at) from atlas_private.review_queue)
        when source.source_key='operations-routines' then (select max(updated_at) from atlas_private.routine_instances)
        when source.source_key='temperature-logs' then (select max(created_at) from atlas_private.temperature_logs)
        when source.source_key='shift-publications' then greatest(
          coalesce((select max(published_at) from atlas_private.shift_publications),'1970-01-01'::timestamptz),
          coalesce((select max(published_at) from atlas_private.shift_month_publications),'1970-01-01'::timestamptz)
        )
        when source.source_key='knowledge-library' then (select max(updated_at) from atlas_private.knowledge_articles)
        when source.source_key='marketing-planning' then (select max(updated_at) from atlas_private.marketing_content_items)
        else source.last_successful_at
      end as effective_last_at
    from source_values source
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_key',source.source_key,
    'label',source.label,
    'domain',source.domain,
    'source_type',source.source_type,
    'status',source.effective_status,
    'is_live',source.is_live,
    'is_historical',source.is_historical,
    'trusted_for_brain',source.trusted_for_brain,
    'record_count',source.effective_count,
    'last_successful_at',source.effective_last_at,
    'last_attempted_at',source.last_attempted_at,
    'freshness_hours',source.freshness_hours,
    'freshness_state',case
      when source.effective_status='not_connected' then 'not_connected'
      when source.is_historical then 'historical'
      when source.effective_last_at is null then 'unknown'
      when source.freshness_hours is not null
        and source.effective_last_at<pg_catalog.now()-(source.freshness_hours||' hours')::interval then 'stale'
      else 'current'
    end,
    'source_scope',source.source_scope,
    'error_code',source.error_code,
    'error_message',coalesce(source.production_note,source.error_message),
    'metadata',source.metadata
  ) order by source.sort_order,source.label),'[]'::jsonb)
  into sources_json
  from computed source;

  select coalesce(jsonb_agg(jsonb_build_object(
    'job_key',job.job_key,
    'label',job.label,
    'category',job.category,
    'schedule_description',job.schedule_description,
    'status',job.status,
    'is_automatic',job.is_automatic,
    'retry_enabled',job.retry_enabled,
    'write_scope',job.write_scope,
    'last_started_at',job.last_started_at,
    'last_succeeded_at',job.last_succeeded_at,
    'last_failed_at',job.last_failed_at,
    'next_run_at',job.next_run_at,
    'last_error_code',job.last_error_code,
    'last_error_message',job.last_error_message,
    'metadata',job.metadata
  ) order by job.sort_order,job.label),'[]'::jsonb)
  into jobs_json
  from atlas_private.system_jobs job;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',incident.id,
    'incident_key',incident.incident_key,
    'service_key',incident.service_key,
    'title',incident.title,
    'severity',incident.severity,
    'status',incident.status,
    'summary',incident.summary,
    'production_impact',incident.production_impact,
    'preview_impact',incident.preview_impact,
    'first_occurred_at',incident.first_occurred_at,
    'last_occurred_at',incident.last_occurred_at,
    'occurrence_count',incident.occurrence_count,
    'resolved_at',incident.resolved_at,
    'resolved_by_label',incident.resolved_by_label,
    'resolution_note',incident.resolution_note,
    'metadata',incident.metadata
  ) order by
    case incident.status when 'open' then 0 when 'monitoring' then 1 else 2 end,
    case incident.severity when 'critical' then 0 when 'degraded' then 1 when 'warning' then 2 else 3 end,
    incident.last_occurred_at desc),'[]'::jsonb)
  into incidents_json
  from atlas_private.system_incidents incident;

  select coalesce(jsonb_agg(jsonb_build_object(
    'checkpoint_key',release.checkpoint_key,
    'label',release.label,
    'environment',release.environment,
    'status',release.status,
    'repository',release.repository,
    'branch',release.branch,
    'base_branch',release.base_branch,
    'pull_request_number',release.pull_request_number,
    'commit_sha',coalesce(p_runtime->>'github_commit_sha',release.commit_sha),
    'commit_date',p_runtime->>'github_commit_date',
    'deployment_url',coalesce(p_runtime->>'client_url',release.deployment_url),
    'migration_status',release.migration_status,
    'functions_status',case
      when coalesce((p_runtime->>'system_gateway')::boolean,false) then 'System gateway active'
      else release.functions_status
    end,
    'production_sync_state',release.production_sync_state,
    'last_known_healthy_reference',release.last_known_healthy_reference,
    'rollback_reference',release.rollback_reference,
    'release_blockers',release.release_blockers,
    'metadata',release.metadata||jsonb_build_object(
      'runtime_project_ref',p_runtime->>'project_ref',
      'runtime_region',p_runtime->>'runtime_region'
    )
  ) order by release.environment,release.label),'[]'::jsonb)
  into releases_json
  from atlas_private.system_release_checkpoints release;

  with profiles as (
    select *
    from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,
      email text,
      display_name text,
      role text,
      active boolean,
      updated_at timestamptz
    )
  ), private_tables as (
    select count(*)::bigint as total,
      count(*) filter (where class.relrowsecurity)::bigint as protected
    from pg_class class
    join pg_namespace namespace on namespace.oid=class.relnamespace
    where namespace.nspname='atlas_private' and class.relkind='r'
  )
  select jsonb_build_object(
    'profiles',jsonb_build_object(
      'total',(select count(*)::bigint from profiles),
      'active',(select count(*)::bigint from profiles where active=true),
      'inactive',(select count(*)::bigint from profiles where active=false),
      'active_managers',(select count(*)::bigint from profiles where active=true and role in ('admin','manager')),
      'roles',coalesce((
        select jsonb_object_agg(role,role_count)
        from (select role,count(*)::bigint role_count from profiles group by role) roles
      ),'{}'::jsonb)
    ),
    'private_schema',jsonb_build_object(
      'tables',(select total from private_tables),
      'rls_enabled',(select protected from private_tables),
      'rls_missing',(select total-protected from private_tables)
    ),
    'unexpected_table_grants',(
      select count(*)::bigint
      from information_schema.role_table_grants
      where table_schema='atlas_private' and grantee in ('anon','authenticated','PUBLIC')
    ),
    'unexpected_atlas_function_grants',(
      select count(*)::bigint
      from information_schema.routine_privileges
      where routine_schema='public' and routine_name like 'atlas_%'
        and grantee in ('anon','authenticated','PUBLIC')
    ),
    'private_storage_buckets',(
      select count(*)::bigint from storage.buckets where public=false
    ),
    'profile_photo_bucket_private',exists (
      select 1 from storage.buckets where id='atlas-profile-photos' and public=false
    ),
    'recent_access_changes',(
      select count(*)::bigint
      from atlas_private.team_profile_events
      where event_type in ('role_changed','active_status_changed')
        and created_at>=pg_catalog.now()-interval '30 days'
    ),
    'browser_service_role_exposed',false,
    'secrets_visible_in_ui',settings_row.secrets_visible_in_ui,
    'destructive_actions_enabled',settings_row.destructive_actions_enabled
  ) into security_json;

  with audit as (
    select created_at,'system'::text domain,event_type,entity_key,actor_label,payload
    from atlas_private.system_events
    union all
    select created_at,'shifts',event_type,coalesce(shift_id::text,week_start::text,month_start::text),actor_label,payload
    from atlas_private.shift_events
    union all
    select created_at,'knowledge',event_type,coalesce(article_id::text,version_id::text),actor_label,payload
    from atlas_private.knowledge_events
    union all
    select created_at,'marketing',event_type,coalesce(content_id::text,campaign_id::text,recommendation_id::text),actor_label,payload
    from atlas_private.marketing_workspace_events
    union all
    select created_at,'profiles',event_type,profile_id::text,actor_label,payload
    from atlas_private.team_profile_events
    union all
    select created_at,'operations',event_type,coalesce(entity_id::text,entity_type),actor_label,payload
    from atlas_private.operations_events
    union all
    select created_at,'reports',event_type,coalesce(saved_view_id::text,report_key),actor_label,payload
    from atlas_private.report_events
    union all
    select created_at,'messages',event_type,coalesce(message_id::text,channel_id::text),actor_label,payload
    from atlas_private.team_message_events
    union all
    select created_at,'scanner',event_type,coalesce(external_item_id::text,normalized_code),actor_label,metadata
    from atlas_private.inventory_scan_events
    union all
    select occurred_at,'brain',memory_type,subject_key,actor_label,context
    from atlas_private.brain_decision_memory
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'created_at',audit.created_at,
    'domain',audit.domain,
    'event_type',audit.event_type,
    'entity_key',audit.entity_key,
    'actor_label',audit.actor_label,
    'payload',audit.payload
  ) order by audit.created_at desc),'[]'::jsonb)
  into audit_json
  from (select * from audit order by created_at desc limit 120) audit;

  select jsonb_build_object(
    'overall_status',case
      when exists (
        select 1 from atlas_private.system_incidents
        where status in ('open','monitoring') and severity in ('critical','degraded')
      ) then 'degraded'
      when exists (select 1 from atlas_private.system_services where status='down') then 'down'
      else 'healthy'
    end,
    'healthy_services',(
      select count(*)::bigint from jsonb_array_elements(services_json) service
      where service->>'status'='healthy'
    ),
    'degraded_services',(
      select count(*)::bigint from jsonb_array_elements(services_json) service
      where service->>'status' in ('degraded','down')
    ),
    'open_incidents',(
      select count(*)::bigint from atlas_private.system_incidents
      where status in ('open','monitoring')
    ),
    'connected_integrations',(
      select count(*)::bigint from atlas_private.integration_connections where status='connected'
    ),
    'unconnected_integrations',(
      select count(*)::bigint from atlas_private.integration_connections where status<>'connected'
    ),
    'trusted_live_sources',(
      select count(*)::bigint from jsonb_array_elements(sources_json) source
      where source->>'trusted_for_brain'='true' and source->>'status'='connected'
    ),
    'blocked_sources',(
      select count(*)::bigint from jsonb_array_elements(sources_json) source
      where source->>'status' in ('not_connected','blocked','stale')
    ),
    'release_blockers',coalesce((
      select sum(jsonb_array_length(release_blockers))
      from atlas_private.system_release_checkpoints
    ),0)
  ) into summary_json;

  return jsonb_build_object(
    'version','atlas-system/0.1.0',
    'generated_at',pg_catalog.now(),
    'summary',summary_json,
    'services',services_json,
    'integrations',integrations_json,
    'data_sources',sources_json,
    'jobs',jobs_json,
    'incidents',incidents_json,
    'releases',releases_json,
    'security',security_json,
    'audit',audit_json,
    'recovery',jsonb_build_object(
      'last_known_healthy_reference',(
        select last_known_healthy_reference
        from atlas_private.system_release_checkpoints
        order by updated_at desc limit 1
      ),
      'rollback_reference',(
        select rollback_reference
        from atlas_private.system_release_checkpoints
        order by updated_at desc limit 1
      ),
      'backup_status','not_verified_by_atlas_runtime',
      'production_sync_enabled',settings_row.production_sync_enabled,
      'rollback_actions_enabled',settings_row.rollback_actions_enabled,
      'destructive_actions_enabled',settings_row.destructive_actions_enabled,
      'automatic_retries_enabled',settings_row.automatic_retries_enabled,
      'mode','view_only'
    ),
    'permissions',jsonb_build_object(
      'can_view_system',true,
      'can_view_security',true,
      'can_retry_jobs',false,
      'can_resolve_incidents',false,
      'can_run_rollback',false,
      'can_promote_production',false
    ),
    'trust',jsonb_build_object(
      'secrets_returned',false,
      'tokens_returned',false,
      'production_source_mutation',false,
      'destructive_controls_enabled',false,
      'automatic_retry_enabled',false,
      'system_is_view_only',true
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260804134510_atlas_system_snapshot.sql statement 1
create or replace function public.atlas_system_snapshot(
  p_profiles jsonb,
  p_production_sources jsonb,
  p_runtime jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.system_snapshot($1,$2,$3,$4,$5);
$$;

-- SOURCE supabase/migrations/20260804134510_atlas_system_snapshot.sql statement 2
revoke execute on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260804134510_atlas_system_snapshot.sql statement 3
grant execute on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)
  to service_role;

-- SOURCE supabase/migrations/20260804134510_atlas_system_snapshot.sql statement 4
comment on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text) is
  'Service-role-only System snapshot for active managers. It returns health metadata without secrets, tokens or source mutations.';

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 0
-- Checkpoint J Settings — canonical replayable schema and RPC contract.
--
-- The earlier 162529 and 163127 files are migration-history anchors for SQL that
-- was deployed before its source was retained. This migration recreates the
-- complete Settings model before Checkpoint K reads settings_sections, making a
-- clean branch reset deterministic.

create schema if not exists atlas_private;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 1
revoke all on schema atlas_private from public, anon, authenticated;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 2
grant usage on schema atlas_private to service_role;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 3
create table if not exists atlas_private.settings_sections (
  section_key text primary key check (section_key in (
    'venue','operations','inventory','temperature','cleaning',
    'marketing','brain','security','appearance','modules'
  )),
  label text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active','review','disabled')),
  settings_value jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings_value)='object'),
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 4
create table if not exists atlas_private.settings_business_hours (
  weekday smallint primary key check (weekday between 0 and 6),
  day_label text not null,
  is_open boolean not null default true,
  open_time time without time zone,
  close_time time without time zone,
  close_next_day boolean not null default false,
  kitchen_close_time time without time zone,
  kitchen_close_next_day boolean not null default false,
  last_order_time time without time zone,
  last_order_next_day boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 5
create table if not exists atlas_private.settings_offers (
  id uuid primary key default gen_random_uuid(),
  offer_key text not null unique,
  name text not null,
  description text,
  active boolean not null default true,
  days smallint[] not null default '{}'::smallint[],
  start_time time without time zone not null,
  end_time time without time zone not null,
  end_next_day boolean not null default false,
  pricing jsonb not null default '{}'::jsonb check (jsonb_typeof(pricing)='object'),
  booking_url text,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 6
create table if not exists atlas_private.settings_roles (
  role_key text primary key check (role_key in ('admin','manager','bartender','viewer')),
  label text not null,
  description text not null default '',
  permissions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(permissions)='object'),
  protected boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 7
create table if not exists atlas_private.settings_notification_policies (
  event_key text primary key,
  category text not null,
  label text not null,
  enabled boolean not null default true,
  channels jsonb not null default '{"in_app":true,"browser":false,"email":false}'::jsonb
    check (jsonb_typeof(channels)='object'),
  target_roles text[] not null default array['admin','manager']::text[],
  reminder_minutes integer[] not null default '{}'::integer[],
  escalation_minutes integer,
  manager_approval_required boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 8
create table if not exists atlas_private.settings_user_preferences (
  user_id uuid primary key,
  theme text not null default 'dark' check (theme in ('dark','light','system')),
  density text not null default 'comfortable' check (density in ('comfortable','compact')),
  language text not null default 'en' check (language in ('en','is')),
  start_view text not null default 'briefing',
  timezone text not null default 'Atlantic/Reykjavik',
  reduce_motion boolean not null default false,
  browser_notifications boolean not null default false,
  email_notifications boolean not null default false,
  preferences jsonb not null default '{}'::jsonb
    check (jsonb_typeof(preferences)='object'),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 9
create table if not exists atlas_private.settings_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text not null,
  entity_key text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 10
create index if not exists settings_events_created_idx
  on atlas_private.settings_events(created_at desc);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 11
create index if not exists settings_events_entity_idx
  on atlas_private.settings_events(entity_type,entity_key,created_at desc);

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 12
alter table atlas_private.settings_sections enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 13
alter table atlas_private.settings_business_hours enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 14
alter table atlas_private.settings_offers enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 15
alter table atlas_private.settings_roles enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 16
alter table atlas_private.settings_notification_policies enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 17
alter table atlas_private.settings_user_preferences enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 18
alter table atlas_private.settings_events enable row level security;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 19
do $settings_private_grants$
declare
  table_name text;
begin
  foreach table_name in array array[
    'settings_sections','settings_business_hours','settings_offers','settings_roles',
    'settings_notification_policies','settings_user_preferences','settings_events'
  ]
  loop
    execute format('revoke all on atlas_private.%I from public, anon, authenticated',table_name);
    execute format('grant all on atlas_private.%I to service_role',table_name);
    execute format('drop policy if exists %I on atlas_private.%I',table_name || '_service_only',table_name);
    execute format(
      'create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      table_name || '_service_only',table_name
    );
  end loop;
end
$settings_private_grants$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 20
create or replace function atlas_private.settings_assert_actor(
  p_actor_role text,
  p_manager_required boolean default false,
  p_admin_required boolean default false
)
returns void
language plpgsql
stable
security invoker
set search_path=''
as $function$
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'An active Atlas role is required';
  end if;
  if p_admin_required and p_actor_role <> 'admin' then
    raise exception 'Only administrators can change this Settings area';
  end if;
  if p_manager_required and p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can change organization Settings';
  end if;
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 21
create or replace function atlas_private.settings_assert_safe_json(p_value jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path=''
as $function$
begin
  if jsonb_typeof(coalesce(p_value,'{}'::jsonb)) <> 'object' then
    raise exception 'Settings values must be a JSON object';
  end if;
  if coalesce(p_value,'{}'::jsonb)::text ~* '"(password|secret|token|api[_ -]?key|service[_ -]?role|credential)"[[:space:]]*:' then
    raise exception 'Sensitive credentials cannot be stored in Atlas Settings';
  end if;
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 25
insert into atlas_private.settings_roles(role_key,label,description,permissions,protected)
values
  ('admin','Administrator','Full governance and security administration.',
    '{"inventory.view":true,"inventory.manage":true,"inventory.costs":true,"inventory.count":true,"inventory.publish_count":true,"recipes.view":true,"recipes.manage":true,"team.view":true,"team.manage":true,"reports.view":true,"settings.manage":true,"security.manage":true,"brain.review":true,"purchasing.review":true}'::jsonb,true),
  ('manager','Manager','Operational management, review and approval without administrator-only security changes.',
    '{"inventory.view":true,"inventory.manage":true,"inventory.costs":true,"inventory.count":true,"inventory.publish_count":true,"recipes.view":true,"recipes.manage":true,"team.view":true,"team.manage":true,"reports.view":true,"settings.manage":true,"security.manage":false,"brain.review":true,"purchasing.review":true}'::jsonb,false),
  ('bartender','Bartender','Daily operational access with commercial and publication boundaries.',
    '{"inventory.view":true,"inventory.manage":false,"inventory.costs":false,"inventory.count":true,"inventory.publish_count":false,"recipes.view":true,"recipes.manage":false,"team.view":true,"team.manage":false,"reports.view":false,"settings.manage":false,"security.manage":false,"brain.review":false,"purchasing.review":false}'::jsonb,false),
  ('viewer','Viewer','Read-only compatibility access.',
    '{"inventory.view":true,"inventory.manage":false,"inventory.costs":false,"inventory.count":false,"inventory.publish_count":false,"recipes.view":true,"recipes.manage":false,"team.view":true,"team.manage":false,"reports.view":false,"settings.manage":false,"security.manage":false,"brain.review":false,"purchasing.review":false}'::jsonb,false)
on conflict (role_key) do nothing;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 26
insert into atlas_private.settings_notification_policies(
  event_key,category,label,enabled,channels,target_roles,reminder_minutes,
  escalation_minutes,manager_approval_required
)
values
  ('temperature.exception','Operations','Temperature exception',true,
    '{"in_app":true,"browser":true,"email":false}'::jsonb,array['admin','manager'],array[0],30,true),
  ('inventory.low_stock','Inventory','Low-stock review',true,
    '{"in_app":true,"browser":false,"email":false}'::jsonb,array['admin','manager'],array[0],null,false),
  ('stock_count.submitted','Inventory','Stock count submitted',true,
    '{"in_app":true,"browser":true,"email":false}'::jsonb,array['admin','manager'],array[0],120,true),
  ('shifts.published','People','Shift plan published',true,
    '{"in_app":true,"browser":true,"email":false}'::jsonb,array['admin','manager','bartender','viewer'],array[0],null,false),
  ('knowledge.required','Knowledge','Required reading assigned',true,
    '{"in_app":true,"browser":false,"email":false}'::jsonb,array['admin','manager','bartender','viewer'],array[1440,0],null,false)
on conflict (event_key) do nothing;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 27
create or replace function atlas_private.settings_snapshot(
  p_profiles jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  profiles_value jsonb := case
    when jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))='array' then coalesce(p_profiles,'[]'::jsonb)
    else '[]'::jsonb
  end;
  result jsonb;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,false,false);
  if p_actor_id is null then raise exception 'Settings actor id is required'; end if;

  select jsonb_build_object(
    'version','atlas-settings/0.1.0',
    'generated_at',now(),
    'permissions',jsonb_build_object(
      'can_manage_organization',p_actor_role in ('admin','manager'),
      'can_manage_security',p_actor_role='admin'
    ),
    'trust',jsonb_build_object(
      'environment','isolated_branch',
      'production_sync_enabled',false,
      'destructive_actions_enabled',false,
      'automatic_social_publishing_enabled',false,
      'automatic_reorder_execution_enabled',false,
      'automatic_brain_execution_enabled',false,
      'secrets_returned',false
    ),
    'sections',coalesce((
      select jsonb_agg(jsonb_build_object(
        'section_key',section_row.section_key,
        'label',section_row.label,
        'description',section_row.description,
        'status',section_row.status,
        'value',section_row.settings_value,
        'version',section_row.version,
        'updated_by_label',section_row.updated_by_label,
        'updated_at',section_row.updated_at,
        'can_edit',case
          when section_row.section_key='security' then p_actor_role='admin'
          else p_actor_role in ('admin','manager')
        end
      ) order by array_position(array['venue','operations','inventory','temperature','cleaning','marketing','brain','security','appearance','modules'],section_row.section_key))
      from atlas_private.settings_sections section_row
    ),'[]'::jsonb),
    'business_hours',coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday',hours.weekday,'day_label',hours.day_label,'is_open',hours.is_open,
        'open_time',hours.open_time,'close_time',hours.close_time,
        'close_next_day',hours.close_next_day,
        'kitchen_close_time',hours.kitchen_close_time,
        'kitchen_close_next_day',hours.kitchen_close_next_day,
        'last_order_time',hours.last_order_time,
        'last_order_next_day',hours.last_order_next_day,
        'version',hours.version,'updated_at',hours.updated_at
      ) order by hours.weekday)
      from atlas_private.settings_business_hours hours
    ),'[]'::jsonb),
    'offers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',offer.id,'offer_key',offer.offer_key,'name',offer.name,
        'description',offer.description,'active',offer.active,'days',offer.days,
        'start_time',offer.start_time,'end_time',offer.end_time,
        'end_next_day',offer.end_next_day,'pricing',offer.pricing,
        'booking_url',offer.booking_url,'version',offer.version,
        'updated_at',offer.updated_at,'can_edit',p_actor_role in ('admin','manager')
      ) order by offer.active desc,offer.start_time,offer.name)
      from atlas_private.settings_offers offer
    ),'[]'::jsonb),
    'roles',coalesce((
      select jsonb_agg(jsonb_build_object(
        'role_key',role_row.role_key,'label',role_row.label,
        'description',role_row.description,'permissions',role_row.permissions,
        'protected',role_row.protected,'version',role_row.version,
        'updated_at',role_row.updated_at,
        'can_edit',p_actor_role='admin' and role_row.role_key <> 'admin'
      ) order by array_position(array['admin','manager','bartender','viewer'],role_row.role_key))
      from atlas_private.settings_roles role_row
    ),'[]'::jsonb),
    'notification_policies',coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_key',policy.event_key,'category',policy.category,'label',policy.label,
        'enabled',policy.enabled,'channels',policy.channels,
        'target_roles',policy.target_roles,'reminder_minutes',policy.reminder_minutes,
        'escalation_minutes',policy.escalation_minutes,
        'manager_approval_required',policy.manager_approval_required,
        'version',policy.version,'updated_at',policy.updated_at,
        'can_edit',p_actor_role in ('admin','manager')
      ) order by policy.category,policy.label)
      from atlas_private.settings_notification_policies policy
    ),'[]'::jsonb),
    'preferences',coalesce((
      select to_jsonb(preference) - 'created_at' - 'updated_by' - 'updated_by_label'
      from atlas_private.settings_user_preferences preference
      where preference.user_id=p_actor_id
    ),jsonb_build_object(
      'user_id',p_actor_id,'theme','dark','density','comfortable','language','en',
      'start_view','briefing','timezone','Atlantic/Reykjavik','reduce_motion',false,
      'browser_notifications',false,'email_notifications',false,
      'preferences','{}'::jsonb,'updated_at',null
    )),
    'integrations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_key',connection.provider_key,'label',connection.label,
        'category',connection.category,'status',connection.status,
        'authorization_state',connection.authorization_state,
        'publishing_permission_state',connection.publishing_permission_state,
        'analytics_permission_state',connection.analytics_permission_state,
        'last_verified_at',connection.last_verified_at,
        'last_connection_error',connection.last_connection_error,
        'capabilities',connection.capabilities,'requirements',connection.requirements
      ) order by connection.category,connection.label)
      from atlas_private.integration_connections connection
    ),'[]'::jsonb),
    'profiles_summary',jsonb_build_object(
      'total',(select count(*) from jsonb_array_elements(profiles_value)),
      'active',(select count(*) from jsonb_array_elements(profiles_value) profile where coalesce((profile->>'active')::boolean,false)),
      'inactive',(select count(*) from jsonb_array_elements(profiles_value) profile where not coalesce((profile->>'active')::boolean,false)),
      'roles',coalesce((
        select jsonb_object_agg(role_name,role_count)
        from (
          select coalesce(nullif(profile->>'role',''),'unknown') role_name,count(*) role_count
          from jsonb_array_elements(profiles_value) profile
          group by coalesce(nullif(profile->>'role',''),'unknown')
        ) role_counts
      ),'{}'::jsonb)
    ),
    'activity',coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc)
      from (
        select *
        from atlas_private.settings_events event_source
        where p_actor_role in ('admin','manager') or event_source.actor_id=p_actor_id
        order by created_at desc
        limit 100
      ) event_row
    ),'[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 28
create or replace function atlas_private.settings_save_section(
  p_section_key text,
  p_value jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  section_row atlas_private.settings_sections;
  safe_value jsonb := coalesce(p_value,'{}'::jsonb);
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,p_section_key='security');
  perform atlas_private.settings_assert_safe_json(safe_value);
  if p_section_key not in ('venue','operations','inventory','temperature','cleaning','marketing','brain','security','appearance','modules') then
    raise exception 'Unknown Settings section';
  end if;

  if p_section_key='venue' then
    safe_value := jsonb_set(safe_value,'{currency}','"ISK"'::jsonb,true);
  elsif p_section_key='operations' then
    safe_value := jsonb_set(safe_value,'{production_shift_sync_enabled}','false'::jsonb,true);
  elsif p_section_key='inventory' then
    safe_value := jsonb_set(jsonb_set(safe_value,'{automatic_reorder_execution}','false'::jsonb,true),'{live_quantity_apply}','false'::jsonb,true);
  elsif p_section_key='marketing' then
    safe_value := jsonb_set(jsonb_set(safe_value,'{automatic_publishing_enabled}','false'::jsonb,true),'{analytics_ingestion_enabled}','false'::jsonb,true);
  elsif p_section_key='brain' then
    safe_value := jsonb_set(safe_value,'{automatic_execution_enabled}','false'::jsonb,true);
  elsif p_section_key='security' then
    safe_value := jsonb_set(jsonb_set(jsonb_set(safe_value,'{api_keys_visible}','false'::jsonb,true),'{production_sync_enabled}','false'::jsonb,true),'{destructive_actions_enabled}','false'::jsonb,true);
  elsif p_section_key='modules' then
    safe_value := jsonb_set(jsonb_set(jsonb_set(safe_value,'{production_sync_enabled}','false'::jsonb,true),'{system}','true'::jsonb,true),'{settings}','true'::jsonb,true);
  end if;

  select * into section_row
  from atlas_private.settings_sections
  where section_key=p_section_key
  for update;
  if not found then raise exception 'Settings section not found'; end if;
  if p_expected_version is null or p_expected_version <> section_row.version then
    raise exception 'Settings changed after this page was opened';
  end if;

  update atlas_private.settings_sections
  set settings_value=safe_value,version=version+1,
      updated_by=p_actor_id,updated_by_label=nullif(trim(coalesce(p_actor_label,'')),''),
      updated_at=now()
  where section_key=p_section_key
  returning * into section_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('section_saved','section',p_section_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',section_row.version));

  return jsonb_build_object(
    'section_key',section_row.section_key,'label',section_row.label,
    'description',section_row.description,'status',section_row.status,
    'value',section_row.settings_value,'version',section_row.version,
    'updated_at',section_row.updated_at,'updated_by_label',section_row.updated_by_label
  );
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 29
create or replace function atlas_private.settings_save_hours(
  p_hours jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  entry jsonb;
  weekdays smallint[] := '{}'::smallint[];
  weekday_value smallint;
  is_open_value boolean;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,false);
  if jsonb_typeof(coalesce(p_hours,'[]'::jsonb)) <> 'array' or jsonb_array_length(p_hours) <> 7 then
    raise exception 'Business hours must contain all seven days';
  end if;

  for entry in select value from jsonb_array_elements(p_hours)
  loop
    weekday_value := (entry->>'weekday')::smallint;
    if weekday_value < 0 or weekday_value > 6 or weekday_value=any(weekdays) then
      raise exception 'Business hours contain an invalid or duplicate weekday';
    end if;
    weekdays := array_append(weekdays,weekday_value);
    is_open_value := coalesce((entry->>'is_open')::boolean,false);
    if is_open_value and (nullif(entry->>'open_time','') is null or nullif(entry->>'close_time','') is null) then
      raise exception 'Open days require opening and closing times';
    end if;

    insert into atlas_private.settings_business_hours(
      weekday,day_label,is_open,open_time,close_time,close_next_day,
      kitchen_close_time,kitchen_close_next_day,last_order_time,last_order_next_day,
      version,updated_by,updated_by_label,updated_at
    ) values (
      weekday_value,left(coalesce(nullif(trim(entry->>'day_label'),''),'Day'),20),is_open_value,
      nullif(entry->>'open_time','')::time,nullif(entry->>'close_time','')::time,
      coalesce((entry->>'close_next_day')::boolean,false),
      nullif(entry->>'kitchen_close_time','')::time,
      coalesce((entry->>'kitchen_close_next_day')::boolean,false),
      nullif(entry->>'last_order_time','')::time,
      coalesce((entry->>'last_order_next_day')::boolean,false),
      1,p_actor_id,nullif(trim(coalesce(p_actor_label,'')),''),now()
    )
    on conflict (weekday) do update
    set day_label=excluded.day_label,is_open=excluded.is_open,
        open_time=excluded.open_time,close_time=excluded.close_time,
        close_next_day=excluded.close_next_day,
        kitchen_close_time=excluded.kitchen_close_time,
        kitchen_close_next_day=excluded.kitchen_close_next_day,
        last_order_time=excluded.last_order_time,
        last_order_next_day=excluded.last_order_next_day,
        version=atlas_private.settings_business_hours.version+1,
        updated_by=excluded.updated_by,updated_by_label=excluded.updated_by_label,
        updated_at=now();
  end loop;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('hours_saved','business_hours','weekly',p_actor_id,p_actor_label,p_actor_role,'{}'::jsonb);

  return coalesce((
    select jsonb_agg(to_jsonb(hours) order by hours.weekday)
    from atlas_private.settings_business_hours hours
  ),'[]'::jsonb);
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 30
create or replace function atlas_private.settings_save_offer(
  p_offer_id uuid,
  p_offer_key text,
  p_name text,
  p_description text,
  p_active boolean,
  p_days smallint[],
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_end_next_day boolean,
  p_pricing jsonb,
  p_booking_url text,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  offer_row atlas_private.settings_offers;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,false);
  perform atlas_private.settings_assert_safe_json(coalesce(p_pricing,'{}'::jsonb));
  if nullif(trim(coalesce(p_offer_key,'')),'') is null or trim(p_offer_key) !~ '^[a-z0-9][a-z0-9-]{1,99}$' then
    raise exception 'Offer key is invalid';
  end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Offer name is required'; end if;
  if p_start_time is null or p_end_time is null then raise exception 'Offer times are required'; end if;
  if exists (select 1 from unnest(coalesce(p_days,'{}'::smallint[])) day_value where day_value < 0 or day_value > 6) then
    raise exception 'Offer days are invalid';
  end if;

  if p_offer_id is null then
    insert into atlas_private.settings_offers(
      offer_key,name,description,active,days,start_time,end_time,end_next_day,
      pricing,booking_url,updated_by,updated_by_label
    ) values (
      trim(p_offer_key),left(trim(p_name),160),nullif(left(trim(coalesce(p_description,'')),3000),''),
      coalesce(p_active,false),coalesce(p_days,'{}'::smallint[]),p_start_time,p_end_time,
      coalesce(p_end_next_day,false),coalesce(p_pricing,'{}'::jsonb),
      nullif(left(trim(coalesce(p_booking_url,'')),3000),''),p_actor_id,p_actor_label
    ) returning * into offer_row;
  else
    select * into offer_row from atlas_private.settings_offers where id=p_offer_id for update;
    if not found then raise exception 'Offer not found'; end if;
    if p_expected_version is null or p_expected_version <> offer_row.version then
      raise exception 'Offer changed after this page was opened';
    end if;
    update atlas_private.settings_offers
    set offer_key=trim(p_offer_key),name=left(trim(p_name),160),
        description=nullif(left(trim(coalesce(p_description,'')),3000),''),
        active=coalesce(p_active,false),days=coalesce(p_days,'{}'::smallint[]),
        start_time=p_start_time,end_time=p_end_time,end_next_day=coalesce(p_end_next_day,false),
        pricing=coalesce(p_pricing,'{}'::jsonb),
        booking_url=nullif(left(trim(coalesce(p_booking_url,'')),3000),''),
        version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
    where id=p_offer_id returning * into offer_row;
  end if;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('offer_saved','offer',offer_row.offer_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('id',offer_row.id,'version',offer_row.version));
  return to_jsonb(offer_row);
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 31
create or replace function atlas_private.settings_save_role(
  p_role_key text,
  p_permissions jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  role_row atlas_private.settings_roles;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,false,true);
  perform atlas_private.settings_assert_safe_json(coalesce(p_permissions,'{}'::jsonb));
  if p_role_key not in ('admin','manager','bartender','viewer') then raise exception 'Unknown Atlas role'; end if;
  if p_role_key='admin' then raise exception 'Administrator permissions are protected'; end if;

  select * into role_row from atlas_private.settings_roles where role_key=p_role_key for update;
  if not found then raise exception 'Role settings not found'; end if;
  if p_expected_version is null or p_expected_version <> role_row.version then
    raise exception 'Role settings changed after this page was opened';
  end if;

  update atlas_private.settings_roles
  set permissions=coalesce(p_permissions,'{}'::jsonb),version=version+1,
      updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
  where role_key=p_role_key returning * into role_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('role_saved','role',p_role_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',role_row.version));
  return to_jsonb(role_row);
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 32
create or replace function atlas_private.settings_save_notification_policy(
  p_event_key text,
  p_enabled boolean,
  p_channels jsonb,
  p_target_roles text[],
  p_reminder_minutes integer[],
  p_escalation_minutes integer,
  p_manager_approval_required boolean,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  policy_row atlas_private.settings_notification_policies;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,false);
  perform atlas_private.settings_assert_safe_json(coalesce(p_channels,'{}'::jsonb));
  if exists (select 1 from unnest(coalesce(p_target_roles,'{}'::text[])) role_value where role_value not in ('admin','manager','bartender','viewer')) then
    raise exception 'Notification target role is invalid';
  end if;
  if exists (select 1 from unnest(coalesce(p_reminder_minutes,'{}'::integer[])) minute_value where minute_value < 0 or minute_value > 43200) then
    raise exception 'Notification reminder is invalid';
  end if;
  if p_escalation_minutes is not null and (p_escalation_minutes < 0 or p_escalation_minutes > 43200) then
    raise exception 'Notification escalation is invalid';
  end if;

  select * into policy_row
  from atlas_private.settings_notification_policies
  where event_key=p_event_key
  for update;
  if not found then raise exception 'Notification policy not found'; end if;
  if p_expected_version is null or p_expected_version <> policy_row.version then
    raise exception 'Notification policy changed after this page was opened';
  end if;

  update atlas_private.settings_notification_policies
  set enabled=coalesce(p_enabled,false),channels=coalesce(p_channels,'{}'::jsonb),
      target_roles=coalesce(p_target_roles,'{}'::text[]),
      reminder_minutes=coalesce(p_reminder_minutes,'{}'::integer[]),
      escalation_minutes=p_escalation_minutes,
      manager_approval_required=coalesce(p_manager_approval_required,false),
      version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
  where event_key=p_event_key returning * into policy_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('notification_saved','notification',p_event_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',policy_row.version));
  return to_jsonb(policy_row);
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 33
create or replace function atlas_private.settings_save_preferences(
  p_user_id uuid,
  p_theme text,
  p_density text,
  p_language text,
  p_start_view text,
  p_timezone text,
  p_reduce_motion boolean,
  p_browser_notifications boolean,
  p_email_notifications boolean,
  p_preferences jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  preference_row atlas_private.settings_user_preferences;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,false,false);
  perform atlas_private.settings_assert_safe_json(coalesce(p_preferences,'{}'::jsonb));
  if p_user_id is null or p_actor_id is null or p_user_id <> p_actor_id then
    raise exception 'Personal preferences can be saved only by their owner';
  end if;
  if p_theme not in ('dark','light','system') then raise exception 'Theme is invalid'; end if;
  if p_density not in ('comfortable','compact') then raise exception 'Density is invalid'; end if;
  if p_language not in ('en','is') then raise exception 'Language is invalid'; end if;
  if nullif(trim(coalesce(p_start_view,'')),'') is null then raise exception 'Start view is required'; end if;
  if nullif(trim(coalesce(p_timezone,'')),'') is null then raise exception 'Timezone is required'; end if;

  insert into atlas_private.settings_user_preferences(
    user_id,theme,density,language,start_view,timezone,reduce_motion,
    browser_notifications,email_notifications,preferences,updated_by,updated_by_label,updated_at
  ) values (
    p_user_id,p_theme,p_density,p_language,left(trim(p_start_view),80),left(trim(p_timezone),100),
    coalesce(p_reduce_motion,false),coalesce(p_browser_notifications,false),
    coalesce(p_email_notifications,false),coalesce(p_preferences,'{}'::jsonb),
    p_actor_id,p_actor_label,now()
  )
  on conflict (user_id) do update
  set theme=excluded.theme,density=excluded.density,language=excluded.language,
      start_view=excluded.start_view,timezone=excluded.timezone,
      reduce_motion=excluded.reduce_motion,
      browser_notifications=excluded.browser_notifications,
      email_notifications=excluded.email_notifications,
      preferences=excluded.preferences,updated_by=excluded.updated_by,
      updated_by_label=excluded.updated_by_label,updated_at=now()
  returning * into preference_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('preferences_saved','preference',p_user_id::text,p_actor_id,p_actor_label,p_actor_role,'{}'::jsonb);
  return to_jsonb(preference_row);
end;
$function$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 34
do $settings_function_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='atlas_private'
      and p.proname in (
        'settings_assert_actor','settings_assert_safe_json','settings_snapshot',
        'settings_save_section','settings_save_hours','settings_save_offer',
        'settings_save_role','settings_save_notification_policy','settings_save_preferences'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated',function_row.signature);
    execute format('grant execute on function %s to service_role',function_row.signature);
  end loop;
end
$settings_function_grants$;

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 35
comment on table atlas_private.settings_sections is
  'Checkpoint J canonical versioned Settings sections. The inventory, Brain and module rows are the settings contract consumed by Checkpoint K.';

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 36
comment on function atlas_private.settings_snapshot(jsonb,uuid,text) is
  'Service-role-only Checkpoint J snapshot. Returns no credentials and keeps production/destructive/automatic execution disabled.';

-- SOURCE supabase/migrations/20260804170000_atlas_settings_checkpoint_j_canonical.sql statement 37
notify pgrst, 'reload schema';

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 0
-- Checkpoint K: evidence-gated shortage, purchase, menu and waste intelligence.
-- Source records remain in production. The preview stores only private snapshots,
-- recommendation evidence and manager decisions. No operational mutation occurs.

create table if not exists atlas_private.brain_intelligence_snapshots (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  source_observed_at timestamptz,
  actor_id uuid,
  actor_label text,
  source_status jsonb not null default '{}'::jsonb,
  domains jsonb not null default '[]'::jsonb,
  recommendation_ids uuid[] not null default '{}',
  automatic_operational_mutation boolean not null default false
    check (automatic_operational_mutation is false),
  created_at timestamptz not null default now(),
  check (jsonb_typeof(source_status)='object'),
  check (jsonb_typeof(domains)='array')
);

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 1
create index if not exists brain_intelligence_snapshots_generated_idx
  on atlas_private.brain_intelligence_snapshots(generated_at desc);

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 2
alter table atlas_private.brain_intelligence_snapshots enable row level security;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 3
drop policy if exists "service role manages brain intelligence snapshots" on atlas_private.brain_intelligence_snapshots;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 4
create policy "service role manages brain intelligence snapshots"
  on atlas_private.brain_intelligence_snapshots for all to service_role
  using (true) with check (true);

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 5
revoke all on atlas_private.brain_intelligence_snapshots from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 6
grant all on atlas_private.brain_intelligence_snapshots to service_role;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 7
create or replace function atlas_private.phase3_intelligence_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'inventory',coalesce((select settings_value from atlas_private.settings_sections where section_key='inventory'),'{}'::jsonb),
    'brain',coalesce((select settings_value from atlas_private.settings_sections where section_key='brain'),'{}'::jsonb),
    'modules',coalesce((select settings_value from atlas_private.settings_sections where section_key='modules'),'{}'::jsonb),
    'trust',jsonb_build_object(
      'automatic_reorder_execution',false,
      'automatic_brain_execution',false,
      'automatic_menu_changes',false,
      'automatic_waste_attribution',false,
      'production_sync',false
    )
  );
$$;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 8
create or replace function atlas_private.sync_phase3_intelligence(
  p_connections jsonb,
  p_domains jsonb,
  p_recommendations jsonb,
  p_source_status jsonb,
  p_source_observed_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  connection_row record;
  recommendation jsonb;
  recommendation_id uuid;
  generated_ids uuid[] := '{}';
  generated_keys text[] := '{}';
  limitations text[];
  confidence_score numeric;
  snapshot_row atlas_private.brain_intelligence_snapshots;
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can refresh operational intelligence';
  end if;
  if jsonb_typeof(coalesce(p_connections,'[]'::jsonb))<>'array' then
    raise exception 'Intelligence connections must be an array';
  end if;
  if jsonb_typeof(coalesce(p_domains,'[]'::jsonb))<>'array' then
    raise exception 'Intelligence domains must be an array';
  end if;
  if jsonb_typeof(coalesce(p_recommendations,'[]'::jsonb))<>'array' then
    raise exception 'Intelligence recommendations must be an array';
  end if;
  if jsonb_typeof(coalesce(p_source_status,'{}'::jsonb))<>'object' then
    raise exception 'Intelligence source status must be an object';
  end if;

  for connection_row in
    select *
    from jsonb_to_recordset(coalesce(p_connections,'[]'::jsonb)) as connection(
      connection_key text,
      status text,
      last_verified_at timestamptz,
      metadata jsonb
    )
  loop
    if connection_row.status not in ('not_connected','pending_review','connected','degraded') then
      raise exception 'Checkpoint K cannot automatically assign connection status %',connection_row.status;
    end if;
    if not exists (
      select 1 from atlas_private.brain_data_connections
      where connection_key=connection_row.connection_key
    ) then
      raise exception 'Unknown Brain connection %',connection_row.connection_key;
    end if;
    if connection_row.metadata is not null and jsonb_typeof(connection_row.metadata)<>'object' then
      raise exception 'Brain connection metadata must be an object';
    end if;

    update atlas_private.brain_data_connections
    set status=connection_row.status,
        last_verified_at=connection_row.last_verified_at,
        metadata=metadata||jsonb_build_object('checkpoint_k',coalesce(connection_row.metadata,'{}'::jsonb)),
        updated_by=p_actor_id,
        updated_by_label=p_actor_label
    where connection_key=connection_row.connection_key;
  end loop;

  for recommendation in
    select value from jsonb_array_elements(coalesce(p_recommendations,'[]'::jsonb))
  loop
    if jsonb_typeof(recommendation)<>'object' then
      raise exception 'Intelligence recommendation must be an object';
    end if;
    if coalesce(recommendation->>'recommendation_key','') !~ '^checkpoint-k:[a-z0-9:_-]+$' then
      raise exception 'Checkpoint K recommendation key is invalid';
    end if;
    if recommendation->>'recommendation_type' not in ('data_quality','shortage','purchase','menu','waste','operations','governance') then
      raise exception 'Checkpoint K recommendation type is invalid';
    end if;
    if recommendation->>'confidence_state' not in ('verified','reviewed','pending','historical','modelled') then
      raise exception 'Checkpoint K confidence state is invalid';
    end if;
    confidence_score := coalesce((recommendation->>'confidence_score')::numeric,0);
    if confidence_score<0 or confidence_score>1 then
      raise exception 'Checkpoint K confidence score is invalid';
    end if;
    if jsonb_typeof(coalesce(recommendation->'suggested_action','{}'::jsonb))<>'object' then
      raise exception 'Checkpoint K suggested action must be an object';
    end if;
    if jsonb_typeof(coalesce(recommendation->'alternatives','[]'::jsonb))<>'array' then
      raise exception 'Checkpoint K alternatives must be an array';
    end if;
    if jsonb_typeof(coalesce(recommendation->'consequence_of_inaction','{}'::jsonb))<>'object' then
      raise exception 'Checkpoint K consequence must be an object';
    end if;
    if jsonb_typeof(coalesce(recommendation->'limitations','[]'::jsonb))<>'array' then
      raise exception 'Checkpoint K limitations must be an array';
    end if;

    select coalesce(array_agg(value),'{}'::text[])
    into limitations
    from jsonb_array_elements_text(coalesce(recommendation->'limitations','[]'::jsonb));

    recommendation_id := atlas_private.upsert_shadow_recommendation(
      recommendation->>'recommendation_key',
      recommendation->>'recommendation_type',
      recommendation->>'capability_key',
      recommendation->>'subject_type',
      recommendation->>'subject_key',
      recommendation->>'title',
      recommendation->>'summary',
      recommendation->>'explanation',
      coalesce(recommendation->'suggested_action','{}'::jsonb),
      coalesce(recommendation->'alternatives','[]'::jsonb),
      coalesce(recommendation->'consequence_of_inaction','{}'::jsonb),
      recommendation->>'confidence_state',
      confidence_score,
      recommendation->>'confidence_reason',
      limitations,
      coalesce((recommendation->>'priority')::integer,100),
      coalesce(recommendation->>'source_kind','edge_function'),
      recommendation->>'source_schema',
      recommendation->>'source_object',
      recommendation->>'source_row_key',
      coalesce(recommendation->>'evidence_label','Checkpoint K evidence'),
      coalesce(recommendation->'evidence_value','{}'::jsonb),
      coalesce(nullif(recommendation->>'observed_at','')::timestamptz,p_source_observed_at,pg_catalog.now())
    );

    generated_ids := array_append(generated_ids,recommendation_id);
    generated_keys := array_append(generated_keys,recommendation->>'recommendation_key');
  end loop;

  update atlas_private.brain_recommendations
  set status='expired',updated_at=pg_catalog.now()
  where recommendation_key like 'checkpoint-k:%'
    and status in ('active','deferred')
    and not (recommendation_key=any(generated_keys));

  insert into atlas_private.brain_intelligence_snapshots (
    generated_at,source_observed_at,actor_id,actor_label,source_status,domains,
    recommendation_ids,automatic_operational_mutation
  ) values (
    pg_catalog.now(),p_source_observed_at,p_actor_id,p_actor_label,
    coalesce(p_source_status,'{}'::jsonb),coalesce(p_domains,'[]'::jsonb),
    generated_ids,false
  ) returning * into snapshot_row;

  return jsonb_build_object(
    'version','atlas-intelligence-k/0.1.0',
    'snapshot_id',snapshot_row.id,
    'generated_at',snapshot_row.generated_at,
    'source_observed_at',snapshot_row.source_observed_at,
    'source_status',snapshot_row.source_status,
    'domains',snapshot_row.domains,
    'recommendation_ids',to_jsonb(snapshot_row.recommendation_ids),
    'recommendation_count',coalesce(array_length(snapshot_row.recommendation_ids,1),0),
    'automatic_operational_mutation',false
  );
end;
$$;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 9
create or replace function atlas_private.phase3_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
select jsonb_build_object(
  'version','atlas-phase3/0.2.0',
  'mode','shadow',
  'generated_at',pg_catalog.now(),
  'stats',jsonb_build_object(
    'active_recommendations',(select count(*) from atlas_private.brain_recommendations where status='active'),
    'deferred_recommendations',(select count(*) from atlas_private.brain_recommendations where status='deferred'),
    'manager_decisions',(select count(*) from atlas_private.brain_decisions),
    'recorded_outcomes',(select count(*) from atlas_private.brain_outcomes),
    'memory_events',(select count(*) from atlas_private.brain_decision_memory),
    'operational_signals',(select count(*) from atlas_private.brain_recommendations where status='active' and recommendation_key like 'checkpoint-k:%')
  ),
  'capabilities',coalesce((
    select jsonb_agg(jsonb_build_object(
      'key',capability_key,
      'label',label,
      'enabled',enabled,
      'confidence',jsonb_build_object('state',confidence_state,'score',confidence_score),
      'blockers',blockers,
      'required_connections',required_connections,
      'source',source_ref
    ) order by capability_key)
    from atlas_private.brain_capability_gates
  ),'[]'::jsonb),
  'intelligence',coalesce((
    select jsonb_build_object(
      'version','atlas-intelligence-k/0.1.0',
      'snapshot_id',snapshot.id,
      'generated_at',snapshot.generated_at,
      'source_observed_at',snapshot.source_observed_at,
      'source_status',snapshot.source_status,
      'domains',snapshot.domains,
      'recommendation_ids',to_jsonb(snapshot.recommendation_ids),
      'automatic_operational_mutation',snapshot.automatic_operational_mutation
    )
    from atlas_private.brain_intelligence_snapshots snapshot
    order by snapshot.generated_at desc
    limit 1
  ),jsonb_build_object(
    'version','atlas-intelligence-k/0.1.0',
    'generated_at',null,
    'source_status','{}'::jsonb,
    'domains','[]'::jsonb,
    'recommendation_ids','[]'::jsonb,
    'automatic_operational_mutation',false
  )),
  'recommendations',coalesce((
    select jsonb_agg(to_jsonb(feed) order by feed.priority,feed.recommendation_key)
    from atlas_private.brain_recommendation_feed feed
    where feed.status in ('active','deferred')
      and (feed.valid_until is null or feed.valid_until>pg_catalog.now())
  ),'[]'::jsonb),
  'memory',coalesce((
    select jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc)
    from (
      select * from atlas_private.brain_decision_memory
      order by occurred_at desc
      limit 30
    ) memory
  ),'[]'::jsonb),
  'trust',jsonb_build_object(
    'ai_generation_used',false,
    'automatic_ordering',false,
    'automatic_menu_changes',false,
    'automatic_operational_mutation',false,
    'historical_stock_used_for_prediction',false,
    'negative_adjustments_treated_as_waste',false,
    'sales_performance_inference',false,
    'manager_review_required',true
  )
);
$$;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 10
create or replace function public.atlas_phase3_intelligence_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$ select atlas_private.phase3_intelligence_settings(); $$;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 11
create or replace function public.atlas_phase3_sync_intelligence(
  p_connections jsonb,
  p_domains jsonb,
  p_recommendations jsonb,
  p_source_status jsonb,
  p_source_observed_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.sync_phase3_intelligence(
    p_connections,p_domains,p_recommendations,p_source_status,p_source_observed_at,
    p_actor_id,p_actor_label,p_actor_role
  );
$$;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 12
revoke execute on function public.atlas_phase3_intelligence_settings() from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 13
revoke execute on function public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 14
grant execute on function public.atlas_phase3_intelligence_settings() to service_role;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 15
grant execute on function public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 16
comment on table atlas_private.brain_intelligence_snapshots is
  'Private Checkpoint K source coverage and four-domain shadow-intelligence snapshots. Never mutates operational source records.';

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 17
comment on function public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text) is
  'Service-role-only Checkpoint K synchronization of evidence-gated shortage, purchase, menu and explicit-waste recommendations.';

-- SOURCE supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql statement 18
comment on function public.atlas_phase3_intelligence_settings() is
  'Service-role-only safe settings subset used by the Checkpoint K deterministic intelligence gateway.';

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 0
-- Checkpoint L1: manager-verified current stock-count sessions.
-- Counts are private preview evidence. Verification creates a private current
-- balance for Atlas intelligence; production inventory is never mutated here.

create table if not exists atlas_private.inventory_count_settings (
  setting_key text primary key,
  freshness_days integer not null default 7 check (freshness_days between 1 and 90),
  allow_staff_start boolean not null default true,
  allow_staff_submit boolean not null default true,
  production_apply_enabled boolean not null default false check (production_apply_enabled is false),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 1
create table if not exists atlas_private.inventory_count_sessions (
  id uuid primary key default gen_random_uuid(),
  session_key text not null unique,
  client_request_id text not null unique,
  title text not null,
  status text not null default 'draft'
    check (status in ('draft','submitted','verified','rejected','cancelled')),
  scope_type text not null default 'all'
    check (scope_type in ('all','location','category')),
  scope_value text,
  notes text,
  inventory_snapshot_at timestamptz not null default now(),
  source_record_count integer not null default 0 check (source_record_count >= 0),
  started_by uuid not null,
  started_by_label text not null,
  started_at timestamptz not null default now(),
  submitted_by uuid,
  submitted_by_label text,
  submitted_at timestamptz,
  verified_by uuid,
  verified_by_label text,
  verified_at timestamptz,
  rejected_by uuid,
  rejected_by_label text,
  rejected_at timestamptz,
  rejected_reason text,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  conflicts_acknowledged boolean not null default false,
  production_applied boolean not null default false check (production_applied is false),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope_type='all' and scope_value is null) or (scope_type<>'all' and nullif(trim(scope_value),'') is not null)),
  check ((status='submitted' and submitted_at is not null) or status<>'submitted'),
  check ((status='verified' and verified_at is not null) or status<>'verified'),
  check ((status='rejected' and rejected_at is not null and nullif(trim(rejected_reason),'') is not null) or status<>'rejected')
);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 2
create table if not exists atlas_private.inventory_count_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references atlas_private.inventory_count_sessions(id) on delete cascade,
  inventory_item_id uuid not null,
  item_name text not null,
  category text,
  inventory_unit text not null default 'units',
  bin_location text,
  sku text,
  barcode text,
  expected_quantity numeric not null default 0,
  expected_updated_at timestamptz,
  source_updated_at date,
  source_kind text not null default 'production_observation'
    check (source_kind in ('production_observation','historical_snapshot','manager_verified_count')),
  observed_quantity numeric check (observed_quantity is null or observed_quantity >= 0),
  observed_unit text,
  line_status text not null default 'pending'
    check (line_status in ('pending','counted','skipped')),
  count_method text
    check (count_method is null or count_method in ('manual','barcode','photo','import')),
  note text,
  skipped_reason text,
  counted_by uuid,
  counted_by_label text,
  counted_at timestamptz,
  source_changed_since_start boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id,inventory_item_id),
  check ((line_status='counted' and observed_quantity is not null and counted_at is not null) or line_status<>'counted'),
  check ((line_status='skipped' and nullif(trim(skipped_reason),'') is not null) or line_status<>'skipped')
);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 3
create table if not exists atlas_private.inventory_verified_balances (
  inventory_item_id uuid primary key,
  item_name text not null,
  category text,
  inventory_unit text not null,
  bin_location text,
  verified_quantity numeric not null check (verified_quantity >= 0),
  verification_status text not null default 'current'
    check (verification_status in ('current','revoked')),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  source_session_id uuid not null references atlas_private.inventory_count_sessions(id) on delete restrict,
  source_line_id uuid not null references atlas_private.inventory_count_lines(id) on delete restrict,
  verified_by uuid not null,
  verified_by_label text not null,
  production_quantity_at_verification numeric,
  production_updated_at timestamptz,
  variance numeric,
  source_kind text not null default 'manager_verified_count'
    check (source_kind='manager_verified_count'),
  historical boolean not null default false check (historical is false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > verified_at)
);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 4
create table if not exists atlas_private.inventory_count_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('session_started','line_saved','session_submitted','session_verified','session_rejected','session_cancelled')),
  session_id uuid references atlas_private.inventory_count_sessions(id) on delete set null,
  line_id uuid references atlas_private.inventory_count_lines(id) on delete set null,
  inventory_item_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 5
create index if not exists inventory_count_sessions_status_started_idx
  on atlas_private.inventory_count_sessions(status,started_at desc);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 6
create index if not exists inventory_count_sessions_started_by_idx
  on atlas_private.inventory_count_sessions(started_by,started_at desc);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 7
create index if not exists inventory_count_lines_session_status_idx
  on atlas_private.inventory_count_lines(session_id,line_status,item_name);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 8
create index if not exists inventory_count_lines_item_idx
  on atlas_private.inventory_count_lines(inventory_item_id,created_at desc);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 9
create index if not exists inventory_verified_balances_freshness_idx
  on atlas_private.inventory_verified_balances(verification_status,expires_at);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 10
create index if not exists inventory_count_events_session_created_idx
  on atlas_private.inventory_count_events(session_id,created_at desc);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 11
alter table atlas_private.inventory_count_settings enable row level security;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 12
alter table atlas_private.inventory_count_sessions enable row level security;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 13
alter table atlas_private.inventory_count_lines enable row level security;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 14
alter table atlas_private.inventory_verified_balances enable row level security;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 15
alter table atlas_private.inventory_count_events enable row level security;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 16
drop policy if exists "service role manages inventory count settings" on atlas_private.inventory_count_settings;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 17
create policy "service role manages inventory count settings" on atlas_private.inventory_count_settings
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 18
drop policy if exists "service role manages inventory count sessions" on atlas_private.inventory_count_sessions;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 19
create policy "service role manages inventory count sessions" on atlas_private.inventory_count_sessions
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 20
drop policy if exists "service role manages inventory count lines" on atlas_private.inventory_count_lines;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 21
create policy "service role manages inventory count lines" on atlas_private.inventory_count_lines
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 22
drop policy if exists "service role manages inventory verified balances" on atlas_private.inventory_verified_balances;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 23
create policy "service role manages inventory verified balances" on atlas_private.inventory_verified_balances
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 24
drop policy if exists "service role manages inventory count events" on atlas_private.inventory_count_events;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 25
create policy "service role manages inventory count events" on atlas_private.inventory_count_events
  for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 26
revoke all on atlas_private.inventory_count_settings from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 27
revoke all on atlas_private.inventory_count_sessions from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 28
revoke all on atlas_private.inventory_count_lines from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 29
revoke all on atlas_private.inventory_verified_balances from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 30
revoke all on atlas_private.inventory_count_events from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 31
grant all on atlas_private.inventory_count_settings to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 32
grant all on atlas_private.inventory_count_sessions to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 33
grant all on atlas_private.inventory_count_lines to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 34
grant all on atlas_private.inventory_verified_balances to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 35
grant all on atlas_private.inventory_count_events to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 36
drop trigger if exists inventory_count_settings_touch on atlas_private.inventory_count_settings;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 37
create trigger inventory_count_settings_touch before update on atlas_private.inventory_count_settings
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 38
drop trigger if exists inventory_count_sessions_touch on atlas_private.inventory_count_sessions;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 39
create trigger inventory_count_sessions_touch before update on atlas_private.inventory_count_sessions
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 40
drop trigger if exists inventory_count_lines_touch on atlas_private.inventory_count_lines;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 41
create trigger inventory_count_lines_touch before update on atlas_private.inventory_count_lines
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 42
drop trigger if exists inventory_verified_balances_touch on atlas_private.inventory_verified_balances;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 43
create trigger inventory_verified_balances_touch before update on atlas_private.inventory_verified_balances
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 44
insert into atlas_private.inventory_count_settings (
  setting_key,freshness_days,allow_staff_start,allow_staff_submit,production_apply_enabled
) values ('va',7,true,true,false)
on conflict (setting_key) do update set
  production_apply_enabled=false,
  updated_at=now();

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 45
create or replace function atlas_private.stock_count_session_summary(p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'total_lines',count(*)::bigint,
    'counted_lines',count(*) filter (where line_status='counted')::bigint,
    'skipped_lines',count(*) filter (where line_status='skipped')::bigint,
    'pending_lines',count(*) filter (where line_status='pending')::bigint,
    'changed_source_lines',count(*) filter (where source_changed_since_start=true)::bigint,
    'progress_percent',case when count(*)=0 then 0 else round(
      100.0*(count(*) filter (where line_status in ('counted','skipped')))::numeric/count(*)::numeric,1
    ) end,
    'positive_variances',count(*) filter (where line_status='counted' and observed_quantity>expected_quantity)::bigint,
    'negative_variances',count(*) filter (where line_status='counted' and observed_quantity<expected_quantity)::bigint,
    'unchanged_lines',count(*) filter (where line_status='counted' and observed_quantity=expected_quantity)::bigint
  )
  from atlas_private.inventory_count_lines
  where session_id=p_session_id;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 46
create or replace function atlas_private.stock_count_detail(
  p_session_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  select * into session_row
  from atlas_private.inventory_count_sessions
  where id=p_session_id;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  if p_actor_role='viewer' and session_row.status<>'verified' then
    raise exception 'This stock-count session is not available to viewers';
  end if;

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'summary',atlas_private.stock_count_session_summary(session_row.id),
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',line.id,
        'session_id',line.session_id,
        'inventory_item_id',line.inventory_item_id,
        'item_name',line.item_name,
        'category',line.category,
        'inventory_unit',line.inventory_unit,
        'bin_location',line.bin_location,
        'sku',line.sku,
        'barcode',line.barcode,
        'expected_quantity',line.expected_quantity,
        'expected_updated_at',line.expected_updated_at,
        'source_updated_at',line.source_updated_at,
        'source_kind',line.source_kind,
        'observed_quantity',line.observed_quantity,
        'observed_unit',line.observed_unit,
        'line_status',line.line_status,
        'count_method',line.count_method,
        'note',line.note,
        'skipped_reason',line.skipped_reason,
        'counted_by',line.counted_by,
        'counted_by_label',line.counted_by_label,
        'counted_at',line.counted_at,
        'source_changed_since_start',line.source_changed_since_start,
        'variance',case when line.observed_quantity is null then null else line.observed_quantity-line.expected_quantity end,
        'version',line.version,
        'updated_at',line.updated_at
      ) order by coalesce(line.bin_location,''),coalesce(line.category,''),line.item_name)
      from atlas_private.inventory_count_lines line
      where line.session_id=session_row.id
    ),'[]'::jsonb),
    'permissions',jsonb_build_object(
      'can_edit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_submit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_verify',(is_manager and session_row.status='submitted'),
      'can_reject',(is_manager and session_row.status='submitted'),
      'can_cancel',((is_manager or session_row.started_by=p_actor_id) and session_row.status in ('draft','submitted')),
      'production_apply_enabled',false
    ),
    'trust',jsonb_build_object(
      'production_inventory_mutated',false,
      'manager_verification_required',true,
      'historical_rows_are_current',false,
      'verified_balances_are_private',true
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 47
create or replace function atlas_private.stock_count_snapshot(
  p_inventory jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.inventory_count_settings;
  sessions_json jsonb := '[]'::jsonb;
  catalog_json jsonb := '[]'::jsonb;
  balances_json jsonb := '[]'::jsonb;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then
    raise exception 'Inventory catalog must be an array';
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',session.id,
    'session_key',session.session_key,
    'title',session.title,
    'status',session.status,
    'scope_type',session.scope_type,
    'scope_value',session.scope_value,
    'started_by',session.started_by,
    'started_by_label',session.started_by_label,
    'started_at',session.started_at,
    'submitted_at',session.submitted_at,
    'verified_at',session.verified_at,
    'verified_by_label',session.verified_by_label,
    'conflict_count',session.conflict_count,
    'conflicts_acknowledged',session.conflicts_acknowledged,
    'version',session.version,
    'summary',atlas_private.stock_count_session_summary(session.id)
  ) order by session.started_at desc),'[]'::jsonb)
  into sessions_json
  from atlas_private.inventory_count_sessions session
  where p_actor_role<>'viewer' or session.status='verified';

  with items as (
    select item
    from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item
    where coalesce((item->>'active')::boolean,true)=true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item->>'id',
    'name',item->>'name',
    'category',item->>'category',
    'quantity',coalesce(nullif(item->>'quantity','')::numeric,0),
    'unit',coalesce(nullif(item->>'unit',''),'units'),
    'par_level',nullif(item->>'par_level','')::numeric,
    'bin_location',nullif(item->>'bin_location',''),
    'sku',nullif(item->>'sku',''),
    'barcode',nullif(item->>'barcode',''),
    'updated_at',nullif(item->>'updated_at','')::timestamptz,
    'source_updated_at',nullif(item->>'source_updated_at','')::date,
    'source_kind',case
      when balance.inventory_item_id is not null and balance.verification_status='current' and balance.expires_at>now() then 'manager_verified_count'
      when nullif(item->>'source_updated_at','')::date<=date '2026-07-26' then 'historical_snapshot'
      else 'production_observation'
    end,
    'verified_quantity',balance.verified_quantity,
    'verified_at',balance.verified_at,
    'verified_expires_at',balance.expires_at,
    'freshness_state',case
      when balance.inventory_item_id is null then 'unverified'
      when balance.verification_status<>'current' then 'revoked'
      when balance.expires_at<=now() then 'stale'
      else 'current'
    end
  ) order by coalesce(item->>'bin_location',''),coalesce(item->>'category',''),item->>'name'),'[]'::jsonb)
  into catalog_json
  from items
  left join atlas_private.inventory_verified_balances balance
    on balance.inventory_item_id=(item->>'id')::uuid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'inventory_item_id',balance.inventory_item_id,
    'item_name',balance.item_name,
    'category',balance.category,
    'inventory_unit',balance.inventory_unit,
    'bin_location',balance.bin_location,
    'verified_quantity',balance.verified_quantity,
    'verified_at',balance.verified_at,
    'expires_at',balance.expires_at,
    'verified_by_label',balance.verified_by_label,
    'source_session_id',balance.source_session_id,
    'variance',balance.variance,
    'freshness_state',case
      when balance.verification_status<>'current' then 'revoked'
      when balance.expires_at<=now() then 'stale'
      else 'current'
    end
  ) order by balance.verified_at desc),'[]'::jsonb)
  into balances_json
  from atlas_private.inventory_verified_balances balance;

  return jsonb_build_object(
    'version','atlas-stock-counts/0.1.0',
    'generated_at',now(),
    'sessions',sessions_json,
    'catalog',catalog_json,
    'verified_balances',balances_json,
    'settings',to_jsonb(settings_row),
    'summary',jsonb_build_object(
      'draft_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='draft'),
      'submitted_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='submitted'),
      'verified_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='verified'),
      'current_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at>now()),
      'stale_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at<=now()),
      'catalog_items',jsonb_array_length(catalog_json)
    ),
    'permissions',jsonb_build_object(
      'can_start',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_start)),
      'can_count',(p_actor_role in ('admin','manager','bartender')),
      'can_submit',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_submit)),
      'can_verify',is_manager,
      'production_apply_enabled',false
    ),
    'trust',jsonb_build_object(
      'shadow_mode',true,
      'production_inventory_mutation',false,
      'automatic_inventory_adjustment',false,
      'manager_verification_required',true,
      'historical_inventory_used_as_current',false,
      'verified_balance_source','manager_verified_count'
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 48
create or replace function atlas_private.stock_count_start(
  p_inventory jsonb,
  p_title text,
  p_scope_type text,
  p_scope_value text,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_client_request_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  inserted_count integer;
  settings_row atlas_private.inventory_count_settings;
begin
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot start stock counts'; end if;
  if p_actor_role='bartender' and not settings_row.allow_staff_start then raise exception 'Staff-started stock counts are disabled'; end if;
  if p_scope_type not in ('all','location','category') then raise exception 'Stock-count scope is invalid'; end if;
  if p_scope_type<>'all' and nullif(trim(coalesce(p_scope_value,'')),'') is null then raise exception 'A scope value is required'; end if;
  if nullif(trim(coalesce(p_client_request_id,'')),'') is null then raise exception 'A client request ID is required'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;

  select * into session_row
  from atlas_private.inventory_count_sessions
  where client_request_id=p_client_request_id;
  if found then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;

  insert into atlas_private.inventory_count_sessions (
    session_key,client_request_id,title,scope_type,scope_value,notes,inventory_snapshot_at,
    started_by,started_by_label
  ) values (
    'count-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,8),
    trim(p_client_request_id),
    coalesce(nullif(trim(coalesce(p_title,'')),''),'Current stock count'),
    p_scope_type,
    case when p_scope_type='all' then null else trim(p_scope_value) end,
    nullif(trim(coalesce(p_notes,'')),''),
    now(),p_actor_id,p_actor_label
  ) returning * into session_row;

  insert into atlas_private.inventory_count_lines (
    session_id,inventory_item_id,item_name,category,inventory_unit,bin_location,sku,barcode,
    expected_quantity,expected_updated_at,source_updated_at,source_kind,observed_unit
  )
  select
    session_row.id,
    (item->>'id')::uuid,
    coalesce(nullif(item->>'name',''),'Unnamed inventory item'),
    nullif(item->>'category',''),
    coalesce(nullif(item->>'unit',''),'units'),
    nullif(item->>'bin_location',''),
    nullif(item->>'sku',''),
    nullif(item->>'barcode',''),
    coalesce(nullif(item->>'quantity','')::numeric,0),
    nullif(item->>'updated_at','')::timestamptz,
    nullif(item->>'source_updated_at','')::date,
    case when nullif(item->>'source_updated_at','')::date<=date '2026-07-26'
      then 'historical_snapshot' else 'production_observation' end,
    coalesce(nullif(item->>'unit',''),'units')
  from jsonb_array_elements(p_inventory) item
  where coalesce((item->>'active')::boolean,true)=true
    and (
      p_scope_type='all'
      or (p_scope_type='location' and lower(coalesce(item->>'bin_location',''))=lower(trim(p_scope_value)))
      or (p_scope_type='category' and lower(coalesce(item->>'category',''))=lower(trim(p_scope_value)))
    );

  get diagnostics inserted_count=row_count;
  if inserted_count=0 then
    delete from atlas_private.inventory_count_sessions where id=session_row.id;
    raise exception 'No active inventory items match this stock-count scope';
  end if;

  update atlas_private.inventory_count_sessions
  set source_record_count=inserted_count
  where id=session_row.id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_started',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('scope_type',p_scope_type,'scope_value',case when p_scope_type='all' then null else trim(p_scope_value) end,'source_record_count',inserted_count)
  );

  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 49
create or replace function atlas_private.stock_count_save_line(
  p_session_id uuid,
  p_line_id uuid,
  p_line_status text,
  p_observed_quantity numeric,
  p_count_method text,
  p_note text,
  p_skipped_reason text,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot count inventory'; end if;
  if p_line_status not in ('pending','counted','skipped') then raise exception 'Count-line status is invalid'; end if;
  if p_count_method is not null and p_count_method not in ('manual','barcode','photo','import') then raise exception 'Count method is invalid'; end if;
  if p_line_status='counted' and (p_observed_quantity is null or p_observed_quantity<0) then raise exception 'A counted line requires a quantity of zero or more'; end if;
  if p_line_status='skipped' and nullif(trim(coalesce(p_skipped_reason,'')),'') is null then raise exception 'A skipped line requires a reason'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be edited'; end if;

  update atlas_private.inventory_count_lines
  set line_status=p_line_status,
      observed_quantity=case when p_line_status='counted' then p_observed_quantity else null end,
      observed_unit=case when p_line_status='counted' then inventory_unit else observed_unit end,
      count_method=case when p_line_status='counted' then coalesce(p_count_method,'manual') else null end,
      note=nullif(trim(coalesce(p_note,'')),''),
      skipped_reason=case when p_line_status='skipped' then trim(p_skipped_reason) else null end,
      counted_by=case when p_line_status='counted' then p_actor_id else null end,
      counted_by_label=case when p_line_status='counted' then p_actor_label else null end,
      counted_at=case when p_line_status='counted' then now() else null end,
      version=version+1
  where id=p_line_id and session_id=p_session_id and version=p_expected_version
  returning * into line_row;
  if not found then raise exception 'This count line changed in another session. Refresh and try again'; end if;

  update atlas_private.inventory_count_sessions
  set version=version+1
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,line_id,inventory_item_id,actor_id,actor_label,actor_role,payload
  ) values (
    'line_saved',p_session_id,line_row.id,line_row.inventory_item_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('line_status',line_row.line_status,'observed_quantity',line_row.observed_quantity,'count_method',line_row.count_method,'line_version',line_row.version)
  );

  return jsonb_build_object('line',to_jsonb(line_row),'summary',atlas_private.stock_count_session_summary(p_session_id));
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 50
create or replace function atlas_private.stock_count_submit(
  p_session_id uuid,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  pending_count integer;
  settings_row atlas_private.inventory_count_settings;
begin
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot submit stock counts'; end if;
  if p_actor_role='bartender' and not settings_row.allow_staff_submit then raise exception 'Staff stock-count submission is disabled'; end if;
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status='submitted' then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be submitted'; end if;
  select count(*) into pending_count from atlas_private.inventory_count_lines where session_id=p_session_id and line_status='pending';
  if pending_count>0 then raise exception 'Complete or skip every count line before submission'; end if;

  update atlas_private.inventory_count_sessions
  set status='submitted',submitted_by=p_actor_id,submitted_by_label=p_actor_label,submitted_at=now(),
      notes=coalesce(nullif(trim(coalesce(p_notes,'')),''),notes),version=version+1
  where id=p_session_id
  returning * into session_row;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_submitted',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    atlas_private.stock_count_session_summary(session_row.id)
  );
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 51
create or replace function atlas_private.stock_count_verify(
  p_session_id uuid,
  p_inventory jsonb,
  p_acknowledge_conflicts boolean,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  conflict_count_value integer := 0;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can verify stock counts'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status='verified' then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;
  if session_row.status<>'submitted' then raise exception 'Only submitted stock counts can be verified'; end if;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  select count(*) into conflict_count_value
  from atlas_private.inventory_count_lines line
  left join current_inventory current on current.inventory_item_id=line.inventory_item_id
  where line.session_id=p_session_id and line.line_status='counted'
    and (
      current.inventory_item_id is null
      or current.quantity is distinct from line.expected_quantity
      or current.updated_at is distinct from line.expected_updated_at
    );

  if conflict_count_value>0 and not coalesce(p_acknowledge_conflicts,false) then
    raise exception 'The production source changed for % counted item(s). Review and acknowledge the conflicts before verification',conflict_count_value;
  end if;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  update atlas_private.inventory_count_lines line
  set source_changed_since_start=(
    current.inventory_item_id is null
    or current.quantity is distinct from line.expected_quantity
    or current.updated_at is distinct from line.expected_updated_at
  )
  from current_inventory current
  where line.session_id=p_session_id and line.inventory_item_id=current.inventory_item_id;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  insert into atlas_private.inventory_verified_balances (
    inventory_item_id,item_name,category,inventory_unit,bin_location,verified_quantity,
    verification_status,verified_at,expires_at,source_session_id,source_line_id,
    verified_by,verified_by_label,production_quantity_at_verification,production_updated_at,variance
  )
  select
    line.inventory_item_id,line.item_name,line.category,line.inventory_unit,line.bin_location,line.observed_quantity,
    'current',now(),now()+make_interval(days=>settings_row.freshness_days),line.session_id,line.id,
    p_actor_id,p_actor_label,current.quantity,current.updated_at,line.observed_quantity-current.quantity
  from atlas_private.inventory_count_lines line
  left join current_inventory current on current.inventory_item_id=line.inventory_item_id
  where line.session_id=p_session_id and line.line_status='counted'
  on conflict (inventory_item_id) do update set
    item_name=excluded.item_name,
    category=excluded.category,
    inventory_unit=excluded.inventory_unit,
    bin_location=excluded.bin_location,
    verified_quantity=excluded.verified_quantity,
    verification_status='current',
    verified_at=excluded.verified_at,
    expires_at=excluded.expires_at,
    source_session_id=excluded.source_session_id,
    source_line_id=excluded.source_line_id,
    verified_by=excluded.verified_by,
    verified_by_label=excluded.verified_by_label,
    production_quantity_at_verification=excluded.production_quantity_at_verification,
    production_updated_at=excluded.production_updated_at,
    variance=excluded.variance,
    source_kind='manager_verified_count',
    historical=false,
    updated_at=now();

  update atlas_private.inventory_count_sessions
  set status='verified',verified_by=p_actor_id,verified_by_label=p_actor_label,verified_at=now(),
      conflict_count=conflict_count_value,conflicts_acknowledged=(conflict_count_value=0 or coalesce(p_acknowledge_conflicts,false)),
      version=version+1
  where id=p_session_id
  returning * into session_row;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_verified',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('conflict_count',conflict_count_value,'conflicts_acknowledged',session_row.conflicts_acknowledged,'freshness_days',settings_row.freshness_days,'production_applied',false)
  );

  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 52
create or replace function atlas_private.stock_count_reject(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare session_row atlas_private.inventory_count_sessions;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can reject stock counts'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A rejection reason is required'; end if;
  update atlas_private.inventory_count_sessions
  set status='rejected',rejected_by=p_actor_id,rejected_by_label=p_actor_label,rejected_at=now(),
      rejected_reason=trim(p_reason),version=version+1
  where id=p_session_id and status='submitted'
  returning * into session_row;
  if not found then raise exception 'Only a submitted stock count can be rejected'; end if;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values ('session_rejected',session_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('reason',trim(p_reason)));
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 53
create or replace function atlas_private.stock_count_cancel(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare session_row atlas_private.inventory_count_sessions;
begin
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role not in ('admin','manager') and session_row.started_by<>p_actor_id then raise exception 'This profile cannot cancel this stock count'; end if;
  if session_row.status not in ('draft','submitted') then raise exception 'This stock count can no longer be cancelled'; end if;
  update atlas_private.inventory_count_sessions
  set status='cancelled',rejected_reason=nullif(trim(coalesce(p_reason,'')),''),version=version+1
  where id=p_session_id
  returning * into session_row;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values ('session_cancelled',session_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('reason',nullif(trim(coalesce(p_reason,'')),'')));
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 54
create or replace function atlas_private.stock_count_verified_balances()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'inventory_item_id',balance.inventory_item_id,
    'item_name',balance.item_name,
    'category',balance.category,
    'inventory_unit',balance.inventory_unit,
    'bin_location',balance.bin_location,
    'verified_quantity',balance.verified_quantity,
    'verified_at',balance.verified_at,
    'expires_at',balance.expires_at,
    'source_session_id',balance.source_session_id,
    'source_line_id',balance.source_line_id,
    'verified_by_label',balance.verified_by_label,
    'production_quantity_at_verification',balance.production_quantity_at_verification,
    'production_updated_at',balance.production_updated_at,
    'variance',balance.variance,
    'source_kind',balance.source_kind,
    'historical',balance.historical,
    'freshness_state',case
      when balance.verification_status<>'current' then 'revoked'
      when balance.expires_at<=now() then 'stale'
      else 'current'
    end
  ) order by balance.verified_at desc),'[]'::jsonb)
  from atlas_private.inventory_verified_balances balance;
$$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 55
create or replace function public.atlas_stock_count_snapshot(jsonb,uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.stock_count_snapshot($1,$2,$3); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 56
create or replace function public.atlas_stock_count_detail(uuid,uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.stock_count_detail($1,$2,$3); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 57
create or replace function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_start($1,$2,$3,$4,$5,$6,$7,$8,$9); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 58
create or replace function public.atlas_stock_count_save_line(uuid,uuid,text,numeric,text,text,text,integer,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_save_line($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 59
create or replace function public.atlas_stock_count_submit(uuid,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_submit($1,$2,$3,$4,$5); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 60
create or replace function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_verify($1,$2,$3,$4,$5,$6); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 61
create or replace function public.atlas_stock_count_reject(uuid,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_reject($1,$2,$3,$4,$5); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 62
create or replace function public.atlas_stock_count_cancel(uuid,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_cancel($1,$2,$3,$4,$5); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 63
create or replace function public.atlas_stock_count_verified_balances()
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.stock_count_verified_balances(); $$;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 64
revoke execute on function public.atlas_stock_count_snapshot(jsonb,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 65
revoke execute on function public.atlas_stock_count_detail(uuid,uuid,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 66
revoke execute on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 67
revoke execute on function public.atlas_stock_count_save_line(uuid,uuid,text,numeric,text,text,text,integer,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 68
revoke execute on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 69
revoke execute on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 70
revoke execute on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 71
revoke execute on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 72
revoke execute on function public.atlas_stock_count_verified_balances() from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 73
grant execute on function public.atlas_stock_count_snapshot(jsonb,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 74
grant execute on function public.atlas_stock_count_detail(uuid,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 75
grant execute on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 76
grant execute on function public.atlas_stock_count_save_line(uuid,uuid,text,numeric,text,text,text,integer,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 77
grant execute on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 78
grant execute on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 79
grant execute on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 80
grant execute on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 81
grant execute on function public.atlas_stock_count_verified_balances() to service_role;

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 82
comment on table atlas_private.inventory_count_sessions is
  'Private Checkpoint L1 count sessions. Verification records evidence only; production inventory is never changed.';

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 83
comment on table atlas_private.inventory_verified_balances is
  'Manager-verified current stock evidence used by Atlas intelligence until its freshness window expires.';

-- SOURCE supabase/migrations/20260805123000_atlas_stock_counts_checkpoint_l1.sql statement 84
comment on function public.atlas_stock_count_verified_balances() is
  'Service-role-only current count evidence for evidence-gated Atlas intelligence.';

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 0
-- Checkpoint L1: unit-aware, manager-verifiable stock-count evidence.
--
-- Observations remain private. This migration records both the quantity entered
-- by the counter and the normalized inventory-base quantity, while explicitly
-- classifying every catalog quantity as current, stale, historical or
-- unverified. No production inventory row is changed here.

alter table atlas_private.inventory_count_lines
  add column if not exists observed_input_quantity numeric,
  add column if not exists observed_input_unit text,
  add column if not exists conversion_factor numeric,
  add column if not exists conversion_basis text,
  add column if not exists units_per_case_snapshot numeric,
  add column if not exists size_ml_snapshot numeric,
  add column if not exists package_size_snapshot text,
  add column if not exists package_weight_g_snapshot numeric,
  add column if not exists par_level_snapshot numeric,
  add column if not exists supplier_snapshot text,
  add column if not exists unit_cost_snapshot numeric,
  add column if not exists case_cost_snapshot numeric,
  add column if not exists source_file_snapshot text,
  add column if not exists count_evidence jsonb not null default '{}'::jsonb;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 1
alter table atlas_private.inventory_count_lines
  drop constraint if exists inventory_count_lines_count_evidence_check;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 2
alter table atlas_private.inventory_count_lines
  add constraint inventory_count_lines_count_evidence_check
  check (jsonb_typeof(count_evidence) = 'object');

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 3
create or replace function atlas_private.stock_count_package_weight_g(p_package_size text)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when coalesce(p_package_size,'') ~* '^\s*[0-9]+(?:\.[0-9]+)?\s*kg\s*$'
      then regexp_replace(p_package_size,'[^0-9.]','','g')::numeric * 1000
    when coalesce(p_package_size,'') ~* '^\s*[0-9]+(?:\.[0-9]+)?\s*g\s*$'
      then regexp_replace(p_package_size,'[^0-9.]','','g')::numeric
    else null
  end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 4
create or replace function atlas_private.stock_count_quantity_status(
  p_inventory_item_id uuid,
  p_source_updated_at date
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  balance_row atlas_private.inventory_verified_balances;
begin
  select * into balance_row
  from atlas_private.inventory_verified_balances
  where inventory_item_id = p_inventory_item_id
  order by verified_at desc
  limit 1;

  if found and balance_row.verification_status = 'current' and balance_row.expires_at > now() then
    return 'current';
  end if;
  if found then
    return 'stale';
  end if;
  if p_source_updated_at is not null and p_source_updated_at <= date '2026-07-31' then
    return 'historical';
  end if;
  return 'unverified';
end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 5
create or replace function atlas_private.stock_count_supported_units(
  p_inventory_unit text,
  p_units_per_case numeric,
  p_size_ml numeric,
  p_package_weight_g numeric
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  with normalized as (
    select lower(trim(coalesce(p_inventory_unit,'units'))) as inventory_unit
  ), options(sort_order, unit_key, allowed) as (
    values
      (1, 'inventory'::text, true),
      (2, 'bottle'::text, (select inventory_unit in ('bottle','bottles') from normalized) or coalesce(p_size_ml,0) > 0),
      (3, 'case'::text, coalesce(p_units_per_case,0) > 0),
      (4, 'unit'::text, true),
      (5, 'litre'::text, (select inventory_unit in ('l','ltr','litre','litres','liter','liters','ml','millilitre','millilitres','milliliter','milliliters') from normalized) or coalesce(p_size_ml,0) > 0),
      (6, 'millilitre'::text, (select inventory_unit in ('l','ltr','litre','litres','liter','liters','ml','millilitre','millilitres','milliliter','milliliters') from normalized) or coalesce(p_size_ml,0) > 0),
      (7, 'kilogram'::text, (select inventory_unit in ('kg','kilogram','kilograms','g','gram','grams') from normalized) or coalesce(p_package_weight_g,0) > 0),
      (8, 'gram'::text, (select inventory_unit in ('kg','kilogram','kilograms','g','gram','grams') from normalized) or coalesce(p_package_weight_g,0) > 0)
  )
  select coalesce(jsonb_agg(unit_key order by sort_order) filter (where allowed), '[]'::jsonb)
  from options;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 6
create or replace function atlas_private.stock_count_normalize_quantity(
  p_input_quantity numeric,
  p_input_unit text,
  p_inventory_unit text,
  p_units_per_case numeric,
  p_size_ml numeric,
  p_package_weight_g numeric
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  input_unit text := lower(trim(coalesce(p_input_unit,'inventory')));
  inventory_unit text := lower(trim(coalesce(p_inventory_unit,'units')));
  family text;
  normalized numeric;
  factor numeric;
  basis text;
  amount_ml numeric;
  amount_g numeric;
begin
  if p_input_quantity is null or p_input_quantity < 0 then
    raise exception 'Observed quantity must be zero or more';
  end if;

  input_unit := case
    when input_unit in ('inventory','base','base unit') then 'inventory'
    when input_unit in ('bottle','bottles') then 'bottle'
    when input_unit in ('case','cases') then 'case'
    when input_unit in ('unit','units','each','piece','pieces') then 'unit'
    when input_unit in ('l','ltr','litre','litres','liter','liters') then 'litre'
    when input_unit in ('ml','millilitre','millilitres','milliliter','milliliters') then 'millilitre'
    when input_unit in ('kg','kilogram','kilograms') then 'kilogram'
    when input_unit in ('g','gram','grams') then 'gram'
    else null
  end;
  if input_unit is null then raise exception 'Unsupported count unit'; end if;

  family := case
    when inventory_unit in ('l','ltr','litre','litres','liter','liters') then 'litre'
    when inventory_unit in ('ml','millilitre','millilitres','milliliter','milliliters') then 'millilitre'
    when inventory_unit in ('kg','kilogram','kilograms') then 'kilogram'
    when inventory_unit in ('g','gram','grams') then 'gram'
    when inventory_unit in ('bottle','bottles') then 'bottle'
    else 'unit'
  end;

  if input_unit = 'inventory' then
    normalized := p_input_quantity;
    factor := 1;
    basis := 'inventory base unit';

  elsif input_unit = 'case' then
    if coalesce(p_units_per_case,0) <= 0 then
      raise exception 'Units per case is required before counting this item by case';
    end if;
    if family in ('unit','bottle') then
      normalized := p_input_quantity * p_units_per_case;
      factor := p_units_per_case;
      basis := 'cases × units per case';
    elsif family in ('litre','millilitre') then
      if coalesce(p_size_ml,0) <= 0 then raise exception 'Package volume is required before counting this item by case'; end if;
      amount_ml := p_input_quantity * p_units_per_case * p_size_ml;
      normalized := case when family='litre' then amount_ml/1000 else amount_ml end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'cases × units per case × package volume';
    else
      if coalesce(p_package_weight_g,0) <= 0 then raise exception 'Package weight is required before counting this item by case'; end if;
      amount_g := p_input_quantity * p_units_per_case * p_package_weight_g;
      normalized := case when family='kilogram' then amount_g/1000 else amount_g end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'cases × units per case × package weight';
    end if;

  elsif input_unit in ('bottle','unit') then
    if family in ('unit','bottle') then
      normalized := p_input_quantity;
      factor := 1;
      basis := case when input_unit='bottle' then 'bottles' else 'individual units' end;
    elsif family in ('litre','millilitre') then
      if coalesce(p_size_ml,0) <= 0 then raise exception 'Package volume is required before counting this item by unit'; end if;
      amount_ml := p_input_quantity * p_size_ml;
      normalized := case when family='litre' then amount_ml/1000 else amount_ml end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'units × package volume';
    else
      if coalesce(p_package_weight_g,0) <= 0 then raise exception 'Package weight is required before counting this item by unit'; end if;
      amount_g := p_input_quantity * p_package_weight_g;
      normalized := case when family='kilogram' then amount_g/1000 else amount_g end;
      factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
      basis := 'units × package weight';
    end if;

  elsif input_unit in ('litre','millilitre') then
    amount_ml := case when input_unit='litre' then p_input_quantity*1000 else p_input_quantity end;
    if family='litre' then
      normalized := amount_ml/1000;
    elsif family='millilitre' then
      normalized := amount_ml;
    elsif family in ('unit','bottle') and coalesce(p_size_ml,0)>0 then
      normalized := amount_ml/p_size_ml;
    else
      raise exception 'Volume is not compatible with this inventory unit';
    end if;
    factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
    basis := 'volume converted to inventory base unit';

  elsif input_unit in ('kilogram','gram') then
    amount_g := case when input_unit='kilogram' then p_input_quantity*1000 else p_input_quantity end;
    if family='kilogram' then
      normalized := amount_g/1000;
    elsif family='gram' then
      normalized := amount_g;
    elsif family in ('unit','bottle') and coalesce(p_package_weight_g,0)>0 then
      normalized := amount_g/p_package_weight_g;
    else
      raise exception 'Weight is not compatible with this inventory unit';
    end if;
    factor := case when p_input_quantity=0 then null else normalized/p_input_quantity end;
    basis := 'weight converted to inventory base unit';
  end if;

  if normalized is null then raise exception 'This count unit cannot be converted to the inventory unit'; end if;
  return jsonb_build_object(
    'input_quantity',p_input_quantity,
    'input_unit',input_unit,
    'normalized_quantity',normalized,
    'conversion_factor',factor,
    'conversion_basis',basis,
    'inventory_unit',p_inventory_unit
  );
end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 7
create or replace function atlas_private.stock_count_detail(
  p_session_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role='viewer' and session_row.status<>'verified' then
    raise exception 'This stock-count session is not available to viewers';
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'summary',atlas_private.stock_count_session_summary(session_row.id),
    'lines',coalesce((
      select jsonb_agg(
        to_jsonb(line_row)
        || jsonb_build_object(
          'variance',case when line_row.observed_quantity is null then null else line_row.observed_quantity-line_row.expected_quantity end,
          'quantity_status',atlas_private.stock_count_quantity_status(line_row.inventory_item_id,line_row.source_updated_at),
          'supported_count_units',atlas_private.stock_count_supported_units(
            line_row.inventory_unit,line_row.units_per_case_snapshot,line_row.size_ml_snapshot,line_row.package_weight_g_snapshot
          )
        )
        order by coalesce(line_row.bin_location,''),coalesce(line_row.category,''),line_row.item_name
      )
      from atlas_private.inventory_count_lines line_row
      where line_row.session_id=session_row.id
    ),'[]'::jsonb),
    'publication',case when to_regclass('atlas_private.inventory_count_publications') is null then null else (
      select to_jsonb(publication_row)
      from atlas_private.inventory_count_publications publication_row
      where publication_row.session_id=session_row.id
    ) end,
    'permissions',jsonb_build_object(
      'can_edit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_submit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_verify',(is_manager and session_row.status='submitted'),
      'can_reject',(is_manager and session_row.status='submitted'),
      'can_cancel',((is_manager or session_row.started_by=p_actor_id) and session_row.status in ('draft','submitted')),
      'can_prepare_publication',(is_manager and session_row.status='verified' and not session_row.production_applied),
      'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false)
    ),
    'trust',jsonb_build_object(
      'production_inventory_mutated',session_row.production_applied,
      'count_observation_mutates_inventory',false,
      'manager_verification_required',true,
      'manager_publication_required',true,
      'historical_rows_are_current',false,
      'verified_balances_are_private',true
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 8
create or replace function atlas_private.stock_count_start(
  p_inventory jsonb,
  p_title text,
  p_scope_type text,
  p_scope_value text,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_client_request_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  inserted_count integer;
  settings_row atlas_private.inventory_count_settings;
begin
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot start stock counts'; end if;
  if p_actor_role='bartender' and not settings_row.allow_staff_start then raise exception 'Staff-started stock counts are disabled'; end if;
  if p_scope_type not in ('all','location','category') then raise exception 'Stock-count scope is invalid'; end if;
  if p_scope_type<>'all' and nullif(trim(coalesce(p_scope_value,'')),'') is null then raise exception 'A scope value is required'; end if;
  if nullif(trim(coalesce(p_client_request_id,'')),'') is null then raise exception 'A client request ID is required'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where client_request_id=p_client_request_id;
  if found then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;

  insert into atlas_private.inventory_count_sessions (
    session_key,client_request_id,title,scope_type,scope_value,notes,inventory_snapshot_at,
    started_by,started_by_label
  ) values (
    'count-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,8),
    trim(p_client_request_id),coalesce(nullif(trim(coalesce(p_title,'')),''),'Current stock count'),
    p_scope_type,case when p_scope_type='all' then null else trim(p_scope_value) end,
    nullif(trim(coalesce(p_notes,'')),''),now(),p_actor_id,p_actor_label
  ) returning * into session_row;

  insert into atlas_private.inventory_count_lines (
    session_id,inventory_item_id,item_name,category,inventory_unit,bin_location,sku,barcode,
    expected_quantity,expected_updated_at,source_updated_at,source_kind,observed_unit,
    units_per_case_snapshot,size_ml_snapshot,package_size_snapshot,package_weight_g_snapshot,
    par_level_snapshot,supplier_snapshot,unit_cost_snapshot,case_cost_snapshot,source_file_snapshot
  )
  select
    session_row.id,(item->>'id')::uuid,coalesce(nullif(item->>'name',''),'Unnamed inventory item'),
    nullif(item->>'category',''),coalesce(nullif(item->>'unit',''),'units'),nullif(item->>'bin_location',''),
    nullif(item->>'sku',''),nullif(item->>'barcode',''),coalesce(nullif(item->>'quantity','')::numeric,0),
    nullif(item->>'updated_at','')::timestamptz,nullif(item->>'source_updated_at','')::date,
    case when nullif(item->>'source_updated_at','')::date<=date '2026-07-31' then 'historical_snapshot' else 'production_observation' end,
    coalesce(nullif(item->>'unit',''),'units'),nullif(item->>'units_per_case','')::numeric,
    nullif(item->>'size_ml','')::numeric,nullif(item->>'package_size',''),
    coalesce(nullif(item->>'package_weight_g','')::numeric,atlas_private.stock_count_package_weight_g(item->>'package_size')),
    nullif(item->>'par_level','')::numeric,nullif(coalesce(item->>'supplier',item->>'supplier_name'),''),
    nullif(item->>'cost_price','')::numeric,nullif(item->>'case_cost','')::numeric,nullif(item->>'source_file','')
  from jsonb_array_elements(p_inventory) item
  where coalesce((item->>'active')::boolean,true)=true
    and (
      p_scope_type='all'
      or (p_scope_type='location' and lower(coalesce(item->>'bin_location',''))=lower(trim(p_scope_value)))
      or (p_scope_type='category' and lower(coalesce(item->>'category',''))=lower(trim(p_scope_value)))
    );

  get diagnostics inserted_count=row_count;
  if inserted_count=0 then
    delete from atlas_private.inventory_count_sessions where id=session_row.id;
    raise exception 'No active inventory items match this stock-count scope';
  end if;
  update atlas_private.inventory_count_sessions set source_record_count=inserted_count where id=session_row.id;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_started',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('scope_type',p_scope_type,'scope_value',case when p_scope_type='all' then null else trim(p_scope_value) end,'source_record_count',inserted_count)
  );
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 9
create or replace function atlas_private.stock_count_save_line_v2(
  p_session_id uuid,
  p_line_id uuid,
  p_line_status text,
  p_input_quantity numeric,
  p_input_unit text,
  p_count_method text,
  p_note text,
  p_skipped_reason text,
  p_expected_version integer,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
  normalized jsonb;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot count inventory'; end if;
  if p_line_status not in ('pending','counted','skipped') then raise exception 'Count-line status is invalid'; end if;
  if p_count_method is not null and p_count_method not in ('manual','barcode','photo','import') then raise exception 'Count method is invalid'; end if;
  if p_line_status='skipped' and nullif(trim(coalesce(p_skipped_reason,'')),'') is null then raise exception 'A skipped line requires a reason'; end if;
  if jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object' then raise exception 'Count evidence must be an object'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be edited'; end if;
  select * into line_row from atlas_private.inventory_count_lines where id=p_line_id and session_id=p_session_id;
  if not found then raise exception 'Stock-count line not found'; end if;

  if p_line_status='counted' then
    normalized := atlas_private.stock_count_normalize_quantity(
      p_input_quantity,p_input_unit,line_row.inventory_unit,line_row.units_per_case_snapshot,
      line_row.size_ml_snapshot,line_row.package_weight_g_snapshot
    );
  end if;

  update atlas_private.inventory_count_lines
  set line_status=p_line_status,
      observed_quantity=case when p_line_status='counted' then (normalized->>'normalized_quantity')::numeric else null end,
      observed_input_quantity=case when p_line_status='counted' then p_input_quantity else null end,
      observed_input_unit=case when p_line_status='counted' then normalized->>'input_unit' else null end,
      observed_unit=case when p_line_status='counted' then normalized->>'input_unit' else observed_unit end,
      conversion_factor=case when p_line_status='counted' then nullif(normalized->>'conversion_factor','')::numeric else null end,
      conversion_basis=case when p_line_status='counted' then normalized->>'conversion_basis' else null end,
      count_method=case when p_line_status='counted' then coalesce(p_count_method,'manual') else null end,
      note=nullif(trim(coalesce(p_note,'')),''),
      skipped_reason=case when p_line_status='skipped' then trim(p_skipped_reason) else null end,
      counted_by=case when p_line_status='counted' then p_actor_id else null end,
      counted_by_label=case when p_line_status='counted' then p_actor_label else null end,
      counted_at=case when p_line_status='counted' then now() else null end,
      count_evidence=coalesce(p_evidence,'{}'::jsonb),version=version+1
  where id=p_line_id and session_id=p_session_id and version=p_expected_version
  returning * into line_row;
  if not found then raise exception 'This count line changed in another session. Refresh and try again'; end if;

  update atlas_private.inventory_count_sessions set version=version+1 where id=p_session_id;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,line_id,inventory_item_id,actor_id,actor_label,actor_role,payload
  ) values (
    'line_saved',p_session_id,line_row.id,line_row.inventory_item_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'line_status',line_row.line_status,'observed_input_quantity',line_row.observed_input_quantity,
      'observed_input_unit',line_row.observed_input_unit,'normalized_quantity',line_row.observed_quantity,
      'inventory_unit',line_row.inventory_unit,'conversion_basis',line_row.conversion_basis,
      'count_method',line_row.count_method,'line_version',line_row.version
    )
  );
  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 10
create or replace function atlas_private.stock_count_snapshot(
  p_inventory jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  settings_row atlas_private.inventory_count_settings;
  sessions_json jsonb := '[]'::jsonb;
  catalog_json jsonb := '[]'::jsonb;
  balances_json jsonb := '[]'::jsonb;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then raise exception 'This profile cannot access stock counts'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  select coalesce(jsonb_agg(
    to_jsonb(session_row) || jsonb_build_object('summary',atlas_private.stock_count_session_summary(session_row.id))
    order by session_row.started_at desc
  ),'[]'::jsonb)
  into sessions_json
  from atlas_private.inventory_count_sessions session_row
  where p_actor_role<>'viewer' or session_row.status='verified';

  with items as (
    select item from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item
    where coalesce((item->>'active')::boolean,true)=true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item->>'id','name',item->>'name','category',item->>'category',
    'quantity',coalesce(nullif(item->>'quantity','')::numeric,0),'unit',coalesce(nullif(item->>'unit',''),'units'),
    'par_level',nullif(item->>'par_level','')::numeric,'bin_location',nullif(item->>'bin_location',''),
    'sku',nullif(item->>'sku',''),'barcode',nullif(item->>'barcode',''),
    'units_per_case',nullif(item->>'units_per_case','')::numeric,'size_ml',nullif(item->>'size_ml','')::numeric,
    'package_size',nullif(item->>'package_size',''),'supplier',nullif(coalesce(item->>'supplier',item->>'supplier_name'),''),
    'cost_price',nullif(item->>'cost_price','')::numeric,'case_cost',nullif(item->>'case_cost','')::numeric,
    'updated_at',nullif(item->>'updated_at','')::timestamptz,'source_updated_at',nullif(item->>'source_updated_at','')::date,
    'source_kind',case
      when balance.inventory_item_id is not null and balance.verification_status='current' and balance.expires_at>now() then 'manager_verified_count'
      when nullif(item->>'source_updated_at','')::date<=date '2026-07-31' then 'historical_snapshot'
      else 'production_observation' end,
    'quantity_status',atlas_private.stock_count_quantity_status((item->>'id')::uuid,nullif(item->>'source_updated_at','')::date),
    'verified_quantity',balance.verified_quantity,'verified_at',balance.verified_at,'verified_expires_at',balance.expires_at
  ) order by coalesce(item->>'bin_location',''),coalesce(item->>'category',''),item->>'name'),'[]'::jsonb)
  into catalog_json
  from items
  left join atlas_private.inventory_verified_balances balance on balance.inventory_item_id=(item->>'id')::uuid;

  select coalesce(jsonb_agg(to_jsonb(balance_row) || jsonb_build_object(
    'freshness_state',case when balance_row.verification_status<>'current' then 'revoked' when balance_row.expires_at<=now() then 'stale' else 'current' end
  ) order by balance_row.verified_at desc),'[]'::jsonb)
  into balances_json from atlas_private.inventory_verified_balances balance_row;

  return jsonb_build_object(
    'version','atlas-stock-counts/0.2.0','generated_at',now(),'sessions',sessions_json,
    'catalog',catalog_json,'verified_balances',balances_json,'settings',to_jsonb(settings_row),
    'summary',jsonb_build_object(
      'draft_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='draft'),
      'submitted_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='submitted'),
      'verified_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='verified'),
      'current_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at>now()),
      'stale_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at<=now()),
      'current_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='current'),
      'stale_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='stale'),
      'historical_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='historical'),
      'unverified_items',(select count(*) from jsonb_array_elements(catalog_json) item where item->>'quantity_status'='unverified'),
      'catalog_items',jsonb_array_length(catalog_json)
    ),
    'permissions',jsonb_build_object(
      'can_start',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_start)),
      'can_count',(p_actor_role in ('admin','manager','bartender')),
      'can_submit',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_submit)),
      'can_verify',is_manager,'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false)
    ),
    'trust',jsonb_build_object(
      'shadow_mode',not coalesce(settings_row.production_apply_enabled,false),
      'count_observation_mutates_inventory',false,'verification_mutates_inventory',false,
      'publication_is_only_adjustment_boundary',true,'manager_verification_required',true,
      'historical_inventory_used_as_current',false,'verified_balance_source','manager_verified_count'
    )
  );
end;
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 11
create or replace function public.atlas_stock_count_save_line_v2(
  uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.stock_count_save_line_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13);
$$;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 12
revoke all on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 13
grant execute on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 14
comment on column atlas_private.inventory_count_lines.observed_quantity is
  'Count quantity normalized into the inventory item base unit. The original entry is preserved in observed_input_quantity and observed_input_unit.';

-- SOURCE supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql statement 15
comment on function atlas_private.stock_count_normalize_quantity(numeric,text,text,numeric,numeric,numeric) is
  'Checkpoint L1 unit conversion for bottle, case, unit, litre, millilitre and weight observations.';

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 0
-- Checkpoint L1: manager-only publication boundary.
--
-- Saving or verifying a count never changes live inventory. This migration adds
-- one explicit, auditable publication transaction. It remains disabled by
-- default and can only be called through the service-role gateway after that
-- gateway has revalidated an active manager or administrator profile.

alter table atlas_private.inventory_count_settings
  drop constraint if exists inventory_count_settings_production_apply_enabled_check;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 1
alter table atlas_private.inventory_count_sessions
  drop constraint if exists inventory_count_sessions_production_applied_check;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 2
alter table atlas_private.inventory_count_sessions
  add column if not exists publication_status text not null default 'not_ready',
  add column if not exists publication_approved_by uuid,
  add column if not exists publication_approved_by_label text,
  add column if not exists publication_approved_at timestamptz,
  add column if not exists publication_request_id text,
  add column if not exists published_by uuid,
  add column if not exists published_by_label text,
  add column if not exists published_at timestamptz;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 3
alter table atlas_private.inventory_count_sessions
  drop constraint if exists inventory_count_sessions_publication_status_check;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 4
alter table atlas_private.inventory_count_sessions
  add constraint inventory_count_sessions_publication_status_check
  check (publication_status in ('not_ready','ready','blocked','publishing','published','failed'));

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 5
create unique index if not exists inventory_count_sessions_publication_request_uidx
  on atlas_private.inventory_count_sessions(publication_request_id)
  where publication_request_id is not null;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 6
create table if not exists atlas_private.inventory_count_publications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references atlas_private.inventory_count_sessions(id) on delete restrict,
  request_id text not null unique,
  status text not null default 'ready'
    check (status in ('ready','blocked','publishing','published','failed')),
  production_apply_enabled boolean not null default false,
  blocked_reason text,
  approved_by uuid not null,
  approved_by_label text not null,
  approved_at timestamptz not null default now(),
  published_by uuid,
  published_by_label text,
  published_at timestamptz,
  item_count integer not null default 0 check (item_count >= 0),
  adjustment_count integer not null default 0 check (adjustment_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  failure_message text,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 7
create table if not exists atlas_private.inventory_count_publication_lines (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references atlas_private.inventory_count_publications(id) on delete cascade,
  session_id uuid not null references atlas_private.inventory_count_sessions(id) on delete restrict,
  count_line_id uuid not null references atlas_private.inventory_count_lines(id) on delete restrict,
  inventory_item_id uuid not null,
  item_name text not null,
  inventory_unit text not null,
  before_quantity numeric,
  observed_quantity numeric not null check (observed_quantity >= 0),
  adjustment_quantity numeric,
  before_updated_at timestamptz,
  verified_production_quantity numeric,
  verified_production_updated_at timestamptz,
  conflict_reason text,
  status text not null default 'pending'
    check (status in ('pending','blocked','applied','skipped','failed')),
  movement_note text,
  production_after_quantity numeric,
  applied_at timestamptz,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(publication_id,count_line_id)
);

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 8
create index if not exists inventory_count_publications_status_idx
  on atlas_private.inventory_count_publications(status,approved_at desc);

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 9
create index if not exists inventory_count_publication_lines_status_idx
  on atlas_private.inventory_count_publication_lines(publication_id,status,item_name);

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 10
alter table atlas_private.inventory_count_publications enable row level security;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 11
alter table atlas_private.inventory_count_publication_lines enable row level security;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 12
revoke all on atlas_private.inventory_count_publications from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 13
revoke all on atlas_private.inventory_count_publication_lines from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 14
grant all on atlas_private.inventory_count_publications to service_role;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 15
grant all on atlas_private.inventory_count_publication_lines to service_role;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 16
drop policy if exists "service role manages inventory count publications" on atlas_private.inventory_count_publications;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 17
create policy "service role manages inventory count publications"
  on atlas_private.inventory_count_publications for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 18
drop policy if exists "service role manages inventory count publication lines" on atlas_private.inventory_count_publication_lines;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 19
create policy "service role manages inventory count publication lines"
  on atlas_private.inventory_count_publication_lines for all to service_role using (true) with check (true);

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 20
drop trigger if exists inventory_count_publications_touch on atlas_private.inventory_count_publications;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 21
create trigger inventory_count_publications_touch before update on atlas_private.inventory_count_publications
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 22
drop trigger if exists inventory_count_publication_lines_touch on atlas_private.inventory_count_publication_lines;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 23
create trigger inventory_count_publication_lines_touch before update on atlas_private.inventory_count_publication_lines
  for each row execute function atlas_private.touch_updated_at();

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 24
alter table atlas_private.inventory_count_events
  drop constraint if exists inventory_count_events_event_type_check;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 25
alter table atlas_private.inventory_count_events
  add constraint inventory_count_events_event_type_check check (event_type in (
    'session_started','line_saved','session_submitted','session_verified','session_rejected','session_cancelled',
    'publication_prepared','publication_blocked','session_published','publication_failed'
  ));

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 26
create or replace function atlas_private.stock_count_prepare_publication(
  p_session_id uuid,
  p_inventory jsonb,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  publication_row atlas_private.inventory_count_publications;
  item_total integer := 0;
  adjustment_total integer := 0;
  conflict_total integer := 0;
  blocked_text text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve stock-count publication'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request ID is required'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'verified' then raise exception 'Only a manager-verified count can be prepared for publication'; end if;
  if session_row.production_applied or session_row.publication_status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  insert into atlas_private.inventory_count_publications (
    session_id,request_id,status,production_apply_enabled,approved_by,approved_by_label,evidence
  ) values (
    p_session_id,trim(p_request_id),'ready',coalesce(settings_row.production_apply_enabled,false),
    p_actor_id,p_actor_label,
    jsonb_build_object('verified_at',session_row.verified_at,'prepared_against_inventory_at',now())
  )
  on conflict(session_id) do update set
    request_id=excluded.request_id,
    status=case when atlas_private.inventory_count_publications.status='published' then 'published' else 'ready' end,
    production_apply_enabled=excluded.production_apply_enabled,
    blocked_reason=null,approved_by=excluded.approved_by,approved_by_label=excluded.approved_by_label,
    approved_at=now(),failure_message=null,evidence=excluded.evidence,updated_at=now()
  returning * into publication_row;

  if publication_row.status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;

  delete from atlas_private.inventory_count_publication_lines where publication_id=publication_row.id;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  insert into atlas_private.inventory_count_publication_lines (
    publication_id,session_id,count_line_id,inventory_item_id,item_name,inventory_unit,
    before_quantity,observed_quantity,adjustment_quantity,before_updated_at,
    verified_production_quantity,verified_production_updated_at,conflict_reason,status,movement_note
  )
  select
    publication_row.id,line_row.session_id,line_row.id,line_row.inventory_item_id,line_row.item_name,line_row.inventory_unit,
    current.quantity,line_row.observed_quantity,line_row.observed_quantity-current.quantity,current.updated_at,
    balance_row.production_quantity_at_verification,balance_row.production_updated_at,
    case
      when current.inventory_item_id is null then 'Inventory item is no longer present in the active catalog'
      when current.quantity is distinct from balance_row.production_quantity_at_verification then 'Production quantity changed after manager verification'
      when current.updated_at is distinct from balance_row.production_updated_at then 'Production record changed after manager verification'
      else null
    end,
    case
      when current.inventory_item_id is null then 'blocked'
      when current.quantity is distinct from balance_row.production_quantity_at_verification then 'blocked'
      when current.updated_at is distinct from balance_row.production_updated_at then 'blocked'
      when line_row.observed_quantity=current.quantity then 'skipped'
      else 'pending'
    end,
    'Atlas verified count '||publication_row.request_id||' · session '||line_row.session_id::text||' · line '||line_row.id::text
  from atlas_private.inventory_count_lines line_row
  join atlas_private.inventory_verified_balances balance_row
    on balance_row.source_session_id=line_row.session_id and balance_row.source_line_id=line_row.id
  left join current_inventory current on current.inventory_item_id=line_row.inventory_item_id
  where line_row.session_id=p_session_id and line_row.line_status='counted';

  select count(*),count(*) filter(where adjustment_quantity<>0),count(*) filter(where status='blocked')
  into item_total,adjustment_total,conflict_total
  from atlas_private.inventory_count_publication_lines where publication_id=publication_row.id;

  if item_total=0 then blocked_text := 'No counted lines are available for publication';
  elsif conflict_total>0 then blocked_text := conflict_total||' production conflict(s) require a fresh verification';
  elsif not coalesce(settings_row.production_apply_enabled,false) then blocked_text := 'Production publication is disabled in this environment';
  else blocked_text := null;
  end if;

  update atlas_private.inventory_count_publications
  set item_count=item_total,adjustment_count=adjustment_total,conflict_count=conflict_total,
      status=case when blocked_text is null then 'ready' else 'blocked' end,
      blocked_reason=blocked_text,updated_at=now()
  where id=publication_row.id;

  update atlas_private.inventory_count_sessions
  set publication_status=case when blocked_text is null then 'ready' else 'blocked' end,
      publication_approved_by=p_actor_id,publication_approved_by_label=p_actor_label,
      publication_approved_at=now(),publication_request_id=publication_row.request_id,
      version=version+1,updated_at=now()
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    case when blocked_text is null then 'publication_prepared' else 'publication_blocked' end,
    p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,
      'item_count',item_total,'adjustment_count',adjustment_total,'conflict_count',conflict_total,
      'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false),'blocked_reason',blocked_text)
  );

  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
end;
$$;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 27
create or replace function atlas_private.stock_count_publish(
  p_session_id uuid,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  publication_row atlas_private.inventory_count_publications;
  publication_line atlas_private.inventory_count_publication_lines;
  item_row public.inventory_items;
  conflict_total integer := 0;
  delta numeric;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish stock counts'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request ID is required'; end if;

  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if not coalesce(settings_row.production_apply_enabled,false) then
    raise exception 'Production stock-count publication is disabled';
  end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.production_applied or session_row.publication_status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;
  if session_row.status<>'verified' then raise exception 'Only a manager-verified count can be published'; end if;

  select * into publication_row
  from atlas_private.inventory_count_publications
  where session_id=p_session_id and request_id=trim(p_request_id)
  for update;
  if not found then raise exception 'Prepare this publication again before applying it'; end if;
  if publication_row.status<>'ready' then raise exception 'This publication is not ready to apply'; end if;

  select count(*) into conflict_total
  from atlas_private.inventory_count_publication_lines plan_line
  left join public.inventory_items item on item.id=plan_line.inventory_item_id
  where plan_line.publication_id=publication_row.id
    and (
      item.id is null
      or item.quantity is distinct from plan_line.before_quantity
      or item.updated_at is distinct from plan_line.before_updated_at
    );

  if conflict_total>0 then
    update atlas_private.inventory_count_publications
    set status='blocked',blocked_reason=conflict_total||' inventory record(s) changed after publication approval',
        conflict_count=conflict_total,updated_at=now()
    where id=publication_row.id;
    update atlas_private.inventory_count_sessions
    set publication_status='blocked',version=version+1,updated_at=now() where id=p_session_id;
    insert into atlas_private.inventory_count_events (
      event_type,session_id,actor_id,actor_label,actor_role,payload
    ) values (
      'publication_blocked',p_session_id,p_actor_id,p_actor_label,p_actor_role,
      jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,'conflict_count',conflict_total)
    );
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;

  update atlas_private.inventory_count_publications set status='publishing',updated_at=now() where id=publication_row.id;
  update atlas_private.inventory_count_sessions set publication_status='publishing',version=version+1,updated_at=now() where id=p_session_id;

  for publication_line in
    select * from atlas_private.inventory_count_publication_lines
    where publication_id=publication_row.id order by item_name,id
  loop
    select * into item_row from public.inventory_items where id=publication_line.inventory_item_id for update;
    if not found then raise exception 'Inventory item % disappeared during publication',publication_line.item_name; end if;
    if item_row.quantity is distinct from publication_line.before_quantity
       or item_row.updated_at is distinct from publication_line.before_updated_at then
      raise exception 'Inventory item % changed during publication',publication_line.item_name;
    end if;

    delta := publication_line.observed_quantity-item_row.quantity;
    if delta<>0 then
      update public.inventory_items
      set quantity=publication_line.observed_quantity,updated_by=p_actor_id::text,updated_at=now()
      where id=item_row.id
      returning * into item_row;

      insert into public.inventory_movements (
        item_id,item_name,movement_type,quantity_change,unit_cost,total_cost,supplier_id,note,created_by
      ) values (
        item_row.id,item_row.name,'count',delta,item_row.cost_price,
        case when item_row.cost_price is null then null else abs(delta)*item_row.cost_price end,
        item_row.supplier_id,publication_line.movement_note,p_actor_id
      );

      update atlas_private.inventory_count_publication_lines
      set status='applied',production_after_quantity=item_row.quantity,applied_at=now(),updated_at=now()
      where id=publication_line.id;
    else
      update atlas_private.inventory_count_publication_lines
      set status='skipped',production_after_quantity=item_row.quantity,applied_at=now(),updated_at=now()
      where id=publication_line.id;
    end if;
  end loop;

  update atlas_private.inventory_count_publications
  set status='published',published_by=p_actor_id,published_by_label=p_actor_label,published_at=now(),
      blocked_reason=null,failure_message=null,updated_at=now()
  where id=publication_row.id;

  update atlas_private.inventory_count_sessions
  set publication_status='published',production_applied=true,published_by=p_actor_id,
      published_by_label=p_actor_label,published_at=now(),version=version+1,updated_at=now()
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_published',p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,
      'item_count',publication_row.item_count,'adjustment_count',publication_row.adjustment_count)
  );

  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
exception when others then
  update atlas_private.inventory_count_publications
  set status='failed',failure_message=sqlerrm,updated_at=now()
  where session_id=p_session_id and request_id=trim(p_request_id) and status<>'published';
  update atlas_private.inventory_count_sessions
  set publication_status='failed',version=version+1,updated_at=now()
  where id=p_session_id and not production_applied;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'publication_failed',p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',trim(p_request_id),'error',sqlerrm)
  );
  raise;
end;
$$;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 28
create or replace function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select atlas_private.stock_count_prepare_publication($1,$2,$3,$4,$5,$6); $$;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 29
create or replace function public.atlas_stock_count_publish(uuid,text,uuid,text,text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select atlas_private.stock_count_publish($1,$2,$3,$4,$5); $$;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 30
revoke all on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 31
revoke all on function public.atlas_stock_count_publish(uuid,text,uuid,text,text)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 32
grant execute on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 33
grant execute on function public.atlas_stock_count_publish(uuid,text,uuid,text,text)
  to service_role;

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 34
-- Preview and branch deployments stay read-only until an explicit production
-- release decision enables publication after authenticated browser acceptance.
update atlas_private.inventory_count_settings
set production_apply_enabled=false,updated_at=now()
where setting_key='va';

-- SOURCE supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql statement 35
comment on table atlas_private.inventory_count_publications is
  'Manager-approved publication plans. Count observations and verification cannot mutate live inventory; only stock_count_publish can create controlled count adjustments.';

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 0
-- Restore the named PostgREST contract for Checkpoint J Settings.
--
-- The private functions already expose stable named arguments, but the public
-- service-role wrappers were recreated with positional-only parameters. The
-- Settings Edge Function sends named JSON payloads, so PostgREST could not
-- resolve atlas_settings_snapshot(p_actor_id, p_actor_role, p_profiles).
-- Keep every public wrapper security-invoker and service-role-only.

create or replace function public.atlas_settings_snapshot(
  p_profiles jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select atlas_private.settings_snapshot(p_profiles, p_actor_id, p_actor_role);
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 1
create or replace function public.atlas_settings_save_section(
  p_section_key text,
  p_value jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_section(
    p_section_key,
    p_value,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 2
create or replace function public.atlas_settings_save_hours(
  p_hours jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_hours(
    p_hours,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 3
create or replace function public.atlas_settings_save_offer(
  p_offer_id uuid,
  p_offer_key text,
  p_name text,
  p_description text,
  p_active boolean,
  p_days smallint[],
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_end_next_day boolean,
  p_pricing jsonb,
  p_booking_url text,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_offer(
    p_offer_id,
    p_offer_key,
    p_name,
    p_description,
    p_active,
    p_days,
    p_start_time,
    p_end_time,
    p_end_next_day,
    p_pricing,
    p_booking_url,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 4
create or replace function public.atlas_settings_save_role(
  p_role_key text,
  p_permissions jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_role(
    p_role_key,
    p_permissions,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 5
create or replace function public.atlas_settings_save_notification_policy(
  p_event_key text,
  p_enabled boolean,
  p_channels jsonb,
  p_target_roles text[],
  p_reminder_minutes integer[],
  p_escalation_minutes integer,
  p_manager_approval_required boolean,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_notification_policy(
    p_event_key,
    p_enabled,
    p_channels,
    p_target_roles,
    p_reminder_minutes,
    p_escalation_minutes,
    p_manager_approval_required,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 6
create or replace function public.atlas_settings_save_preferences(
  p_user_id uuid,
  p_theme text,
  p_density text,
  p_language text,
  p_start_view text,
  p_timezone text,
  p_reduce_motion boolean,
  p_browser_notifications boolean,
  p_email_notifications boolean,
  p_preferences jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_preferences(
    p_user_id,
    p_theme,
    p_density,
    p_language,
    p_start_view,
    p_timezone,
    p_reduce_motion,
    p_browser_notifications,
    p_email_notifications,
    p_preferences,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 7
revoke all on function public.atlas_settings_snapshot(jsonb, uuid, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 8
revoke all on function public.atlas_settings_save_section(text, jsonb, integer, uuid, text, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 9
revoke all on function public.atlas_settings_save_hours(jsonb, uuid, text, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 10
revoke all on function public.atlas_settings_save_offer(uuid, text, text, text, boolean, smallint[], time without time zone, time without time zone, boolean, jsonb, text, integer, uuid, text, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 11
revoke all on function public.atlas_settings_save_role(text, jsonb, integer, uuid, text, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 12
revoke all on function public.atlas_settings_save_notification_policy(text, boolean, jsonb, text[], integer[], integer, boolean, integer, uuid, text, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 13
revoke all on function public.atlas_settings_save_preferences(uuid, text, text, text, text, text, boolean, boolean, boolean, jsonb, uuid, text, text)
  from public, anon, authenticated;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 14
grant execute on function public.atlas_settings_snapshot(jsonb, uuid, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 15
grant execute on function public.atlas_settings_save_section(text, jsonb, integer, uuid, text, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 16
grant execute on function public.atlas_settings_save_hours(jsonb, uuid, text, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 17
grant execute on function public.atlas_settings_save_offer(uuid, text, text, text, boolean, smallint[], time without time zone, time without time zone, boolean, jsonb, text, integer, uuid, text, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 18
grant execute on function public.atlas_settings_save_role(text, jsonb, integer, uuid, text, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 19
grant execute on function public.atlas_settings_save_notification_policy(text, boolean, jsonb, text[], integer[], integer, boolean, integer, uuid, text, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 20
grant execute on function public.atlas_settings_save_preferences(uuid, text, text, text, text, text, boolean, boolean, boolean, jsonb, uuid, text, text)
  to service_role;

-- SOURCE supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql statement 21
notify pgrst, 'reload schema';

-- SOURCE supabase/migrations/20260806165146_atlas_phase1_stock_count_views_branch_only.sql statement 0
-- Atlas-branch-only stock-count evidence views.
--
-- This migration is safe in every environment. It creates the redacted staff and
-- manager evidence projections only when the isolated Atlas L1 source relation is
-- present. Production has no such source relation, so production receives an
-- intentional no-op and continues to access L1 through authenticated Edge Functions.

do $atlas_stock_count_views$
begin
  if to_regclass('atlas_private.inventory_verified_balances') is not null then
    execute $ddl$
      create or replace function private.read_stock_count_summary()
      returns table (
        inventory_item_id uuid,
        item_name text,
        category text,
        inventory_unit text,
        bin_location text,
        verified_quantity numeric,
        quantity_state text,
        verified_at timestamptz,
        expires_at timestamptz,
        historical boolean
      )
      language plpgsql
      stable
      security definer
      set search_path = ''
      as $function$
      begin
        if coalesce((select auth.role()), '') <> 'service_role'
           and session_user <> 'postgres'
           and not private.is_active_staff() then
          raise exception 'An active Atlas profile is required'
            using errcode = '42501';
        end if;

        return query
        select
          balance.inventory_item_id,
          balance.item_name,
          balance.category,
          balance.inventory_unit,
          balance.bin_location,
          balance.verified_quantity,
          case
            when balance.historical is true then 'historical'
            when balance.verified_at is null then 'unverified'
            when balance.expires_at is not null and balance.expires_at <= now() then 'stale'
            when balance.verification_status = 'current' then 'current'
            else coalesce(balance.verification_status, 'unverified')
          end,
          balance.verified_at,
          balance.expires_at,
          balance.historical
        from atlas_private.inventory_verified_balances as balance;
      end;
      $function$
    $ddl$;

    execute $ddl$
      create or replace function private.read_stock_count_manager_summary()
      returns table (
        inventory_item_id uuid,
        item_name text,
        category text,
        inventory_unit text,
        bin_location text,
        verified_quantity numeric,
        quantity_state text,
        verified_at timestamptz,
        expires_at timestamptz,
        historical boolean,
        source_session_id uuid,
        source_line_id uuid,
        verified_by uuid,
        verified_by_label text,
        production_quantity_at_verification numeric,
        production_updated_at timestamptz,
        variance numeric,
        source_kind text
      )
      language plpgsql
      stable
      security definer
      set search_path = ''
      as $function$
      begin
        if coalesce((select auth.role()), '') <> 'service_role'
           and session_user <> 'postgres'
           and not private.is_manager_or_admin() then
          raise exception 'Stock-count verification evidence is manager-only'
            using errcode = '42501';
        end if;

        return query
        select
          balance.inventory_item_id,
          balance.item_name,
          balance.category,
          balance.inventory_unit,
          balance.bin_location,
          balance.verified_quantity,
          case
            when balance.historical is true then 'historical'
            when balance.verified_at is null then 'unverified'
            when balance.expires_at is not null and balance.expires_at <= now() then 'stale'
            when balance.verification_status = 'current' then 'current'
            else coalesce(balance.verification_status, 'unverified')
          end,
          balance.verified_at,
          balance.expires_at,
          balance.historical,
          balance.source_session_id,
          balance.source_line_id,
          balance.verified_by,
          balance.verified_by_label,
          balance.production_quantity_at_verification,
          balance.production_updated_at,
          balance.variance,
          balance.source_kind
        from atlas_private.inventory_verified_balances as balance;
      end;
      $function$
    $ddl$;

    execute 'drop view if exists public.stock_count_summary';
    execute $ddl$
      create view public.stock_count_summary
      with (security_invoker = true)
      as
      select *
      from private.read_stock_count_summary()
    $ddl$;

    execute 'drop view if exists public.stock_count_manager_summary';
    execute $ddl$
      create view public.stock_count_manager_summary
      with (security_invoker = true)
      as
      select *
      from private.read_stock_count_manager_summary()
    $ddl$;

    execute 'revoke all on function private.read_stock_count_summary() from public, anon';
    execute 'revoke all on function private.read_stock_count_manager_summary() from public, anon';
    execute 'grant execute on function private.read_stock_count_summary() to authenticated, service_role';
    execute 'grant execute on function private.read_stock_count_manager_summary() to authenticated, service_role';
    execute 'revoke all on table public.stock_count_summary from public, anon';
    execute 'revoke all on table public.stock_count_manager_summary from public, anon';
    execute 'grant select on table public.stock_count_summary to authenticated, service_role';
    execute 'grant select on table public.stock_count_manager_summary to authenticated, service_role';
    execute $ddl$
      comment on view public.stock_count_summary is
        'Redacted active-staff verified-stock summary. No verifier identity, variance, supplier or cost fields.'
    $ddl$;
    execute $ddl$
      comment on view public.stock_count_manager_summary is
        'Manager-gated stock-count verification provenance and variance evidence.'
    $ddl$;
  else
    raise notice 'Skipping Atlas stock-count views: verified-balance source is absent';
  end if;
end
$atlas_stock_count_views$;

-- SOURCE supabase/migrations/20260806165146_atlas_phase1_stock_count_views_branch_only.sql statement 1
notify pgrst, 'reload schema';

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 0
-- Restore the named PostgREST contract for the Team Profiles gateway wrappers.
-- Private implementations, profile data, onboarding data, RLS policies, and production remain unchanged.

create or replace function public.atlas_team_profiles_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profiles_snapshot(
    p_profiles,
    p_tasks,
    p_progress,
    p_actor_id,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 1
create or replace function public.atlas_team_profile_upsert_details(
  p_profile_id uuid,
  p_preferred_name text,
  p_job_title text,
  p_department text,
  p_employment_type text,
  p_start_date date,
  p_phone text,
  p_phone_visibility text,
  p_preferred_language text,
  p_manager_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_upsert_details(
    p_profile_id,
    p_preferred_name,
    p_job_title,
    p_department,
    p_employment_type,
    p_start_date,
    p_phone,
    p_phone_visibility,
    p_preferred_language,
    p_manager_notes,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 2
create or replace function public.atlas_team_profile_save_emergency_contact(
  p_contact_id uuid,
  p_profile_id uuid,
  p_contact_name text,
  p_relationship text,
  p_phone text,
  p_note text,
  p_priority smallint,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_save_emergency_contact(
    p_contact_id,
    p_profile_id,
    p_contact_name,
    p_relationship,
    p_phone,
    p_note,
    p_priority,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 3
create or replace function public.atlas_team_profile_remove_emergency_contact(
  p_contact_id uuid,
  p_profile_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_remove_emergency_contact(
    p_contact_id,
    p_profile_id,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 4
create or replace function public.atlas_team_profile_log_external_event(
  p_event_type text,
  p_profile_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_payload jsonb
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_log_external_event(
    p_event_type,
    p_profile_id,
    p_actor_id,
    p_actor_label,
    p_actor_role,
    p_payload
  );
$function$;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 5
revoke all on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 6
revoke all on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 7
revoke all on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 8
revoke all on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 9
revoke all on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 10
grant execute on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 11
grant execute on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 12
grant execute on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 13
grant execute on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 14
grant execute on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20260908193653_atlas_team_profiles_named_arguments.sql statement 15
notify pgrst, 'reload schema';

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 0
-- Restore the named PostgREST contract for the Stock Count gateway wrappers.
-- Private implementations, count evidence, inventory data, and production remain unchanged.

create or replace function public.atlas_stock_count_snapshot(
  p_inventory jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb language sql stable security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_snapshot(p_inventory, p_actor_id, p_actor_role);
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 1
create or replace function public.atlas_stock_count_detail(
  p_session_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb language sql stable security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_detail(p_session_id, p_actor_id, p_actor_role);
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 2
create or replace function public.atlas_stock_count_start(
  p_inventory jsonb,
  p_title text,
  p_scope_type text,
  p_scope_value text,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_client_request_id text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_start(
    p_inventory, p_title, p_scope_type, p_scope_value, p_notes,
    p_actor_id, p_actor_label, p_actor_role, p_client_request_id
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 3
create or replace function public.atlas_stock_count_save_line_v2(
  p_session_id uuid,
  p_line_id uuid,
  p_line_status text,
  p_input_quantity numeric,
  p_input_unit text,
  p_count_method text,
  p_note text,
  p_skipped_reason text,
  p_expected_version integer,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_save_line_v2(
    p_session_id, p_line_id, p_line_status, p_input_quantity, p_input_unit,
    p_count_method, p_note, p_skipped_reason, p_expected_version, p_evidence,
    p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 4
create or replace function public.atlas_stock_count_submit(
  p_session_id uuid,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_submit(
    p_session_id, p_notes, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 5
create or replace function public.atlas_stock_count_verify(
  p_session_id uuid,
  p_inventory jsonb,
  p_acknowledge_conflicts boolean,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_verify(
    p_session_id, p_inventory, p_acknowledge_conflicts,
    p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 6
create or replace function public.atlas_stock_count_prepare_publication(
  p_session_id uuid,
  p_inventory jsonb,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_prepare_publication(
    p_session_id, p_inventory, p_request_id, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 7
create or replace function public.atlas_stock_count_publish(
  p_session_id uuid,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_publish(
    p_session_id, p_request_id, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 8
create or replace function public.atlas_stock_count_reject(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_reject(
    p_session_id, p_reason, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 9
create or replace function public.atlas_stock_count_cancel(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_cancel(
    p_session_id, p_reason, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 10
revoke all on function public.atlas_stock_count_snapshot(jsonb,uuid,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 11
revoke all on function public.atlas_stock_count_detail(uuid,uuid,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 12
revoke all on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 13
revoke all on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 14
revoke all on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 15
revoke all on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 16
revoke all on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 17
revoke all on function public.atlas_stock_count_publish(uuid,text,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 18
revoke all on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 19
revoke all on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) from public, anon, authenticated;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 20
grant execute on function public.atlas_stock_count_snapshot(jsonb,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 21
grant execute on function public.atlas_stock_count_detail(uuid,uuid,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 22
grant execute on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 23
grant execute on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 24
grant execute on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 25
grant execute on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 26
grant execute on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 27
grant execute on function public.atlas_stock_count_publish(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 28
grant execute on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 29
grant execute on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20260909083100_atlas_stock_counts_named_arguments.sql statement 30
notify pgrst, 'reload schema';

-- SOURCE supabase/migrations/20260909085342_atlas_reports_recordset_wrapper_hardening.sql statement 0
-- Harden the isolated Reports RPC boundary before the private parser expands
-- incoming JSON with jsonb_to_recordset. Each recordset is coerced to an
-- array and non-object members are discarded. Production source rows are not
-- changed; this only normalizes the read-only JSON copy used for reporting.

create or replace function public.atlas_reports_snapshot_v2(
  p_inventory jsonb,
  p_recipes jsonb,
  p_recipe_ingredients jsonb,
  p_suppliers jsonb,
  p_movements jsonb,
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with normalized_inputs as (
    select
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))='array'
            then coalesce(p_inventory,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as inventory,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipes,'[]'::jsonb))='array'
            then coalesce(p_recipes,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipes,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipe_ingredients,'[]'::jsonb))='array'
            then coalesce(p_recipe_ingredients,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipe_ingredients,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_suppliers,'[]'::jsonb))='array'
            then coalesce(p_suppliers,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as suppliers,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_movements,'[]'::jsonb))='array'
            then coalesce(p_movements,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as movements,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))='array'
            then coalesce(p_profiles,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as profiles,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_tasks,'[]'::jsonb))='array'
            then coalesce(p_tasks,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as tasks,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_progress,'[]'::jsonb))='array'
            then coalesce(p_progress,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as progress
  ),
  normalized_inventory as (
    select coalesce(jsonb_agg(
      case
        when item ? 'package_size' then jsonb_set(
          item,
          '{package_size}',
          to_jsonb(atlas_private.reports_normalize_package_size(item->>'package_size')),
          true
        )
        else item
      end
    ),'[]'::jsonb) as payload
    from normalized_inputs
    cross join lateral jsonb_array_elements(normalized_inputs.inventory) as rows(item)
  )
  select atlas_private.reports_snapshot_v2(
    normalized_inventory.payload,
    normalized_inputs.recipes,
    normalized_inputs.recipe_ingredients,
    normalized_inputs.suppliers,
    normalized_inputs.movements,
    normalized_inputs.profiles,
    normalized_inputs.tasks,
    normalized_inputs.progress,
    p_actor_id,
    p_actor_role,
    p_period_start,
    p_period_end,
    p_comparison_start,
    p_comparison_end,
    p_comparison_key,
    p_filters
  )
  from normalized_inputs
  cross join normalized_inventory;
$function$;

-- SOURCE supabase/migrations/20260909085342_atlas_reports_recordset_wrapper_hardening.sql statement 1
revoke execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260909085342_atlas_reports_recordset_wrapper_hardening.sql statement 2
grant execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

-- SOURCE supabase/migrations/20260909085342_atlas_reports_recordset_wrapper_hardening.sql statement 3
comment on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  is 'Service-role-only Reports snapshot wrapper. Coerces all incoming recordsets to arrays of JSON objects before invoking the read-only private parser.';

-- SOURCE supabase/migrations/20260909085342_atlas_reports_recordset_wrapper_hardening.sql statement 4
notify pgrst,'reload schema';

-- SOURCE supabase/migrations/20260909090422_atlas_reports_null_package_size_wrapper_fix.sql statement 0
-- Keep the isolated Reports wrapper object-only after package-size
-- normalization. to_jsonb(SQL NULL) is SQL NULL, and jsonb_set is strict;
-- coalescing the replacement to JSON null prevents a valid inventory object
-- with package_size=null from becoming a null array member.

create or replace function public.atlas_reports_snapshot_v2(
  p_inventory jsonb,
  p_recipes jsonb,
  p_recipe_ingredients jsonb,
  p_suppliers jsonb,
  p_movements jsonb,
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with normalized_inputs as (
    select
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))='array'
            then coalesce(p_inventory,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as inventory,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipes,'[]'::jsonb))='array'
            then coalesce(p_recipes,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipes,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipe_ingredients,'[]'::jsonb))='array'
            then coalesce(p_recipe_ingredients,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipe_ingredients,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_suppliers,'[]'::jsonb))='array'
            then coalesce(p_suppliers,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as suppliers,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_movements,'[]'::jsonb))='array'
            then coalesce(p_movements,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as movements,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))='array'
            then coalesce(p_profiles,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as profiles,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_tasks,'[]'::jsonb))='array'
            then coalesce(p_tasks,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as tasks,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_progress,'[]'::jsonb))='array'
            then coalesce(p_progress,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as progress
  ),
  normalized_inventory as (
    select coalesce(jsonb_agg(
      case
        when item ? 'package_size' then jsonb_set(
          item,
          '{package_size}',
          coalesce(
            to_jsonb(atlas_private.reports_normalize_package_size(item->>'package_size')),
            'null'::jsonb
          ),
          true
        )
        else item
      end
    ),'[]'::jsonb) as payload
    from normalized_inputs
    cross join lateral jsonb_array_elements(normalized_inputs.inventory) as rows(item)
  )
  select atlas_private.reports_snapshot_v2(
    normalized_inventory.payload,
    normalized_inputs.recipes,
    normalized_inputs.recipe_ingredients,
    normalized_inputs.suppliers,
    normalized_inputs.movements,
    normalized_inputs.profiles,
    normalized_inputs.tasks,
    normalized_inputs.progress,
    p_actor_id,
    p_actor_role,
    p_period_start,
    p_period_end,
    p_comparison_start,
    p_comparison_end,
    p_comparison_key,
    p_filters
  )
  from normalized_inputs
  cross join normalized_inventory;
$function$;

-- SOURCE supabase/migrations/20260909090422_atlas_reports_null_package_size_wrapper_fix.sql statement 1
revoke execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;

-- SOURCE supabase/migrations/20260909090422_atlas_reports_null_package_size_wrapper_fix.sql statement 2
grant execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

-- SOURCE supabase/migrations/20260909090422_atlas_reports_null_package_size_wrapper_fix.sql statement 3
comment on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  is 'Service-role-only Reports snapshot wrapper. Coerces every recordset to JSON objects and preserves object shape when package_size is null.';

-- SOURCE supabase/migrations/20260909090422_atlas_reports_null_package_size_wrapper_fix.sql statement 4
notify pgrst,'reload schema';
-- Neutral isolated settings: no venue prices, operational history or release claims.
insert into atlas_private.settings_sections(section_key,label,description,status,settings_value)
select key, initcap(key), 'Isolated S33 rehearsal; configuration awaiting review', 'review', '{}'::jsonb
from unnest(array['venue','operations','inventory','temperature','cleaning','marketing','brain','security','appearance','modules']) key;
comment on schema atlas_private is 'S33 isolated runtime; synthetic rehearsal only. No production connectivity is authorized.';
commit;
