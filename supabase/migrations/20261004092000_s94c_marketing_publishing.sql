-- S94C Marketing publishing: content workflow and delivery queue.
--
-- Binding documents: docs/marketing/S94_Publishing_Architecture.md (§0, §2, §5, §6, §8, §9, §10)
-- and docs/marketing/research/07-scheduler-design.md (delivery table, attempt ledger, provider
-- accounts, transition table, claim/lease/fencing, begin_submit marker, backoff, stale guard,
-- approval fingerprint gate, content-level status, notifications).
--
-- Depends on 20261004090000_s94a_marketing_media.sql (marketing_media_assets, marketing_media_variants,
-- marketing_content_media) and 20261004091000_s94b_publishing_connections.sql
-- (integration_resources, public.atlas_integration_publish_targets()).
--
-- Rules kept here:
-- * Nothing is published unless a manager or admin approved that exact content (fingerprint). An edit
--   after approval cancels the unstarted deliveries and needs approval again.
-- * Automatic publishing stays off until an admin turns it on (Settings > Marketing).
-- * One delivery per platform target; a published delivery is final; provider ids are write-once.
-- * No token, secret or signed URL is stored in any row written here (check constraints).
-- * The replay has no pg_cron/pg_net: the tick function skips quietly when they are missing.
--
-- Idempotent: every statement can run twice.

set lock_timeout = '5s';
set statement_timeout = '5min';

-- ---------------------------------------------------------------------------------------------
-- 1. Content model
-- ---------------------------------------------------------------------------------------------

alter table atlas_private.marketing_content_items
  add column if not exists version integer not null default 1,
  add column if not exists platform_options jsonb not null default '{}'::jsonb,
  add column if not exists approved_fingerprint bytea,
  add column if not exists approval_id uuid;

alter table atlas_private.marketing_content_items
  drop constraint if exists marketing_content_items_version_check,
  drop constraint if exists marketing_content_items_platform_options_check,
  drop constraint if exists marketing_content_items_approved_fingerprint_check,
  drop constraint if exists marketing_content_items_platforms_check,
  drop constraint if exists marketing_content_items_approval_id_fkey;
alter table atlas_private.marketing_content_items
  add constraint marketing_content_items_version_check check (version >= 1),
  add constraint marketing_content_items_platform_options_check check (
    jsonb_typeof(platform_options) = 'object'
    and pg_catalog.octet_length(platform_options::text) <= 65536
    and platform_options::text !~* '"(access_token|refresh_token|client_secret|token|secret|authorization|signature)"\s*:'
  ),
  add constraint marketing_content_items_approved_fingerprint_check check (
    approved_fingerprint is null or pg_catalog.octet_length(approved_fingerprint) = 32
  ),
  add constraint marketing_content_items_platforms_check check (
    platforms <@ array['instagram','facebook','tiktok','google-business-profile']::text[]
  ),
  add constraint marketing_content_items_approval_id_fkey foreign key (approval_id)
    references atlas_private.marketing_content_approvals(id) on delete set null;
create index if not exists marketing_content_items_approval_idx
  on atlas_private.marketing_content_items (approval_id) where approval_id is not null;

alter table atlas_private.marketing_content_approvals
  add column if not exists approved_fingerprint bytea,
  add column if not exists approved_scheduled_for timestamptz;
alter table atlas_private.marketing_content_approvals
  drop constraint if exists marketing_content_approvals_fingerprint_check;
alter table atlas_private.marketing_content_approvals
  add constraint marketing_content_approvals_fingerprint_check check (
    (decision = 'approved' or approved_fingerprint is null)
    and (approved_fingerprint is null or pg_catalog.octet_length(approved_fingerprint) = 32)
  );

alter table atlas_private.marketing_workspace_events
  drop constraint if exists marketing_workspace_events_event_type_check;
alter table atlas_private.marketing_workspace_events
  add constraint marketing_workspace_events_event_type_check check (event_type in (
    'campaign_created','content_created','content_updated','approval_submitted','approval_decided',
    'content_published','content_completed','content_cancelled','recommendation_converted',
    'recommendation_dismissed','connection_state_changed',
    'approval_invalidated','content_rescheduled','content_duplicated','deliveries_created','publish_now',
    'delivery_published','delivery_needs_attention','delivery_failed','delivery_requeued',
    'delivery_marked_posted','delivery_cancelled'
  ));

-- ---------------------------------------------------------------------------------------------
-- 2. Deliveries, attempts, provider accounts, transitions (report 07 §2)
-- ---------------------------------------------------------------------------------------------

create table if not exists atlas_private.marketing_deliveries (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete restrict,
  provider_key text not null references atlas_private.integration_connections(provider_key),
  external_account_id text not null,
  target_kind text not null,
  approval_id uuid not null references atlas_private.marketing_content_approvals(id),
  approved_fingerprint bytea not null,
  payload_snapshot jsonb not null,
  status text not null default 'queued',
  due_at timestamptz not null,
  next_attempt_at timestamptz not null,
  latest_acceptable_at timestamptz not null,
  priority smallint not null default 100,
  claim_token uuid,
  claimed_by text,
  claimed_until timestamptz,
  attempt_count integer not null default 0,
  max_attempts integer not null default 6,
  poll_count integer not null default 0,
  phase text not null default 'none',
  provider_container_id text,
  provider_publish_id text,
  provider_post_id text,
  provider_permalink text,
  progress jsonb not null default '{}'::jsonb,
  submit_started_at timestamptz,
  verify_attempts integer not null default 0,
  published_at timestamptz,
  published_source text,
  last_error_class text,
  last_error_code text,
  last_error_message text,
  attention_reason text,
  attention_notified_at timestamptz,
  cancel_requested_at timestamptz,
  cancelled_at timestamptz,
  cancelled_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  row_version integer not null default 1,
  constraint marketing_deliveries_provider_check check (provider_key in ('instagram','facebook','tiktok','google-business-profile')),
  constraint marketing_deliveries_account_check check (pg_catalog.char_length(external_account_id) between 1 and 200),
  constraint marketing_deliveries_target_kind_check check (target_kind in (
    'ig_feed','ig_carousel','ig_reel','ig_story','fb_page_post','fb_page_photo','fb_page_video','fb_reel',
    'tiktok_video','tiktok_inbox_video','tiktok_photo','gbp_local_post')),
  constraint marketing_deliveries_fingerprint_check check (pg_catalog.octet_length(approved_fingerprint) = 32),
  constraint marketing_deliveries_snapshot_check check (
    jsonb_typeof(payload_snapshot) = 'object'
    and payload_snapshot::text !~* '"(access_token|refresh_token|client_secret|token|secret|authorization|signature|signed_url|url_token)"\s*:'
    and payload_snapshot::text !~* '(X-Amz-Signature|/object/sign/|[?&]token=)'),
  constraint marketing_deliveries_status_check check (status in (
    'queued','publishing','processing','verifying','retrying','published','failed','needs_attention','cancelled')),
  constraint marketing_deliveries_priority_check check (priority between 1 and 1000),
  constraint marketing_deliveries_claimed_by_check check (claimed_by is null or pg_catalog.char_length(claimed_by) between 1 and 120),
  constraint marketing_deliveries_attempts_check check (attempt_count >= 0 and poll_count >= 0 and verify_attempts >= 0),
  constraint marketing_deliveries_max_attempts_check check (max_attempts between 1 and 20),
  constraint marketing_deliveries_phase_check check (phase in (
    'none','media_ready','container_created','container_ready','submitting','submitted','remote_processing')),
  constraint marketing_deliveries_ids_check check (
    (provider_container_id is null or provider_container_id ~ '^[A-Za-z0-9_:./~=+-]{1,200}$')
    and (provider_publish_id is null or provider_publish_id ~ '^[A-Za-z0-9_:./~=+-]{1,200}$')
    and (provider_post_id is null or provider_post_id ~ '^[A-Za-z0-9_:./~=+-]{1,200}$')),
  constraint marketing_deliveries_permalink_check check (
    provider_permalink is null or (provider_permalink ~ '^https://[^[:space:]]+$' and pg_catalog.char_length(provider_permalink) between 12 and 2000
      and provider_permalink !~* '(access_token|[?&]token=|signature|X-Amz-)')),
  constraint marketing_deliveries_progress_check check (
    jsonb_typeof(progress) = 'object' and pg_catalog.octet_length(progress::text) <= 16384
    and progress::text !~* '"(access_token|refresh_token|client_secret|token|secret|authorization|signature|url)"\s*:'
    and progress::text !~* 'https?://'),
  constraint marketing_deliveries_published_source_check check (published_source is null or published_source in ('provider','verification','manual')),
  constraint marketing_deliveries_error_class_check check (last_error_class is null or last_error_class in (
    'transient','rate_limited','auth','permanent','uncertain','stale','policy')),
  constraint marketing_deliveries_error_code_check check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  constraint marketing_deliveries_error_message_check check (last_error_message is null or (
    pg_catalog.char_length(last_error_message) <= 500
    and last_error_message !~* '(access_token|refresh_token|client_secret|bearer [a-z0-9]|[?&]token=|signature=|https?://)')),
  constraint marketing_deliveries_attention_check check (attention_reason is null or attention_reason in (
    'outcome_unknown','auth_expired','rate_limit_exhausted','max_attempts','stale_schedule','provider_rejected',
    'media_invalid','manual_hold','no_resource','provider_not_ready')),
  constraint marketing_deliveries_cancelled_reason_check check (cancelled_reason is null or cancelled_reason in (
    'user','superseded_by_edit','content_cancelled','provider_disconnected')),
  constraint deliveries_published_has_id check (status <> 'published' or provider_post_id is not null or coalesce(published_source, '') = 'manual'),
  constraint deliveries_published_has_time check (status <> 'published' or published_at is not null),
  constraint deliveries_claim_complete check ((claim_token is null) = (claimed_until is null) and (claim_token is null) = (claimed_by is null)),
  constraint deliveries_publishing_claimed check (status <> 'publishing' or claim_token is not null),
  constraint deliveries_submit_marker check (phase not in ('submitting','submitted') or submit_started_at is not null),
  constraint deliveries_cancelled_has_reason check (status <> 'cancelled' or (cancelled_reason is not null and cancelled_at is not null)),
  constraint deliveries_stale_after_due check (latest_acceptable_at >= due_at)
);

create unique index if not exists marketing_deliveries_live_target_uidx
  on atlas_private.marketing_deliveries (content_id, provider_key, external_account_id, target_kind)
  where status <> 'cancelled';
create unique index if not exists marketing_deliveries_post_uidx
  on atlas_private.marketing_deliveries (provider_key, provider_post_id) where provider_post_id is not null;
create unique index if not exists marketing_deliveries_container_uidx
  on atlas_private.marketing_deliveries (provider_key, provider_container_id) where provider_container_id is not null;
create unique index if not exists marketing_deliveries_publish_uidx
  on atlas_private.marketing_deliveries (provider_key, provider_publish_id) where provider_publish_id is not null;
create unique index if not exists marketing_deliveries_claim_token_uidx
  on atlas_private.marketing_deliveries (claim_token) where claim_token is not null;
create index if not exists marketing_deliveries_due_idx
  on atlas_private.marketing_deliveries (next_attempt_at, priority, id)
  where status in ('queued','retrying','processing','verifying','publishing');
create index if not exists marketing_deliveries_account_published_idx
  on atlas_private.marketing_deliveries (provider_key, external_account_id, published_at desc)
  where published_at is not null;
create index if not exists marketing_deliveries_account_status_idx
  on atlas_private.marketing_deliveries (provider_key, external_account_id, status);
create index if not exists marketing_deliveries_approval_idx
  on atlas_private.marketing_deliveries (approval_id);
create index if not exists marketing_deliveries_attention_idx
  on atlas_private.marketing_deliveries (updated_at desc) where status in ('needs_attention','failed','verifying');

create table if not exists atlas_private.marketing_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references atlas_private.marketing_deliveries(id) on delete cascade,
  attempt_no integer not null check (attempt_no >= 1),
  claim_token uuid not null unique,
  claimed_by text not null check (pg_catalog.char_length(claimed_by) between 1 and 120),
  claim_kind text not null check (claim_kind in ('publish','poll','verify','recover')),
  started_at timestamptz not null default pg_catalog.now(),
  finished_at timestamptz,
  steps jsonb not null default '[]'::jsonb,
  outcome text check (outcome in ('published','processing','retrying','verifying','failed','needs_attention','lease_lost','cancelled')),
  unique (delivery_id, attempt_no),
  constraint attempts_steps_array check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 200),
  constraint attempts_steps_no_secrets check (
    steps::text !~* '"(access_token|refresh_token|client_secret|token|secret|authorization|signature|url|upload_url)"\s*:'
    and steps::text !~* '(access_token|refresh_token|client_secret|bearer [a-z0-9]|[?&]token=|signature=|X-Amz-|https?://)')
);

create table if not exists atlas_private.marketing_provider_accounts (
  provider_key text not null references atlas_private.integration_connections(provider_key),
  external_account_id text not null check (pg_catalog.char_length(external_account_id) between 1 and 200),
  cooldown_until timestamptz,
  daily_publish_cap integer check (daily_publish_cap is null or daily_publish_cap between 1 and 1000),
  atlas_daily_cap integer not null default 25 check (atlas_daily_cap between 1 and 1000),
  last_quota_check_at timestamptz,
  last_quota_usage integer check (last_quota_usage is null or last_quota_usage >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (provider_key, external_account_id)
);

create table if not exists atlas_private.marketing_delivery_transitions (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);
-- Report 07 §2.3 table. Three rows are added from the same report's own rules: queued→needs_attention
-- (§3.2 "if now() > latest_acceptable_at on a queued or retrying row, the claim moves it to
-- needs_attention"; also no resource / provider not ready / budget past the window), and
-- publishing→cancelled, processing→cancelled (§2.3 "before submitting it goes to cancelled", §5.1
-- policy class "cancelled"). The guard trigger allows the two cancel rows only while no
-- non-idempotent call was started (phase not submitting/submitted), so a post that may exist can
-- never be "cancelled".
insert into atlas_private.marketing_delivery_transitions (from_status, to_status) values
  ('queued','publishing'),('queued','cancelled'),('queued','needs_attention'),
  ('retrying','publishing'),('retrying','cancelled'),('retrying','needs_attention'),
  ('publishing','published'),('publishing','processing'),('publishing','retrying'),('publishing','verifying'),
  ('publishing','failed'),('publishing','needs_attention'),('publishing','cancelled'),
  ('processing','published'),('processing','failed'),('processing','needs_attention'),('processing','verifying'),
  ('processing','publishing'),('processing','cancelled'),
  ('verifying','published'),('verifying','retrying'),('verifying','needs_attention'),
  ('failed','queued'),('failed','cancelled'),
  ('needs_attention','queued'),('needs_attention','published'),('needs_attention','cancelled')
on conflict do nothing;

alter table atlas_private.marketing_deliveries enable row level security;
alter table atlas_private.marketing_delivery_attempts enable row level security;
alter table atlas_private.marketing_provider_accounts enable row level security;
alter table atlas_private.marketing_delivery_transitions enable row level security;
revoke all on atlas_private.marketing_deliveries from public, anon, authenticated;
revoke all on atlas_private.marketing_delivery_attempts from public, anon, authenticated;
revoke all on atlas_private.marketing_provider_accounts from public, anon, authenticated;
revoke all on atlas_private.marketing_delivery_transitions from public, anon, authenticated;
-- Writes go only through the definer RPCs below: the service role can read, never write directly.
revoke all on atlas_private.marketing_deliveries from service_role;
revoke all on atlas_private.marketing_delivery_attempts from service_role;
revoke all on atlas_private.marketing_provider_accounts from service_role;
revoke all on atlas_private.marketing_delivery_transitions from service_role;
grant select on atlas_private.marketing_deliveries to service_role;
grant select on atlas_private.marketing_delivery_attempts to service_role;
grant select on atlas_private.marketing_provider_accounts to service_role;
grant select on atlas_private.marketing_delivery_transitions to service_role;
drop policy if exists "service role reads marketing deliveries" on atlas_private.marketing_deliveries;
create policy "service role reads marketing deliveries" on atlas_private.marketing_deliveries
  for select to service_role using (true);
drop policy if exists "service role reads marketing delivery attempts" on atlas_private.marketing_delivery_attempts;
create policy "service role reads marketing delivery attempts" on atlas_private.marketing_delivery_attempts
  for select to service_role using (true);
drop policy if exists "service role reads marketing provider accounts" on atlas_private.marketing_provider_accounts;
create policy "service role reads marketing provider accounts" on atlas_private.marketing_provider_accounts
  for select to service_role using (true);
drop policy if exists "service role reads marketing delivery transitions" on atlas_private.marketing_delivery_transitions;
create policy "service role reads marketing delivery transitions" on atlas_private.marketing_delivery_transitions
  for select to service_role using (true);

create or replace function atlas_private.marketing_delivery_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then
      raise exception 'A delivery starts queued' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if not exists (
      select 1 from atlas_private.marketing_delivery_transitions t
      where t.from_status = old.status and t.to_status = new.status
    ) then
      raise exception 'illegal delivery transition %→%', old.status, new.status using errcode = 'P0001';
    end if;
    if old.status = 'publishing' and new.status = 'retrying' and old.phase in ('submitting','submitted') then
      raise exception 'unsafe retry after submit; verify first' using errcode = 'P0001';
    end if;
    if old.status in ('publishing','processing') and new.status = 'cancelled' and old.phase in ('submitting','submitted') then
      raise exception 'a delivery that may already be posted cannot be cancelled' using errcode = 'P0001';
    end if;
  end if;
  -- Provider ids are write-once: once learned they can never be changed or cleared.
  if (old.provider_post_id is not null and new.provider_post_id is distinct from old.provider_post_id)
     or (old.provider_publish_id is not null and new.provider_publish_id is distinct from old.provider_publish_id) then
    raise exception 'provider ids are write-once' using errcode = 'P0001';
  end if;
  -- An Instagram container may be replaced only when it was proven expired before any submit:
  -- the id is cleared together with a phase reset to 'none' from a pre-submit phase.
  if old.provider_container_id is not null and new.provider_container_id is distinct from old.provider_container_id then
    if not (new.provider_container_id is null and new.phase = 'none'
            and old.phase in ('media_ready','container_created','container_ready')) then
      raise exception 'provider ids are write-once' using errcode = 'P0001';
    end if;
  end if;
  if old.status in ('published','cancelled') and (
       new.payload_snapshot is distinct from old.payload_snapshot
       or new.approved_fingerprint is distinct from old.approved_fingerprint
       or new.published_at is distinct from old.published_at
       or new.provider_permalink is distinct from old.provider_permalink) then
    raise exception 'A final delivery cannot change' using errcode = 'P0001';
  end if;
  if new.payload_snapshot is distinct from old.payload_snapshot
     or new.approved_fingerprint is distinct from old.approved_fingerprint
     or new.approval_id is distinct from old.approval_id
     or new.content_id is distinct from old.content_id
     or new.provider_key is distinct from old.provider_key
     or new.target_kind is distinct from old.target_kind then
    raise exception 'The approved delivery payload is frozen' using errcode = 'P0001';
  end if;
  new.updated_at := pg_catalog.now();
  new.row_version := old.row_version + 1;
  return new;
end;
$$;

drop trigger if exists marketing_delivery_guard on atlas_private.marketing_deliveries;
create trigger marketing_delivery_guard
  before insert or update on atlas_private.marketing_deliveries
  for each row execute function atlas_private.marketing_delivery_guard();

drop trigger if exists marketing_provider_accounts_touch on atlas_private.marketing_provider_accounts;
create trigger marketing_provider_accounts_touch
  before update on atlas_private.marketing_provider_accounts
  for each row execute function atlas_private.touch_updated_at();

create or replace function atlas_private.marketing_attempts_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Delivery attempts are append-only' using errcode = 'P0001';
  end if;
  if new.delivery_id <> old.delivery_id or new.attempt_no <> old.attempt_no or new.claim_token <> old.claim_token
     or new.claim_kind <> old.claim_kind or new.started_at <> old.started_at
     or (old.finished_at is not null and (new.outcome is distinct from old.outcome or new.steps is distinct from old.steps)) then
    raise exception 'Delivery attempts are append-only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists marketing_attempts_append_only on atlas_private.marketing_delivery_attempts;
create trigger marketing_attempts_append_only
  before update or delete on atlas_private.marketing_delivery_attempts
  for each row execute function atlas_private.marketing_attempts_append_only();

-- ---------------------------------------------------------------------------------------------
-- 3. Helpers: actor, settings, venue time, sanitising, targets, readiness
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_actor(p_actor_id uuid, p_allowed text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_label text;
begin
  select profile.role::text, coalesce(nullif(pg_catalog.btrim(profile.display_name), ''), nullif(profile.email, ''), 'Atlas user')
  into v_role, v_label
  from public.profiles profile
  where profile.id = p_actor_id and profile.active is true;
  if p_actor_id is null or v_role is null or not (v_role = any(p_allowed)) then
    raise exception 'This Marketing action is not available for your Atlas role'
      using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return jsonb_build_object('id', p_actor_id, 'role', v_role, 'label', left(v_label, 120));
end;
$$;

create or replace function atlas_private.marketing_automatic_publishing_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select section.settings_value -> 'automatic_publishing_enabled' = 'true'::jsonb
    from atlas_private.settings_sections section
    where section.section_key = 'marketing'
  ), false);
$$;

-- Removes URLs, bearer strings and token-looking parameters from provider text before it is stored.
-- A secret-looking key is redacted together with its value (quoted, unquoted or empty), so
-- `signature="x"` or `?token=""` can never leave `signature=` / `?token=` behind. The last step is a
-- guarantee: whatever still matches the deliveries/attempts CHECK patterns becomes '[redacted]', so a
-- sanitised text can never make an insert or update fail with 23514.
create or replace function atlas_private.marketing_sanitize_text(p_text text, p_max integer default 240)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case when cleaned ~* '(access_token|refresh_token|client_secret|bearer [a-z0-9]|[?&]token=|signature=|X-Amz-|https?://)'
              then '[redacted]' else cleaned end
  from (
    select nullif(left(pg_catalog.btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]+', ' ', 'g'),
              'https?://[^[:space:]"'']*', '[link]', 'gi'),
            '[?&]?[A-Za-z_]*(access_token|refresh_token|client_secret|token|secret|signature|authorization|password)[A-Za-z_]*[[:space:]]*[=:][[:space:]]*("[^"]*"?|''[^'']*''?|[^[:space:],;&"'']*)',
            '[redacted]', 'gi'),
          '(access_token|refresh_token|client_secret|X-Amz-[A-Za-z-]*)', '[redacted]', 'gi'),
        '(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/=-]+', '[redacted]', 'gi')), greatest(1, least(coalesce(p_max, 240), 500))), '') as cleaned
  ) sanitized;
