-- Checkpoint F — private weekly shift planning.
-- Draft schedules, availability, time off, publications and confirmations live
-- in the isolated branch. Production public.shifts remains unchanged while
-- live_publish_enabled is false.

create table if not exists atlas_private.shift_settings (
  setting_key text primary key,
  timezone text not null default 'Atlantic/Reykjavik',
  week_starts_on smallint not null default 1,
  live_publish_enabled boolean not null default false,
  confirmation_required boolean not null default true,
  default_break_minutes integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (week_starts_on between 0 and 6),
  check (default_break_minutes between 0 and 720),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.shift_people (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique,
  display_name text not null,
  email text,
  default_role text,
  active boolean not null default true,
  login_enabled boolean not null default false,
  source text not null default 'manual' check (source in ('profile','manual')),
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(display_name) between 1 and 160),
  check (email is null or char_length(email) <= 320),
  check (default_role is null or char_length(default_role) <= 120),
  check ((source='profile' and profile_id is not null and login_enabled=true) or source='manual')
);

create table if not exists atlas_private.shift_weeks (
  week_start date primary key,
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
  check (extract(isodow from week_start)=1),
  check (note is null or char_length(note) <= 3000)
);

create table if not exists atlas_private.shift_entries (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references atlas_private.shift_weeks(week_start) on delete cascade,
  person_id uuid not null references atlas_private.shift_people(id) on delete restrict,
  role_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  break_minutes integer not null default 0,
  note text,
  source text not null default 'manual' check (source in ('manual','copied','imported')),
  active boolean not null default true,
  last_published_revision integer,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at-starts_at <= interval '24 hours'),
  check (break_minutes between 0 and 720),
  check ((extract(epoch from (ends_at-starts_at))/60) > break_minutes),
  check (role_name is null or char_length(role_name) <= 120),
  check (note is null or char_length(note) <= 3000)
);

create table if not exists atlas_private.shift_publications (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references atlas_private.shift_weeks(week_start) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null,
  shift_count integer not null,
  planned_hours numeric(10,2) not null,
  published_by uuid,
  published_by_label text,
  published_at timestamptz not null default now(),
  unique (week_start,revision),
  check (jsonb_typeof(snapshot)='object'),
  check (shift_count >= 0),
  check (planned_hours >= 0)
);

create table if not exists atlas_private.shift_availability (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references atlas_private.shift_people(id) on delete cascade,
  weekday smallint not null,
  available_from time,
  available_to time,
  unavailable boolean not null default false,
  note text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (person_id,weekday),
  check (weekday between 0 and 6),
  check (note is null or char_length(note) <= 2000),
  check (not unavailable or (available_from is null and available_to is null))
);

create table if not exists atlas_private.shift_time_off (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references atlas_private.shift_people(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  request_type text not null default 'unavailable' check (request_type in ('unavailable','vacation','sick','other')),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  note text,
  manager_note text,
  requested_by uuid,
  requested_by_label text,
  decided_by uuid,
  decided_by_label text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (ends_on-starts_on <= 366),
  check (note is null or char_length(note) <= 3000),
  check (manager_note is null or char_length(manager_note) <= 3000)
);

create table if not exists atlas_private.shift_responses (
  shift_id uuid not null references atlas_private.shift_entries(id) on delete cascade,
  person_id uuid not null references atlas_private.shift_people(id) on delete cascade,
  response text not null default 'pending' check (response in ('pending','confirmed','change_requested','declined')),
  note text,
  responded_at timestamptz,
  manager_status text not null default 'none' check (manager_status in ('none','open','resolved','rejected')),
  manager_note text,
  decided_by uuid,
  decided_by_label text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shift_id,person_id),
  check (note is null or char_length(note) <= 3000),
  check (manager_note is null or char_length(manager_note) <= 3000)
);

