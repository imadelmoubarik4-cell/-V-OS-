-- S88 Atlas AI security hardening (independent security review, findings
-- F1–F3, F7, F10–F12). Additive; replaces function bodies in place where the
-- signature is unchanged.
--
-- * F1/F11 Live voice is metered by the database: a per-user voice-session
--   row is reserved atomically when a Realtime client secret is minted, with
--   a daily session cap, an estimated daily minutes budget, a concurrency cap
--   and a durable mint throttle. voice-tool and voice-append require a live
--   session owned by the actor and are rate limited per user per minute.
-- * F2 Uploads have atomic per-user daily byte and file quotas, enforced in
--   atlas_ai_media_register.
-- * F3 atlas_ai_run_start checks and reserves a turn atomically under a
--   per-user advisory transaction lock (atlas_ai_rate_check stays for display).
-- * F7 atlas_ai_memory_search always re-checks the actor; the venue clock and
--   the integration RPCs re-check the active profile instead of trusting a
--   claimed role; atlas_ai_action_create only accepts known proposal kinds
--   and valid required_roles for that kind.
-- * F10 OAuth state is bound to the initiating browser (hashed cookie nonce)
--   and the callback re-checks that the initiating user is still an active
--   manager or administrator.
-- * F12 Brain receives a neutral summary of team message proposals, never the
--   drafted message text.
--
-- Error contract additions (message prefix → atlas-ai error_code):
--   'rate_limited: …'            SQLSTATE 53400 → 429 rate_limited
--   'voice_quota_exceeded: …'    SQLSTATE 53400 → 429 voice_quota_exceeded
--   'upload_quota_exceeded: …'   SQLSTATE 53400 → 429 upload_quota_exceeded
--   'voice_session_inactive: …'  SQLSTATE 55000 → 409 voice_session_inactive
--   'not_configured: …'          SQLSTATE 55000 → 503 not_configured

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Settings ---------------------------------------------------------------------

alter table atlas_private.ai_settings
  add column if not exists voice_sessions_per_day integer not null default 20,
  add column if not exists voice_minutes_per_day integer not null default 60,
  add column if not exists max_concurrent_voice_sessions integer not null default 1,
  add column if not exists upload_bytes_per_day bigint not null default 262144000,
  add column if not exists upload_files_per_day integer not null default 100;

