-- Checkpoint I — Atlas System control room
--
-- This migration creates a private, manager-only registry for services, data
-- sources, jobs, incidents, release checkpoints and audit evidence. Checkpoint
-- I is deliberately view-only: retries, incident mutation, rollback,
-- destructive actions and production promotion remain disabled.

create table if not exists atlas_private.system_settings (
  setting_key text primary key,
  environment text not null default 'preview'
    check (environment in ('preview','production')),
  production_sync_enabled boolean not null default false,
  destructive_actions_enabled boolean not null default false,
  automatic_retries_enabled boolean not null default false,
  rollback_actions_enabled boolean not null default false,
  secrets_visible_in_ui boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.system_services (
  service_key text primary key,
  label text not null,
  category text not null
    check (category in ('application','authentication','database','storage','edge_function','integration','module','safeguard')),
  status text not null default 'unknown'
    check (status in ('healthy','degraded','down','not_connected','disabled_by_policy','waiting_authorization','missing_permission','expired','unknown')),
  environment text not null default 'preview'
    check (environment in ('preview','production','external','shared')),
  version_label text,
  check_strategy text not null default 'registry'
    check (check_strategy in ('registry','runtime','client','incident','database')),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_code text,
  failure_message text,
  production_impact text not null default 'none'
    check (production_impact in ('none','limited','degraded','outage','unknown')),
  preview_impact text not null default 'none'
    check (preview_impact in ('none','limited','degraded','outage','unknown')),
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(label) between 1 and 160),
  check (failure_message is null or char_length(failure_message)<=5000),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.system_data_sources (
  source_key text primary key,
  label text not null,
  domain text not null,
  source_type text not null
    check (source_type in ('live','historical_snapshot','private_import','integration','manual')),
  status text not null default 'unknown'
    check (status in ('connected','partial','stale','not_connected','no_records','historical','blocked','unknown')),
  is_live boolean not null default false,
  is_historical boolean not null default false,
  trusted_for_brain boolean not null default false,
  record_count bigint,
  last_successful_at timestamptz,
  last_attempted_at timestamptz,
  freshness_hours integer,
  freshness_state text not null default 'unknown'
    check (freshness_state in ('current','stale','historical','not_connected','unknown')),
  source_scope text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (record_count is null or record_count>=0),
  check (freshness_hours is null or freshness_hours>=0),
  check (error_message is null or char_length(error_message)<=5000),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.system_jobs (
  job_key text primary key,
  label text not null,
  category text not null,
  schedule_description text,
  status text not null default 'idle'
    check (status in ('healthy','running','waiting','failed','disabled_by_policy','not_connected','idle')),
  is_automatic boolean not null default false,
  retry_enabled boolean not null default false,
  write_scope text not null default 'none',
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  next_run_at timestamptz,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_error_message is null or char_length(last_error_message)<=5000),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.system_incidents (
  id uuid primary key default gen_random_uuid(),
  incident_key text not null unique,
  service_key text references atlas_private.system_services(service_key) on delete set null,
  title text not null,
  severity text not null check (severity in ('info','warning','degraded','critical')),
  status text not null default 'open' check (status in ('open','monitoring','resolved','dismissed')),
  summary text not null,
  production_impact text not null default 'none'
    check (production_impact in ('none','limited','degraded','outage','unknown')),
  preview_impact text not null default 'degraded'
    check (preview_impact in ('none','limited','degraded','outage','unknown')),
  first_occurred_at timestamptz not null default now(),
  last_occurred_at timestamptz not null default now(),
  occurrence_count integer not null default 1 check (occurrence_count>0),
  opened_by uuid,
  opened_by_label text,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_label text,
  resolution_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(title) between 1 and 220),
  check (char_length(summary) between 1 and 10000),
  check (resolution_note is null or char_length(resolution_note)<=10000),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.system_release_checkpoints (
  checkpoint_key text primary key,
  label text not null,
  environment text not null check (environment in ('preview','production')),
  status text not null check (status in ('healthy','degraded','blocked','ready','unknown')),
  repository text,
  branch text,
  base_branch text,
  pull_request_number integer,
  commit_sha text,
  deployment_url text,
  migration_status text,
  functions_status text,
  production_sync_state text not null default 'disabled'
    check (production_sync_state in ('disabled','preview_only','enabled','unknown')),
  last_known_healthy_reference text,
  rollback_reference text,
  release_blockers jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(release_blockers)='array'),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'checkpoint_created','health_check_completed','service_status_changed','source_status_changed',
    'job_status_changed','incident_opened','incident_updated','incident_resolved',
    'release_checkpoint_updated','security_check_completed','recovery_reference_updated'
  )),
  domain text not null default 'system',
  entity_key text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

