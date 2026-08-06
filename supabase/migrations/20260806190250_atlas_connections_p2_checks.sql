create or replace function atlas_private.connections_begin_check(
  p_connection_key text,
  p_request_id uuid,
  p_check_kind text,
  p_trigger_source text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  connection_row atlas_private.integration_connections;
  check_row atlas_private.connection_health_checks;
  previous_state text;
begin
  perform atlas_private.connection_assert_actor(p_actor_role,true,false);
  if p_request_id is null then raise exception 'Connection check request id is required'; end if;
  if p_check_kind not in ('automated','manual','synthetic','configuration') then
    raise exception 'Connection check kind is invalid';
  end if;
  if p_trigger_source not in ('manager','scheduled','system','startup','api') then
    raise exception 'Connection check trigger is invalid';
  end if;

  select * into check_row
  from atlas_private.connection_health_checks
  where connection_key=p_connection_key and request_id=p_request_id;
  if found then return to_jsonb(check_row); end if;

  select * into connection_row
  from atlas_private.integration_connections
  where provider_key=p_connection_key and active is true
  for update;
  if not found then raise exception 'Connection is not registered'; end if;
  if connection_row.health_state='intentionally_disabled' and p_check_kind<>'manual' then
    raise exception 'Connection is intentionally disabled by policy';
  end if;

  previous_state := atlas_private.connection_effective_state(
    connection_row.health_state,connection_row.last_succeeded_at,
    connection_row.token_expires_at,connection_row.stale_after_seconds
  );

  insert into atlas_private.connection_health_checks(
    request_id,connection_key,check_kind,trigger_source,status,state_before,
    actor_id,actor_label,actor_role
  ) values (
    p_request_id,p_connection_key,p_check_kind,p_trigger_source,'running',previous_state,
    p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role
  ) returning * into check_row;

  update atlas_private.integration_connections
  set health_state='verifying',last_checked_at=now(),
      updated_by=p_actor_id,updated_by_label=left(coalesce(p_actor_label,''),160)
  where provider_key=p_connection_key;

  insert into atlas_private.connection_events(
    connection_key,health_check_id,event_type,previous_state,new_state,
    actor_id,actor_label,actor_role,payload
  ) values (
    p_connection_key,check_row.id,'check_started',previous_state,'verifying',
    p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,
    jsonb_build_object('request_id',p_request_id,'check_kind',p_check_kind,'trigger_source',p_trigger_source)
  );

  return to_jsonb(check_row);
end;
$function$;

create or replace function atlas_private.connections_finish_check(
  p_check_id uuid,
  p_result_state text,
  p_outcome text,
  p_latency_ms integer,
  p_error_code text,
  p_summary text,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  check_row atlas_private.connection_health_checks;
  connection_row atlas_private.integration_connections;
  previous_state text;
begin
  perform atlas_private.connection_assert_actor(p_actor_role,true,false);
  perform atlas_private.connection_assert_safe_json(coalesce(p_evidence,'{}'::jsonb));

  if p_result_state not in (
    'not_configured','authorization_required','verifying','healthy',
    'degraded','expired','blocked','intentionally_disabled'
  ) then raise exception 'Connection result state is invalid'; end if;
  if p_outcome not in ('passed','failed','skipped') then
    raise exception 'Connection outcome is invalid';
  end if;
  if p_outcome='passed' and p_result_state<>'healthy' then
    raise exception 'A passed connection check must produce healthy state';
  end if;
  if p_result_state='healthy' and p_outcome<>'passed' then
    raise exception 'Healthy connection state requires a passed verification check';
  end if;
  if p_outcome='failed' and p_result_state not in ('degraded','expired','blocked') then
    raise exception 'A failed connection check must produce degraded, expired or blocked state';
  end if;
  if p_latency_ms is not null and (p_latency_ms<0 or p_latency_ms>120000) then
    raise exception 'Connection latency is invalid';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{3,80}$' then
    raise exception 'Connection error code is invalid';
  end if;

  select * into check_row
  from atlas_private.connection_health_checks
  where id=p_check_id
  for update;
  if not found then raise exception 'Connection check was not found'; end if;
  if check_row.status<>'running' then return to_jsonb(check_row); end if;

  select * into connection_row
  from atlas_private.integration_connections
  where provider_key=check_row.connection_key
  for update;
  if not found then raise exception 'Connection registry row was not found'; end if;

  previous_state := atlas_private.connection_effective_state(
    connection_row.health_state,connection_row.last_succeeded_at,
    connection_row.token_expires_at,connection_row.stale_after_seconds
  );

  update atlas_private.connection_health_checks
  set status=p_outcome,state_after=p_result_state,finished_at=now(),
      latency_ms=p_latency_ms,error_code=nullif(p_error_code,''),
      summary=left(nullif(trim(coalesce(p_summary,'')),''),1000),
      evidence=coalesce(p_evidence,'{}'::jsonb)
  where id=check_row.id
  returning * into check_row;

  if p_result_state='healthy' then
    perform set_config('atlas.allow_connection_verified','on',true);
  end if;

  update atlas_private.integration_connections
  set health_state=p_result_state,
      last_checked_at=now(),
      last_succeeded_at=case when p_outcome='passed' then now() else last_succeeded_at end,
      last_failed_at=case when p_outcome='failed' then now() else last_failed_at end,
      last_verified_at=case when p_outcome='passed' then now() else last_verified_at end,
      latency_ms=p_latency_ms,
      last_error_code=case when p_outcome='failed' then nullif(p_error_code,'') else null end,
      last_error_summary=case when p_outcome='failed' then left(nullif(trim(coalesce(p_summary,'')),''),500) else null end,
      last_connection_error=case when p_outcome='failed' then left(nullif(trim(coalesce(p_summary,'')),''),500) else null end,
      updated_by=p_actor_id,
      updated_by_label=left(coalesce(p_actor_label,''),160)
  where provider_key=check_row.connection_key
  returning * into connection_row;

  insert into atlas_private.connection_events(
    connection_key,health_check_id,event_type,previous_state,new_state,
    actor_id,actor_label,actor_role,payload
  ) values (
    check_row.connection_key,check_row.id,'check_completed',previous_state,p_result_state,
    p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,
    jsonb_build_object(
      'outcome',p_outcome,'latency_ms',p_latency_ms,
      'error_code',nullif(p_error_code,''),'summary',left(coalesce(p_summary,''),500)
    )
  );

  if previous_state is distinct from p_result_state then
    insert into atlas_private.connection_events(
      connection_key,health_check_id,event_type,previous_state,new_state,
      actor_id,actor_label,actor_role,payload
    ) values (
      check_row.connection_key,check_row.id,'state_changed',previous_state,p_result_state,
      p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,'{}'::jsonb
    );
  end if;

  return jsonb_build_object('check',to_jsonb(check_row),'connection',to_jsonb(connection_row));
end;
$function$;
