-- Checkpoint F.2: make the full month the primary schedule-planning and
-- publication unit while preserving weekly drill-down and staff confirmations.

create table if not exists atlas_private.shift_months (
  month_start date primary key,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  revision integer not null default 0 check (revision >= 0),
  has_unpublished_changes boolean not null default false,
  note text,
  published_at timestamptz,
  published_by uuid,
  published_by_label text,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_trunc('month',month_start)::date=month_start),
  check (note is null or char_length(note)<=3000)
);

create table if not exists atlas_private.shift_month_publications (
  id uuid primary key default gen_random_uuid(),
  month_start date not null references atlas_private.shift_months(month_start) on delete cascade,
  revision integer not null check (revision>0),
  snapshot jsonb not null,
  week_revisions jsonb not null default '[]'::jsonb,
  shift_count integer not null,
  planned_hours numeric(10,2) not null,
  published_by uuid,
  published_by_label text,
  published_at timestamptz not null default now(),
  unique (month_start,revision),
  check (jsonb_typeof(snapshot)='object'),
  check (jsonb_typeof(week_revisions)='array'),
  check (shift_count>=0),
  check (planned_hours>=0)
);

create index if not exists shift_month_publications_latest_idx
  on atlas_private.shift_month_publications(month_start,revision desc);

alter table atlas_private.shift_months enable row level security;
alter table atlas_private.shift_month_publications enable row level security;

drop policy if exists "service role manages shift months" on atlas_private.shift_months;
create policy "service role manages shift months"
  on atlas_private.shift_months for all to service_role using (true) with check (true);

drop policy if exists "service role manages shift month publications" on atlas_private.shift_month_publications;
create policy "service role manages shift month publications"
  on atlas_private.shift_month_publications for all to service_role using (true) with check (true);

revoke all on atlas_private.shift_months from public,anon,authenticated;
revoke all on atlas_private.shift_month_publications from public,anon,authenticated;
grant all on atlas_private.shift_months to service_role;
grant all on atlas_private.shift_month_publications to service_role;

drop trigger if exists shift_months_touch on atlas_private.shift_months;
create trigger shift_months_touch before update on atlas_private.shift_months
  for each row execute function atlas_private.touch_updated_at();

alter table atlas_private.shift_events
  add column if not exists month_start date;

create index if not exists shift_events_month_created_idx
  on atlas_private.shift_events(month_start,created_at desc)
  where month_start is not null;

alter table atlas_private.shift_events
  drop constraint if exists shift_events_event_type_check;

alter table atlas_private.shift_events
  add constraint shift_events_event_type_check
  check (event_type in (
    'profiles_synced','person_created','person_updated','shift_created','shift_updated','shift_cancelled',
    'week_copied','week_published','month_published','availability_updated','time_off_requested',
    'time_off_decided','shift_response_updated','shift_response_decided'
  ));

create or replace function atlas_private.shift_month_start(p_date date)
returns date
language sql
immutable
security invoker
set search_path=''
as $$
  select date_trunc('month',p_date)::date;
$$;

create or replace function atlas_private.shift_ensure_month(
  p_month_start date,
  p_actor_id uuid,
  p_actor_label text
)
returns atlas_private.shift_months
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare month_row atlas_private.shift_months;
begin
  if p_month_start is null or date_trunc('month',p_month_start)::date<>p_month_start then
    raise exception 'Month start must be the first day of a month';
  end if;

  insert into atlas_private.shift_months (
    month_start,created_by,created_by_label
  ) values (
    p_month_start,p_actor_id,p_actor_label
  )
  on conflict (month_start) do nothing;

  select * into month_row
  from atlas_private.shift_months
  where month_start=p_month_start;
  return month_row;
end;
$$;

create or replace function atlas_private.shift_mark_month_unpublished()
returns trigger
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  timezone_name text;
  old_month date;
  new_month date;
  actor_id uuid;
  actor_label text;
  operational_change boolean := true;
begin
  select timezone into timezone_name
  from atlas_private.shift_settings
  where setting_key='va';
  timezone_name := coalesce(timezone_name,'Atlantic/Reykjavik');

  if tg_op='UPDATE' then
    operational_change := (
      old.week_start,old.person_id,old.role_name,old.starts_at,old.ends_at,
      old.break_minutes,old.note,old.active
    ) is distinct from (
      new.week_start,new.person_id,new.role_name,new.starts_at,new.ends_at,
      new.break_minutes,new.note,new.active
    );
    if not operational_change then return new; end if;
    old_month := date_trunc('month',old.starts_at at time zone timezone_name)::date;
  end if;

  new_month := date_trunc('month',new.starts_at at time zone timezone_name)::date;
  actor_id := coalesce(new.updated_by,new.created_by);
  actor_label := coalesce(new.updated_by_label,new.created_by_label);

  insert into atlas_private.shift_months (
    month_start,status,has_unpublished_changes,created_by,created_by_label
  ) values (
    new_month,'draft',true,actor_id,actor_label
  )
  on conflict (month_start) do update set
    has_unpublished_changes=true,
    status=case when atlas_private.shift_months.status='archived' then 'draft' else atlas_private.shift_months.status end,
    updated_at=pg_catalog.now();

  if old_month is not null and old_month<>new_month then
    insert into atlas_private.shift_months (
      month_start,status,has_unpublished_changes,created_by,created_by_label
    ) values (
      old_month,'draft',true,actor_id,actor_label
    )
    on conflict (month_start) do update set
      has_unpublished_changes=true,
      status=case when atlas_private.shift_months.status='archived' then 'draft' else atlas_private.shift_months.status end,
      updated_at=pg_catalog.now();
  end if;

  return new;
