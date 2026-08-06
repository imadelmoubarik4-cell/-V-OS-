create or replace function atlas_private.connection_assert_actor(
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
    raise exception 'Only administrators may approve high-risk connection capabilities';
  end if;
  if p_manager_required and p_actor_role not in ('admin','manager') then
    raise exception 'Connection checks and capability changes require a manager';
  end if;
end;
$function$;

create or replace function atlas_private.connection_assert_safe_json(p_value jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path=''
as $function$
begin
  if jsonb_typeof(coalesce(p_value,'{}'::jsonb)) <> 'object' then
    raise exception 'Connection evidence must be a JSON object';
  end if;
  if coalesce(p_value,'{}'::jsonb)::text ~* '"(password|secret|token|api[_ -]?key|service[_ -]?role|credential)"[[:space:]]*:' then
    raise exception 'Connection evidence cannot contain credentials or secret values';
  end if;
end;
$function$;

create or replace function atlas_private.connection_effective_state(
  p_health_state text,
  p_last_succeeded_at timestamptz,
  p_token_expires_at timestamptz,
  p_stale_after_seconds integer
)
returns text
language sql
stable
security invoker
set search_path=''
as $function$
  select case
    when p_health_state in ('blocked','intentionally_disabled','not_configured','authorization_required')
      then p_health_state
    when p_token_expires_at is not null and p_token_expires_at <= now()
      then 'expired'
    when p_health_state='healthy' and p_last_succeeded_at is null
      then 'verifying'
    when p_health_state='healthy'
      and p_last_succeeded_at < now() - make_interval(secs => greatest(coalesce(p_stale_after_seconds,3600),60))
      then 'degraded'
    else p_health_state
  end;
$function$;

create or replace function atlas_private.connection_brain_projection()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'evidence_key',evidence.connection_key,
    'label',evidence.label,
    'evidence_state',evidence.status,
    'evidence_last_verified_at',evidence.last_verified_at,
    'canonical_connection_key',evidence.source_ref,
    'canonical_connection_state',case
      when canonical.provider_key is null then null
      else atlas_private.connection_effective_state(
        canonical.health_state,canonical.last_succeeded_at,
        canonical.token_expires_at,canonical.stale_after_seconds
      )
    end,
    'effective_evidence_state',case
      when evidence.source_ref is null then evidence.status
      when canonical.provider_key is null then 'not_connected'
      when atlas_private.connection_effective_state(
        canonical.health_state,canonical.last_succeeded_at,
        canonical.token_expires_at,canonical.stale_after_seconds
      )='healthy' then evidence.status
      when atlas_private.connection_effective_state(
        canonical.health_state,canonical.last_succeeded_at,
        canonical.token_expires_at,canonical.stale_after_seconds
      ) in ('verifying','authorization_required') then 'pending_review'
      else 'not_connected'
    end,
    'semantics','evidence_gate_not_provider_registry'
  ) order by evidence.connection_key),'[]'::jsonb)
  from atlas_private.brain_data_connections evidence
  left join atlas_private.integration_connections canonical
    on canonical.provider_key=evidence.source_ref;
$function$;

create or replace function atlas_private.connections_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_history_limit integer default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  history_limit integer := least(greatest(coalesce(p_history_limit,50),0),200);
  connection_rows jsonb := '[]'::jsonb;
  history_rows jsonb := '[]'::jsonb;
  summary_value jsonb := '{}'::jsonb;