create index if not exists system_services_status_idx
  on atlas_private.system_services(status,sort_order);
create index if not exists system_sources_status_idx
  on atlas_private.system_data_sources(status,sort_order);
create index if not exists system_jobs_status_idx
  on atlas_private.system_jobs(status,sort_order);
create index if not exists system_incidents_status_idx
  on atlas_private.system_incidents(status,severity,last_occurred_at desc);
create index if not exists system_incidents_service_idx
  on atlas_private.system_incidents(service_key,status);
create index if not exists system_events_created_idx
  on atlas_private.system_events(created_at desc);
create index if not exists system_events_entity_idx
  on atlas_private.system_events(domain,entity_key,created_at desc);

alter table atlas_private.system_settings enable row level security;
alter table atlas_private.system_services enable row level security;
alter table atlas_private.system_data_sources enable row level security;
alter table atlas_private.system_jobs enable row level security;
alter table atlas_private.system_incidents enable row level security;
alter table atlas_private.system_release_checkpoints enable row level security;
alter table atlas_private.system_events enable row level security;

drop policy if exists "service role manages system settings" on atlas_private.system_settings;
create policy "service role manages system settings" on atlas_private.system_settings
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages system services" on atlas_private.system_services;
create policy "service role manages system services" on atlas_private.system_services
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages system sources" on atlas_private.system_data_sources;
create policy "service role manages system sources" on atlas_private.system_data_sources
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages system jobs" on atlas_private.system_jobs;
create policy "service role manages system jobs" on atlas_private.system_jobs
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages system incidents" on atlas_private.system_incidents;
create policy "service role manages system incidents" on atlas_private.system_incidents
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages system releases" on atlas_private.system_release_checkpoints;
create policy "service role manages system releases" on atlas_private.system_release_checkpoints
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages system events" on atlas_private.system_events;
create policy "service role manages system events" on atlas_private.system_events
  for all to service_role using (true) with check (true);

revoke all on atlas_private.system_settings from public,anon,authenticated;
revoke all on atlas_private.system_services from public,anon,authenticated;
revoke all on atlas_private.system_data_sources from public,anon,authenticated;
revoke all on atlas_private.system_jobs from public,anon,authenticated;
revoke all on atlas_private.system_incidents from public,anon,authenticated;
revoke all on atlas_private.system_release_checkpoints from public,anon,authenticated;
revoke all on atlas_private.system_events from public,anon,authenticated;
grant all on atlas_private.system_settings to service_role;
grant all on atlas_private.system_services to service_role;
grant all on atlas_private.system_data_sources to service_role;
grant all on atlas_private.system_jobs to service_role;
grant all on atlas_private.system_incidents to service_role;
grant all on atlas_private.system_release_checkpoints to service_role;
grant all on atlas_private.system_events to service_role;

drop trigger if exists system_settings_touch on atlas_private.system_settings;
create trigger system_settings_touch before update on atlas_private.system_settings
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_services_touch on atlas_private.system_services;
create trigger system_services_touch before update on atlas_private.system_services
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_sources_touch on atlas_private.system_data_sources;
create trigger system_sources_touch before update on atlas_private.system_data_sources
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_jobs_touch on atlas_private.system_jobs;
create trigger system_jobs_touch before update on atlas_private.system_jobs
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_incidents_touch on atlas_private.system_incidents;
create trigger system_incidents_touch before update on atlas_private.system_incidents
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists system_releases_touch on atlas_private.system_release_checkpoints;
create trigger system_releases_touch before update on atlas_private.system_release_checkpoints
  for each row execute function atlas_private.touch_updated_at();

alter table atlas_private.integration_connections
  drop constraint if exists integration_connections_category_check;
