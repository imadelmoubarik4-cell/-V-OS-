-- S91 live voice: a short renewable lease and a device handoff.
--
-- Production (25 Sep): on a phone, live voice kept answering "already open in
-- another tab or device" for about a minute with no other device in use. A
-- session had been reserved but voice-end never reached the server (a 401
-- during the cross-device sign-out bug, or iOS dropping the page without
-- pagehide), so the 10-minute idle lease kept the concurrency slot.
--
-- * Lease: a session is reserved with an idle lease of p_lease_seconds
--   (30..600). atlas-ai asks for 2 minutes only when the client says it sends
--   heartbeats (the S91 web app, about every 45 seconds); without that the
--   default stays 10 minutes, so an older open tab that never heartbeats is
--   not cut off after 2 silent minutes (S91 review P2-A). The first heartbeat
--   also shortens a 10-minute session to 2 minutes. Tool calls and transcript
--   appends renew the lease too. A dead heartbeating session frees its slot
--   within 2 minutes. Heartbeats are limited to one per 15 seconds per
--   session (review P3-5). The hard cap (60 minutes) is unchanged.
-- * Takeover: atlas_ai_voice_session_start(..., p_takeover => true) ends the
--   SAME user's other live voice sessions (end_reason 'replaced', replaced_by
--   the new session, one audit row each in ai_voice_session_events) and
--   reserves the new one under the same per-user lock and transaction. Other
--   users' sessions are never touched. Quotas still apply to the new session;
--   if one refuses it, nothing is ended.
-- * A replaced session answers tool, heartbeat and activate with
--   'voice_session_replaced: …' (SQLSTATE 55000 → 409 voice_session_replaced)
--   so that device can stop cleanly and say where the call went. Its final
--   transcript append is still saved for 5 minutes after the handoff (the
--   result says replaced: true; review P3-3), later appends are refused as
--   replaced. 'end' stays idempotent.
--
-- Additive. Replaces atlas_ai_voice_session_start (old 5-argument signature
-- dropped; the new one keeps those five parameters first with the same
-- defaults, so an older atlas-ai build keeps working) and the bodies of
-- atlas_ai_voice_session_touch and ai_voice_session_json. Grants follow the
-- S88 hardening migration: service_role only, invoker, search_path pinned.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Columns -------------------------------------------------------------------------

alter table atlas_private.ai_voice_sessions
  add column if not exists lease_seconds integer not null default 600,
  add column if not exists heartbeats integer not null default 0,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists replaced_by uuid references atlas_private.ai_voice_sessions(id) on delete set null;

do $s91_voice_constraints$
declare
  v_name text;
begin
  -- The S88 inline check allowed only client_end and mint_failed.
  for v_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'atlas_private.ai_voice_sessions'::regclass and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%end_reason%'
      and c.conname <> 'ai_voice_sessions_end_reason_valid'
  loop
    execute format('alter table atlas_private.ai_voice_sessions drop constraint %I', v_name);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'ai_voice_sessions_end_reason_valid'
      and conrelid = 'atlas_private.ai_voice_sessions'::regclass) then
    alter table atlas_private.ai_voice_sessions add constraint ai_voice_sessions_end_reason_valid
      check (end_reason is null or end_reason in ('client_end','mint_failed','replaced'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_voice_sessions_replaced_by_reason'
      and conrelid = 'atlas_private.ai_voice_sessions'::regclass) then
    alter table atlas_private.ai_voice_sessions add constraint ai_voice_sessions_replaced_by_reason
      check (replaced_by is null or end_reason = 'replaced');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_voice_sessions_lease_seconds_range'
      and conrelid = 'atlas_private.ai_voice_sessions'::regclass) then
    alter table atlas_private.ai_voice_sessions add constraint ai_voice_sessions_lease_seconds_range
      check (lease_seconds between 30 and 600);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_voice_sessions_heartbeats_nonnegative'
      and conrelid = 'atlas_private.ai_voice_sessions'::regclass) then
    alter table atlas_private.ai_voice_sessions add constraint ai_voice_sessions_heartbeats_nonnegative
      check (heartbeats >= 0);
  end if;
