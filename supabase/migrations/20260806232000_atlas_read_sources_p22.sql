-- Phase 2 / P2.2 — Read-only source feeds.
--
-- This migration extends the existing Checkpoint G Knowledge source model. It
-- does not create a second provider registry: provider health remains canonical
-- in atlas_private.integration_connections. The public wrappers are callable
-- only by service_role through the authenticated atlas-read-sources gateway.
-- No source body, credential, token, private URL or production row is returned.

do $p22_invariants$
begin
  if to_regclass('atlas_private.integration_connections') is null then
    raise exception 'P2.2 requires the canonical P2.0 connection registry';
  end if;
  if to_regclass('atlas_private.knowledge_sources') is null then
    raise exception 'P2.2 requires the Checkpoint G Knowledge source model';
  end if;
  if to_regclass('atlas_private.import_batches') is null then
    raise exception 'P2.2 requires the private Real VA source-batch model';
  end if;
end
$p22_invariants$;

alter table atlas_private.knowledge_sources
  add column if not exists connection_key text,
  add column if not exists external_document_id text,
  add column if not exists external_modified_at timestamptz,
  add column if not exists last_checked_at timestamptz,
  add column if not exists content_fingerprint text,
  add column if not exists freshness_state text not null default 'unverified';

alter table atlas_private.knowledge_sources
  drop constraint if exists knowledge_sources_connection_key_fkey,
  drop constraint if exists knowledge_sources_freshness_state_check,
  drop constraint if exists knowledge_sources_external_document_id_check,
  drop constraint if exists knowledge_sources_content_fingerprint_check;

alter table atlas_private.knowledge_sources
  add constraint knowledge_sources_connection_key_fkey
    foreign key (connection_key)
    references atlas_private.integration_connections(provider_key)
    on update cascade on delete set null,
  add constraint knowledge_sources_freshness_state_check
    check (freshness_state in ('current','stale','unverified','error')),
  add constraint knowledge_sources_external_document_id_check
    check (external_document_id is null or char_length(external_document_id) <= 1000),
  add constraint knowledge_sources_content_fingerprint_check
    check (content_fingerprint is null or content_fingerprint ~ '^[A-Fa-f0-9]{32,128}$');

create index if not exists knowledge_sources_connection_freshness_idx
  on atlas_private.knowledge_sources(connection_key,freshness_state,last_checked_at desc);
create unique index if not exists knowledge_sources_external_document_uidx
  on atlas_private.knowledge_sources(connection_key,external_document_id)
  where connection_key is not null and external_document_id is not null;