alter table atlas_private.integration_connections
  add constraint integration_connections_category_check
  check (category in (
    'social','reputation','business_profile','other','infrastructure','development',
    'hosting','email','storage','operations','payments'
  ));

insert into atlas_private.system_settings (
  setting_key,environment,production_sync_enabled,destructive_actions_enabled,
  automatic_retries_enabled,rollback_actions_enabled,secrets_visible_in_ui,metadata
) values (
  'va','preview',false,false,false,false,false,
  jsonb_build_object(
    'checkpoint','I','system_mode','view_only','production_source_mutation',false,
    'incident_retry_controls','not_enabled','secrets_and_tokens_returned',false
  )
)
on conflict (setting_key) do update set
  environment='preview',production_sync_enabled=false,destructive_actions_enabled=false,
  automatic_retries_enabled=false,rollback_actions_enabled=false,secrets_visible_in_ui=false,
  metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_services (
  service_key,label,category,status,environment,version_label,check_strategy,
  last_checked_at,last_success_at,last_failure_at,failure_code,failure_message,
  production_impact,preview_impact,metadata,sort_order
) values
  ('web-app','Atlas web application','application','healthy','preview','Sprint 4 Phase 3','client',now(),now(),null,null,null,'none','none',jsonb_build_object('health_source','active_browser_session'),10),
  ('production-auth','Production VÁ authentication','authentication','healthy','production',null,'runtime',now(),now(),null,null,null,'none','none',jsonb_build_object('project_ref','dnefgcmjcgxlynycxkts'),20),
  ('private-database','Private Sprint database','database','healthy','preview',null,'database',now(),now(),null,null,null,'none','none',jsonb_build_object('project_ref','uhbamqetppqmygesoeeh'),30),
  ('private-storage','Private Atlas storage','storage','healthy','preview',null,'database',now(),now(),null,null,null,'none','none',jsonb_build_object('expected_bucket','atlas-profile-photos'),40),
  ('edge-functions','Atlas Edge Functions','edge_function','healthy','preview','0.1.0','runtime',now(),now(),null,null,null,'none','none',jsonb_build_object('current_gateway','atlas-system'),50),
  ('reports-service','Reports service','module','degraded','preview','Checkpoint H','incident',now(),null,now(),'REPORTS_LOADING_STALL','Authenticated Reports snapshot remains under investigation.','none','degraded',jsonb_build_object('checkpoint','H','deferred_for_system_checkpoint',true),60),
  ('google-drive-sync','Google Drive automatic sync','integration','not_connected','external',null,'registry',now(),null,null,null,null,'none','none',jsonb_build_object('manual_private_import_only',true),70),
  ('social-publishing','Automatic social publishing','safeguard','disabled_by_policy','external',null,'registry',now(),null,null,null,null,'none','none',jsonb_build_object('planning_enabled',true,'automatic_actions',false),80),
  ('production-sync','Automatic production promotion','safeguard','disabled_by_policy','production',null,'registry',now(),null,null,null,null,'none','none',jsonb_build_object('preview_only',true),90)
on conflict (service_key) do update set
  label=excluded.label,category=excluded.category,status=excluded.status,
  environment=excluded.environment,version_label=excluded.version_label,
  check_strategy=excluded.check_strategy,last_checked_at=excluded.last_checked_at,
  last_success_at=excluded.last_success_at,last_failure_at=excluded.last_failure_at,
  failure_code=excluded.failure_code,failure_message=excluded.failure_message,
  production_impact=excluded.production_impact,preview_impact=excluded.preview_impact,
  metadata=excluded.metadata,sort_order=excluded.sort_order,updated_at=now();