create table if not exists atlas_private.shift_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'profiles_synced','person_created','person_updated','shift_created','shift_updated','shift_cancelled',
    'week_copied','week_published','availability_updated','time_off_requested','time_off_decided',
    'shift_response_updated','shift_response_decided'
  )),
  week_start date,
  shift_id uuid references atlas_private.shift_entries(id) on delete set null,
  person_id uuid references atlas_private.shift_people(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

create unique index if not exists shift_people_email_uidx on atlas_private.shift_people(lower(email)) where email is not null and active=true;
create index if not exists shift_people_active_name_idx on atlas_private.shift_people(active,display_name);
create index if not exists shift_entries_week_start_idx on atlas_private.shift_entries(week_start,starts_at) where active=true;
create index if not exists shift_entries_person_time_idx on atlas_private.shift_entries(person_id,starts_at,ends_at) where active=true;
create index if not exists shift_publications_latest_idx on atlas_private.shift_publications(week_start,revision desc);
create index if not exists shift_availability_person_idx on atlas_private.shift_availability(person_id,weekday);
create index if not exists shift_time_off_person_dates_idx on atlas_private.shift_time_off(person_id,starts_on,ends_on,status);
create index if not exists shift_time_off_pending_idx on atlas_private.shift_time_off(status,starts_on) where status='pending';
create index if not exists shift_responses_person_idx on atlas_private.shift_responses(person_id,response,updated_at desc);
create index if not exists shift_responses_open_idx on atlas_private.shift_responses(manager_status,updated_at desc) where manager_status='open';
create index if not exists shift_events_week_created_idx on atlas_private.shift_events(week_start,created_at desc) where week_start is not null;
create index if not exists shift_events_person_created_idx on atlas_private.shift_events(person_id,created_at desc) where person_id is not null;

alter table atlas_private.shift_settings enable row level security;
alter table atlas_private.shift_people enable row level security;
alter table atlas_private.shift_weeks enable row level security;
alter table atlas_private.shift_entries enable row level security;
alter table atlas_private.shift_publications enable row level security;
alter table atlas_private.shift_availability enable row level security;
alter table atlas_private.shift_time_off enable row level security;
alter table atlas_private.shift_responses enable row level security;
alter table atlas_private.shift_events enable row level security;

drop policy if exists "service role manages shift settings" on atlas_private.shift_settings;
create policy "service role manages shift settings" on atlas_private.shift_settings for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift people" on atlas_private.shift_people;
create policy "service role manages shift people" on atlas_private.shift_people for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift weeks" on atlas_private.shift_weeks;
create policy "service role manages shift weeks" on atlas_private.shift_weeks for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift entries" on atlas_private.shift_entries;
create policy "service role manages shift entries" on atlas_private.shift_entries for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift publications" on atlas_private.shift_publications;
create policy "service role manages shift publications" on atlas_private.shift_publications for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift availability" on atlas_private.shift_availability;
create policy "service role manages shift availability" on atlas_private.shift_availability for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift time off" on atlas_private.shift_time_off;
create policy "service role manages shift time off" on atlas_private.shift_time_off for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift responses" on atlas_private.shift_responses;
create policy "service role manages shift responses" on atlas_private.shift_responses for all to service_role using (true) with check (true);
drop policy if exists "service role manages shift events" on atlas_private.shift_events;
create policy "service role manages shift events" on atlas_private.shift_events for all to service_role using (true) with check (true);

revoke all on atlas_private.shift_settings from public,anon,authenticated;
revoke all on atlas_private.shift_people from public,anon,authenticated;
revoke all on atlas_private.shift_weeks from public,anon,authenticated;
revoke all on atlas_private.shift_entries from public,anon,authenticated;
revoke all on atlas_private.shift_publications from public,anon,authenticated;
revoke all on atlas_private.shift_availability from public,anon,authenticated;
revoke all on atlas_private.shift_time_off from public,anon,authenticated;
revoke all on atlas_private.shift_responses from public,anon,authenticated;
revoke all on atlas_private.shift_events from public,anon,authenticated;
grant all on atlas_private.shift_settings to service_role;
grant all on atlas_private.shift_people to service_role;
grant all on atlas_private.shift_weeks to service_role;
grant all on atlas_private.shift_entries to service_role;
grant all on atlas_private.shift_publications to service_role;
grant all on atlas_private.shift_availability to service_role;
grant all on atlas_private.shift_time_off to service_role;
grant all on atlas_private.shift_responses to service_role;
grant all on atlas_private.shift_events to service_role;

drop trigger if exists shift_settings_touch on atlas_private.shift_settings;
create trigger shift_settings_touch before update on atlas_private.shift_settings for each row execute function atlas_private.touch_updated_at();
drop trigger if exists shift_people_touch on atlas_private.shift_people;
create trigger shift_people_touch before update on atlas_private.shift_people for each row execute function atlas_private.touch_updated_at();
drop trigger if exists shift_weeks_touch on atlas_private.shift_weeks;
create trigger shift_weeks_touch before update on atlas_private.shift_weeks for each row execute function atlas_private.touch_updated_at();
drop trigger if exists shift_entries_touch on atlas_private.shift_entries;
create trigger shift_entries_touch before update on atlas_private.shift_entries for each row execute function atlas_private.touch_updated_at();
drop trigger if exists shift_availability_touch on atlas_private.shift_availability;
create trigger shift_availability_touch before update on atlas_private.shift_availability for each row execute function atlas_private.touch_updated_at();
drop trigger if exists shift_time_off_touch on atlas_private.shift_time_off;
create trigger shift_time_off_touch before update on atlas_private.shift_time_off for each row execute function atlas_private.touch_updated_at();
drop trigger if exists shift_responses_touch on atlas_private.shift_responses;
create trigger shift_responses_touch before update on atlas_private.shift_responses for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.shift_settings (
  setting_key,timezone,week_starts_on,live_publish_enabled,confirmation_required,default_break_minutes,metadata
) values (
  'va','Atlantic/Reykjavik',1,false,true,0,
  jsonb_build_object(
    'checkpoint','F',
    'planning_mode','isolated_branch',
    'publish_to_team_enabled',true,
    'production_shift_sync_enabled',false,
    'labour_cost_state','not_configured'
  )
)
on conflict (setting_key) do update set
  timezone=excluded.timezone,
  week_starts_on=excluded.week_starts_on,
  live_publish_enabled=false,
  confirmation_required=excluded.confirmation_required,
  metadata=excluded.metadata,
  updated_at=now();

create or replace function atlas_private.shift_normalize_week(p_date date)
returns date language sql immutable security invoker set search_path='' as $$
  select (p_date - (extract(isodow from p_date)::integer - 1))::date;
$$;

create or replace function atlas_private.shift_ensure_week(
  p_week_start date,p_actor_id uuid,p_actor_label text
)
returns atlas_private.shift_weeks
language plpgsql volatile security invoker set search_path='' as $$
declare week_row atlas_private.shift_weeks;
begin
  if p_week_start is null or extract(isodow from p_week_start)<>1 then raise exception 'Week start must be a Monday'; end if;
  insert into atlas_private.shift_weeks (week_start,created_by,created_by_label)
  values (p_week_start,p_actor_id,p_actor_label)
  on conflict (week_start) do nothing;
  select * into week_row from atlas_private.shift_weeks where week_start=p_week_start;
  return week_row;
end;
$$;

create or replace function atlas_private.shift_sync_profiles(
  p_profiles jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns bigint language plpgsql volatile security invoker set search_path='' as $$
declare changed_count bigint:=0;
begin
  insert into atlas_private.shift_people (
    id,profile_id,display_name,email,default_role,active,login_enabled,source,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select profile.id,profile.id,
    coalesce(nullif(trim(profile.display_name),''),nullif(split_part(coalesce(profile.email,''),'@',1),''),'Team member'),
    nullif(trim(profile.email),''),
    case profile.role when 'admin' then 'Manager' when 'manager' then 'Manager' when 'bartender' then 'Bartender' else 'Team' end,
    coalesce(profile.active,false),true,'profile',p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
    id uuid,email text,display_name text,role text,active boolean
  )
  where profile.id is not null
  on conflict (id) do update set
    profile_id=excluded.profile_id,
    display_name=excluded.display_name,
    email=excluded.email,
    default_role=excluded.default_role,
    active=excluded.active,
    login_enabled=true,
    source='profile',
    updated_by=p_actor_id,
    updated_by_label=p_actor_label,
    updated_at=pg_catalog.now();
  get diagnostics changed_count=row_count;

  insert into atlas_private.shift_events (event_type,actor_id,actor_label,actor_role,payload)
  values ('profiles_synced',p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('changed_count',changed_count));
  return changed_count;
end;
$$;

create or replace function atlas_private.shift_workspace_snapshot(
  p_week_start date,p_actor_id uuid,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  settings_row atlas_private.shift_settings;
  week_row atlas_private.shift_weeks;
  publication_row atlas_private.shift_publications;
  is_manager boolean := p_actor_role in ('admin','manager');
  actor_person_id uuid;
  people_json jsonb:='[]'::jsonb;
  shifts_json jsonb:='[]'::jsonb;
  availability_json jsonb:='[]'::jsonb;
  time_off_json jsonb:='[]'::jsonb;
  responses_json jsonb:='[]'::jsonb;
  events_json jsonb:='[]'::jsonb;
begin
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  week_row := atlas_private.shift_ensure_week(p_week_start,p_actor_id,null);
  select id into actor_person_id from atlas_private.shift_people where profile_id=p_actor_id limit 1;
  select * into publication_row from atlas_private.shift_publications where week_start=p_week_start order by revision desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',person.id,'profile_id',person.profile_id,'display_name',person.display_name,
    'email',person.email,'default_role',person.default_role,'active',person.active,
    'login_enabled',person.login_enabled,'source',person.source,
    'can_edit_availability',(is_manager or person.profile_id=p_actor_id)
  ) order by person.active desc,person.display_name),'[]'::jsonb)
  into people_json
  from atlas_private.shift_people person
  where is_manager or person.active=true or person.profile_id=p_actor_id;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',shift.id,'week_start',shift.week_start,'person_id',shift.person_id,
      'person_name',person.display_name,'profile_id',person.profile_id,
      'login_enabled',person.login_enabled,'role_name',shift.role_name,
      'starts_at',shift.starts_at,'ends_at',shift.ends_at,
      'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'break_minutes',shift.break_minutes,'note',shift.note,'source',shift.source,
      'active',shift.active,'updated_at',shift.updated_at,
      'last_published_revision',shift.last_published_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb)
    into shifts_json
    from atlas_private.shift_entries shift
    join atlas_private.shift_people person on person.id=shift.person_id
    where shift.week_start=p_week_start and shift.active=true;
  elsif publication_row.id is not null then
    shifts_json := coalesce(publication_row.snapshot->'shifts','[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',availability.id,'person_id',availability.person_id,'weekday',availability.weekday,
    'available_from',availability.available_from,'available_to',availability.available_to,
    'unavailable',availability.unavailable,'note',availability.note,
    'updated_at',availability.updated_at
  ) order by availability.person_id,availability.weekday),'[]'::jsonb)
  into availability_json
  from atlas_private.shift_availability availability
  join atlas_private.shift_people person on person.id=availability.person_id
  where is_manager or person.profile_id=p_actor_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',request.id,'person_id',request.person_id,'person_name',person.display_name,
    'starts_on',request.starts_on,'ends_on',request.ends_on,
    'request_type',request.request_type,'status',request.status,'note',request.note,
    'manager_note',case when is_manager then request.manager_note else null end,
    'requested_by_label',request.requested_by_label,
    'decided_by_label',case when is_manager then request.decided_by_label else null end,
    'created_at',request.created_at,'updated_at',request.updated_at
  ) order by request.starts_on,person.display_name),'[]'::jsonb)
  into time_off_json
  from atlas_private.shift_time_off request
  join atlas_private.shift_people person on person.id=request.person_id
  where request.ends_on>=p_week_start-interval '14 days'
    and request.starts_on<=p_week_start+interval '42 days'
    and (is_manager or person.profile_id=p_actor_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id',response.shift_id,'person_id',response.person_id,
    'response',response.response,'note',response.note,'responded_at',response.responded_at,
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
  where shift.week_start=p_week_start and (is_manager or person.profile_id=p_actor_id);

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,'event_type',event.event_type,'week_start',event.week_start,
      'shift_id',event.shift_id,'person_id',event.person_id,
      'actor_label',event.actor_label,'actor_role',event.actor_role,
      'payload',event.payload,'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into events_json
    from (
      select * from atlas_private.shift_events
      where week_start=p_week_start or week_start is null
      order by created_at desc limit 80
    ) event;
  end if;

  return jsonb_build_object(
    'version','atlas-shifts/0.1.0',
    'generated_at',pg_catalog.now(),
    'venue_date',(pg_catalog.now() at time zone settings_row.timezone)::date,
    'settings',jsonb_build_object(
      'timezone',settings_row.timezone,
      'week_starts_on',settings_row.week_starts_on,
      'live_publish_enabled',settings_row.live_publish_enabled,
      'confirmation_required',settings_row.confirmation_required,
      'default_break_minutes',settings_row.default_break_minutes,
      'metadata',settings_row.metadata
    ),
    'week',jsonb_build_object(
      'week_start',week_row.week_start,'status',week_row.status,'revision',week_row.revision,
      'has_unpublished_changes',week_row.has_unpublished_changes,'note',week_row.note,
      'published_at',week_row.published_at,'published_by_label',week_row.published_by_label,
      'latest_publication',case when publication_row.id is null then null else jsonb_build_object(
        'id',publication_row.id,'revision',publication_row.revision,
        'shift_count',publication_row.shift_count,'planned_hours',publication_row.planned_hours,
        'published_at',publication_row.published_at,'published_by_label',publication_row.published_by_label
      ) end
    ),
    'people',people_json,'shifts',shifts_json,'availability',availability_json,
    'time_off',time_off_json,'responses',responses_json,'events',events_json,
    'actor_person_id',actor_person_id,
    'permissions',jsonb_build_object(
      'can_manage_schedule',is_manager,'can_add_people',is_manager,
      'can_publish_week',is_manager,'can_manage_all_availability',is_manager,
      'can_decide_time_off',is_manager,'can_respond_to_shifts',(actor_person_id is not null)
    ),
    'trust',jsonb_build_object(
      'planning_environment','isolated_branch',
      'production_shift_sync_enabled',settings_row.live_publish_enabled,
      'publish_to_team_enabled',true,'direct_browser_table_access',false,
      'audit_history_preserved',true,'labour_costs_configured',false,
      'coverage_targets_configured',false
    )
  );
end;
$$;

create or replace function atlas_private.shift_person_create(
  p_display_name text,p_email text,p_default_role text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare person_row atlas_private.shift_people;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can add schedule-only people'; end if;
  if nullif(trim(coalesce(p_display_name,'')),'') is null then raise exception 'Display name is required'; end if;
  insert into atlas_private.shift_people (
    display_name,email,default_role,active,login_enabled,source,
    created_by,created_by_label,updated_by,updated_by_label
  ) values (
    trim(p_display_name),nullif(trim(coalesce(p_email,'')),''),
    nullif(trim(coalesce(p_default_role,'')),''),true,false,'manual',
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  ) returning * into person_row;
  insert into atlas_private.shift_events (
    event_type,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'person_created',person_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('display_name',person_row.display_name)
  );
  return to_jsonb(person_row);
end;
$$;

create or replace function atlas_private.shift_save(
  p_shift_id uuid,p_week_start date,p_person_id uuid,p_role_name text,
  p_starts_local timestamp,p_ends_local timestamp,p_break_minutes integer,p_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  settings_row atlas_private.shift_settings;
  shift_row atlas_private.shift_entries;
  starts_utc timestamptz;
  ends_utc timestamptz;
  event_name text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can create or edit shifts'; end if;
  perform atlas_private.shift_ensure_week(p_week_start,p_actor_id,p_actor_label);
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  if not exists (select 1 from atlas_private.shift_people where id=p_person_id and active=true) then raise exception 'The selected team member is inactive or missing'; end if;
  if p_starts_local is null or p_ends_local is null then raise exception 'Start and end times are required'; end if;
  if atlas_private.shift_normalize_week(p_starts_local::date)<>p_week_start then raise exception 'Shift start is outside the selected week'; end if;
  if p_ends_local<=p_starts_local then raise exception 'Shift end must be after shift start'; end if;
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
    update atlas_private.shift_entries set
      person_id=p_person_id,
      role_name=nullif(trim(coalesce(p_role_name,'')),''),
      starts_at=starts_utc,
      ends_at=ends_utc,
      break_minutes=coalesce(p_break_minutes,0),
      note=nullif(trim(coalesce(p_note,'')),''),
      active=true,
      updated_by=p_actor_id,
      updated_by_label=p_actor_label
    where id=p_shift_id and week_start=p_week_start
    returning * into shift_row;
    if not found then raise exception 'Shift not found in the selected week'; end if;
    event_name := 'shift_updated';
  end if;

  update atlas_private.shift_weeks
  set has_unpublished_changes=true,status=case when status='archived' then 'draft' else status end
  where week_start=p_week_start;

  insert into atlas_private.shift_events (
    event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    event_name,p_week_start,shift_row.id,shift_row.person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('starts_at',shift_row.starts_at,'ends_at',shift_row.ends_at,'role_name',shift_row.role_name)
  );
  return to_jsonb(shift_row);
end;
$$;

create or replace function atlas_private.shift_cancel(
  p_shift_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare shift_row atlas_private.shift_entries;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can remove shifts'; end if;
  update atlas_private.shift_entries
  set active=false,updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=p_shift_id and active=true
  returning * into shift_row;
  if not found then raise exception 'Shift not found'; end if;
  update atlas_private.shift_weeks set has_unpublished_changes=true where week_start=shift_row.week_start;
  insert into atlas_private.shift_events (
    event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'shift_cancelled',shift_row.week_start,shift_row.id,shift_row.person_id,
    p_actor_id,p_actor_label,p_actor_role,'{}'::jsonb
  );
  return to_jsonb(shift_row);
end;
$$;

create or replace function atlas_private.shift_publish_week(
  p_week_start date,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  settings_row atlas_private.shift_settings;
  week_row atlas_private.shift_weeks;
  next_revision integer;
  shift_count integer;
  planned_hours numeric(10,2);
  shifts_json jsonb;
  publication_row atlas_private.shift_publications;
  overlap_count bigint;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish schedules'; end if;
  select * into settings_row from atlas_private.shift_settings where setting_key='va';
  week_row := atlas_private.shift_ensure_week(p_week_start,p_actor_id,p_actor_label);
  select count(*) into shift_count from atlas_private.shift_entries where week_start=p_week_start and active=true;
  if shift_count=0 then raise exception 'Add at least one shift before publishing'; end if;

  select count(*) into overlap_count
  from atlas_private.shift_entries first_shift
  join atlas_private.shift_entries second_shift
    on first_shift.person_id=second_shift.person_id
   and first_shift.id<second_shift.id
   and tstzrange(first_shift.starts_at,first_shift.ends_at,'[)') && tstzrange(second_shift.starts_at,second_shift.ends_at,'[)')
  where first_shift.week_start=p_week_start and second_shift.week_start=p_week_start
    and first_shift.active=true and second_shift.active=true;
  if overlap_count>0 then raise exception 'Resolve overlapping shifts before publishing'; end if;

  next_revision := week_row.revision+1;
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',shift.id,'week_start',shift.week_start,'person_id',shift.person_id,
      'person_name',person.display_name,'profile_id',person.profile_id,
      'login_enabled',person.login_enabled,'role_name',shift.role_name,
      'starts_at',shift.starts_at,'ends_at',shift.ends_at,
      'starts_local',to_char(shift.starts_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_local',to_char(shift.ends_at at time zone settings_row.timezone,'YYYY-MM-DD"T"HH24:MI:SS'),
      'break_minutes',shift.break_minutes,'note',shift.note,'active',true,
      'publication_revision',next_revision
    ) order by shift.starts_at,person.display_name),'[]'::jsonb),
    coalesce(round(sum((extract(epoch from (shift.ends_at-shift.starts_at))/3600)-(shift.break_minutes::numeric/60)),2),0)
  into shifts_json,planned_hours
  from atlas_private.shift_entries shift
  join atlas_private.shift_people person on person.id=shift.person_id
  where shift.week_start=p_week_start and shift.active=true;

  insert into atlas_private.shift_publications (
    week_start,revision,snapshot,shift_count,planned_hours,published_by,published_by_label
  ) values (
    p_week_start,next_revision,
    jsonb_build_object('week_start',p_week_start,'revision',next_revision,'shifts',shifts_json,'note',nullif(trim(coalesce(p_note,'')),'')),
    shift_count,planned_hours,p_actor_id,p_actor_label
  ) returning * into publication_row;

  update atlas_private.shift_weeks set
    status='published',revision=next_revision,has_unpublished_changes=false,
    note=nullif(trim(coalesce(p_note,'')),''),published_at=publication_row.published_at,
    published_by=p_actor_id,published_by_label=p_actor_label
  where week_start=p_week_start;

  update atlas_private.shift_entries
  set last_published_revision=next_revision
  where week_start=p_week_start and active=true;

  insert into atlas_private.shift_responses (
    shift_id,person_id,response,manager_status
  )
  select shift.id,shift.person_id,'pending','none'
  from atlas_private.shift_entries shift
  join atlas_private.shift_people person on person.id=shift.person_id
  where shift.week_start=p_week_start and shift.active=true
    and person.login_enabled=true and person.profile_id is not null
  on conflict (shift_id,person_id) do update set
    response='pending',note=null,responded_at=null,manager_status='none',manager_note=null,
    decided_by=null,decided_by_label=null,decided_at=null,updated_at=pg_catalog.now();

  system_body := 'Schedule published' || E'\n'
    || 'Week of ' || to_char(p_week_start,'DD Mon YYYY') || ' · ' || shift_count
    || ' shifts · ' || planned_hours || ' planned hours.' || E'\n'
    || 'Please review and confirm your assigned shifts.';
  begin
    perform atlas_private.team_messages_post_system(
      'announcements','shift-week-published:'||p_week_start::text||':'||next_revision::text,
      system_body,'shift',p_week_start::text,
      'Week of '||to_char(p_week_start,'DD Mon YYYY'),'shifts',
      jsonb_build_object('week_start',p_week_start,'revision',next_revision,'shift_count',shift_count,'planned_hours',planned_hours)
    );
  exception when others then null;
  end;

  insert into atlas_private.shift_events (
    event_type,week_start,actor_id,actor_label,actor_role,payload
  ) values (
    'week_published',p_week_start,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('revision',next_revision,'shift_count',shift_count,'planned_hours',planned_hours)
  );
  return to_jsonb(publication_row);
end;
$$;

create or replace function atlas_private.shift_save_availability(
  p_person_id uuid,p_weekday smallint,p_available_from time,p_available_to time,
  p_unavailable boolean,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  person_row atlas_private.shift_people;
  availability_row atlas_private.shift_availability;
begin
  if p_weekday not between 0 and 6 then raise exception 'Weekday is invalid'; end if;
  select * into person_row from atlas_private.shift_people where id=p_person_id;
  if not found then raise exception 'Team member not found'; end if;
  if p_actor_role not in ('admin','manager') and person_row.profile_id<>p_actor_id then raise exception 'Staff may edit only their own availability'; end if;

  insert into atlas_private.shift_availability (
    person_id,weekday,available_from,available_to,unavailable,note,updated_by,updated_by_label
  ) values (
    p_person_id,p_weekday,
    case when coalesce(p_unavailable,false) then null else p_available_from end,
    case when coalesce(p_unavailable,false) then null else p_available_to end,
    coalesce(p_unavailable,false),nullif(trim(coalesce(p_note,'')),''),p_actor_id,p_actor_label
  )
  on conflict (person_id,weekday) do update set
    available_from=excluded.available_from,available_to=excluded.available_to,
    unavailable=excluded.unavailable,note=excluded.note,
    updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  returning * into availability_row;

  insert into atlas_private.shift_events (
    event_type,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'availability_updated',p_person_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('weekday',p_weekday,'unavailable',availability_row.unavailable)
  );
  return to_jsonb(availability_row);
end;
$$;

create or replace function atlas_private.shift_respond(
  p_shift_id uuid,p_response text,p_note text,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  shift_row atlas_private.shift_entries;
  person_row atlas_private.shift_people;
  week_row atlas_private.shift_weeks;
  response_row atlas_private.shift_responses;
begin
  if p_response not in ('confirmed','change_requested','declined') then raise exception 'Shift response is invalid'; end if;
  if p_response<>'confirmed' and nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'A note is required when requesting a change or declining'; end if;
  select * into shift_row from atlas_private.shift_entries where id=p_shift_id and active=true;
  if not found then raise exception 'Shift not found'; end if;
  select * into person_row from atlas_private.shift_people where id=shift_row.person_id;
  if person_row.profile_id<>p_actor_id then raise exception 'You can respond only to your own shift'; end if;
  select * into week_row from atlas_private.shift_weeks where week_start=shift_row.week_start;
  if week_row.status<>'published' or shift_row.last_published_revision<>week_row.revision then raise exception 'This shift is not part of the latest published schedule'; end if;

  insert into atlas_private.shift_responses (
    shift_id,person_id,response,note,responded_at,manager_status
  ) values (
    shift_row.id,shift_row.person_id,p_response,nullif(trim(coalesce(p_note,'')),''),
    pg_catalog.now(),case when p_response='confirmed' then 'none' else 'open' end
  )
  on conflict (shift_id,person_id) do update set
    response=excluded.response,note=excluded.note,responded_at=excluded.responded_at,
    manager_status=excluded.manager_status,manager_note=null,decided_by=null,
    decided_by_label=null,decided_at=null,updated_at=pg_catalog.now()
  returning * into response_row;

  insert into atlas_private.shift_events (
    event_type,week_start,shift_id,person_id,actor_id,actor_label,actor_role,payload
  ) values (
    'shift_response_updated',shift_row.week_start,shift_row.id,shift_row.person_id,
    p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('response',p_response)
  );
  return to_jsonb(response_row);
end;
$$;

create or replace function public.atlas_shifts_sync_profiles(
  p_profiles jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns bigint language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_sync_profiles(p_profiles,p_actor_id,p_actor_label,p_actor_role);
$$;
create or replace function public.atlas_shifts_snapshot(
  p_week_start date,p_actor_id uuid,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_workspace_snapshot(p_week_start,p_actor_id,p_actor_role);
$$;
create or replace function public.atlas_shifts_create_person(
  p_display_name text,p_email text,p_default_role text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_person_create(p_display_name,p_email,p_default_role,p_actor_id,p_actor_label,p_actor_role);
$$;
create or replace function public.atlas_shifts_save_shift(
  p_shift_id uuid,p_week_start date,p_person_id uuid,p_role_name text,p_starts_local timestamp,
  p_ends_local timestamp,p_break_minutes integer,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_save(p_shift_id,p_week_start,p_person_id,p_role_name,p_starts_local,p_ends_local,p_break_minutes,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;
create or replace function public.atlas_shifts_cancel_shift(
  p_shift_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_cancel(p_shift_id,p_actor_id,p_actor_label,p_actor_role);
$$;
create or replace function public.atlas_shifts_publish_week(
  p_week_start date,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_publish_week(p_week_start,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;
create or replace function public.atlas_shifts_save_availability(
  p_person_id uuid,p_weekday smallint,p_available_from time,p_available_to time,p_unavailable boolean,
  p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_save_availability(p_person_id,p_weekday,p_available_from,p_available_to,p_unavailable,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;
create or replace function public.atlas_shifts_respond(
  p_shift_id uuid,p_response text,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb language sql volatile security invoker set search_path='' as $$
  select atlas_private.shift_respond(p_shift_id,p_response,p_note,p_actor_id,p_actor_label,p_actor_role);
$$;

revoke execute on function public.atlas_shifts_sync_profiles(jsonb,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_snapshot(date,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_create_person(text,text,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_save_shift(uuid,date,uuid,text,timestamp,timestamp,integer,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_cancel_shift(uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_publish_week(date,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_save_availability(uuid,smallint,time,time,boolean,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_shifts_respond(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_shifts_sync_profiles(jsonb,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_snapshot(date,uuid,text) to service_role;
grant execute on function public.atlas_shifts_create_person(text,text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_save_shift(uuid,date,uuid,text,timestamp,timestamp,integer,text,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_cancel_shift(uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_publish_week(date,text,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_save_availability(uuid,smallint,time,time,boolean,text,uuid,text,text) to service_role;
grant execute on function public.atlas_shifts_respond(uuid,text,text,uuid,text,text) to service_role;

comment on table atlas_private.shift_entries is 'Private Checkpoint F schedule drafts. Production public.shifts is not changed while live publish is disabled.';
comment on table atlas_private.shift_publications is 'Immutable team-visible weekly schedule snapshots and revision history.';
comment on function public.atlas_shifts_snapshot(date,uuid,text) is 'Service-role-only Shifts workspace snapshot after production-profile authorization.';
