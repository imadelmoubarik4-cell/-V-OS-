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
