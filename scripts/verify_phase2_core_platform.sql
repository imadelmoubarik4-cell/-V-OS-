\set ON_ERROR_STOP on

begin;
create temporary table core_platform_results(
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;

do $core_platform_acceptance$
declare
  actor_id constant uuid := '10000000-0000-4000-8000-000000000001';
  snapshot jsonb;
  denied boolean;
begin
  snapshot:=public.atlas_core_platform_snapshot(actor_id,'admin');

  insert into core_platform_results values(
    'p21_snapshot_contract',
    snapshot->>'version'='atlas-core-platform/0.1.0'
      and (snapshot->'summary'->>'required_connections')::integer=8,
    'Core-platform snapshot contains all eight required connections.'
  );

  insert into core_platform_results values(
    'p21_no_false_ready',
    snapshot->'summary'->>'ready_for_release'='false'
      and (snapshot->'summary'->>'action_required')::integer>0,
    'A clean replay with no completed checks is not reported ready.'
  );

  insert into core_platform_results values(
    'p21_safe_policy',
    snapshot->'policy'->>'health_requires_verification_evidence'='true'
      and snapshot->'policy'->>'stale_is_not_healthy'='true'
      and snapshot->'policy'->>'smtp_requires_invitation_delivery'='true'
      and snapshot->'policy'->>'smtp_requires_password_reset_delivery'='true'
      and snapshot->'policy'->>'production_deployment_from_atlas'='false'
      and snapshot->'policy'->>'production_sync_enabled'='false'
      and snapshot->'policy'->>'automatic_external_side_effects'='false'
      and snapshot->'policy'->>'secrets_returned'='false'
      and snapshot->'policy'->>'tokens_returned'='false',
    'P2.1 keeps release, sync, external side effects and secrets disabled.'
  );

  insert into core_platform_results
  select 'p21_freshness_windows',
         count(*)=9
           and bool_and(stale_after_seconds>=21600)
           and min(case when provider_key='custom-smtp' then stale_after_seconds end)=2592000,
         'Core platform checks use operational freshness windows instead of immediate false degradation.'
  from atlas_private.integration_connections
  where provider_key in (
    'production-auth','production-data','atlas-private-database',
    'atlas-private-edge','atlas-private-storage','github','netlify',
    'supabase','custom-smtp'
  );

  insert into core_platform_results values(
    'p21_service_role_rpc_only',
    not has_function_privilege('anon','public.atlas_core_platform_snapshot(uuid,text)','execute')
      and not has_function_privilege('authenticated','public.atlas_core_platform_snapshot(uuid,text)','execute')
      and has_function_privilege('service_role','public.atlas_core_platform_snapshot(uuid,text)','execute'),
    'P2.1 release-readiness RPC is service-role-only.'
  );

  denied:=false;
  begin
    perform public.atlas_core_platform_snapshot(actor_id,'bartender');
  exception when others then denied:=true;
  end;
  insert into core_platform_results values(
    'p21_bartender_denied',denied,
    'Bartender cannot query manager-level platform readiness.'
  );
end
$core_platform_acceptance$;

do $core_platform_failure_gate$
begin
  if exists(select 1 from core_platform_results where not passed) then
    raise exception 'P2.1 core-platform acceptance failed: %',(
      select string_agg(test_name,', ' order by test_name)
      from core_platform_results where not passed
    );
  end if;
end
$core_platform_failure_gate$;

select jsonb_build_object(
  'passed',bool_and(passed),
  'passed_count',count(*) filter(where passed),
  'failed_count',count(*) filter(where not passed),
  'rolled_back',true,
  'tests',jsonb_agg(jsonb_build_object(
    'test',test_name,'passed',passed,'detail',detail
  ) order by test_name)
)
from core_platform_results;

rollback;
