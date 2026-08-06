-- Phase 2 / P2.1 — core platform stabilization.
--
-- P2.0 established connection truth. P2.1 applies operationally realistic
-- freshness windows and exposes one service-role-only readiness contract for
-- Production Supabase, Atlas Supabase, Auth, Storage, SMTP, GitHub and Netlify.
-- A platform is never reported ready while a required connection is stale,
-- degraded, expired, blocked, not configured or awaiting authorization.

do $p21_invariants$
begin
  if to_regclass('atlas_private.integration_connections') is null then
    raise exception 'P2.1 requires the canonical P2.0 connection registry';
  end if;
end
$p21_invariants$;

update atlas_private.integration_connections
set stale_after_seconds = case provider_key
      when 'production-auth' then 43200
      when 'production-data' then 43200
      when 'atlas-private-database' then 43200
      when 'atlas-private-edge' then 43200
      when 'atlas-private-storage' then 86400
      when 'github' then 21600
      when 'netlify' then 21600
      when 'supabase' then 43200
      when 'custom-smtp' then 2592000
      else stale_after_seconds
    end,
    metadata = metadata || jsonb_build_object(
      'checkpoint','P2.1',
      'health_requires_evidence',true,
      'automatic_external_side_effects',false,
      'operational_check_cadence',case provider_key
        when 'atlas-private-storage' then 'daily'
        when 'custom-smtp' then 'monthly_or_after_configuration_change'
        when 'github' then 'per_release_or_six_hour_staleness'
        when 'netlify' then 'per_release_or_six_hour_staleness'
        else 'per_management_session_or_twelve_hour_staleness'
      end
    ),
    updated_at=now()
where provider_key in (
  'production-auth','production-data','atlas-private-database',
  'atlas-private-edge','atlas-private-storage','github','netlify',
  'supabase','custom-smtp'
);

insert into atlas_private.connection_dependencies(
  connection_key,module_key,requirement_level,required_capabilities,safety_boundary
)
values
  ('production-auth','core-platform','required',array['auth.session.verify'],
    'Every browser-facing gateway revalidates the current production session and active profile.'),
  ('production-data','core-platform','required',array['profiles.read'],
    'Production reads remain RLS-filtered; no service-role key enters the browser.'),
  ('atlas-private-database','core-platform','required',array['private.rpc.read'],
    'Private review and evidence contracts are service-role-only behind authenticated gateways.'),
  ('atlas-private-edge','core-platform','required',array['gateway.request'],
    'Edge gateways return safe error classes and no credentials or stack traces.'),
  ('atlas-private-storage','core-platform','required',array['profile_photo.read'],
    'Profile media remains in a private bucket and is read through signed URLs.'),
  ('github','core-platform','required',array['source.metadata.read'],
    'Runtime verification is public metadata only; Atlas cannot write to the repository.'),
  ('netlify','core-platform','required',array['deploy.preview.read'],
    'Deploy Preview reachability is verified; production deployment remains blocked.'),
  ('custom-smtp','core-platform','required',array['auth.email.invitation','auth.email.password_reset'],
    'Configured is not healthy: both invitation and password-reset delivery must pass.')
on conflict (connection_key,module_key) do update
set requirement_level=excluded.requirement_level,
    required_capabilities=excluded.required_capabilities,
    safety_boundary=excluded.safety_boundary,
    updated_at=now();

create or replace function atlas_private.core_platform_snapshot(
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
  rows jsonb;
  required_total integer;
  healthy_total integer;
  action_total integer;
  smtp_state text;
begin
  perform atlas_private.connections_assert_actor(p_actor_role,false);

  select count(*),
         count(*) filter (
           where atlas_private.connection_effective_state(
             connection.health_state,connection.last_succeeded_at,
             connection.token_expires_at,connection.stale_after_seconds
           )='healthy'
         ),
         count(*) filter (
           where atlas_private.connection_effective_state(
             connection.health_state,connection.last_succeeded_at,
             connection.token_expires_at,connection.stale_after_seconds
           )<>'healthy'
         ),
         max(case when connection.provider_key='custom-smtp' then
           atlas_private.connection_effective_state(
             connection.health_state,connection.last_succeeded_at,
             connection.token_expires_at,connection.stale_after_seconds
           ) end)
  into required_total,healthy_total,action_total,smtp_state
  from atlas_private.integration_connections connection
  where connection.provider_key in (
    'production-auth','production-data','atlas-private-database',
    'atlas-private-edge','atlas-private-storage','github','netlify',
    'custom-smtp'
  ) and connection.active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'connection_key',connection.provider_key,
    'label',connection.label,
    'state',atlas_private.connection_effective_state(
      connection.health_state,connection.last_succeeded_at,
      connection.token_expires_at,connection.stale_after_seconds
    ),
    'authorization_state',connection.authorization_state,
    'last_checked_at',connection.last_checked_at,
    'last_succeeded_at',connection.last_succeeded_at,
    'last_failed_at',connection.last_failed_at,
    'last_error_code',connection.last_error_code,
    'last_error_summary',connection.last_error_summary,
    'latency_ms',connection.latency_ms,
    'stale_after_seconds',connection.stale_after_seconds,
    'next_stale_at',case
      when connection.last_succeeded_at is null then null
      else connection.last_succeeded_at
        + make_interval(secs=>connection.stale_after_seconds)
    end,
    'required',true,
    'automatic_external_side_effects',false
  ) order by connection.provider_key),'[]'::jsonb)
  into rows
  from atlas_private.integration_connections connection
  where connection.provider_key in (
    'production-auth','production-data','atlas-private-database',
    'atlas-private-edge','atlas-private-storage','github','netlify',
    'custom-smtp'
  ) and connection.active;

  return jsonb_build_object(
    'version','atlas-core-platform/0.1.0',
    'generated_at',now(),
    'summary',jsonb_build_object(
      'required_connections',coalesce(required_total,0),
      'healthy_connections',coalesce(healthy_total,0),
      'action_required',coalesce(action_total,0),
      'smtp_state',coalesce(smtp_state,'not_configured'),
      'ready_for_release',coalesce(required_total,0)>0
        and coalesce(healthy_total,0)=coalesce(required_total,0)
    ),
    'connections',rows,
    'policy',jsonb_build_object(
      'health_requires_verification_evidence',true,
      'stale_is_not_healthy',true,
      'smtp_requires_invitation_delivery',true,
      'smtp_requires_password_reset_delivery',true,
      'production_deployment_from_atlas',false,
      'production_sync_enabled',false,
      'automatic_external_side_effects',false,
      'secrets_returned',false,
      'tokens_returned',false
    ),
    'actor',jsonb_build_object('id',p_actor_id,'role',p_actor_role)
  );
end;
$function$;

create or replace function public.atlas_core_platform_snapshot(
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.core_platform_snapshot(p_actor_id,p_actor_role);
$function$;

revoke all on function atlas_private.core_platform_snapshot(uuid,text)
  from public,anon,authenticated;
revoke all on function public.atlas_core_platform_snapshot(uuid,text)
  from public,anon,authenticated;
grant execute on function atlas_private.core_platform_snapshot(uuid,text)
  to service_role;
grant execute on function public.atlas_core_platform_snapshot(uuid,text)
  to service_role;

comment on function public.atlas_core_platform_snapshot(uuid,text) is
  'Service-role-only P2.1 release readiness. Any stale or failed required connection keeps release readiness false.';

notify pgrst,'reload schema';
