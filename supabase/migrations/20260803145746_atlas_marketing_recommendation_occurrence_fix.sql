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