end
$s91_voice_constraints$;

create index if not exists ai_voice_sessions_user_live_idx
  on atlas_private.ai_voice_sessions (user_id, lease_expires_at) where ended_at is null;

-- Audit of handoffs ------------------------------------------------------------------

create table if not exists atlas_private.ai_voice_session_events (
  id bigint generated always as identity primary key,
  voice_session_id uuid not null references atlas_private.ai_voice_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_role text not null check (actor_role in ('admin','manager','bartender','viewer')),
  event text not null check (event in ('replaced')),
  replaced_by uuid references atlas_private.ai_voice_sessions(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now()
);

create index if not exists ai_voice_session_events_user_idx
  on atlas_private.ai_voice_session_events (user_id, created_at desc);
create index if not exists ai_voice_session_events_session_idx
  on atlas_private.ai_voice_session_events (voice_session_id);

alter table atlas_private.ai_voice_session_events enable row level security;
revoke all on atlas_private.ai_voice_session_events from public, anon, authenticated;
grant all on atlas_private.ai_voice_session_events to service_role;
drop policy if exists "service role manages ai voice session events" on atlas_private.ai_voice_session_events;
create policy "service role manages ai voice session events"
  on atlas_private.ai_voice_session_events for all to service_role using (true) with check (true);

comment on table atlas_private.ai_voice_session_events is
  'Atlas AI live voice audit: one row per session ended by a device handoff (event replaced), with the session that replaced it. Owner-scoped, service role only.';
comment on column atlas_private.ai_voice_sessions.lease_seconds is
  'Idle lease length for this session. Heartbeats, tool calls and transcript appends extend lease_expires_at by this much (never past hard_expires_at).';

-- Session JSON ------------------------------------------------------------------------

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
    'lease_seconds', p_row.lease_seconds,
    'hard_expires_at', p_row.hard_expires_at,
    'ended_at', p_row.ended_at,
    'end_reason', p_row.end_reason,
    'replaced', p_row.end_reason = 'replaced',
    'live', p_row.ended_at is null and pg_catalog.now() < least(p_row.lease_expires_at, p_row.hard_expires_at),
    'tool_calls', p_row.tool_calls,
    'appended_turns', p_row.appended_turns,
    'heartbeats', p_row.heartbeats
  );
$$;

-- Start (reserve) with an optional takeover ---------------------------------------------

drop function if exists public.atlas_ai_voice_session_start(uuid, text, uuid, jsonb, integer);

-- Atomic check-and-reserve for a Realtime client secret. Checks, in order:
-- enabled, durable mint throttle (per minute), the daily turn limit (a mint
-- is one turn), then (with p_takeover) ends the actor's own live sessions,
-- then the daily voice-session cap, the concurrency cap and the estimated
-- daily minutes budget. Reserves a run (channel voice) and a voice-session
-- row with a p_lease_seconds idle lease. Any refusal rolls back the takeover.
create or replace function public.atlas_ai_voice_session_start(
  p_actor_id uuid,
  p_actor_role text,
  p_conversation_id uuid,
  p_models jsonb default '{}'::jsonb,
  p_mints_per_minute integer default 6,
  p_takeover boolean default false,
  p_lease_seconds integer default 600
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
  v_replaced uuid[] := array[]::uuid[];
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 600), 30), 600);
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

  -- Device handoff: only this actor's own live sessions; minutes are counted
  -- up to now.
  if coalesce(p_takeover, false) then
    with ended as (
      update atlas_private.ai_voice_sessions s
      set ended_at = greatest(s.started_at, pg_catalog.now()),
          end_reason = 'replaced'
      where s.user_id = p_actor_id
        and s.ended_at is null
        and pg_catalog.now() < least(s.lease_expires_at, s.hard_expires_at)
      returning s.id
    )
    select coalesce(array_agg(e.id), array[]::uuid[]) into v_replaced from ended e;
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
  insert into atlas_private.ai_voice_sessions (user_id, role, conversation_id, run_id, lease_seconds, lease_expires_at, hard_expires_at)
  values (p_actor_id, p_actor_role, p_conversation_id, v_run.id, v_lease,
    pg_catalog.now() + make_interval(secs => v_lease), pg_catalog.now() + interval '60 minutes')
  returning * into v_row;

  if cardinality(v_replaced) > 0 then
    update atlas_private.ai_voice_sessions s set replaced_by = v_row.id
    where s.id = any(v_replaced) and s.user_id = p_actor_id;
    insert into atlas_private.ai_voice_session_events (voice_session_id, user_id, actor_role, event, replaced_by)
    select replaced_id, p_actor_id, p_actor_role, 'replaced', v_row.id from unnest(v_replaced) as replaced_id;
  end if;

  return atlas_private.ai_voice_session_json(v_row) || jsonb_build_object(
    'replaced_sessions', cardinality(v_replaced),
    'limits', jsonb_build_object(
      'voice_sessions_per_day', coalesce(v_settings.voice_sessions_per_day, 20),
      'voice_minutes_per_day', coalesce(v_settings.voice_minutes_per_day, 60),
      'max_concurrent_voice_sessions', coalesce(v_settings.max_concurrent_voice_sessions, 1),
      'sessions_used', (v_usage->>'sessions_used')::integer + 1,
      'minutes_used_estimate', (v_usage->>'minutes_used_estimate')::integer));
