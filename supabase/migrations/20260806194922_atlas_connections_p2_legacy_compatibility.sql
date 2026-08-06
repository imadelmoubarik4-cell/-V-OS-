-- P2.0 compatibility: legacy connection writers may report a provider as
-- connected after configuration, but they may not manufacture canonical healthy
-- state. Preserve the legacy operation while translating it to verifying until
-- a controlled P2.0 health check supplies successful evidence.
create or replace function atlas_private.connection_sync_compatibility()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  if tg_op='UPDATE'
     and new.health_state is not distinct from old.health_state
     and new.status is distinct from old.status then
    new.health_state := case new.status
      when 'connected' then 'verifying'
      when 'authorization_required' then 'authorization_required'
      when 'pending_review' then 'verifying'
      when 'degraded' then 'degraded'
      when 'expired' then 'expired'
      when 'not_applicable' then 'intentionally_disabled'
      else 'not_configured'
    end;
  end if;

  if new.token_expires_at is not null
     and new.token_expires_at <= now()
     and new.health_state not in ('blocked','intentionally_disabled') then
    new.health_state := 'expired';
  end if;

  if new.health_state='healthy'
     and (tg_op='INSERT' or new.health_state is distinct from old.health_state)
     and coalesce(current_setting('atlas.allow_connection_verified',true),'') <> 'on' then
    raise exception 'Healthy connection state requires a completed controlled health check'
      using errcode='42501';
  end if;
  if new.health_state='healthy' and new.last_succeeded_at is null then
    raise exception 'Healthy connection state requires successful verification evidence';
  end if;

  new.status := case new.health_state
    when 'healthy' then 'connected'
    when 'authorization_required' then 'authorization_required'
    when 'verifying' then 'pending_review'
    when 'degraded' then 'degraded'
    when 'expired' then 'expired'
    when 'blocked' then 'degraded'
    when 'intentionally_disabled' then 'not_applicable'
    else 'not_connected'
  end;

  if tg_op='UPDATE' then new.version := old.version + 1; end if;
  new.updated_at := now();
  return new;
end;
$function$;

comment on function atlas_private.connection_sync_compatibility() is
  'P2.0 compatibility bridge. Legacy connected status becomes verifying; only a passed controlled health check may create canonical healthy state.';
