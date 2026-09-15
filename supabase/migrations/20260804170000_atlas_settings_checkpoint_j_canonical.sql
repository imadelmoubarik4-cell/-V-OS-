-- Checkpoint J Settings — canonical replayable schema and RPC contract.
--
-- The earlier 162529 and 163127 files are migration-history anchors for SQL that
-- was deployed before its source was retained. This migration recreates the
-- complete Settings model before Checkpoint K reads settings_sections, making a
-- clean branch reset deterministic.

create schema if not exists atlas_private;
revoke all on schema atlas_private from public, anon, authenticated;
grant usage on schema atlas_private to service_role;

create table if not exists atlas_private.settings_sections (
  section_key text primary key check (section_key in (
    'venue','operations','inventory','temperature','cleaning',
    'marketing','brain','security','appearance','modules'
  )),
  label text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active','review','disabled')),
  settings_value jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings_value)='object'),
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.settings_business_hours (
  weekday smallint primary key check (weekday between 0 and 6),
  day_label text not null,
  is_open boolean not null default true,
  open_time time without time zone,
  close_time time without time zone,
  close_next_day boolean not null default false,
  kitchen_close_time time without time zone,
  kitchen_close_next_day boolean not null default false,
  last_order_time time without time zone,
  last_order_next_day boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.settings_offers (
  id uuid primary key default gen_random_uuid(),
  offer_key text not null unique,
  name text not null,
  description text,
  active boolean not null default true,
  days smallint[] not null default '{}'::smallint[],
  start_time time without time zone not null,
  end_time time without time zone not null,
  end_next_day boolean not null default false,
  pricing jsonb not null default '{}'::jsonb check (jsonb_typeof(pricing)='object'),
  booking_url text,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.settings_roles (
  role_key text primary key check (role_key in ('admin','manager','bartender','viewer')),
  label text not null,
  description text not null default '',
  permissions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(permissions)='object'),
  protected boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.settings_notification_policies (
  event_key text primary key,
  category text not null,
  label text not null,
  enabled boolean not null default true,
  channels jsonb not null default '{"in_app":true,"browser":false,"email":false}'::jsonb
    check (jsonb_typeof(channels)='object'),
  target_roles text[] not null default array['admin','manager']::text[],
  reminder_minutes integer[] not null default '{}'::integer[],
  escalation_minutes integer,
  manager_approval_required boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.settings_user_preferences (
  user_id uuid primary key,
  theme text not null default 'dark' check (theme in ('dark','light','system')),
  density text not null default 'comfortable' check (density in ('comfortable','compact')),
  language text not null default 'en' check (language in ('en','is')),
  start_view text not null default 'briefing',
  timezone text not null default 'Atlantic/Reykjavik',
  reduce_motion boolean not null default false,
  browser_notifications boolean not null default false,
  email_notifications boolean not null default false,
  preferences jsonb not null default '{}'::jsonb
    check (jsonb_typeof(preferences)='object'),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.settings_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text not null,
  entity_key text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

create index if not exists settings_events_created_idx
  on atlas_private.settings_events(created_at desc);
create index if not exists settings_events_entity_idx
  on atlas_private.settings_events(entity_type,entity_key,created_at desc);

alter table atlas_private.settings_sections enable row level security;
alter table atlas_private.settings_business_hours enable row level security;
alter table atlas_private.settings_offers enable row level security;
alter table atlas_private.settings_roles enable row level security;
alter table atlas_private.settings_notification_policies enable row level security;
alter table atlas_private.settings_user_preferences enable row level security;
alter table atlas_private.settings_events enable row level security;

do $settings_private_grants$
declare
  table_name text;
begin
  foreach table_name in array array[
    'settings_sections','settings_business_hours','settings_offers','settings_roles',
    'settings_notification_policies','settings_user_preferences','settings_events'
  ]
  loop
    execute format('revoke all on atlas_private.%I from public, anon, authenticated',table_name);
    execute format('grant all on atlas_private.%I to service_role',table_name);
    execute format('drop policy if exists %I on atlas_private.%I',table_name || '_service_only',table_name);
    execute format(
      'create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      table_name || '_service_only',table_name
    );
  end loop;
end
$settings_private_grants$;

create or replace function atlas_private.settings_assert_actor(
  p_actor_role text,
  p_manager_required boolean default false,
  p_admin_required boolean default false
)
returns void
language plpgsql
stable
security invoker
set search_path=''
as $function$
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'An active Atlas role is required';
  end if;
  if p_admin_required and p_actor_role <> 'admin' then
    raise exception 'Only administrators can change this Settings area';
  end if;
  if p_manager_required and p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can change organization Settings';
  end if;
end;
$function$;

create or replace function atlas_private.settings_assert_safe_json(p_value jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path=''
as $function$
begin
  if jsonb_typeof(coalesce(p_value,'{}'::jsonb)) <> 'object' then
    raise exception 'Settings values must be a JSON object';
  end if;
  if coalesce(p_value,'{}'::jsonb)::text ~* '"(password|secret|token|api[_ -]?key|service[_ -]?role|credential)"[[:space:]]*:' then
    raise exception 'Sensitive credentials cannot be stored in Atlas Settings';
  end if;
end;
$function$;

insert into atlas_private.settings_sections(section_key,label,description,status,settings_value)
values
  ('venue','Venue','Business identity, location, language and contact defaults.','active',
    '{"business_name":"VÁ","legal_name":"VÁ Bar","registration_number":"","location_label":"Hafnartorg Gallery","address_line":"","city":"Reykjavík","country_code":"IS","timezone":"Atlantic/Reykjavik","currency":"ISK","primary_language":"en","supported_languages":["en","is"],"email":"","phone":"","website":"","booking_url":""}'::jsonb),
  ('operations','Operations','Week, break, confirmation and service-mode defaults.','active',
    '{"week_starts_on":1,"default_break_minutes":30,"shift_confirmation_required":true,"service_mode_enabled":false,"last_order_minutes_before_close":30,"production_shift_sync_enabled":false}'::jsonb),
  ('inventory','Inventory','Stock thresholds, scanner behavior and review-only reorder guidance.','active',
    '{"low_stock_warning_enabled":true,"critical_stock_ratio":0.35,"variance_tolerance_percent":5,"waste_tolerance_percent":3,"automatic_reorder_suggestions":true,"automatic_reorder_execution":false,"barcode_gallery_enabled":true,"allow_multiple_barcodes":true,"staff_barcode_linking":false,"live_quantity_apply":false}'::jsonb),
  ('temperature','Temperature','Required logs, reminders, evidence and exception review.','active',
    '{"daily_log_required":true,"reminder_times":["10:00"],"escalation_minutes":60,"photo_required_on_exception":true,"corrective_action_required":true,"manager_review_on_exception":true,"retention_months":24}'::jsonb),
  ('cleaning','Cleaning','Routine evidence, overdue escalation and weekly schedule.','active',
    '{"photo_required":false,"comment_required_on_exception":true,"manager_review_on_exception":true,"overdue_escalation_minutes":60,"weekly_schedule":{"sunday":"Deep clean bar equipment","monday":"Deep clean storage","tuesday":"Deep clean guest areas"}}'::jsonb),
  ('marketing','Marketing','Drafting and approval rules without automatic publishing.','active',
    '{"brand_voice":"Warm, polished and welcoming VÁ hospitality.","approval_required":true,"automatic_publishing_enabled":false,"ai_caption_drafts_enabled":true,"default_story_frames":3,"analytics_ingestion_enabled":false}'::jsonb),
  ('brain','Atlas Brain','Evidence, learning and recommendation behavior.','active',
    '{"mode":"shadow","decision_memory_enabled":true,"purchase_learning_enabled":true,"menu_learning_enabled":true,"waste_learning_enabled":true,"forecast_learning_enabled":false,"explanation_level":"evidence","evidence_mode":"strict","automatic_execution_enabled":false}'::jsonb),
  ('security','Security','Administrative safeguards. Secrets are never stored here.','active',
    '{"session_timeout_minutes":480,"two_factor_required":true,"trusted_devices_enabled":false,"emergency_lockdown_enabled":false,"password_policy_managed_by_auth":true,"api_keys_visible":false,"production_sync_enabled":false,"destructive_actions_enabled":false}'::jsonb),
  ('appearance','Appearance','Default theme, density, language and motion preferences.','active',
    '{"theme":"dark","density":"comfortable","language":"en","date_format":"DD/MM/YYYY","time_format":"24h","start_view":"briefing","reduce_motion":false}'::jsonb),
  ('modules','Modules','Visible Atlas workspaces and release states.','active',
    '{"operations":true,"scanner":true,"messages":true,"marketing":true,"profiles":true,"shifts":true,"knowledge":true,"reports":true,"system":true,"settings":true,"reports_state":"preview","production_sync_enabled":false}'::jsonb)
on conflict (section_key) do nothing;

insert into atlas_private.settings_business_hours(
  weekday,day_label,is_open,open_time,close_time,close_next_day,
  kitchen_close_time,kitchen_close_next_day,last_order_time,last_order_next_day
)
values
  (0,'Sunday',true,'15:00','00:00',true,null,false,'23:30',false),
  (1,'Monday',true,'15:00','00:00',true,null,false,'23:30',false),
  (2,'Tuesday',true,'15:00','00:00',true,null,false,'23:30',false),
  (3,'Wednesday',true,'15:00','00:00',true,null,false,'23:30',false),
  (4,'Thursday',true,'15:00','00:00',true,null,false,'23:30',false),
  (5,'Friday',true,'15:00','03:00',true,null,false,'02:30',true),
  (6,'Saturday',true,'15:00','03:00',true,null,false,'02:30',true)
on conflict (weekday) do nothing;

insert into atlas_private.settings_offers(
  offer_key,name,description,active,days,start_time,end_time,end_next_day,pricing,booking_url
)
values
  ('daily-happy-hour','Daily Happy Hour','Daily VÁ Happy Hour window.',true,
    array[0,1,2,3,4,5,6]::smallint[],'15:00','18:00',false,'{}'::jsonb,null),
  ('late-happy-hour','Late Happy Hour','Late Happy Hour on Thursday and Saturday.',true,
    array[4,6]::smallint[],'22:00','00:00',true,'{}'::jsonb,null)
on conflict (offer_key) do nothing;

insert into atlas_private.settings_roles(role_key,label,description,permissions,protected)
values
  ('admin','Administrator','Full governance and security administration.',
    '{"inventory.view":true,"inventory.manage":true,"inventory.costs":true,"inventory.count":true,"inventory.publish_count":true,"recipes.view":true,"recipes.manage":true,"team.view":true,"team.manage":true,"reports.view":true,"settings.manage":true,"security.manage":true,"brain.review":true,"purchasing.review":true}'::jsonb,true),
  ('manager','Manager','Operational management, review and approval without administrator-only security changes.',
    '{"inventory.view":true,"inventory.manage":true,"inventory.costs":true,"inventory.count":true,"inventory.publish_count":true,"recipes.view":true,"recipes.manage":true,"team.view":true,"team.manage":true,"reports.view":true,"settings.manage":true,"security.manage":false,"brain.review":true,"purchasing.review":true}'::jsonb,false),
  ('bartender','Bartender','Daily operational access with commercial and publication boundaries.',
    '{"inventory.view":true,"inventory.manage":false,"inventory.costs":false,"inventory.count":true,"inventory.publish_count":false,"recipes.view":true,"recipes.manage":false,"team.view":true,"team.manage":false,"reports.view":false,"settings.manage":false,"security.manage":false,"brain.review":false,"purchasing.review":false}'::jsonb,false),
  ('viewer','Viewer','Read-only compatibility access.',
    '{"inventory.view":true,"inventory.manage":false,"inventory.costs":false,"inventory.count":false,"inventory.publish_count":false,"recipes.view":true,"recipes.manage":false,"team.view":true,"team.manage":false,"reports.view":false,"settings.manage":false,"security.manage":false,"brain.review":false,"purchasing.review":false}'::jsonb,false)
on conflict (role_key) do nothing;

insert into atlas_private.settings_notification_policies(
  event_key,category,label,enabled,channels,target_roles,reminder_minutes,
  escalation_minutes,manager_approval_required
)
values
  ('temperature.exception','Operations','Temperature exception',true,
    '{"in_app":true,"browser":true,"email":false}'::jsonb,array['admin','manager'],array[0],30,true),
  ('inventory.low_stock','Inventory','Low-stock review',true,
    '{"in_app":true,"browser":false,"email":false}'::jsonb,array['admin','manager'],array[0],null,false),
  ('stock_count.submitted','Inventory','Stock count submitted',true,
    '{"in_app":true,"browser":true,"email":false}'::jsonb,array['admin','manager'],array[0],120,true),
  ('shifts.published','People','Shift plan published',true,
    '{"in_app":true,"browser":true,"email":false}'::jsonb,array['admin','manager','bartender','viewer'],array[0],null,false),
  ('knowledge.required','Knowledge','Required reading assigned',true,
    '{"in_app":true,"browser":false,"email":false}'::jsonb,array['admin','manager','bartender','viewer'],array[1440,0],null,false)
on conflict (event_key) do nothing;

create or replace function atlas_private.settings_snapshot(
  p_profiles jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  profiles_value jsonb := case
    when jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))='array' then coalesce(p_profiles,'[]'::jsonb)
    else '[]'::jsonb
  end;
  result jsonb;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,false,false);
  if p_actor_id is null then raise exception 'Settings actor id is required'; end if;

  select jsonb_build_object(
    'version','atlas-settings/0.1.0',
    'generated_at',now(),
    'permissions',jsonb_build_object(
      'can_manage_organization',p_actor_role in ('admin','manager'),
      'can_manage_security',p_actor_role='admin'
    ),
    'trust',jsonb_build_object(
      'environment','isolated_branch',
      'production_sync_enabled',false,
      'destructive_actions_enabled',false,
      'automatic_social_publishing_enabled',false,
      'automatic_reorder_execution_enabled',false,
      'automatic_brain_execution_enabled',false,
      'secrets_returned',false
    ),
    'sections',coalesce((
      select jsonb_agg(jsonb_build_object(
        'section_key',section_row.section_key,
        'label',section_row.label,
        'description',section_row.description,
        'status',section_row.status,
        'value',section_row.settings_value,
        'version',section_row.version,
        'updated_by_label',section_row.updated_by_label,
        'updated_at',section_row.updated_at,
        'can_edit',case
          when section_row.section_key='security' then p_actor_role='admin'
          else p_actor_role in ('admin','manager')
        end
      ) order by array_position(array['venue','operations','inventory','temperature','cleaning','marketing','brain','security','appearance','modules'],section_row.section_key))
      from atlas_private.settings_sections section_row
    ),'[]'::jsonb),
    'business_hours',coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday',hours.weekday,'day_label',hours.day_label,'is_open',hours.is_open,
        'open_time',hours.open_time,'close_time',hours.close_time,
        'close_next_day',hours.close_next_day,
        'kitchen_close_time',hours.kitchen_close_time,
        'kitchen_close_next_day',hours.kitchen_close_next_day,
        'last_order_time',hours.last_order_time,
        'last_order_next_day',hours.last_order_next_day,
        'version',hours.version,'updated_at',hours.updated_at
      ) order by hours.weekday)
      from atlas_private.settings_business_hours hours
    ),'[]'::jsonb),
    'offers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',offer.id,'offer_key',offer.offer_key,'name',offer.name,
        'description',offer.description,'active',offer.active,'days',offer.days,
        'start_time',offer.start_time,'end_time',offer.end_time,
        'end_next_day',offer.end_next_day,'pricing',offer.pricing,
        'booking_url',offer.booking_url,'version',offer.version,
        'updated_at',offer.updated_at,'can_edit',p_actor_role in ('admin','manager')
      ) order by offer.active desc,offer.start_time,offer.name)
      from atlas_private.settings_offers offer
    ),'[]'::jsonb),
    'roles',coalesce((
      select jsonb_agg(jsonb_build_object(
        'role_key',role_row.role_key,'label',role_row.label,
        'description',role_row.description,'permissions',role_row.permissions,
        'protected',role_row.protected,'version',role_row.version,
        'updated_at',role_row.updated_at,
        'can_edit',p_actor_role='admin' and role_row.role_key <> 'admin'
      ) order by array_position(array['admin','manager','bartender','viewer'],role_row.role_key))
      from atlas_private.settings_roles role_row
    ),'[]'::jsonb),
    'notification_policies',coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_key',policy.event_key,'category',policy.category,'label',policy.label,
        'enabled',policy.enabled,'channels',policy.channels,
        'target_roles',policy.target_roles,'reminder_minutes',policy.reminder_minutes,
        'escalation_minutes',policy.escalation_minutes,
        'manager_approval_required',policy.manager_approval_required,
        'version',policy.version,'updated_at',policy.updated_at,
        'can_edit',p_actor_role in ('admin','manager')
      ) order by policy.category,policy.label)
      from atlas_private.settings_notification_policies policy
    ),'[]'::jsonb),
    'preferences',coalesce((
      select to_jsonb(preference) - 'created_at' - 'updated_by' - 'updated_by_label'
      from atlas_private.settings_user_preferences preference
      where preference.user_id=p_actor_id
    ),jsonb_build_object(
      'user_id',p_actor_id,'theme','dark','density','comfortable','language','en',
      'start_view','briefing','timezone','Atlantic/Reykjavik','reduce_motion',false,
      'browser_notifications',false,'email_notifications',false,
      'preferences','{}'::jsonb,'updated_at',null
    )),
    'integrations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_key',connection.provider_key,'label',connection.label,
        'category',connection.category,'status',connection.status,
        'authorization_state',connection.authorization_state,
        'publishing_permission_state',connection.publishing_permission_state,
        'analytics_permission_state',connection.analytics_permission_state,
        'last_verified_at',connection.last_verified_at,
        'last_connection_error',connection.last_connection_error,
        'capabilities',connection.capabilities,'requirements',connection.requirements
      ) order by connection.category,connection.label)
      from atlas_private.integration_connections connection
    ),'[]'::jsonb),
    'profiles_summary',jsonb_build_object(
      'total',(select count(*) from jsonb_array_elements(profiles_value)),
      'active',(select count(*) from jsonb_array_elements(profiles_value) profile where coalesce((profile->>'active')::boolean,false)),
      'inactive',(select count(*) from jsonb_array_elements(profiles_value) profile where not coalesce((profile->>'active')::boolean,false)),
      'roles',coalesce((
        select jsonb_object_agg(role_name,role_count)
        from (
          select coalesce(nullif(profile->>'role',''),'unknown') role_name,count(*) role_count
          from jsonb_array_elements(profiles_value) profile
          group by coalesce(nullif(profile->>'role',''),'unknown')
        ) role_counts
      ),'{}'::jsonb)
    ),
    'activity',coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc)
      from (
        select *
        from atlas_private.settings_events event_source
        where p_actor_role in ('admin','manager') or event_source.actor_id=p_actor_id
        order by created_at desc
        limit 100
      ) event_row
    ),'[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

