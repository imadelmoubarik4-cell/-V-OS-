-- Checkpoint F workflow completion: roster editing, week copy, time-off
-- decisions and manager resolution of shift response requests.

create or replace function atlas_private.shift_person_update(
  p_person_id uuid,
  p_display_name text,
  p_email text,
  p_default_role text,
  p_active boolean,
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
declare person_row atlas_private.shift_people;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can update the shift roster'; end if;
  if nullif(trim(coalesce(p_display_name,'')),'') is null then raise exception 'Display name is required'; end if;
  update atlas_private.shift_people
  set display_name=trim(p_display_name),
      email=nullif(trim(coalesce(p_email,'')),''),
      default_role=nullif(trim(coalesce(p_default_role,'')),''),
      active=coalesce(p_active,active),
      updated_by=p_actor_id,
      updated_by_label=p_actor_label
  where id=p_person_id
  returning * into person_row;
  if not found then raise exception 'Roster person not found'; end if;
  insert into atlas_private.shift_events (event_type,person_id,actor_id,actor_label,actor_role,payload)
  values ('person_updated',person_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('display_name',person_row.display_name,'active',person_row.active,'default_role',person_row.default_role));
  return to_jsonb(person_row);
end;
$$;

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
declare copied_count bigint;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can copy schedules'; end if;
  if extract(isodow from p_source_week)<>1 or extract(isodow from p_target_week)<>1 then raise exception 'Week dates must be Mondays'; end if;
  if p_source_week=p_target_week then raise exception 'Source and target weeks must differ'; end if;
  perform atlas_private.shift_ensure_week(p_target_week,p_actor_id,p_actor_label);
  if exists (select 1 from atlas_private.shift_entries where week_start=p_target_week and active=true) then
    raise exception 'The target week already contains shifts';
  end if;

  insert into atlas_private.shift_entries (
    week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select
    p_target_week,shift.person_id,shift.role_name,
    shift.starts_at+(p_target_week-p_source_week),
    shift.ends_at+(p_target_week-p_source_week),
    shift.break_minutes,shift.note,'copied',true,
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from atlas_private.shift_entries shift
  where shift.week_start=p_source_week and shift.active=true;
  get diagnostics copied_count=row_count;
  if copied_count=0 then raise exception 'The source week has no shifts to copy'; end if;

  update atlas_private.shift_weeks set has_unpublished_changes=true where week_start=p_target_week;
  insert into atlas_private.shift_events (event_type,week_start,actor_id,actor_label,actor_role,payload)
  values ('week_copied',p_target_week,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_week',p_source_week,'copied_count',copied_count));
  return jsonb_build_object('source_week',p_source_week,'target_week',p_target_week,'copied_count',copied_count);
end;
$$;

create or replace function atlas_private.shift_request_time_off(
  p_person_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_request_type text,
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
declare person_row atlas_private.shift_people; request_row atlas_private.shift_time_off; initial_status text;
begin
  select * into person_row from atlas_private.shift_people where id=p_person_id;
  if not found then raise exception 'Team member not found'; end if;
  if p_actor_role not in ('admin','manager') and person_row.profile_id<>p_actor_id then
    raise exception 'Staff may request time off only for themselves';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on<p_starts_on then raise exception 'Time-off dates are invalid'; end if;
  if p_ends_on-p_starts_on>366 then raise exception 'Time-off request is too long'; end if;
  if p_request_type not in ('unavailable','vacation','sick','other') then raise exception 'Time-off type is invalid'; end if;
  initial_status := case when p_actor_role in ('admin','manager') then 'approved' else 'pending' end;

  insert into atlas_private.shift_time_off (
    person_id,starts_on,ends_on,request_type,status,note,requested_by,requested_by_label,
    decided_by,decided_by_label,decided_at
  ) values (
    p_person_id,p_starts_on,p_ends_on,p_request_type,initial_status,
    nullif(trim(coalesce(p_note,'')),''),p_actor_id,p_actor_label,
    case when initial_status='approved' then p_actor_id else null end,
    case when initial_status='approved' then p_actor_label else null end,
    case when initial_status='approved' then pg_catalog.now() else null end
  ) returning * into request_row;

  insert into atlas_private.shift_events (event_type,person_id,actor_id,actor_label,actor_role,payload)
  values ('time_off_requested',p_person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',request_row.id,'starts_on',p_starts_on,'ends_on',p_ends_on,'status',initial_status,'request_type',p_request_type));
  return to_jsonb(request_row);
end;
$$;

create or replace function atlas_private.shift_decide_time_off(
  p_request_id uuid,
  p_status text,
  p_manager_note text,
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
declare request_row atlas_private.shift_time_off;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can decide time-off requests'; end if;
  if p_status not in ('approved','rejected','cancelled') then raise exception 'Decision status is invalid'; end if;
  update atlas_private.shift_time_off
  set status=p_status,
      manager_note=nullif(trim(coalesce(p_manager_note,'')),''),
      decided_by=p_actor_id,
      decided_by_label=p_actor_label,
      decided_at=pg_catalog.now()
  where id=p_request_id and status='pending'
  returning * into request_row;
  if not found then raise exception 'Pending time-off request not found'; end if;
  insert into atlas_private.shift_events (event_type,person_id,actor_id,actor_label,actor_role,payload)
  values ('time_off_decided',request_row.person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',request_row.id,'status',p_status,'manager_note',p_manager_note));
  return to_jsonb(request_row);
end;
$$;

create or replace function atlas_private.shift_decide_response(
  p_shift_id uuid,
  p_person_id uuid,
  p_manager_status text,
  p_manager_note text,
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
declare response_row atlas_private.shift_responses; shift_row atlas_private.shift_entries;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can decide shift requests'; end if;
  if p_manager_status not in ('resolved','rejected') then raise exception 'Manager status is invalid'; end if;
  if nullif(trim(coalesce(p_manager_note,'')),'') is null then raise exception 'A manager note is required'; end if;
  update atlas_private.shift_responses
  set manager_status=p_manager_status,
      manager_note=trim(p_manager_note),
      decided_by=p_actor_id,
      decided_by_label=p_actor_label,
      decided_at=pg_catalog.now()
  where shift_id=p_shift_id and person_id=p_person_id and manager_status='open'
  returning * into response_row;
  if not found then raise exception 'Open shift request not found'; end if;
  select * into shift_row from atlas_private.shift_entries where id=p_shift_id;
  insert into atlas_private.shift_events (event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload)
  values ('shift_response_decided',shift_row.week_start,p_shift_id,p_person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('manager_status',p_manager_status,'manager_note',p_manager_note));
  return to_jsonb(response_row);
end;
$$;

create or replace function public.atlas_shifts_update_person(
  p_person_id uuid,p_display_name text,p_email text,p_default_role text,p_active boolean,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_person_update(p_person_id,p_display_name,p_email,p_default_role,p_active,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_shifts_copy_week(
  p_source_week date,p_target_week date,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_copy_week(p_source_week,p_target_week,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_shifts_request_time_off(
  p_person_id uuid,p_starts_on date,p_ends_on date,p_request_type text,p_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_request_time_off(p_person_id,p_starts_on,p_ends_on,p_request_type,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_shifts_decide_time_off(
  p_request_id uuid,p_status text,p_manager_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_decide_time_off(p_request_id,p_status,p_manager_note,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_shifts_decide_response(
  p_shift_id uuid,p_person_id uuid,p_manager_status text,p_manager_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.shift_decide_response(p_shift_id,p_person_id,p_manager_status,p_manager_note,p_actor_id,p_actor_label,p_actor_role); $$;

revoke execute on function public.atlas_shifts_update_person(uuid,text,text,text,boolean,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_copy_week(date,date,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_request_time_off(uuid,date,date,text,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_decide_time_off(uuid,text,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_decide_response(uuid,uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_shifts_update_person(uuid,text,text,text,boolean,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_copy_week(date,date,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_request_time_off(uuid,date,date,text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_decide_time_off(uuid,text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_decide_response(uuid,uuid,text,text,uuid,text,text) to service_role;