insert into atlas_private.integration_connections (
  provider_key,label,category,status,capabilities,requirements,authorization_state,
  publishing_permission_state,analytics_permission_state,last_verified_at,metadata
) values
  ('supabase','Supabase','infrastructure','connected',jsonb_build_object('database',true,'auth',true,'storage',true,'edge_functions',true),jsonb_build_object('production_auth_project',true,'private_preview_project',true),'authorized','not_supported','not_supported',now(),jsonb_build_object('runtime_gateway_verified',true,'secrets_in_browser',false)),
  ('github','GitHub repository','development','connected',jsonb_build_object('deployment_source',true,'runtime_repository_write',false),jsonb_build_object('repository','imadelmoubarik4-cell/-V-OS-','branch','agent/sprint-4-phase-3-atlas-brain'),'authorized','not_supported','not_supported',now(),jsonb_build_object('public_branch_metadata_only',true,'credentials_stored_in_atlas',false)),
  ('netlify','Netlify','hosting','connected',jsonb_build_object('preview_hosting',true,'automatic_deploy_from_branch',true),jsonb_build_object('site','os-vabar','deploy_preview',true),'authorized','not_supported','not_supported',now(),jsonb_build_object('runtime_api_access',false,'current_host_from_browser',true)),
  ('gmail','Gmail','email','not_connected',jsonb_build_object('supplier_document_search','requires_oauth'),jsonb_build_object('atlas_runtime_oauth',true),'not_connected','not_supported','not_supported',null,jsonb_build_object('assistant_connector_does_not_equal_atlas_runtime_connection',true)),
  ('outlook','Microsoft Outlook','email','not_connected',jsonb_build_object('supplier_document_search','requires_oauth'),jsonb_build_object('atlas_runtime_oauth',true),'not_connected','not_supported','not_supported',null,jsonb_build_object('assistant_connector_does_not_equal_atlas_runtime_connection',true)),
  ('google-drive','Google Drive','storage','not_connected',jsonb_build_object('knowledge_sync','requires_oauth','document_import','manual_private_only'),jsonb_build_object('atlas_runtime_oauth',true,'folder_scope',true),'not_connected','not_supported','not_supported',null,jsonb_build_object('automatic_sync_enabled',false)),
  ('dineout','Dineout','operations','not_connected',jsonb_build_object('sales',false,'bookings',false,'pos',false),jsonb_build_object('verified_api_access',true,'product_mapping',true),'not_connected','not_supported','not_requested',null,jsonb_build_object('sales_reporting_disabled',true)),
  ('teya','Teya','payments','not_connected',jsonb_build_object('settlements',false,'payment_metrics',false),jsonb_build_object('verified_api_access',true),'not_connected','not_supported','not_requested',null,jsonb_build_object('payment_reporting_disabled',true))
on conflict (provider_key) do update set
  label=excluded.label,category=excluded.category,status=excluded.status,
  capabilities=excluded.capabilities,requirements=excluded.requirements,
  authorization_state=excluded.authorization_state,
  publishing_permission_state=excluded.publishing_permission_state,
  analytics_permission_state=excluded.analytics_permission_state,
  last_verified_at=excluded.last_verified_at,
  metadata=atlas_private.integration_connections.metadata||excluded.metadata,
  updated_at=now();

insert into atlas_private.system_data_sources (
  source_key,label,domain,source_type,status,is_live,is_historical,trusted_for_brain,
  record_count,last_successful_at,last_attempted_at,freshness_hours,freshness_state,
  source_scope,error_code,error_message,metadata,sort_order
) values
  ('production-profiles','Production team profiles','people','live','connected',true,false,true,null,null,now(),24,'current','production',null,null,'{}'::jsonb,10),
  ('production-inventory','Production inventory','inventory','live','connected',true,false,true,null,null,now(),24,'current','production',null,null,'{}'::jsonb,20),
  ('production-recipes','Production recipes','recipes','live','connected',true,false,true,null,null,now(),24,'current','production',null,null,'{}'::jsonb,30),
  ('production-suppliers','Production suppliers','purchasing','live','connected',true,false,true,null,null,now(),72,'current','production',null,null,'{}'::jsonb,40),
  ('production-movements','Production inventory movements','inventory','live','connected',true,false,true,null,null,now(),24,'current','production',null,null,'{}'::jsonb,50),
  ('sprint3-private-import','Sprint 3 private import batches','data_review','private_import','partial',false,false,false,null,null,now(),null,'unknown','preview',null,null,jsonb_build_object('private',true),60),
  ('sprint3-review','Real VÁ Data review queue','data_review','private_import','partial',false,false,false,null,null,now(),null,'unknown','preview',null,null,jsonb_build_object('promotion_blocked_until_review',true),70),
  ('july-2026-inventory','July 2026 inventory evidence','inventory','historical_snapshot','historical',false,true,false,220,'2026-07-26'::date,now(),null,'historical','preview',null,null,jsonb_build_object('effective_from','2026-07-19','effective_to','2026-07-26','live_quantity',false),80),
  ('operations-routines','Operations routines','operations','live','connected',true,false,true,null,null,now(),24,'current','preview',null,null,'{}'::jsonb,90),
  ('temperature-logs','Temperature logs','operations','live','connected',true,false,true,null,null,now(),24,'current','preview',null,null,'{}'::jsonb,100),
  ('shift-publications','Published schedules','people','live','connected',true,false,true,null,null,now(),24,'current','preview',null,null,'{}'::jsonb,110),
  ('knowledge-library','Knowledge library','knowledge','live','connected',true,false,false,null,null,now(),72,'current','preview',null,null,'{}'::jsonb,120),
  ('marketing-planning','Marketing planning','marketing','live','connected',true,false,false,null,null,now(),72,'current','preview',null,null,'{}'::jsonb,130),
  ('sales-history','Sales history','sales','integration','not_connected',false,false,false,0,null,now(),null,'not_connected','external','SOURCE_NOT_CONNECTED','Verified sales API and product mapping are not connected.',jsonb_build_object('forecasting_disabled',true),140),
  ('bookings','Bookings','sales','integration','not_connected',false,false,false,0,null,now(),null,'not_connected','external','SOURCE_NOT_CONNECTED','Verified booking source is not connected.',jsonb_build_object('forecasting_disabled',true),150)