end;
$$;

drop trigger if exists shift_entries_mark_month_unpublished on atlas_private.shift_entries;
create trigger shift_entries_mark_month_unpublished
  after insert or update of week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,active
  on atlas_private.shift_entries
  for each row execute function atlas_private.shift_mark_month_unpublished();

create or replace function atlas_private.shift_save(
  p_shift_id uuid,
  p_week_start date,
  p_person_id uuid,
  p_role_name text,
  p_starts_local timestamp,
  p_ends_local timestamp,
  p_break_minutes integer,
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
  shift_row atlas_private.shift_entries;
  previous_row atlas_private.shift_entries;
  starts_utc timestamptz;
  ends_utc timestamptz;
  event_name text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can create or edit shifts'; end if;
  perform atlas_private.shift_ensure_week(p_week_start,p_actor_id,p_actor_label);
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  if not exists (select 1 from atlas_private.shift_people where id=p_person_id and active=true) then
    raise exception 'The selected team member is inactive or missing';
  end if;
  if p_starts_local is null or p_ends_local is null then raise exception 'Start and end times are required'; end if;
  if atlas_private.shift_normalize_week(p_starts_local::date)<>p_week_start then
    raise exception 'Shift start is outside the selected week';
  end if;
  if p_ends_local<=p_starts_local then raise exception 'Shift end must be after shift start'; end if;
  if p_ends_local-p_starts_local>interval '24 hours' then raise exception 'A shift cannot exceed 24 hours'; end if;
  if coalesce(p_break_minutes,0)<0
     or coalesce(p_break_minutes,0)>=extract(epoch from (p_ends_local-p_starts_local))/60 then
    raise exception 'Break duration is invalid';
  end if;

  starts_utc := p_starts_local at time zone settings_row.timezone;
  ends_utc := p_ends_local at time zone settings_row.timezone;

  if p_shift_id is null then
    insert into atlas_private.shift_entries (
      week_start,person_id,role_name,starts_at,ends_at,break_minutes,note,source,active,
      created_by,created_by_label,updated_by,updated_by_label
    ) values (
      p_week_start,p_person_id,nullif(trim(coalesce(p_role_name,'')),''),starts_utc,ends_utc,
      coalesce(p_break_minutes,0),nullif(trim(coalesce(p_note,'')),''),'manual',true,
      p_actor_id,p_actor_label,p_actor_id,p_actor_label
    ) returning * into shift_row;
    event_name := 'shift_created';
  else
    select * into previous_row
    from atlas_private.shift_entries
    where id=p_shift_id
    for update;
    if not found then raise exception 'Shift not found'; end if;

    update atlas_private.shift_entries
    set week_start=p_week_start,
        person_id=p_person_id,
        role_name=nullif(trim(coalesce(p_role_name,'')),''),
        starts_at=starts_utc,
        ends_at=ends_utc,
        break_minutes=coalesce(p_break_minutes,0),
        note=nullif(trim(coalesce(p_note,'')),''),
        active=true,
        updated_by=p_actor_id,
        updated_by_label=p_actor_label
    where id=p_shift_id
    returning * into shift_row;
    event_name := 'shift_updated';

    if previous_row.week_start<>p_week_start then
      update atlas_private.shift_weeks
      set has_unpublished_changes=true
      where week_start=previous_row.week_start;
    end if;
  end if;

  update atlas_private.shift_weeks
  set has_unpublished_changes=true,
      status=case when status='archived' then 'draft' else status end
  where week_start=p_week_start;

  insert into atlas_private.shift_events (
    event_type,week_start,month_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    event_name,p_week_start,atlas_private.shift_month_start(p_starts_local::date),
    shift_row.id,shift_row.person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'previous_week_start',previous_row.week_start,
      'starts_at',shift_row.starts_at,
      'ends_at',shift_row.ends_at,
      'role_name',shift_row.role_name,
      'break_minutes',shift_row.break_minutes
    )
  );
  return to_jsonb(shift_row);
