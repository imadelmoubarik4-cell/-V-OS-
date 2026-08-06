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