on conflict (source_key) do update set
  label=excluded.label,domain=excluded.domain,source_type=excluded.source_type,
  status=excluded.status,is_live=excluded.is_live,is_historical=excluded.is_historical,
  trusted_for_brain=excluded.trusted_for_brain,freshness_hours=excluded.freshness_hours,
  freshness_state=excluded.freshness_state,source_scope=excluded.source_scope,
  error_code=excluded.error_code,error_message=excluded.error_message,
  metadata=excluded.metadata,sort_order=excluded.sort_order,updated_at=now();

insert into atlas_private.system_jobs (
  job_key,label,category,schedule_description,status,is_automatic,retry_enabled,
  write_scope,last_started_at,last_succeeded_at,last_failed_at,next_run_at,
  last_error_code,last_error_message,metadata,sort_order
) values
  ('sprint3-review','Sprint 3 source review','data_review','Manager-driven review queue','waiting',false,false,'private_review_only',now(),null,null,null,null,null,jsonb_build_object('pending_rows',1104),10),
  ('operations-routines','Operations routine generation','operations','Daily and weekly routine materialization','healthy',true,false,'private_operations',now(),now(),null,null,null,null,jsonb_build_object('manager_controls_in_operations',true),20),
  ('temperature-reminder','Daily temperature reminder','operations','Daily during venue operations','healthy',true,false,'notification_only',now(),now(),null,null,null,null,'{}'::jsonb,30),
  ('team-unread','Team unread refresh','communications','Client refresh while signed in','healthy',true,false,'read_only',now(),now(),null,null,null,null,'{}'::jsonb,40),
  ('marketing-reminders','Marketing reminders','marketing','Content planning reminders','healthy',true,false,'private_marketing',now(),now(),null,null,null,null,jsonb_build_object('publishing_disabled',true),50),
  ('shift-publication','Shift publication notifications','people','On manager publication','healthy',false,false,'private_schedule_and_announcement',now(),now(),null,null,null,null,jsonb_build_object('production_shift_sync',false),60),
  ('knowledge-announcements','Knowledge publication announcements','knowledge','On manager publication','healthy',false,false,'private_knowledge_and_announcement',now(),now(),null,null,null,null,'{}'::jsonb,70),
  ('reports-snapshot','Reports snapshot','reports','On report request','failed',true,false,'read_only',now(),null,now(),null,'REPORTS_LOADING_STALL','Authenticated Reports snapshot has not passed browser acceptance.',jsonb_build_object('deferred',true,'production_impact','none'),80),
  ('google-drive-sync','Google Drive automatic synchronization','integration','Not scheduled','not_connected',false,false,'none',null,null,null,null,'SOURCE_NOT_CONNECTED',null,jsonb_build_object('manual_private_import_only',true),90),
  ('social-publishing','Automatic social publishing','integration','Disabled by policy','disabled_by_policy',false,false,'none',null,null,null,null,null,null,jsonb_build_object('planning_only',true),100)