create table if not exists atlas_private.read_source_events (
  id uuid primary key default gen_random_uuid(),
  connection_key text references atlas_private.integration_connections(provider_key)
    on update cascade on delete set null,
  event_type text not null check (event_type in (
    'foundation_initialized','snapshot_generated','source_verified',
    'source_degraded','authorization_required','source_retired'
  )),
  source_key text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists read_source_events_created_idx
  on atlas_private.read_source_events(created_at desc);
create index if not exists read_source_events_connection_idx
  on atlas_private.read_source_events(connection_key,created_at desc)
  where connection_key is not null;

alter table atlas_private.read_source_events enable row level security;
revoke all on atlas_private.read_source_events from public,anon,authenticated;
grant select,insert on atlas_private.read_source_events to service_role;
drop policy if exists read_source_events_service_select
  on atlas_private.read_source_events;
create policy read_source_events_service_select
  on atlas_private.read_source_events for select to service_role using (true);
drop policy if exists read_source_events_service_insert
  on atlas_private.read_source_events;
create policy read_source_events_service_insert
  on atlas_private.read_source_events for insert to service_role with check (true);

create or replace function atlas_private.read_source_events_append_only()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  raise exception 'Read-source event history is append-only' using errcode='42501';
end;
$function$;
revoke all on function atlas_private.read_source_events_append_only()
  from public,anon,authenticated;
grant execute on function atlas_private.read_source_events_append_only()
  to service_role;
drop trigger if exists read_source_events_append_only
  on atlas_private.read_source_events;
create trigger read_source_events_append_only
before update or delete on atlas_private.read_source_events
for each row execute function atlas_private.read_source_events_append_only();

insert into atlas_private.integration_connections (
  provider_key,label,category,status,capabilities,requirements,metadata,
  authorization_state,publishing_permission_state,analytics_permission_state,
  environment,owner_module,provider_type,health_state,check_strategy,
  stale_after_seconds,credential_source,active
)
values (
  'atlas-source-library','Atlas private source library','storage','pending_review',
  '{"metadata_read":true,"source_body_returned":false,"automatic_sync":false}'::jsonb,
  '{"private_source_batches":true,"manager_only_metadata":true,"content_not_returned":true}'::jsonb,
  '{"checkpoint":"P2.2","restored_real_va_checkpoint":true,"credentials_stored":false}'::jsonb,
  'authorized','not_supported','not_supported','atlas_private','knowledge',
  'document_feed','verifying','branch_rpc',3600,'none',true
)
on conflict (provider_key) do update
set label=excluded.label,
    category=excluded.category,
    capabilities=excluded.capabilities,
    requirements=excluded.requirements,
    metadata=atlas_private.integration_connections.metadata || excluded.metadata,
    authorization_state=excluded.authorization_state,
    environment=excluded.environment,
    owner_module=excluded.owner_module,
    provider_type=excluded.provider_type,
    check_strategy=excluded.check_strategy,
    stale_after_seconds=excluded.stale_after_seconds,
    credential_source=excluded.credential_source,
    active=true,
    updated_at=now();

update atlas_private.integration_connections
set owner_module='knowledge',
    requirements=requirements || jsonb_build_object(
      'read_only',true,
      'source_scope_required',true,
      'automatic_sync',false
    ),
    metadata=metadata || jsonb_build_object(
      'checkpoint','P2.2',
      'source_bodies_returned',false,
      'credentials_stored_in_registry',false
    )
where provider_key in ('google-drive','gmail','outlook');

select set_config('atlas.allow_high_risk_capability_grant','on',true);
insert into atlas_private.connection_capability_grants(
  connection_key,capability_key,capability_kind,grant_state,risk_level,
  manager_approval_required,automatic_execution_allowed,metadata
)
values
  ('atlas-source-library','source.metadata.read','read','granted','low',false,false,
    '{"manager_only":true,"source_body_returned":false}'::jsonb),
  ('atlas-source-library','source.content.read','read','read_only','medium',true,false,
    '{"not_exposed_by_p2_2":true}'::jsonb),
  ('atlas-source-library','source.sync.write','write','blocked','high',true,false,
    '{"automatic_sync":false}'::jsonb),
  ('google-drive','documents.metadata.read','read','verification_required','medium',true,false,
    '{"oauth_required":true,"folder_scope_required":true}'::jsonb),
  ('google-drive','documents.sync.write','write','blocked','high',true,false,
    '{"automatic_sync":false}'::jsonb),
  ('gmail','messages.metadata.read','read','verification_required','medium',true,false,
    '{"oauth_required":true,"mailbox_scope_required":true}'::jsonb),
  ('gmail','messages.sync.write','write','blocked','high',true,false,
    '{"automatic_sync":false}'::jsonb),
  ('outlook','messages.metadata.read','read','verification_required','medium',true,false,
    '{"oauth_required":true,"mailbox_scope_required":true}'::jsonb),
  ('outlook','messages.sync.write','write','blocked','high',true,false,
    '{"automatic_sync":false}'::jsonb)
on conflict (connection_key,capability_key) do update
set capability_kind=excluded.capability_kind,
    grant_state=excluded.grant_state,
    risk_level=excluded.risk_level,
    manager_approval_required=excluded.manager_approval_required,
    automatic_execution_allowed=false,
    metadata=excluded.metadata,
    updated_at=now();

insert into atlas_private.connection_dependencies(
  connection_key,module_key,requirement_level,required_capabilities,safety_boundary
)
values
  ('atlas-source-library','knowledge','required',array['source.metadata.read'],
    'Metadata-only manager feed. Source bodies and private URLs remain excluded.'),
  ('google-drive','knowledge','optional',array['documents.metadata.read'],
    'OAuth and folder scope are required. Automatic synchronization remains disabled.'),
  ('gmail','knowledge','future',array['messages.metadata.read'],
    'No mailbox read occurs until a dedicated Atlas OAuth scope is approved.'),
  ('outlook','knowledge','future',array['messages.metadata.read'],
    'No mailbox read occurs until a dedicated Atlas OAuth scope is approved.')
on conflict (connection_key,module_key) do update
set requirement_level=excluded.requirement_level,
    required_capabilities=excluded.required_capabilities,
    safety_boundary=excluded.safety_boundary,
    updated_at=now();

create or replace function atlas_private.knowledge_sync_drive_connection_status()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  if new.provider_key <> 'google-drive' then
    return new;
  end if;

  update atlas_private.knowledge_settings
  set google_drive_connection_status = case
        when new.health_state='healthy' then 'connected'
        when new.health_state='authorization_required' then 'waiting_authorization'
        when new.health_state='degraded' then 'degraded'
        when new.health_state='expired' then 'expired'
        else 'not_connected'
      end,
      automatic_drive_sync_enabled=false,
      metadata=metadata || jsonb_build_object(
        'canonical_connection_key','google-drive',
        'canonical_health_state',new.health_state,
        'p2_2_read_only',true,
        'automatic_sync_enabled',false
      ),
      updated_at=now()
  where setting_key='va';
  return new;
end;
$function$;
revoke all on function atlas_private.knowledge_sync_drive_connection_status()
  from public,anon,authenticated;
grant execute on function atlas_private.knowledge_sync_drive_connection_status()
  to service_role;
drop trigger if exists integration_connections_knowledge_drive_sync
  on atlas_private.integration_connections;
create trigger integration_connections_knowledge_drive_sync
after insert or update of health_state on atlas_private.integration_connections
for each row execute function atlas_private.knowledge_sync_drive_connection_status();

-- Align Checkpoint G immediately with the canonical provider state.
update atlas_private.knowledge_settings settings
set google_drive_connection_status = case connection.health_state
      when 'healthy' then 'connected'
      when 'authorization_required' then 'waiting_authorization'
      when 'degraded' then 'degraded'
      when 'expired' then 'expired'
      else 'not_connected'
    end,
    automatic_drive_sync_enabled=false,
    metadata=settings.metadata || jsonb_build_object(
      'canonical_connection_key','google-drive',
      'canonical_health_state',connection.health_state,
      'p2_2_read_only',true,
      'automatic_sync_enabled',false
    ),
    updated_at=now()
from atlas_private.integration_connections connection
where settings.setting_key='va'
  and connection.provider_key='google-drive';

create or replace function atlas_private.read_sources_assert_actor(p_actor_role text)
returns void
language plpgsql
stable
security invoker
set search_path=''
as $function$
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Read-only Source Center is available only to managers and administrators';
  end if;
end;
$function$;

create or replace function atlas_private.read_sources_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit,200),1),500);
  local_sources jsonb;
  attributed_sources jsonb;
  connection_rows jsonb;
  event_rows jsonb;
  current_count integer;
  stale_count integer;
  unverified_count integer;