begin
  perform atlas_private.connection_assert_actor(p_actor_role,false,false);
  if p_actor_id is null then raise exception 'Connection Center actor id is required'; end if;

  with resolved as (
    select connection.*,
      atlas_private.connection_effective_state(
        connection.health_state,connection.last_succeeded_at,
        connection.token_expires_at,connection.stale_after_seconds
      ) as effective_state
    from atlas_private.integration_connections connection
    where connection.active is true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'connection_key',connection.provider_key,
    'label',connection.label,
    'category',connection.category,
    'environment',connection.environment,
    'owner_module',connection.owner_module,
    'provider_type',connection.provider_type,
    'state',connection.effective_state,
    'configured_state',connection.health_state,
    'legacy_status',connection.status,
    'check_strategy',connection.check_strategy,
    'stale_after_seconds',connection.stale_after_seconds,
    'last_checked_at',connection.last_checked_at,
    'last_succeeded_at',connection.last_succeeded_at,
    'last_failed_at',connection.last_failed_at,
    'latency_ms',connection.latency_ms,
    'last_error_code',connection.last_error_code,
    'last_error_summary',connection.last_error_summary,
    'authorization_state',connection.authorization_state,
    'token_expires_at',connection.token_expires_at,
    'external_account_label',connection.external_account_label,
    'requirements',connection.requirements,
    'metadata',case when p_actor_role in ('admin','manager') then connection.metadata else '{}'::jsonb end,
    'capabilities',coalesce((
      select jsonb_agg(jsonb_build_object(
        'capability_key',capability.capability_key,
        'kind',capability.capability_kind,
        'grant_state',capability.grant_state,
        'risk_level',capability.risk_level,
        'manager_approval_required',capability.manager_approval_required,
        'automatic_execution_allowed',false,
        'reviewed_at',capability.reviewed_at,
        'reviewed_by_label',case when p_actor_role in ('admin','manager') then capability.reviewed_by_label else null end,
        'metadata',case when p_actor_role in ('admin','manager') then capability.metadata else '{}'::jsonb end
      ) order by capability.capability_kind,capability.capability_key)
      from atlas_private.connection_capability_grants capability
      where capability.connection_key=connection.provider_key
    ),'[]'::jsonb),
    'dependencies',coalesce((
      select jsonb_agg(jsonb_build_object(
        'module_key',dependency.module_key,
        'requirement_level',dependency.requirement_level,
        'required_capabilities',dependency.required_capabilities,
        'safety_boundary',dependency.safety_boundary
      ) order by dependency.requirement_level,dependency.module_key)
      from atlas_private.connection_dependencies dependency
      where dependency.connection_key=connection.provider_key
    ),'[]'::jsonb)
  ) order by connection.environment,connection.category,connection.label),'[]'::jsonb)
  into connection_rows
  from resolved connection;

  select jsonb_build_object(
    'total',count(*)::bigint,
    'healthy',count(*) filter (where effective_state='healthy')::bigint,
    'degraded',count(*) filter (where effective_state in ('degraded','expired','blocked'))::bigint,
    'action_required',count(*) filter (where effective_state in ('not_configured','authorization_required','verifying'))::bigint,
    'intentionally_disabled',count(*) filter (where effective_state='intentionally_disabled')::bigint,
    'last_success_at',max(last_succeeded_at)
  ) into summary_value
  from (
    select connection.*,
      atlas_private.connection_effective_state(
        connection.health_state,connection.last_succeeded_at,
        connection.token_expires_at,connection.stale_after_seconds
      ) effective_state
    from atlas_private.integration_connections connection
    where connection.active is true
  ) resolved;

  if p_actor_role in ('admin','manager') and history_limit>0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,
      'connection_key',event.connection_key,
      'event_type',event.event_type,
      'previous_state',event.previous_state,
      'new_state',event.new_state,
      'actor_label',event.actor_label,
      'actor_role',event.actor_role,
      'payload',event.payload,
      'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into history_rows
    from (
      select * from atlas_private.connection_events
      order by created_at desc
      limit history_limit
    ) event;
  end if;

  return jsonb_build_object(
    'version','atlas-connections/0.1.0',
    'generated_at',now(),
    'summary',summary_value,
    'connections',connection_rows,
    'history',history_rows,
    'brain_projection',case
      when to_regclass('atlas_private.brain_data_connections') is not null
        then atlas_private.connection_brain_projection()
      else '[]'::jsonb
    end,
    'permissions',jsonb_build_object(
      'can_view',true,
      'can_run_checks',p_actor_role in ('admin','manager'),
      'can_manage_capabilities',p_actor_role in ('admin','manager'),
      'can_grant_high_risk',p_actor_role='admin'
    ),
    'protocol',jsonb_build_object(
      'states',jsonb_build_array(
        'not_configured','authorization_required','verifying','healthy',
        'degraded','expired','blocked','intentionally_disabled'
      ),
      'safe_read_retries',jsonb_build_array(
        'provider_rate_limited','provider_unavailable','connection_timeout'
      ),
      'write_idempotency_required',true,
      'automatic_external_side_effects',false,
      'healthy_requires_verification',true
    ),
    'trust',jsonb_build_object(
      'secrets_returned',false,
      'tokens_returned',false,
      'credentials_stored_in_registry',false,
      'production_sync_enabled',false,
      'automatic_ordering_enabled',false,
      'automatic_publishing_enabled',false
    )
  );
end;
$function$;
