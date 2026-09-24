-- S88 item 7: server-side OAuth / API-key foundation for Atlas integrations.
--
-- * Credentials are encrypted in the atlas-integrations Edge Function
--   (AES-256-GCM, key from a function secret). The database stores only
--   ciphertext + nonce + key version and never sees plaintext tokens.
-- * OAuth state is stored as sha256(state); it is single-use and expires
--   after 10 minutes. PKCE verifiers are stored encrypted.
-- * Every new table lives in atlas_private with RLS on and a service-role-only
--   policy; anon/authenticated have no privileges. All RPCs are service-role
--   only and are reached through the Edge Function, which checks the JWT and
--   the active manager/admin profile.
-- * "connected" is written only by integration_record_result('verified'), and
--   only while a credential row exists.
-- Additive and backwards compatible with existing Settings/Marketing/System
-- snapshots, which read integration_connections but never the new tables.

alter table atlas_private.integration_connections
  add column if not exists auth_kind text not null default 'oauth2',
  add column if not exists scopes_granted text[] not null default '{}'::text[],
  add column if not exists connected_by uuid,
  add column if not exists connected_by_label text,
  add column if not exists connected_at timestamptz,
  add column if not exists disconnected_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'integration_connections_auth_kind_check'
      and conrelid = 'atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_auth_kind_check
      check (auth_kind in ('oauth2','api_key','none'));
  end if;
end $$;

