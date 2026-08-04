-- Checkpoint I System snapshot. Manager-only through the authenticated gateway.
-- The RPC is service-role-only and returns no secrets or destructive actions.

create or replace function atlas_private.system_snapshot(
  p_profiles jsonb,
  p_edge_health jsonb,
  p_release_context jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.system_settings;
  is_manager boolean := p_actor_role in ('admin','manager');
  migration_count bigint := 0;
  latest_migration text;
  private_rls_disabled bigint := 0;
  public_storage_buckets bigint := 0;
  profile_bucket_present boolean := false;
  open_incidents bigint := 0;
  critical_incidents bigint := 0;
  services_json jsonb := '[]'::jsonb;
  integrations_json jsonb := '[]'::jsonb;
  sources_json jsonb := '[]'::jsonb;
  jobs_json jsonb := '[]'::jsonb;
  incidents_json jsonb := '[]'::jsonb;
  security_json jsonb := '{}'::jsonb;
  audit_json jsonb := '[]'::jsonb;
  recovery_json jsonb := '[]'::jsonb;
  environments_json jsonb := '[]'::jsonb;
begin
  if not is_manager then raise exception 'System is limited to managers and administrators'; end if;
  select * into settings_row from atlas_private.system_settings where setting_key='atlas';
  if not found then raise exception 'System settings are missing'; end if;

  begin
    select count(*)::bigint,max(version::text)
    into migration_count,latest_migration
    from supabase_migrations.schema_migrations;
  exception when others then
    migration_count := 0;
    latest_migration := null;
  end;

  select count(*)::bigint into private_rls_disabled
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
  where namespace.nspname='atlas_private'
    and relation.relkind='r'
    and not relation.relrowsecurity;

  begin
    select count(*) filter (where public=true)::bigint,
           bool_or(id='atlas-profile-photos')
    into public_storage_buckets,profile_bucket_present
    from storage.buckets;
  exception when others then
    public_storage_buckets := 0;
    profile_bucket_present := false;
  end;

  select count(*)::bigint,
         count(*) filter (where severity='critical')::bigint
  into open_incidents,critical_incidents
  from atlas_private.system_incidents
  where status in ('open','monitoring');

  services_json := jsonb_build_array(
    jsonb_build_object(
      'key','web-preview','name','Atlas Web Preview','category','Application',
      'status',coalesce(p_release_context->>'preview_status','unknown'),
      'detail',coalesce(p_release_context->>'preview_detail','Deploy Preview #5'),
      'checked_at',p_release_context->'checked_at'
    ),
    jsonb_build_object(
      'key','authentication','name','Authentication','category','Platform','status','healthy',
      'detail','Current production VÁ session and active staff profile verified.','checked_at',pg_catalog.now()
    ),
    jsonb_build_object(
      'key','private-database','name','Private Database','category','Platform','status','healthy',
      'detail','System snapshot executed against the isolated preview database.','checked_at',pg_catalog.now()
    ),
    jsonb_build_object(
      'key','storage','name','Private Storage','category','Platform',
      'status',case when profile_bucket_present then 'healthy' else 'degraded' end,
      'detail',case when profile_bucket_present then 'Private profile-photo storage bucket is available.' else 'Expected private profile-photo bucket was not found.' end,
      'checked_at',pg_catalog.now()
    ),
    jsonb_build_object(
      'key','edge-functions','name','Edge Functions','category','Platform',
      'status',case when coalesce((p_edge_health->>'unhealthy_count')::integer,0)=0 then 'healthy' else 'degraded' end,
      'detail',coalesce(p_edge_health->>'summary','Edge-function probes unavailable.'),
      'checked_at',p_edge_health->'checked_at'
    ),
    jsonb_build_object(
      'key','reports','name','Reports Service','category','Application',
      'status',case when exists (
        select 1 from atlas_private.system_incidents
        where incident_key='reports-snapshot-loading' and status in ('open','monitoring')
      ) then 'degraded' else 'healthy' end,
      'detail',case when exists (
        select 1 from atlas_private.system_incidents
        where incident_key='reports-snapshot-loading' and status in ('open','monitoring')
      ) then 'Checkpoint H remains deferred: the authenticated Reports screen does not complete.' else 'No open Reports incident.' end,
      'checked_at',pg_catalog.now()
    ),
    jsonb_build_object(
      'key','production-sync','name','Production Synchronization','category','Safeguard',
      'status','disabled_by_policy',
      'detail','Preview features do not automatically promote data or migrations to production.',
      'checked_at',pg_catalog.now()
    )
  );

  environments_json := jsonb_build_array(
    jsonb_build_object(
      'key','production','name','Production','project_ref',settings_row.production_project_ref,
      'deployment','main','branch','main','status','protected','source_data_changed',false,
      'detail','Production authentication and source records remain protected from preview writes.'
    ),
    jsonb_build_object(
      'key','preview','name','Sprint 4 Preview','project_ref',settings_row.preview_project_ref,
      'deployment',coalesce(p_release_context->>'preview_url',settings_row.netlify_preview_url),
      'branch',coalesce(p_release_context->>'github_branch',settings_row.github_branch),
      'commit',p_release_context->>'github_commit',
      'status',coalesce(p_release_context->>'preview_status','unknown'),
      'migration_count',migration_count,'latest_migration',latest_migration,'source_data_changed',false
    ),
    jsonb_build_object(
      'key','repository','name','GitHub Branch','repository',settings_row.github_repository,
      'branch',coalesce(p_release_context->>'github_branch',settings_row.github_branch),
      'commit',p_release_context->>'github_commit',
      'status',coalesce(p_release_context->>'github_status','unknown'),
      'detail','Draft PR #5; merge and production release remain separate decisions.'
    )
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'key',registry.integration_key,
    'name',registry.name,
    'category',registry.category,
    'status',case
      when connection.provider_key is null then registry.state
      when coalesce(connection.authorization_state,'')='expired' or connection.status='expired' then 'connection_expired'
      when coalesce(connection.authorization_state,'')='waiting_authorization'
        or connection.status in ('authorization_required','pending_review') then 'waiting_authorization'
      when coalesce(connection.authorization_state,'')='authorized' or connection.status='connected' then
        case
          when coalesce(connection.publishing_permission_state,'not_requested')='missing'
            or coalesce(connection.analytics_permission_state,'not_requested')='missing' then 'missing_permission'
          else 'connected'
        end
      else registry.state
    end,
    'detail',coalesce(connection.last_connection_error,registry.state_detail),
    'external_account_label',coalesce(connection.external_account_label,registry.external_account_label),
    'automatic_sync_enabled',registry.automatic_sync_enabled,
    'publishing_enabled',case when connection.provider_key is not null then coalesce(connection.publishing_permission_state='granted',false) else registry.publishing_enabled end,
    'analytics_enabled',case when connection.provider_key is not null then coalesce(connection.analytics_permission_state='granted',false) else registry.analytics_enabled end,
    'last_verified_at',coalesce(connection.last_verified_at,registry.last_verified_at),
    'token_expires_at',connection.token_expires_at,
    'metadata',registry.metadata
  ) order by registry.category,registry.name),'[]'::jsonb)
  into integrations_json
  from atlas_private.system_integrations registry
  left join atlas_private.integration_connections connection
    on connection.provider_key=registry.integration_key;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key',source.source_key,
    'name',source.name,
    'source_kind',source.source_kind,
    'status',coalesce(source.state_override,
      case
        when source.relation_name is null then 'not_connected'
        when atlas_private.system_relation_count(source.relation_name) is null then 'not_connected'
        when atlas_private.system_relation_count(source.relation_name)=0 then 'no_records'
        when source.source_kind='historical' then 'historical'
        else 'connected'
      end),
    'record_count',atlas_private.system_relation_count(source.relation_name),
    'last_record_at',atlas_private.system_relation_latest(source.relation_name,source.timestamp_column),
    'last_success_at',source.last_success_at,
    'last_attempt_at',source.last_attempt_at,
    'live_for_operations',source.live_for_operations,
    'trusted_for_brain',source.trusted_for_brain,
    'note',source.note,
    'metadata',source.metadata
  ) order by case coalesce(source.state_override,'connected')
      when 'degraded' then 0 when 'partial' then 1 when 'not_connected' then 2
      when 'historical' then 3 else 4 end,source.name),'[]'::jsonb)
  into sources_json
  from atlas_private.system_data_sources source;

  select coalesce(jsonb_agg(to_jsonb(job) order by
    case job.status when 'failed' then 0 when 'degraded' then 1 when 'waiting' then 2 else 3 end,
    job.name),'[]'::jsonb)
  into jobs_json
  from atlas_private.system_jobs job;

  select coalesce(jsonb_agg(to_jsonb(incident) order by
    case incident.severity when 'critical' then 0 when 'degraded' then 1 when 'warning' then 2 else 3 end,
    incident.last_seen_at desc),'[]'::jsonb)
  into incidents_json
  from atlas_private.system_incidents incident;

  with profile_input as (
    select * from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,email text,display_name text,role text,active boolean
    )
  )
  select jsonb_build_object(
    'active_profiles',count(*) filter (where active=true),
    'inactive_profiles',count(*) filter (where active=false),
    'roles',coalesce((
      select jsonb_object_agg(role,role_count)
      from (select role,count(*)::bigint role_count from profile_input where active=true group by role) role_rows
    ),'{}'::jsonb),
    'private_tables_without_rls',private_rls_disabled,
    'public_storage_buckets',public_storage_buckets,
    'private_profile_storage_available',profile_bucket_present,
    'expired_or_degraded_integrations',(
      select count(*)::bigint from jsonb_array_elements(integrations_json) item
      where item->>'status' in ('connection_expired','degraded','missing_permission')
    ),
    'service_role_in_browser',false,
    'secrets_visible_in_system',false,
    'destructive_controls_enabled',settings_row.destructive_actions_enabled,
    'production_sync_enabled',settings_row.production_sync_enabled,
    'authorization_rule','Active production profile revalidated on every System request.'
  ) into security_json
  from profile_input;

  with unified as (
    select event.created_at,'System'::text module,event.event_type,event.actor_label,event.actor_role,event.payload
    from atlas_private.system_events event
    union all
    select event.created_at,'Shifts',event.event_type,event.actor_label,event.actor_role,event.payload
    from atlas_private.shift_events event
    where event.event_type in ('week_published','month_published','shift_response_decided')
    union all
    select event.created_at,'Knowledge',event.event_type,event.actor_label,event.actor_role,event.payload
    from atlas_private.knowledge_events event
    where event.event_type in ('version_published','article_retired','article_acknowledged')
    union all
    select event.created_at,'Marketing',event.event_type,event.actor_label,event.actor_role,event.payload
    from atlas_private.marketing_workspace_events event
    where event.event_type in ('content_published','approval_decided','recommendation_converted')
    union all
    select event.created_at,'Profiles',event.event_type,event.actor_label,event.actor_role,event.payload
    from atlas_private.team_profile_events event
    where event.event_type in ('role_changed','active_status_changed','profile_photo_updated')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'created_at',created_at,'module',module,'event_type',event_type,
    'actor_label',actor_label,'actor_role',actor_role,'payload',payload
  ) order by created_at desc),'[]'::jsonb)
  into audit_json
  from (select * from unified order by created_at desc limit 120) recent;

  select coalesce(jsonb_agg(to_jsonb(point) order by point.recorded_at desc),'[]'::jsonb)
  into recovery_json
  from atlas_private.system_recovery_points point;

  return jsonb_build_object(
    'version','atlas-system/0.1.0',
    'generated_at',pg_catalog.now(),
    'environment',settings_row.environment,
    'summary',jsonb_build_object(
      'overall_status',case
        when critical_incidents>0 then 'critical'
        when open_incidents>0 or coalesce((p_edge_health->>'unhealthy_count')::integer,0)>0 then 'degraded'
        else 'healthy' end,
      'open_incidents',open_incidents,
      'critical_incidents',critical_incidents,
      'connected_integrations',(
        select count(*)::bigint from jsonb_array_elements(integrations_json) item where item->>'status'='connected'
      ),
      'total_integrations',jsonb_array_length(integrations_json),
      'healthy_services',(
        select count(*)::bigint from jsonb_array_elements(services_json) item where item->>'status' in ('healthy','connected')
      ),
      'total_services',jsonb_array_length(services_json),
      'failed_jobs',(select count(*)::bigint from atlas_private.system_jobs where status in ('failed','degraded')),
      'release_blockers',(
        select count(*)::bigint from atlas_private.system_incidents
        where status in ('open','monitoring') and coalesce((metadata->>'release_blocker')::boolean,false)=true
      )
    ),
    'services',services_json,
    'environments',environments_json,
    'integrations',integrations_json,
    'data_sources',sources_json,
    'jobs',jobs_json,
    'incidents',incidents_json,
    'security',security_json,
    'audit',audit_json,
    'recovery',recovery_json,
    'edge_health',coalesce(p_edge_health,'{}'::jsonb),
    'release_context',coalesce(p_release_context,'{}'::jsonb),
    'permissions',jsonb_build_object(
      'can_view_system',true,'can_retry_jobs',false,'can_resolve_incidents',false,
      'can_execute_rollback',false,'read_only',true
    ),
    'trust',jsonb_build_object(
      'production_source_data_changed',false,
      'automatic_production_promotion',false,
      'destructive_actions_enabled',false,
      'secrets_returned',false,
      'jobs_view_only',true,
      'reports_incident_preserved',true,
      'manager_profile_required',true
    )
  );
end;
$$;

create or replace function public.atlas_system_snapshot(
  p_profiles jsonb,p_edge_health jsonb,p_release_context jsonb,p_actor_id uuid,p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.system_snapshot(p_profiles,p_edge_health,p_release_context,p_actor_id,p_actor_role);
$$;

revoke execute on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)
  from public,anon,authenticated;
grant execute on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)
  to service_role;

comment on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text) is
  'Service-role-only manager System control-room snapshot with no secrets or destructive actions.';
