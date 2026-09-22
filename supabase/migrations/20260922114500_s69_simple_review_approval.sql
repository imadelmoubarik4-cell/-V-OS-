-- S69: Decouple review approval from later promotion action.
-- An owner/manager may approve source evidence while proposed_action remains 'review'.
-- Promotion remains a separate explicit operation and is not performed here.

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
