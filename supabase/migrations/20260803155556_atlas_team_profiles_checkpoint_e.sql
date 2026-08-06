-- Checkpoint E — private Team Profiles data and service-role RPC surface.
-- Production Auth profiles and onboarding records remain the authority for
-- identity, role, active access and training; this branch stores private
-- employment details, emergency contacts and immutable audit events.

create table if not exists atlas_private.team_profile_details (
  profile_id uuid primary key,
  preferred_name text,
  job_title text,
  department text check (department is null or department in ('management','bar','kitchen','service','operations','marketing','other')),
  employment_type text check (employment_type is null or employment_type in ('owner','full_time','part_time','temporary','contractor','other')),
  start_date date,
  phone text check (phone is null or char_length(phone) between 3 and 40),
  phone_visibility text not null default 'managers_only' check (phone_visibility in ('team','managers_only')),
  preferred_language text,
  manager_notes text,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (preferred_name is null or char_length(preferred_name) between 1 and 120),
  check (job_title is null or char_length(job_title) <= 160),
  check (preferred_language is null or char_length(preferred_language) <= 80),
  check (manager_notes is null or char_length(manager_notes) <= 5000)
);

create table if not exists atlas_private.team_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  contact_name text not null check (char_length(contact_name) between 1 and 160),
  relationship text check (relationship is null or char_length(relationship) <= 120),
  phone text not null check (char_length(phone) between 3 and 40),
  note text check (note is null or char_length(note) <= 2000),
  priority smallint not null default 1 check (priority between 1 and 5),
  active boolean not null default true,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.team_profile_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'profile_details_updated','display_name_changed','role_changed',
    'active_status_changed','emergency_contact_saved',
    'emergency_contact_removed','onboarding_status_changed'
  )),
  profile_id uuid not null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

create index if not exists team_profile_details_department_idx
  on atlas_private.team_profile_details(department,employment_type);
create index if not exists team_emergency_contacts_profile_idx
  on atlas_private.team_emergency_contacts(profile_id,active,priority);
create unique index if not exists team_emergency_contacts_active_priority_uidx
  on atlas_private.team_emergency_contacts(profile_id,priority) where active=true;
create index if not exists team_profile_events_profile_created_idx
  on atlas_private.team_profile_events(profile_id,created_at desc);
create index if not exists team_profile_events_created_idx
  on atlas_private.team_profile_events(created_at desc);

alter table atlas_private.team_profile_details enable row level security;
alter table atlas_private.team_emergency_contacts enable row level security;
alter table atlas_private.team_profile_events enable row level security;

drop policy if exists "service role manages team profile details" on atlas_private.team_profile_details;
create policy "service role manages team profile details" on atlas_private.team_profile_details
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages team emergency contacts" on atlas_private.team_emergency_contacts;
create policy "service role manages team emergency contacts" on atlas_private.team_emergency_contacts
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages team profile events" on atlas_private.team_profile_events;
create policy "service role manages team profile events" on atlas_private.team_profile_events
  for all to service_role using (true) with check (true);

revoke all on atlas_private.team_profile_details from public,anon,authenticated;
revoke all on atlas_private.team_emergency_contacts from public,anon,authenticated;
revoke all on atlas_private.team_profile_events from public,anon,authenticated;
grant all on atlas_private.team_profile_details to service_role;
grant all on atlas_private.team_emergency_contacts to service_role;
grant all on atlas_private.team_profile_events to service_role;

drop trigger if exists team_profile_details_touch on atlas_private.team_profile_details;
create trigger team_profile_details_touch before update on atlas_private.team_profile_details
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists team_emergency_contacts_touch on atlas_private.team_emergency_contacts;
create trigger team_emergency_contacts_touch before update on atlas_private.team_emergency_contacts
  for each row execute function atlas_private.touch_updated_at();

