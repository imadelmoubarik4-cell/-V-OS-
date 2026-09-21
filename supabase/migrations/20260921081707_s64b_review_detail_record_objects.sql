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

  select coalesce(jsonb_agg(to_jsonb(decision_record) order by decision_record.created_at desc),'[]'::jsonb)
  into history_data
  from atlas_private.review_decisions decision_record
  where decision_record.row_kind=p_row_kind and decision_record.row_id=p_row_id;

  select coalesce(jsonb_agg(to_jsonb(issue_record) order by issue_record.severity desc,issue_record.issue),'[]'::jsonb)
  into issues_data
  from atlas_private.import_review_items issue_record
  where issue_record.batch_id=row_batch_id and issue_record.source_key=row_source_key;

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