end;
$$;

create or replace function atlas_private.shift_month_snapshot(
  p_month_start date,
  p_actor_id uuid,
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
  is_manager boolean := p_actor_role in ('admin','manager');
  actor_person_id uuid;
  month_end date;
  grid_start date;
  grid_end date;
  people_json jsonb := '[]'::jsonb;
  shifts_json jsonb := '[]'::jsonb;
  availability_json jsonb := '[]'::jsonb;
  time_off_json jsonb := '[]'::jsonb;
  responses_json jsonb := '[]'::jsonb;
  weeks_json jsonb := '[]'::jsonb;
  events_json jsonb := '[]'::jsonb;
begin
  if p_month_start is null or date_trunc('month',p_month_start)::date<>p_month_start then
    raise exception 'Month start must be the first day of a month';
  end if;

  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  month_row := atlas_private.shift_ensure_month(p_month_start,p_actor_id,null);
  month_end := (p_month_start+interval '1 month - 1 day')::date;
  grid_start := atlas_private.shift_normalize_week(p_month_start);
  grid_end := atlas_private.shift_normalize_week(month_end);
  select id into actor_person_id from atlas_private.shift_people where profile_id=p_actor_id limit 1;

  select * into publication_row
  from atlas_private.shift_month_publications
  where month_start=p_month_start
  order by revision desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',person.id,
    'profile_id',person.profile_id,
    'display_name',person.display_name,
    'email',person.email,
    'default_role',person.default_role,
    'active',person.active,
    'login_enabled',person.login_enabled,
    'source',person.source,
    'can_edit_availability',(is_manager or person.profile_id=p_actor_id)
  ) order by person.active desc,person.display_name),'[]'::jsonb)
  into people_json
  from atlas_private.shift_people person
  where is_manager or person.active=true or person.profile_id=p_actor_id;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
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
      'active',shift.active,
      'updated_at',shift.updated_at,
      'last_published_revision',shift.last_published_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb)
    into shifts_json
    from atlas_private.shift_entries shift
    join atlas_private.shift_people person on person.id=shift.person_id
    where shift.active=true
      and (shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end;
  elsif publication_row.id is not null then
    shifts_json := coalesce(publication_row.snapshot->'shifts','[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',availability.id,
    'person_id',availability.person_id,
    'weekday',availability.weekday,
    'available_from',availability.available_from,
    'available_to',availability.available_to,
    'unavailable',availability.unavailable,
    'note',availability.note,
    'updated_at',availability.updated_at
  ) order by availability.person_id,availability.weekday),'[]'::jsonb)
  into availability_json
  from atlas_private.shift_availability availability
  join atlas_private.shift_people person on person.id=availability.person_id
  where is_manager or person.profile_id=p_actor_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',request.id,
    'person_id',request.person_id,
    'person_name',person.display_name,
    'starts_on',request.starts_on,
    'ends_on',request.ends_on,
    'request_type',request.request_type,
    'status',request.status,
    'note',request.note,
    'manager_note',case when is_manager then request.manager_note else null end,
    'requested_by_label',request.requested_by_label,
    'decided_by_label',case when is_manager then request.decided_by_label else null end,
    'created_at',request.created_at,
    'updated_at',request.updated_at
  ) order by request.starts_on,person.display_name),'[]'::jsonb)
  into time_off_json
  from atlas_private.shift_time_off request
  join atlas_private.shift_people person on person.id=request.person_id
  where request.ends_on>=p_month_start
    and request.starts_on<=month_end
    and (is_manager or person.profile_id=p_actor_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id',response.shift_id,
    'person_id',response.person_id,
    'response',response.response,
    'note',response.note,
    'responded_at',response.responded_at,
    'manager_status',case when is_manager then response.manager_status else null end,
    'manager_note',case when is_manager then response.manager_note else null end,
    'decided_by_label',case when is_manager then response.decided_by_label else null end,
    'decided_at',case when is_manager then response.decided_at else null end,
    'updated_at',response.updated_at
  ) order by response.updated_at desc),'[]'::jsonb)
  into responses_json
  from atlas_private.shift_responses response
  join atlas_private.shift_entries shift on shift.id=response.shift_id
  join atlas_private.shift_people person on person.id=response.person_id
  where (shift.starts_at at time zone settings_row.timezone)::date between p_month_start and month_end
    and (is_manager or person.profile_id=p_actor_id);

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'week_start',series.week_start,
      'status',coalesce(week.status,'draft'),
      'revision',coalesce(week.revision,0),
      'has_unpublished_changes',coalesce(week.has_unpublished_changes,false),
      'published_at',week.published_at,
      'published_by_label',week.published_by_label,
      'latest_publication',case when publication.id is null then null else jsonb_build_object(
        'id',publication.id,
        'revision',publication.revision,
        'shift_count',publication.shift_count,
        'planned_hours',publication.planned_hours,
        'published_at',publication.published_at,
        'published_by_label',publication.published_by_label
      ) end
    ) order by series.week_start),'[]'::jsonb)
    into weeks_json
    from (
      select generate_series(grid_start,grid_end,interval '7 days')::date as week_start
    ) series
    left join atlas_private.shift_weeks week on week.week_start=series.week_start
    left join lateral (
      select * from atlas_private.shift_publications publication
      where publication.week_start=series.week_start
      order by publication.revision desc
      limit 1
    ) publication on true;
  elsif publication_row.id is not null then
    weeks_json := coalesce(publication_row.week_revisions,'[]'::jsonb);
  end if;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,
      'event_type',event.event_type,
      'month_start',event.month_start,
      'week_start',event.week_start,
      'shift_id',event.shift_id,
      'person_id',event.person_id,
      'actor_label',event.actor_label,
      'actor_role',event.actor_role,
      'payload',event.payload,
      'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into events_json
    from (
      select * from atlas_private.shift_events
      where month_start=p_month_start
         or week_start between grid_start and grid_end
      order by created_at desc
      limit 120
    ) event;
  end if;

  return jsonb_build_object(
    'version','atlas-shifts-month/0.1.0',
    'generated_at',pg_catalog.now(),
    'venue_date',(pg_catalog.now() at time zone settings_row.timezone)::date,
    'settings',jsonb_build_object(
      'timezone',settings_row.timezone,
      'live_publish_enabled',settings_row.live_publish_enabled,
      'confirmation_required',settings_row.confirmation_required,
      'metadata',settings_row.metadata
    ),
    'month',jsonb_build_object(
      'month_start',month_row.month_start,
      'month_end',month_end,
      'status',case when is_manager then month_row.status when publication_row.id is not null then 'published' else 'draft' end,
      'revision',case when is_manager then month_row.revision else coalesce(publication_row.revision,0) end,
      'has_unpublished_changes',case when is_manager then month_row.has_unpublished_changes else false end,
      'note',case when is_manager then month_row.note else publication_row.snapshot->>'note' end,
      'published_at',coalesce(publication_row.published_at,month_row.published_at),
      'published_by_label',coalesce(publication_row.published_by_label,month_row.published_by_label),
      'latest_publication',case when publication_row.id is null then null else jsonb_build_object(
        'id',publication_row.id,
        'revision',publication_row.revision,
        'shift_count',publication_row.shift_count,
        'planned_hours',publication_row.planned_hours,
        'published_at',publication_row.published_at,
        'published_by_label',publication_row.published_by_label
      ) end
    ),
    'people',people_json,
    'shifts',shifts_json,
    'availability',availability_json,
    'time_off',time_off_json,
    'responses',responses_json,
    'weeks',weeks_json,
    'events',events_json,
    'actor_person_id',actor_person_id,
    'permissions',jsonb_build_object(
      'can_manage_schedule',is_manager,
      'can_publish_month',is_manager,
      'can_respond_to_shifts',(actor_person_id is not null)
    ),
    'trust',jsonb_build_object(
      'planning_environment','isolated_branch',
      'production_shift_sync_enabled',false,
      'month_publish_to_team_enabled',true,
      'staff_visibility','latest_published_month_revision',
      'direct_browser_table_access',false,
      'audit_history_preserved',true
    )
  );
