-- S64B: held-source visibility and explicitly labelled batch conflict context.
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
  case when batch.batch_key like 'S63B-%' then 'source_checked' else row.review_status end as review_status,
  row.matched_item_id as matched_id,
  row.match_strategy,
  row.match_score,
  row.issues,
  row.decision_notes,
  row.reviewed_by,
  row.reviewed_by_label,
  row.reviewed_at,
  row.decision_version,
  row.updated_at,
  (batch.batch_key like 'S63B-%') as source_frozen
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
  case when batch.batch_key like 'S63B-%' then 'source_checked' else row.review_status end as review_status,
  row.matched_entity_id,
  row.match_strategy,
  row.match_score,
  row.issues,
  row.decision_notes,
  row.reviewed_by,
  row.reviewed_by_label,
  row.reviewed_at,
  row.decision_version,
  row.updated_at,
  (batch.batch_key like 'S63B-%') as source_frozen
from atlas_private.import_entity_rows row
join atlas_private.import_batches batch on batch.id=row.batch_id
union all
select 'review_item'::text,r.id,r.batch_id,b.batch_key,r.entity_type,
  (r.source_data->>'source_ordinal')::integer,r.source_key,
  coalesce(r.source_data->'source_record'->>'name',r.source_key),
  coalesce(r.source_data->>'source_file',b.file_name),null::integer,
  'review'::text,r.source_data->>'disposition',null::text,null::text,null::numeric,
  array[r.issue],r.source_data->>'resolution',null::uuid,null::text,null::timestamptz,0,r.created_at,true
from atlas_private.import_review_items r join atlas_private.import_batches b on b.id=r.batch_id
where b.batch_key like 'S63B-%' and r.source_data->>'record_kind'='source_record';

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
      'held', (select count(*) from atlas_private.review_queue where review_status='held'),
      'excluded', (select count(*) from atlas_private.review_queue where review_status='excluded'),
      'source_checked', (select count(*) from atlas_private.review_queue where review_status='source_checked'),
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
  batch_issues_data jsonb;
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
      coalesce(row.normalized_data->>'source_key',row.normalized_data->>'item_id',row.canonical_key,row.id::text)
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
  elsif p_row_kind='review_item' then
    select to_jsonb(r) || jsonb_build_object(
      'normalized_data',r.source_data->'source_record','raw_data',r.source_data,
      'source_hash',r.source_data->>'wire_sha256','entity_scope',r.entity_type,
      'review_status',r.source_data->>'disposition','proposed_action','review',
      'issues',jsonb_build_array(r.issue),'batch_key',b.batch_key,
      'batch_source_files',b.source_files,'batch_file_name',b.file_name),r.batch_id,r.source_key
    into row_data,row_batch_id,row_source_key
    from atlas_private.import_review_items r join atlas_private.import_batches b on b.id=r.batch_id
    where r.id=p_row_id and b.batch_key like 'S63B-%' and r.source_data->>'record_kind'='source_record';
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

  select coalesce(jsonb_agg(to_jsonb(i) order by i.resolved,i.severity,i.issue),'[]'::jsonb)
  into batch_issues_data from atlas_private.import_review_items i
  where i.batch_id=row_batch_id and i.source_data->>'record_kind'='review_issue'
    and i.source_key is distinct from row_source_key;
  if row_data->>'batch_key' like 'S63B-%' and p_row_kind<>'review_item' then
    row_data:=row_data || jsonb_build_object('review_status','source_checked');
  end if;
  return jsonb_build_object(
    'source_frozen',row_data->>'batch_key' like 'S63B-%',
    'batch_issue_records',batch_issues_data,
    'row_kind',p_row_kind,
    'row',row_data,
    'history',history_data,
    'issue_records',issues_data
  );
end;
$$;


revoke all on atlas_private.review_queue from public,anon,authenticated;
grant select on atlas_private.review_queue to service_role;
revoke execute on function public.atlas_sprint3_review_summary() from public,anon,authenticated;
revoke execute on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) from public,anon,authenticated;
revoke execute on function public.atlas_sprint3_review_detail(text,uuid) from public,anon,authenticated;
grant execute on function public.atlas_sprint3_review_summary() to service_role;
grant execute on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) to service_role;
grant execute on function public.atlas_sprint3_review_detail(text,uuid) to service_role;


