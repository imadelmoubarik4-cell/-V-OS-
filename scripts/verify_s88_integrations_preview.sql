-- S88 preview-only integrations/OAuth acceptance. Rolled back.
-- Proves browser roles cannot read credential rows or call the integration
-- RPCs, OAuth state is single-use, "connected" needs a stored credential, and
-- no snapshot the browser receives carries credential-shaped keys.

begin;

create temporary table s88_integrations (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s88_integrations to anon, authenticated, service_role;

create or replace function pg_temp.s88_has_secret_keys(p_value jsonb)
returns boolean language sql immutable as $$
  select coalesce(p_value::text ~* '"(ciphertext|nonce|verifier|verifier_ciphertext|verifier_nonce|access_token|refresh_token|api_key|client_secret|state_hash|code_verifier)"\s*:', false);
$$;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088001','authenticated','authenticated','s88-int-mgr@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
update public.profiles set role='manager', active=true where id='00000000-0000-4000-8000-000000088001';

-- ---------------------------------------------------------------- privileges

insert into s88_integrations
select format('%s has no privilege on atlas_private.%s', r.role_name, t.table_name),
       not has_table_privilege(r.role_name, format('atlas_private.%I', t.table_name), 'select,insert,update,delete')
from (values ('anon'),('authenticated')) r(role_name)
cross join (values ('integration_credentials'),('integration_oauth_states'),('integration_events'),('integration_connections')) t(table_name);

insert into s88_integrations
select format('%s cannot execute %s', r.role_name, p.oid::regprocedure),
       not has_function_privilege(r.role_name, p.oid, 'execute')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'),('authenticated'),('public')) r(role_name)
where (n.nspname = 'public' and p.proname like 'atlas\_integration\_%')
   or (n.nspname = 'atlas_private' and p.proname like 'integration\_%' and p.proname <> 'integration_connections');

insert into s88_integrations values
  ('service_role can execute the status wrapper', has_function_privilege('service_role', 'public.atlas_integration_status(text)', 'execute')),
  ('RLS is enabled on the three new tables', (
    select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'atlas_private' and c.relname in ('integration_credentials','integration_oauth_states','integration_events')
  )),
  ('no policy grants browser roles access to credential tables', not exists (
    select 1 from pg_policies p
    where p.schemaname = 'atlas_private'
      and p.tablename in ('integration_credentials','integration_oauth_states','integration_events')
      and (p.roles && array['anon','authenticated','public']::name[])
  )),
  ('google-drive provider row exists', exists (select 1 from atlas_private.integration_connections where provider_key = 'google-drive' and auth_kind = 'oauth2')),
  ('tripadvisor is an API-key provider', exists (select 1 from atlas_private.integration_connections where provider_key = 'tripadvisor' and auth_kind = 'api_key'));

-- ---------------------------------------------------------------- service-role flow (fixtures)

set local role service_role;

select public.atlas_integration_begin(
  'google-drive', repeat('ab', 32), repeat('cd', 40), repeat('ef', 12), 1::smallint, '#knowledge',
  '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager'
);
select public.atlas_integration_begin(
  'tiktok', repeat('12', 32), null, null, null, '#settings',
  '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager'
);
-- A consumed-by-expiry fixture.
select public.atlas_integration_begin(
  'facebook', repeat('34', 32), null, null, null, '#settings',
  '00000000-0000-4000-8000-000000088001', 'S88 manager', 'admin'
);
reset role;
update atlas_private.integration_oauth_states set expires_at = now() - interval '1 second' where state_hash = decode(repeat('34', 32), 'hex');
set local role service_role;

do $flow$
declare
  v_first jsonb;
  v_second jsonb;
  v_blocked boolean;
begin
  insert into s88_integrations values ('raw state is never stored', not exists (
    select 1 from information_schema.columns where table_schema = 'atlas_private' and table_name = 'integration_oauth_states' and column_name = 'state'
  ));

  v_first := public.atlas_integration_consume_state('google-drive', repeat('ab', 32));
  v_second := public.atlas_integration_consume_state('google-drive', repeat('ab', 32));
  insert into s88_integrations values
    ('state is consumed once', v_first is not null and v_first->>'return_path' = '#knowledge' and v_first->>'actor_role' = 'manager'),
    ('state replay is rejected', v_second is null),
    ('state bound to its provider', public.atlas_integration_consume_state('google-business-profile', repeat('12', 32)) is null),
    ('state for the right provider still works once', public.atlas_integration_consume_state('tiktok', repeat('12', 32)) is not null),
    ('expired state is rejected', public.atlas_integration_consume_state('facebook', repeat('34', 32)) is null);

  v_blocked := false;
  begin
    perform public.atlas_integration_begin('google-drive', repeat('56', 32), null, null, null, '#settings',
      '00000000-0000-4000-8000-000000088001', 'S88 bartender', 'bartender');
  exception when insufficient_privilege then v_blocked := true;
  end;
  insert into s88_integrations values ('bartender cannot start a connection', v_blocked);

  v_blocked := false;
  begin
    perform public.atlas_integration_begin('google-drive', repeat('57', 32), null, null, null, 'https://evil.example',
      '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  exception when check_violation then v_blocked := true;
  end;
  insert into s88_integrations values ('absolute return targets are rejected', v_blocked);

  v_blocked := false;
  begin
    perform public.atlas_integration_begin('tripadvisor', repeat('58', 32), null, null, null, '#settings',
      '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  exception when invalid_parameter_value then v_blocked := true;
  end;
  insert into s88_integrations values ('API-key providers cannot start OAuth', v_blocked);

  v_blocked := false;
  begin
    perform public.atlas_integration_record_result('google-drive', 'verified', 'x', 'Drive', array['s'], null, null, null,
      '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  exception when invalid_parameter_value then v_blocked := true;
  end;
  insert into s88_integrations values ('connected requires a stored credential', v_blocked);

  perform public.atlas_integration_store_credential('google-drive', 'oauth_token_set', repeat('aa', 48), repeat('bb', 12), 1::smallint,
    now() + interval '1 hour', null, null, '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  insert into s88_integrations values ('stored credential alone is not connected', exists (
    select 1 from atlas_private.integration_connections where provider_key = 'google-drive' and status = 'authorization_required'
  ));

  perform public.atlas_integration_record_result('google-drive', 'verify_failed', null, null, null, null, true, 'HTTP 401',
    '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  insert into s88_integrations values ('failed verification is not connected', exists (
    select 1 from atlas_private.integration_connections where provider_key = 'google-drive' and status = 'expired' and last_connection_error = 'HTTP 401'
  ));

  perform public.atlas_integration_record_result('google-drive', 'verified', 'perm-1', 'VÁ Drive', array['https://www.googleapis.com/auth/drive.file'], null, null, null,
    '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  insert into s88_integrations values ('verified credential is connected', exists (
    select 1 from atlas_private.integration_connections
    where provider_key = 'google-drive' and status = 'connected' and last_verified_at is not null and external_account_label = 'VÁ Drive'
  ));

  v_blocked := false;
  begin
    perform public.atlas_integration_status('bartender');
  exception when insufficient_privilege then v_blocked := true;
  end;
  insert into s88_integrations values ('status is manager-only', v_blocked);

  insert into s88_integrations values
    ('status output has no credential keys', not pg_temp.s88_has_secret_keys(public.atlas_integration_status('manager'))),
    ('status reports the credential exists', exists (
      select 1 from jsonb_array_elements(public.atlas_integration_status('admin')) row
      where row->>'provider_key' = 'google-drive' and (row->>'has_credential')::boolean
    ));

  v_blocked := false;
  begin
    insert into atlas_private.integration_events (provider_key, event_type, payload)
    values ('google-drive', 'verified', '{"detail":{"access_token":"x"}}'::jsonb);
  exception when check_violation then v_blocked := true;
  end;
  insert into s88_integrations values ('events reject nested token payloads', v_blocked);

  v_blocked := false;
  begin
    perform public.atlas_integration_store_credential('google-drive', 'api_key', repeat('aa', 48), repeat('bb', 12), 1::smallint,
      null, null, null, '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
  exception when invalid_parameter_value then v_blocked := true;
  end;
  insert into s88_integrations values ('credential kind must match the provider', v_blocked);
end
$flow$;

reset role;

-- ---------------------------------------------------------------- browser probes

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088001',true);

do $probe$
declare
  v_blocked boolean;
  v_table text;
begin
  foreach v_table in array array['integration_credentials','integration_oauth_states','integration_events'] loop
    v_blocked := false;
    begin
      execute format('select count(*) from atlas_private.%I', v_table);
    exception when insufficient_privilege then v_blocked := true;
    end;
    insert into s88_integrations values (format('manager JWT cannot read %s', v_table), v_blocked);
  end loop;

  v_blocked := false;
  begin
    perform public.atlas_integration_read_credential('google-drive', 'admin');
  exception when insufficient_privilege then v_blocked := true;
  end;
  insert into s88_integrations values ('manager JWT cannot call the credential reader', v_blocked);

  v_blocked := false;
  begin
    perform public.atlas_integration_consume_state('google-drive', repeat('ab', 32));
  exception when insufficient_privilege then v_blocked := true;
  end;
  insert into s88_integrations values ('manager JWT cannot consume OAuth state', v_blocked);
end
$probe$;

reset role;

set local role anon;
do $anon$
declare v_blocked boolean := false;
begin
  begin
    perform 1 from atlas_private.integration_credentials;
  exception when insufficient_privilege then v_blocked := true;
  end;
  insert into s88_integrations values ('anon cannot read credentials', v_blocked);
end
$anon$;
reset role;

-- ---------------------------------------------------------------- snapshots stay credential-free

set local role service_role;
insert into s88_integrations values
  ('settings snapshot has no credential keys', not pg_temp.s88_has_secret_keys(
    public.atlas_settings_snapshot('[]'::jsonb, '00000000-0000-4000-8000-000000088001', 'manager'))),
  ('operations settings has no credential keys', not pg_temp.s88_has_secret_keys(public.atlas_operations_settings())),
  -- atlas_system_snapshot needs Reports tables absent from the replay DB, so
  -- prove structurally that no function outside the integration RPCs reads
  -- the credential or state tables.
  ('only integration RPCs reference credential tables', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','atlas_private')
      and p.prosrc ~ 'integration_(credentials|oauth_states)'
      and not (p.proname like 'integration\_%' or p.proname like 'atlas\_integration\_%')
  )),
  ('marketing snapshot has no credential keys', not pg_temp.s88_has_secret_keys(
    public.atlas_marketing_workspace_snapshot('00000000-0000-4000-8000-000000088001', 'manager', current_date, current_date + 7)));

select public.atlas_integration_disconnect('google-drive', '00000000-0000-4000-8000-000000088001', 'S88 manager', 'manager');
reset role;

insert into s88_integrations values
  ('disconnect removes the credential', not exists (select 1 from atlas_private.integration_credentials where provider_key = 'google-drive')),
  ('disconnect resets status', exists (
    select 1 from atlas_private.integration_connections
    where provider_key = 'google-drive' and status = 'not_connected' and last_verified_at is null and external_account_label is null
  )),
  ('events recorded the lifecycle', (
    select count(distinct event_type) >= 5 from atlas_private.integration_events where provider_key = 'google-drive'
  ));

select jsonb_build_object(
  's88_integrations', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed', coalesce(jsonb_agg(test_name order by test_name) filter (where not passed), '[]'::jsonb)
) from s88_integrations;

rollback;
