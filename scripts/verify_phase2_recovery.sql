\set ON_ERROR_STOP on

begin;
create temporary table recovery_results(
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;

do $recovery_acceptance$
declare
  actor_id constant uuid := '10000000-0000-4000-8000-000000000001';
  request_key uuid := gen_random_uuid();
  first_check jsonb;
  second_check jsonb;
  check_id uuid;
  event_id uuid;
  denied boolean;
  automatic_allowed boolean;
begin
  insert into recovery_results values(
    'stale_success_degrades',
    atlas_private.connection_effective_state(
      'healthy',now()-interval '2 hours',null,60
    )='degraded',
    'A stale successful check is no longer healthy.'
  );

  insert into recovery_results values(
    'expired_authorization_expires',
    atlas_private.connection_effective_state(
      'healthy',now(),now()-interval '1 minute',3600
    )='expired',
    'An expired token overrides a previously healthy state.'
  );

  insert into recovery_results values(
    'healthy_without_evidence_verifies',
    atlas_private.connection_effective_state(
      'healthy',null,null,3600
    )='verifying',
    'A healthy label without successful evidence resolves to verifying.'
  );

  insert into recovery_results values(
    'blocked_state_is_preserved',
    atlas_private.connection_effective_state(
      'blocked',now(),null,3600
    )='blocked',
    'A blocked connection cannot be softened by recent timestamps.'
  );

  insert into recovery_results values(
    'not_configured_is_not_healthy',
    atlas_private.connection_effective_state(
      'not_configured',now(),null,3600
    )='not_configured',
    'Missing configuration remains explicit.'
  );

  first_check:=public.atlas_connections_begin_check(
    'github',request_key,'synthetic','system',
    actor_id,'Recovery acceptance','admin'
  );
  second_check:=public.atlas_connections_begin_check(
    'github',request_key,'synthetic','system',
    actor_id,'Recovery acceptance','admin'
  );
  check_id:=(first_check->>'id')::uuid;

  insert into recovery_results values(
    'health_check_idempotent',
    first_check->>'id'=second_check->>'id',
    'Repeating the same request ID returns the same health-check record.'
  );

  perform public.atlas_connections_finish_check(
    check_id,'degraded','failed',500,'PROVIDER_UNAVAILABLE',
    'Recovery fixture provider outage.',
    '{"fixture":true,"credential_returned":false}'::jsonb,
    actor_id,'Recovery acceptance','admin'
  );

  insert into recovery_results
  select 'failed_check_no_false_success',
         check_row.status='failed'
           and check_row.state_after='degraded'
           and connection.health_state='degraded'
           and connection.last_error_code='PROVIDER_UNAVAILABLE'
           and atlas_private.connection_effective_state(
             connection.health_state,connection.last_succeeded_at,
             connection.token_expires_at,connection.stale_after_seconds
           )='degraded',
         'A provider outage persists a failed check and degraded connection state.'
  from atlas_private.connection_health_checks check_row
  join atlas_private.integration_connections connection
    on connection.provider_key=check_row.connection_key
  where check_row.id=check_id;

  denied:=false;
  begin
    update atlas_private.connection_health_checks
    set summary='tampered'
    where id=check_id;
  exception when others then denied:=true;
  end;
  insert into recovery_results values(
    'completed_check_immutable',denied,
    'Completed health-check evidence rejects updates.'
  );

  select id into event_id
  from atlas_private.connection_events
  where health_check_id=check_id
  order by created_at desc
  limit 1;
  denied:=false;
  begin
    update atlas_private.connection_events
    set payload=payload||'{"tampered":true}'::jsonb
    where id=event_id;
  exception when others then denied:=true;
  end;
  insert into recovery_results values(
    'event_history_append_only',denied,
    'Connection event history rejects mutation.'
  );

  denied:=false;
  begin
    update atlas_private.integration_connections
    set health_state='healthy',last_succeeded_at=now()
    where provider_key='github';
  exception when others then denied:=true;
  end;
  insert into recovery_results values(
    'direct_healthy_denied',denied,
    'Only the controlled completed-check workflow can create a healthy state.'
  );

  perform set_config('atlas.allow_high_risk_capability_grant','on',true);
  insert into atlas_private.connection_capability_grants(
    connection_key,capability_key,capability_kind,grant_state,risk_level,
    manager_approval_required,automatic_execution_allowed,metadata
  ) values (
    'github','recovery.fixture.write','write','granted','high',true,true,
    '{"fixture":true}'::jsonb
  )
  on conflict (connection_key,capability_key) do update
  set grant_state='granted',
      capability_kind='write',
      risk_level='high',
      manager_approval_required=true,
      automatic_execution_allowed=true,
      metadata='{"fixture":true}'::jsonb;

  select automatic_execution_allowed into automatic_allowed
  from atlas_private.connection_capability_grants
  where connection_key='github'
    and capability_key='recovery.fixture.write';
  insert into recovery_results values(
    'automatic_execution_forced_off',automatic_allowed is false,
    'Even an approved high-risk capability cannot enable automatic execution.'
  );
end
$recovery_acceptance$;

do $recovery_failure_gate$
begin
  if exists(select 1 from recovery_results where not passed) then
    raise exception 'P2.6 recovery acceptance failed: %',(
      select string_agg(test_name,', ' order by test_name)
      from recovery_results where not passed
    );
  end if;
end
$recovery_failure_gate$;

select jsonb_build_object(
  'passed',bool_and(passed),
  'passed_count',count(*) filter(where passed),
  'failed_count',count(*) filter(where not passed),
  'rolled_back',true,
  'tests',jsonb_agg(jsonb_build_object(
    'test',test_name,'passed',passed,'detail',detail
  ) order by test_name)
)
from recovery_results;

rollback;