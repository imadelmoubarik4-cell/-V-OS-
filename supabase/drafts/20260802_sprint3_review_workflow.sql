-- Sprint 3 - Real VÁ Data review workflow.
-- Public-safe database contract only. Contains no operational rows.
-- Apply only after 20260802_sprint3_private_staging.sql on an isolated branch.

alter table atlas_private.import_inventory_rows
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_by_label text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists decision_version integer not null default 0;

alter table atlas_private.import_entity_rows
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_by_label text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists decision_version integer not null default 0;

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

create index if not exists sprint3_review_decisions_row_idx
  on atlas_private.review_decisions(row_kind,row_id,created_at desc);
create index if not exists sprint3_review_decisions_batch_idx
  on atlas_private.review_decisions(batch_id,created_at desc);

alter table atlas_private.review_decisions enable row level security;
drop policy if exists "service role manages sprint3 decisions" on atlas_private.review_decisions;
create policy "service role manages sprint3 decisions"
  on atlas_private.review_decisions for all to service_role
  using (true) with check (true);
revoke all on atlas_private.review_decisions from public, anon, authenticated;
grant select, insert on atlas_private.review_decisions to service_role;

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

revoke execute on function atlas_private.decide_inventory_row(uuid,text,text,text,text,uuid,text)
  from public, anon, authenticated;
revoke execute on function atlas_private.decide_entity_row(uuid,text,text,text,text,text,uuid,text)
  from public, anon, authenticated;
grant execute on function atlas_private.decide_inventory_row(uuid,text,text,text,text,uuid,text)
  to service_role;
grant execute on function atlas_private.decide_entity_row(uuid,text,text,text,text,text,uuid,text)
  to service_role;

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

create or replace view atlas_private.review_progress
with (security_invoker = true)
as
select entity_scope,review_status,count(*)::bigint as row_count
from atlas_private.review_queue
group by entity_scope,review_status;

revoke all on atlas_private.review_queue from public, anon, authenticated;
revoke all on atlas_private.review_progress from public, anon, authenticated;
grant select on atlas_private.review_queue to service_role;
grant select on atlas_private.review_progress to service_role;

comment on table atlas_private.review_decisions is
  'Immutable audit trail for Sprint 3 staging decisions.';
comment on view atlas_private.review_queue is
  'Unified private review queue. No browser role has direct access.';