begin
  perform atlas_private.read_sources_assert_actor(p_actor_role);

  select coalesce(jsonb_agg(jsonb_build_object(
    'source_id',batch.id,
    'connection_key','atlas-source-library',
    'source_key',batch.batch_key,
    'source_label',coalesce(batch.file_name,batch.batch_key),
    'source_type',batch.entity_scope,
    'file_extension',batch.file_extension,
    'source_version',batch.source_hash,
    'record_counts',batch.record_counts,
    'current_stage',batch.current_stage,
    'progress_percent',batch.progress_percent,
    'last_modified_at',batch.updated_at,
    'freshness_state',case
      when batch.source_hash is not null and batch.progress_percent=100 then 'current'
      when batch.updated_at < now()-interval '180 days' then 'stale'
      else 'unverified'
    end,
    'content_access','metadata_only',
    'private_url_returned',false
  ) order by batch.updated_at desc,batch.batch_key),'[]'::jsonb)
  into local_sources
  from (
    select * from atlas_private.import_batches
    order by updated_at desc,batch_key
    limit safe_limit
  ) batch;

  select coalesce(jsonb_agg(jsonb_build_object(
    'source_id',source.id,
    'article_id',source.article_id,
    'connection_key',source.connection_key,
    'source_type',source.source_type,
    'source_label',source.source_label,
    'source_reference',source.source_reference,
    'source_version',source.source_version,
    'external_document_id',source.external_document_id,
    'external_modified_at',source.external_modified_at,
    'last_checked_at',source.last_checked_at,
    'last_verified_at',source.last_verified_at,
    'freshness_state',source.freshness_state,
    'connection_status',source.connection_status,
    'visible_to_staff',source.visible_to_staff,
    'private_url_returned',false
  ) order by source.updated_at desc,source.source_label),'[]'::jsonb)
  into attributed_sources
  from (
    select * from atlas_private.knowledge_sources
    order by updated_at desc,source_label
    limit safe_limit
  ) source;

  select coalesce(jsonb_agg(jsonb_build_object(
    'connection_key',connection.provider_key,
    'label',connection.label,
    'provider_type',connection.provider_type,
    'state',atlas_private.connection_effective_state(
      connection.health_state,connection.last_succeeded_at,
      connection.token_expires_at,connection.stale_after_seconds
    ),
    'authorization_state',connection.authorization_state,
    'last_succeeded_at',connection.last_succeeded_at,
    'last_failed_at',connection.last_failed_at,
    'last_error_code',connection.last_error_code,
    'last_error_summary',connection.last_error_summary,
    'automatic_sync',false
  ) order by connection.provider_key),'[]'::jsonb)
  into connection_rows
  from atlas_private.integration_connections connection
  where connection.provider_key in (
    'atlas-source-library','google-drive','gmail','outlook'
  ) and connection.active;

  select coalesce(jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc),'[]'::jsonb)
  into event_rows
  from (
    select id,connection_key,event_type,source_key,actor_label,actor_role,payload,created_at
    from atlas_private.read_source_events
    order by created_at desc
    limit 60
  ) event_row;

  select count(*) filter (where source_hash is not null and progress_percent=100),
         count(*) filter (where updated_at < now()-interval '180 days'),
         count(*) filter (where source_hash is null or progress_percent<100)
  into current_count,stale_count,unverified_count
  from atlas_private.import_batches;

  return jsonb_build_object(
    'version','atlas-read-sources/0.1.0',
    'generated_at',now(),
    'summary',jsonb_build_object(
      'private_source_batches',(select count(*) from atlas_private.import_batches),
      'unified_review_rows',(select count(*) from atlas_private.review_queue),
      'attributed_sources',(select count(*) from atlas_private.knowledge_sources),
      'current_sources',coalesce(current_count,0),
      'stale_sources',coalesce(stale_count,0),
      'unverified_sources',coalesce(unverified_count,0),
      'external_connections_healthy',(
        select count(*) from atlas_private.integration_connections connection
        where connection.provider_key in ('google-drive','gmail','outlook')
          and atlas_private.connection_effective_state(
            connection.health_state,connection.last_succeeded_at,
            connection.token_expires_at,connection.stale_after_seconds
          )='healthy'
      )
    ),
    'connections',connection_rows,
    'local_sources',local_sources,
    'attributed_sources',attributed_sources,
    'events',event_rows,
    'permissions',jsonb_build_object(
      'can_view',true,
      'can_connect_external_sources',false,
      'can_run_automatic_sync',false,
      'can_view_private_urls',false,
      'can_view_source_bodies',false,
      'read_only',true
    ),
    'trust',jsonb_build_object(
      'canonical_connection_registry',true,
      'source_bodies_returned',false,
      'private_urls_returned',false,
      'credentials_returned',false,
      'automatic_sync_enabled',false,
      'production_source_mutation',false
    ),
    'actor',jsonb_build_object('id',p_actor_id,'role',p_actor_role)
  );