create or replace function atlas_private.team_profiles_snapshot(
  p_profiles jsonb,p_tasks jsonb,p_progress jsonb,p_actor_id uuid,p_actor_role text
) returns jsonb
language sql stable security invoker set search_path=''
as $$
with profiles_input as (
  select * from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as p(
    id uuid,email text,display_name text,role text,active boolean,
    created_at timestamptz,updated_at timestamptz
  )
), tasks_input as (
  select * from jsonb_to_recordset(coalesce(p_tasks,'[]'::jsonb)) as t(
    id uuid,title text,description text,category text,sort_order integer,
    required boolean,active boolean
  )
), progress_input as (
  select * from jsonb_to_recordset(coalesce(p_progress,'[]'::jsonb)) as x(
    id uuid,task_id uuid,user_id uuid,completed_at timestamptz,
    completed_by uuid,note text
  )
), visible as (
  select p.* from profiles_input p
  where p_actor_role in ('admin','manager') or p.active=true or p.id=p_actor_id
), rows as (
  select p.id,p.active,
    coalesce(nullif(trim(d.preferred_name),''),nullif(trim(p.display_name),''),split_part(coalesce(p.email,''),'@',1),'Team member') sort_name,
    jsonb_build_object(
      'id',p.id,'email',p.email,'display_name',p.display_name,
      'preferred_name',d.preferred_name,
      'name',coalesce(nullif(trim(d.preferred_name),''),nullif(trim(p.display_name),''),split_part(coalesce(p.email,''),'@',1),'Team member'),
      'role',p.role,'active',coalesce(p.active,false),'job_title',d.job_title,
      'department',d.department,'employment_type',d.employment_type,
      'start_date',d.start_date,
      'phone',case when p_actor_role in ('admin','manager') or p.id=p_actor_id or d.phone_visibility='team' then d.phone end,
      'phone_visibility',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then coalesce(d.phone_visibility,'managers_only') end,
      'preferred_language',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then d.preferred_language end,
      'manager_notes',case when p_actor_role in ('admin','manager') then d.manager_notes end,
      'created_at',p.created_at,'updated_at',greatest(p.updated_at,d.updated_at),
      'can_view_sensitive',(p_actor_role in ('admin','manager') or p.id=p_actor_id),
      'can_edit_profile',(p_actor_role in ('admin','manager') or p.id=p_actor_id),
      'can_manage_access',(p_actor_role in ('admin','manager') and p.id<>p_actor_id),
      'can_manage_training',(p_actor_role in ('admin','manager')),
      'emergency_contact_count',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then (
        select count(*)::bigint from atlas_private.team_emergency_contacts c
        where c.profile_id=p.id and c.active=true
      ) end,
      'emergency_contacts',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',c.id,'contact_name',c.contact_name,'relationship',c.relationship,
          'phone',c.phone,'note',c.note,'priority',c.priority,'active',c.active,
          'updated_at',c.updated_at
        ) order by c.priority,c.contact_name)
        from atlas_private.team_emergency_contacts c
        where c.profile_id=p.id and c.active=true
      ),'[]'::jsonb) else '[]'::jsonb end,
      'profile_completion_percent',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then 20 * (
        (coalesce(nullif(trim(d.preferred_name),''),nullif(trim(p.display_name),'')) is not null)::integer
        + (nullif(trim(d.job_title),'') is not null)::integer
        + (nullif(trim(d.phone),'') is not null)::integer
        + (d.start_date is not null)::integer
        + case when exists(select 1 from atlas_private.team_emergency_contacts c where c.profile_id=p.id and c.active=true) then 1 else 0 end
      ) end,
      'training',case when p_actor_role in ('admin','manager') or p.id=p_actor_id then jsonb_build_object(
        'total_required',(select count(*)::bigint from tasks_input t where t.active and t.required),
        'completed_required',(select count(*)::bigint from tasks_input t where t.active and t.required and exists(
          select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
        )),
        'percent',case when (select count(*) from tasks_input t where t.active and t.required)=0 then 100 else round(100 *
          (select count(*) from tasks_input t where t.active and t.required and exists(
            select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
          ))::numeric / (select count(*) from tasks_input t where t.active and t.required)::numeric) end,
        'complete',not exists(select 1 from tasks_input t where t.active and t.required and not exists(
          select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
        )),
        'tasks',coalesce((select jsonb_agg(jsonb_build_object(
          'id',t.id,'title',t.title,'description',t.description,'category',t.category,
          'sort_order',t.sort_order,'required',t.required,'completed',(x.completed_at is not null),
          'completed_at',x.completed_at,'completed_by',x.completed_by,'note',x.note
        ) order by t.sort_order,t.title)
        from tasks_input t left join progress_input x on x.task_id=t.id and x.user_id=p.id
        where t.active),'[]'::jsonb)
      ) else jsonb_build_object('private',true) end
    ) payload
  from visible p left join atlas_private.team_profile_details d on d.profile_id=p.id
)
select jsonb_build_object(
  'version','atlas-team-profiles/0.1.0','generated_at',pg_catalog.now(),
  'profiles',coalesce((select jsonb_agg(payload order by active desc,sort_name) from rows),'[]'::jsonb),
  'summary',jsonb_build_object(
    'total_profiles',(select count(*)::bigint from visible),
    'active_profiles',(select count(*)::bigint from visible where active),
    'inactive_profiles',case when p_actor_role in ('admin','manager') then (select count(*)::bigint from visible where not active) end,
    'managers',(select count(*)::bigint from visible where active and role in ('admin','manager')),
    'training_complete',case when p_actor_role in ('admin','manager') then (select count(*)::bigint from visible p where not exists(
      select 1 from tasks_input t where t.active and t.required and not exists(
        select 1 from progress_input x where x.task_id=t.id and x.user_id=p.id and x.completed_at is not null
      ))) end,
    'emergency_contacts_complete',case when p_actor_role in ('admin','manager') then (select count(*)::bigint from visible p where exists(
      select 1 from atlas_private.team_emergency_contacts c where c.profile_id=p.id and c.active=true
    )) end,
    'required_onboarding_tasks',(select count(*)::bigint from tasks_input where active and required)
  ),
  'events',case when p_actor_role in ('admin','manager') then coalesce((select jsonb_agg(jsonb_build_object(
    'id',e.id,'event_type',e.event_type,'profile_id',e.profile_id,'actor_id',e.actor_id,
    'actor_label',e.actor_label,'actor_role',e.actor_role,'payload',e.payload,'created_at',e.created_at
  ) order by e.created_at desc) from (select * from atlas_private.team_profile_events order by created_at desc limit 60) e),'[]'::jsonb) else '[]'::jsonb end,
  'policy',jsonb_build_object(
    'inactive_profile_access','denied_by_gateway','emergency_contacts','self_or_manager',
    'training_management','manager_or_admin','role_and_active_controls','manager_or_admin_except_self',
    'email_change','not_supported_in_checkpoint_e','auth_invitation','not_connected',
    'direct_browser_table_access',false,'audit_history_preserved',true
  )
);
$$;