on conflict (job_key) do update set
  label=excluded.label,category=excluded.category,schedule_description=excluded.schedule_description,
  status=excluded.status,is_automatic=excluded.is_automatic,retry_enabled=excluded.retry_enabled,
  write_scope=excluded.write_scope,last_started_at=excluded.last_started_at,
  last_succeeded_at=excluded.last_succeeded_at,last_failed_at=excluded.last_failed_at,
  next_run_at=excluded.next_run_at,last_error_code=excluded.last_error_code,
  last_error_message=excluded.last_error_message,metadata=excluded.metadata,
  sort_order=excluded.sort_order,updated_at=now();

insert into atlas_private.system_release_checkpoints (
  checkpoint_key,label,environment,status,repository,branch,base_branch,pull_request_number,
  commit_sha,deployment_url,migration_status,functions_status,production_sync_state,
  last_known_healthy_reference,rollback_reference,release_blockers,metadata
) values (
  'sprint4-phase3','Sprint 4 Phase 3 preview','preview','degraded','imadelmoubarik4-cell/-V-OS-',
  'agent/sprint-4-phase-3-atlas-brain','agent/sprint-4-atlas-brain-daily-briefing',5,
  null,'https://deploy-preview-5--os-vabar.netlify.app','System migration applied',
  'System gateway active','disabled',
  'agent/sprint-4-atlas-brain-daily-briefing@a6edfd941caeb896a63e29b36353083cf050604d',
  'PR #5 base checkpoint',
  jsonb_build_array(jsonb_build_object(
    'key','reports-browser-acceptance',
    'label','Reports authenticated snapshot remains unresolved',
    'severity','degraded','production_impact','none','preview_impact','Reports unavailable'
  )),
  jsonb_build_object('destructive_rollback_enabled',false,'automatic_promotion_enabled',false)
)
on conflict (checkpoint_key) do update set
  label=excluded.label,environment=excluded.environment,status=excluded.status,
  repository=excluded.repository,branch=excluded.branch,base_branch=excluded.base_branch,
  pull_request_number=excluded.pull_request_number,deployment_url=excluded.deployment_url,
  migration_status=excluded.migration_status,functions_status=excluded.functions_status,
  production_sync_state=excluded.production_sync_state,
  last_known_healthy_reference=excluded.last_known_healthy_reference,
  rollback_reference=excluded.rollback_reference,release_blockers=excluded.release_blockers,
  metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_incidents (
  incident_key,service_key,title,severity,status,summary,production_impact,preview_impact,
  first_occurred_at,last_occurred_at,occurrence_count,metadata
) values (
  'reports-loading-stall','reports-service','Reports authenticated snapshot does not complete',
  'degraded','open',
  'The Reports interface remains on Loading Reports for authenticated preview users. Database parser and gateway fixes were attempted, but browser acceptance has not passed. The issue is deferred while Checkpoint I proceeds.',
  'none','degraded','2026-08-04T11:00:00Z'::timestamptz,now(),1,
  jsonb_build_object('checkpoint','H','deferred',true,'release_blocker',true,'production_records_changed',false)
)
on conflict (incident_key) do update set
  service_key=excluded.service_key,title=excluded.title,severity=excluded.severity,
  status='open',summary=excluded.summary,production_impact=excluded.production_impact,
  preview_impact=excluded.preview_impact,last_occurred_at=now(),
  metadata=excluded.metadata,updated_at=now();

insert into atlas_private.system_events (
  event_type,domain,entity_key,actor_label,actor_role,payload
) values (
  'checkpoint_created','system','checkpoint-i','Atlas migration','system',
  jsonb_build_object('checkpoint','I','mode','view_only','production_sync',false,'reports_incident_preserved',true)
);

comment on table atlas_private.system_incidents is
  'View-only Atlas incident registry. Resolution and retry controls are intentionally disabled in Checkpoint I.';
comment on table atlas_private.system_release_checkpoints is
  'Preview and production release checkpoints, blockers and recovery references without destructive controls.';
