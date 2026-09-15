-- PostgreSQL dates subtract to an integer day count. Convert that count to an
-- interval before adding it to timestamptz shift boundaries.

create or replace function atlas_private.shift_copy_week(
  p_source_week date,
  p_target_week date,
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
  copied_count bigint;
  week_offset interval := (p_target_week-p_source_week) * interval '1 day';
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can copy schedules';
  end if;
  if extract(isodow from p_source_week)<>1 or extract(isodow from p_target_week)<>1 then
    raise exception 'Week dates must be Mondays';
  end if;
  if p_source_week=p_target_week then
    raise exception 'Source and target weeks must differ';
  end if;

  perform atlas_private.shift_ensure_week(p_target_week,p_actor_id,p_actor_label);
  if exists (
    select 1 from atlas_private.shift_entries
    where week_start=p_target_week and active=true
  ) then
    raise exception 'The target week already contains shifts';
  end if;

  insert into atlas_private.shift_entries (
    week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select
    p_target_week,
    shift.person_id,
    shift.role_name,
    shift.starts_at+week_offset,
    shift.ends_at+week_offset,
    shift.break_minutes,
    shift.note,
    'copied',
    true,
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from atlas_private.shift_entries shift
  where shift.week_start=p_source_week and shift.active=true;
  get diagnostics copied_count=row_count;

  if copied_count=0 then
    raise exception 'The source week has no shifts to copy';
  end if;

  update atlas_private.shift_weeks
  set has_unpublished_changes=true
  where week_start=p_target_week;

  insert into atlas_private.shift_events (
    event_type,week_start,actor_id,actor_label,actor_role,payload
  ) values (
    'week_copied',p_target_week,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_week',p_source_week,'copied_count',copied_count)
  );

  return jsonb_build_object(
    'source_week',p_source_week,
    'target_week',p_target_week,
    'copied_count',copied_count
  );
end;
$$;
