-- S70: Store S63B review decisions in the immutable decision ledger.
-- S63B source rows remain frozen. Review status/action/match are projected from the latest decision.

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
  batch_key text;
  prior atlas_private.review_decisions;
  previous_status text;
  previous_action text;
  previous_match text;
  new_status text;
  new_action text;
  new_match text;
  row_source_key text;
begin
  if p_decision not in ('approve','reject','reset') then
    raise exception 'Invalid decision: %', p_decision;
  end if;

  select *
  into before_row
  from atlas_private.import_inventory_rows
  where id=p_row_id
  for update;

  if not found then raise exception 'Inventory staging row not found'; end if;

  select b.batch_key
  into batch_key
  from atlas_private.import_batches b
  where b.id=before_row.batch_id;

  select *
  into prior
  from atlas_private.review_decisions d
  where d.row_kind='inventory' and d.row_id=p_row_id
  order by d.created_at desc, d.id desc
  limit 1;

  previous_status := coalesce(prior.new_status,before_row.review_status);
  previous_action := coalesce(prior.new_action,before_row.proposed_action);
  previous_match := coalesce(prior.new_matched_id,before_row.matched_item_id);

  new_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    else 'pending'
  end;

  new_action := coalesce(p_action,previous_action,'review');
  new_match := coalesce(p_matched_item_id,previous_match);

  if p_decision='approve' and new_action not in ('review','create','merge','skip') then
    raise exception 'Approved inventory row requires review, create, merge, or skip action';
  end if;
  if p_decision='approve' and new_action='merge' and new_match is null then
    raise exception 'Merge approval requires a matched inventory item';
  end if;
  if p_decision='reset' then
    new_action := 'review';
    new_match := null;
  end if;

  row_source_key := coalesce(
    before_row.normalized_data->>'item_id',
    before_row.canonical_key,
    before_row.id::text
  );

  if batch_key like 'S63B-%' then
    insert into atlas_private.review_decisions (
      row_kind,row_id,batch_id,source_key,decision,
      previous_status,new_status,previous_action,new_action,
      previous_matched_id,new_matched_id,notes,decided_by,decided_by_label
    ) values (
      'inventory',before_row.id,before_row.batch_id,row_source_key,p_decision,
      previous_status,new_status,previous_action,new_action,
      previous_match,new_match,p_notes,p_decided_by,p_decided_by_label
    );

    after_row := before_row;
    after_row.review_status := new_status;
    after_row.proposed_action := new_action;
    after_row.matched_item_id := new_match;
    after_row.decision_notes := p_notes;
    after_row.reviewed_by := p_decided_by;
    after_row.reviewed_by_label := p_decided_by_label;
    after_row.reviewed_at := case when p_decision='reset' then null else pg_catalog.now() end;
    after_row.decision_version := before_row.decision_version + 1;
    return after_row;
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
  where id=p_row_id
  returning * into after_row;

  insert into atlas_private.review_decisions (
    row_kind,row_id,batch_id,source_key,decision,
    previous_status,new_status,previous_action,new_action,
    previous_matched_id,new_matched_id,notes,decided_by,decided_by_label
  ) values (
    'inventory',after_row.id,after_row.batch_id,row_source_key,p_decision,
    previous_status,after_row.review_status,previous_action,after_row.proposed_action,
    previous_match,after_row.matched_item_id,p_notes,p_decided_by,p_decided_by_label
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
  batch_key text;
  prior atlas_private.review_decisions;
  previous_status text;
  previous_action text;
  previous_match text;
  new_status text;
  new_action text;
  new_match_type text;
  new_match_id text;
  row_source_key text;
begin
  if p_decision not in ('approve','reject','reset') then
    raise exception 'Invalid decision: %', p_decision;
  end if;

  select *
  into before_row
  from atlas_private.import_entity_rows
  where id=p_row_id
  for update;

  if not found then raise exception 'Entity staging row not found'; end if;

  select b.batch_key
  into batch_key
  from atlas_private.import_batches b
  where b.id=before_row.batch_id;

  select *
  into prior
  from atlas_private.review_decisions d
  where d.row_kind='entity' and d.row_id=p_row_id
  order by d.created_at desc, d.id desc
  limit 1;

  previous_status := coalesce(prior.new_status,before_row.review_status);
  previous_action := coalesce(prior.new_action,before_row.proposed_action);
  previous_match := coalesce(prior.new_matched_id,before_row.matched_entity_id);

  new_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    else 'pending'
  end;

  new_action := coalesce(p_action,previous_action,'review');
  new_match_type := coalesce(p_matched_entity_type,before_row.matched_entity_type);
  new_match_id := coalesce(p_matched_entity_id,previous_match);

  if p_decision='approve' and new_action not in ('review','create','merge','link','skip') then
    raise exception 'Approved entity row requires review, create, merge, link, or skip action';
  end if;
  if p_decision='approve' and new_action in ('merge','link') and new_match_id is null then
    raise exception 'Merge/link approval requires a matched entity';
  end if;
  if p_decision='reset' then
    new_action := 'review';
    new_match_type := null;
    new_match_id := null;
  end if;

  row_source_key := coalesce(
    before_row.source_key,
    before_row.normalized_data->>'recipe_key',
    before_row.normalized_data->>'name',
    before_row.id::text
  );

  if batch_key like 'S63B-%' then
    insert into atlas_private.review_decisions (
      row_kind,row_id,batch_id,source_key,decision,
      previous_status,new_status,previous_action,new_action,
      previous_matched_id,new_matched_id,notes,decided_by,decided_by_label
    ) values (
      'entity',before_row.id,before_row.batch_id,row_source_key,p_decision,
      previous_status,new_status,previous_action,new_action,
      previous_match,new_match_id,p_notes,p_decided_by,p_decided_by_label
    );

    after_row := before_row;
    after_row.review_status := new_status;
    after_row.proposed_action := new_action;
    after_row.matched_entity_type := new_match_type;
    after_row.matched_entity_id := new_match_id;
    after_row.decision_notes := p_notes;
    after_row.reviewed_by := p_decided_by;
    after_row.reviewed_by_label := p_decided_by_label;
    after_row.reviewed_at := case when p_decision='reset' then null else pg_catalog.now() end;
    after_row.decision_version := before_row.decision_version + 1;
    return after_row;
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
  where id=p_row_id
  returning * into after_row;

  insert into atlas_private.review_decisions (
    row_kind,row_id,batch_id,source_key,decision,
    previous_status,new_status,previous_action,new_action,
    previous_matched_id,new_matched_id,notes,decided_by,decided_by_label
  ) values (
    'entity',after_row.id,after_row.batch_id,row_source_key,p_decision,
    previous_status,after_row.review_status,previous_action,after_row.proposed_action,
    previous_match,after_row.matched_entity_id,p_notes,p_decided_by,p_decided_by_label
  );

  return after_row;
end;
$$;

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
  coalesce(dec.new_action,row.proposed_action) as proposed_action,
  coalesce(dec.new_status,row.review_status) as review_status,
  coalesce(dec.new_matched_id,row.matched_item_id) as matched_id,
  row.match_strategy,
  row.match_score,
  row.issues,
  coalesce(dec.notes,row.decision_notes) as decision_notes,
  coalesce(dec.decided_by,row.reviewed_by) as reviewed_by,
  coalesce(dec.decided_by_label,row.reviewed_by_label) as reviewed_by_label,
  coalesce(dec.created_at,row.reviewed_at) as reviewed_at,
  row.decision_version + coalesce(decision_count.count,0)::integer as decision_version,
  row.updated_at,
  (batch.batch_key like 'S63B-%') as source_frozen
from atlas_private.import_inventory_rows row
join atlas_private.import_batches batch on batch.id=row.batch_id
left join lateral (
  select d.*
  from atlas_private.review_decisions d
  where d.row_kind='inventory' and d.row_id=row.id
  order by d.created_at desc,d.id desc
  limit 1
) dec on true
left join lateral (
  select count(*)::bigint as count
  from atlas_private.review_decisions d
  where d.row_kind='inventory' and d.row_id=row.id
) decision_count on true

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
  coalesce(dec.new_action,row.proposed_action),
  coalesce(dec.new_status,row.review_status),
  coalesce(dec.new_matched_id,row.matched_entity_id),
  row.match_strategy,
  row.match_score,
  row.issues,
  coalesce(dec.notes,row.decision_notes),
  coalesce(dec.decided_by,row.reviewed_by),
  coalesce(dec.decided_by_label,row.reviewed_by_label),
  coalesce(dec.created_at,row.reviewed_at),
  row.decision_version + coalesce(decision_count.count,0)::integer,
  row.updated_at,
  (batch.batch_key like 'S63B-%')
from atlas_private.import_entity_rows row
join atlas_private.import_batches batch on batch.id=row.batch_id
left join lateral (
  select d.*
  from atlas_private.review_decisions d
  where d.row_kind='entity' and d.row_id=row.id
  order by d.created_at desc,d.id desc
  limit 1
) dec on true
left join lateral (
  select count(*)::bigint as count
  from atlas_private.review_decisions d
  where d.row_kind='entity' and d.row_id=row.id
) decision_count on true

union all

select
  'review_item'::text,
  r.id,
  r.batch_id,
  b.batch_key,
  r.entity_type,
  (r.source_data->>'source_ordinal')::integer,
  r.source_key,
  coalesce(r.source_data->'source_record'->>'name',r.source_key),
  coalesce(r.source_data->>'source_file',b.file_name),
  null::integer,
  'review'::text,
  r.source_data->>'disposition',
  null::text,
  null::text,
  null::numeric,
  array[r.issue],
  r.source_data->>'resolution',
  null::uuid,
  null::text,
  null::timestamptz,
  0,
  r.created_at,
  true
from atlas_private.import_review_items r
join atlas_private.import_batches b on b.id=r.batch_id
where b.batch_key like 'S63B-%'
  and r.source_data->>'record_kind'='source_record';

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
  latest_decision jsonb;
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
    select
      to_jsonb(r) || jsonb_build_object(
        'normalized_data',r.source_data->'source_record',
        'raw_data',r.source_data,
        'source_hash',r.source_data->>'wire_sha256',
        'entity_scope',r.entity_type,
        'review_status',r.source_data->>'disposition',
        'proposed_action','review',
        'issues',jsonb_build_array(r.issue),
        'batch_key',b.batch_key,
        'batch_source_files',b.source_files,
        'batch_file_name',b.file_name
      ),
      r.batch_id,
      r.source_key
    into row_data,row_batch_id,row_source_key
    from atlas_private.import_review_items r
    join atlas_private.import_batches b on b.id=r.batch_id
    where r.id=p_row_id
      and b.batch_key like 'S63B-%'
      and r.source_data->>'record_kind'='source_record';
  else
    raise exception 'Unsupported row kind: %',p_row_kind;
  end if;

  if row_data is null then raise exception 'Sprint 3 review row not found'; end if;

  select to_jsonb(d)
  into latest_decision
  from atlas_private.review_decisions d
  where d.row_kind=p_row_kind and d.row_id=p_row_id
  order by d.created_at desc,d.id desc
  limit 1;

  if latest_decision is not null and p_row_kind in ('inventory','entity') then
    row_data := row_data || jsonb_build_object(
      'review_status',latest_decision->>'new_status',
      'proposed_action',latest_decision->>'new_action',
      'decision_notes',latest_decision->>'notes',
      'reviewed_by',latest_decision->>'decided_by',
      'reviewed_by_label',latest_decision->>'decided_by_label',
      'reviewed_at',latest_decision->>'created_at'
    );
    if p_row_kind='inventory' then
      row_data := row_data || jsonb_build_object('matched_item_id',latest_decision->>'new_matched_id');
    else
      row_data := row_data || jsonb_build_object('matched_entity_id',latest_decision->>'new_matched_id');
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(decision_record) order by decision_record.created_at desc),'[]'::jsonb)
  into history_data
  from atlas_private.review_decisions decision_record
  where decision_record.row_kind=p_row_kind and decision_record.row_id=p_row_id;

  select coalesce(jsonb_agg(to_jsonb(issue_record) order by issue_record.severity desc,issue_record.issue),'[]'::jsonb)
  into issues_data
  from atlas_private.import_review_items issue_record
  where issue_record.batch_id=row_batch_id and issue_record.source_key=row_source_key;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.resolved,i.severity,i.issue),'[]'::jsonb)
  into batch_issues_data
  from atlas_private.import_review_items i
  where i.batch_id=row_batch_id
    and i.source_data->>'record_kind'='review_issue'
    and i.source_key is distinct from row_source_key;

  return jsonb_build_object(
    'source_frozen',row_data->>'batch_key' like 'S63B-%',
    'decision_allowed',p_row_kind in ('inventory','entity'),
    'batch_issue_records',batch_issues_data,
    'row_kind',p_row_kind,
    'row',row_data,
    'history',history_data,
    'issue_records',issues_data
  );
end;
$$;

revoke execute on function atlas_private.decide_inventory_row(uuid,text,text,text,text,uuid,text)
  from public,anon,authenticated;
revoke execute on function atlas_private.decide_entity_row(uuid,text,text,text,text,text,uuid,text)
  from public,anon,authenticated;
grant execute on function atlas_private.decide_inventory_row(uuid,text,text,text,text,uuid,text) to service_role;
grant execute on function atlas_private.decide_entity_row(uuid,text,text,text,text,text,uuid,text) to service_role;

revoke all on atlas_private.review_queue from public,anon,authenticated;
grant select on atlas_private.review_queue to service_role;
revoke execute on function public.atlas_sprint3_review_detail(text,uuid) from public,anon,authenticated;
grant execute on function public.atlas_sprint3_review_detail(text,uuid) to service_role;