insert into atlas_private.integration_connections (provider_key,label,category,status,capabilities,requirements,metadata,auth_kind)
values
  ('instagram','Instagram','social','not_connected','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'oauth2'),
  ('facebook','Facebook','social','not_connected','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'oauth2'),
  ('tiktok','TikTok','social','not_connected','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'oauth2'),
  ('google-business-profile','Google Business Profile','business_profile','not_connected','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'oauth2'),
  ('tripadvisor','Tripadvisor','reputation','not_connected','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'api_key'),
  ('google-drive','Google Drive','storage','not_connected','{"knowledge_sync":"requires_oauth"}'::jsonb,'{"atlas_runtime_oauth":true}'::jsonb,'{}'::jsonb,'oauth2')
on conflict (provider_key) do nothing;

update atlas_private.integration_connections
set auth_kind = case when provider_key = 'tripadvisor' then 'api_key' else 'oauth2' end,
    metadata = metadata || jsonb_build_object(
      'credentials_stored_outside_table', true,
      'credential_encryption', 'aes-256-gcm-edge-function',
      'managed_by', 'atlas-integrations'
    ),
    updated_at = now()
where provider_key in ('instagram','facebook','tiktok','google-business-profile','tripadvisor','google-drive');

create table if not exists atlas_private.integration_credentials (
  provider_key text primary key
    references atlas_private.integration_connections(provider_key) on delete cascade,
  credential_kind text not null check (credential_kind in ('oauth_token_set','api_key')),
  ciphertext bytea not null check (octet_length(ciphertext) between 17 and 65536),
  nonce bytea not null check (octet_length(nonce) = 12),
  key_version smallint not null check (key_version > 0),
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  external_account_id text check (external_account_id is null or length(external_account_id) <= 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table if not exists atlas_private.integration_oauth_states (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  provider_key text not null
    references atlas_private.integration_connections(provider_key) on delete cascade,
  actor_id uuid not null,
  actor_label text,
  actor_role text not null check (actor_role in ('admin','manager')),
  verifier_ciphertext bytea,
  verifier_nonce bytea check (verifier_nonce is null or octet_length(verifier_nonce) = 12),
  key_version smallint check (key_version is null or key_version > 0),
  return_path text not null check (return_path ~ '^#[a-z][a-z0-9-]{0,40}(/[a-z0-9-]{1,40}){0,3}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz,
  constraint integration_oauth_states_verifier_complete check (
    (verifier_ciphertext is null and verifier_nonce is null and key_version is null)
    or (verifier_ciphertext is not null and verifier_nonce is not null and key_version is not null)
  )
);

create index if not exists integration_oauth_states_expiry_idx
  on atlas_private.integration_oauth_states(expires_at);

create table if not exists atlas_private.integration_events (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null
    references atlas_private.integration_connections(provider_key) on delete cascade,
  event_type text not null check (event_type in (
    'connect_started','credential_stored','connected','callback_failed','verified','verify_failed',
    'refreshed','refresh_failed','disconnected','api_key_saved'
  )),
  actor_id uuid,
  actor_label text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint integration_events_payload_object check (jsonb_typeof(payload) = 'object'),
  -- No credential-shaped key anywhere in the payload, at any depth.
  constraint integration_events_payload_no_secrets check (
    payload::text !~* '"(access_token|refresh_token|id_token|token|code|code_verifier|verifier|client_secret|app_secret|api_key|secret|password|ciphertext|nonce|state)"\s*:'
  )
);

create index if not exists integration_events_provider_idx
  on atlas_private.integration_events(provider_key, created_at desc);

alter table atlas_private.integration_credentials enable row level security;
alter table atlas_private.integration_oauth_states enable row level security;
alter table atlas_private.integration_events enable row level security;

drop policy if exists "service role manages integration credentials" on atlas_private.integration_credentials;
create policy "service role manages integration credentials" on atlas_private.integration_credentials
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages integration oauth states" on atlas_private.integration_oauth_states;
create policy "service role manages integration oauth states" on atlas_private.integration_oauth_states
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages integration events" on atlas_private.integration_events;
create policy "service role manages integration events" on atlas_private.integration_events
  for all to service_role using (true) with check (true);

revoke all on atlas_private.integration_credentials from public, anon, authenticated;
revoke all on atlas_private.integration_oauth_states from public, anon, authenticated;
revoke all on atlas_private.integration_events from public, anon, authenticated;
grant select, insert, update, delete on atlas_private.integration_credentials to service_role;
grant select, insert, update, delete on atlas_private.integration_oauth_states to service_role;
grant select, insert on atlas_private.integration_events to service_role;

-- ------------------------------------------------------------------ helpers

create or replace function atlas_private.integration_assert_manager(p_actor_role text)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_actor_role is null or p_actor_role not in ('admin','manager') then
    raise exception 'Only managers and administrators can manage integrations'
      using errcode = '42501';
  end if;
end;
$function$;

create or replace function atlas_private.integration_assert_provider(p_provider_key text)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if p_provider_key is null
    or p_provider_key not in ('google-business-profile','google-drive','facebook','instagram','tiktok','tripadvisor')
    or not exists (select 1 from atlas_private.integration_connections c where c.provider_key = p_provider_key)
  then
    raise exception 'Unknown integration provider' using errcode = '22023';
  end if;
end;
$function$;

create or replace function atlas_private.integration_hex(p_value text, p_label text)
returns bytea
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_value is null or p_value !~ '^[0-9a-f]+$' or length(p_value) % 2 <> 0 then
    raise exception '% must be lowercase hex', p_label using errcode = '22023';
  end if;
  return pg_catalog.decode(p_value, 'hex');
end;
$function$;

-- ------------------------------------------------------------------ status

create or replace function atlas_private.integration_status(p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider_key', c.provider_key,
      'label', c.label,
      'category', c.category,
      'auth_kind', c.auth_kind,
      'status', c.status,
      'authorization_state', c.authorization_state,
      'scopes_granted', to_jsonb(c.scopes_granted),
      'external_account_label', c.external_account_label,
      'last_verified_at', c.last_verified_at,
      'token_expires_at', c.token_expires_at,
      'last_connection_error', c.last_connection_error,
      'connected_by_label', c.connected_by_label,
      'connected_at', c.connected_at,
      'disconnected_at', c.disconnected_at,
      'has_credential', (cr.provider_key is not null),
      'credential_access_expires_at', cr.access_expires_at,
      'credential_refresh_expires_at', cr.refresh_expires_at,
      'recent_events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'event_type', e.event_type, 'actor_label', e.actor_label, 'created_at', e.created_at
        ) order by e.created_at desc)
        from (
          select ev.event_type, ev.actor_label, ev.created_at
          from atlas_private.integration_events ev
          where ev.provider_key = c.provider_key
          order by ev.created_at desc
          limit 5
        ) e
      ), '[]'::jsonb)
    ) order by c.label)
    from atlas_private.integration_connections c
    left join atlas_private.integration_credentials cr on cr.provider_key = c.provider_key
    where c.provider_key in ('google-business-profile','google-drive','facebook','instagram','tiktok','tripadvisor')
  ), '[]'::jsonb);
end;
$function$;

-- ------------------------------------------------------------------ OAuth state

create or replace function atlas_private.integration_begin(
  p_provider_key text,
  p_state_hash text,
  p_verifier_ciphertext text,
  p_verifier_nonce text,
  p_key_version smallint,
  p_return_path text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_expires timestamptz;
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  if p_actor_id is null then
    raise exception 'Actor is required' using errcode = '22023';
  end if;
  if (select c.auth_kind from atlas_private.integration_connections c where c.provider_key = p_provider_key) <> 'oauth2' then
    raise exception 'This provider does not use OAuth' using errcode = '22023';
  end if;

  delete from atlas_private.integration_oauth_states s
  where s.expires_at < now() - interval '1 day'
     or (s.consumed_at is not null and s.consumed_at < now() - interval '1 day');

  insert into atlas_private.integration_oauth_states (
    state_hash, provider_key, actor_id, actor_label, actor_role,
    verifier_ciphertext, verifier_nonce, key_version, return_path
  ) values (
    atlas_private.integration_hex(p_state_hash, 'State hash'),
    p_provider_key, p_actor_id, left(p_actor_label, 200), p_actor_role,
    case when p_verifier_ciphertext is null then null else atlas_private.integration_hex(p_verifier_ciphertext, 'Verifier') end,
    case when p_verifier_nonce is null then null else atlas_private.integration_hex(p_verifier_nonce, 'Verifier nonce') end,
    case when p_verifier_ciphertext is null then null else p_key_version end,
    p_return_path
  )
  returning expires_at into v_expires;

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (p_provider_key, 'connect_started', p_actor_id, left(p_actor_label, 200), '{}'::jsonb);

  return jsonb_build_object('expires_at', v_expires);
end;
$function$;

-- Single use: the update succeeds once, for the matching provider, before expiry.
create or replace function atlas_private.integration_consume_state(
  p_provider_key text,
  p_state_hash text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_row atlas_private.integration_oauth_states%rowtype;
begin
  update atlas_private.integration_oauth_states s
  set consumed_at = now()
  where s.state_hash = atlas_private.integration_hex(p_state_hash, 'State hash')
    and s.provider_key = p_provider_key
    and s.consumed_at is null
    and s.expires_at > now()
  returning s.* into v_row;

  if v_row.state_hash is null then
    return null;
  end if;

  return jsonb_build_object(
    'provider_key', v_row.provider_key,
    'actor_id', v_row.actor_id,
    'actor_label', v_row.actor_label,
    'actor_role', v_row.actor_role,
    'verifier_ciphertext', case when v_row.verifier_ciphertext is null then null else pg_catalog.encode(v_row.verifier_ciphertext, 'hex') end,
    'verifier_nonce', case when v_row.verifier_nonce is null then null else pg_catalog.encode(v_row.verifier_nonce, 'hex') end,
    'key_version', v_row.key_version,
    'return_path', v_row.return_path
  );
end;
$function$;

-- ------------------------------------------------------------------ credentials

create or replace function atlas_private.integration_store_credential(
  p_provider_key text,
  p_credential_kind text,
  p_ciphertext text,
  p_nonce text,
  p_key_version smallint,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_external_account_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_auth_kind text;
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  select c.auth_kind into v_auth_kind from atlas_private.integration_connections c where c.provider_key = p_provider_key;
  if (v_auth_kind = 'oauth2' and p_credential_kind <> 'oauth_token_set')
    or (v_auth_kind = 'api_key' and p_credential_kind <> 'api_key') then
    raise exception 'Credential kind does not match the provider' using errcode = '22023';
  end if;

  insert into atlas_private.integration_credentials as cr (
    provider_key, credential_kind, ciphertext, nonce, key_version,
    access_expires_at, refresh_expires_at, external_account_id, created_by
  ) values (
    p_provider_key, p_credential_kind,
    atlas_private.integration_hex(p_ciphertext, 'Ciphertext'),
    atlas_private.integration_hex(p_nonce, 'Nonce'),
    p_key_version, p_access_expires_at, p_refresh_expires_at, left(p_external_account_id, 200), p_actor_id
  )
  on conflict (provider_key) do update set
    credential_kind = excluded.credential_kind,
    ciphertext = excluded.ciphertext,
    nonce = excluded.nonce,
    key_version = excluded.key_version,
    access_expires_at = excluded.access_expires_at,
    refresh_expires_at = excluded.refresh_expires_at,
    external_account_id = coalesce(excluded.external_account_id, cr.external_account_id),
    rotated_at = now();

  -- A stored credential is not a connection yet: verification must succeed.
  update atlas_private.integration_connections c
  set status = case when c.status = 'connected' then 'connected' else 'authorization_required' end,
      authorization_state = case when c.status = 'connected' then c.authorization_state else 'waiting_authorization' end,
      token_expires_at = p_access_expires_at,
      updated_by = p_actor_id,
      updated_by_label = left(p_actor_label, 200),
      updated_at = now()
  where c.provider_key = p_provider_key;

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (
    p_provider_key,
    case when p_credential_kind = 'api_key' then 'api_key_saved' else 'credential_stored' end,
    p_actor_id, left(p_actor_label, 200),
    jsonb_build_object('key_version', p_key_version)
  );

  return jsonb_build_object('stored', true);
end;
$function$;

-- Service-role read of the encrypted credential for the Edge Function only.
create or replace function atlas_private.integration_read_credential(
  p_provider_key text,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_row atlas_private.integration_credentials%rowtype;
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  select * into v_row from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key;
  if v_row.provider_key is null then
    return null;
  end if;
  return jsonb_build_object(
    'credential_kind', v_row.credential_kind,
    'ciphertext', pg_catalog.encode(v_row.ciphertext, 'hex'),
    'nonce', pg_catalog.encode(v_row.nonce, 'hex'),
    'key_version', v_row.key_version,
    'access_expires_at', v_row.access_expires_at,
    'refresh_expires_at', v_row.refresh_expires_at
  );
end;
$function$;

-- verified | verify_failed | callback_failed | refreshed | refresh_failed
create or replace function atlas_private.integration_record_result(
  p_provider_key text,
  p_event_type text,
  p_account_id text,
  p_account_label text,
  p_scopes text[],
  p_access_expires_at timestamptz,
  p_needs_reauthorization boolean,
  p_error text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_has_credential boolean;
  v_error text := left(regexp_replace(coalesce(p_error, ''), '[^[:print:]]', ' ', 'g'), 240);
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  if p_event_type not in ('verified','verify_failed','callback_failed','refreshed','refresh_failed') then
    raise exception 'Unsupported integration result' using errcode = '22023';
  end if;
  v_has_credential := exists (select 1 from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key);

  if p_event_type = 'verified' then
    if not v_has_credential then
      raise exception 'An integration cannot be connected without a stored credential' using errcode = '22023';
    end if;
    update atlas_private.integration_connections c
    set status = 'connected',
        authorization_state = 'authorized',
        external_account_id = left(p_account_id, 200),
        external_account_label = left(p_account_label, 200),
        scopes_granted = coalesce(p_scopes, c.scopes_granted),
        token_expires_at = coalesce(p_access_expires_at, c.token_expires_at),
        last_verified_at = now(),
        last_connection_error = null,
        connected_by = coalesce(c.connected_by, p_actor_id),
        connected_by_label = coalesce(c.connected_by_label, left(p_actor_label, 200)),
        connected_at = coalesce(c.connected_at, now()),
        disconnected_at = null,
        updated_by = p_actor_id,
        updated_by_label = left(p_actor_label, 200),
        updated_at = now()
    where c.provider_key = p_provider_key;
    update atlas_private.integration_credentials cr
    set external_account_id = coalesce(left(p_account_id, 200), cr.external_account_id)
    where cr.provider_key = p_provider_key;
  elsif p_event_type = 'refreshed' then
    update atlas_private.integration_connections c
    set token_expires_at = p_access_expires_at, updated_at = now()
    where c.provider_key = p_provider_key;
  else
    update atlas_private.integration_connections c
    set status = case
          when not v_has_credential then 'not_connected'
          when coalesce(p_needs_reauthorization, false) then 'expired'
          else 'degraded'
        end,
        authorization_state = case
          when not v_has_credential then 'not_connected'
          when coalesce(p_needs_reauthorization, false) then 'expired'
          else 'waiting_authorization'
        end,
        last_connection_error = nullif(v_error, ''),
        updated_by = p_actor_id,
        updated_by_label = left(p_actor_label, 200),
        updated_at = now()
    where c.provider_key = p_provider_key;
  end if;

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (
    p_provider_key, p_event_type, p_actor_id, left(p_actor_label, 200),
    jsonb_strip_nulls(jsonb_build_object(
      'account_label', left(p_account_label, 200),
      'error', nullif(v_error, ''),
      'needs_reauthorization', p_needs_reauthorization
    ))
  );

  return jsonb_build_object('recorded', p_event_type);
end;
$function$;

create or replace function atlas_private.integration_disconnect(
  p_provider_key text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_deleted integer;
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  delete from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key;
  get diagnostics v_deleted = row_count;
  delete from atlas_private.integration_oauth_states s where s.provider_key = p_provider_key and s.consumed_at is null;

  update atlas_private.integration_connections c
  set status = 'not_connected',
      authorization_state = 'not_connected',
      external_account_id = null,
      external_account_label = null,
      scopes_granted = '{}'::text[],
      token_expires_at = null,
      last_verified_at = null,
      last_connection_error = null,
      connected_by = null,
      connected_by_label = null,
      connected_at = null,
      disconnected_at = now(),
      updated_by = p_actor_id,
      updated_by_label = left(p_actor_label, 200),
      updated_at = now()
  where c.provider_key = p_provider_key;

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (p_provider_key, 'disconnected', p_actor_id, left(p_actor_label, 200),
          jsonb_build_object('credential_removed', v_deleted > 0));

  return jsonb_build_object('disconnected', true, 'credential_removed', v_deleted > 0);
end;
$function$;

-- ------------------------------------------------------------------ public service-role wrappers

create or replace function public.atlas_integration_status(p_actor_role text)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select atlas_private.integration_status(p_actor_role); $$;

create or replace function public.atlas_integration_begin(
  p_provider_key text, p_state_hash text, p_verifier_ciphertext text, p_verifier_nonce text,
  p_key_version smallint, p_return_path text, p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_begin(p_provider_key, p_state_hash, p_verifier_ciphertext, p_verifier_nonce,
  p_key_version, p_return_path, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_consume_state(p_provider_key text, p_state_hash text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_consume_state(p_provider_key, p_state_hash); $$;

create or replace function public.atlas_integration_store_credential(
  p_provider_key text, p_credential_kind text, p_ciphertext text, p_nonce text, p_key_version smallint,
  p_access_expires_at timestamptz, p_refresh_expires_at timestamptz, p_external_account_id text,
  p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_store_credential(p_provider_key, p_credential_kind, p_ciphertext, p_nonce,
  p_key_version, p_access_expires_at, p_refresh_expires_at, p_external_account_id, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_read_credential(p_provider_key text, p_actor_role text)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select atlas_private.integration_read_credential(p_provider_key, p_actor_role); $$;

create or replace function public.atlas_integration_record_result(
  p_provider_key text, p_event_type text, p_account_id text, p_account_label text, p_scopes text[],
  p_access_expires_at timestamptz, p_needs_reauthorization boolean, p_error text,
  p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_record_result(p_provider_key, p_event_type, p_account_id, p_account_label,
  p_scopes, p_access_expires_at, p_needs_reauthorization, p_error, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_disconnect(
  p_provider_key text, p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_disconnect(p_provider_key, p_actor_id, p_actor_label, p_actor_role); $$;

do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'atlas_private.integration_assert_manager(text)',
    'atlas_private.integration_assert_provider(text)',
    'atlas_private.integration_hex(text, text)',
    'atlas_private.integration_status(text)',
    'atlas_private.integration_begin(text, text, text, text, smallint, text, uuid, text, text)',
    'atlas_private.integration_consume_state(text, text)',
    'atlas_private.integration_store_credential(text, text, text, text, smallint, timestamptz, timestamptz, text, uuid, text, text)',
    'atlas_private.integration_read_credential(text, text)',
    'atlas_private.integration_record_result(text, text, text, text, text[], timestamptz, boolean, text, uuid, text, text)',
    'atlas_private.integration_disconnect(text, uuid, text, text)',
    'public.atlas_integration_status(text)',
    'public.atlas_integration_begin(text, text, text, text, smallint, text, uuid, text, text)',
    'public.atlas_integration_consume_state(text, text)',
    'public.atlas_integration_store_credential(text, text, text, text, smallint, timestamptz, timestamptz, text, uuid, text, text)',
    'public.atlas_integration_read_credential(text, text)',
    'public.atlas_integration_record_result(text, text, text, text, text[], timestamptz, boolean, text, uuid, text, text)',
    'public.atlas_integration_disconnect(text, uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$grants$;

comment on table atlas_private.integration_credentials is
  'S88: AES-256-GCM ciphertext of provider credentials, encrypted in the atlas-integrations Edge Function. Service role only; never returned to the browser.';
comment on table atlas_private.integration_oauth_states is
  'S88: sha256 of single-use OAuth state (10 minute expiry) and encrypted PKCE verifier. Service role only.';
comment on table atlas_private.integration_events is
  'S88: integration audit trail. Payload may not contain credential-shaped keys.';

notify pgrst, 'reload schema';