create or replace function atlas_private.team_profile_upsert_details(
  p_profile_id uuid,p_preferred_name text,p_job_title text,p_department text,
  p_employment_type text,p_start_date date,p_phone text,p_phone_visibility text,
  p_preferred_language text,p_manager_notes text,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb
language plpgsql volatile security invoker set search_path=''
as $$
declare old_row atlas_private.team_profile_details; saved atlas_private.team_profile_details; manager boolean:=p_actor_role in ('admin','manager');
begin
  if p_profile_id is null or p_actor_id is null then raise exception 'Profile and actor are required'; end if;
  if not manager and p_profile_id<>p_actor_id then raise exception 'Staff may edit only their own contact details'; end if;
  if p_department is not null and p_department not in ('management','bar','kitchen','service','operations','marketing','other') then raise exception 'Department is invalid'; end if;
  if p_employment_type is not null and p_employment_type not in ('owner','full_time','part_time','temporary','contractor','other') then raise exception 'Employment type is invalid'; end if;
  if coalesce(p_phone_visibility,'managers_only') not in ('team','managers_only') then raise exception 'Phone visibility is invalid'; end if;
  select * into old_row from atlas_private.team_profile_details where profile_id=p_profile_id;
  insert into atlas_private.team_profile_details(profile_id,preferred_name,job_title,department,employment_type,start_date,phone,phone_visibility,preferred_language,manager_notes,created_by,created_by_label,updated_by,updated_by_label)
  values(p_profile_id,nullif(trim(coalesce(p_preferred_name,'')),''),case when manager then nullif(trim(coalesce(p_job_title,'')),'') end,case when manager then p_department end,case when manager then p_employment_type end,case when manager then p_start_date end,nullif(trim(coalesce(p_phone,'')),''),coalesce(p_phone_visibility,'managers_only'),nullif(trim(coalesce(p_preferred_language,'')),''),case when manager then nullif(trim(coalesce(p_manager_notes,'')),'') end,p_actor_id,p_actor_label,p_actor_id,p_actor_label)
  on conflict(profile_id) do update set
    preferred_name=excluded.preferred_name,
    job_title=case when manager then excluded.job_title else atlas_private.team_profile_details.job_title end,
    department=case when manager then excluded.department else atlas_private.team_profile_details.department end,
    employment_type=case when manager then excluded.employment_type else atlas_private.team_profile_details.employment_type end,
    start_date=case when manager then excluded.start_date else atlas_private.team_profile_details.start_date end,
    phone=excluded.phone,phone_visibility=excluded.phone_visibility,preferred_language=excluded.preferred_language,
    manager_notes=case when manager then excluded.manager_notes else atlas_private.team_profile_details.manager_notes end,
    updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  returning * into saved;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values('profile_details_updated',p_profile_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object(
    'preferred_name_changed',old_row.preferred_name is distinct from saved.preferred_name,
    'job_title_changed',old_row.job_title is distinct from saved.job_title,
    'department_changed',old_row.department is distinct from saved.department,
    'employment_type_changed',old_row.employment_type is distinct from saved.employment_type,
    'start_date_changed',old_row.start_date is distinct from saved.start_date,
    'phone_changed',old_row.phone is distinct from saved.phone,
    'phone_visibility',saved.phone_visibility,'preferred_language_changed',old_row.preferred_language is distinct from saved.preferred_language,
    'manager_notes_changed',manager and old_row.manager_notes is distinct from saved.manager_notes
  ));
  return to_jsonb(saved);
end; $$;

create or replace function atlas_private.team_profile_save_emergency_contact(
  p_contact_id uuid,p_profile_id uuid,p_contact_name text,p_relationship text,p_phone text,
  p_note text,p_priority smallint,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb
language plpgsql volatile security invoker set search_path=''
as $$
declare contact_id uuid:=p_contact_id; saved atlas_private.team_emergency_contacts; manager boolean:=p_actor_role in ('admin','manager');
begin
  if not manager and p_profile_id<>p_actor_id then raise exception 'Staff may edit only their own emergency contacts'; end if;
  if nullif(trim(coalesce(p_contact_name,'')),'') is null or nullif(trim(coalesce(p_phone,'')),'') is null then raise exception 'Emergency contact name and phone are required'; end if;
  if coalesce(p_priority,1) not between 1 and 5 then raise exception 'Emergency contact priority must be between 1 and 5'; end if;
  if contact_id is null then select id into contact_id from atlas_private.team_emergency_contacts where profile_id=p_profile_id and priority=coalesce(p_priority,1) and active limit 1; end if;
  update atlas_private.team_emergency_contacts set active=false,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  where profile_id=p_profile_id and priority=coalesce(p_priority,1) and active and (contact_id is null or id<>contact_id);
  if contact_id is null then
    insert into atlas_private.team_emergency_contacts(profile_id,contact_name,relationship,phone,note,priority,active,created_by,created_by_label,updated_by,updated_by_label)
    values(p_profile_id,trim(p_contact_name),nullif(trim(coalesce(p_relationship,'')),''),trim(p_phone),nullif(trim(coalesce(p_note,'')),''),coalesce(p_priority,1),true,p_actor_id,p_actor_label,p_actor_id,p_actor_label)
    returning * into saved;
  else
    update atlas_private.team_emergency_contacts set contact_name=trim(p_contact_name),relationship=nullif(trim(coalesce(p_relationship,'')),''),phone=trim(p_phone),note=nullif(trim(coalesce(p_note,'')),''),priority=coalesce(p_priority,1),active=true,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
    where id=contact_id and profile_id=p_profile_id returning * into saved;
    if not found then raise exception 'Emergency contact not found'; end if;
  end if;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values('emergency_contact_saved',p_profile_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('contact_id',saved.id,'priority',saved.priority));
  return to_jsonb(saved);
end; $$;

create or replace function atlas_private.team_profile_remove_emergency_contact(
  p_contact_id uuid,p_profile_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
) returns jsonb
language plpgsql volatile security invoker set search_path=''
as $$
declare removed atlas_private.team_emergency_contacts; manager boolean:=p_actor_role in ('admin','manager');
begin
  if not manager and p_profile_id<>p_actor_id then raise exception 'Staff may edit only their own emergency contacts'; end if;
  update atlas_private.team_emergency_contacts set active=false,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=pg_catalog.now()
  where id=p_contact_id and profile_id=p_profile_id and active returning * into removed;
  if not found then raise exception 'Emergency contact not found'; end if;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values('emergency_contact_removed',p_profile_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('contact_id',removed.id,'priority',removed.priority));
  return to_jsonb(removed);
end; $$;

create or replace function atlas_private.team_profile_log_external_event(
  p_event_type text,p_profile_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text,p_payload jsonb
) returns uuid
language plpgsql volatile security invoker set search_path=''
as $$ declare event_id uuid; begin
  if p_event_type not in ('display_name_changed','role_changed','active_status_changed','onboarding_status_changed') then raise exception 'External team-profile event type is invalid'; end if;
  insert into atlas_private.team_profile_events(event_type,profile_id,actor_id,actor_label,actor_role,payload)
  values(p_event_type,p_profile_id,p_actor_id,p_actor_label,p_actor_role,coalesce(p_payload,'{}'::jsonb)) returning id into event_id;
  return event_id;
end; $$;

create or replace function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.team_profiles_snapshot($1,$2,$3,$4,$5); $$;
create or replace function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_upsert_details($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13); $$;
create or replace function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_save_emergency_contact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10); $$;
create or replace function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_remove_emergency_contact($1,$2,$3,$4,$5); $$;
create or replace function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb)
returns uuid language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_profile_log_external_event($1,$2,$3,$4,$5,$6); $$;

revoke execute on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) to service_role;
grant execute on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) to service_role;

comment on table atlas_private.team_profile_details is 'Private employment and contact details keyed to production VÁ profile IDs.';
comment on table atlas_private.team_emergency_contacts is 'Emergency contacts visible only to the profile owner and managers through the Team Profiles gateway.';
comment on table atlas_private.team_profile_events is 'Immutable audit history for Team Profile, access, emergency-contact and onboarding changes.';
