-- Checkpoint I — System
-- Manager-only, read-only control-room registry. No production synchronization,
-- job retry, incident resolution, credential display or rollback execution.

create table if not exists atlas_private.system_settings (
  setting_key text primary key,
  environment text not null default 'preview' check (environment in ('preview','production','development')),
  production_project_ref text not null,
  preview_project_ref text not null,
  github_repository text not null,
  github_branch text not null,
  netlify_preview_url text,
  production_sync_enabled boolean not null default false,
  destructive_actions_enabled boolean not null default false,
  automatic_retry_enabled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.system_integrations (
  integration_key text primary key,
  name text not null,
  category text not null,
  state text not null default 'not_connected'
    check (state in ('connected','not_connected','waiting_authorization','missing_permission','connection_expired','degraded','disabled_by_policy')),
  state_detail text,
  external_account_label text,
  automatic_sync_enabled boolean not null default false,
  publishing_enabled boolean not null default false,
  analytics_enabled boolean not null default false,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.system_data_sources (
  source_key text primary key,
  name text not null,
  relation_name text,
  timestamp_column text,
  source_kind text not null check (source_kind in ('live','historical','private_import','external','derived')),
  state_override text check (state_override is null or state_override in ('connected','historical','partial','not_connected','no_records','degraded','disabled_by_policy')),
  live_for_operations boolean not null default false,
  trusted_for_brain boolean not null default false,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  note text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  updated_at timestamptz not null default now(),
  check (relation_name is null or relation_name ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  check (timestamp_column is null or timestamp_column ~ '^[a-z_][a-z0-9_]*$')
);

create table if not exists atlas_private.system_jobs (
  job_key text primary key,
  name text not null,
  category text not null,
  status text not null check (status in ('scheduled','running','completed','waiting','failed','degraded','disabled','not_connected','on_demand')),
  automatic boolean not null default false,
  last_run_at timestamptz,
  next_run_at timestamptz,
  retry_count integer not null default 0 check (retry_count>=0),
  last_error text,
  note text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.system_incidents (
  id uuid primary key default gen_random_uuid(),
  incident_key text not null unique,
  title text not null,
  service_key text not null,
  severity text not null check (severity in ('info','warning','degraded','critical')),
  status text not null default 'open' check (status in ('open','monitoring','resolved','accepted_risk')),
  summary text not null,
  production_impact text,
  preview_impact text,
  error_code text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1 check (occurrence_count>0),
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_label text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.system_recovery_points (
  id uuid primary key default gen_random_uuid(),
  recovery_key text not null unique,
  name text not null,
  environment text not null check (environment in ('preview','production','development')),
  checkpoint_type text not null check (checkpoint_type in ('migration','deployment','branch','manual')),
  reference text,
  status text not null check (status in ('healthy','available','historical','blocked','unknown')),
  recorded_at timestamptz not null default now(),
  note text,
  destructive_action_available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'checkpoint_started','checkpoint_completed','migration_applied','deployment_observed',
    'incident_opened','incident_updated','incident_resolved','integration_state_changed',
    'data_source_refreshed','job_state_changed','security_review_completed','recovery_point_recorded'
  )),
  service_key text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

create index if not exists system_integrations_category_state_idx on atlas_private.system_integrations(category,state,name);
create index if not exists system_sources_kind_state_idx on atlas_private.system_data_sources(source_kind,state_override,name);
create index if not exists system_jobs_status_updated_idx on atlas_private.system_jobs(status,updated_at desc);
create index if not exists system_incidents_status_severity_idx on atlas_private.system_incidents(status,severity,last_seen_at desc);
create index if not exists system_recovery_status_recorded_idx on atlas_private.system_recovery_points(status,recorded_at desc);
create index if not exists system_events_created_idx on atlas_private.system_events(created_at desc);

alter table atlas_private.system_settings enable row level security;
alter table atlas_private.system_integrations enable row level security;
alter table atlas_private.system_data_sources enable row level security;
alter table atlas_private.system_jobs enable row level security;
alter table atlas_private.system_incidents enable row level security;
alter table atlas_private.system_recovery_points enable row level security;
alter table atlas_private.system_events enable row level security;

do $policies$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'system_settings','system_integrations','system_data_sources','system_jobs',
    'system_incidents','system_recovery_points','system_events'
  ] loop
    policy_name := 'service role manages '||replace(table_name,'_',' ');
    execute format('drop policy if exists %I on atlas_private.%I',policy_name,table_name);
    execute format('create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',policy_name,table_name);
    execute format('revoke all on atlas_private.%I from public,anon,authenticated',table_name);
    execute format('grant all on atlas_private.%I to service_role',table_name);
  end loop;
end;
$policies$;

drop trigger if exists system_settings_touch on atlas_private.system_settings;
create trigger system_settings_touch before update on atlas_private.system_settings for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_integrations_touch on atlas_private.system_integrations;
create trigger system_integrations_touch before update on atlas_private.system_integrations for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_sources_touch on atlas_private.system_data_sources;
create trigger system_sources_touch before update on atlas_private.system_data_sources for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_jobs_touch on atlas_private.system_jobs;
create trigger system_jobs_touch before update on atlas_private.system_jobs for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_incidents_touch on atlas_private.system_incidents;
create trigger system_incidents_touch before update on atlas_private.system_incidents for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.system_settings (
  setting_key,environment,production_project_ref,preview_project_ref,github_repository,
  github_branch,netlify_preview_url,production_sync_enabled,destructive_actions_enabled,
  automatic_retry_enabled,metadata
) values (
  'atlas','preview','dnefgcmjcgxlynycxkts','uhbamqetppqmygesoeeh',
  'imadelmoubarik4-cell/-V-OS-','agent/sprint-4-phase-3-atlas-brain',
  'https://deploy-preview-5--os-vabar.netlify.app',false,false,false,
  jsonb_build_object('checkpoint','I','production_source_data_changed',false,'reports_checkpoint','deferred_blocked','view_only_jobs',true,'rollback_execution_enabled',false,'secrets_exposed',false)
)
on conflict (setting_key) do update set
  environment=excluded.environment,production_project_ref=excluded.production_project_ref,
  preview_project_ref=excluded.preview_project_ref,github_repository=excluded.github_repository,
  github_branch=excluded.github_branch,netlify_preview_url=excluded.netlify_preview_url,
  production_sync_enabled=false,destructive_actions_enabled=false,
  automatic_retry_enabled=false,metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_integrations (
  integration_key,name,category,state,state_detail,automatic_sync_enabled,publishing_enabled,analytics_enabled,metadata
) values
  ('supabase','Supabase','Platform','connected','Production authentication and the isolated preview project are configured.',true,false,false,jsonb_build_object('scope','database-auth-storage-edge')),
  ('github','GitHub','Development','connected','The Atlas repository and Sprint 4 branch are connected.',false,false,false,jsonb_build_object('repository','imadelmoubarik4-cell/-V-OS-')),
  ('netlify','Netlify','Deployment','connected','Deploy Preview #5 is the active acceptance environment.',true,false,false,jsonb_build_object('site','os-vabar')),
  ('gmail','Gmail','Communication','not_connected','Available to authorized research workflows, but not synchronized into the Atlas application.',false,false,false,'{}'::jsonb),
  ('outlook','Outlook','Communication','not_connected','Available to authorized research workflows, but not synchronized into the Atlas application.',false,false,false,'{}'::jsonb),
  ('google-drive','Google Drive','Documents','not_connected','Knowledge references may be added manually; automatic Drive synchronization is disabled.',false,false,false,'{}'::jsonb),
  ('dineout','Dineout','Operations','not_connected','No verified live sales or booking API is connected to Atlas.',false,false,false,'{}'::jsonb),
  ('teya','Teya','Payments','not_connected','Payment and settlement data is not connected to the trusted reporting layer.',false,false,false,'{}'::jsonb),
  ('google-business-profile','Google Business Profile','Marketing','not_connected','Planning works before connection; publishing and analytics remain locked.',false,false,false,'{}'::jsonb),
  ('facebook','Facebook','Marketing','not_connected','OAuth and platform permissions are not verified.',false,false,false,'{}'::jsonb),
  ('instagram','Instagram','Marketing','not_connected','OAuth and platform permissions are not verified.',false,false,false,'{}'::jsonb),
  ('tiktok','TikTok','Marketing','not_connected','Developer authorization and posting scopes are not verified.',false,false,false,'{}'::jsonb),
  ('tripadvisor','Tripadvisor','Reputation','not_connected','Review and listing access remain outside Atlas until authorized API access is verified.',false,false,false,'{}'::jsonb)
on conflict (integration_key) do update set
  name=excluded.name,category=excluded.category,state_detail=excluded.state_detail,
  automatic_sync_enabled=excluded.automatic_sync_enabled,publishing_enabled=excluded.publishing_enabled,
  analytics_enabled=excluded.analytics_enabled,metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_data_sources (
  source_key,name,relation_name,timestamp_column,source_kind,state_override,
  live_for_operations,trusted_for_brain,last_success_at,last_attempt_at,note,metadata
) values
  ('real-va-review','Real VÁ review queue','atlas_private.review_queue','updated_at','private_import','partial',false,false,'2026-08-03 00:00:00+00','2026-08-03 00:00:00+00','Sprint 3 imported evidence remains subject to manager review.','{}'::jsonb),
  ('july-inventory','July 2026 inventory evidence','atlas_private.import_inventory_rows','created_at','historical','historical',false,false,'2026-08-03 00:00:00+00','2026-08-03 00:00:00+00','Historical opening snapshot; never treated as current live stock.','{}'::jsonb),
  ('inventory','Inventory','public.inventory_items','updated_at','live',null,true,true,null,null,'Canonical item records used by operations where review gates permit.','{}'::jsonb),
  ('recipes','Recipes','public.recipes','updated_at','live',null,true,true,null,null,'Approved recipe and product links.','{}'::jsonb),
  ('suppliers','Suppliers','public.suppliers','updated_at','live',null,true,true,null,null,'Supplier profiles; commercial fields remain permission-controlled.','{}'::jsonb),
  ('operations','Operational routines','atlas_private.routine_instances','updated_at','live',null,true,true,null,null,'Checklist and cleaning evidence.','{}'::jsonb),
  ('temperatures','Temperature logs','atlas_private.temperature_logs','created_at','live',null,true,true,null,null,'Daily refrigeration evidence.','{}'::jsonb),
  ('shifts','Shift planning','atlas_private.shift_entries','updated_at','live',null,true,true,null,null,'Private drafts and published revisions.','{}'::jsonb),
  ('knowledge','Knowledge','atlas_private.knowledge_articles','updated_at','live',null,true,true,null,null,'Only manager-published versions are staff-visible.','{}'::jsonb),
  ('marketing','Marketing planning','atlas_private.marketing_content_items','updated_at','live',null,true,false,null,null,'Planning and manual publication history; no automatic social action.','{}'::jsonb),
  ('sales','Sales history',null,null,'external','not_connected',false,false,null,null,'A verified production sales source and product mapping are not connected.','{}'::jsonb),
  ('bookings','Bookings',null,null,'external','not_connected',false,false,null,null,'A trusted booking feed is not connected.','{}'::jsonb),
  ('drive-sync','Google Drive synchronization',null,null,'external','disabled_by_policy',false,false,null,null,'Automatic Drive synchronization is disabled until authorization is verified.','{}'::jsonb)
on conflict (source_key) do update set
  name=excluded.name,relation_name=excluded.relation_name,timestamp_column=excluded.timestamp_column,
  source_kind=excluded.source_kind,state_override=excluded.state_override,
  live_for_operations=excluded.live_for_operations,trusted_for_brain=excluded.trusted_for_brain,
  note=excluded.note,metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_jobs (
  job_key,name,category,status,automatic,last_run_at,next_run_at,retry_count,last_error,note,metadata
) values
  ('sprint3-import','Sprint 3 private import','Imports','completed',false,'2026-08-03 00:00:00+00',null,0,null,'Private supplier, purchasing and inventory evidence imported.','{}'::jsonb),
  ('real-va-review','Real VÁ review workflow','Data review','waiting',false,null,null,0,null,'Records await manager review before canonical promotion.','{}'::jsonb),
  ('reports-snapshot','Reports snapshot','Reporting','failed',false,now(),null,0,'Authenticated Reports remains on the loading state.','Checkpoint H is deferred and remains a release blocker.','{}'::jsonb),
  ('operations-routines','Operational routine scheduler','Operations','scheduled',true,null,null,0,null,'Creates due routines and temperature expectations.','{}'::jsonb),
  ('marketing-reminders','Marketing reminders','Marketing','scheduled',true,null,null,0,null,'Surfaces planning reminders only; no social publishing.','{}'::jsonb),
  ('shift-publication','Schedule publication','People','on_demand',false,null,null,0,null,'Publishes immutable week and month revisions when a manager confirms.','{}'::jsonb),
  ('knowledge-announcements','Knowledge announcements','Knowledge','on_demand',false,null,null,0,null,'Posts an announcement after a manager publishes a Knowledge version.','{}'::jsonb),
  ('social-publishing','Automatic social publishing','Marketing','disabled',false,null,null,0,null,'Disabled until OAuth and platform permissions are verified.','{}'::jsonb),
  ('drive-sync','Google Drive synchronization','Documents','disabled',false,null,null,0,null,'Disabled until a supported authorization and sync contract exists.','{}'::jsonb),
  ('sales-sync','Sales synchronization','Sales','not_connected',false,null,null,0,null,'No trusted sales source is connected.','{}'::jsonb)
on conflict (job_key) do update set
  name=excluded.name,category=excluded.category,status=excluded.status,automatic=excluded.automatic,
  last_error=excluded.last_error,note=excluded.note,metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_incidents (
  incident_key,title,service_key,severity,status,summary,production_impact,preview_impact,
  error_code,first_seen_at,last_seen_at,occurrence_count,metadata
) values (
  'reports-snapshot-loading','Reports snapshot does not complete','atlas-reports','degraded','open',
  'The authenticated Reports workspace remains on Loading Reports and has not passed browser acceptance.',
  'None. Production source records are unchanged.','Reports unavailable in the Sprint 4 preview.',
  'REPORTS_SNAPSHOT_LOADING','2026-08-04 12:00:00+00',now(),1,
  jsonb_build_object('checkpoint','H','release_blocker',true,'deferred',true)
)
on conflict (incident_key) do update set
  title=excluded.title,service_key=excluded.service_key,severity=excluded.severity,status='open',
  summary=excluded.summary,production_impact=excluded.production_impact,
  preview_impact=excluded.preview_impact,error_code=excluded.error_code,last_seen_at=now(),
  resolution_note=null,resolved_at=null,resolved_by=null,resolved_by_label=null,
  metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_recovery_points (
  recovery_key,name,environment,checkpoint_type,reference,status,recorded_at,note,destructive_action_available,metadata
) values
  ('sprint3-repaired','Sprint 3 repaired data checkpoint','preview','migration','agent/sprint-3-real-va-data','historical','2026-08-02 18:30:00+00','Migration history repaired and data preserved.',false,'{}'::jsonb),
  ('sprint4-knowledge-accepted','Checkpoint G Knowledge accepted','preview','branch','agent/sprint-4-phase-3-atlas-brain','healthy','2026-08-04 01:30:00+00','Last accepted functional checkpoint before Reports debugging.',false,'{}'::jsonb),
  ('sprint4-current-preview','Current Sprint 4 preview','preview','deployment','deploy-preview-5--os-vabar.netlify.app','blocked',now(),'Current preview includes an unresolved Reports release blocker.',false,jsonb_build_object('blocker','reports-snapshot-loading'))
on conflict (recovery_key) do update set
  name=excluded.name,reference=excluded.reference,status=excluded.status,
  recorded_at=excluded.recorded_at,note=excluded.note,
  destructive_action_available=false,metadata=excluded.metadata;

insert into atlas_private.system_events (event_type,service_key,actor_label,actor_role,payload)
select 'checkpoint_started','atlas-system','Atlas deployment','system',jsonb_build_object('checkpoint','I','view_only',true)
where not exists (select 1 from atlas_private.system_events where event_type='checkpoint_started' and service_key='atlas-system');
insert into atlas_private.system_events (event_type,service_key,actor_label,actor_role,payload)
select 'incident_opened','atlas-reports','Atlas deployment','system',jsonb_build_object('incident_key','reports-snapshot-loading','severity','degraded')
where not exists (select 1 from atlas_private.system_events where event_type='incident_opened' and service_key='atlas-reports');

create or replace function atlas_private.system_relation_count(p_relation text)
returns bigint language plpgsql stable security invoker set search_path='' as $$
declare relation_oid regclass; result_count bigint;
begin
  if p_relation is null or p_relation !~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$' then return null; end if;
  relation_oid := to_regclass(p_relation);
  if relation_oid is null then return null; end if;
  execute format('select count(*)::bigint from %s',relation_oid) into result_count;
  return result_count;
exception when others then return null;
end;
$$;

create or replace function atlas_private.system_relation_latest(p_relation text,p_column text)
returns timestamptz language plpgsql stable security invoker set search_path='' as $$
declare relation_oid regclass; result_time timestamptz;
begin
  if p_relation is null or p_column is null
     or p_relation !~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'
     or p_column !~ '^[a-z_][a-z0-9_]*$' then return null; end if;
  relation_oid := to_regclass(p_relation);
  if relation_oid is null then return null; end if;
  execute format('select max(%I)::timestamptz from %s',p_column,relation_oid) into result_time;
  return result_time;
exception when others then return null;
end;
$$;

comment on table atlas_private.system_incidents is 'Private Atlas incidents and release blockers. Checkpoint I is view-only and does not resolve incidents automatically.';
comment on table atlas_private.system_jobs is 'Read-only registry of imports, synchronization and publication jobs. Retry execution is disabled in Checkpoint I.';
