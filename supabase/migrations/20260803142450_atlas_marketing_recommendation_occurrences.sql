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

create index if not exists marketing_recommendation_occurrences_date_idx
  on atlas_private.marketing_recommendation_occurrences(occurrence_date,state,recommendation_id);
create index if not exists marketing_recommendation_occurrences_content_idx
  on atlas_private.marketing_recommendation_occurrences(content_id)
  where content_id is not null;

alter table atlas_private.marketing_recommendation_occurrences enable row level security;
drop policy if exists "service role manages marketing recommendation occurrences" on atlas_private.marketing_recommendation_occurrences;
create policy "service role manages marketing recommendation occurrences"
  on atlas_private.marketing_recommendation_occurrences for all to service_role using (true) with check (true);
revoke all on atlas_private.marketing_recommendation_occurrences from public,anon,authenticated;
grant all on atlas_private.marketing_recommendation_occurrences to service_role;

drop trigger if exists marketing_recommendation_occurrences_touch on atlas_private.marketing_recommendation_occurrences;
create trigger marketing_recommendation_occurrences_touch
  before update on atlas_private.marketing_recommendation_occurrences
  for each row execute function atlas_private.touch_updated_at();

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

create or replace function public.atlas_marketing_recommendations(p_local_date date)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.marketing_recommendations_for_date(p_local_date); $$;

create or replace function public.atlas_marketing_convert_recommendation_occurrence(
  p_recommendation_id uuid,p_occurrence_date date,p_client_request_id uuid,p_scheduled_for timestamptz,p_reminder_at timestamptz,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_convert_recommendation_occurrence(p_recommendation_id,p_occurrence_date,p_client_request_id,p_scheduled_for,p_reminder_at,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_dismiss_recommendation_occurrence(
  p_recommendation_id uuid,p_occurrence_date date,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_dismiss_recommendation_occurrence(p_recommendation_id,p_occurrence_date,p_reason,p_actor_id,p_actor_label,p_actor_role); $$;

revoke execute on function public.atlas_marketing_recommendations(date) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_dismiss_recommendation_occurrence(uuid,date,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_marketing_recommendations(date) to service_role;
grant execute on function public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_dismiss_recommendation_occurrence(uuid,date,text,uuid,text,text) to service_role;

comment on table atlas_private.marketing_recommendation_occurrences is 'Per-date conversion or dismissal state for recurring Atlas marketing recommendations.';