end;
$$;

-- Touch ------------------------------------------------------------------------------------

-- Records activity on an owned voice session.
--   p_event 'activate'    stores the provider session id (live sessions only)
--   p_event 'heartbeat'   the live client is still connected: renews a 2-minute
--                         lease (at most one per 15 seconds)
--   p_event 'tool'        a voice-tool call: live only, 30 per minute; renews
--   p_event 'append'      a transcript append: live or within 5 minutes of the
--                         end (final flush), 30 per minute; renews while live
--   p_event 'end'         ends the session (idempotent)
--   p_event 'mint_failed' releases a reservation whose mint failed
-- A session replaced by another device answers every event except 'end' and
-- 'mint_failed' with voice_session_replaced.
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
  if p_event is null or p_event not in ('activate','heartbeat','tool','append','end','mint_failed') then
    perform atlas_private.ai_invalid('event must be activate, heartbeat, tool, append, end or mint_failed');
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

  if v_row.end_reason = 'replaced' then
    -- The replaced device's last transcript lines are kept for 5 minutes.
    if p_event <> 'append' or pg_catalog.now() > v_row.ended_at + interval '5 minutes' then
      raise exception using errcode = '55000', message = 'voice_session_replaced: live voice moved to another device';
    end if;
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
        lease_expires_at = case when v_live
          then greatest(s.lease_expires_at, least(s.hard_expires_at, pg_catalog.now() + make_interval(secs => s.lease_seconds)))
          else s.lease_expires_at end
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
        lease_expires_at = greatest(s.lease_expires_at, least(s.hard_expires_at, pg_catalog.now() + make_interval(secs => s.lease_seconds)))
    where s.id = v_row.id
    returning * into v_row;
  elsif p_event = 'heartbeat' then
    if v_row.last_heartbeat_at is not null and v_row.last_heartbeat_at > pg_catalog.now() - interval '15 seconds' then
      raise exception using errcode = '53400', message = 'rate_limited: too many voice heartbeats';
    end if;
    -- A heartbeating client gets the 2-minute lease from now on.
    update atlas_private.ai_voice_sessions s
    set heartbeats = s.heartbeats + 1,
        last_heartbeat_at = pg_catalog.now(),
        last_activity_at = pg_catalog.now(),
        lease_seconds = least(s.lease_seconds, 120),
        lease_expires_at = least(s.hard_expires_at, pg_catalog.now() + make_interval(secs => least(s.lease_seconds, 120)))
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

-- Grants ------------------------------------------------------------------------------------

do $s91_voice_grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'atlas_private.ai_voice_session_json(atlas_private.ai_voice_sessions)',
    'public.atlas_ai_voice_session_start(uuid, text, uuid, jsonb, integer, boolean, integer)',
    'public.atlas_ai_voice_session_touch(text, uuid, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$s91_voice_grants$;

notify pgrst, 'reload schema';