end;
$function$;

create or replace function atlas_private.read_sources_ping()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select jsonb_build_object(
    'version','atlas-read-sources/0.1.0',
    'checked_at',now(),
    'private_source_batches',(select count(*) from atlas_private.import_batches),
    'unified_review_rows',(select count(*) from atlas_private.review_queue),
    'source_bodies_returned',false,
    'automatic_sync_enabled',false
  );
$function$;

create or replace function public.atlas_read_sources_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.read_sources_snapshot(p_actor_id,p_actor_role,p_limit);
$function$;

create or replace function public.atlas_read_sources_ping()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.read_sources_ping();
$function$;

revoke all on function atlas_private.read_sources_assert_actor(text)
  from public,anon,authenticated;
revoke all on function atlas_private.read_sources_snapshot(uuid,text,integer)
  from public,anon,authenticated;
revoke all on function atlas_private.read_sources_ping()
  from public,anon,authenticated;
revoke all on function public.atlas_read_sources_snapshot(uuid,text,integer)
  from public,anon,authenticated;
revoke all on function public.atlas_read_sources_ping()
  from public,anon,authenticated;
grant execute on function atlas_private.read_sources_assert_actor(text) to service_role;
grant execute on function atlas_private.read_sources_snapshot(uuid,text,integer) to service_role;
grant execute on function atlas_private.read_sources_ping() to service_role;
grant execute on function public.atlas_read_sources_snapshot(uuid,text,integer) to service_role;
grant execute on function public.atlas_read_sources_ping() to service_role;

insert into atlas_private.read_source_events(
  connection_key,event_type,actor_label,actor_role,payload
)
select 'atlas-source-library','foundation_initialized','Atlas migration','system',
       jsonb_build_object(
         'checkpoint','P2.2',
         'private_source_batches',(select count(*) from atlas_private.import_batches),
         'source_bodies_returned',false,
         'automatic_sync_enabled',false
       )
where not exists (
  select 1 from atlas_private.read_source_events
  where event_type='foundation_initialized'
    and connection_key='atlas-source-library'
);

comment on table atlas_private.read_source_events is
  'Append-only P2.2 source-feed evidence. No source body, private URL or credential is stored.';
comment on function public.atlas_read_sources_snapshot(uuid,text,integer) is
  'Service-role-only P2.2 metadata snapshot. Browser access is available only through atlas-read-sources.';

notify pgrst,'reload schema';
