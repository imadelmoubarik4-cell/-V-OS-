-- Checkpoint I manager-only System snapshot.
--
-- The gateway supplies role-validated production profile and source metadata.
-- The database adds private service, job, incident, release, security and audit
-- evidence. No secret, access token or destructive control is returned.

create or replace function atlas_private.system_snapshot(
  p_profiles jsonb,
  p_production_sources jsonb,
  p_runtime jsonb,
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
  services_json jsonb := '[]'::jsonb;
  integrations_json jsonb := '[]'::jsonb;
  sources_json jsonb := '[]'::jsonb;
  jobs_json jsonb := '[]'::jsonb;
  incidents_json jsonb := '[]'::jsonb;
  releases_json jsonb := '[]'::jsonb;
  audit_json jsonb := '[]'::jsonb;
  security_json jsonb := '{}'::jsonb;
  summary_json jsonb := '{}'::jsonb;
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'System is available only to managers and administrators';
  end if;

  select * into settings_row
  from atlas_private.system_settings
  where setting_key='va';

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_key',service.service_key,
    'label',service.label,
    'category',service.category,
    'status',case
      when service.service_key='production-auth'
        and coalesce((p_runtime->>'auth_verified')::boolean,false)=false then 'degraded'
      when service.service_key='private-storage'
        and not exists (
          select 1 from storage.buckets bucket
          where bucket.id='atlas-profile-photos' and bucket.public=false
        ) then 'degraded'
      when service.service_key='reports-service'
        and exists (
          select 1 from atlas_private.system_incidents incident
          where incident.service_key=service.service_key
            and incident.status in ('open','monitoring')
        ) then 'degraded'
      else service.status
    end,
    'environment',service.environment,
    'version_label',service.version_label,
    'check_strategy',service.check_strategy,
    'last_checked_at',case
      when service.check_strategy in ('runtime','client','database','incident') then pg_catalog.now()
      else service.last_checked_at
    end,
    'last_success_at',service.last_success_at,
    'last_failure_at',service.last_failure_at,
    'failure_code',service.failure_code,
    'failure_message',service.failure_message,
    'production_impact',service.production_impact,
    'preview_impact',service.preview_impact,
    'metadata',service.metadata || case service.service_key
      when 'web-app' then jsonb_build_object('client_hostname',p_runtime->>'client_hostname')
      when 'edge-functions' then jsonb_build_object(
        'system_gateway',p_runtime->>'function_version',
        'runtime_region',p_runtime->>'runtime_region',
        'deployment_id',p_runtime->>'deployment_id'
      )
      else '{}'::jsonb
    end
  ) order by service.sort_order,service.label),'[]'::jsonb)
  into services_json
  from atlas_private.system_services service;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',connection.provider_key,
    'label',connection.label,
    'category',connection.category,
    'status',connection.status,
    'display_status',case
      when connection.status='connected' then 'connected'
      when connection.status='degraded' then 'degraded'
      when connection.status='expired' or connection.authorization_state='expired' then 'connection_expired'
      when connection.authorization_state='waiting_authorization'
        or connection.status in ('authorization_required','pending_review') then 'waiting_for_authorization'
      when connection.publishing_permission_state='missing' then 'missing_publishing_permission'
      when connection.analytics_permission_state='missing' then 'missing_analytics_permission'
      when connection.status='not_applicable' then 'disabled_by_policy'
      else 'not_connected'
    end,
    'authorization_state',connection.authorization_state,
    'publishing_permission_state',connection.publishing_permission_state,
    'analytics_permission_state',connection.analytics_permission_state,
    'external_account_label',connection.external_account_label,
    'last_verified_at',connection.last_verified_at,
    'token_expires_at',connection.token_expires_at,
    'last_connection_error',connection.last_connection_error,
    'capabilities',connection.capabilities,
    'requirements',connection.requirements,
    'metadata',connection.metadata
  ) order by connection.category,connection.label),'[]'::jsonb)
  into integrations_json
  from atlas_private.integration_connections connection;

  with production_input as (
    select *
    from jsonb_to_recordset(coalesce(p_production_sources,'[]'::jsonb)) as source(
      source_key text,
      label text,
      status text,
      record_count bigint,
      last_record_at timestamptz,
      is_live boolean,
      is_historical boolean,
      trusted_for_brain boolean,
      note text
    )
  ), source_values as (
    select registry.*,
      production.status as production_status,
      production.record_count as production_record_count,
      production.last_record_at as production_last_record_at,
      production.note as production_note
    from atlas_private.system_data_sources registry
    left join production_input production on production.source_key=registry.source_key
  ), computed as (
    select source.*,
      case
        when source.production_status is not null then source.production_status
        when source.source_key='sprint3-private-import' then
          case when exists (select 1 from atlas_private.import_batches) then 'partial' else 'no_records' end
        when source.source_key='sprint3-review' then
          case when coalesce((select sum(pending_rows) from atlas_private.data_coverage),0)>0 then 'partial' else 'connected' end
        when source.source_key='july-2026-inventory' then 'historical'
        when source.source_key='operations-routines' then
          case when exists (select 1 from atlas_private.routine_instances) then 'connected' else 'no_records' end
        when source.source_key='temperature-logs' then
          case when exists (select 1 from atlas_private.temperature_logs) then 'connected' else 'no_records' end
        when source.source_key='shift-publications' then
          case when exists (select 1 from atlas_private.shift_publications)
                 or exists (select 1 from atlas_private.shift_month_publications)
            then 'connected' else 'no_records' end
        when source.source_key='knowledge-library' then
          case when exists (select 1 from atlas_private.knowledge_articles where status='published') then 'connected' else 'no_records' end
        when source.source_key='marketing-planning' then
          case when exists (select 1 from atlas_private.marketing_content_items) then 'connected' else 'no_records' end
        else source.status
      end as effective_status,
      case
        when source.production_record_count is not null then source.production_record_count
        when source.source_key='sprint3-private-import' then (select count(*)::bigint from atlas_private.import_batches)
        when source.source_key='sprint3-review' then coalesce((select sum(total_rows) from atlas_private.data_coverage),0)
        when source.source_key='july-2026-inventory' then (select count(*)::bigint from atlas_private.import_inventory_rows)
        when source.source_key='operations-routines' then (select count(*)::bigint from atlas_private.routine_instances)
        when source.source_key='temperature-logs' then (select count(*)::bigint from atlas_private.temperature_logs)
        when source.source_key='shift-publications' then
          (select count(*)::bigint from atlas_private.shift_publications)
          +(select count(*)::bigint from atlas_private.shift_month_publications)
        when source.source_key='knowledge-library' then
          (select count(*)::bigint from atlas_private.knowledge_articles where status='published')
        when source.source_key='marketing-planning' then
          (select count(*)::bigint from atlas_private.marketing_content_items)
        else coalesce(source.record_count,0)
      end as effective_count,
      case
        when source.production_last_record_at is not null then source.production_last_record_at
        when source.source_key='sprint3-private-import' then (select max(updated_at) from atlas_private.import_batches)
        when source.source_key='sprint3-review' then (select max(updated_at) from atlas_private.review_queue)
        when source.source_key='operations-routines' then (select max(updated_at) from atlas_private.routine_instances)
        when source.source_key='temperature-logs' then (select max(created_at) from atlas_private.temperature_logs)
        when source.source_key='shift-publications' then greatest(
          coalesce((select max(published_at) from atlas_private.shift_publications),'1970-01-01'::timestamptz),
          coalesce((select max(published_at) from atlas_private.shift_month_publications),'1970-01-01'::timestamptz)
        )
        when source.source_key='knowledge-library' then (select max(updated_at) from atlas_private.knowledge_articles)
        when source.source_key='marketing-planning' then (select max(updated_at) from atlas_private.marketing_content_items)
        else source.last_successful_at
      end as effective_last_at
    from source_values source
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_key',source.source_key,
    'label',source.label,
    'domain',source.domain,
    'source_type',source.source_type,
    'status',source.effective_status,
    'is_live',source.is_live,
    'is_historical',source.is_historical,
    'trusted_for_brain',source.trusted_for_brain,
    'record_count',source.effective_count,
    'last_successful_at',source.effective_last_at,
    'last_attempted_at',source.last_attempted_at,
    'freshness_hours',source.freshness_hours,
    'freshness_state',case
      when source.effective_status='not_connected' then 'not_connected'
      when source.is_historical then 'historical'
      when source.effective_last_at is null then 'unknown'
      when source.freshness_hours is not null
        and source.effective_last_at<pg_catalog.now()-(source.freshness_hours||' hours')::interval then 'stale'
      else 'current'
    end,
    'source_scope',source.source_scope,
    'error_code',source.error_code,
    'error_message',coalesce(source.production_note,source.error_message),
    'metadata',source.metadata
  ) order by source.sort_order,source.label),'[]'::jsonb)
  into sources_json
  from computed source;

  select coalesce(jsonb_agg(jsonb_build_object(
    'job_key',job.job_key,
    'label',job.label,
    'category',job.category,
    'schedule_description',job.schedule_description,
    'status',job.status,
    'is_automatic',job.is_automatic,
    'retry_enabled',job.retry_enabled,
    'write_scope',job.write_scope,
    'last_started_at',job.last_started_at,
    'last_succeeded_at',job.last_succeeded_at,
    'last_failed_at',job.last_failed_at,
    'next_run_at',job.next_run_at,
    'last_error_code',job.last_error_code,
    'last_error_message',job.last_error_message,
    'metadata',job.metadata
  ) order by job.sort_order,job.label),'[]'::jsonb)
  into jobs_json
  from atlas_private.system_jobs job;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',incident.id,
    'incident_key',incident.incident_key,
    'service_key',incident.service_key,
    'title',incident.title,
    'severity',incident.severity,
    'status',incident.status,
    'summary',incident.summary,
    'production_impact',incident.production_impact,
    'preview_impact',incident.preview_impact,
    'first_occurred_at',incident.first_occurred_at,
    'last_occurred_at',incident.last_occurred_at,
    'occurrence_count',incident.occurrence_count,
    'resolved_at',incident.resolved_at,
    'resolved_by_label',incident.resolved_by_label,
    'resolution_note',incident.resolution_note,
    'metadata',incident.metadata
  ) order by
    case incident.status when 'open' then 0 when 'monitoring' then 1 else 2 end,
    case incident.severity when 'critical' then 0 when 'degraded' then 1 when 'warning' then 2 else 3 end,
    incident.last_occurred_at desc),'[]'::jsonb)
  into incidents_json
  from atlas_private.system_incidents incident;

  select coalesce(jsonb_agg(jsonb_build_object(
    'checkpoint_key',release.checkpoint_key,
    'label',release.label,
    'environment',release.environment,
    'status',release.status,
    'repository',release.repository,
    'branch',release.branch,
    'base_branch',release.base_branch,
    'pull_request_number',release.pull_request_number,
    'commit_sha',coalesce(p_runtime->>'github_commit_sha',release.commit_sha),
    'commit_date',p_runtime->>'github_commit_date',
    'deployment_url',coalesce(p_runtime->>'client_url',release.deployment_url),
    'migration_status',release.migration_status,
    'functions_status',case
      when coalesce((p_runtime->>'system_gateway')::boolean,false) then 'System gateway active'
      else release.functions_status
    end,
    'production_sync_state',release.production_sync_state,
    'last_known_healthy_reference',release.last_known_healthy_reference,
    'rollback_reference',release.rollback_reference,
    'release_blockers',release.release_blockers,
    'metadata',release.metadata||jsonb_build_object(
      'runtime_project_ref',p_runtime->>'project_ref',
      'runtime_region',p_runtime->>'runtime_region'
    )
  ) order by release.environment,release.label),'[]'::jsonb)
  into releases_json
  from atlas_private.system_release_checkpoints release;

  with profiles as (
    select *
    from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,
      email text,
      display_name text,
      role text,
      active boolean,
      updated_at timestamptz
    )
  ), private_tables as (
    select count(*)::bigint as total,
      count(*) filter (where class.relrowsecurity)::bigint as protected
    from pg_class class
    join pg_namespace namespace on namespace.oid=class.relnamespace
    where namespace.nspname='atlas_private' and class.relkind='r'
  )
  select jsonb_build_object(
    'profiles',jsonb_build_object(
      'total',(select count(*)::bigint from profiles),
      'active',(select count(*)::bigint from profiles where active=true),
      'inactive',(select count(*)::bigint from profiles where active=false),
      'active_managers',(select count(*)::bigint from profiles where active=true and role in ('admin','manager')),
      'roles',coalesce((
        select jsonb_object_agg(role,role_count)
        from (select role,count(*)::bigint role_count from profiles group by role) roles
      ),'{}'::jsonb)
    ),
    'private_schema',jsonb_build_object(
      'tables',(select total from private_tables),
      'rls_enabled',(select protected from private_tables),
      'rls_missing',(select total-protected from private_tables)
    ),
    'unexpected_table_grants',(
      select count(*)::bigint
      from information_schema.role_table_grants
      where table_schema='atlas_private' and grantee in ('anon','authenticated','PUBLIC')
    ),
    'unexpected_atlas_function_grants',(
      select count(*)::bigint
      from information_schema.routine_privileges
      where routine_schema='public' and routine_name like 'atlas_%'
        and grantee in ('anon','authenticated','PUBLIC')
    ),
    'private_storage_buckets',(
      select count(*)::bigint from storage.buckets where public=false
    ),
    'profile_photo_bucket_private',exists (
      select 1 from storage.buckets where id='atlas-profile-photos' and public=false
    ),
    'recent_access_changes',(
      select count(*)::bigint
      from atlas_private.team_profile_events
      where event_type in ('role_changed','active_status_changed')
        and created_at>=pg_catalog.now()-interval '30 days'
    ),
    'browser_service_role_exposed',false,
    'secrets_visible_in_ui',settings_row.secrets_visible_in_ui,
    'destructive_actions_enabled',settings_row.destructive_actions_enabled
  ) into security_json;

  with audit as (
    select created_at,'system'::text domain,event_type,entity_key,actor_label,payload
    from atlas_private.system_events
    union all
    select created_at,'shifts',event_type,coalesce(shift_id::text,week_start::text,month_start::text),actor_label,payload
    from atlas_private.shift_events
    union all
    select created_at,'knowledge',event_type,coalesce(article_id::text,version_id::text),actor_label,payload
    from atlas_private.knowledge_events
    union all
    select created_at,'marketing',event_type,coalesce(content_id::text,campaign_id::text,recommendation_id::text),actor_label,payload
    from atlas_private.marketing_workspace_events
    union all
    select created_at,'profiles',event_type,profile_id::text,actor_label,payload
    from atlas_private.team_profile_events
    union all
    select created_at,'operations',event_type,coalesce(entity_id::text,entity_type),actor_label,payload
    from atlas_private.operations_events
    union all
    select created_at,'reports',event_type,coalesce(saved_view_id::text,report_key),actor_label,payload
    from atlas_private.report_events
    union all
    select created_at,'messages',event_type,coalesce(message_id::text,channel_id::text),actor_label,payload
    from atlas_private.team_message_events
    union all
    select created_at,'scanner',event_type,coalesce(external_item_id::text,normalized_code),actor_label,metadata
    from atlas_private.inventory_scan_events
    union all
    select occurred_at,'brain',memory_type,subject_key,actor_label,context
    from atlas_private.brain_decision_memory
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'created_at',audit.created_at,
    'domain',audit.domain,
    'event_type',audit.event_type,
    'entity_key',audit.entity_key,
    'actor_label',audit.actor_label,
    'payload',audit.payload
  ) order by audit.created_at desc),'[]'::jsonb)
  into audit_json
  from (select * from audit order by created_at desc limit 120) audit;

  select jsonb_build_object(
    'overall_status',case
      when exists (
        select 1 from atlas_private.system_incidents
        where status in ('open','monitoring') and severity in ('critical','degraded')
      ) then 'degraded'
      when exists (select 1 from atlas_private.system_services where status='down') then 'down'
      else 'healthy'
    end,
    'healthy_services',(
      select count(*)::bigint from jsonb_array_elements(services_json) service
      where service->>'status'='healthy'
    ),
    'degraded_services',(
      select count(*)::bigint from jsonb_array_elements(services_json) service
      where service->>'status' in ('degraded','down')
    ),
    'open_incidents',(
      select count(*)::bigint from atlas_private.system_incidents
      where status in ('open','monitoring')
    ),
    'connected_integrations',(
      select count(*)::bigint from atlas_private.integration_connections where status='connected'
    ),
    'unconnected_integrations',(
      select count(*)::bigint from atlas_private.integration_connections where status<>'connected'
    ),
    'trusted_live_sources',(
      select count(*)::bigint from jsonb_array_elements(sources_json) source
      where source->>'trusted_for_brain'='true' and source->>'status'='connected'
    ),
    'blocked_sources',(
      select count(*)::bigint from jsonb_array_elements(sources_json) source
      where source->>'status' in ('not_connected','blocked','stale')
    ),
    'release_blockers',coalesce((
      select sum(jsonb_array_length(release_blockers))
      from atlas_private.system_release_checkpoints
    ),0)
  ) into summary_json;

  return jsonb_build_object(
    'version','atlas-system/0.1.0',
    'generated_at',pg_catalog.now(),
    'summary',summary_json,
    'services',services_json,
    'integrations',integrations_json,
    'data_sources',sources_json,
    'jobs',jobs_json,
    'incidents',incidents_json,
    'releases',releases_json,
    'security',security_json,
    'audit',audit_json,
    'recovery',jsonb_build_object(
      'last_known_healthy_reference',(
        select last_known_healthy_reference
        from atlas_private.system_release_checkpoints
        order by updated_at desc limit 1
      ),
      'rollback_reference',(
        select rollback_reference
        from atlas_private.system_release_checkpoints
        order by updated_at desc limit 1
      ),
      'backup_status','not_verified_by_atlas_runtime',
      'production_sync_enabled',settings_row.production_sync_enabled,
      'rollback_actions_enabled',settings_row.rollback_actions_enabled,
      'destructive_actions_enabled',settings_row.destructive_actions_enabled,
      'automatic_retries_enabled',settings_row.automatic_retries_enabled,
      'mode','view_only'
    ),
    'permissions',jsonb_build_object(
      'can_view_system',true,
      'can_view_security',true,
      'can_retry_jobs',false,
      'can_resolve_incidents',false,
      'can_run_rollback',false,
      'can_promote_production',false
    ),
    'trust',jsonb_build_object(
      'secrets_returned',false,
      'tokens_returned',false,
      'production_source_mutation',false,
      'destructive_controls_enabled',false,
      'automatic_retry_enabled',false,
      'system_is_view_only',true
    )
  );
end;
$$;

create or replace function public.atlas_system_snapshot(
  p_profiles jsonb,
  p_production_sources jsonb,
  p_runtime jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.system_snapshot($1,$2,$3,$4,$5);
$$;

revoke execute on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)
  from public,anon,authenticated;
grant execute on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)
  to service_role;

comment on function public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text) is
  'Service-role-only System snapshot for active managers. It returns health metadata without secrets, tokens or source mutations.';
