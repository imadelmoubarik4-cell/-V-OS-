-- S94B Social Publishing Connections (docs/marketing/S94_Publishing_Architecture.md §4).
--
-- Extends the S88 integrations foundation for publishing:
-- * integration_connections.publishing_review_state (admin-set platform review)
--   and a derived publishing_permission_state written on every verify,
--   resource change and review change (fixes the Marketing "waiting for
--   authorization" display after a successful verify, report 02 §9).
-- * atlas_private.integration_resources: Pages / Instagram accounts / Business
--   Profile accounts+locations / TikTok account listed live by the Edge
--   Function (ids, labels, non-secret metadata only); one selected per kind.
-- * atlas_private.integration_resource_credentials: the selected Facebook Page
--   access token (for Facebook and Instagram publishing), AES-256-GCM
--   ciphertext made in the Edge Function (AAD
--   atlas-integrations|<provider>|resource|<resource_id>). Plaintext never
--   reaches the database.
-- * OAuth state purpose ('connect' | 'publishing') so "Allow publishing"
--   requests connect ∪ publish scopes; event types publish_scope_requested,
--   resource_listed, resource_selected, credential_used, review_state_set.
-- * Worker-only RPCs: atlas_integration_publish_targets() (readiness),
--   atlas_integration_read_credential_for_delivery(delivery, claim token) and
--   a lease-based refresh lock (refresh_lock / refresh_store / refresh_release)
--   so concurrent workers never race a rotating refresh token.
--
-- atlas_private.marketing_deliveries is created LATER by the S94C migration
-- (20261004092000). Only plpgsql bodies reference it; PL/pgSQL resolves table
-- names when a statement first runs, not when the function is created, so
-- this migration applies without that table. Each such function checks
-- to_regclass() first and refuses ('publishing_not_installed') until S94C is
-- applied. Keep these functions plpgsql (a SQL-language body would be
-- validated at creation and fail).
--
-- Every table: atlas_private, RLS on, service-role-only policy, no browser
-- grants. Every function: security definer, search_path = '', execute revoked
-- from public/anon/authenticated and granted to service_role only. Functions
-- that act for a person re-check the active profile and role in SQL.

-- ------------------------------------------------------------------ columns

alter table atlas_private.integration_connections
  add column if not exists publishing_review_state text not null default 'unknown';

do $s94b_columns$
begin
  if not exists (select 1 from pg_constraint where conname = 'integration_connections_publishing_review_state_check'
      and conrelid = 'atlas_private.integration_connections'::regclass) then
    alter table atlas_private.integration_connections add constraint integration_connections_publishing_review_state_check
      check (publishing_review_state in ('not_required','unknown','required','pending','approved','rejected'));
  end if;
end
$s94b_columns$;

alter table atlas_private.integration_oauth_states
  add column if not exists purpose text not null default 'connect';

do $s94b_purpose$
begin
  if not exists (select 1 from pg_constraint where conname = 'integration_oauth_states_purpose_check'
      and conrelid = 'atlas_private.integration_oauth_states'::regclass) then
    alter table atlas_private.integration_oauth_states add constraint integration_oauth_states_purpose_check
      check (purpose in ('connect','publishing'));
  end if;
end
$s94b_purpose$;

-- Lease used by the refresh lock (a PostgREST call is its own transaction, so
-- a row lock alone could not span the provider call).
alter table atlas_private.integration_credentials
  add column if not exists refresh_lock_token uuid,
  add column if not exists refresh_locked_until timestamptz,
  add column if not exists refresh_lock_actor_id uuid,
  add column if not exists refresh_lock_actor_label text;

alter table atlas_private.integration_events drop constraint if exists integration_events_event_type_check;
alter table atlas_private.integration_events add constraint integration_events_event_type_check check (event_type in (
  'connect_started','credential_stored','connected','callback_failed','verified','verify_failed',
  'refreshed','refresh_failed','disconnected','api_key_saved',
  'publish_scope_requested','resource_listed','resource_selected','credential_used','review_state_set'
));

-- ------------------------------------------------------------------ tables

create table if not exists atlas_private.integration_resources (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null
    references atlas_private.integration_connections(provider_key) on delete cascade,
  resource_kind text not null
    check (resource_kind in ('facebook_page','instagram_account','gbp_account','gbp_location','tiktok_account')),
  resource_id text not null
    check (length(resource_id) between 1 and 200 and resource_id ~ '^[A-Za-z0-9_.:/-]+$'),
  parent_resource_id text
    check (parent_resource_id is null or (length(parent_resource_id) between 1 and 200 and parent_resource_id ~ '^[A-Za-z0-9_.:/-]+$')),
  label text not null check (length(label) between 1 and 200),
  metadata jsonb not null default '{}'::jsonb,
  selected boolean not null default false,
  selected_at timestamptz,
  selected_by uuid,
  selected_by_label text,
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint integration_resources_unique unique (provider_key, resource_kind, resource_id),
  constraint integration_resources_kind_matches_provider check (
    (provider_key = 'facebook' and resource_kind = 'facebook_page')
    or (provider_key = 'instagram' and resource_kind = 'instagram_account')
    or (provider_key = 'google-business-profile' and resource_kind in ('gbp_account','gbp_location'))
    or (provider_key = 'tiktok' and resource_kind = 'tiktok_account')
  ),
  constraint integration_resources_metadata_object check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  constraint integration_resources_metadata_no_secrets check (
    metadata::text !~* '"(access_token|refresh_token|id_token|token|code|code_verifier|verifier|client_secret|app_secret|api_key|secret|password|ciphertext|nonce|state)"\s*:'
  )
);

-- At most one selected resource per provider and kind.
create unique index if not exists integration_resources_one_selected
  on atlas_private.integration_resources(provider_key, resource_kind) where selected;

create table if not exists atlas_private.integration_resource_credentials (
  provider_key text not null,
  resource_kind text not null check (resource_kind in ('facebook_page','instagram_account')),
  resource_id text not null,
  ciphertext bytea not null check (octet_length(ciphertext) between 17 and 65536),
  nonce bytea not null check (octet_length(nonce) = 12),
  key_version smallint not null check (key_version > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  primary key (provider_key, resource_kind, resource_id),
  foreign key (provider_key, resource_kind, resource_id)
    references atlas_private.integration_resources(provider_key, resource_kind, resource_id) on delete cascade
);

alter table atlas_private.integration_resources enable row level security;
alter table atlas_private.integration_resource_credentials enable row level security;

drop policy if exists "service role manages integration resources" on atlas_private.integration_resources;
create policy "service role manages integration resources" on atlas_private.integration_resources
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages integration resource credentials" on atlas_private.integration_resource_credentials;
create policy "service role manages integration resource credentials" on atlas_private.integration_resource_credentials
  for all to service_role using (true) with check (true);

revoke all on atlas_private.integration_resources from public, anon, authenticated;
revoke all on atlas_private.integration_resource_credentials from public, anon, authenticated;
grant select, insert, update, delete on atlas_private.integration_resources to service_role;
grant select, insert, update, delete on atlas_private.integration_resource_credentials to service_role;

comment on table atlas_private.integration_resources is
  'S94B: publishing targets listed live from the provider (Pages, Instagram accounts, Business Profile accounts/locations, TikTok account). Ids, labels and non-secret metadata only; one selected per provider and kind. Service role only.';
comment on table atlas_private.integration_resource_credentials is
  'S94B: AES-256-GCM ciphertext of the selected Facebook Page access token (Facebook and Instagram publishing), encrypted in the atlas-integrations Edge Function with AAD atlas-integrations|<provider>|resource|<resource_id>. Service role only.';
comment on column atlas_private.integration_connections.publishing_review_state is
  'S94B: platform review of Atlas''s publishing access, set by an administrator (not readable by API). TikTok Direct Post needs approved; for Google Business Profile approved means Business Profile API access was granted.';

-- ------------------------------------------------------------------ helpers

-- Contract §4 publish scopes (connect scopes stay in providers.mjs `scopes`).
create or replace function atlas_private.integration_publish_scopes(p_provider_key text)
returns text[]
language sql
immutable
security definer
set search_path = ''
as $function$
  select case p_provider_key
    when 'facebook' then array['pages_show_list','pages_read_engagement','pages_manage_posts','business_management']
    when 'instagram' then array['instagram_basic','instagram_content_publish','pages_show_list','pages_read_engagement','business_management']
    when 'tiktok' then array['video.upload','video.publish']
    when 'google-business-profile' then array['https://www.googleapis.com/auth/business.manage']
    else array[]::text[]
  end;
$function$;

-- The resource a delivery publishes to, per provider.
create or replace function atlas_private.integration_primary_resource_kind(p_provider_key text)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select case p_provider_key
    when 'facebook' then 'facebook_page'
    when 'instagram' then 'instagram_account'
    when 'google-business-profile' then 'gbp_location'
    when 'tiktok' then 'tiktok_account'
    else null
  end;
$function$;

create or replace function atlas_private.integration_assert_publishing_provider(p_provider_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.integration_assert_provider(p_provider_key);
  if p_provider_key not in ('facebook','instagram','tiktok','google-business-profile') then
    raise exception 'This provider does not publish' using errcode = '22023';
  end if;
end;
$function$;

create or replace function atlas_private.integration_assert_admin(p_actor_id uuid, p_actor_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  if p_actor_role is distinct from 'admin' then
    raise exception 'Only administrators can set the platform review state' using errcode = '42501';
  end if;
end;
$function$;

-- publishing_permission_state, derived from the connection (contract §4):
--   granted       all publish scopes granted. Google Business Profile: the
--                 business.manage scope, a selected location (listing it
--                 proved API access) and a review state that is not
--                 required/pending/rejected.
--   missing       connected (verified at least once) without them.
--   pending       Google Business Profile only: scope granted, location or
--                 API access not confirmed yet.
--   not_requested no stored credential, or never verified.
-- Other providers are left as they are (not_supported / not_requested).
create or replace function atlas_private.integration_derive_publishing(p_provider_key text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_scopes text[];
  v_verified timestamptz;
  v_review text;
  v_has_credential boolean;
  v_state text;
begin
  if p_provider_key not in ('facebook','instagram','tiktok','google-business-profile') then
    return null;
  end if;
  select c.status, c.scopes_granted, c.last_verified_at, c.publishing_review_state
    into v_status, v_scopes, v_verified, v_review
  from atlas_private.integration_connections c
  where c.provider_key = p_provider_key
  for update;
  if not found then
    return null;
  end if;
  v_has_credential := exists (select 1 from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key);

  if not v_has_credential or v_status = 'not_connected' or v_verified is null then
    v_state := 'not_requested';
  elsif p_provider_key = 'google-business-profile' then
    if not (atlas_private.integration_publish_scopes(p_provider_key) <@ coalesce(v_scopes, '{}'::text[])) then
      v_state := 'missing';
    elsif exists (
      select 1 from atlas_private.integration_resources r
      where r.provider_key = p_provider_key and r.resource_kind = 'gbp_location' and r.selected
    ) and v_review not in ('required','pending','rejected') then
      v_state := 'granted';
    else
      v_state := 'pending';
    end if;
  elsif atlas_private.integration_publish_scopes(p_provider_key) <@ coalesce(v_scopes, '{}'::text[]) then
    v_state := 'granted';
  else
    v_state := 'missing';
  end if;

  update atlas_private.integration_connections c
  set publishing_permission_state = v_state
  where c.provider_key = p_provider_key and c.publishing_permission_state is distinct from v_state;
  return v_state;
end;
$function$;

-- Listed resources for the status payload (no credential columns).
create or replace function atlas_private.integration_resources_json(p_provider_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'resource_kind', r.resource_kind,
    'resource_id', r.resource_id,
    'parent_resource_id', r.parent_resource_id,
    'label', r.label,
    'metadata', r.metadata,
    'selected', r.selected,
    'selected_at', r.selected_at,
    'selected_by_label', r.selected_by_label,
    'has_resource_credential', exists (
      select 1 from atlas_private.integration_resource_credentials rc
      where rc.provider_key = r.provider_key and rc.resource_kind = r.resource_kind and rc.resource_id = r.resource_id
    ),
    'refreshed_at', r.refreshed_at
  ) order by r.resource_kind, r.selected desc, lower(r.label), r.resource_id), '[]'::jsonb)
  from atlas_private.integration_resources r
  where r.provider_key = p_provider_key;
$function$;

-- True when the delivery exists, belongs to the provider (when given) and is
-- currently claimed with this token. S94C table; see the header note.
create or replace function atlas_private.integration_delivery_claim_ok(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_provider_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_ok boolean;
begin
  if p_delivery_id is null or p_claim_token is null
    or pg_catalog.to_regclass('atlas_private.marketing_deliveries') is null then
    return false;
  end if;
  select true into v_ok
  from atlas_private.marketing_deliveries d
  where d.id = p_delivery_id
    and d.claim_token = p_claim_token
    and d.claimed_until > now()
    and (p_provider_key is null or d.provider_key = p_provider_key);
  return coalesce(v_ok, false);
end;
$function$;

-- ------------------------------------------------------------------ S88 functions extended

-- Status now also carries the publishing fields and listed resources.
create or replace function atlas_private.integration_status(p_actor_role text, p_actor_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider_key', c.provider_key,
      'label', c.label,
      'category', c.category,
      'auth_kind', c.auth_kind,
      'status', c.status,
      'authorization_state', c.authorization_state,
      'publishing_permission_state', c.publishing_permission_state,
      'publishing_review_state', c.publishing_review_state,
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
      'resources', atlas_private.integration_resources_json(c.provider_key),
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

-- The hop needs the purpose to build the scope list.
create or replace function atlas_private.integration_bind_browser(
  p_provider_key text,
  p_state_hash text,
  p_binding_hash text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_expires timestamptz;
  v_purpose text;
begin
  update atlas_private.integration_oauth_states s
  set browser_binding_hash = atlas_private.integration_hex(p_binding_hash, 'Binding hash'),
      bound_at = now()
  where s.state_hash = atlas_private.integration_hex(p_state_hash, 'State hash')
    and s.provider_key = p_provider_key
    and s.consumed_at is null
    and s.expires_at > now()
    and s.browser_binding_hash is null
  returning s.expires_at, s.purpose into v_expires, v_purpose;
  if v_expires is null then
    return null;
  end if;
  return jsonb_build_object('bound', true, 'expires_at', v_expires, 'purpose', v_purpose);
end;
$function$;

-- As S88 (hardened, 20260926106000) plus: verified prefers the selected
-- resource as the external account, and publishing_permission_state is
-- derived after every result.
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
  v_selected_id text;
  v_selected_label text;
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  if p_event_type not in ('verified','verify_failed','callback_failed','refreshed','refresh_failed') then
    raise exception 'Unsupported integration result' using errcode = '22023';
  end if;
  v_has_credential := exists (select 1 from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key);

  if p_event_type = 'verified' then
    if not v_has_credential then
      raise exception 'An integration cannot be connected without a stored credential' using errcode = '22023';
    end if;
    select r.resource_id, r.label into v_selected_id, v_selected_label
    from atlas_private.integration_resources r
    where r.provider_key = p_provider_key and r.selected
      and r.resource_kind = atlas_private.integration_primary_resource_kind(p_provider_key);
    update atlas_private.integration_connections c
    set status = 'connected',
        authorization_state = 'authorized',
        external_account_id = left(coalesce(v_selected_id, p_account_id), 200),
        external_account_label = left(coalesce(v_selected_label, p_account_label), 200),
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

  perform atlas_private.integration_derive_publishing(p_provider_key);

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

-- As S88 plus: listed resources and their Page tokens go with the connection;
-- the admin-set review state is platform-level and is kept.
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
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
  delete from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key;
  get diagnostics v_deleted = row_count;
  delete from atlas_private.integration_oauth_states s where s.provider_key = p_provider_key and s.consumed_at is null;
  delete from atlas_private.integration_resources r where r.provider_key = p_provider_key;

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
      publishing_permission_state = case
        when p_provider_key in ('facebook','instagram','tiktok','google-business-profile') then 'not_requested'
        else c.publishing_permission_state
      end,
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

-- ------------------------------------------------------------------ S94B actor RPCs

-- Marks a just-started, unbound state (started by this actor) as a
-- publishing consent: the hop then asks for connect ∪ publish scopes.
create or replace function atlas_private.integration_set_state_purpose(
  p_provider_key text,
  p_state_hash text,
  p_purpose text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_updated integer;
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_publishing_provider(p_provider_key);
  if p_purpose is null or p_purpose not in ('connect','publishing') then
    raise exception 'Unsupported connection purpose' using errcode = '22023';
  end if;
  update atlas_private.integration_oauth_states s
  set purpose = p_purpose
  where s.state_hash = atlas_private.integration_hex(p_state_hash, 'State hash')
    and s.provider_key = p_provider_key
    and s.actor_id = p_actor_id
    and s.consumed_at is null
    and s.browser_binding_hash is null
    and s.expires_at > now();
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'The connection request was not found' using errcode = '22023';
  end if;
  if p_purpose = 'publishing' then
    insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
    values (p_provider_key, 'publish_scope_requested', p_actor_id, left(p_actor_label, 200),
            jsonb_build_object('scope_count', cardinality(atlas_private.integration_publish_scopes(p_provider_key))));
  end if;
  return jsonb_build_object('purpose', p_purpose);
end;
$function$;

-- Replaces the provider's listed resources with a fresh live listing.
-- p_resources: [{resource_kind, resource_id, parent_resource_id, label, metadata}].
-- Resources that disappeared at the provider are removed (with any Page
-- token). Nothing is selected by default, except the TikTok account: a
-- TikTok token belongs to exactly one account, so there is no choice to make.
create or replace function atlas_private.integration_resources_store(
  p_provider_key text,
  p_resources jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_item jsonb;
  v_ids text[] := '{}'::text[];
  v_count integer := 0;
  v_kind text;
  v_id text;
  v_label text;
  v_parent text;
  v_metadata jsonb;
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_publishing_provider(p_provider_key);
  if not exists (select 1 from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key) then
    raise exception 'Connect this provider before listing its accounts' using errcode = '22023';
  end if;
  if p_resources is null or jsonb_typeof(p_resources) <> 'array' or jsonb_array_length(p_resources) > 500 then
    raise exception 'Resources must be an array of at most 500 entries' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_resources) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each resource must be an object' using errcode = '22023';
    end if;
    v_kind := v_item->>'resource_kind';
    v_id := v_item->>'resource_id';
    v_parent := nullif(v_item->>'parent_resource_id', '');
    v_label := left(regexp_replace(coalesce(nullif(btrim(v_item->>'label'), ''), v_id, ''), '[^[:print:]]', ' ', 'g'), 200);
    v_metadata := coalesce(v_item->'metadata', '{}'::jsonb);
    if jsonb_typeof(v_metadata) <> 'object' then
      raise exception 'Resource metadata must be an object' using errcode = '22023';
    end if;
    insert into atlas_private.integration_resources as r (
      provider_key, resource_kind, resource_id, parent_resource_id, label, metadata, refreshed_at
    ) values (p_provider_key, v_kind, v_id, v_parent, v_label, v_metadata, now())
    on conflict (provider_key, resource_kind, resource_id) do update set
      parent_resource_id = excluded.parent_resource_id,
      label = excluded.label,
      metadata = excluded.metadata,
      refreshed_at = now();
    v_ids := v_ids || (v_kind || '|' || v_id);
    v_count := v_count + 1;
  end loop;

  delete from atlas_private.integration_resources r
  where r.provider_key = p_provider_key
    and not ((r.resource_kind || '|' || r.resource_id) = any (v_ids));

  -- A selected resource that is no longer selectable loses its selection.
  update atlas_private.integration_resources r
  set selected = false, selected_at = null, selected_by = null, selected_by_label = null
  where r.provider_key = p_provider_key and r.selected and r.metadata->>'selectable' = 'false';
  delete from atlas_private.integration_resource_credentials rc
  where rc.provider_key = p_provider_key
    and not exists (
      select 1 from atlas_private.integration_resources r
      where r.provider_key = rc.provider_key and r.resource_kind = rc.resource_kind
        and r.resource_id = rc.resource_id and r.selected
    );

  if p_provider_key = 'tiktok'
    and (select count(*) from atlas_private.integration_resources r where r.provider_key = 'tiktok' and r.resource_kind = 'tiktok_account') = 1
    and not exists (select 1 from atlas_private.integration_resources r where r.provider_key = 'tiktok' and r.selected) then
    update atlas_private.integration_resources r
    set selected = true, selected_at = now(), selected_by = p_actor_id, selected_by_label = left(p_actor_label, 200)
    where r.provider_key = 'tiktok' and r.resource_kind = 'tiktok_account';
  end if;

  update atlas_private.integration_connections c
  set external_account_id = coalesce(sel.resource_id, c.external_account_id),
      external_account_label = coalesce(sel.label, c.external_account_label),
      updated_at = now()
  from (
    select r.resource_id, r.label from atlas_private.integration_resources r
    where r.provider_key = p_provider_key and r.selected
      and r.resource_kind = atlas_private.integration_primary_resource_kind(p_provider_key)
  ) sel
  where c.provider_key = p_provider_key;

  perform atlas_private.integration_derive_publishing(p_provider_key);

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (p_provider_key, 'resource_listed', p_actor_id, left(p_actor_label, 200),
          jsonb_build_object('resource_count', v_count));

  return jsonb_build_object(
    'resources', atlas_private.integration_resources_json(p_provider_key),
    'publishing_permission_state', (select c.publishing_permission_state from atlas_private.integration_connections c where c.provider_key = p_provider_key)
  );
end;
$function$;

-- Selects one listed resource. Facebook Pages and Instagram accounts carry
-- the Page access token as ciphertext (encrypted in the Edge Function); other
-- kinds must not. Selecting a Business Profile location also selects the
-- account it was listed under (needed for the v4 localPosts path).
create or replace function atlas_private.integration_resource_select(
  p_provider_key text,
  p_resource_kind text,
  p_resource_id text,
  p_ciphertext text,
  p_nonce text,
  p_key_version smallint,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_parent text;
  v_label text;
  v_metadata jsonb;
  v_needs_token boolean := p_resource_kind in ('facebook_page','instagram_account');
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_publishing_provider(p_provider_key);
  if p_resource_kind is distinct from atlas_private.integration_primary_resource_kind(p_provider_key) then
    raise exception 'This kind of account cannot be chosen for this provider' using errcode = '22023';
  end if;
  if not exists (select 1 from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key) then
    raise exception 'Connect this provider before choosing an account' using errcode = '22023';
  end if;
  select r.id, r.parent_resource_id, r.label, r.metadata into v_id, v_parent, v_label, v_metadata
  from atlas_private.integration_resources r
  where r.provider_key = p_provider_key and r.resource_kind = p_resource_kind and r.resource_id = p_resource_id
  for update;
  if v_id is null then
    raise exception 'That account was not in the latest list' using errcode = '22023';
  end if;
  if v_metadata->>'selectable' = 'false' then
    raise exception 'That account cannot be used for publishing' using errcode = '22023';
  end if;
  if v_needs_token and (p_ciphertext is null or p_nonce is null or p_key_version is null) then
    raise exception 'A Page access credential is required for this account' using errcode = '22023';
  end if;
  if not v_needs_token and (p_ciphertext is not null or p_nonce is not null) then
    raise exception 'This account does not take a separate credential' using errcode = '22023';
  end if;

  update atlas_private.integration_resources r
  set selected = false, selected_at = null, selected_by = null, selected_by_label = null
  where r.provider_key = p_provider_key and r.selected
    and (r.resource_kind = p_resource_kind or (p_resource_kind = 'gbp_location' and r.resource_kind = 'gbp_account'));
  update atlas_private.integration_resources r
  set selected = true, selected_at = now(), selected_by = p_actor_id, selected_by_label = left(p_actor_label, 200)
  where r.id = v_id;
  if p_resource_kind = 'gbp_location' and v_parent is not null then
    update atlas_private.integration_resources r
    set selected = true, selected_at = now(), selected_by = p_actor_id, selected_by_label = left(p_actor_label, 200)
    where r.provider_key = p_provider_key and r.resource_kind = 'gbp_account' and r.resource_id = v_parent;
  end if;

  -- Only the selected resource keeps a stored Page token.
  delete from atlas_private.integration_resource_credentials rc
  where rc.provider_key = p_provider_key and not (rc.resource_kind = p_resource_kind and rc.resource_id = p_resource_id);
  if v_needs_token then
    insert into atlas_private.integration_resource_credentials as rc (
      provider_key, resource_kind, resource_id, ciphertext, nonce, key_version, created_by
    ) values (
      p_provider_key, p_resource_kind, p_resource_id,
      atlas_private.integration_hex(p_ciphertext, 'Ciphertext'),
      atlas_private.integration_hex(p_nonce, 'Nonce'),
      p_key_version, p_actor_id
    )
    on conflict (provider_key, resource_kind, resource_id) do update set
      ciphertext = excluded.ciphertext,
      nonce = excluded.nonce,
      key_version = excluded.key_version,
      created_by = excluded.created_by,
      rotated_at = now();
  end if;

  update atlas_private.integration_connections c
  set external_account_id = left(p_resource_id, 200),
      external_account_label = v_label,
      updated_by = p_actor_id,
      updated_by_label = left(p_actor_label, 200),
      updated_at = now()
  where c.provider_key = p_provider_key;

  perform atlas_private.integration_derive_publishing(p_provider_key);

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (p_provider_key, 'resource_selected', p_actor_id, left(p_actor_label, 200),
          jsonb_build_object('resource_kind', p_resource_kind, 'resource_id', left(p_resource_id, 200), 'account_label', v_label));

  return jsonb_build_object(
    'selected', jsonb_build_object('kind', p_resource_kind, 'id', p_resource_id, 'label', v_label),
    'resources', atlas_private.integration_resources_json(p_provider_key),
    'publishing_permission_state', (select c.publishing_permission_state from atlas_private.integration_connections c where c.provider_key = p_provider_key)
  );
end;
$function$;

-- Ciphertext of a stored resource credential for the Edge Function (actor
-- path, e.g. a manual check). Never reaches the browser.
create or replace function atlas_private.integration_read_resource_credential(
  p_provider_key text,
  p_resource_kind text,
  p_resource_id text,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_row record;
begin
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_publishing_provider(p_provider_key);
  select rc.ciphertext, rc.nonce, rc.key_version into v_row
  from atlas_private.integration_resource_credentials rc
  where rc.provider_key = p_provider_key and rc.resource_kind = p_resource_kind and rc.resource_id = p_resource_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'resource_kind', p_resource_kind,
    'resource_id', p_resource_id,
    'ciphertext', pg_catalog.encode(v_row.ciphertext, 'hex'),
    'nonce', pg_catalog.encode(v_row.nonce, 'hex'),
    'key_version', v_row.key_version
  );
end;
$function$;

-- Administrator only: platform review is not readable by API.
create or replace function atlas_private.integration_set_review_state(
  p_provider_key text,
  p_review_state text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_previous text;
begin
  perform atlas_private.integration_assert_admin(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_publishing_provider(p_provider_key);
  if p_review_state is null or p_review_state not in ('not_required','unknown','required','pending','approved','rejected') then
    raise exception 'Unsupported review state' using errcode = '22023';
  end if;
  select c.publishing_review_state into v_previous
  from atlas_private.integration_connections c where c.provider_key = p_provider_key for update;
  update atlas_private.integration_connections c
  set publishing_review_state = p_review_state,
      updated_by = p_actor_id,
      updated_by_label = left(p_actor_label, 200),
      updated_at = now()
  where c.provider_key = p_provider_key;
  perform atlas_private.integration_derive_publishing(p_provider_key);
  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (p_provider_key, 'review_state_set', p_actor_id, left(p_actor_label, 200),
          jsonb_build_object('previous', v_previous, 'review', p_review_state));
  return jsonb_build_object(
    'publishing_review_state', p_review_state,
    'publishing_permission_state', (select c.publishing_permission_state from atlas_private.integration_connections c where c.provider_key = p_provider_key)
  );
end;
$function$;

-- ------------------------------------------------------------------ worker/gateway RPCs (no actor)

-- Readiness per publishing provider (contract §4). `not_configured` depends on
-- Edge Function secrets the database cannot see; the gateways overlay it.
-- target_kinds lists what the review state allows; `ready` says whether a
-- delivery can publish now.
create or replace function atlas_private.integration_publish_targets()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb := '[]'::jsonb;
  v_row record;
  v_connection text;
  v_reason text;
  v_kinds text[];
  v_resource jsonb;
begin
  for v_row in
    select c.provider_key, c.status, c.last_verified_at, c.publishing_permission_state, c.publishing_review_state,
           cr.provider_key is not null as has_credential, cr.access_expires_at, cr.refresh_expires_at,
           sel.resource_kind, sel.resource_id, sel.label as resource_label,
           case when sel.resource_kind in ('facebook_page','instagram_account') then rc.resource_id is not null else true end as resource_credential_ok,
           gbp.selected_location
    from atlas_private.integration_connections c
    left join atlas_private.integration_credentials cr on cr.provider_key = c.provider_key
    left join atlas_private.integration_resources sel
      on sel.provider_key = c.provider_key and sel.selected
     and sel.resource_kind = atlas_private.integration_primary_resource_kind(c.provider_key)
    left join atlas_private.integration_resource_credentials rc
      on rc.provider_key = sel.provider_key and rc.resource_kind = sel.resource_kind and rc.resource_id = sel.resource_id
    left join lateral (
      select exists (select 1 from atlas_private.integration_resources g
                     where g.provider_key = c.provider_key and g.resource_kind = 'gbp_location' and g.selected) as selected_location
    ) gbp on true
    where c.provider_key in ('instagram','facebook','tiktok','google-business-profile')
    order by array_position(array['instagram','facebook','tiktok','google-business-profile'], c.provider_key)
  loop
    v_connection := case
      when not v_row.has_credential or v_row.status = 'not_connected' then 'not_connected'
      when v_row.status = 'expired'
        or (v_row.refresh_expires_at is not null and v_row.refresh_expires_at <= now())
        or (v_row.provider_key in ('facebook','instagram') and v_row.access_expires_at is not null and v_row.access_expires_at <= now())
        then 'needs_reauthorization'
      when v_row.status = 'pending_review' then 'pending_review'
      when v_row.status = 'degraded' then 'verification_failed'
      when v_row.status = 'connected' and v_row.last_verified_at is not null then 'connected'
      else 'verifying'
    end;

    v_kinds := case v_row.provider_key
      when 'instagram' then array['ig_feed','ig_carousel','ig_reel']
      when 'facebook' then array['fb_page_post','fb_page_photo','fb_page_video','fb_reel']
      when 'tiktok' then case when v_row.publishing_review_state = 'approved'
                              then array['tiktok_inbox_video','tiktok_video']
                              else array['tiktok_inbox_video'] end
      else array['gbp_local_post']
    end;

    v_reason := case
      when v_connection = 'not_connected' then 'not_connected'
      when v_connection = 'pending_review' then 'review_pending'
      when v_connection <> 'connected' then 'needs_reauthorization'
      when v_row.provider_key = 'google-business-profile' and v_row.publishing_permission_state = 'pending'
        then case
          when not v_row.selected_location then 'no_resource_selected'
          when v_row.publishing_review_state = 'pending' then 'review_pending'
          else 'review_required'
        end
      when v_row.publishing_permission_state <> 'granted' then 'publishing_permission_missing'
      when v_row.provider_key <> 'tiktok' and v_row.publishing_review_state in ('required','rejected') then 'review_required'
      when v_row.provider_key <> 'tiktok' and v_row.publishing_review_state = 'pending' then 'review_pending'
      when v_row.resource_id is null or not v_row.resource_credential_ok then 'no_resource_selected'
      else null
    end;

    v_resource := case when v_row.resource_id is null then null
      else jsonb_build_object('kind', v_row.resource_kind, 'id', v_row.resource_id, 'label', v_row.resource_label) end;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'provider_key', v_row.provider_key,
      'connection_state', v_connection,
      'publishing_permission_state', v_row.publishing_permission_state,
      'publishing_review_state', v_row.publishing_review_state,
      'resource', v_resource,
      'ready', v_reason is null,
      'reason', v_reason,
      'target_kinds', to_jsonb(v_kinds)
    ));
  end loop;
  return v_result;
end;
$function$;

-- The publishing worker's only way to the ciphertext. Refuses (granted:false
-- with a reason, no ciphertext, no event) unless the delivery is claimed with
-- this token right now, its content is approved or scheduled, the connection
-- is connected with publishing permission granted and the delivery's target
-- account is the selected resource. On success records credential_used.
create or replace function atlas_private.integration_read_credential_for_delivery(
  p_delivery_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_provider text;
  v_account text;
  v_content uuid;
  v_claim uuid;
  v_until timestamptz;
  v_delivery_status text;
  v_content_status text;
  v_status text;
  v_permission text;
  v_kind text;
  v_cred record;
  v_res record;
  v_rcred record;
  v_resource jsonb;
begin
  if p_delivery_id is null or p_claim_token is null then
    return jsonb_build_object('granted', false, 'reason', 'not_claimed');
  end if;
  if pg_catalog.to_regclass('atlas_private.marketing_deliveries') is null then
    return jsonb_build_object('granted', false, 'reason', 'publishing_not_installed');
  end if;

  select d.provider_key, d.external_account_id, d.content_id, d.claim_token, d.claimed_until, d.status
    into v_provider, v_account, v_content, v_claim, v_until, v_delivery_status
  from atlas_private.marketing_deliveries d
  where d.id = p_delivery_id;
  if v_provider is null then
    return jsonb_build_object('granted', false, 'reason', 'not_found');
  end if;
  if v_claim is distinct from p_claim_token or v_until is null or v_until <= now() then
    return jsonb_build_object('granted', false, 'reason', 'not_claimed');
  end if;
  if v_delivery_status in ('published','cancelled','failed','needs_attention') then
    return jsonb_build_object('granted', false, 'reason', 'delivery_closed');
  end if;

  select ci.status into v_content_status from atlas_private.marketing_content_items ci where ci.id = v_content;
  if v_content_status is null or v_content_status not in ('approved','scheduled') then
    return jsonb_build_object('granted', false, 'reason', 'not_approved');
  end if;

  select c.status, c.publishing_permission_state into v_status, v_permission
  from atlas_private.integration_connections c where c.provider_key = v_provider;
  select cr.credential_kind, cr.ciphertext, cr.nonce, cr.key_version, cr.access_expires_at, cr.refresh_expires_at
    into v_cred
  from atlas_private.integration_credentials cr where cr.provider_key = v_provider;
  if not found or v_status is distinct from 'connected' then
    return jsonb_build_object('granted', false, 'reason', case when v_status = 'expired' then 'needs_reauthorization' else 'not_connected' end);
  end if;
  if v_permission is distinct from 'granted' then
    return jsonb_build_object('granted', false, 'reason', 'publishing_permission_missing');
  end if;

  v_kind := atlas_private.integration_primary_resource_kind(v_provider);
  select r.resource_kind, r.resource_id, r.label into v_res
  from atlas_private.integration_resources r
  where r.provider_key = v_provider and r.resource_kind = v_kind and r.selected;
  if not found then
    return jsonb_build_object('granted', false, 'reason', 'no_resource_selected');
  end if;
  if v_account is distinct from v_res.resource_id then
    return jsonb_build_object('granted', false, 'reason', 'resource_changed');
  end if;

  if v_kind in ('facebook_page','instagram_account') then
    select rc.ciphertext, rc.nonce, rc.key_version into v_rcred
    from atlas_private.integration_resource_credentials rc
    where rc.provider_key = v_provider and rc.resource_kind = v_kind and rc.resource_id = v_res.resource_id;
    if not found then
      return jsonb_build_object('granted', false, 'reason', 'no_resource_selected');
    end if;
    v_resource := jsonb_build_object(
      'kind', v_res.resource_kind, 'id', v_res.resource_id, 'label', v_res.label,
      'credential', jsonb_build_object(
        'ciphertext', pg_catalog.encode(v_rcred.ciphertext, 'hex'),
        'nonce', pg_catalog.encode(v_rcred.nonce, 'hex'),
        'key_version', v_rcred.key_version
      )
    );
  else
    v_resource := jsonb_build_object('kind', v_res.resource_kind, 'id', v_res.resource_id, 'label', v_res.label, 'credential', null);
  end if;

  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (v_provider, 'credential_used', null, 'Atlas publisher',
          jsonb_build_object('delivery_id', p_delivery_id, 'resource_kind', v_kind));

  return jsonb_build_object(
    'granted', true,
    'provider_key', v_provider,
    'delivery_id', p_delivery_id,
    'credential', jsonb_build_object(
      'credential_kind', v_cred.credential_kind,
      'ciphertext', pg_catalog.encode(v_cred.ciphertext, 'hex'),
      'nonce', pg_catalog.encode(v_cred.nonce, 'hex'),
      'key_version', v_cred.key_version,
      'access_expires_at', v_cred.access_expires_at,
      'refresh_expires_at', v_cred.refresh_expires_at
    ),
    'resource', v_resource
  );
end;
$function$;

-- Refresh lock (Google, TikTok). Either a worker holding a live delivery
-- claim for this provider, or an active manager/admin (Settings "Test"),
-- takes a short lease. The current ciphertext is returned either way, so a
-- caller that did not get the lease can see whether another caller already
-- refreshed. Lease: 10-120 seconds (default 60).
create or replace function atlas_private.integration_refresh_lock(
  p_provider_key text,
  p_delivery_id uuid,
  p_claim_token uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 60), 10), 120);
  v_token uuid;
  v_row record;
begin
  perform atlas_private.integration_assert_provider(p_provider_key);
  if p_provider_key not in ('google-business-profile','google-drive','tiktok') then
    raise exception 'This provider does not refresh tokens' using errcode = '22023';
  end if;
  if p_actor_id is not null then
    perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  elsif not atlas_private.integration_delivery_claim_ok(p_delivery_id, p_claim_token, p_provider_key) then
    raise exception 'The delivery is not claimed' using errcode = '42501';
  end if;

  update atlas_private.integration_credentials cr
  set refresh_lock_token = gen_random_uuid(),
      refresh_locked_until = now() + make_interval(secs => v_lease),
      refresh_lock_actor_id = p_actor_id,
      refresh_lock_actor_label = left(coalesce(p_actor_label, case when p_actor_id is null then 'Atlas publisher' end), 200)
  where cr.provider_key = p_provider_key
    and (cr.refresh_locked_until is null or cr.refresh_locked_until <= now())
  returning cr.refresh_lock_token into v_token;

  select cr.credential_kind, cr.ciphertext, cr.nonce, cr.key_version, cr.access_expires_at, cr.refresh_expires_at, cr.refresh_locked_until
    into v_row
  from atlas_private.integration_credentials cr where cr.provider_key = p_provider_key;
  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'not_connected');
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'acquired', v_token is not null,
    'lock_token', v_token,
    'locked_until', v_row.refresh_locked_until,
    'credential', jsonb_build_object(
      'credential_kind', v_row.credential_kind,
      'ciphertext', pg_catalog.encode(v_row.ciphertext, 'hex'),
      'nonce', pg_catalog.encode(v_row.nonce, 'hex'),
      'key_version', v_row.key_version,
      'access_expires_at', v_row.access_expires_at,
      'refresh_expires_at', v_row.refresh_expires_at
    )
  ));
end;
$function$;

-- Stores the refreshed token set and releases the lease; only the lease
-- holder (same lock token, even if the lease ran out and nobody took it).
create or replace function atlas_private.integration_refresh_store(
  p_provider_key text,
  p_lock_token uuid,
  p_ciphertext text,
  p_nonce text,
  p_key_version smallint,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_label text;
begin
  perform atlas_private.integration_assert_provider(p_provider_key);
  if p_lock_token is null then
    raise exception 'The refresh lock is required' using errcode = '22023';
  end if;
  select cr.refresh_lock_actor_id, cr.refresh_lock_actor_label into v_actor, v_label
  from atlas_private.integration_credentials cr
  where cr.provider_key = p_provider_key and cr.refresh_lock_token = p_lock_token
  for update;
  if not found then
    return jsonb_build_object('stored', false, 'reason', 'lock_lost');
  end if;
  update atlas_private.integration_credentials cr
  set ciphertext = atlas_private.integration_hex(p_ciphertext, 'Ciphertext'),
      nonce = atlas_private.integration_hex(p_nonce, 'Nonce'),
      key_version = p_key_version,
      access_expires_at = p_access_expires_at,
      refresh_expires_at = coalesce(p_refresh_expires_at, cr.refresh_expires_at),
      rotated_at = now(),
      refresh_lock_token = null,
      refresh_locked_until = null,
      refresh_lock_actor_id = null,
      refresh_lock_actor_label = null
  where cr.provider_key = p_provider_key;
  update atlas_private.integration_connections c
  set token_expires_at = p_access_expires_at, updated_at = now()
  where c.provider_key = p_provider_key;
  insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
  values (p_provider_key, 'refreshed', v_actor, v_label, jsonb_build_object('key_version', p_key_version));
  return jsonb_build_object('stored', true);
end;
$function$;

-- Releases the lease. With p_error: records refresh_failed and marks the
-- connection expired (p_needs_reauthorization) or degraded.
create or replace function atlas_private.integration_refresh_release(
  p_provider_key text,
  p_lock_token uuid,
  p_error text,
  p_needs_reauthorization boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_label text;
  v_error text := left(regexp_replace(coalesce(p_error, ''), '[^[:print:]]', ' ', 'g'), 240);
begin
  perform atlas_private.integration_assert_provider(p_provider_key);
  update atlas_private.integration_credentials cr
  set refresh_lock_token = null, refresh_locked_until = null, refresh_lock_actor_id = null, refresh_lock_actor_label = null
  where cr.provider_key = p_provider_key and cr.refresh_lock_token = p_lock_token
  returning null::uuid into v_actor;
  if not found then
    return jsonb_build_object('released', false);
  end if;
  if nullif(v_error, '') is not null then
    update atlas_private.integration_connections c
    set status = case when coalesce(p_needs_reauthorization, false) then 'expired' else 'degraded' end,
        authorization_state = case when coalesce(p_needs_reauthorization, false) then 'expired' else 'waiting_authorization' end,
        last_connection_error = v_error,
        updated_at = now()
    where c.provider_key = p_provider_key;
    perform atlas_private.integration_derive_publishing(p_provider_key);
    insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
    values (p_provider_key, 'refresh_failed', null, 'Atlas publisher',
            jsonb_strip_nulls(jsonb_build_object('error', v_error, 'needs_reauthorization', p_needs_reauthorization)));
  end if;
  return jsonb_build_object('released', true);
end;
$function$;

-- ------------------------------------------------------------------ public service-role wrappers

create or replace function public.atlas_integration_set_state_purpose(
  p_provider_key text, p_state_hash text, p_purpose text, p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_set_state_purpose(p_provider_key, p_state_hash, p_purpose, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_resources_store(
  p_provider_key text, p_resources jsonb, p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_resources_store(p_provider_key, p_resources, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_resource_select(
  p_provider_key text, p_resource_kind text, p_resource_id text, p_ciphertext text, p_nonce text, p_key_version smallint,
  p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_resource_select(p_provider_key, p_resource_kind, p_resource_id, p_ciphertext, p_nonce,
  p_key_version, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_read_resource_credential(
  p_provider_key text, p_resource_kind text, p_resource_id text, p_actor_id uuid, p_actor_role text
)
returns jsonb language sql stable security definer set search_path = ''
as $$ select atlas_private.integration_read_resource_credential(p_provider_key, p_resource_kind, p_resource_id, p_actor_id, p_actor_role); $$;

create or replace function public.atlas_integration_set_review_state(
  p_provider_key text, p_review_state text, p_actor_id uuid, p_actor_label text, p_actor_role text
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_set_review_state(p_provider_key, p_review_state, p_actor_id, p_actor_label, p_actor_role); $$;

create or replace function public.atlas_integration_publish_targets()
returns jsonb language sql stable security definer set search_path = ''
as $$ select atlas_private.integration_publish_targets(); $$;

-- plpgsql (not sql): the body reaches atlas_private.marketing_deliveries
-- through the atlas_private function, which is only resolved at run time.
create or replace function public.atlas_integration_read_credential_for_delivery(p_delivery_id uuid, p_claim_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$ begin return atlas_private.integration_read_credential_for_delivery(p_delivery_id, p_claim_token); end; $$;

create or replace function public.atlas_integration_refresh_lock(
  p_provider_key text, p_delivery_id uuid, p_claim_token uuid, p_actor_id uuid, p_actor_label text, p_actor_role text, p_lease_seconds integer
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_refresh_lock(p_provider_key, p_delivery_id, p_claim_token, p_actor_id, p_actor_label, p_actor_role, p_lease_seconds); $$;

create or replace function public.atlas_integration_refresh_store(
  p_provider_key text, p_lock_token uuid, p_ciphertext text, p_nonce text, p_key_version smallint,
  p_access_expires_at timestamptz, p_refresh_expires_at timestamptz
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_refresh_store(p_provider_key, p_lock_token, p_ciphertext, p_nonce, p_key_version,
  p_access_expires_at, p_refresh_expires_at); $$;

create or replace function public.atlas_integration_refresh_release(
  p_provider_key text, p_lock_token uuid, p_error text, p_needs_reauthorization boolean
)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.integration_refresh_release(p_provider_key, p_lock_token, p_error, p_needs_reauthorization); $$;

-- ------------------------------------------------------------------ grants

do $s94b_grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'atlas_private.integration_publish_scopes(text)',
    'atlas_private.integration_primary_resource_kind(text)',
    'atlas_private.integration_assert_publishing_provider(text)',
    'atlas_private.integration_assert_admin(uuid, text)',
    'atlas_private.integration_derive_publishing(text)',
    'atlas_private.integration_resources_json(text)',
    'atlas_private.integration_delivery_claim_ok(uuid, uuid, text)',
    'atlas_private.integration_status(text, uuid)',
    'atlas_private.integration_bind_browser(text, text, text)',
    'atlas_private.integration_record_result(text, text, text, text, text[], timestamptz, boolean, text, uuid, text, text)',
    'atlas_private.integration_disconnect(text, uuid, text, text)',
    'atlas_private.integration_set_state_purpose(text, text, text, uuid, text, text)',
    'atlas_private.integration_resources_store(text, jsonb, uuid, text, text)',
    'atlas_private.integration_resource_select(text, text, text, text, text, smallint, uuid, text, text)',
    'atlas_private.integration_read_resource_credential(text, text, text, uuid, text)',
    'atlas_private.integration_set_review_state(text, text, uuid, text, text)',
    'atlas_private.integration_publish_targets()',
    'atlas_private.integration_read_credential_for_delivery(uuid, uuid)',
    'atlas_private.integration_refresh_lock(text, uuid, uuid, uuid, text, text, integer)',
    'atlas_private.integration_refresh_store(text, uuid, text, text, smallint, timestamptz, timestamptz)',
    'atlas_private.integration_refresh_release(text, uuid, text, boolean)',
    'public.atlas_integration_set_state_purpose(text, text, text, uuid, text, text)',
    'public.atlas_integration_resources_store(text, jsonb, uuid, text, text)',
    'public.atlas_integration_resource_select(text, text, text, text, text, smallint, uuid, text, text)',
    'public.atlas_integration_read_resource_credential(text, text, text, uuid, text)',
    'public.atlas_integration_set_review_state(text, text, uuid, text, text)',
    'public.atlas_integration_publish_targets()',
    'public.atlas_integration_read_credential_for_delivery(uuid, uuid)',
    'public.atlas_integration_refresh_lock(text, uuid, uuid, uuid, text, text, integer)',
    'public.atlas_integration_refresh_store(text, uuid, text, text, smallint, timestamptz, timestamptz)',
    'public.atlas_integration_refresh_release(text, uuid, text, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$s94b_grants$;

-- Existing verified connections get their publishing state now.
do $s94b_derive$
begin
  perform atlas_private.integration_derive_publishing(p.provider_key)
  from (values ('facebook'),('instagram'),('tiktok'),('google-business-profile')) p(provider_key);
end
$s94b_derive$;

comment on function public.atlas_integration_publish_targets() is
  'S94B service-role readiness per publishing provider: [{provider_key, connection_state, publishing_permission_state, publishing_review_state, resource, ready, reason, target_kinds}]. No credentials.';
comment on function public.atlas_integration_read_credential_for_delivery(uuid, uuid) is
  'S94B service-role only: ciphertext for a delivery claimed with this token right now (content approved/scheduled, publishing permission granted, target = selected resource). Records credential_used. Requires the S94C marketing_deliveries table at run time.';

notify pgrst, 'reload schema';