$$;

-- Fixed, browser-facing wording for a delivery error (last_error_message). Provider text never
-- reaches the browser: it stays, sanitised, in the attempt ledger (manager history only).
create or replace function atlas_private.marketing_error_wording(p_class text, p_attention text, p_code text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_code in ('ig_image_not_jpeg','ig_image_format') then 'Instagram takes JPEG photos only. Use the JPEG copy of the photo and approve again.'
    when p_code = 'stale_schedule' or p_class = 'stale' or p_attention = 'stale_schedule' then 'The planned time passed before the post could be sent.'
    when p_code = 'processing_timeout' then 'The platform did not finish processing in time.'
    when p_attention = 'max_attempts' then 'Atlas stopped retrying after the maximum number of attempts.'
    when p_class = 'auth' or p_attention = 'auth_expired' then 'The connection needs reconnecting in Settings › Integrations before Atlas can post.'
    when p_attention = 'no_resource' then 'Choose which account Atlas posts to in Settings › Integrations, then approve the post again.'
    when p_attention = 'provider_not_ready' then 'The connection is not ready to publish this post. Check Settings › Integrations.'
    when p_attention = 'manual_hold' then 'This post is on hold. Check it before publishing again.'
    when p_attention = 'media_invalid' then 'The platform could not use a photo or video in this post. Check the media and approve again.'
    when p_attention = 'rate_limit_exhausted' or p_class = 'rate_limited' then 'The platform asked Atlas to slow down. Atlas will try again later.'
    when p_attention = 'outcome_unknown' then 'Atlas could not confirm whether the platform published this post. Check the platform.'
    when p_class = 'uncertain' then 'Atlas is checking whether the platform published this post.'
    when p_class in ('permanent','policy') or p_attention = 'provider_rejected' then 'The platform refused this post.'
    when p_class = 'transient' then 'The platform could not be reached. Atlas will try again.'
    else 'Atlas could not publish this post.' end;
$$;

-- A worker step: only allow-listed keys, sanitised short strings, a server timestamp.
create or replace function atlas_private.marketing_sanitize_step(p_step jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := jsonb_build_object('at', pg_catalog.clock_timestamp());
  v_key text;
  v_value jsonb;
begin
  if p_step is null or jsonb_typeof(p_step) <> 'object' then
    return v_out;
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_step) loop
    if v_key not in ('step','http_status','provider_request_id','outcome','code','message','poll_status','detail','attempt') then
      continue;
    end if;
    if jsonb_typeof(v_value) = 'number' and v_key in ('http_status','attempt') then
      v_out := v_out || jsonb_build_object(v_key, least(greatest((v_value #>> '{}')::numeric, 0), 99999));
    elsif jsonb_typeof(v_value) in ('string','number','boolean') then
      v_out := v_out || jsonb_build_object(v_key, atlas_private.marketing_sanitize_text(v_value #>> '{}', 240));
    end if;
  end loop;
  return jsonb_strip_nulls(v_out);
end;
$$;

create or replace function atlas_private.marketing_publish_targets()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_targets jsonb;
begin
  if to_regprocedure('public.atlas_integration_publish_targets()') is null then
    return '[]'::jsonb;
  end if;
  execute 'select public.atlas_integration_publish_targets()' into v_targets;
  if v_targets is null or jsonb_typeof(v_targets) <> 'array' then
    return '[]'::jsonb;
  end if;
  return v_targets;
end;
$$;

create or replace function atlas_private.marketing_target_for(p_targets jsonb, p_provider text)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select target from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) target
  where target ->> 'provider_key' = p_provider
  limit 1;
$$;

create or replace function atlas_private.marketing_target_resource_id(p_targets jsonb, p_provider text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(nullif(atlas_private.marketing_target_for(p_targets, p_provider) #>> '{resource,id}', ''), 'pending');
$$;

-- "As soon as it's approved": metadata.publish_asap on content without a time. A time wins.
create or replace function atlas_private.marketing_content_publish_asap(p_scheduled_for timestamptz, p_metadata jsonb)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_scheduled_for is null and coalesce(p_metadata -> 'publish_asap' = 'true'::jsonb, false);
$$;

-- Ordered media for one content item. p_platform null lists every attachment (fingerprint and
-- snapshot); a platform returns its effective list (its own override rows, else the common rows).
-- variant_id is the attachment's own choice (round-tripped by the composer); publish_variant_id is
-- what is actually published: that choice, else the ready JPEG publish copy of a non-JPEG photo,
-- else null (the original). storage_path, mime_type, size and sha256 describe the published file,
-- so the frozen payload and the approval fingerprint cannot bypass the JPEG copy.
create or replace function atlas_private.marketing_content_media_list(p_content_id uuid, p_platform text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_has_override boolean := false;
begin
  if p_platform is not null then
    select exists (
      select 1 from atlas_private.marketing_content_media cm
      where cm.content_id = p_content_id and cm.platform = p_platform
    ) into v_has_override;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'attachment_id', cm.id,
      'asset_id', cm.asset_id,
      'variant_id', cm.variant_id,
      'publish_variant_id', variant.id,
      'collection_id', cm.collection_id,
      'platform', cm.platform,
      'position', cm.position,
      'role', cm.role,
      'kind', asset.kind,
      'storage_path', coalesce(variant.storage_path, asset.storage_path),
      'mime_type', coalesce(variant.mime_type, asset.mime_type, asset.declared_mime),
      'width', coalesce(variant.width, asset.width),
      'height', coalesce(variant.height, asset.height),
      'duration_ms', asset.duration_ms,
      'byte_size', coalesce(variant.byte_size::bigint, asset.byte_size),
      'sha256', coalesce(variant.sha256, asset.sha256),
      'asset_sha256', asset.sha256,
      'alt_text', coalesce(cm.alt_text, asset.alt_text),
      'thumb_storage_path', (
        select thumb.storage_path from atlas_private.marketing_media_variants thumb
        where thumb.asset_id = cm.asset_id and thumb.purpose in ('thumb','poster')
          and thumb.status = 'ready' and thumb.deleted_at is null
        order by case thumb.purpose when 'thumb' then 0 else 1 end, thumb.created_at desc
        limit 1)
    ) order by cm.platform nulls first, cm.position, cm.id), '[]'::jsonb)
  into v_result
  from atlas_private.marketing_content_media cm
  join atlas_private.marketing_media_assets asset on asset.id = cm.asset_id
  left join atlas_private.marketing_media_variants variant
    on variant.id = coalesce(cm.variant_id, atlas_private.marketing_media_publish_copy(cm.asset_id))
  where cm.content_id = p_content_id
    and (p_platform is null
         or (v_has_override and cm.platform = p_platform)
         or (not v_has_override and cm.platform is null));
  return v_result;
end;
$$;

-- Default placement from the attached media (rules.mjs is the authority in the composer; this is
-- the server-side fallback when platform_options.<platform>.target_kind is absent).
create or replace function atlas_private.marketing_target_kind(p_platform text, p_options jsonb, p_media jsonb)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_chosen text := nullif(p_options #>> array[p_platform, 'target_kind'], '');
  v_count integer := jsonb_array_length(coalesce(p_media, '[]'::jsonb));
  v_videos integer;
begin
  select count(*) into v_videos from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) item
  where item ->> 'kind' = 'video';
  if v_chosen is not null then
    if (p_platform = 'instagram' and v_chosen in ('ig_feed','ig_carousel','ig_reel'))
       or (p_platform = 'facebook' and v_chosen in ('fb_page_post','fb_page_photo','fb_page_video','fb_reel'))
       or (p_platform = 'tiktok' and v_chosen in ('tiktok_video','tiktok_inbox_video'))
       or (p_platform = 'google-business-profile' and v_chosen = 'gbp_local_post') then
      return v_chosen;
    end if;
    raise exception 'Unsupported placement % for %', v_chosen, p_platform using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  return case p_platform
    when 'instagram' then case when v_count >= 2 then 'ig_carousel' when v_videos = 1 then 'ig_reel' else 'ig_feed' end
    when 'facebook' then case when v_count = 0 then 'fb_page_post' when v_videos >= 1 then 'fb_page_video' else 'fb_page_photo' end
    when 'tiktok' then 'tiktok_inbox_video'
    when 'google-business-profile' then 'gbp_local_post'
  end;
end;
$$;

create or replace function atlas_private.marketing_effective_caption(p_caption text, p_options jsonb, p_platform text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select replace(replace(coalesce(nullif(p_options #>> array[p_platform, 'caption'], ''), p_caption, ''), E'\r\n', E'\n'), E'\r', E'\n');
$$;

create or replace function atlas_private.marketing_validate_platform_options(p_options jsonb, p_platforms text[])
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_url text;
begin
  if p_options is null then return '{}'::jsonb; end if;
  if jsonb_typeof(p_options) <> 'object' then
    raise exception 'Platform options must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_options) loop
    if v_key not in ('instagram','facebook','tiktok','google-business-profile') then
      raise exception 'Unknown platform in options: %', left(v_key, 40) using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if jsonb_typeof(v_value) <> 'object' then
      raise exception 'Options for % must be an object', v_key using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if v_value ? 'caption' and jsonb_typeof(v_value -> 'caption') not in ('string','null') then
      raise exception 'Caption override must be text' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if pg_catalog.char_length(coalesce(v_value ->> 'caption', '')) > 10000 then
      raise exception 'Caption override is too long' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if v_key = 'tiktok' and v_value ? 'tiktok' then
      if coalesce(v_value #>> '{tiktok,privacy_level}', 'SELF_ONLY') not in
         ('PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY') then
        raise exception 'TikTok privacy level is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
    end if;
    if v_key = 'google-business-profile' and v_value ? 'gbp' then
      -- ALERT (COVID-era) posts are not published by the worker, so they are refused here too.
      if coalesce(v_value #>> '{gbp,topic_type}', 'STANDARD') not in ('STANDARD','EVENT','OFFER') then
        raise exception 'Google post type is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
      v_url := v_value #>> '{gbp,call_to_action,url}';
      if v_url is not null and (v_url !~ '^https://[^[:space:]]+$' or pg_catalog.char_length(v_url) > 2000) then
        raise exception 'Call-to-action link must start with https://' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
    end if;
    perform atlas_private.marketing_target_kind(v_key, p_options, '[]'::jsonb);
  end loop;
  return p_options;
end;
$$;

-- §5.3: sha256 over canonical JSON (explicit jsonb_build_object, never to_jsonb(row)).
create or replace function atlas_private.marketing_content_fingerprint_payload(p_content_id uuid, p_targets jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c atlas_private.marketing_content_items;
  v_targets jsonb := coalesce(p_targets, atlas_private.marketing_publish_targets());
  v_target_list jsonb := '[]'::jsonb;
  v_platform text;
  v_media jsonb;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id;
  if not found then return null; end if;
  foreach v_platform in array (select coalesce(array_agg(p order by p), '{}'::text[]) from unnest(c.platforms) p) loop
    v_media := atlas_private.marketing_content_media_list(c.id, v_platform);
    v_target_list := v_target_list || jsonb_build_array(jsonb_build_object(
      'platform', v_platform,
      'target_kind', atlas_private.marketing_target_kind(v_platform, c.platform_options, v_media),
      'resource_id', atlas_private.marketing_target_resource_id(v_targets, v_platform),
      'caption', atlas_private.marketing_effective_caption(c.caption_draft, c.platform_options, v_platform)
    ));
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object(
      'asset_id', item ->> 'asset_id', 'variant_id', item ->> 'publish_variant_id', 'platform', item ->> 'platform',
      'position', item -> 'position', 'role', item ->> 'role', 'sha256', item ->> 'sha256'
    ) order by ordinality), '[]'::jsonb)
  into v_media
  from jsonb_array_elements(atlas_private.marketing_content_media_list(c.id, null)) with ordinality as m(item, ordinality);
  return jsonb_build_object(
    'v', 1,
    'content_type', c.content_type,
    'scheduled_for', case when c.scheduled_for is null then null
      else to_char(c.scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'publish_asap', atlas_private.marketing_content_publish_asap(c.scheduled_for, c.metadata),
    'targets', v_target_list,
    'media', v_media,
    'platform_options', c.platform_options
  );
end;
$$;

create or replace function atlas_private.marketing_content_fingerprint(p_content_id uuid, p_targets jsonb default null)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.sha256(convert_to(atlas_private.marketing_content_fingerprint_payload(p_content_id, p_targets)::text, 'UTF8'));
$$;

-- Frozen payload for one delivery: the worker publishes this, never live content.
create or replace function atlas_private.marketing_delivery_payload(p_content_id uuid, p_platform text, p_targets jsonb, p_approval_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c atlas_private.marketing_content_items;
  v_media jsonb;
  v_media_out jsonb;
  v_approved_at timestamptz;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id;
  select created_at into v_approved_at from atlas_private.marketing_content_approvals where id = p_approval_id;
  v_media := atlas_private.marketing_content_media_list(c.id, p_platform);
  select coalesce(jsonb_agg(jsonb_build_object(
      'asset_id', item -> 'asset_id', 'variant_id', item -> 'publish_variant_id', 'kind', item -> 'kind',
      'storage_path', item -> 'storage_path', 'mime_type', item -> 'mime_type', 'width', item -> 'width',
      'height', item -> 'height', 'duration_ms', item -> 'duration_ms', 'byte_size', item -> 'byte_size',
      'sha256', item -> 'sha256', 'position', item -> 'position', 'role', item -> 'role', 'alt_text', item -> 'alt_text'
    ) order by ordinality), '[]'::jsonb)
  into v_media_out
  from jsonb_array_elements(v_media) with ordinality as m(item, ordinality);
  return jsonb_build_object(
    'version', 1,
    'content_id', c.id,
    'approval_id', p_approval_id,
    'approved_at', v_approved_at,
    'title', c.title,
    'content_type', c.content_type,
    'provider_key', p_platform,
    'target_kind', atlas_private.marketing_target_kind(p_platform, c.platform_options, v_media),
    'external_account_id', atlas_private.marketing_target_resource_id(p_targets, p_platform),
    'caption', atlas_private.marketing_effective_caption(c.caption_draft, c.platform_options, p_platform),
    'platform_options', coalesce(c.platform_options -> p_platform, '{}'::jsonb),
    'media', v_media_out,
    'scheduled_for', c.scheduled_for,
    'publish_asap', atlas_private.marketing_content_publish_asap(c.scheduled_for, c.metadata),
    'event_starts_at', c.event_starts_at,
    'event_ends_at', c.event_ends_at,
    'venue_timezone', atlas_private.venue_timezone()
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Events, notifications, content-level status
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_delivery_event(p_delivery_id uuid, p_event_type text, p_payload jsonb default '{}'::jsonb,
  p_actor jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries;
  v_campaign uuid;
begin
  select * into d from atlas_private.marketing_deliveries where id = p_delivery_id;
  select campaign_id into v_campaign from atlas_private.marketing_content_items where id = d.content_id;
  insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
  values (p_event_type, v_campaign, d.content_id, (p_actor ->> 'id')::uuid,
          coalesce(p_actor ->> 'label', 'Atlas publisher'), coalesce(p_actor ->> 'role', 'system'),
          jsonb_build_object('delivery_id', d.id, 'provider_key', d.provider_key, 'target_kind', d.target_kind,
                             'status', d.status, 'attention_reason', d.attention_reason) || coalesce(p_payload, '{}'::jsonb));
end;
$$;

-- One push per delivery per attention episode (reset by a manager requeue). Audience: active admins
-- and managers plus the content owner when active. Provider label and title only, never raw errors.
create or replace function atlas_private.marketing_delivery_notify(p_delivery_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries;
  c atlas_private.marketing_content_items;
  v_label text;
  v_audience uuid[];
  v_count integer := 0;
begin
  select * into d from atlas_private.marketing_deliveries where id = p_delivery_id for no key update;
  if not found or d.status not in ('needs_attention','failed') then return 0; end if;
  perform atlas_private.marketing_delivery_event(d.id,
    case when d.status = 'failed' then 'delivery_failed' else 'delivery_needs_attention' end,
    jsonb_build_object('error_class', d.last_error_class, 'error_code', d.last_error_code));
  if d.attention_notified_at is not null then return 0; end if;
  select * into c from atlas_private.marketing_content_items where id = d.content_id;
  select coalesce(nullif(label, ''), d.provider_key) into v_label from atlas_private.integration_connections where provider_key = d.provider_key;
  select array_agg(distinct profile.id) into v_audience
  from public.profiles profile
  where profile.active is true
    and (profile.role::text in ('admin','manager') or profile.id = c.owner_id);
  if v_audience is not null then
    v_count := public.atlas_push_notification_enqueue_many(
      v_audience, 'marketing_attention',
      case when d.status = 'failed' then 'Post could not be published' else 'Post needs attention' end,
      left(v_label || ': "' || left(c.title, 80) || '" ' || case
        when d.status = 'failed' then 'was not published. Open Marketing to fix it.'
        when d.attention_reason = 'outcome_unknown' then 'may or may not have been posted. Check and tell Atlas.'
        when d.attention_reason = 'stale_schedule' then 'was not sent in time. Open Marketing to decide.'
        when d.attention_reason in ('auth_expired','provider_not_ready','no_resource') then 'is waiting for the connection in Settings.'
        else 'needs a check in Marketing.' end, 500),
      'marketing', d.id);
  end if;
  update atlas_private.marketing_deliveries set attention_notified_at = pg_catalog.now() where id = d.id;
  return v_count;
end;
$$;

create or replace function atlas_private.marketing_publication_state(p_content_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c atlas_private.marketing_content_items;
  v_live integer; v_published integer; v_attention integer; v_active integer; v_waiting integer;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id;
  if not found then return 'none'; end if;
  select count(*) filter (where status <> 'cancelled'),
         count(*) filter (where status = 'published'),
         count(*) filter (where status in ('needs_attention','failed')),
         count(*) filter (where status in ('publishing','processing','verifying')),
         count(*) filter (where status in ('queued','retrying'))
  into v_live, v_published, v_attention, v_active, v_waiting
  from atlas_private.marketing_deliveries where content_id = p_content_id;
  if v_attention > 0 then return 'attention'; end if;
  if v_live > 0 and v_published = v_live then return 'published'; end if;
  if v_active > 0 then return 'publishing'; end if;
  if v_published > 0 then return 'partial'; end if;
  if c.status in ('approved','scheduled') then
    if v_waiting = 0 or not atlas_private.marketing_automatic_publishing_enabled() then return 'ready_not_sent'; end if;
    return 'queued';
  end if;
  return 'none';
end;
$$;

-- Report 07 §2.4: all live deliveries published -> content published (external ids rebuilt).
create or replace function atlas_private.marketing_content_refresh_publication(p_content_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c atlas_private.marketing_content_items;
  v_live integer; v_published integer;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id for no key update;
  if not found then return 'none'; end if;
  select count(*) filter (where status <> 'cancelled'), count(*) filter (where status = 'published')
  into v_live, v_published
  from atlas_private.marketing_deliveries where content_id = p_content_id;
  if c.status in ('approved','scheduled') and v_live > 0 and v_live = v_published then
    update atlas_private.marketing_content_items
    set status = 'published',
        published_at = (select max(published_at) from atlas_private.marketing_deliveries where content_id = p_content_id and status = 'published'),
        external_publication_ids = (
          select coalesce(jsonb_object_agg(provider_key, entry), '{}'::jsonb) from (
            select distinct on (provider_key) provider_key, jsonb_strip_nulls(jsonb_build_object(
              'delivery_id', id, 'post_id', provider_post_id, 'permalink', provider_permalink,
              'target_kind', target_kind, 'published_at', published_at, 'source', published_source)) entry
            from atlas_private.marketing_deliveries
            where content_id = p_content_id and status = 'published'
            order by provider_key, published_at desc) per_provider)
    where id = p_content_id;
    insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_label, actor_role, payload)
    values ('content_published', c.campaign_id, c.id, 'Atlas publisher', 'system',
            jsonb_build_object('source', 'deliveries', 'deliveries', v_published));
  end if;
  return atlas_private.marketing_publication_state(p_content_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Material edits after approval (§5.1, report 07 §7.4)
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_content_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material boolean;
  v_leaving boolean;
  v_editable boolean;
  v_in_flight integer;
  v_cancelled integer := 0;
  v_reason text;
begin
  new.version := old.version + 1;
  v_material := new.caption_draft is distinct from old.caption_draft
    or new.platforms is distinct from old.platforms
    or new.scheduled_for is distinct from old.scheduled_for
    or new.platform_options is distinct from old.platform_options
    or new.content_type is distinct from old.content_type
    or atlas_private.marketing_content_publish_asap(new.scheduled_for, new.metadata)
       is distinct from atlas_private.marketing_content_publish_asap(old.scheduled_for, old.metadata);
  if old.status not in ('approved','scheduled') then
    if new.status in ('approved','scheduled') and old.status <> 'pending_approval' then
      raise exception 'Only an approval decision can approve content' using errcode = 'P0001', hint = 'atlas:invalid_request';
    end if;
    return new;
  end if;
  v_leaving := new.status not in ('approved','scheduled');
  if not v_material and not v_leaving then
    -- Approved -> scheduled bookkeeping and non-material edits (title, notes, reminder) keep approval.
    return new;
  end if;
  v_editable := new.status not in ('cancelled','published','completed','rejected');
  select count(*) into v_in_flight from atlas_private.marketing_deliveries
  where content_id = old.id and status in ('publishing','processing','verifying');
  if v_in_flight > 0 and (v_editable or v_material) then
    raise exception 'This post is being published right now. Wait for it to finish or cancel it first.'
      using errcode = '55000', hint = 'atlas:in_flight';
  end if;
  v_reason := case when new.status = 'cancelled' then 'content_cancelled'
                   when new.status in ('published','completed','rejected') then 'user'
                   else 'superseded_by_edit' end;
  -- Unstarted deliveries are cancelled. Failed ones, and attention rows where nothing may exist,
  -- go too, so a re-approval can queue that target again. Attention rows that may already be posted
  -- stay for a manager to resolve (mark posted / cancel).
  with cancelled as (
    update atlas_private.marketing_deliveries
    set status = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_reason = v_reason
    where content_id = old.id
      and (status in ('queued','retrying','failed')
           or (status = 'needs_attention' and (phase not in ('submitting','submitted') or new.status = 'cancelled')))
    returning id)
  select count(*) into v_cancelled from cancelled;
  if not v_editable then
    update atlas_private.marketing_deliveries set cancel_requested_at = coalesce(cancel_requested_at, pg_catalog.now())
    where content_id = old.id and status in ('publishing','processing','verifying');
  end if;
  if v_editable then
    new.approved_fingerprint := null;
    new.approval_id := null;
    if new.status in ('approved','scheduled') then
      new.status := 'draft';
    end if;
    insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_label, actor_role, payload)
    values ('approval_invalidated', new.campaign_id, new.id, 'Atlas', 'system',
            jsonb_build_object('previous_status', old.status, 'status', new.status, 'material_edit', v_material,
                               'cancelled_deliveries', v_cancelled));
  end if;
  return new;
end;
$$;

drop trigger if exists marketing_content_items_guard on atlas_private.marketing_content_items;
create trigger marketing_content_items_guard
  before update on atlas_private.marketing_content_items
  for each row execute function atlas_private.marketing_content_guard();

-- Media changes are material: attached, removed, reordered or replaced media on approved content
-- sends it back to draft through the content guard above (the S94A media RPCs do the same).
create or replace function atlas_private.marketing_content_media_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content_id uuid;
begin
  foreach v_content_id in array array_remove(array[
      case when tg_op in ('INSERT','UPDATE') then new.content_id end,
      case when tg_op in ('UPDATE','DELETE') then old.content_id end], null) loop
    if tg_op = 'UPDATE' and new.content_id = old.content_id and v_content_id = old.content_id
       and new.asset_id is not distinct from old.asset_id and new.variant_id is not distinct from old.variant_id
       and new.position is not distinct from old.position and new.platform is not distinct from old.platform
       and new.role is not distinct from old.role then
      continue;
    end if;
    -- Only a recorded approval can be invalidated (content approved before S94C has none and
    -- can never be delivered: deliveries require the approval id and fingerprint).
    update atlas_private.marketing_content_items set status = 'draft'
    where id = v_content_id and status in ('approved','scheduled') and approval_id is not null;
  end loop;
  return null;
end;
$$;

drop trigger if exists marketing_content_media_material on atlas_private.marketing_content_media;
create trigger marketing_content_media_material
  after insert or update or delete on atlas_private.marketing_content_media
  for each row execute function atlas_private.marketing_content_media_changed();

-- ---------------------------------------------------------------------------------------------
-- 6. Deliveries from an approval (§5.2)
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_deliveries_create_for_approval(
  p_content_id uuid,
  p_approval_id uuid,
  p_due_at timestamptz default null,
  p_priority integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c atlas_private.marketing_content_items;
  a atlas_private.marketing_content_approvals;
  v_targets jsonb := atlas_private.marketing_publish_targets();
  v_platform text;
  v_payload jsonb;
  v_due timestamptz;
  v_latest timestamptz;
  v_created jsonb := '[]'::jsonb;
  v_row atlas_private.marketing_deliveries;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id for no key update;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  select * into a from atlas_private.marketing_content_approvals where id = p_approval_id and content_id = p_content_id;
  if not found or a.decision <> 'approved' or a.approved_fingerprint is null then
    raise exception 'Deliveries need an approved decision with a fingerprint' using errcode = 'P0001', hint = 'atlas:invalid_request';
  end if;
  if c.status not in ('approved','scheduled') or c.approval_id is distinct from a.id then
    raise exception 'This content is not approved' using errcode = '55000', hint = 'atlas:superseded';
  end if;
  if atlas_private.marketing_content_fingerprint(c.id, v_targets) <> a.approved_fingerprint then
    raise exception 'This post changed after approval. Approve it again.' using errcode = '55000', hint = 'atlas:superseded';
  end if;
  -- "As soon as it's approved" (metadata.publish_asap, no time): due now. With automatic publishing
  -- off the rows wait (ready, not sent) exactly like a scheduled post whose time has come.
  v_due := coalesce(p_due_at, c.scheduled_for,
    case when atlas_private.marketing_content_publish_asap(c.scheduled_for, c.metadata) then pg_catalog.now() end);
  if v_due is null then
    return v_created;   -- unscheduled approval: nothing is queued until a schedule or Publish now
  end if;
  v_latest := case when p_priority <= 10 then v_due + interval '30 minutes' else v_due + interval '6 hours' end;
  if c.event_starts_at is not null and c.content_type = 'event_promotion' then
    v_latest := greatest(v_due, least(v_latest, c.event_starts_at));
  end if;
  foreach v_platform in array (select coalesce(array_agg(p order by p), '{}'::text[]) from unnest(c.platforms) p) loop
    v_payload := atlas_private.marketing_delivery_payload(c.id, v_platform, v_targets, a.id);
    insert into atlas_private.marketing_deliveries (
      content_id, provider_key, external_account_id, target_kind, approval_id, approved_fingerprint,
      payload_snapshot, status, due_at, next_attempt_at, latest_acceptable_at, priority
    ) values (
      c.id, v_platform, v_payload ->> 'external_account_id', v_payload ->> 'target_kind', a.id, a.approved_fingerprint,
      v_payload, 'queued', v_due, v_due, v_latest, greatest(1, least(coalesce(p_priority, 100), 1000))
    )
    on conflict (content_id, provider_key, external_account_id, target_kind) where status <> 'cancelled' do nothing
    returning * into v_row;
    if found then
      v_created := v_created || jsonb_build_array(jsonb_build_object(
        'id', v_row.id, 'provider_key', v_row.provider_key, 'target_kind', v_row.target_kind,
        'external_account_id', v_row.external_account_id, 'status', v_row.status, 'due_at', v_row.due_at));
    end if;
  end loop;
  if jsonb_array_length(v_created) > 0 then
    insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_label, actor_role, payload)
    values ('deliveries_created', c.campaign_id, c.id, 'Atlas', 'system',
            jsonb_build_object('approval_id', a.id, 'deliveries', v_created));
  end if;
  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Backoff, gate, refusals, lease recovery (report 07 §3, §5, §7)
-- ---------------------------------------------------------------------------------------------

-- Equal jitter: half fixed + half random, capped (1 h), Retry-After wins. p_jitter in [0,1) is the
-- test hook; null uses the session setting atlas.marketing_backoff_jitter, else random().
create or replace function atlas_private.marketing_backoff(
  p_attempt integer,
  p_base_s integer default 60,
  p_cap_s integer default 3600,
  p_retry_after_s integer default null,
  p_jitter double precision default null
)
returns interval
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_setting text := nullif(current_setting('atlas.marketing_backoff_jitter', true), '');
  v_jitter double precision := coalesce(p_jitter, case when v_setting ~ '^0?\.[0-9]+$|^0$' then v_setting::double precision end, random());
  v_base double precision;
begin
  v_jitter := greatest(0, least(v_jitter, 0.999999));
  v_base := least(greatest(coalesce(p_cap_s, 3600), 1)::double precision,
                  greatest(coalesce(p_base_s, 60), 1) * power(2, greatest(coalesce(p_attempt, 1), 1) - 1));
  return make_interval(secs => greatest(least(coalesce(p_retry_after_s, 0), 86400)::double precision,
                                        (v_base / 2.0) * (1 + v_jitter)));
end;
$$;

-- Next time the account has publishing budget (null = now). Instagram: provider cap (100, or the last
-- quota read) and the Atlas safety cap (25/day); every account: Atlas cap. Google Business Profile:
-- one publication in flight per location (10 edits/min/location, serialized).
create or replace function atlas_private.marketing_account_budget_next(p_provider text, p_account text, p_delivery_id uuid default null)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pa atlas_private.marketing_provider_accounts;
  v_cap integer;
  v_used integer;
  v_oldest timestamptz;
begin
  select * into pa from atlas_private.marketing_provider_accounts where provider_key = p_provider and external_account_id = p_account;
  v_cap := least(coalesce(pa.atlas_daily_cap, 25),
                 coalesce(pa.daily_publish_cap, case when p_provider = 'instagram' then 100 else 1000 end));
  select count(*), min(coalesce(published_at, submit_started_at)) into v_used, v_oldest
  from atlas_private.marketing_deliveries
  where provider_key = p_provider and external_account_id = p_account
    and (id <> p_delivery_id or p_delivery_id is null)
    and ((published_at > pg_catalog.now() - interval '24 hours' and coalesce(published_source, 'provider') <> 'manual')
         or (status in ('publishing','processing','verifying') and phase in ('submitting','submitted')
             and submit_started_at > pg_catalog.now() - interval '24 hours'));
  if v_used >= v_cap then
    return coalesce(v_oldest, pg_catalog.now()) + interval '24 hours' + make_interval(secs => 30 + floor(random() * 120));
  end if;
  if p_provider = 'google-business-profile' and exists (
    select 1 from atlas_private.marketing_deliveries
    where provider_key = p_provider and external_account_id = p_account and status = 'publishing'
      and claim_token is not null and (id <> p_delivery_id or p_delivery_id is null)) then
    return pg_catalog.now() + interval '60 seconds';
  end if;
  return null;
end;
$$;

-- Gate for a queued/retrying delivery before a publish claim and again inside begin_submit.
-- Returns null when publishing may proceed, else a reason code (report 07 §7.3).
create or replace function atlas_private.marketing_delivery_gate_reason(p_delivery_id uuid, p_targets jsonb default null)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries;
  c atlas_private.marketing_content_items;
  a atlas_private.marketing_content_approvals;
  v_targets jsonb := coalesce(p_targets, atlas_private.marketing_publish_targets());
  v_target jsonb;
  v_selected text;
  pa atlas_private.marketing_provider_accounts;
begin
  select * into d from atlas_private.marketing_deliveries where id = p_delivery_id;
  select * into c from atlas_private.marketing_content_items where id = d.content_id;
  select * into a from atlas_private.marketing_content_approvals where id = d.approval_id;
  if d.cancel_requested_at is not null then return 'cancel_requested'; end if;
  if c.status in ('cancelled','rejected','completed','published') then return 'content_cancelled'; end if;
  if c.status not in ('approved','scheduled') or c.approval_id is distinct from d.approval_id
     or a.decision is distinct from 'approved' or a.approved_fingerprint is distinct from d.approved_fingerprint
     or c.approved_fingerprint is distinct from d.approved_fingerprint then
    return 'superseded_by_edit';
  end if;
  -- No decision newer than this approval (ties in one transaction are the approval itself).
  if exists (select 1 from atlas_private.marketing_content_approvals approval
             where approval.content_id = c.id and approval.id <> a.id and approval.created_at > a.created_at) then
    return 'superseded_by_edit';
  end if;
  v_target := atlas_private.marketing_target_for(v_targets, d.provider_key);
  v_selected := nullif(v_target #>> '{resource,id}', '');
  if d.external_account_id <> 'pending' and v_selected is not null and v_selected <> d.external_account_id then
    return 'superseded_by_edit';   -- the approved account is no longer the selected one
  end if;
  if atlas_private.marketing_content_fingerprint(c.id, v_targets) <> d.approved_fingerprint then
    return 'superseded_by_edit';
  end if;
  if pg_catalog.now() > d.latest_acceptable_at then return 'stale_schedule'; end if;
  if not atlas_private.marketing_automatic_publishing_enabled() then return 'automatic_publishing_disabled'; end if;
  if d.external_account_id = 'pending' or v_selected is null then return 'no_resource'; end if;
  if coalesce((v_target ->> 'ready')::boolean, false) is not true
     or not coalesce(v_target -> 'target_kinds', '[]'::jsonb) ? d.target_kind then
    return 'provider_not_ready';
  end if;
  if d.status = 'retrying' and d.attempt_count >= d.max_attempts then return 'max_attempts'; end if;
  select * into pa from atlas_private.marketing_provider_accounts
  where provider_key = d.provider_key and external_account_id = d.external_account_id;
  if pa.cooldown_until is not null and pa.cooldown_until > pg_catalog.now() then return 'cooldown'; end if;
  if atlas_private.marketing_account_budget_next(d.provider_key, d.external_account_id, d.id) is not null then return 'rate_limited'; end if;
  return null;
end;
$$;

-- Applies a gate refusal to a locked delivery (claimed or not). Cancels, parks for a manager, or
-- defers. Returns the resulting status.
create or replace function atlas_private.marketing_delivery_refuse(p_delivery_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries;
  c_status text;
  v_next timestamptz;
  v_status text;
  v_outcome text;
begin
  select * into d from atlas_private.marketing_deliveries where id = p_delivery_id for no key update;
  select status into c_status from atlas_private.marketing_content_items where id = d.content_id;
  if p_reason in ('cancel_requested','content_cancelled','superseded_by_edit') then
    update atlas_private.marketing_deliveries set
      status = 'cancelled', cancelled_at = pg_catalog.now(),
      cancelled_reason = case when p_reason = 'superseded_by_edit' then 'superseded_by_edit'
                              when p_reason = 'content_cancelled' or c_status = 'cancelled' then 'content_cancelled'
                              else 'user' end,
      claim_token = null, claimed_by = null, claimed_until = null
    where id = d.id;
    v_outcome := 'cancelled';
  elsif p_reason in ('stale_schedule','no_resource','provider_not_ready','max_attempts') then
    update atlas_private.marketing_deliveries set
      status = 'needs_attention', attention_reason = p_reason,
      last_error_class = case when p_reason = 'stale_schedule' then 'stale' else 'policy' end,
      last_error_code = p_reason,
      last_error_message = case p_reason
        when 'stale_schedule' then 'The planned time passed before the post could be sent.'
        when 'no_resource' then 'No page, account or location was chosen when this post was approved.'
        when 'provider_not_ready' then 'The connection is not ready to publish this post.'
        else 'Atlas stopped retrying after the maximum number of attempts.' end,
      claim_token = null, claimed_by = null, claimed_until = null
    where id = d.id;
    v_outcome := 'needs_attention';
  else
    -- Deferral (automatic publishing off, cooldown, publishing budget used up).
    if p_reason = 'cooldown' then
      select greatest(cooldown_until, pg_catalog.now() + interval '30 seconds') into v_next
      from atlas_private.marketing_provider_accounts
      where provider_key = d.provider_key and external_account_id = d.external_account_id;
    elsif p_reason = 'rate_limited' then
      v_next := atlas_private.marketing_account_budget_next(d.provider_key, d.external_account_id, d.id);
    else
      v_next := pg_catalog.now() + interval '5 minutes';
    end if;
    v_next := coalesce(v_next, pg_catalog.now() + interval '1 minute');
    if p_reason in ('cooldown','rate_limited') and v_next > d.latest_acceptable_at then
      update atlas_private.marketing_deliveries set
        status = 'needs_attention', attention_reason = 'rate_limit_exhausted', last_error_class = 'rate_limited',
        last_error_code = 'rate_limit_exhausted',
        last_error_message = 'The platform publishing limit is used up until after the latest acceptable time.',
        claim_token = null, claimed_by = null, claimed_until = null
      where id = d.id;
      v_outcome := 'needs_attention';
    else
      update atlas_private.marketing_deliveries set
        status = case when status = 'publishing' then 'retrying' else status end,
        attempt_count = case when status = 'publishing' then greatest(attempt_count - 1, 0) else attempt_count end,
        next_attempt_at = v_next,
        claim_token = null, claimed_by = null, claimed_until = null
      where id = d.id;
      v_outcome := 'retrying';
    end if;
  end if;
  if d.claim_token is not null then
    update atlas_private.marketing_delivery_attempts set
      finished_at = pg_catalog.now(), outcome = v_outcome,
      steps = steps || jsonb_build_array(atlas_private.marketing_sanitize_step(jsonb_build_object('step', 'gate', 'outcome', p_reason)))
    where claim_token = d.claim_token and finished_at is null;
  end if;
  select status into v_status from atlas_private.marketing_deliveries where id = d.id;
  if v_status = 'cancelled' then
    perform atlas_private.marketing_delivery_event(d.id, 'delivery_cancelled', jsonb_build_object('reason', p_reason));
  elsif v_status = 'needs_attention' then
    perform atlas_private.marketing_delivery_notify(d.id);
  end if;
  perform atlas_private.marketing_content_refresh_publication(d.content_id);
  return v_status;
end;
$$;

-- Report 07 §3.2(a): expired leases. Before the submit marker -> retrying (safe); after it ->
-- verifying (never a blind retry); polls and verifies keep their status.
create or replace function atlas_private.marketing_recover_expired_leases()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r atlas_private.marketing_deliveries;
  v_count integer := 0;
begin
  for r in
    select * from atlas_private.marketing_deliveries
    where claim_token is not null and claimed_until < pg_catalog.now()
    order by claimed_until
    for no key update skip locked
  loop
    update atlas_private.marketing_delivery_attempts
    set outcome = 'lease_lost', finished_at = pg_catalog.now()
    where claim_token = r.claim_token and finished_at is null;
    if r.status = 'publishing' and r.phase in ('submitting','submitted') then
      update atlas_private.marketing_deliveries set status = 'verifying', last_error_class = 'uncertain',
        last_error_code = 'lease_expired', claim_token = null, claimed_by = null, claimed_until = null,
        next_attempt_at = pg_catalog.now()
      where id = r.id;
    elsif r.status = 'publishing' and r.attempt_count >= r.max_attempts then
      update atlas_private.marketing_deliveries set status = 'needs_attention', attention_reason = 'max_attempts',
        last_error_class = 'transient', last_error_code = 'lease_expired',
        claim_token = null, claimed_by = null, claimed_until = null
      where id = r.id;
      perform atlas_private.marketing_delivery_notify(r.id);
    elsif r.status = 'publishing' then
      update atlas_private.marketing_deliveries set status = 'retrying', last_error_class = 'transient',
        last_error_code = 'lease_expired', claim_token = null, claimed_by = null, claimed_until = null,
        next_attempt_at = pg_catalog.now()
      where id = r.id;
    else
      update atlas_private.marketing_deliveries set claim_token = null, claimed_by = null, claimed_until = null,
        next_attempt_at = pg_catalog.now()
      where id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Worker RPCs: claim, heartbeat, record_step, begin_submit, complete
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_delivery_json(d atlas_private.marketing_deliveries)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id, 'content_id', d.content_id, 'provider_key', d.provider_key,
    'external_account_id', d.external_account_id, 'target_kind', d.target_kind, 'status', d.status,
    'phase', d.phase, 'priority', d.priority, 'attempt_count', d.attempt_count, 'max_attempts', d.max_attempts,
    'poll_count', d.poll_count, 'verify_attempts', d.verify_attempts, 'due_at', d.due_at,
    'next_attempt_at', d.next_attempt_at, 'latest_acceptable_at', d.latest_acceptable_at,
    'provider_container_id', d.provider_container_id, 'provider_publish_id', d.provider_publish_id,
    'provider_post_id', d.provider_post_id, 'provider_permalink', d.provider_permalink,
    'submit_started_at', d.submit_started_at, 'progress', d.progress,
    'published_at', d.published_at, 'published_source', d.published_source,
    'last_error_class', d.last_error_class, 'last_error_code', d.last_error_code,
    'last_error_message', d.last_error_message, 'attention_reason', d.attention_reason,
    'cancel_requested_at', d.cancel_requested_at, 'cancelled_at', d.cancelled_at,
    'cancelled_reason', d.cancelled_reason, 'created_at', d.created_at, 'updated_at', d.updated_at,
    'row_version', d.row_version);
$$;

create or replace function atlas_private.marketing_delivery_claim(
  p_worker_id text,
  p_limit integer default 4,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := pg_catalog.btrim(coalesce(p_worker_id, ''));
  v_limit integer := greatest(1, least(coalesce(p_limit, 4), 20));
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 300), 900));
  v_auto boolean := atlas_private.marketing_automatic_publishing_enabled();
  v_targets jsonb;
  v_ids uuid[];
  r atlas_private.marketing_deliveries;
  v_reason text;
  v_kind text;
  v_token uuid;
  v_attempt integer;
  v_claimed integer := 0;
  v_per_account jsonb := '{}'::jsonb;
  v_key text;
  v_cap integer;
  v_result jsonb := '[]'::jsonb;
begin
  if v_worker !~ '^[A-Za-z0-9._:@-]{1,120}$' then
    raise exception 'Worker id is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  perform atlas_private.marketing_recover_expired_leases();
  v_targets := atlas_private.marketing_publish_targets();

  if v_auto then
    -- Stale guard and cancel requests on waiting rows, whether or not they are due yet.
    for r in
      select * from atlas_private.marketing_deliveries
      where status in ('queued','retrying') and claim_token is null
        and (cancel_requested_at is not null or latest_acceptable_at < pg_catalog.now())
      for no key update skip locked
    loop
      perform atlas_private.marketing_delivery_refuse(r.id,
        case when r.cancel_requested_at is not null then 'cancel_requested'
             else coalesce(atlas_private.marketing_delivery_gate_reason(r.id, v_targets), 'stale_schedule') end);
    end loop;
  end if;

  -- (b) Candidates and fairness without locks (window functions cannot be combined with FOR UPDATE).
  -- Up to 10 per account are ranked so a concurrent claimer that skips rows another worker has
  -- locked (but not yet committed) still finds work; the per-account cap of 2 (1 for a Google
  -- location) is enforced on the locked rows in (c).
  select array_agg(candidate.id order by candidate.priority, candidate.next_attempt_at, candidate.id)
  into v_ids
  from (
    select d.id, d.priority, d.next_attempt_at,
           row_number() over (partition by d.provider_key, d.external_account_id
                              order by d.priority, d.next_attempt_at, d.id) as rn
    from atlas_private.marketing_deliveries d
    left join atlas_private.marketing_provider_accounts pa
      on pa.provider_key = d.provider_key and pa.external_account_id = d.external_account_id
    where d.claim_token is null
      and d.next_attempt_at <= pg_catalog.now()
      and (d.status in ('processing','verifying') or (v_auto and d.status in ('queued','retrying')))
      and (pa.cooldown_until is null or pa.cooldown_until <= pg_catalog.now())
  ) candidate
  where candidate.rn <= 10;
  if v_ids is null then
    return v_result;
  end if;
  v_ids := v_ids[1:v_limit * 10];

  -- (c) Lock with SKIP LOCKED, re-check every predicate, then (d) claim.
  for r in
    select * from atlas_private.marketing_deliveries d
    where d.id = any(v_ids)
      and d.claim_token is null
      and d.next_attempt_at <= pg_catalog.now()
      and (d.status in ('processing','verifying') or (v_auto and d.status in ('queued','retrying')))
    order by d.priority, d.next_attempt_at, d.id
    for no key update skip locked
  loop
    exit when v_claimed >= v_limit;
    v_key := r.provider_key || '|' || r.external_account_id;
    v_cap := case when r.provider_key = 'google-business-profile' then 1 else 2 end;
    if coalesce((v_per_account ->> v_key)::integer, 0) >= v_cap then
      continue;
    end if;
    if r.status in ('queued','retrying') then
      v_reason := atlas_private.marketing_delivery_gate_reason(r.id, v_targets);
      if v_reason is not null then
        if v_reason <> 'automatic_publishing_disabled' then
          perform atlas_private.marketing_delivery_refuse(r.id, v_reason);
        end if;
        continue;
      end if;
      v_kind := 'publish';
    elsif r.status = 'processing' then
      v_kind := 'poll';
    else
      v_kind := 'verify';
    end if;
    v_token := gen_random_uuid();
    select coalesce(max(attempt_no), 0) + 1 into v_attempt
    from atlas_private.marketing_delivery_attempts where delivery_id = r.id;
    update atlas_private.marketing_deliveries set
      claim_token = v_token,
      claimed_by = v_worker,
      claimed_until = pg_catalog.now() + make_interval(secs => v_lease),
      status = case when status in ('queued','retrying') then 'publishing' else status end,
      attempt_count = attempt_count + case when status in ('queued','retrying') then 1 else 0 end,
      poll_count = poll_count + case when status = 'processing' then 1 else 0 end,
      verify_attempts = verify_attempts + case when status = 'verifying' then 1 else 0 end
    where id = r.id
    returning * into r;
    insert into atlas_private.marketing_delivery_attempts (delivery_id, attempt_no, claim_token, claimed_by, claim_kind)
    values (r.id, v_attempt, v_token, v_worker, v_kind);
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'claim_token', v_token,
      'claim_kind', v_kind,
      'attempt_no', v_attempt,
      'lease_until', r.claimed_until,
      'delivery', atlas_private.marketing_delivery_json(r),
      'payload_snapshot', r.payload_snapshot));
    v_claimed := v_claimed + 1;
    v_per_account := v_per_account || jsonb_build_object(v_key, coalesce((v_per_account ->> v_key)::integer, 0) + 1);
  end loop;
  return v_result;
end;
$$;

-- Fenced lock helper: the row only when this claim token still owns an unexpired lease.
create or replace function atlas_private.marketing_delivery_lock_claim(p_delivery_id uuid, p_claim_token uuid)
returns atlas_private.marketing_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries;
begin
  if p_delivery_id is null or p_claim_token is null then return null; end if;
  select * into d from atlas_private.marketing_deliveries
  where id = p_delivery_id and claim_token = p_claim_token and claimed_until > pg_catalog.now()
  for no key update;
  if not found then return null; end if;
  return d;
end;
$$;

create or replace function atlas_private.marketing_delivery_heartbeat(p_delivery_id uuid, p_claim_token uuid, p_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries := atlas_private.marketing_delivery_lock_claim(p_delivery_id, p_claim_token);
begin
  if d.id is null then return jsonb_build_object('ok', false, 'lease_lost', true); end if;
  update atlas_private.marketing_deliveries
  set claimed_until = greatest(claimed_until, pg_catalog.now() + make_interval(secs => greatest(30, least(coalesce(p_seconds, 300), 900))))
  where id = d.id
  returning * into d;
  return jsonb_build_object('ok', true, 'lease_until', d.claimed_until);
end;
$$;

-- Applies provider ids / progress from a worker payload to a locked, claimed delivery.
create or replace function atlas_private.marketing_delivery_apply_ids(p_delivery_id uuid, p_phase text, p_ids jsonb)
returns atlas_private.marketing_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries;
  v_ids jsonb := coalesce(p_ids, '{}'::jsonb);
  v_reset boolean;
  v_permalink text;
begin
  select * into d from atlas_private.marketing_deliveries where id = p_delivery_id for no key update;
  if jsonb_typeof(v_ids) <> 'object' then
    raise exception 'ids must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if exists (select 1 from jsonb_object_keys(v_ids) k
             where k not in ('provider_container_id','provider_publish_id','provider_post_id','provider_permalink','progress','reset_container')) then
    raise exception 'Unknown delivery id field' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if p_phase is not null then
    if p_phase not in ('none','media_ready','container_created','container_ready','submitted','remote_processing') then
      raise exception 'Phase % cannot be recorded here', left(p_phase, 40) using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    -- After the marker only forward moves are allowed, except the Instagram case where the worker
    -- proved the publish did not happen: the same FINISHED container goes back to container_ready.
    if d.phase in ('submitting','submitted','remote_processing') and p_phase not in ('submitted','remote_processing')
       and not (p_phase = 'container_ready' and d.phase = 'submitting' and d.provider_container_id is not null
                and d.provider_post_id is null) then
      raise exception 'A submitted delivery cannot go back to an earlier phase' using errcode = 'P0001', hint = 'atlas:invalid_request';
    end if;
    if p_phase in ('submitted','remote_processing') and d.phase not in ('submitting','submitted','remote_processing') then
      raise exception 'Record the submit marker first' using errcode = 'P0001', hint = 'atlas:invalid_request';
    end if;
  end if;
  v_reset := coalesce((v_ids ->> 'reset_container')::boolean, false);
  if v_reset and (p_phase is distinct from 'none' or d.phase not in ('media_ready','container_created','container_ready')) then
    raise exception 'A container can only be replaced before submit, with phase none' using errcode = 'P0001', hint = 'atlas:invalid_request';
  end if;
  v_permalink := nullif(v_ids ->> 'provider_permalink', '');
  if v_permalink is not null and (v_permalink !~ '^https://[^[:space:]]+$' or pg_catalog.char_length(v_permalink) > 2000) then
    raise exception 'Permalink must be an https link' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_ids ? 'progress' and jsonb_typeof(v_ids -> 'progress') <> 'object' then
    raise exception 'progress must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  update atlas_private.marketing_deliveries set
    phase = coalesce(p_phase, phase),
    provider_container_id = case when v_reset then null
      else coalesce(nullif(v_ids ->> 'provider_container_id', ''), provider_container_id) end,
    provider_publish_id = coalesce(nullif(v_ids ->> 'provider_publish_id', ''), provider_publish_id),
    provider_post_id = coalesce(nullif(v_ids ->> 'provider_post_id', ''), provider_post_id),
    provider_permalink = coalesce(v_permalink, provider_permalink),
    progress = progress || coalesce(v_ids -> 'progress', '{}'::jsonb)
  where id = d.id
  returning * into d;
  return d;
end;
$$;

create or replace function atlas_private.marketing_delivery_record_step(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_phase text,
  p_ids jsonb,
  p_step jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries := atlas_private.marketing_delivery_lock_claim(p_delivery_id, p_claim_token);
begin
  if d.id is null then return jsonb_build_object('ok', false, 'lease_lost', true); end if;
  d := atlas_private.marketing_delivery_apply_ids(d.id, p_phase, p_ids);
  update atlas_private.marketing_delivery_attempts
  set steps = steps || jsonb_build_array(atlas_private.marketing_sanitize_step(p_step)
                 || jsonb_strip_nulls(jsonb_build_object('phase', p_phase)))
  where claim_token = p_claim_token and finished_at is null;
  return jsonb_build_object('ok', true, 'phase', d.phase, 'lease_until', d.claimed_until);
end;
$$;

-- The submitting marker (report 07 §3.1): re-runs the gate inside the transaction that sets it.
-- The worker makes the non-idempotent provider call only after {ok:true}.
create or replace function atlas_private.marketing_delivery_begin_submit(p_delivery_id uuid, p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries := atlas_private.marketing_delivery_lock_claim(p_delivery_id, p_claim_token);
  v_reason text;
  v_status text;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'lease_lost', true); end if;
  if d.status not in ('publishing','processing') then
    raise exception 'This delivery is not publishing' using errcode = 'P0001', hint = 'atlas:invalid_request';
  end if;
  if d.phase in ('submitting','submitted','remote_processing') then
    raise exception 'The submit marker is already set; verify instead of submitting again'
      using errcode = 'P0001', hint = 'atlas:invalid_request';
  end if;
  v_reason := atlas_private.marketing_delivery_gate_reason(d.id);
  if v_reason = 'max_attempts' then v_reason := null; end if;   -- this claim already counted
  if v_reason is not null then
    v_status := atlas_private.marketing_delivery_refuse(d.id, v_reason);
    return jsonb_build_object('ok', false, 'refused', true, 'reason', v_reason, 'status', v_status);
  end if;
  update atlas_private.marketing_deliveries set
    status = 'publishing',
    phase = 'submitting',
    submit_started_at = pg_catalog.now(),
    claimed_until = greatest(claimed_until, pg_catalog.now() + interval '300 seconds')
  where id = d.id
  returning * into d;
  update atlas_private.marketing_delivery_attempts
  set steps = steps || jsonb_build_array(atlas_private.marketing_sanitize_step(jsonb_build_object('step', 'begin_submit')))
  where claim_token = p_claim_token and finished_at is null;
  return jsonb_build_object('ok', true, 'lease_until', d.claimed_until, 'submit_started_at', d.submit_started_at);
end;
$$;

create or replace function atlas_private.marketing_poll_delay(p_provider text, p_target_kind text, p_poll_count integer)
returns interval
language sql
immutable
security definer
set search_path = ''
as $$
  select make_interval(secs => case
    when p_provider = 'tiktok' then (array[30,60,120,300,600,900])[least(greatest(coalesce(p_poll_count, 0), 0) + 1, 6)]
    when p_target_kind in ('ig_reel','fb_page_video','fb_reel') then (array[60,120,300,300,600])[least(greatest(coalesce(p_poll_count, 0), 0) + 1, 5)]
    else (array[60,60,120,300,300,600])[least(greatest(coalesce(p_poll_count, 0), 0) + 1, 6)]
  end);
$$;

create or replace function atlas_private.marketing_poll_budget(p_provider text, p_target_kind text)
returns interval
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_provider = 'tiktok' then interval '24 hours'
    when p_target_kind in ('ig_reel','fb_page_video','fb_reel') then interval '2 hours'
    else interval '60 minutes' end;
$$;

create or replace function atlas_private.marketing_delivery_complete(p_delivery_id uuid, p_claim_token uuid, p_outcome jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries := atlas_private.marketing_delivery_lock_claim(p_delivery_id, p_claim_token);
  v_outcome jsonb := coalesce(p_outcome, '{}'::jsonb);
  v_status text := v_outcome ->> 'status';
  v_class text := nullif(v_outcome #>> '{error,class}', '');
  v_code text := nullif(left(regexp_replace(coalesce(v_outcome #>> '{error,code}', ''), '[^A-Za-z0-9_.:-]', '_', 'g'), 80), '');
  v_message text := atlas_private.marketing_sanitize_text(v_outcome #>> '{error,message}', 240);
  v_retry_after integer;
  v_cooldown integer;
  v_attention text := nullif(v_outcome ->> 'attention_reason', '');
  v_next timestamptz;
  v_final text;
  v_post text;
  v_permalink text;
  v_published_at timestamptz;
  v_source text;
  v_started timestamptz;
  v_definitive boolean := coalesce(p_outcome -> 'definitive' = 'true'::jsonb, false);
  v_poll_after integer := case when (p_outcome ->> 'poll_after_s') ~ '^[0-9]{1,5}$'
                               then greatest(5, least((p_outcome ->> 'poll_after_s')::integer, 3600)) end;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'lease_lost', true); end if;
  if jsonb_typeof(v_outcome) <> 'object' or v_status is null
     or v_status not in ('published','processing','retrying','verifying','failed','needs_attention') then
    raise exception 'Outcome status is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_class is not null and v_class not in ('transient','rate_limited','auth','permanent','uncertain','stale','policy') then
    raise exception 'Error class is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_attention is not null and v_attention not in ('outcome_unknown','auth_expired','rate_limit_exhausted','max_attempts',
      'stale_schedule','provider_rejected','media_invalid','manual_hold','no_resource','provider_not_ready') then
    raise exception 'Attention reason is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  v_retry_after := case when (v_outcome ->> 'retry_after_s') ~ '^[0-9]{1,6}$' then least((v_outcome ->> 'retry_after_s')::integer, 86400) end;
  v_cooldown := case when (v_outcome ->> 'cooldown_s') ~ '^[0-9]{1,6}$' then least((v_outcome ->> 'cooldown_s')::integer, 86400) end;

  if v_class = 'rate_limited' or v_cooldown is not null then
    insert into atlas_private.marketing_provider_accounts (provider_key, external_account_id, cooldown_until)
    values (d.provider_key, d.external_account_id,
            pg_catalog.now() + make_interval(secs => greatest(coalesce(v_cooldown, 0), coalesce(v_retry_after, 0), 60)))
    on conflict (provider_key, external_account_id) do update
      set cooldown_until = greatest(coalesce(atlas_private.marketing_provider_accounts.cooldown_until, excluded.cooldown_until), excluded.cooldown_until);
  end if;

  if v_status = 'published' then
    v_post := nullif(pg_catalog.btrim(coalesce(v_outcome ->> 'post_id', '')), '');
    v_permalink := nullif(v_outcome ->> 'permalink', '');
    v_source := coalesce(nullif(v_outcome ->> 'source', ''), case when d.status = 'verifying' then 'verification' else 'provider' end);
    if v_post is null then
      raise exception 'A published outcome needs the provider post id' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if v_source not in ('provider','verification') then
      raise exception 'Published source is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    v_published_at := case when (v_outcome ->> 'published_at') is not null
      then least((v_outcome ->> 'published_at')::timestamptz, pg_catalog.now()) else pg_catalog.now() end;
    d := atlas_private.marketing_delivery_apply_ids(d.id, null, jsonb_strip_nulls(jsonb_build_object(
      'provider_post_id', v_post, 'provider_permalink', v_permalink) || coalesce(v_outcome -> 'ids', '{}'::jsonb)));
    update atlas_private.marketing_deliveries set status = 'published', published_at = v_published_at,
      published_source = v_source, attention_reason = null
    where id = d.id;
    v_final := 'published';
  elsif v_status = 'processing' then
    d := atlas_private.marketing_delivery_apply_ids(d.id, nullif(v_outcome ->> 'phase', ''), v_outcome -> 'ids');
    select min(started_at) into v_started from atlas_private.marketing_delivery_attempts where delivery_id = d.id;
    if pg_catalog.now() - coalesce(d.submit_started_at, v_started, d.due_at) > atlas_private.marketing_poll_budget(d.provider_key, d.target_kind) then
      update atlas_private.marketing_deliveries set status = 'needs_attention', attention_reason = 'outcome_unknown',
        last_error_class = 'uncertain', last_error_code = 'processing_timeout',
        last_error_message = 'The platform did not finish processing in time.'
      where id = d.id;
      v_final := 'needs_attention';
    else
      v_next := pg_catalog.now() + case when v_poll_after is not null then make_interval(secs => v_poll_after)
        else atlas_private.marketing_poll_delay(d.provider_key, d.target_kind, d.poll_count) end;
      update atlas_private.marketing_deliveries set
        status = case when status = 'verifying' then 'verifying' else 'processing' end,
        next_attempt_at = v_next
      where id = d.id;
      v_final := case when d.status = 'verifying' then 'verifying' else 'processing' end;
    end if;
  elsif v_status = 'retrying' and d.status = 'processing' then
    -- A poll that failed transiently: poll again later; polls never consume attempts.
    v_next := pg_catalog.now() + atlas_private.marketing_backoff(d.poll_count, 30, 900, v_retry_after);
    update atlas_private.marketing_deliveries set next_attempt_at = v_next, last_error_class = coalesce(v_class, 'transient'),
      last_error_code = v_code, last_error_message = v_message
    where id = d.id;
    v_final := 'processing';
  elsif v_status = 'retrying' and d.status = 'publishing' and d.phase in ('submitting','submitted','remote_processing') then
    if v_definitive and d.provider_post_id is null and d.provider_publish_id is null then
      -- The provider definitively rejected the call (report 07 §5.1): nothing was created, so the
      -- marker is cleared first and the ordinary retry below applies.
      update atlas_private.marketing_deliveries
      set phase = case when provider_container_id is not null then 'container_ready' else 'none' end
      where id = d.id
      returning * into d;
    else
      v_status := 'verifying';   -- after the submit marker nothing is retried blindly
    end if;
  elsif v_status = 'retrying' and d.status = 'verifying' and not v_definitive then
    v_status := 'verifying';     -- leaving verification needs proof of absence
  end if;

  if v_final is null and v_status = 'retrying' then
    if d.attempt_count >= d.max_attempts then
      update atlas_private.marketing_deliveries set status = 'needs_attention', attention_reason = 'max_attempts',
        last_error_class = coalesce(v_class, 'transient'), last_error_code = v_code, last_error_message = v_message
      where id = d.id;
      v_final := 'needs_attention';
    else
      v_next := pg_catalog.now() + atlas_private.marketing_backoff(greatest(d.attempt_count, 1), 60, 3600, v_retry_after);
      if v_next > d.latest_acceptable_at then
        update atlas_private.marketing_deliveries set status = 'needs_attention', attention_reason = 'stale_schedule',
          last_error_class = coalesce(v_class, 'transient'), last_error_code = v_code, last_error_message = v_message
        where id = d.id;
        v_final := 'needs_attention';
      else
        update atlas_private.marketing_deliveries set status = 'retrying', next_attempt_at = v_next,
          phase = case when phase in ('submitting','submitted','remote_processing')
                       then case when provider_container_id is not null then 'container_ready' else 'none' end
                       else phase end,
          last_error_class = coalesce(v_class, 'transient'), last_error_code = v_code, last_error_message = v_message
        where id = d.id;
        v_final := 'retrying';
      end if;
    end if;
  elsif v_final is null and v_status = 'verifying' then
    d := atlas_private.marketing_delivery_apply_ids(d.id, null, v_outcome -> 'ids');
    if d.status = 'verifying' and d.verify_attempts >= 3 then
      update atlas_private.marketing_deliveries set status = 'needs_attention', attention_reason = 'outcome_unknown',
        last_error_class = coalesce(v_class, 'uncertain'), last_error_code = coalesce(v_code, 'verify_exhausted'),
        last_error_message = coalesce(v_message, 'Atlas could not confirm whether the post exists.')
      where id = d.id;
      v_final := 'needs_attention';
    else
      v_next := pg_catalog.now() + make_interval(secs => greatest(coalesce(v_retry_after, 0),
        coalesce(v_poll_after, (array[60,120,300])[least(greatest(d.verify_attempts, 0) + 1, 3)])));
      update atlas_private.marketing_deliveries set status = 'verifying', next_attempt_at = v_next,
        last_error_class = coalesce(v_class, 'uncertain'), last_error_code = v_code, last_error_message = v_message
      where id = d.id;
      v_final := 'verifying';
    end if;
  elsif v_final is null and v_status = 'failed' and d.status in ('publishing','processing') then
    update atlas_private.marketing_deliveries set status = 'failed',
      attention_reason = coalesce(v_attention, case when v_class = 'permanent' then 'provider_rejected' end),
      last_error_class = coalesce(v_class, 'permanent'), last_error_code = v_code, last_error_message = v_message
    where id = d.id;
    v_final := 'failed';
  elsif v_final is null and v_status in ('failed','needs_attention') then
    update atlas_private.marketing_deliveries set status = 'needs_attention',
      attention_reason = coalesce(v_attention, case v_class
        when 'auth' then 'auth_expired' when 'rate_limited' then 'rate_limit_exhausted'
        when 'permanent' then 'provider_rejected' when 'stale' then 'stale_schedule'
        when 'policy' then 'manual_hold' else 'outcome_unknown' end),
      last_error_class = coalesce(v_class, 'uncertain'), last_error_code = v_code, last_error_message = v_message
    where id = d.id;
    v_final := 'needs_attention';
  end if;

  -- The browser sees fixed wording per class / attention reason / code; the provider's own
  -- (sanitised) text is kept only in the attempt ledger below.
  update atlas_private.marketing_deliveries set claim_token = null, claimed_by = null, claimed_until = null,
    last_error_message = case when last_error_class is null or status = 'published' then last_error_message
      else atlas_private.marketing_error_wording(last_error_class, attention_reason, last_error_code) end
  where id = d.id
  returning * into d;
  update atlas_private.marketing_delivery_attempts set finished_at = pg_catalog.now(), outcome = v_final,
    steps = steps || jsonb_build_array(atlas_private.marketing_sanitize_step(jsonb_strip_nulls(jsonb_build_object(
      'step', 'complete', 'outcome', v_final, 'code', v_code, 'message', v_message))))
  where claim_token = p_claim_token and finished_at is null;
  if v_final = 'published' then
    perform atlas_private.marketing_delivery_event(d.id, 'delivery_published',
      jsonb_build_object('source', d.published_source, 'permalink', d.provider_permalink));
  elsif v_final in ('needs_attention','failed') then
    perform atlas_private.marketing_delivery_notify(d.id);
  end if;
  perform atlas_private.marketing_content_refresh_publication(d.content_id);
  select * into d from atlas_private.marketing_deliveries where id = d.id;
  return jsonb_build_object('ok', true, 'status', d.status, 'next_attempt_at', d.next_attempt_at,
                            'attention_reason', d.attention_reason);
end;
$$;

-- Security P2-1: a provider refused the connection itself while publishing (outcome class auth:
-- expired/revoked token, lost permission). Fenced on the live claim: only the worker holding this
-- delivery may mark its connection. The connection becomes expired ("Needs reconnecting"), the
-- publishing permission is derived again and a sanitised publish_auth_failed event is recorded, so
-- the next deliveries stop at the gate instead of calling the provider with a dead token.
create or replace function atlas_private.marketing_delivery_mark_auth_failed(p_delivery_id uuid, p_claim_token uuid, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d atlas_private.marketing_deliveries := atlas_private.marketing_delivery_lock_claim(p_delivery_id, p_claim_token);
  v_error text := coalesce(atlas_private.marketing_sanitize_text(p_error, 240), 'The platform refused the connection.');
  v_updated integer;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'lease_lost', true); end if;
  update atlas_private.integration_connections c
  set status = 'expired', authorization_state = 'expired', last_connection_error = v_error, updated_at = pg_catalog.now()
  where c.provider_key = d.provider_key and c.status <> 'not_connected';
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    perform atlas_private.integration_derive_publishing(d.provider_key);
    insert into atlas_private.integration_events (provider_key, event_type, actor_id, actor_label, payload)
    values (d.provider_key, 'publish_auth_failed', null, 'Atlas publisher',
            jsonb_build_object('delivery_id', d.id, 'error', v_error));
  end if;
  update atlas_private.marketing_delivery_attempts
  set steps = steps || jsonb_build_array(atlas_private.marketing_sanitize_step(jsonb_build_object('step', 'auth_failed')))
  where claim_token = p_claim_token and finished_at is null;
  return jsonb_build_object('ok', true, 'provider_key', d.provider_key, 'connection_status',
    (select c.status from atlas_private.integration_connections c where c.provider_key = d.provider_key));
end;
$$;

-- Media that a delivery may already have put on a platform (published, or anything after the
-- submit marker, or still in flight) stays pinned even when its post is cancelled afterwards
-- (cancel after a partial publish): the payload snapshot names the asset and variant.
create or replace function atlas_private.marketing_delivery_media_pin(p_asset_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct d.content_id)::integer
  from atlas_private.marketing_deliveries d
  where (d.status in ('published','publishing','processing','verifying')
         or d.provider_post_id is not null or d.provider_publish_id is not null
         or d.phase in ('submitting','submitted','remote_processing'))
    and d.payload_snapshot -> 'media' @> jsonb_build_array(jsonb_build_object('asset_id', p_asset_id));
$$;

-- S94A's delete block, extended with the delivery pin above (same shape: reason published).
create or replace function atlas_private.marketing_media_delete_block(p_asset_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when exists (select 1 from atlas_private.marketing_media_publication_uses u
                 where u.asset_id = p_asset_id and u.outcome in ('published','processing'))
         or atlas_private.marketing_delivery_media_pin(p_asset_id) > 0
      then pg_catalog.jsonb_build_object('reason', 'published', 'count', greatest(
        (select count(distinct u.content_id) from atlas_private.marketing_media_publication_uses u
         where u.asset_id = p_asset_id and u.outcome in ('published','processing')),
        atlas_private.marketing_delivery_media_pin(p_asset_id)))
    when exists (select 1 from atlas_private.marketing_content_media m
                 join atlas_private.marketing_content_items c on c.id = m.content_id
                 where m.asset_id = p_asset_id and c.status = any(atlas_private.marketing_media_pinning_statuses()))
      then pg_catalog.jsonb_build_object('reason', 'in_use', 'count',
        (select count(distinct m.content_id) from atlas_private.marketing_content_media m
         join atlas_private.marketing_content_items c on c.id = m.content_id
         where m.asset_id = p_asset_id and c.status = any(atlas_private.marketing_media_pinning_statuses())))
    else null end;
$function$;
revoke all on function atlas_private.marketing_media_delete_block(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 9. Manager actions, publish now, cancel, reschedule, duplicate, history, partial update
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_content_json(p_content_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(content) - 'approved_fingerprint'
    || jsonb_build_object('publication_state', atlas_private.marketing_publication_state(content.id),
                          'has_approval_fingerprint', content.approved_fingerprint is not null)
  from atlas_private.marketing_content_items content
  where content.id = p_content_id;
$$;

create or replace function atlas_private.marketing_delivery_manager_action(
  p_actor_id uuid,
  p_delivery_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager']);
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  d atlas_private.marketing_deliveries;
  c atlas_private.marketing_content_items;
  v_confirmed boolean := coalesce((v_payload ->> 'confirmed_not_posted')::boolean, false);
  v_permalink text := nullif(pg_catalog.btrim(coalesce(v_payload ->> 'permalink', '')), '');
  v_post text := nullif(pg_catalog.btrim(coalesce(v_payload ->> 'post_id', '')), '');
  v_note text := atlas_private.marketing_sanitize_text(v_payload ->> 'note', 500);
  v_published_at timestamptz;
begin
  if p_action not in ('retry','mark_posted','cancel') then
    raise exception 'Unknown delivery action' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into d from atlas_private.marketing_deliveries where id = p_delivery_id for no key update;
  if not found then raise exception 'Delivery not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  select * into c from atlas_private.marketing_content_items where id = d.content_id;

  if p_action = 'retry' then
    if d.status not in ('failed','needs_attention') then
      raise exception 'Only a failed or blocked platform can be retried' using errcode = '55000', hint = 'atlas:conflict';
    end if;
    if d.provider_post_id is not null then
      raise exception 'The platform already reported this post. Mark it as posted instead.' using errcode = '55000', hint = 'atlas:conflict';
    end if;
    if d.phase in ('submitting','submitted','remote_processing') and not v_confirmed then
      raise exception 'Atlas may already have posted this. Check the platform and confirm it was not posted before retrying.'
        using errcode = '55000', hint = 'atlas:attestation_required';
    end if;
    if c.status not in ('approved','scheduled') or c.approval_id is distinct from d.approval_id
       or atlas_private.marketing_content_fingerprint(c.id) is distinct from d.approved_fingerprint then
      raise exception 'This post changed after approval. Approve it again before retrying.' using errcode = '55000', hint = 'atlas:superseded';
    end if;
    update atlas_private.marketing_deliveries set
      status = 'queued',
      phase = case when phase in ('submitting','submitted','remote_processing')
                   then case when provider_container_id is not null then 'container_ready' else 'none' end
                   else phase end,
      attempt_count = 0, poll_count = 0, verify_attempts = 0,
      next_attempt_at = pg_catalog.now(),
      latest_acceptable_at = greatest(latest_acceptable_at, pg_catalog.now() + interval '1 hour'),
      attention_reason = null, attention_notified_at = null, cancel_requested_at = null
    where id = d.id;
    perform atlas_private.marketing_delivery_event(d.id, 'delivery_requeued',
      jsonb_build_object('confirmed_not_posted', v_confirmed, 'note', v_note), v_actor);
  elsif p_action = 'mark_posted' then
    if not (d.status = 'needs_attention' or (d.status = 'verifying' and d.claim_token is null)) then
      raise exception 'Only a platform that needs attention can be marked as posted' using errcode = '55000', hint = 'atlas:conflict';
    end if;
    if v_permalink is null or (v_permalink !~ '^https://[^[:space:]]+$' or pg_catalog.char_length(v_permalink) > 2000) then
      raise exception 'Paste the https link to the post' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if v_post is not null and v_post !~ '^[A-Za-z0-9_:./~=+-]{1,200}$' then
      raise exception 'Post id is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    v_published_at := least(coalesce((v_payload ->> 'published_at')::timestamptz, pg_catalog.now()), pg_catalog.now());
    update atlas_private.marketing_deliveries set
      status = 'published', published_source = 'manual', published_at = v_published_at,
      provider_permalink = v_permalink, provider_post_id = coalesce(provider_post_id, v_post), attention_reason = null
    where id = d.id;
    perform atlas_private.marketing_delivery_event(d.id, 'delivery_marked_posted',
      jsonb_build_object('permalink', v_permalink, 'note', v_note), v_actor);
  else
    if d.status in ('published','cancelled') then
      raise exception 'This platform is already final' using errcode = '55000', hint = 'atlas:conflict';
    elsif d.status in ('publishing','processing','verifying') then
      update atlas_private.marketing_deliveries set cancel_requested_at = coalesce(cancel_requested_at, pg_catalog.now())
      where id = d.id;
    else
      update atlas_private.marketing_deliveries set status = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_reason = 'user'
      where id = d.id;
    end if;
    perform atlas_private.marketing_delivery_event(d.id, 'delivery_cancelled',
      jsonb_build_object('reason', 'user', 'note', v_note, 'in_flight', d.status in ('publishing','processing','verifying')), v_actor);
  end if;
  perform atlas_private.marketing_content_refresh_publication(d.content_id);
  select * into d from atlas_private.marketing_deliveries where id = d.id;
  select * into c from atlas_private.marketing_content_items where id = d.content_id;
  return jsonb_build_object('ok', true, 'action', p_action,
    'delivery', atlas_private.marketing_delivery_json(d) - 'progress',
    'content', jsonb_build_object('id', c.id, 'status', c.status, 'version', c.version,
                                  'publication_state', atlas_private.marketing_publication_state(c.id)));
end;
$$;

create or replace function atlas_private.marketing_publish_now(p_actor_id uuid, p_content_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager']);
  c atlas_private.marketing_content_items;
  a atlas_private.marketing_content_approvals;
  v_deliveries jsonb;
  v_updated integer;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id for no key update;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if not atlas_private.marketing_automatic_publishing_enabled() then
    raise exception 'Automatic publishing is off. An admin can turn it on in Settings > Marketing.'
      using errcode = '55000', hint = 'atlas:automatic_publishing_disabled';
  end if;
  if c.status not in ('approved','scheduled') or c.approval_id is null then
    raise exception 'Only approved posts can be published' using errcode = '55000', hint = 'atlas:not_approved';
  end if;
  select * into a from atlas_private.marketing_content_approvals where id = c.approval_id;
  if atlas_private.marketing_content_fingerprint(c.id) is distinct from a.approved_fingerprint then
    raise exception 'This post changed after approval. Approve it again.' using errcode = '55000', hint = 'atlas:superseded';
  end if;
  if not exists (select 1 from atlas_private.marketing_deliveries where content_id = c.id and approval_id = a.id) then
    perform atlas_private.marketing_deliveries_create_for_approval(c.id, a.id, pg_catalog.now(), 10);
  end if;
  -- Only the delivery rows change: scheduled_for (and so the approved fingerprint) stays as approved.
  update atlas_private.marketing_deliveries set
    due_at = pg_catalog.now(), next_attempt_at = pg_catalog.now(), priority = 10,
    latest_acceptable_at = pg_catalog.now() + interval '30 minutes'
  where content_id = c.id and approval_id = a.id and status in ('queued','retrying') and claim_token is null
    and (priority <> 10 or next_attempt_at > pg_catalog.now());
  get diagnostics v_updated = row_count;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'provider_key', provider_key, 'target_kind', target_kind,
                                               'status', status, 'due_at', due_at) order by provider_key), '[]'::jsonb)
  into v_deliveries
  from atlas_private.marketing_deliveries where content_id = c.id and status <> 'cancelled';
  insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
  values ('publish_now', c.campaign_id, c.id, p_actor_id, v_actor ->> 'label', v_actor ->> 'role',
          jsonb_build_object('approval_id', a.id, 'deliveries_made_due', v_updated));
  return jsonb_build_object('status', 'queued', 'content_id', c.id,
    'wake', exists (select 1 from atlas_private.marketing_deliveries where content_id = c.id and status in ('queued','retrying')
                    and next_attempt_at <= pg_catalog.now()),
    'deliveries', v_deliveries);
end;
$$;

create or replace function atlas_private.marketing_content_cancel(p_actor_id uuid, p_content_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager']);
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  v_note text := atlas_private.marketing_sanitize_text(p_reason, 500);
  v_cancelled integer;
  v_requested integer;
begin
  select * into previous_row from atlas_private.marketing_content_items where id = p_content_id for no key update;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if previous_row.status in ('published','completed','cancelled','rejected') then
    raise exception 'This content is already final' using errcode = '55000', hint = 'atlas:conflict';
  end if;
  update atlas_private.marketing_content_items set status = 'cancelled' where id = p_content_id returning * into content_row;
  select count(*) filter (where status = 'cancelled' and cancelled_at = pg_catalog.now()),
         count(*) filter (where status in ('publishing','processing','verifying') and cancel_requested_at is not null)
  into v_cancelled, v_requested
  from atlas_private.marketing_deliveries where content_id = p_content_id;
  perform atlas_private.marketing_record_revision(p_content_id, 'cancellation', to_jsonb(previous_row), to_jsonb(content_row),
    p_actor_id, v_actor ->> 'label', v_actor ->> 'role', v_note);
  insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
  values ('content_cancelled', content_row.campaign_id, content_row.id, p_actor_id, v_actor ->> 'label', v_actor ->> 'role',
          jsonb_build_object('previous_status', previous_row.status, 'reason', v_note,
                             'cancelled_deliveries', v_cancelled, 'cancel_requested', v_requested));
  return jsonb_build_object('content', atlas_private.marketing_content_json(p_content_id),
                            'cancelled_deliveries', v_cancelled, 'cancel_requested', v_requested);
end;
$$;

-- Partial patch: only keys present in p_patch change; explicit null clears a nullable field.
create or replace function atlas_private.marketing_update_content_patch(
  p_actor_id uuid,
  p_content_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager','bartender']);
  v_role text := v_actor ->> 'role';
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  v_platforms text[];
  v_options jsonb;
  v_note text := atlas_private.marketing_sanitize_text(p_note, 500);
  v_cancelled integer;
begin
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'Patch must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if exists (select 1 from jsonb_object_keys(v_patch) k where k not in (
      'campaign_id','title','priority','platforms','scheduled_for','reminder_at','event_starts_at','event_ends_at',
      'suggested_format','caption_draft','creative_brief','frames','media_requirements','owner_id','owner_label',
      'platform_options','publish_asap')) then
    raise exception 'Unknown content field' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into previous_row from atlas_private.marketing_content_items where id = p_content_id for no key update;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  -- The composer always sends the version it loaded; a caller without one gets no stale check.
  if p_expected_version is not null and previous_row.version <> p_expected_version then
    raise exception 'This post changed after you opened it. Refresh and try again.' using errcode = '40001', hint = 'atlas:stale_request';
  end if;
  if previous_row.status in ('published','completed','cancelled') then
    raise exception 'Published, completed or cancelled content cannot be edited' using errcode = '55000', hint = 'atlas:conflict';
  end if;
  if v_role not in ('admin','manager') and previous_row.created_by is distinct from p_actor_id
     and previous_row.owner_id is distinct from p_actor_id then
    raise exception 'Only the owner, creator or a manager can edit this content' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if v_role not in ('admin','manager') and v_patch ? 'platform_options' then
    raise exception 'Only managers can change publishing options' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if v_patch ? 'title' and nullif(pg_catalog.btrim(coalesce(v_patch ->> 'title', '')), '') is null then
    raise exception 'Content title is required' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_patch ? 'priority' and coalesce(v_patch ->> 'priority', '') not in ('low','normal','high','urgent') then
    raise exception 'Priority is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_patch ? 'platforms' then
    if jsonb_typeof(v_patch -> 'platforms') not in ('array','null') then
      raise exception 'Platforms must be a list' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    select coalesce(array_agg(distinct value order by value), '{}'::text[]) into v_platforms
    from jsonb_array_elements_text(coalesce(v_patch -> 'platforms', '[]'::jsonb)) value;
    if not v_platforms <@ array['instagram','facebook','tiktok','google-business-profile']::text[] then
      raise exception 'Unknown platform' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  else
    v_platforms := previous_row.platforms;
  end if;
  if v_patch ? 'frames' and jsonb_typeof(v_patch -> 'frames') <> 'array' then
    raise exception 'Frames must be a list' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_patch ? 'media_requirements' and jsonb_typeof(v_patch -> 'media_requirements') <> 'object' then
    raise exception 'Media requirements must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_patch ? 'publish_asap' and jsonb_typeof(v_patch -> 'publish_asap') <> 'boolean' then
    raise exception 'publish_asap must be true or false' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  v_options := case when v_patch ? 'platform_options'
    then atlas_private.marketing_validate_platform_options(coalesce(nullif(v_patch -> 'platform_options', 'null'::jsonb), '{}'::jsonb), v_platforms)
    else previous_row.platform_options end;

  update atlas_private.marketing_content_items set
    campaign_id = case when v_patch ? 'campaign_id' then (v_patch ->> 'campaign_id')::uuid else campaign_id end,
    title = case when v_patch ? 'title' then pg_catalog.btrim(v_patch ->> 'title') else title end,
    priority = case when v_patch ? 'priority' then v_patch ->> 'priority' else priority end,
    platforms = v_platforms,
    scheduled_for = case when v_patch ? 'scheduled_for' then (v_patch ->> 'scheduled_for')::timestamptz else scheduled_for end,
    reminder_at = case when v_patch ? 'reminder_at' then (v_patch ->> 'reminder_at')::timestamptz else reminder_at end,
    event_starts_at = case when v_patch ? 'event_starts_at' then (v_patch ->> 'event_starts_at')::timestamptz else event_starts_at end,
    event_ends_at = case when v_patch ? 'event_ends_at' then (v_patch ->> 'event_ends_at')::timestamptz else event_ends_at end,
    suggested_format = case when v_patch ? 'suggested_format' then nullif(pg_catalog.btrim(coalesce(v_patch ->> 'suggested_format', '')), '') else suggested_format end,
    caption_draft = case when v_patch ? 'caption_draft' then nullif(pg_catalog.btrim(coalesce(v_patch ->> 'caption_draft', '')), '') else caption_draft end,
    creative_brief = case when v_patch ? 'creative_brief' then nullif(pg_catalog.btrim(coalesce(v_patch ->> 'creative_brief', '')), '') else creative_brief end,
    frames = case when v_patch ? 'frames' then v_patch -> 'frames' else frames end,
    media_requirements = case when v_patch ? 'media_requirements' then v_patch -> 'media_requirements' else media_requirements end,
    owner_id = case when v_patch ? 'owner_id' then (v_patch ->> 'owner_id')::uuid else owner_id end,
    owner_label = case when v_patch ? 'owner_label' then nullif(pg_catalog.btrim(coalesce(v_patch ->> 'owner_label', '')), '') else owner_label end,
    platform_options = v_options,
    metadata = case when not (v_patch ? 'publish_asap') then metadata
                    when v_patch -> 'publish_asap' = 'true'::jsonb then metadata || '{"publish_asap": true}'::jsonb
                    else metadata - 'publish_asap' end,
    status = case when status = 'changes_requested' then 'draft' else status end
  where id = p_content_id
  returning * into content_row;
  if content_row.event_ends_at is not null and content_row.event_starts_at is not null
     and content_row.event_ends_at < content_row.event_starts_at then
    raise exception 'Event end cannot precede event start' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select count(*) into v_cancelled from atlas_private.marketing_deliveries
  where content_id = p_content_id and status = 'cancelled' and cancelled_at = pg_catalog.now() and cancelled_reason = 'superseded_by_edit';
  perform atlas_private.marketing_record_revision(content_row.id, 'edit', to_jsonb(previous_row), to_jsonb(content_row),
    p_actor_id, v_actor ->> 'label', v_role, v_note);
  insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
  values ('content_updated', content_row.campaign_id, content_row.id, p_actor_id, v_actor ->> 'label', v_role,
          jsonb_build_object('title', content_row.title, 'status', content_row.status, 'note', v_note,
                             'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_patch) k),
                             'approval_invalidated', previous_row.status in ('approved','scheduled') and content_row.status = 'draft'));
  return jsonb_build_object('content', atlas_private.marketing_content_json(content_row.id),
    'approval_invalidated', previous_row.status in ('approved','scheduled') and content_row.status = 'draft',
    'cancelled_deliveries', v_cancelled);
end;
$$;

create or replace function atlas_private.marketing_content_reschedule(
  p_actor_id uuid,
  p_content_id uuid,
  p_expected_version integer,
  p_scheduled_for timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager']);
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  v_cancelled integer;
begin
  if p_scheduled_for is null then
    raise exception 'Choose a new time' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if p_scheduled_for < pg_catalog.now() - interval '1 minute' then
    raise exception 'The new time is in the past' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into previous_row from atlas_private.marketing_content_items where id = p_content_id for no key update;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if p_expected_version is null or previous_row.version <> p_expected_version then
    raise exception 'This post changed after you opened it. Refresh and try again.' using errcode = '40001', hint = 'atlas:stale_request';
  end if;
  if previous_row.status in ('published','completed','cancelled','rejected') then
    raise exception 'Only unpublished content can be rescheduled' using errcode = '55000', hint = 'atlas:conflict';
  end if;
  if exists (select 1 from atlas_private.marketing_deliveries where content_id = p_content_id and status = 'published') then
    raise exception 'Part of this post is already published and cannot be moved' using errcode = '55000', hint = 'atlas:conflict';
  end if;
  update atlas_private.marketing_content_items set scheduled_for = p_scheduled_for where id = p_content_id returning * into content_row;
  select count(*) into v_cancelled from atlas_private.marketing_deliveries
  where content_id = p_content_id and status = 'cancelled' and cancelled_at = pg_catalog.now() and cancelled_reason = 'superseded_by_edit';
  perform atlas_private.marketing_record_revision(content_row.id, 'edit', to_jsonb(previous_row), to_jsonb(content_row),
    p_actor_id, v_actor ->> 'label', v_actor ->> 'role', 'Rescheduled');
  insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
  values ('content_rescheduled', content_row.campaign_id, content_row.id, p_actor_id, v_actor ->> 'label', v_actor ->> 'role',
          jsonb_build_object('from', previous_row.scheduled_for, 'to', content_row.scheduled_for,
                             'approval_invalidated', previous_row.status in ('approved','scheduled')));
  return jsonb_build_object('content', atlas_private.marketing_content_json(content_row.id),
    'approval_invalidated', previous_row.status in ('approved','scheduled'),
    'cancelled_deliveries', v_cancelled);
end;
$$;

create or replace function atlas_private.marketing_content_duplicate(p_actor_id uuid, p_content_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager']);
  source_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  v_options jsonb;
begin
  select * into source_row from atlas_private.marketing_content_items where id = p_content_id;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  -- TikTok consent is per post and must be given again.
  v_options := source_row.platform_options;
  if v_options ? 'tiktok' and v_options -> 'tiktok' ? 'tiktok' then
    v_options := jsonb_set(v_options, '{tiktok,tiktok}', (v_options #> '{tiktok,tiktok}') - 'consent_confirmed_at' - 'consent_by');
  end if;
  insert into atlas_private.marketing_content_items (
    client_request_id, campaign_id, title, content_type, status, priority, platforms, suggested_format, caption_draft,
    creative_brief, frames, media_requirements, owner_id, owner_label, created_by, created_by_label, created_by_role,
    metadata, platform_options
  ) values (
    gen_random_uuid(), source_row.campaign_id, left('Copy of ' || source_row.title, 180), source_row.content_type,
    case when source_row.content_type = 'content_idea' then 'idea' else 'draft' end,
    source_row.priority, source_row.platforms, source_row.suggested_format, source_row.caption_draft,
    source_row.creative_brief, source_row.frames, source_row.media_requirements, p_actor_id, v_actor ->> 'label',
    p_actor_id, v_actor ->> 'label', v_actor ->> 'role',
    jsonb_build_object('duplicated_from', source_row.id), v_options
  ) returning * into content_row;
  insert into atlas_private.marketing_content_media (content_id, asset_id, variant_id, collection_id, platform, position, role, alt_text, added_by, added_by_label)
  select content_row.id, cm.asset_id, cm.variant_id, cm.collection_id, cm.platform, cm.position, cm.role, cm.alt_text, p_actor_id, v_actor ->> 'label'
  from atlas_private.marketing_content_media cm
  where cm.content_id = source_row.id
  order by cm.platform nulls first, cm.position;
  perform atlas_private.marketing_record_revision(content_row.id, 'create', null, to_jsonb(content_row),
    p_actor_id, v_actor ->> 'label', v_actor ->> 'role', 'Duplicated');
  insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
  values ('content_duplicated', content_row.campaign_id, content_row.id, p_actor_id, v_actor ->> 'label', v_actor ->> 'role',
          jsonb_build_object('source_content_id', source_row.id, 'title', content_row.title));
  return jsonb_build_object('content', atlas_private.marketing_content_json(content_row.id), 'source_content_id', source_row.id);
end;
$$;

create or replace function atlas_private.marketing_publication_history(p_actor_id uuid, p_content_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := atlas_private.marketing_actor(p_actor_id, array['admin','manager']);
  c atlas_private.marketing_content_items;
begin
  select * into c from atlas_private.marketing_content_items where id = p_content_id;
  if not found then raise exception 'Marketing content not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  return jsonb_build_object(
    'content', jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status, 'version', c.version,
      'scheduled_for', c.scheduled_for, 'publication_state', atlas_private.marketing_publication_state(c.id)),
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'provider_key', d.provider_key, 'target_kind', d.target_kind,
        'external_account_id', d.external_account_id, 'status', d.status, 'phase', d.phase,
        'due_at', d.due_at, 'next_attempt_at', d.next_attempt_at, 'published_at', d.published_at,
        'published_source', d.published_source, 'provider_post_id', d.provider_post_id,
        'provider_permalink', d.provider_permalink, 'attempt_count', d.attempt_count,
        'max_attempts', d.max_attempts, 'last_error_class', d.last_error_class,
        'last_error_code', d.last_error_code, 'last_error_message', d.last_error_message,
        'attention_reason', d.attention_reason, 'cancelled_reason', d.cancelled_reason,
        'cancel_requested_at', d.cancel_requested_at, 'created_at', d.created_at, 'updated_at', d.updated_at,
        'can_retry', d.status in ('failed','needs_attention') and d.provider_post_id is null,
        'retry_needs_confirmation', d.phase in ('submitting','submitted','remote_processing'),
        'attempts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'attempt_no', att.attempt_no, 'claim_kind', att.claim_kind, 'claimed_by', att.claimed_by,
            'started_at', att.started_at, 'finished_at', att.finished_at, 'outcome', att.outcome,
            'steps', att.steps) order by att.attempt_no)
          from atlas_private.marketing_delivery_attempts att where att.delivery_id = d.id), '[]'::jsonb)
      ) order by d.provider_key, d.created_at)
      from atlas_private.marketing_deliveries d where d.content_id = c.id), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object('id', approval.id, 'decision', approval.decision,
        'actor_label', approval.actor_label, 'actor_role', approval.actor_role, 'note', approval.note,
        'created_at', approval.created_at, 'current', approval.id = c.approval_id) order by approval.created_at, approval.id)
      from atlas_private.marketing_content_approvals approval where approval.content_id = c.id), '[]'::jsonb),
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object('revision_number', revision.revision_number, 'change_type', revision.change_type,
        'changed_by_label', revision.changed_by_label, 'changed_by_role', revision.changed_by_role,
        'note', revision.note, 'created_at', revision.created_at) order by revision.revision_number)
      from atlas_private.marketing_content_revisions revision where revision.content_id = c.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', event.id, 'event_type', event.event_type,
        'actor_label', event.actor_label, 'actor_role', event.actor_role, 'payload', event.payload,
        'created_at', event.created_at) order by event.created_at, event.id)
      from atlas_private.marketing_workspace_events event where event.content_id = c.id), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 10. Existing workflow: approval creates deliveries; create returns the id; venue time
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_decide_approval(
  p_content_id uuid,
  p_decision text,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  approval_row atlas_private.marketing_content_approvals;
  next_status text;
  v_targets jsonb;
  v_fingerprint bytea;
  v_deliveries jsonb := '[]'::jsonb;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve marketing content'; end if;
  if p_decision not in ('approved','changes_requested','rejected') then raise exception 'Approval decision is invalid'; end if;
  if p_decision<>'approved' and nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'A note is required for changes or rejection'; end if;

  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for no key update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status<>'pending_approval' then raise exception 'Content is not awaiting approval'; end if;

  next_status := case
    when p_decision='approved' and previous_row.scheduled_for is not null then 'scheduled'
    when p_decision='approved' then 'approved'
    when p_decision='changes_requested' then 'changes_requested'
    else 'rejected'
  end;

  if p_decision='approved' then
    v_targets := atlas_private.marketing_publish_targets();
    v_fingerprint := atlas_private.marketing_content_fingerprint(p_content_id, v_targets);
  end if;

  insert into atlas_private.marketing_content_approvals (content_id,decision,actor_id,actor_label,actor_role,note,approved_fingerprint,approved_scheduled_for)
  values (p_content_id,p_decision,p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),''),
          v_fingerprint,case when p_decision='approved' then previous_row.scheduled_for end)
  returning * into approval_row;
  update atlas_private.marketing_content_items
  set status=next_status,
      approved_fingerprint=case when p_decision='approved' then v_fingerprint end,
      approval_id=case when p_decision='approved' then approval_row.id end
  where id=p_content_id returning * into content_row;

  if p_decision='approved' then
    v_deliveries := atlas_private.marketing_deliveries_create_for_approval(p_content_id, approval_row.id, null, 100);
  end if;

  perform atlas_private.marketing_record_revision(
    p_content_id,'approval',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'approval_decided',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('decision',p_decision,'approval_id',approval_row.id,'note',p_note,'deliveries',jsonb_array_length(v_deliveries))
  );
  select * into content_row from atlas_private.marketing_content_items where id=p_content_id;
  return jsonb_build_object('content',to_jsonb(content_row) - 'approved_fingerprint',
                            'approval',to_jsonb(approval_row) - 'approved_fingerprint',
                            'deliveries',v_deliveries);
end;
$$;

-- create-content: the created id is returned at the top level (fixes create + submit in the UI).
create or replace function public.atlas_marketing_create_content(
  p_client_request_id uuid,p_campaign_id uuid,p_title text,p_content_type text,p_priority text,p_platforms text[],p_scheduled_for timestamptz,p_reminder_at timestamptz,
  p_event_starts_at timestamptz,p_event_ends_at timestamptz,p_suggested_format text,p_caption_draft text,p_creative_brief text,p_frames jsonb,p_media_requirements jsonb,
  p_owner_id uuid,p_owner_label text,p_actor_id uuid,p_actor_label text,p_actor_role text,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$
  select result || jsonb_build_object('id', result #> '{content,id}', 'content_id', result #> '{content,id}')
  from (select atlas_private.marketing_create_content(p_client_request_id,p_campaign_id,p_title,p_content_type,p_priority,p_platforms,
    p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,p_suggested_format,p_caption_draft,p_creative_brief,p_frames,
    p_media_requirements,p_owner_id,p_owner_label,p_actor_id,p_actor_label,p_actor_role,p_metadata) as result) created;
$$;

create or replace function public.atlas_marketing_convert_recommendation_occurrence(
  p_recommendation_id uuid,p_occurrence_date date,p_client_request_id uuid,p_scheduled_for timestamptz,p_reminder_at timestamptz,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$
  select result || jsonb_build_object('id', result #> '{content,id}', 'content_id', result #> '{content,id}')
  from (select atlas_private.marketing_convert_recommendation_occurrence(p_recommendation_id,p_occurrence_date,p_client_request_id,
    p_scheduled_for,p_reminder_at,p_actor_id,p_actor_label,p_actor_role) as result) converted;
$$;

-- Venue time: the occurrence functions use atlas_private.venue_date() instead of a hard-coded zone.
do $venue_time$
declare
  v_function regprocedure;
  v_definition text;
begin
  foreach v_function in array array[
    'atlas_private.marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text)'::regprocedure,
    'atlas_private.marketing_dismiss_recommendation_occurrence(uuid,date,text,uuid,text,text)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_function);
    if v_definition like '%Atlantic/Reykjavik%' then
      v_definition := replace(v_definition,
        '(pg_catalog.now() at time zone ''Atlantic/Reykjavik'')::date',
        'atlas_private.venue_date(pg_catalog.now())');
      execute v_definition;
    end if;
  end loop;
end;
$venue_time$;

-- ---------------------------------------------------------------------------------------------
-- 11. Snapshot (same signature) with venue time, media, deliveries and publishing state
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_workspace_snapshot(
  p_user_id uuid,
  p_user_role text,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
#variable_conflict use_variable
declare
  local_date date := atlas_private.venue_date(pg_catalog.now());
  start_date date := coalesce(p_start_date,date_trunc('month',local_date)::date);
  end_date date := coalesce(p_end_date,(date_trunc('month',local_date)+interval '1 month - 1 day')::date);
  automatic_enabled boolean := atlas_private.marketing_automatic_publishing_enabled();
  targets_json jsonb := atlas_private.marketing_publish_targets();
  content_json jsonb := '[]'::jsonb;
  recommendations_json jsonb := '[]'::jsonb;
  campaigns_json jsonb := '[]'::jsonb;
  connections_json jsonb := '[]'::jsonb;
  history_json jsonb := '[]'::jsonb;
  reminders_json jsonb := '[]'::jsonb;
  stats_json jsonb := '{}'::jsonb;
  attention_json jsonb := '{}'::jsonb;
begin
  if start_date>end_date or end_date-start_date>92 then
    raise exception 'Marketing calendar range must be between 1 and 93 days';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',campaign.id,
    'name',campaign.name,
    'description',campaign.description,
    'campaign_type',campaign.campaign_type,
    'status',campaign.status,
    'objective',campaign.objective,
    'target_audience',campaign.target_audience,
    'platforms',campaign.platforms,
    'start_date',campaign.start_date,
    'end_date',campaign.end_date,
    'created_by_label',campaign.created_by_label,
    'created_at',campaign.created_at,
    'updated_at',campaign.updated_at
  ) order by campaign.start_date nulls last,campaign.name),'[]'::jsonb)
  into campaigns_json
  from atlas_private.marketing_campaigns campaign
  where campaign.status<>'cancelled';

  select coalesce(jsonb_agg(row_data.item order by row_data.sort_time,row_data.title),'[]'::jsonb)
  into content_json
  from (
    select
      coalesce(content.scheduled_for,content.reminder_at,content.created_at) as sort_time,
      content.title,
      jsonb_build_object(
        'id',content.id,
        'campaign_id',content.campaign_id,
        'campaign_name',campaign.name,
        'title',content.title,
        'content_type',content.content_type,
        'status',content.status,
        'version',content.version,
        'priority',content.priority,
        'platforms',content.platforms,
        'platform_options',content.platform_options,
        'scheduled_for',content.scheduled_for,
        'reminder_at',content.reminder_at,
        'event_starts_at',content.event_starts_at,
        'event_ends_at',content.event_ends_at,
        'suggested_format',content.suggested_format,
        'caption_draft',content.caption_draft,
        'creative_brief',content.creative_brief,
        'frames',content.frames,
        'media_requirements',content.media_requirements,
        'owner_id',content.owner_id,
        'owner_label',content.owner_label,
        'created_by',content.created_by,
        'created_by_label',content.created_by_label,
        'created_by_role',content.created_by_role,
        'published_at',content.published_at,
        'completed_at',content.completed_at,
        'external_publication_ids',content.external_publication_ids,
        'metadata',content.metadata,
        'created_at',content.created_at,
        'updated_at',content.updated_at,
        'approval_id',content.approval_id,
        'media',(
          select coalesce(jsonb_agg(jsonb_build_object(
            'attachment_id',item->'attachment_id','asset_id',item->'asset_id','variant_id',item->'variant_id',
            'publish_variant_id',item->'publish_variant_id','collection_id',item->'collection_id',
            'kind',item->'kind','mime_type',item->'mime_type','width',item->'width','height',item->'height',
            'duration_ms',item->'duration_ms','byte_size',item->'byte_size','position',item->'position',
            'role',item->'role','platform',item->'platform','alt_text',item->'alt_text',
            'thumb_storage_path',item->'thumb_storage_path'
          ) order by ordinality),'[]'::jsonb)
          from jsonb_array_elements(atlas_private.marketing_content_media_list(content.id,null)) with ordinality as media(item,ordinality)
        ),
        'deliveries',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',delivery.id,
            'provider_key',delivery.provider_key,
            'target_kind',delivery.target_kind,
            'status',delivery.status,
            'due_at',delivery.due_at,
            'published_at',delivery.published_at,
            'provider_permalink',delivery.provider_permalink,
            'attention_reason',delivery.attention_reason,
            'next_attempt_at',delivery.next_attempt_at,
            'last_error_message',delivery.last_error_message,
            'cancel_requested',delivery.cancel_requested_at is not null
          ) order by delivery.provider_key,delivery.created_at)
          from atlas_private.marketing_deliveries delivery
          where delivery.content_id=content.id and delivery.status<>'cancelled'
        ),'[]'::jsonb),
        'publication_state',atlas_private.marketing_publication_state(content.id),
        'can_edit',(
          content.status not in ('published','completed','cancelled')
          and (p_user_role in ('admin','manager') or content.created_by=p_user_id or content.owner_id=p_user_id)
        ),
        'can_approve',(p_user_role in ('admin','manager') and content.status='pending_approval'),
        'can_publish_now',(p_user_role in ('admin','manager') and automatic_enabled and content.status in ('approved','scheduled')),
        'approval_history',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',approval.id,
            'decision',approval.decision,
            'actor_label',approval.actor_label,
            'actor_role',approval.actor_role,
            'note',approval.note,
            'created_at',approval.created_at
          ) order by approval.created_at)
          from atlas_private.marketing_content_approvals approval
          where approval.content_id=content.id
        ),'[]'::jsonb)
      ) as item
    from atlas_private.marketing_content_items content
    left join atlas_private.marketing_campaigns campaign on campaign.id=content.campaign_id
    where (
      (content.scheduled_for is not null and atlas_private.venue_date(content.scheduled_for) between start_date and end_date)
      or (content.reminder_at is not null and atlas_private.venue_date(content.reminder_at) between start_date and end_date)
      or (content.event_starts_at is not null and atlas_private.venue_date(content.event_starts_at) between start_date and end_date)
      or (content.scheduled_for is null and content.status in ('idea','draft','pending_approval','changes_requested','approved'))
      or exists (select 1 from atlas_private.marketing_deliveries delivery
                 where delivery.content_id=content.id and delivery.status in ('needs_attention','failed','verifying','publishing','processing'))
    )
  ) row_data;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',recommendation.id,
    'recommendation_key',recommendation.recommendation_key,
    'title',recommendation.title,
    'summary',recommendation.summary,
    'content_type',recommendation.content_type,
    'platforms',recommendation.platforms,
    'recurrence',recommendation.recurrence,
    'day_of_week',recommendation.day_of_week,
    'suggested_time',recommendation.suggested_time,
    'suggested_format',recommendation.suggested_format,
    'caption_draft',recommendation.caption_draft,
    'creative_brief',recommendation.creative_brief,
    'frames',recommendation.frames,
    'reason',recommendation.reason,
    'evidence',recommendation.evidence,
    'confidence_score',recommendation.confidence_score,
    'status',recommendation.status,
    'is_due_today',case
      when recommendation.recurrence='daily' then true
      when recommendation.recurrence='weekly' then recommendation.day_of_week=extract(dow from local_date)::smallint
      when recommendation.recurrence='one_off' then recommendation.active_from=local_date
      else false
    end,
    'metadata',recommendation.metadata
  ) order by
    case
      when recommendation.recurrence='daily' then 0
      when recommendation.recurrence='weekly' and recommendation.day_of_week=extract(dow from local_date)::smallint then 0
      else 1
    end,
    recommendation.suggested_time nulls last,
    recommendation.title),'[]'::jsonb)
  into recommendations_json
  from atlas_private.marketing_recommendations recommendation
  where recommendation.status='active'
    and (recommendation.active_from is null or recommendation.active_from<=local_date)
    and (recommendation.active_to is null or recommendation.active_to>=local_date);

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',connection.provider_key,
    'label',connection.label,
    'category',connection.category,
    'display_status',atlas_private.marketing_connection_display_status(
      connection.authorization_state,
      connection.publishing_permission_state,
      connection.analytics_permission_state,
      connection.token_expires_at
    ),
    'authorization_state',connection.authorization_state,
    'publishing_permission_state',connection.publishing_permission_state,
    'analytics_permission_state',connection.analytics_permission_state,
    'external_account_label',connection.external_account_label,
    'last_verified_at',connection.last_verified_at,
    'token_expires_at',connection.token_expires_at,
    'last_connection_error',connection.last_connection_error,
    'capabilities',connection.capabilities,
    'requirements',connection.requirements,
    'metadata',connection.metadata
  ) order by connection.label),'[]'::jsonb)
  into connections_json
  from atlas_private.integration_connections connection
  where connection.provider_key in ('instagram','facebook','tiktok','google-business-profile');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',content.id,
    'title',content.title,
    'content_type',content.content_type,
    'status',content.status,
    'reminder_at',content.reminder_at,
    'scheduled_for',content.scheduled_for,
    'platforms',content.platforms,
    'priority',content.priority
  ) order by content.reminder_at nulls last,content.scheduled_for nulls last),'[]'::jsonb)
  into reminders_json
  from atlas_private.marketing_content_items content
  where content.status not in ('published','completed','rejected','cancelled')
    and content.reminder_at is not null
    and content.reminder_at <= pg_catalog.now()+interval '14 days';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',event.id,
    'event_type',event.event_type,
    'campaign_id',event.campaign_id,
    'content_id',event.content_id,
    'recommendation_id',event.recommendation_id,
    'actor_label',event.actor_label,
    'actor_role',event.actor_role,
    'payload',event.payload,
    'created_at',event.created_at
  ) order by event.created_at desc),'[]'::jsonb)
  into history_json
  from (
    select * from atlas_private.marketing_workspace_events
    order by created_at desc
    limit 40
  ) event;

  select jsonb_build_object(
    'total_items',count(*)::bigint,
    'ideas',count(*) filter (where status='idea')::bigint,
    'drafts',count(*) filter (where status in ('draft','changes_requested'))::bigint,
    'awaiting_approval',count(*) filter (where status='pending_approval')::bigint,
    'approved',count(*) filter (where status in ('approved','scheduled'))::bigint,
    'published',count(*) filter (where status='published')::bigint,
    'completed',count(*) filter (where status='completed')::bigint,
    'overdue_reminders',count(*) filter (
      where reminder_at is not null
        and reminder_at<pg_catalog.now()
        and status not in ('published','completed','rejected','cancelled')
    )::bigint
  ) into stats_json
  from atlas_private.marketing_content_items;

  select jsonb_build_object(
    'needs_attention',count(*) filter (where delivery.status='needs_attention')::bigint,
    'failed',count(*) filter (where delivery.status='failed')::bigint,
    'verifying',count(*) filter (where delivery.status='verifying')::bigint,
    'total',count(*) filter (where delivery.status in ('needs_attention','failed'))::bigint,
    'blocked_next_30_days',(
      select count(*) from atlas_private.marketing_content_items upcoming
      where upcoming.status in ('approved','scheduled')
        and upcoming.scheduled_for between pg_catalog.now() and pg_catalog.now()+interval '30 days'
        and exists (
          select 1 from unnest(upcoming.platforms) platform
          where coalesce((atlas_private.marketing_target_for(targets_json,platform)->>'ready')::boolean,false) is not true
        )
    )::bigint
  ) into attention_json
  from atlas_private.marketing_deliveries delivery;

  return jsonb_build_object(
    'version','atlas-marketing-workspace/0.2.0',
    'generated_at',pg_catalog.now(),
    'venue_date',local_date,
    'venue_timezone',atlas_private.venue_timezone(),
    'range',jsonb_build_object('start_date',start_date,'end_date',end_date),
    'stats',stats_json,
    'attention',attention_json,
    'automatic_publishing_enabled',automatic_enabled,
    'publish_targets',targets_json,
    'campaigns',campaigns_json,
    'content_items',content_json,
    'recommendations',recommendations_json,
    'reminders',reminders_json,
    'connections',connections_json,
    'history',history_json,
    'permissions',jsonb_build_object(
      'can_create',p_user_role in ('admin','manager','bartender'),
      'can_approve',p_user_role in ('admin','manager'),
      'can_mark_published',p_user_role in ('admin','manager'),
      'can_manage_connections',p_user_role in ('admin','manager'),
      'can_publish',p_user_role in ('admin','manager'),
      'can_manage_automatic_publishing',p_user_role='admin'
    ),
    'trust',jsonb_build_object(
      'actual_publishing_enabled',automatic_enabled,
      'analytics_ingestion_enabled',false,
      'oauth_tokens_in_browser',false,
      'recommendations_shadow_only',true,
      'manager_approval_required',true,
      'history_preserved',true
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 12. Settings: automatic publishing is an admin-only switch (default false)
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.settings_save_section(
  p_section_key text,
  p_value jsonb,
  p_expected_version integer,
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
  section_row atlas_private.settings_sections;
  safe_value jsonb := coalesce(p_value,'{}'::jsonb);
  stored_publishing jsonb;
begin
  perform atlas_private.settings_assert_actor(p_actor_role,true,p_section_key='security');
  perform atlas_private.settings_assert_safe_json(safe_value);
  if p_section_key not in ('venue','operations','inventory','temperature','cleaning','marketing','brain','security','appearance','modules') then
    raise exception 'Unknown Settings section';
  end if;

  if p_section_key='venue' then
    safe_value := jsonb_set(safe_value,'{currency}','"ISK"'::jsonb,true);
  elsif p_section_key='operations' then
    safe_value := jsonb_set(safe_value,'{production_shift_sync_enabled}','false'::jsonb,true);
  elsif p_section_key='inventory' then
    safe_value := jsonb_set(jsonb_set(safe_value,'{automatic_reorder_execution}','false'::jsonb,true),'{live_quantity_apply}','false'::jsonb,true);
  elsif p_section_key='marketing' then
    -- S94: automatic publishing is an admin-only switch (default false); only a boolean true turns it
    -- on. A manager's save keeps whatever an admin stored. Analytics ingestion stays off.
    select case when section.settings_value->'automatic_publishing_enabled'='true'::jsonb then 'true'::jsonb else 'false'::jsonb end
    into stored_publishing
    from atlas_private.settings_sections section where section.section_key='marketing';
    safe_value := jsonb_set(jsonb_set(safe_value,'{automatic_publishing_enabled}',
      case when p_actor_role='admin'
           then case when safe_value->'automatic_publishing_enabled'='true'::jsonb then 'true'::jsonb
                     when safe_value ? 'automatic_publishing_enabled' then 'false'::jsonb
                     else coalesce(stored_publishing,'false'::jsonb) end
           else coalesce(stored_publishing,'false'::jsonb) end,true),
      '{analytics_ingestion_enabled}','false'::jsonb,true);
  elsif p_section_key='brain' then
    safe_value := jsonb_set(safe_value,'{automatic_execution_enabled}','false'::jsonb,true);
  elsif p_section_key='security' then
    safe_value := jsonb_set(jsonb_set(jsonb_set(safe_value,'{api_keys_visible}','false'::jsonb,true),'{production_sync_enabled}','false'::jsonb,true),'{destructive_actions_enabled}','false'::jsonb,true);
  elsif p_section_key='modules' then
    safe_value := jsonb_set(jsonb_set(jsonb_set(safe_value,'{production_sync_enabled}','false'::jsonb,true),'{system}','true'::jsonb,true),'{settings}','true'::jsonb,true);
  end if;

  select * into section_row
  from atlas_private.settings_sections
  where section_key=p_section_key
  for update;
  if not found then raise exception 'Settings section not found'; end if;
  if p_expected_version is null or p_expected_version <> section_row.version then
    raise exception 'Settings changed after this page was opened';
  end if;

  update atlas_private.settings_sections
  set settings_value=safe_value,version=version+1,
      updated_by=p_actor_id,updated_by_label=nullif(trim(coalesce(p_actor_label,'')),''),
      updated_at=now()
  where section_key=p_section_key
  returning * into section_row;

  insert into atlas_private.settings_events(event_type,entity_type,entity_key,actor_id,actor_label,actor_role,payload)
  values ('section_saved','section',p_section_key,p_actor_id,p_actor_label,p_actor_role,
          jsonb_build_object('version',section_row.version));

  return jsonb_build_object(
    'section_key',section_row.section_key,'label',section_row.label,
    'description',section_row.description,'status',section_row.status,
    'value',section_row.settings_value,'version',section_row.version,
    'updated_at',section_row.updated_at,'updated_by_label',section_row.updated_by_label
  );
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 13. Notifications: marketing attention pushes
-- ---------------------------------------------------------------------------------------------

alter table atlas_private.push_notification_queue drop constraint if exists push_notification_queue_event_type_check;
alter table atlas_private.push_notification_queue add constraint push_notification_queue_event_type_check
  check (event_type in ('team_message','shift_update','marketing_attention'));
alter table atlas_private.push_notification_queue drop constraint if exists push_notification_queue_route_check;
alter table atlas_private.push_notification_queue add constraint push_notification_queue_route_check
  check (route in ('team','shifts','marketing'));

create or replace function public.atlas_push_notification_enqueue_many(
  p_audience_user_ids uuid[],
  p_event_type text,
  p_title text,
  p_body text,
  p_route text,
  p_object_id uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare inserted_count integer;
begin
  if p_event_type not in ('team_message', 'shift_update', 'marketing_attention') then raise exception 'Unsupported notification event'; end if;
  if p_route not in ('team', 'shifts', 'marketing') then raise exception 'Unsupported notification route'; end if;
  insert into atlas_private.push_notification_queue (
    audience_user_id, event_type, title, body, route, object_id
  )
  select distinct audience_id, p_event_type, left(p_title, 160), left(p_body, 500), p_route, p_object_id
  from unnest(coalesce(p_audience_user_ids, '{}'::uuid[])) audience_id
  where audience_id is not null;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 14. Scheduler tick (pg_cron -> pg_net -> worker). Skips quietly without the extensions.
-- ---------------------------------------------------------------------------------------------

create or replace function atlas_private.marketing_publisher_tick(p_reason text default 'cron')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due boolean;
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
     or to_regnamespace('net') is null or to_regnamespace('vault') is null
     or to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  select exists (
    select 1 from atlas_private.marketing_deliveries d
    where d.next_attempt_at <= pg_catalog.now()
      and ((d.status in ('processing','verifying') and d.claim_token is null)
           or (d.status in ('queued','retrying') and d.claim_token is null
               and atlas_private.marketing_automatic_publishing_enabled())
           or (d.claim_token is not null and d.claimed_until < pg_catalog.now()))
  ) into v_due;
  if not v_due then return null; end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_url using 'atlas_project_url';
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'atlas_marketing_publisher_secret';
  exception when others then
    return null;
  end;
  if v_url is null or v_secret is null or v_url !~ '^https://' then
    raise warning 'marketing publisher tick is not configured';
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
    into v_request
    using v_url || '/functions/v1/atlas-marketing-publisher?action=tick',
          jsonb_build_object('reason', left(coalesce(p_reason, 'cron'), 20)),
          jsonb_build_object('content-type', 'application/json', 'x-atlas-publisher-secret', v_secret);
  return v_request;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 15. Public wrappers (service role only, definer, empty search_path)
-- ---------------------------------------------------------------------------------------------

create or replace function public.atlas_marketing_delivery_claim(p_worker_id text, p_limit integer default 4, p_lease_seconds integer default 300)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_delivery_claim(p_worker_id, p_limit, p_lease_seconds); $$;

create or replace function public.atlas_marketing_delivery_heartbeat(p_delivery_id uuid, p_claim_token uuid, p_seconds integer default 300)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_delivery_heartbeat(p_delivery_id, p_claim_token, p_seconds); $$;

create or replace function public.atlas_marketing_delivery_record_step(p_delivery_id uuid, p_claim_token uuid, p_phase text, p_ids jsonb, p_step jsonb)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_delivery_record_step(p_delivery_id, p_claim_token, p_phase, p_ids, p_step); $$;

create or replace function public.atlas_marketing_delivery_begin_submit(p_delivery_id uuid, p_claim_token uuid)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_delivery_begin_submit(p_delivery_id, p_claim_token); $$;

create or replace function public.atlas_marketing_delivery_complete(p_delivery_id uuid, p_claim_token uuid, p_outcome jsonb)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_delivery_complete(p_delivery_id, p_claim_token, p_outcome); $$;

create or replace function public.atlas_integration_mark_auth_failed(p_delivery_id uuid, p_claim_token uuid, p_error text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$ begin return atlas_private.marketing_delivery_mark_auth_failed(p_delivery_id, p_claim_token, p_error); end; $$;

create or replace function public.atlas_marketing_delivery_manager_action(p_actor_id uuid, p_delivery_id uuid, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_delivery_manager_action(p_actor_id, p_delivery_id, p_action, p_payload); $$;

create or replace function public.atlas_marketing_publish_now(p_actor_id uuid, p_content_id uuid)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_publish_now(p_actor_id, p_content_id); $$;

create or replace function public.atlas_marketing_content_cancel(p_actor_id uuid, p_content_id uuid, p_reason text default null)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_content_cancel(p_actor_id, p_content_id, p_reason); $$;

create or replace function public.atlas_marketing_content_reschedule(p_actor_id uuid, p_content_id uuid, p_expected_version integer, p_scheduled_for timestamptz)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_content_reschedule(p_actor_id, p_content_id, p_expected_version, p_scheduled_for); $$;

create or replace function public.atlas_marketing_content_duplicate(p_actor_id uuid, p_content_id uuid)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_content_duplicate(p_actor_id, p_content_id); $$;

create or replace function public.atlas_marketing_publication_history(p_actor_id uuid, p_content_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$ select atlas_private.marketing_publication_history(p_actor_id, p_content_id); $$;

create or replace function public.atlas_marketing_update_content(p_actor_id uuid, p_content_id uuid, p_expected_version integer, p_patch jsonb, p_note text default null)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select atlas_private.marketing_update_content_patch(p_actor_id, p_content_id, p_expected_version, p_patch, p_note); $$;

-- ---------------------------------------------------------------------------------------------
-- 16. Grants
-- ---------------------------------------------------------------------------------------------

do $grants$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'atlas_private' and p.proname in (
        'marketing_delivery_guard','marketing_attempts_append_only','marketing_actor',
        'marketing_automatic_publishing_enabled','marketing_sanitize_text','marketing_sanitize_step',
        'marketing_publish_targets','marketing_target_for','marketing_target_resource_id','marketing_content_media_list',
        'marketing_target_kind','marketing_effective_caption','marketing_validate_platform_options',
        'marketing_content_fingerprint_payload','marketing_content_fingerprint','marketing_delivery_payload',
        'marketing_delivery_event','marketing_delivery_notify','marketing_publication_state',
        'marketing_content_refresh_publication','marketing_content_guard','marketing_content_media_changed',
        'marketing_deliveries_create_for_approval','marketing_backoff','marketing_account_budget_next',
        'marketing_delivery_gate_reason','marketing_delivery_refuse','marketing_recover_expired_leases',
        'marketing_delivery_json','marketing_delivery_claim','marketing_delivery_lock_claim','marketing_delivery_heartbeat',
        'marketing_delivery_apply_ids','marketing_delivery_record_step','marketing_delivery_begin_submit',
        'marketing_poll_delay','marketing_poll_budget','marketing_delivery_complete','marketing_content_json',
        'marketing_delivery_manager_action','marketing_publish_now','marketing_content_cancel',
        'marketing_update_content_patch','marketing_content_reschedule','marketing_content_duplicate',
        'marketing_publication_history','marketing_publisher_tick',
        'marketing_content_publish_asap','marketing_error_wording',
        'marketing_delivery_mark_auth_failed','marketing_delivery_media_pin'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    if v_function::text like 'atlas_private.marketing_publisher_tick(%' then
      execute format('revoke all on function %s from service_role', v_function);
    else
      execute format('grant execute on function %s to service_role', v_function);
    end if;
  end loop;
end;
$grants$;

revoke all on function public.atlas_marketing_delivery_claim(text, integer, integer) from public, anon, authenticated;
revoke all on function public.atlas_marketing_delivery_heartbeat(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.atlas_marketing_delivery_record_step(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.atlas_marketing_delivery_begin_submit(uuid, uuid) from public, anon, authenticated;
revoke all on function public.atlas_marketing_delivery_complete(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.atlas_integration_mark_auth_failed(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.atlas_marketing_delivery_manager_action(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.atlas_marketing_publish_now(uuid, uuid) from public, anon, authenticated;
revoke all on function public.atlas_marketing_content_cancel(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.atlas_marketing_content_reschedule(uuid, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.atlas_marketing_content_duplicate(uuid, uuid) from public, anon, authenticated;
revoke all on function public.atlas_marketing_publication_history(uuid, uuid) from public, anon, authenticated;
revoke all on function public.atlas_marketing_update_content(uuid, uuid, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.atlas_marketing_create_content(uuid,uuid,text,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_push_notification_enqueue_many(uuid[], text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.atlas_marketing_delivery_claim(text, integer, integer) to service_role;
grant execute on function public.atlas_marketing_delivery_heartbeat(uuid, uuid, integer) to service_role;
grant execute on function public.atlas_marketing_delivery_record_step(uuid, uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.atlas_marketing_delivery_begin_submit(uuid, uuid) to service_role;
grant execute on function public.atlas_marketing_delivery_complete(uuid, uuid, jsonb) to service_role;
grant execute on function public.atlas_integration_mark_auth_failed(uuid, uuid, text) to service_role;
grant execute on function public.atlas_marketing_delivery_manager_action(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.atlas_marketing_publish_now(uuid, uuid) to service_role;
grant execute on function public.atlas_marketing_content_cancel(uuid, uuid, text) to service_role;
grant execute on function public.atlas_marketing_content_reschedule(uuid, uuid, integer, timestamptz) to service_role;
grant execute on function public.atlas_marketing_content_duplicate(uuid, uuid) to service_role;
grant execute on function public.atlas_marketing_publication_history(uuid, uuid) to service_role;
grant execute on function public.atlas_marketing_update_content(uuid, uuid, integer, jsonb, text) to service_role;
grant execute on function public.atlas_marketing_create_content(uuid,uuid,text,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,jsonb) to service_role;
grant execute on function public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) to service_role;
grant execute on function public.atlas_push_notification_enqueue_many(uuid[], text, text, text, text, uuid) to service_role;

-- Guard: no Marketing SQL keeps a hard-coded venue time zone.
do $venue_guard$
begin
  if exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'atlas_private' and p.proname like 'marketing%') or (n.nspname = 'public' and p.proname like 'atlas_marketing%'))
      and p.prosrc like '%Atlantic/Reykjavik%'
  ) then
    raise exception 'Marketing SQL still hard-codes a venue time zone';
  end if;
end;
$venue_guard$;

comment on table atlas_private.marketing_deliveries is
  'S94 per-platform publication of approved Marketing content. Written only by definer RPCs; transitions enforced by marketing_delivery_guard.';
comment on table atlas_private.marketing_delivery_attempts is
  'S94 append-only attempt ledger: one row per claim with sanitised provider steps (no tokens, no URLs).';
comment on table atlas_private.marketing_provider_accounts is
  'S94 per-account publishing rate state (cooldowns, daily caps).';
comment on function public.atlas_marketing_delivery_claim(text, integer, integer) is
  'Service-role worker claim: lease recovery, approval fingerprint gate, fairness, FOR UPDATE SKIP LOCKED.';
comment on function atlas_private.marketing_publisher_tick(text) is
  'pg_cron entry point: wakes atlas-marketing-publisher via pg_net with the Vault secret atlas_marketing_publisher_secret; returns null when pg_net/Vault are missing or nothing is due.';

reset statement_timeout;
reset lock_timeout;