create or replace function atlas_private.settings_save_section(
  p_section_key text,
  p_value jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  section_row atlas_private.settings_sections;
  safe_value jsonb := coalesce(p_value,'{}'::jsonb);
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,p_section_key='security');
  perform atlas_private.settings_assert_safe_json(safe_value);
  if p_section_key not in ('venue','operations','inventory','temperature','cleaning','marketing','brain','security','appearance','modules') then
    raise exception 'Unknown Settings section';
  end if;

  if p_section_key='venue' then
    safe_value := jsonb_set(safe_value,'{currency}','"ISK"'::jsonb,true);
  elsif p_section_key='operations' then
    safe_value := jsonb_set(safe_value,'{production_shift_sync_enabled}','false'::jsonb,true);
  elsif p_section_key='inventory' then
    safe_value := jsonb_set(jsonb_set(safe_value,'{automatic_reorder_execution}','false'::jsonb,true),'{live_quantity_apply}','false'::jsonb,true);
  elsif p_section_key='marketing' then
    safe_value := jsonb_set(jsonb_set(safe_value,'{automatic_publishing_enabled}','false'::jsonb,true),'{analytics_ingestion_enabled}','false'::jsonb,true);
  elsif p_section_key='brain' then
    safe_value := jsonb_set(safe_value,'{automatic_execution_enabled}','false'::jsonb,true);
  elsif p_section_key='security' then
    safe_value := jsonb_set(jsonb_set(jsonb_set(safe_value,'{api_keys_visible}','false'::jsonb,true),'{production_sync_enabled}','false'::jsonb,true),'{destructive_actions_enabled}','false'::jsonb,true);
  elsif p_section_key='modules' then
    safe_value := jsonb_set(jsonb_set(jsonb_set(safe_value,'{production_sync_enabled}','false'::jsonb,true),'{system}','true'::jsonb,true),'{settings}','true'::jsonb,true);
  end if;

  select * into section_row
  from atlas_private.settings_sections
  where section_key=p_section_key
  for update;
  if not found then raise exception 'Settings section not found'; end if;
  if p_expected_version is null or p_expected_version <> section_row.version then
    raise exception 'Settings changed after this page was opened';
  end if;

  update atlas_private.settings_sections
  set settings_value=safe_value,version=version+1,
      updated_by=p_actor_id,updated_by_label=nullif(trim(coalesce(p_actor_label,'')),''),
      updated_at=now()
  where section_key=p_section_key
  returning * into section_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('section_saved','section',p_section_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',section_row.version));

  return jsonb_build_object(
    'section_key',section_row.section_key,'label',section_row.label,
    'description',section_row.description,'status',section_row.status,
    'value',section_row.settings_value,'version',section_row.version,
    'updated_at',section_row.updated_at,'updated_by_label',section_row.updated_by_label
  );
end;
$function$;

create or replace function atlas_private.settings_save_hours(
  p_hours jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  entry jsonb;
  weekdays smallint[] := '{}'::smallint[];
  weekday_value smallint;
  is_open_value boolean;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,false);
  if jsonb_typeof(coalesce(p_hours,'[]'::jsonb)) <> 'array' or jsonb_array_length(p_hours) <> 7 then
    raise exception 'Business hours must contain all seven days';
  end if;

  for entry in select value from jsonb_array_elements(p_hours)
  loop
    weekday_value := (entry->>'weekday')::smallint;
    if weekday_value < 0 or weekday_value > 6 or weekday_value=any(weekdays) then
      raise exception 'Business hours contain an invalid or duplicate weekday';
    end if;
    weekdays := array_append(weekdays,weekday_value);
    is_open_value := coalesce((entry->>'is_open')::boolean,false);
    if is_open_value and (nullif(entry->>'open_time','') is null or nullif(entry->>'close_time','') is null) then
      raise exception 'Open days require opening and closing times';
    end if;

    insert into atlas_private.settings_business_hours(
      weekday,day_label,is_open,open_time,close_time,close_next_day,
      kitchen_close_time,kitchen_close_next_day,last_order_time,last_order_next_day,
      version,updated_by,updated_by_label,updated_at
    ) values (
      weekday_value,left(coalesce(nullif(trim(entry->>'day_label'),''),'Day'),20),is_open_value,
      nullif(entry->>'open_time','')::time,nullif(entry->>'close_time','')::time,
      coalesce((entry->>'close_next_day')::boolean,false),
      nullif(entry->>'kitchen_close_time','')::time,
      coalesce((entry->>'kitchen_close_next_day')::boolean,false),
      nullif(entry->>'last_order_time','')::time,
      coalesce((entry->>'last_order_next_day')::boolean,false),
      1,p_actor_id,nullif(trim(coalesce(p_actor_label,'')),''),now()
    )
    on conflict (weekday) do update
    set day_label=excluded.day_label,is_open=excluded.is_open,
        open_time=excluded.open_time,close_time=excluded.close_time,
        close_next_day=excluded.close_next_day,
        kitchen_close_time=excluded.kitchen_close_time,
        kitchen_close_next_day=excluded.kitchen_close_next_day,
        last_order_time=excluded.last_order_time,
        last_order_next_day=excluded.last_order_next_day,
        version=atlas_private.settings_business_hours.version+1,
        updated_by=excluded.updated_by,updated_by_label=excluded.updated_by_label,
        updated_at=now();
  end loop;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('hours_saved','business_hours','weekly',p_actor_id,p_actor_label,p_actor_role,'{}'::jsonb);

  return coalesce((
    select jsonb_agg(to_jsonb(hours) order by hours.weekday)
    from atlas_private.settings_business_hours hours
  ),'[]'::jsonb);
end;
$function$;

create or replace function atlas_private.settings_save_offer(
  p_offer_id uuid,
  p_offer_key text,
  p_name text,
  p_description text,
  p_active boolean,
  p_days smallint[],
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_end_next_day boolean,
  p_pricing jsonb,
  p_booking_url text,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  offer_row atlas_private.settings_offers;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,false);
  perform atlas_private.settings_assert_safe_json(coalesce(p_pricing,'{}'::jsonb));
  if nullif(trim(coalesce(p_offer_key,'')),'') is null or trim(p_offer_key) !~ '^[a-z0-9][a-z0-9-]{1,99}$' then
    raise exception 'Offer key is invalid';
  end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Offer name is required'; end if;
  if p_start_time is null or p_end_time is null then raise exception 'Offer times are required'; end if;
  if exists (select 1 from unnest(coalesce(p_days,'{}'::smallint[])) day_value where day_value < 0 or day_value > 6) then
    raise exception 'Offer days are invalid';
  end if;

  if p_offer_id is null then
    insert into atlas_private.settings_offers(
      offer_key,name,description,active,days,start_time,end_time,end_next_day,
      pricing,booking_url,updated_by,updated_by_label
    ) values (
      trim(p_offer_key),left(trim(p_name),160),nullif(left(trim(coalesce(p_description,'')),3000),''),
      coalesce(p_active,false),coalesce(p_days,'{}'::smallint[]),p_start_time,p_end_time,
      coalesce(p_end_next_day,false),coalesce(p_pricing,'{}'::jsonb),
      nullif(left(trim(coalesce(p_booking_url,'')),3000),''),p_actor_id,p_actor_label
    ) returning * into offer_row;
  else
    select * into offer_row from atlas_private.settings_offers where id=p_offer_id for update;
    if not found then raise exception 'Offer not found'; end if;
    if p_expected_version is null or p_expected_version <> offer_row.version then
      raise exception 'Offer changed after this page was opened';
    end if;
    update atlas_private.settings_offers
    set offer_key=trim(p_offer_key),name=left(trim(p_name),160),
        description=nullif(left(trim(coalesce(p_description,'')),3000),''),
        active=coalesce(p_active,false),days=coalesce(p_days,'{}'::smallint[]),
        start_time=p_start_time,end_time=p_end_time,end_next_day=coalesce(p_end_next_day,false),
        pricing=coalesce(p_pricing,'{}'::jsonb),
        booking_url=nullif(left(trim(coalesce(p_booking_url,'')),3000),''),
        version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
    where id=p_offer_id returning * into offer_row;
  end if;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('offer_saved','offer',offer_row.offer_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('id',offer_row.id,'version',offer_row.version));
  return to_jsonb(offer_row);
end;
$function$;

create or replace function atlas_private.settings_save_role(
  p_role_key text,
  p_permissions jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  role_row atlas_private.settings_roles;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,false,true);
  perform atlas_private.settings_assert_safe_json(coalesce(p_permissions,'{}'::jsonb));
  if p_role_key not in ('admin','manager','bartender','viewer') then raise exception 'Unknown Atlas role'; end if;
  if p_role_key='admin' then raise exception 'Administrator permissions are protected'; end if;

  select * into role_row from atlas_private.settings_roles where role_key=p_role_key for update;
  if not found then raise exception 'Role settings not found'; end if;
  if p_expected_version is null or p_expected_version <> role_row.version then
    raise exception 'Role settings changed after this page was opened';
  end if;

  update atlas_private.settings_roles
  set permissions=coalesce(p_permissions,'{}'::jsonb),version=version+1,
      updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
  where role_key=p_role_key returning * into role_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('role_saved','role',p_role_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',role_row.version));
  return to_jsonb(role_row);
end;
$function$;

create or replace function atlas_private.settings_save_notification_policy(
  p_event_key text,
  p_enabled boolean,
  p_channels jsonb,
  p_target_roles text[],
  p_reminder_minutes integer[],
  p_escalation_minutes integer,
  p_manager_approval_required boolean,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  policy_row atlas_private.settings_notification_policies;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,false);
  perform atlas_private.settings_assert_safe_json(coalesce(p_channels,'{}'::jsonb));
  if exists (select 1 from unnest(coalesce(p_target_roles,'{}'::text[])) role_value where role_value not in ('admin','manager','bartender','viewer')) then
    raise exception 'Notification target role is invalid';
  end if;
  if exists (select 1 from unnest(coalesce(p_reminder_minutes,'{}'::integer[])) minute_value where minute_value < 0 or minute_value > 43200) then
    raise exception 'Notification reminder is invalid';
  end if;
  if p_escalation_minutes is not null and (p_escalation_minutes < 0 or p_escalation_minutes > 43200) then
    raise exception 'Notification escalation is invalid';
  end if;

  select * into policy_row
  from atlas_private.settings_notification_policies
  where event_key=p_event_key
  for update;
  if not found then raise exception 'Notification policy not found'; end if;
  if p_expected_version is null or p_expected_version <> policy_row.version then
    raise exception 'Notification policy changed after this page was opened';
  end if;

  update atlas_private.settings_notification_policies
  set enabled=coalesce(p_enabled,false),channels=coalesce(p_channels,'{}'::jsonb),
      target_roles=coalesce(p_target_roles,'{}'::text[]),
      reminder_minutes=coalesce(p_reminder_minutes,'{}'::integer[]),
      escalation_minutes=p_escalation_minutes,
      manager_approval_required=coalesce(p_manager_approval_required,false),
      version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
  where event_key=p_event_key returning * into policy_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('notification_saved','notification',p_event_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',policy_row.version));
  return to_jsonb(policy_row);
end;
$function$;

create or replace function atlas_private.settings_save_preferences(
  p_user_id uuid,
  p_theme text,
  p_density text,
  p_language text,
  p_start_view text,
  p_timezone text,
  p_reduce_motion boolean,
  p_browser_notifications boolean,
  p_email_notifications boolean,
  p_preferences jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  preference_row atlas_private.settings_user_preferences;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,false,false);
  perform atlas_private.settings_assert_safe_json(coalesce(p_preferences,'{}'::jsonb));
  if p_user_id is null or p_actor_id is null or p_user_id <> p_actor_id then
    raise exception 'Personal preferences can be saved only by their owner';
  end if;
  if p_theme not in ('dark','light','system') then raise exception 'Theme is invalid'; end if;
  if p_density not in ('comfortable','compact') then raise exception 'Density is invalid'; end if;
  if p_language not in ('en','is') then raise exception 'Language is invalid'; end if;
  if nullif(trim(coalesce(p_start_view,'')),'') is null then raise exception 'Start view is required'; end if;
  if nullif(trim(coalesce(p_timezone,'')),'') is null then raise exception 'Timezone is required'; end if;

  insert into atlas_private.settings_user_preferences(
    user_id,theme,density,language,start_view,timezone,reduce_motion,
    browser_notifications,email_notifications,preferences,updated_by,updated_by_label,updated_at
  ) values (
    p_user_id,p_theme,p_density,p_language,left(trim(p_start_view),80),left(trim(p_timezone),100),
    coalesce(p_reduce_motion,false),coalesce(p_browser_notifications,false),
    coalesce(p_email_notifications,false),coalesce(p_preferences,'{}'::jsonb),
    p_actor_id,p_actor_label,now()
  )
  on conflict (user_id) do update
  set theme=excluded.theme,density=excluded.density,language=excluded.language,
      start_view=excluded.start_view,timezone=excluded.timezone,
      reduce_motion=excluded.reduce_motion,
      browser_notifications=excluded.browser_notifications,
      email_notifications=excluded.email_notifications,
      preferences=excluded.preferences,updated_by=excluded.updated_by,
      updated_by_label=excluded.updated_by_label,updated_at=now()
  returning * into preference_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('preferences_saved','preference',p_user_id::text,p_actor_id,p_actor_label,p_actor_role,'{}'::jsonb);
  return to_jsonb(preference_row);
end;
$function$;

do $settings_function_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='atlas_private'
      and p.proname in (
        'settings_assert_actor','settings_assert_safe_json','settings_snapshot',
        'settings_save_section','settings_save_hours','settings_save_offer',
        'settings_save_role','settings_save_notification_policy','settings_save_preferences'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated',function_row.signature);
    execute format('grant execute on function %s to service_role',function_row.signature);
  end loop;
end
$settings_function_grants$;

comment on table atlas_private.settings_sections is
  'Checkpoint J canonical versioned Settings sections. The inventory, Brain and module rows are the settings contract consumed by Checkpoint K.';
comment on function atlas_private.settings_snapshot(jsonb,uuid,text) is
  'Service-role-only Checkpoint J snapshot. Returns no credentials and keeps production/destructive/automatic execution disabled.';

notify pgrst, 'reload schema';
