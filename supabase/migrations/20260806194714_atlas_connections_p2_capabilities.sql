create or replace function atlas_private.connections_set_capability(
  p_connection_key text,
  p_capability_key text,
  p_capability_kind text,
  p_grant_state text,
  p_risk_level text,
  p_manager_approval_required boolean,
  p_metadata jsonb,
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
  previous_row atlas_private.connection_capability_grants;
  result_row atlas_private.connection_capability_grants;
  admin_required boolean;
begin
  perform atlas_private.connection_assert_actor(p_actor_role,true,false);
  perform atlas_private.connection_assert_safe_json(coalesce(p_metadata,'{}'::jsonb));
  if not exists (
    select 1 from atlas_private.integration_connections
    where provider_key=p_connection_key and active=true
  ) then raise exception 'Connection is not registered'; end if;
  if p_capability_key !~ '^[a-z][a-z0-9._-]{2,119}$' then
    raise exception 'Capability key is invalid';
  end if;
  if p_capability_kind not in ('read','write','publish','admin') then
    raise exception 'Capability kind is invalid';
  end if;
  if p_grant_state not in (
    'not_requested','verification_required','read_only','granted',
    'denied','blocked','not_supported'
  ) then raise exception 'Capability grant state is invalid'; end if;
  if p_risk_level not in ('low','medium','high','critical') then
    raise exception 'Capability risk level is invalid';
  end if;

  admin_required := p_grant_state='granted'
    and (p_capability_kind in ('write','publish','admin') or p_risk_level in ('high','critical'));
  if admin_required then
    perform atlas_private.connection_assert_actor(p_actor_role,true,true);
    perform set_config('atlas.allow_high_risk_capability_grant','on',true);
  end if;

  select * into previous_row
  from atlas_private.connection_capability_grants
  where connection_key=p_connection_key and capability_key=p_capability_key;

  insert into atlas_private.connection_capability_grants(
    connection_key,capability_key,capability_kind,grant_state,risk_level,
    manager_approval_required,automatic_execution_allowed,reviewed_at,
    reviewed_by,reviewed_by_label,metadata
  ) values (
    p_connection_key,p_capability_key,p_capability_kind,p_grant_state,p_risk_level,
    coalesce(p_manager_approval_required,false),false,now(),p_actor_id,
    left(coalesce(p_actor_label,''),160),coalesce(p_metadata,'{}'::jsonb)
  )
  on conflict (connection_key,capability_key) do update
  set capability_kind=excluded.capability_kind,
      grant_state=excluded.grant_state,
      risk_level=excluded.risk_level,
      manager_approval_required=excluded.manager_approval_required,
      automatic_execution_allowed=false,
      reviewed_at=excluded.reviewed_at,
      reviewed_by=excluded.reviewed_by,
      reviewed_by_label=excluded.reviewed_by_label,
      metadata=excluded.metadata,
      updated_at=now()
  returning * into result_row;

  insert into atlas_private.connection_events(
    connection_key,event_type,actor_id,actor_label,actor_role,payload
  ) values (
    p_connection_key,'capability_changed',p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,
    jsonb_build_object(
      'capability_key',p_capability_key,
      'previous_grant_state',previous_row.grant_state,
      'new_grant_state',result_row.grant_state,
      'risk_level',result_row.risk_level,
      'automatic_execution_allowed',false
    )
  );

  return to_jsonb(result_row);
end;
$function$;

create or replace function atlas_private.connections_ping()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select jsonb_build_object(
    'version','atlas-connections/0.1.0',
    'checked_at',now(),
    'registry_rows',(select count(*) from atlas_private.integration_connections where active),
    'automatic_external_side_effects',false
  );
$function$;
