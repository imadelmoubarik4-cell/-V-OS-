-- Close the historical Reports release blocker after authenticated PR27
-- acceptance. This data-only migration is for the isolated project. It does
-- not enable production synchronization, retries, rollback, destructive
-- controls, or automatic execution.

update atlas_private.system_services
set status='healthy',
    check_strategy='runtime',
    last_checked_at=now(),
    last_success_at=now(),
    failure_code=null,
    failure_message=null,
    production_impact='none',
    preview_impact='none',
    metadata=(metadata - 'deferred_for_system_checkpoint') || jsonb_build_object(
      'checkpoint','H',
      'browser_acceptance_passed',true,
      'reports_function_version',9,
      'isolated_only',true
    )
where service_key='reports-service';

update atlas_private.system_jobs
set status='healthy',
    last_started_at=now(),
    last_succeeded_at=now(),
    last_error_code=null,
    last_error_message=null,
    metadata=(metadata - 'deferred') || jsonb_build_object(
      'browser_acceptance_passed',true,
      'read_only',true,
      'production_impact','none'
    )
where job_key='reports-snapshot';

update atlas_private.system_incidents
set title='Reports authenticated snapshot restored',
    severity='info',
    status='resolved',
    summary='Authenticated PR27 validation now completes after SQL recordset-wrapper hardening and null-safe package-size normalization.',
    production_impact='none',
    preview_impact='none',
    resolved_at=now(),
    resolved_by_label='PR27 isolated validation',
    resolution_note='Reports loaded the complete Checkpoint H workspace with 49 visible inventory records. Migration replay, Atlas verification and the Supabase Security Advisor passed.',
    metadata=metadata || jsonb_build_object(
      'deferred',false,
      'release_blocker',false,
      'browser_acceptance_passed',true,
      'production_records_changed',false,
      'isolated_only',true,
      'hardening_migration','20260909085342',
      'null_safe_migration','20260909090422'
    )
where incident_key='reports-loading-stall';

update atlas_private.system_release_checkpoints
set label='PR27 isolated validation',
    status='ready',
    repository='imadelmoubarik4-cell/-V-OS-',
    branch='codex/pr26-live-validation-fixes',
    base_branch='claude/recipes-gallery-v2',
    pull_request_number=27,
    deployment_url='https://deploy-preview-27--os-vabar.netlify.app',
    migration_status='Isolated Reports closure migrations applied',
    functions_status='Reports, System and Settings gateways active',
    production_sync_state='disabled',
    last_known_healthy_reference='codex/pr26-live-validation-fixes@runtime',
    rollback_reference='claude/recipes-gallery-v2@ba98535e4c65802c4ee235a235432efc457c918e',
    release_blockers='[]'::jsonb,
    metadata=metadata || jsonb_build_object(
      'automatic_promotion_enabled',false,
      'destructive_rollback_enabled',false,
      'authenticated_acceptance_passed',true,
      'isolated_project_ref','uhbamqetppqmygesoeeh'
    )
where checkpoint_key='sprint4-phase3';

update atlas_private.settings_sections
set settings_value=jsonb_set(
      jsonb_set(
        jsonb_set(settings_value,'{reports}','true'::jsonb,true),
        '{reports_state}','"ready"'::jsonb,true
      ),
      '{production_sync_enabled}','false'::jsonb,true
    ),
    version=version+1,
    updated_by_label='PR27 isolated validation'
where section_key='modules';

insert into atlas_private.system_events(
  event_type,domain,entity_key,actor_label,actor_role,payload
) values
  (
    'service_status_changed','reports','reports-service',
    'PR27 isolated validation','system',
    jsonb_build_object('from','degraded','to','healthy','production_impact','none')
  ),
  (
    'job_status_changed','reports','reports-snapshot',
    'PR27 isolated validation','system',
    jsonb_build_object('from','failed','to','healthy','read_only',true)
  ),
  (
    'incident_resolved','reports','reports-loading-stall',
    'PR27 isolated validation','system',
    jsonb_build_object('release_blocker',false,'production_records_changed',false)
  ),
  (
    'release_checkpoint_updated','system','sprint4-phase3',
    'PR27 isolated validation','system',
    jsonb_build_object(
      'pull_request_number',27,
      'status','ready',
      'production_sync_state','disabled'
    )
  );

do $validation$
begin
  if not exists (
    select 1 from atlas_private.system_services
    where service_key='reports-service'
      and status='healthy'
      and failure_code is null
      and preview_impact='none'
  ) then
    raise exception 'Reports service closure did not apply';
  end if;

  if not exists (
    select 1 from atlas_private.system_incidents
    where incident_key='reports-loading-stall'
      and status='resolved'
      and resolved_at is not null
      and metadata->>'release_blocker'='false'
  ) then
    raise exception 'Reports incident closure did not apply';
  end if;

  if not exists (
    select 1 from atlas_private.system_release_checkpoints
    where checkpoint_key='sprint4-phase3'
      and status='ready'
      and release_blockers='[]'::jsonb
      and production_sync_state='disabled'
  ) then
    raise exception 'PR27 release checkpoint closure did not apply';
  end if;

  if not exists (
    select 1 from atlas_private.settings_sections
    where section_key='modules'
      and settings_value->>'reports_state'='ready'
      and settings_value->>'production_sync_enabled'='false'
  ) then
    raise exception 'Settings Reports ready state did not apply';
  end if;
end;
$validation$;

