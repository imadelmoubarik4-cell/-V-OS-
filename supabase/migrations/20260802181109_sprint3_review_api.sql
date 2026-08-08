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

revoke execute on function public.atlas_sprint3_review_summary() from public,anon,authenticated;
revoke execute on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) from public,anon,authenticated;
revoke execute on function public.atlas_sprint3_review_detail(text,uuid) from public,anon,authenticated;
revoke execute on function public.atlas_sprint3_review_decide_inventory(uuid,text,text,text,text,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_sprint3_review_decide_entity(uuid,text,text,text,text,text,uuid,text) from public,anon,authenticated;

grant execute on function public.atlas_sprint3_review_summary() to service_role;
grant execute on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) to service_role;
grant execute on function public.atlas_sprint3_review_detail(text,uuid) to service_role;
grant execute on function public.atlas_sprint3_review_decide_inventory(uuid,text,text,text,text,uuid,text) to service_role;
grant execute on function public.atlas_sprint3_review_decide_entity(uuid,text,text,text,text,text,uuid,text) to service_role;

comment on function public.atlas_sprint3_review_summary() is
  'Service-role-only summary for the Sprint 3 manager review Edge Function.';
comment on function public.atlas_sprint3_review_rows(text,text,text,integer,integer) is
  'Service-role-only paginated review queue for the Sprint 3 manager review Edge Function.';
comment on function public.atlas_sprint3_review_detail(text,uuid) is
  'Service-role-only evidence detail for the Sprint 3 manager review Edge Function.';
comment on function public.atlas_sprint3_review_decide_inventory(uuid,text,text,text,text,uuid,text) is
  'Service-role-only inventory decision wrapper for the Sprint 3 manager review Edge Function.';
comment on function public.atlas_sprint3_review_decide_entity(uuid,text,text,text,text,text,uuid,text) is
  'Service-role-only entity decision wrapper for the Sprint 3 manager review Edge Function.';