do $s88_settings_checks$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_settings_voice_sessions_per_day_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_voice_sessions_per_day_range
      check (voice_sessions_per_day between 1 and 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_settings_voice_minutes_per_day_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_voice_minutes_per_day_range
      check (voice_minutes_per_day between 1 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_settings_max_concurrent_voice_sessions_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_max_concurrent_voice_sessions_range
      check (max_concurrent_voice_sessions between 1 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_settings_upload_bytes_per_day_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_upload_bytes_per_day_range
      check (upload_bytes_per_day between 1048576 and 10737418240);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_settings_upload_files_per_day_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_upload_files_per_day_range
      check (upload_files_per_day between 1 and 10000);
  end if;
end
$s88_settings_checks$;

-- Voice sessions and per-minute rate events --------------------------------------

-- One row per minted Realtime client secret. A session is live while it has
-- not ended and both its idle lease (extended by tool calls and transcript
-- appends) and its hard cap (the provider's 60-minute session limit) are in
-- the future. The server cannot close a Realtime call; ending a row only
-- stops Atlas from serving it (tools, transcript) and frees the quota.
create table if not exists atlas_private.ai_voice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin','manager','bartender','viewer')),
  conversation_id uuid references atlas_private.ai_conversations(id) on delete set null,
  run_id uuid references atlas_private.ai_runs(id) on delete set null,
  provider_session_id text
    check (provider_session_id is null or provider_session_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  started_at timestamptz not null default pg_catalog.now(),
  last_activity_at timestamptz not null default pg_catalog.now(),
  lease_expires_at timestamptz not null,
  hard_expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason is null or end_reason in ('client_end','mint_failed')),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  appended_turns integer not null default 0 check (appended_turns >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  check (lease_expires_at >= started_at and hard_expires_at >= started_at),
  check (ended_at is null or ended_at >= started_at)
);

create index if not exists ai_voice_sessions_user_started_idx
  on atlas_private.ai_voice_sessions (user_id, started_at desc);
create index if not exists ai_voice_sessions_provider_idx
  on atlas_private.ai_voice_sessions (user_id, provider_session_id) where provider_session_id is not null;
create index if not exists ai_voice_sessions_conversation_idx
  on atlas_private.ai_voice_sessions (conversation_id) where conversation_id is not null;
create index if not exists ai_voice_sessions_run_idx
  on atlas_private.ai_voice_sessions (run_id) where run_id is not null;

create table if not exists atlas_private.ai_rate_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  bucket text not null check (bucket in ('voice_mint','voice_tool','voice_append')),
  created_at timestamptz not null default pg_catalog.now()
);

create index if not exists ai_rate_events_user_bucket_idx
  on atlas_private.ai_rate_events (user_id, bucket, created_at desc);

alter table atlas_private.ai_voice_sessions enable row level security;
alter table atlas_private.ai_rate_events enable row level security;
revoke all on atlas_private.ai_voice_sessions from public, anon, authenticated;
revoke all on atlas_private.ai_rate_events from public, anon, authenticated;
grant all on atlas_private.ai_voice_sessions to service_role;
grant all on atlas_private.ai_rate_events to service_role;
drop policy if exists "service role manages ai voice sessions" on atlas_private.ai_voice_sessions;
create policy "service role manages ai voice sessions"
  on atlas_private.ai_voice_sessions for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai rate events" on atlas_private.ai_rate_events;
create policy "service role manages ai rate events"
  on atlas_private.ai_rate_events for all to service_role using (true) with check (true);

comment on table atlas_private.ai_voice_sessions is
  'Atlas AI live voice sessions: one row per minted Realtime client secret, owner-scoped. Quota, concurrency and liveness for voice-tool/voice-append. Minutes are an estimate (the browser owns the call).';
comment on table atlas_private.ai_rate_events is
  'Atlas AI per-user, per-minute rate events (voice mint, voice tool, voice append). Rows older than a day are pruned on write.';

-- Helpers -----------------------------------------------------------------------

-- Serialises check-and-reserve per user and scope for the current transaction.
create or replace function atlas_private.ai_lock_user(p_user_id uuid, p_scope text)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('atlas_ai:' || p_scope || ':' || p_user_id::text, 0));
$$;

-- Durable sliding-window limiter. Returns false (and records nothing) when
-- the user already used p_limit events of this bucket within p_window.
create or replace function atlas_private.ai_rate_take(p_user_id uuid, p_bucket text, p_limit integer, p_window interval)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_used integer;
begin
  perform atlas_private.ai_lock_user(p_user_id, 'rate:' || p_bucket);
  delete from atlas_private.ai_rate_events e
  where e.user_id = p_user_id and e.bucket = p_bucket and e.created_at < pg_catalog.now() - interval '1 day';
  select count(*) into v_used from atlas_private.ai_rate_events e
  where e.user_id = p_user_id and e.bucket = p_bucket and e.created_at > pg_catalog.now() - p_window;
  if v_used >= greatest(1, coalesce(p_limit, 1)) then
    return false;
  end if;
  insert into atlas_private.ai_rate_events (user_id, bucket) values (p_user_id, p_bucket);
  return true;
end;
$$;

-- Turns counted against the daily limit (same rule as atlas_ai_rate_check).
create or replace function atlas_private.ai_turns_used(p_user_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer from atlas_private.ai_runs r
  where r.user_id = p_user_id
    and r.started_at > pg_catalog.now() - interval '24 hours'
    and r.channel not in ('voice_tool','background');
$$;

-- Voice usage in the rolling 24-hour window. Minutes are estimated from the
-- start to the end (or, for a session that was never ended, to the end of
-- its lease or hard cap, whichever comes first, capped at now).
create or replace function atlas_private.ai_voice_usage(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'sessions_used', count(*),
    'live_sessions', count(*) filter (where s.ended_at is null
      and pg_catalog.now() < least(s.lease_expires_at, s.hard_expires_at)),
    'minutes_used_estimate', coalesce(ceil(sum(extract(epoch from (
      coalesce(s.ended_at, least(pg_catalog.now(), s.lease_expires_at, s.hard_expires_at)) - s.started_at)) / 60.0)), 0)::integer
  )
  from atlas_private.ai_voice_sessions s
  where s.user_id = p_user_id
    and s.started_at > pg_catalog.now() - interval '24 hours'
    and s.end_reason is distinct from 'mint_failed';
$$;

-- Brain copy of a proposal preview. Team messages are private drafts: Brain
-- (read by managers) keeps the channel, recipients and effects, never the text.
create or replace function atlas_private.ai_brain_preview(p_kind text, p_preview jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_kind = 'team_message.send' then jsonb_strip_nulls(jsonb_build_object(
      'headline', p_preview->'headline',
      'recipients', p_preview->'recipients',
      'will_change', p_preview->'will_change',
      'will_not_change', p_preview->'will_not_change',
      'route', p_preview->'route',
      'lines', jsonb_build_array(jsonb_build_object(
        'label', 'Message',
        'detail', 'Draft text is kept with the person who prepared it and is not copied to Brain.')),
      'private_content_withheld', true))
    else coalesce(p_preview, '{}'::jsonb)
  end;
$$;

-- Roles a proposal kind may require (mirrors _shared/ai-tools/actions.mjs
-- PROPOSAL_KINDS and requiredRolesFor). NULL means the kind is unknown.
create or replace function atlas_private.ai_action_allowed_roles(p_kind text, p_command jsonb)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_kind in ('purchase_order.create','purchase_order.receive','shift.draft','knowledge.draft',
                    'settings.suggestion','par_level.suggestion') then array['admin','manager']::text[]
    when p_kind = 'stock_count.draft' then array['admin','manager','bartender']::text[]
    when p_kind = 'team_message.send' then
      case when p_command->>'channel_key' = 'announcements' then array['admin','manager']::text[]
           else array['admin','manager','bartender']::text[] end
    else null
  end;
$$;

-- Runs: atomic turn reservation (F3) -------------------------------------------

create or replace function public.atlas_ai_run_start(
  p_actor_id uuid,
  p_actor_role text,
  p_conversation_id uuid default null,
  p_channel text default 'text',
  p_models jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_runs;
  v_settings atlas_private.ai_settings;
  v_channel text := coalesce(p_channel, 'text');
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;
  if v_channel <> 'background' then
    select * into v_settings from atlas_private.ai_settings s where s.id;
    if not coalesce(v_settings.enabled, false) then
      raise exception using errcode = '55000', message = 'not_configured: Atlas AI is disabled';
    end if;
    if v_channel <> 'voice_tool' then
      -- Check and reserve under one per-user lock: concurrent turns queue
      -- here, so a burst cannot overshoot the daily limit.
      perform atlas_private.ai_lock_user(p_actor_id, 'turns');
      if atlas_private.ai_turns_used(p_actor_id) >= coalesce(v_settings.daily_turn_limit_per_user, 200) then
        raise exception using errcode = '53400', message = 'rate_limited: daily Atlas AI limit reached';
      end if;
    end if;
  end if;
  insert into atlas_private.ai_runs (conversation_id, user_id, role, channel, models)
  values (p_conversation_id, p_actor_id, p_actor_role, v_channel, coalesce(p_models, '{}'::jsonb))
  returning * into v_row;
  return jsonb_build_object('run_id', v_row.id, 'conversation_id', v_row.conversation_id,
    'channel', v_row.channel, 'started_at', v_row.started_at, 'status', v_row.status);
exception
  when check_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Live voice sessions (F1, F11) ---------------------------------------------------

create or replace function atlas_private.ai_voice_session_json(p_row atlas_private.ai_voice_sessions)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'voice_session_id', p_row.id,
    'conversation_id', p_row.conversation_id,
    'run_id', p_row.run_id,
    'provider_session_id', p_row.provider_session_id,
    'started_at', p_row.started_at,
    'last_activity_at', p_row.last_activity_at,
    'lease_expires_at', p_row.lease_expires_at,
    'hard_expires_at', p_row.hard_expires_at,
    'ended_at', p_row.ended_at,
    'end_reason', p_row.end_reason,
    'live', p_row.ended_at is null and pg_catalog.now() < least(p_row.lease_expires_at, p_row.hard_expires_at),
    'tool_calls', p_row.tool_calls,
    'appended_turns', p_row.appended_turns
  );
$$;

-- Atomic check-and-reserve for a Realtime client secret. Checks, in order:
-- enabled, durable mint throttle (per minute), the daily turn limit (a mint
-- is one turn), the daily voice-session cap, the concurrency cap and the
-- estimated daily minutes budget. Reserves a run (channel voice) and a
-- voice-session row. Call ..._touch(…, 'mint_failed') if the mint fails.
create or replace function public.atlas_ai_voice_session_start(
  p_actor_id uuid,
  p_actor_role text,
  p_conversation_id uuid,
  p_models jsonb default '{}'::jsonb,
  p_mints_per_minute integer default 6
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_settings atlas_private.ai_settings;
  v_usage jsonb;
  v_run atlas_private.ai_runs;
  v_row atlas_private.ai_voice_sessions;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;
  select * into v_settings from atlas_private.ai_settings s where s.id;
  if not coalesce(v_settings.enabled, false) then
    raise exception using errcode = '55000', message = 'not_configured: Atlas AI is disabled';
  end if;

  perform atlas_private.ai_lock_user(p_actor_id, 'turns');
  perform atlas_private.ai_lock_user(p_actor_id, 'voice');
  if not atlas_private.ai_rate_take(p_actor_id, 'voice_mint', least(greatest(coalesce(p_mints_per_minute, 6), 1), 60), interval '1 minute') then
    raise exception using errcode = '53400', message = 'rate_limited: too many voice sessions started this minute';
  end if;
  if atlas_private.ai_turns_used(p_actor_id) >= coalesce(v_settings.daily_turn_limit_per_user, 200) then
    raise exception using errcode = '53400', message = 'rate_limited: daily Atlas AI limit reached';
  end if;
  v_usage := atlas_private.ai_voice_usage(p_actor_id);
  if (v_usage->>'sessions_used')::integer >= coalesce(v_settings.voice_sessions_per_day, 20) then
    raise exception using errcode = '53400', message = 'voice_quota_exceeded: daily_sessions';
  end if;
  if (v_usage->>'live_sessions')::integer >= coalesce(v_settings.max_concurrent_voice_sessions, 1) then
    raise exception using errcode = '53400', message = 'voice_quota_exceeded: concurrent';
  end if;
  if (v_usage->>'minutes_used_estimate')::integer >= coalesce(v_settings.voice_minutes_per_day, 60) then
    raise exception using errcode = '53400', message = 'voice_quota_exceeded: daily_minutes';
  end if;

  insert into atlas_private.ai_runs (conversation_id, user_id, role, channel, models)
  values (p_conversation_id, p_actor_id, p_actor_role, 'voice', coalesce(p_models, '{}'::jsonb))
  returning * into v_run;
  insert into atlas_private.ai_voice_sessions (user_id, role, conversation_id, run_id, lease_expires_at, hard_expires_at)
  values (p_actor_id, p_actor_role, p_conversation_id, v_run.id,
    pg_catalog.now() + interval '10 minutes', pg_catalog.now() + interval '60 minutes')
  returning * into v_row;

  return atlas_private.ai_voice_session_json(v_row) || jsonb_build_object(
    'limits', jsonb_build_object(
      'voice_sessions_per_day', coalesce(v_settings.voice_sessions_per_day, 20),
      'voice_minutes_per_day', coalesce(v_settings.voice_minutes_per_day, 60),
      'max_concurrent_voice_sessions', coalesce(v_settings.max_concurrent_voice_sessions, 1),
      'sessions_used', (v_usage->>'sessions_used')::integer + 1,
      'minutes_used_estimate', (v_usage->>'minutes_used_estimate')::integer));
end;
$$;

-- Records activity on an owned voice session.
--   p_event 'activate'    stores the provider session id (live sessions only)
--   p_event 'tool'        a voice-tool call: live only, 30 per minute
--   p_event 'append'      a transcript append: live or within 5 minutes of the
--                         end (final flush), 30 per minute
--   p_event 'end'         ends the session (idempotent)
--   p_event 'mint_failed' releases a reservation whose mint failed
-- p_voice_session_id is the Atlas id or the provider session id.
create or replace function public.atlas_ai_voice_session_touch(
  p_voice_session_id text,
  p_actor_id uuid,
  p_actor_role text,
  p_event text,
  p_provider_session_id text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_voice_sessions;
  v_key text := nullif(btrim(coalesce(p_voice_session_id, '')), '');
  v_live boolean;
  v_end timestamptz;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_event not in ('activate','tool','append','end','mint_failed') then
    perform atlas_private.ai_invalid('event must be activate, tool, append, end or mint_failed');
  end if;
  if v_key is null or char_length(v_key) > 120 then
    raise exception using errcode = '55000', message = 'voice_session_inactive: a live voice session is required';
  end if;

  select * into v_row from atlas_private.ai_voice_sessions s
  where s.user_id = p_actor_id and (s.id::text = lower(v_key) or s.provider_session_id = v_key)
  order by s.started_at desc
  limit 1
  for update;
  if v_row.id is null then
    raise exception using errcode = '55000', message = 'voice_session_inactive: unknown voice session';
  end if;

  v_live := v_row.ended_at is null and pg_catalog.now() < least(v_row.lease_expires_at, v_row.hard_expires_at);
  v_end := coalesce(v_row.ended_at, least(v_row.lease_expires_at, v_row.hard_expires_at));

  if p_event = 'end' or p_event = 'mint_failed' then
    if v_row.ended_at is null then
      update atlas_private.ai_voice_sessions s
      set ended_at = greatest(s.started_at, least(pg_catalog.now(), s.lease_expires_at, s.hard_expires_at)),
          end_reason = case when p_event = 'mint_failed' then 'mint_failed' else 'client_end' end
      where s.id = v_row.id
      returning * into v_row;
    end if;
    return atlas_private.ai_voice_session_json(v_row);
  end if;

  if p_event = 'append' then
    if not v_live and pg_catalog.now() > v_end + interval '5 minutes' then
      raise exception using errcode = '55000', message = 'voice_session_inactive: the voice session has ended';
    end if;
    if not atlas_private.ai_rate_take(p_actor_id, 'voice_append', 30, interval '1 minute') then
      raise exception using errcode = '53400', message = 'rate_limited: too many voice transcript updates this minute';
    end if;
    update atlas_private.ai_voice_sessions s
    set appended_turns = s.appended_turns + 1,
        last_activity_at = pg_catalog.now(),
        lease_expires_at = case when v_live then least(s.hard_expires_at, pg_catalog.now() + interval '10 minutes') else s.lease_expires_at end
    where s.id = v_row.id
    returning * into v_row;
    return atlas_private.ai_voice_session_json(v_row);
  end if;

  if not v_live then
    raise exception using errcode = '55000', message = 'voice_session_inactive: the voice session has ended';
  end if;

  if p_event = 'tool' then
    if not atlas_private.ai_rate_take(p_actor_id, 'voice_tool', 30, interval '1 minute') then
      raise exception using errcode = '53400', message = 'rate_limited: too many voice tool calls this minute';
    end if;
    update atlas_private.ai_voice_sessions s
    set tool_calls = s.tool_calls + 1,
        last_activity_at = pg_catalog.now(),
        lease_expires_at = least(s.hard_expires_at, pg_catalog.now() + interval '10 minutes')
    where s.id = v_row.id
    returning * into v_row;
  else
    update atlas_private.ai_voice_sessions s
    set provider_session_id = coalesce(s.provider_session_id,
          case when p_provider_session_id ~ '^[A-Za-z0-9_.:-]{1,120}$' then p_provider_session_id end),
        last_activity_at = pg_catalog.now()
    where s.id = v_row.id
    returning * into v_row;
  end if;
  return atlas_private.ai_voice_session_json(v_row);
end;
$$;

-- Media: atomic per-user daily quotas (F2) -----------------------------------------

create or replace function public.atlas_ai_media_register(
  p_actor_id uuid,
  p_actor_role text,
  p_conversation_id uuid,
  p_path text,
  p_mime text,
  p_bytes bigint,
  p_kind text,
  p_sha256 text default null,
  p_bucket text default 'atlas-ai-media'
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_settings atlas_private.ai_settings;
  v_row atlas_private.ai_media;
  v_prefix text;
  v_files integer;
  v_bytes bigint;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;
  v_prefix := p_actor_id::text || '/' || coalesce(p_conversation_id::text, 'unsorted') || '/';
  if p_path is null or left(p_path, char_length(v_prefix)) <> v_prefix then
    perform atlas_private.ai_invalid('path must start with <actor_id>/<conversation_id|unsorted>/');
  end if;
  select * into v_settings from atlas_private.ai_settings where id;

  -- Deleted media still counts: the quota limits what was stored today.
  perform atlas_private.ai_lock_user(p_actor_id, 'uploads');
  select count(*), coalesce(sum(m.bytes), 0) into v_files, v_bytes
  from atlas_private.ai_media m
  where m.user_id = p_actor_id and m.created_at > pg_catalog.now() - interval '24 hours';
  if v_files + 1 > coalesce(v_settings.upload_files_per_day, 100) then
    raise exception using errcode = '53400', message = 'upload_quota_exceeded: daily_files';
  end if;
  if v_bytes + greatest(coalesce(p_bytes, 0), 0) > coalesce(v_settings.upload_bytes_per_day, 262144000) then
    raise exception using errcode = '53400', message = 'upload_quota_exceeded: daily_bytes';
  end if;

  insert into atlas_private.ai_media (user_id, conversation_id, bucket, path, mime, bytes, kind, sha256, expires_at)
  values (
    p_actor_id, p_conversation_id, coalesce(p_bucket, 'atlas-ai-media'), p_path, p_mime, p_bytes, p_kind,
    lower(p_sha256),
    case
      when p_kind = 'audio' and coalesce(v_settings.audio_retention, 'delete_after_transcription') = 'delete_after_transcription'
        then pg_catalog.now() + interval '1 day'
      else pg_catalog.now() + make_interval(days => coalesce(v_settings.media_retention_days, 30))
    end
  )
  returning * into v_row;
  return atlas_private.ai_media_json(v_row);
exception
  when check_violation or not_null_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
  when unique_violation then
    raise exception using errcode = '55000', message = 'conflict: media path already registered';
end;
$$;

-- Settings and rate display ---------------------------------------------------------

create or replace function public.atlas_ai_settings_get(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_settings;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_row from atlas_private.ai_settings s where s.id;
  return jsonb_build_object(
    'enabled', coalesce(v_row.enabled, false),
    'media_retention_days', coalesce(v_row.media_retention_days, 30),
    'audio_retention', coalesce(v_row.audio_retention, 'delete_after_transcription'),
    'daily_turn_limit_per_user', coalesce(v_row.daily_turn_limit_per_user, 200),
    'voice_sessions_per_day', coalesce(v_row.voice_sessions_per_day, 20),
    'voice_minutes_per_day', coalesce(v_row.voice_minutes_per_day, 60),
    'max_concurrent_voice_sessions', coalesce(v_row.max_concurrent_voice_sessions, 1),
    'upload_bytes_per_day', coalesce(v_row.upload_bytes_per_day, 262144000),
    'upload_files_per_day', coalesce(v_row.upload_files_per_day, 100),
    'updated_at', v_row.updated_at,
    'can_edit', p_actor_role in ('admin','manager')
  );
end;
$$;

create or replace function public.atlas_ai_settings_set(p_actor_id uuid, p_actor_role text, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_unknown text;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_actor_role not in ('admin','manager') then
    raise exception using errcode = '42501', message = 'forbidden: only managers change Atlas AI settings';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform atlas_private.ai_invalid('patch must be a JSON object');
  end if;
  select key into v_unknown from jsonb_object_keys(p_patch) key
  where key not in ('enabled','media_retention_days','audio_retention','daily_turn_limit_per_user',
    'voice_sessions_per_day','voice_minutes_per_day','max_concurrent_voice_sessions',
    'upload_bytes_per_day','upload_files_per_day') limit 1;
  if v_unknown is not null then perform atlas_private.ai_invalid('unknown setting: ' || v_unknown); end if;

  insert into atlas_private.ai_settings (id) values (true) on conflict (id) do nothing;
  update atlas_private.ai_settings s set
    enabled = case when p_patch ? 'enabled' then (p_patch->>'enabled')::boolean else s.enabled end,
    media_retention_days = case when p_patch ? 'media_retention_days' then (p_patch->>'media_retention_days')::integer else s.media_retention_days end,
    audio_retention = case when p_patch ? 'audio_retention' then p_patch->>'audio_retention' else s.audio_retention end,
    daily_turn_limit_per_user = case when p_patch ? 'daily_turn_limit_per_user' then (p_patch->>'daily_turn_limit_per_user')::integer else s.daily_turn_limit_per_user end,
    voice_sessions_per_day = case when p_patch ? 'voice_sessions_per_day' then (p_patch->>'voice_sessions_per_day')::integer else s.voice_sessions_per_day end,
    voice_minutes_per_day = case when p_patch ? 'voice_minutes_per_day' then (p_patch->>'voice_minutes_per_day')::integer else s.voice_minutes_per_day end,
    max_concurrent_voice_sessions = case when p_patch ? 'max_concurrent_voice_sessions' then (p_patch->>'max_concurrent_voice_sessions')::integer else s.max_concurrent_voice_sessions end,
    upload_bytes_per_day = case when p_patch ? 'upload_bytes_per_day' then (p_patch->>'upload_bytes_per_day')::bigint else s.upload_bytes_per_day end,
    upload_files_per_day = case when p_patch ? 'upload_files_per_day' then (p_patch->>'upload_files_per_day')::integer else s.upload_files_per_day end,
    updated_by = p_actor_id
  where s.id;
  return public.atlas_ai_settings_get(p_actor_id, p_actor_role);
exception
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Display only; enforcement happens in atlas_ai_run_start and
-- atlas_ai_voice_session_start. Adds voice and upload usage.
create or replace function public.atlas_ai_rate_check(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_settings atlas_private.ai_settings;
  v_used integer;
  v_oldest timestamptz;
  v_limit integer;
  v_voice jsonb;
  v_files integer;
  v_bytes bigint;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_settings from atlas_private.ai_settings s where s.id;
  v_limit := coalesce(v_settings.daily_turn_limit_per_user, 200);
  select count(*), min(r.started_at) into v_used, v_oldest
  from atlas_private.ai_runs r
  where r.user_id = p_actor_id
    and r.started_at > pg_catalog.now() - interval '24 hours'
    and r.channel not in ('voice_tool','background');
  v_voice := atlas_private.ai_voice_usage(p_actor_id);
  select count(*), coalesce(sum(m.bytes), 0) into v_files, v_bytes
  from atlas_private.ai_media m
  where m.user_id = p_actor_id and m.created_at > pg_catalog.now() - interval '24 hours';
  return jsonb_build_object(
    'enabled', coalesce(v_settings.enabled, false),
    'allowed', coalesce(v_settings.enabled, false) and v_used < v_limit,
    'used', v_used,
    'limit', v_limit,
    'remaining', greatest(0, v_limit - v_used),
    'window_hours', 24,
    'resets_at', case when v_used >= v_limit then v_oldest + interval '24 hours' else null end,
    'voice', v_voice || jsonb_build_object(
      'sessions_limit', coalesce(v_settings.voice_sessions_per_day, 20),
      'minutes_limit', coalesce(v_settings.voice_minutes_per_day, 60),
      'max_concurrent', coalesce(v_settings.max_concurrent_voice_sessions, 1)),
    'uploads', jsonb_build_object(
      'files_used', v_files, 'files_limit', coalesce(v_settings.upload_files_per_day, 100),
      'bytes_used', v_bytes, 'bytes_limit', coalesce(v_settings.upload_bytes_per_day, 262144000))
  );
end;
$$;

-- Actions: kind allow-list and required roles bound to the kind (F7) ----------------

create or replace function public.atlas_ai_action_create(
  p_actor_id uuid,
  p_actor_role text,
  p_conversation_id uuid,
  p_message_id uuid,
  p_kind text,
  p_title text,
  p_preview jsonb,
  p_command jsonb,
  p_required_roles text[] default array['admin','manager']::text[],
  p_expires_in_seconds integer default 86400
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_actions;
  v_allowed text[];
  v_roles text[] := coalesce(p_required_roles, array['admin','manager']::text[]);
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;
  if p_message_id is not null and not exists (
    select 1 from atlas_private.ai_messages m
    where m.id = p_message_id and m.conversation_id is not distinct from p_conversation_id
  ) then
    perform atlas_private.ai_invalid('message_id is not a message in this conversation');
  end if;
  if p_command is null or jsonb_typeof(p_command) <> 'object' or p_command = '{}'::jsonb then
    perform atlas_private.ai_invalid('command must be a non-empty JSON object');
  end if;
  v_allowed := atlas_private.ai_action_allowed_roles(p_kind, p_command);
  if v_allowed is null then
    perform atlas_private.ai_invalid('unknown proposal kind');
  end if;
  -- Managers and administrators can always approve; nobody outside the
  -- kind's policy (never a viewer) can be named.
  if cardinality(v_roles) = 0
     or not (v_roles <@ v_allowed)
     or not (v_roles @> array['admin','manager']::text[]) then
    perform atlas_private.ai_invalid('required_roles must include admin and manager and stay within the policy for this kind');
  end if;
  if coalesce(p_expires_in_seconds, 86400) not between 60 and 604800 then
    perform atlas_private.ai_invalid('expires_in_seconds must be between 60 and 604800');
  end if;

  insert into atlas_private.ai_actions (
    conversation_id, message_id, user_id, role_at_proposal, kind, title, preview, command,
    required_roles, expires_at
  ) values (
    p_conversation_id, p_message_id, p_actor_id, p_actor_role, p_kind,
    atlas_private.ai_clean_title(p_title), coalesce(p_preview, '{}'::jsonb), p_command,
    (select array_agg(distinct role order by role) from unnest(v_roles) role),
    pg_catalog.now() + make_interval(secs => coalesce(p_expires_in_seconds, 86400))
  ) returning * into v_row;
  return atlas_private.ai_action_json(v_row, false);
exception
  when check_violation or not_null_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Brain: neutral copy of private drafts (F12) -----------------------------------------

create or replace function public.atlas_ai_record_proposal(
  p_action_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_evidence jsonb default '[]'::jsonb,
  p_subject_type text default null,
  p_subject_key text default null,
  p_summary text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_action atlas_private.ai_actions;
  v_key text;
  v_rec uuid;
  v_item jsonb;
  v_index integer := 0;
  v_first_tool text;
  v_state text;
  v_score numeric;
  v_private boolean;
  v_summary text;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_evidence is not null and (jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) > 20) then
    perform atlas_private.ai_invalid('evidence must be an array of at most 20 items');
  end if;

  select * into v_action from atlas_private.ai_actions a
  where a.id = p_action_id and a.user_id = p_actor_id
  for update;
  if v_action.id is null then raise exception using errcode = 'P0002', message = 'not_found: action'; end if;

  v_key := 'atlas-ai:action:' || v_action.id::text;
  if v_action.brain_recommendation_id is not null then
    return jsonb_build_object('action_id', v_action.id, 'brain_recommendation_id', v_action.brain_recommendation_id,
      'recommendation_key', v_key, 'created', false);
  end if;

  -- Team messages are personal drafts until sent: Brain (manager-readable)
  -- gets the channel and the effect, never the text or text-bearing evidence.
  v_private := v_action.kind = 'team_message.send';
  v_summary := case
    when v_private then left(coalesce(v_action.preview->>'headline', 'Team message') || ' prepared by Atlas AI for approval. The draft text is not copied to Brain.', 2000)
    else left(coalesce(nullif(btrim(p_summary), ''), v_action.preview->>'summary', v_action.title), 2000)
  end;

  select nullif(item->>'tool', '') into v_first_tool
  from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) item
  where nullif(item->>'tool', '') is not null
  limit 1;

  v_rec := atlas_private.upsert_shadow_recommendation(
    v_key,
    'assistant',
    'atlas_ai_proposals',
    left(coalesce(nullif(btrim(p_subject_type), ''), 'atlas_ai_action'), 120),
    left(coalesce(nullif(btrim(p_subject_key), ''), v_action.kind), 240),
    v_action.title,
    v_summary,
    format('Prepared by Atlas AI for a %s. Nothing changes until a person approves this proposal; approval runs the normal Atlas command.', v_action.role_at_proposal),
    jsonb_build_object('kind', 'atlas_ai_action', 'action_id', v_action.id, 'action_kind', v_action.kind,
      'required_roles', to_jsonb(v_action.required_roles),
      'preview', atlas_private.ai_brain_preview(v_action.kind, v_action.preview)),
    '[]'::jsonb,
    '{}'::jsonb,
    'modelled',
    0.5,
    'Prepared by Atlas AI from tool results; requires human approval.',
    array['Shadow recommendation from Atlas AI. It never changes operational records by itself.']::text[],
    50,
    'atlas_ai_tool',
    'atlas_private',
    coalesce(v_first_tool, 'ai_actions'),
    v_action.id::text,
    'Atlas AI proposal',
    jsonb_build_object('action_id', v_action.id, 'kind', v_action.kind, 'role_at_proposal', v_action.role_at_proposal,
      'evidence_count', coalesce(jsonb_array_length(p_evidence), 0)),
    pg_catalog.now()
  );

  update atlas_private.brain_recommendations r
  set generated_by = 'atlas-ai/s88', valid_until = v_action.expires_at, updated_at = pg_catalog.now()
  where r.id = v_rec;

  for v_item in select value from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_item) <> 'object' then continue; end if;
    if v_private then
      v_item := (v_item - 'value') || jsonb_build_object('value_withheld', true);
    end if;
    v_state := case v_item->>'kind'
      when 'fact' then 'verified' when 'calculation' then 'verified'
      when 'missing' then 'pending' else 'modelled' end;
    v_score := case v_item->>'kind'
      when 'fact' then 1.0 when 'calculation' then 0.95 when 'interpretation' then 0.6
      when 'estimate' then 0.5 else 0.0 end;
    insert into atlas_private.brain_recommendation_evidence (
      recommendation_id, evidence_key, label, source_kind, source_schema, source_object,
      source_row_key, observed_at, confidence_state, confidence_score, value
    ) values (
      v_rec, 'tool-' || lpad(v_index::text, 2, '0'),
      left(coalesce(nullif(v_item->>'label', ''), nullif(v_item->>'tool', ''), 'Evidence'), 240),
      'atlas_ai_tool', null, left(coalesce(nullif(v_item->>'tool', ''), 'unknown'), 120),
      left(v_item->'source'->>'id', 240), pg_catalog.now(), v_state, v_score,
      v_item
    )
    on conflict (recommendation_id, evidence_key) do update set
      label = excluded.label, source_object = excluded.source_object, source_row_key = excluded.source_row_key,
      confidence_state = excluded.confidence_state, confidence_score = excluded.confidence_score, value = excluded.value;
  end loop;

  update atlas_private.ai_actions a set brain_recommendation_id = v_rec where a.id = v_action.id;

  return jsonb_build_object('action_id', v_action.id, 'brain_recommendation_id', v_rec,
    'recommendation_key', v_key, 'created', true);
end;
$$;

-- Decision memory: the actor is always required and re-checked (F7) ---------------

create or replace function public.atlas_ai_memory_search(
  p_query text,
  p_limit integer,
  p_actor_role text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query tsquery := atlas_private.ai_tsquery(p_query, false);
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  -- A NULL actor is refused by ai_require_actor (no claimed-role path).
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if coalesce(p_actor_role, '') not in ('admin','manager') then
    raise exception using errcode = '42501', message = 'forbidden: decision memory is manager-only';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(ranked) - 'document' order by ranked.rank desc, ranked.occurred_at desc)
    from (
      select memory.*,
        case when v_query is null then 0::real else pg_catalog.ts_rank(doc.document, v_query) end as rank,
        doc.document
      from atlas_private.brain_decision_memory memory
      cross join lateral (
        select pg_catalog.to_tsvector('simple'::regconfig, concat_ws(' ',
          memory.title, memory.summary, memory.subject_type, memory.subject_key, memory.action,
          memory.actor_label, memory.context->>'reason_code', memory.context->>'recommendation_key')) as document
      ) doc
      where v_query is null or doc.document @@ v_query
      order by rank desc, memory.occurred_at desc
      limit v_limit
    ) ranked
  ), '[]'::jsonb);
end;
$$;

-- Venue clock: the actor is re-checked against the active profile (F7) ---------------

drop function if exists public.atlas_settings_venue_clock(text);

create or replace function public.atlas_settings_venue_clock(p_actor_role text, p_actor_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  return atlas_private.settings_venue_clock(p_actor_role);
end;
$function$;

comment on function public.atlas_settings_venue_clock(text, uuid) is
  'S88 service-role-only venue clock for every active Atlas role. The actor id is required and re-checked against the active profile.';

-- Integrations: profile re-check and browser-bound OAuth state (F7, F10) -------------

alter table atlas_private.integration_oauth_states
  add column if not exists browser_binding_hash bytea,
  add column if not exists bound_at timestamptz;

do $s88_binding_check$
begin
  if not exists (select 1 from pg_constraint where conname = 'integration_oauth_states_binding_hash_length'
      and conrelid = 'atlas_private.integration_oauth_states'::regclass) then
    alter table atlas_private.integration_oauth_states add constraint integration_oauth_states_binding_hash_length
      check (browser_binding_hash is null or octet_length(browser_binding_hash) = 32);
  end if;
end
$s88_binding_check$;

-- The claimed actor must be an active profile holding exactly that role, and
-- that role must be manager or admin.
create or replace function atlas_private.integration_assert_actor(p_actor_id uuid, p_actor_role text)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform atlas_private.integration_assert_manager(p_actor_role);
  if p_actor_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = p_actor_id and profile.active is true and profile.role::text = p_actor_role
  ) then
    raise exception 'Only active managers and administrators can manage integrations'
      using errcode = '42501';
  end if;
end;
$function$;

drop function if exists public.atlas_integration_status(text);
drop function if exists atlas_private.integration_status(text);

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
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
  perform atlas_private.integration_assert_provider(p_provider_key);
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

-- Binds a started, unconsumed state to the browser that opened the Atlas
-- authorize hop (sha256 of a random cookie nonce). Once only: a leaked hop
-- URL opened later cannot rebind it.
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
begin
  update atlas_private.integration_oauth_states s
  set browser_binding_hash = atlas_private.integration_hex(p_binding_hash, 'Binding hash'),
      bound_at = now()
  where s.state_hash = atlas_private.integration_hex(p_state_hash, 'State hash')
    and s.provider_key = p_provider_key
    and s.consumed_at is null
    and s.expires_at > now()
    and s.browser_binding_hash is null
  returning s.expires_at into v_expires;
  if v_expires is null then
    return null;
  end if;
  return jsonb_build_object('bound', true, 'expires_at', v_expires);
end;
$function$;

drop function if exists public.atlas_integration_consume_state(text, text);
drop function if exists atlas_private.integration_consume_state(text, text);

-- Single use, bound to the browser, and the initiating user must still be an
-- active manager or administrator (their current role is returned).
create or replace function atlas_private.integration_consume_state(
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
  v_row atlas_private.integration_oauth_states%rowtype;
  v_role text;
begin
  if p_binding_hash is null then
    return null;
  end if;
  update atlas_private.integration_oauth_states s
  set consumed_at = now()
  where s.state_hash = atlas_private.integration_hex(p_state_hash, 'State hash')
    and s.provider_key = p_provider_key
    and s.consumed_at is null
    and s.expires_at > now()
    and s.browser_binding_hash = atlas_private.integration_hex(p_binding_hash, 'Binding hash')
  returning s.* into v_row;

  if v_row.state_hash is null then
    return null;
  end if;

  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_row.actor_id and profile.active is true and profile.role::text in ('admin','manager');

  if v_role is null then
    return jsonb_build_object('provider_key', v_row.provider_key, 'actor_allowed', false, 'return_path', v_row.return_path);
  end if;

  return jsonb_build_object(
    'provider_key', v_row.provider_key,
    'actor_allowed', true,
    'actor_id', v_row.actor_id,
    'actor_label', v_row.actor_label,
    'actor_role', v_role,
    'verifier_ciphertext', case when v_row.verifier_ciphertext is null then null else pg_catalog.encode(v_row.verifier_ciphertext, 'hex') end,
    'verifier_nonce', case when v_row.verifier_nonce is null then null else pg_catalog.encode(v_row.verifier_nonce, 'hex') end,
    'key_version', v_row.key_version,
    'return_path', v_row.return_path
  );
end;
$function$;

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
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
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

drop function if exists public.atlas_integration_read_credential(text, text);
drop function if exists atlas_private.integration_read_credential(text, text);

create or replace function atlas_private.integration_read_credential(
  p_provider_key text,
  p_actor_role text,
  p_actor_id uuid
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
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
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
  perform atlas_private.integration_assert_actor(p_actor_id, p_actor_role);
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

create or replace function public.atlas_integration_status(p_actor_role text, p_actor_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select atlas_private.integration_status(p_actor_role, p_actor_id); $$;

create or replace function public.atlas_integration_bind_browser(p_provider_key text, p_state_hash text, p_binding_hash text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_bind_browser(p_provider_key, p_state_hash, p_binding_hash); $$;

create or replace function public.atlas_integration_consume_state(p_provider_key text, p_state_hash text, p_binding_hash text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.integration_consume_state(p_provider_key, p_state_hash, p_binding_hash); $$;

create or replace function public.atlas_integration_read_credential(p_provider_key text, p_actor_role text, p_actor_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select atlas_private.integration_read_credential(p_provider_key, p_actor_role, p_actor_id); $$;

-- Grants --------------------------------------------------------------------------------

do $s88_hardening_grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'atlas_private.ai_lock_user(uuid, text)',
    'atlas_private.ai_rate_take(uuid, text, integer, interval)',
    'atlas_private.ai_turns_used(uuid)',
    'atlas_private.ai_voice_usage(uuid)',
    'atlas_private.ai_brain_preview(text, jsonb)',
    'atlas_private.ai_action_allowed_roles(text, jsonb)',
    'atlas_private.ai_voice_session_json(atlas_private.ai_voice_sessions)',
    'public.atlas_ai_run_start(uuid, text, uuid, text, jsonb)',
    'public.atlas_ai_voice_session_start(uuid, text, uuid, jsonb, integer)',
    'public.atlas_ai_voice_session_touch(text, uuid, text, text, text)',
    'public.atlas_ai_media_register(uuid, text, uuid, text, text, bigint, text, text, text)',
    'public.atlas_ai_settings_get(uuid, text)',
    'public.atlas_ai_settings_set(uuid, text, jsonb)',
    'public.atlas_ai_rate_check(uuid, text)',
    'public.atlas_ai_action_create(uuid, text, uuid, uuid, text, text, jsonb, jsonb, text[], integer)',
    'public.atlas_ai_record_proposal(uuid, uuid, text, jsonb, text, text, text)',
    'public.atlas_ai_memory_search(text, integer, text, uuid)',
    'public.atlas_settings_venue_clock(text, uuid)',
    'atlas_private.integration_assert_actor(uuid, text)',
    'atlas_private.integration_status(text, uuid)',
    'atlas_private.integration_begin(text, text, text, text, smallint, text, uuid, text, text)',
    'atlas_private.integration_bind_browser(text, text, text)',
    'atlas_private.integration_consume_state(text, text, text)',
    'atlas_private.integration_store_credential(text, text, text, text, smallint, timestamptz, timestamptz, text, uuid, text, text)',
    'atlas_private.integration_read_credential(text, text, uuid)',
    'atlas_private.integration_record_result(text, text, text, text, text[], timestamptz, boolean, text, uuid, text, text)',
    'atlas_private.integration_disconnect(text, uuid, text, text)',
    'public.atlas_integration_status(text, uuid)',
    'public.atlas_integration_bind_browser(text, text, text)',
    'public.atlas_integration_consume_state(text, text, text)',
    'public.atlas_integration_read_credential(text, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$s88_hardening_grants$;

comment on table atlas_private.ai_settings is
  'Singleton Atlas AI settings. Disabled by default. Voice and upload quotas are per user per rolling 24 hours; voice minutes are an estimate.';

notify pgrst, 'reload schema';