end;
$$;

-- This initial definition is intentionally replaced by the following migration,
-- which also republishes empty affected weeks so deletions are visible in weekly
-- staff views. Keeping the function here makes this migration independently valid.
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
begin
  raise exception 'Complete-month publishing requires migration 20260803225245';
end;
$$;

create or replace function public.atlas_shifts_month_snapshot(
  p_month_start date,p_actor_id uuid,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$ select atlas_private.shift_month_snapshot(p_month_start,p_actor_id,p_actor_role); $$;

create or replace function public.atlas_shifts_publish_month(
  p_month_start date,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$ select atlas_private.shift_publish_month(p_month_start,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

revoke execute on function public.atlas_shifts_month_snapshot(date,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_publish_month(date,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_shifts_month_snapshot(date,uuid,text) to service_role;
grant execute on function public.atlas_shifts_publish_month(date,text,uuid,text,text) to service_role;

comment on table atlas_private.shift_months is 'Private manager month-plan state. Staff visibility is controlled by immutable month publications.';
comment on table atlas_private.shift_month_publications is 'Immutable monthly schedule revisions published to active staff.';
comment on function public.atlas_shifts_month_snapshot(date,uuid,text) is 'Service-role-only monthly Shifts snapshot: managers receive drafts, staff receive only the latest published month revision.';
comment on function public.atlas_shifts_publish_month(date,text,uuid,text,text) is 'Service-role-only atomic month publication that also refreshes team-visible weekly revisions.';
