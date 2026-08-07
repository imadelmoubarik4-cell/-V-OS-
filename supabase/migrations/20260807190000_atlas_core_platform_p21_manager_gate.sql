-- P2.1 authorization repair.
--
-- Core-platform release readiness is manager-level information. The public
-- wrapper remains service-role-only, and this private contract now also
-- rejects bartender and viewer actor roles instead of trusting a caller-supplied
-- active role alone.

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
  perform atlas_private.connection_assert_actor(p_actor_role,true,false);

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

revoke all on function atlas_private.core_platform_snapshot(uuid,text)
  from public,anon,authenticated;
grant execute on function atlas_private.core_platform_snapshot(uuid,text)
  to service_role;

notify pgrst,'reload schema';
