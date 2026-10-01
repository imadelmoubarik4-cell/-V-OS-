-- S100 Security & cost hardening — gap-closing pass over the existing S88 AI controls,
-- S96 DB protections, and the recipe write path. This migration ADDS controls only; it
-- does not weaken any S96 protection, change enforcement defaults, touch stock/price truth,
-- or activate bookings/MFA. Single-venue app (no venue_id): "per-venue" AI budgets are
-- global sums, which is correct here.
--
-- What this adds (each maps to an audited gap):
--   1. Cumulative USD budget (daily + monthly) on the cost-bearing AI path. S88 already
--      records atlas_private.ai_runs.est_cost_usd but nothing read it back to block spend;
--      this enforces it. Budgets are owner-tunable and nullable (NULL = no cap).
--   2. A durable, race-safe per-user request throttle on the TEXT-chat path (10/min + a
--      5/10s burst), reusing the existing advisory-locked atlas_private.ai_rate_take. Voice
--      already had per-minute buckets; text did not.
--   3. A durable, append-only block/abuse event trail (atlas_private.ai_block_events) +
--      a manager-only usage/cost summary RPC, so budgets/429s are observable (data existed,
--      surfacing did not).
--   4. A DB-trigger recipe price/flag change audit (atlas_private.recipe_price_events),
--      append-only, so manager recipe price changes are attributable (they were unlogged).
--
-- Re-runnable: add column if not exists, create table if not exists, create or replace,
-- drop-then-create triggers/policies.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. AI tunables: USD budgets + text-chat throttle limits -------------------------
-- Budgets are a runaway backstop (owner tunes down). NULL disables a cap entirely so the
-- owner is never locked out of their own tool.
alter table atlas_private.ai_settings
  add column if not exists chat_requests_per_minute integer not null default 10
    check (chat_requests_per_minute between 1 and 600),
  add column if not exists chat_burst_limit integer not null default 5
    check (chat_burst_limit between 1 and 200),
  add column if not exists daily_budget_usd numeric(12,2) default 5
    check (daily_budget_usd is null or daily_budget_usd >= 0),
  add column if not exists monthly_budget_usd numeric(12,2) default 30
    check (monthly_budget_usd is null or monthly_budget_usd >= 0);

-- 1b. Allow the text-chat throttle buckets in the existing durable limiter -----------
-- atlas_private.ai_rate_events restricted bucket to the voice buckets; the text-chat
-- throttle (§3) reuses the same advisory-locked limiter, so its buckets must be allowed
-- or every text turn would fail the check. Widen the allow-list (voice buckets kept).
alter table atlas_private.ai_rate_events drop constraint if exists ai_rate_events_bucket_check;
alter table atlas_private.ai_rate_events add constraint ai_rate_events_bucket_check
  check (bucket in ('voice_mint','voice_tool','voice_append','chat_request','chat_burst'));

-- 1c. VÁ/Alcedo pilot baseline for the AI quota/cost settings ----------------------
-- The agreed pilot caps are much tighter than the S88/S89/S91 ship defaults. Apply them
-- to the singleton settings row, but ONLY where a value is still at its original ship
-- default, so a cap the owner has explicitly tuned is never silently overwritten. The
-- budgets are corrected from this migration's own first-draft defaults (50/500) to the
-- pilot (5 daily backstop / 30 monthly hard cap). Everything stays owner-tunable via
-- public.atlas_ai_limits_set / public.atlas_ai_settings_set (NULL budget = cap disabled).
update atlas_private.ai_settings set
  daily_turn_limit_per_user = case when daily_turn_limit_per_user = 200 then 40 else daily_turn_limit_per_user end,
  voice_sessions_per_day = case when voice_sessions_per_day = 20 then 5 else voice_sessions_per_day end,
  voice_minutes_per_day = case when voice_minutes_per_day = 60 then 15 else voice_minutes_per_day end,
  upload_files_per_day = case when upload_files_per_day = 100 then 20 else upload_files_per_day end,
  upload_bytes_per_day = case when upload_bytes_per_day = 262144000 then 52428800 else upload_bytes_per_day end, -- 50 MiB
  recognition_identifications_per_hour = case when recognition_identifications_per_hour = 60 then 20 else recognition_identifications_per_hour end,
  recognition_vision_per_day = case when recognition_vision_per_day = 150 then 30 else recognition_vision_per_day end,
  recognition_vision_budget_usd_per_day = case when recognition_vision_budget_usd_per_day = 5 then 1 else recognition_vision_budget_usd_per_day end,
  media_retention_days = case when media_retention_days = 30 then 14 else media_retention_days end,
  -- audio_retention and max_concurrent_voice_sessions already ship at the pilot value.
  daily_budget_usd = case when daily_budget_usd = 50 then 5 else daily_budget_usd end,
  monthly_budget_usd = case when monthly_budget_usd = 500 then 30 else monthly_budget_usd end,
  updated_at = pg_catalog.now()
where id;

-- 2. Durable, append-only block/abuse event trail --------------------------------
create table if not exists atlas_private.ai_block_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  role text check (role is null or role in ('admin','manager','bartender','viewer')),
  kind text not null check (kind in (
    'rate_limited','budget_daily','budget_monthly','turn_limit','disabled','other')),
  channel text,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default pg_catalog.now()
);
create index if not exists ai_block_events_created_idx
  on atlas_private.ai_block_events (created_at desc);
create index if not exists ai_block_events_kind_idx
  on atlas_private.ai_block_events (kind, created_at desc);

alter table atlas_private.ai_block_events enable row level security;
drop policy if exists "service role manages ai block events" on atlas_private.ai_block_events;
create policy "service role manages ai block events" on atlas_private.ai_block_events
  for all to service_role using (true) with check (true);
revoke all on atlas_private.ai_block_events from public, anon, authenticated;
grant select, insert on atlas_private.ai_block_events to service_role;
revoke update, delete, truncate on atlas_private.ai_block_events from service_role, authenticated, anon;
-- Append-only (S96 pattern): the FK column may null on profile delete, nothing else changes.
drop trigger if exists s96_append_only on atlas_private.ai_block_events;
create trigger s96_append_only before update or delete on atlas_private.ai_block_events
  for each row execute function private.audit_append_only('user_id');
drop trigger if exists s96_append_only_no_truncate on atlas_private.ai_block_events;
create trigger s96_append_only_no_truncate before truncate on atlas_private.ai_block_events
  for each statement execute function private.audit_append_only();

-- 3. atlas_ai_run_start — add text throttle + USD budget to the existing guards ----
-- Faithful re-definition of the S88 function with two added checks. Preserves the enabled
-- kill-switch, the per-user daily turn limit, ownership and the invariant that the actor is
-- re-validated server-side. security invoker + service_role-only grant are unchanged.
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
  v_spent numeric;
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

    -- S100: per-user per-minute request throttle on the text-chat path (durable + race-safe
    -- via the advisory-locked sliding window). Voice has its own per-minute buckets already.
    if v_channel = 'text' then
      if not atlas_private.ai_rate_take(p_actor_id, 'chat_request',
             coalesce(v_settings.chat_requests_per_minute, 10), interval '1 minute')
         or not atlas_private.ai_rate_take(p_actor_id, 'chat_burst',
             coalesce(v_settings.chat_burst_limit, 5), interval '10 seconds') then
        raise exception using errcode = '53400',
          message = 'rate_limited: too many AI requests, slow down', hint = 'retry_after=30';
      end if;
    end if;

    -- S100: cumulative USD budget (global = per-venue) on the cost-bearing path. Reads back
    -- the est_cost_usd S88 already records. NULL budget = no cap (owner opt-out).
    if v_channel <> 'voice_tool' then
      if v_settings.daily_budget_usd is not null then
        select coalesce(pg_catalog.sum(r.est_cost_usd), 0) into v_spent
        from atlas_private.ai_runs r
        where r.est_cost_usd is not null and r.started_at > pg_catalog.now() - interval '1 day';
        if v_spent >= v_settings.daily_budget_usd then
          raise exception using errcode = '53400', message = 'rate_limited: daily AI budget reached';
        end if;
      end if;
      if v_settings.monthly_budget_usd is not null then
        select coalesce(pg_catalog.sum(r.est_cost_usd), 0) into v_spent
        from atlas_private.ai_runs r
        where r.est_cost_usd is not null and r.started_at >= pg_catalog.date_trunc('month', pg_catalog.now());
        if v_spent >= v_settings.monthly_budget_usd then
          raise exception using errcode = '53400', message = 'rate_limited: monthly AI budget reached';
        end if;
      end if;
    end if;

    if v_channel <> 'voice_tool' then
      -- Check and reserve under one per-user lock: concurrent turns queue
      -- here, so a burst cannot overshoot the daily limit.
      perform atlas_private.ai_lock_user(p_actor_id, 'turns');
      if atlas_private.ai_turns_used(p_actor_id) >= coalesce(v_settings.daily_turn_limit_per_user, 40) then
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
revoke execute on function public.atlas_ai_run_start(uuid,text,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.atlas_ai_run_start(uuid,text,uuid,text,jsonb) to service_role;

-- 4. Record a block/abuse event (edge calls this on the 429 path; its own txn survives the
--    run_start rollback). service_role-only; re-validates the actor.
create or replace function public.atlas_ai_record_block(
  p_actor_id uuid, p_actor_role text, p_kind text, p_channel text default null, p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  insert into atlas_private.ai_block_events (user_id, role, kind, channel, detail)
  values (p_actor_id, p_actor_role,
    case when p_kind in ('rate_limited','budget_daily','budget_monthly','turn_limit','disabled') then p_kind else 'other' end,
    p_channel,
    case when pg_catalog.jsonb_typeof(coalesce(p_detail,'{}'::jsonb)) = 'object' then coalesce(p_detail,'{}'::jsonb) else '{}'::jsonb end);
end;
$$;
revoke execute on function public.atlas_ai_record_block(uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.atlas_ai_record_block(uuid,text,text,text,jsonb) to service_role;

-- 5. Manager/admin usage & cost summary (observability read-back) -----------------
create or replace function public.atlas_ai_usage_summary(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_settings atlas_private.ai_settings;
  v_day_start timestamptz := pg_catalog.now() - interval '1 day';
  v_month_start timestamptz := pg_catalog.date_trunc('month', pg_catalog.now());
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_actor_role not in ('admin','manager') then
    raise exception using errcode = '42501', message = 'forbidden: manager access required';
  end if;
  select * into v_settings from atlas_private.ai_settings s where s.id;
  return jsonb_build_object(
    'enabled', coalesce(v_settings.enabled, false),
    'limits', jsonb_build_object(
      'daily_turn_limit_per_user', v_settings.daily_turn_limit_per_user,
      'chat_requests_per_minute', v_settings.chat_requests_per_minute,
      'chat_burst_limit', v_settings.chat_burst_limit,
      'daily_budget_usd', v_settings.daily_budget_usd,
      'monthly_budget_usd', v_settings.monthly_budget_usd),
    'spend', jsonb_build_object(
      'daily_usd', coalesce((select pg_catalog.sum(r.est_cost_usd) from atlas_private.ai_runs r
        where r.est_cost_usd is not null and r.started_at > v_day_start), 0),
      'monthly_usd', coalesce((select pg_catalog.sum(r.est_cost_usd) from atlas_private.ai_runs r
        where r.est_cost_usd is not null and r.started_at >= v_month_start), 0)),
    'runs', jsonb_build_object(
      'today', (select pg_catalog.count(*) from atlas_private.ai_runs r where r.started_at > v_day_start),
      'this_month', (select pg_catalog.count(*) from atlas_private.ai_runs r where r.started_at >= v_month_start)),
    'blocks', jsonb_build_object(
      'today', (select pg_catalog.count(*) from atlas_private.ai_block_events b where b.created_at > v_day_start),
      'this_month', (select pg_catalog.count(*) from atlas_private.ai_block_events b where b.created_at >= v_month_start),
      'by_kind_today', coalesce((select pg_catalog.jsonb_object_agg(k.kind, k.n) from (
        select b.kind, pg_catalog.count(*) as n from atlas_private.ai_block_events b
        where b.created_at > v_day_start group by b.kind) k), '{}'::jsonb))
  );
end;
$$;
revoke execute on function public.atlas_ai_usage_summary(uuid,text) from public, anon, authenticated;
grant execute on function public.atlas_ai_usage_summary(uuid,text) to service_role;

-- 6. Manager/admin setter for the new AI tunables (owner-tunable; no dashboard needed) ----
create or replace function public.atlas_ai_limits_set(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare p jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_actor_role not in ('admin','manager') then
    raise exception using errcode = '42501', message = 'forbidden: manager access required';
  end if;
  if pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_arguments: object required';
  end if;
  update atlas_private.ai_settings set
    chat_requests_per_minute = coalesce((p->>'chat_requests_per_minute')::int, chat_requests_per_minute),
    chat_burst_limit = coalesce((p->>'chat_burst_limit')::int, chat_burst_limit),
    -- a present key sets the value (incl. null to disable the cap); an absent key is unchanged
    daily_budget_usd = case when p ? 'daily_budget_usd' then (p->>'daily_budget_usd')::numeric else daily_budget_usd end,
    monthly_budget_usd = case when p ? 'monthly_budget_usd' then (p->>'monthly_budget_usd')::numeric else monthly_budget_usd end,
    updated_at = pg_catalog.now(), updated_by = p_actor_id
  where id;
  return public.atlas_ai_usage_summary(p_actor_id, p_actor_role);
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'invalid_arguments: bad limit value';
end;
$$;
revoke execute on function public.atlas_ai_limits_set(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.atlas_ai_limits_set(uuid,text,jsonb) to service_role;

-- 7. Recipe price/flag change audit (DB-trigger, cannot be skipped by a frontend path) ----
-- The direct manager recipe write path (RLS manager-only) is kept as-is this PR; this makes
-- every commercial change to a recipe attributable. Append-only.
create table if not exists atlas_private.recipe_price_events (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null,
  field text not null check (field in (
    'menu_price','happy_hour_price','glass_price','bottle_price','active','show_on_menu')),
  old_value text,
  new_value text,
  changed_by uuid,
  changed_by_role text,
  changed_at timestamptz not null default pg_catalog.now()
);
create index if not exists recipe_price_events_recipe_idx
  on atlas_private.recipe_price_events (recipe_id, changed_at desc);
create index if not exists recipe_price_events_changed_idx
  on atlas_private.recipe_price_events (changed_at desc);

alter table atlas_private.recipe_price_events enable row level security;
drop policy if exists "service role manages recipe price events" on atlas_private.recipe_price_events;
create policy "service role manages recipe price events" on atlas_private.recipe_price_events
  for all to service_role using (true) with check (true);
revoke all on atlas_private.recipe_price_events from public, anon, authenticated;
grant select, insert on atlas_private.recipe_price_events to service_role;
revoke update, delete, truncate on atlas_private.recipe_price_events from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.recipe_price_events;
create trigger s96_append_only before update or delete on atlas_private.recipe_price_events
  for each row execute function private.audit_append_only();
drop trigger if exists s96_append_only_no_truncate on atlas_private.recipe_price_events;
create trigger s96_append_only_no_truncate before truncate on atlas_private.recipe_price_events
  for each statement execute function private.audit_append_only();

-- The trigger runs SECURITY DEFINER so it writes to the sealed atlas_private table even on a
-- direct PostgREST manager UPDATE; the browser never reaches the table itself.
create or replace function private.recipe_commercial_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_role text := private.current_profile_role();
begin
  if new.menu_price is distinct from old.menu_price then
    insert into atlas_private.recipe_price_events (recipe_id, field, old_value, new_value, changed_by, changed_by_role)
    values (new.id, 'menu_price', old.menu_price::text, new.menu_price::text, v_actor, v_role);
  end if;
  if new.happy_hour_price is distinct from old.happy_hour_price then
    insert into atlas_private.recipe_price_events (recipe_id, field, old_value, new_value, changed_by, changed_by_role)
    values (new.id, 'happy_hour_price', old.happy_hour_price::text, new.happy_hour_price::text, v_actor, v_role);
  end if;
  if new.glass_price is distinct from old.glass_price then
    insert into atlas_private.recipe_price_events (recipe_id, field, old_value, new_value, changed_by, changed_by_role)
    values (new.id, 'glass_price', old.glass_price::text, new.glass_price::text, v_actor, v_role);
  end if;
  if new.bottle_price is distinct from old.bottle_price then
    insert into atlas_private.recipe_price_events (recipe_id, field, old_value, new_value, changed_by, changed_by_role)
    values (new.id, 'bottle_price', old.bottle_price::text, new.bottle_price::text, v_actor, v_role);
  end if;
  if new.active is distinct from old.active then
    insert into atlas_private.recipe_price_events (recipe_id, field, old_value, new_value, changed_by, changed_by_role)
    values (new.id, 'active', old.active::text, new.active::text, v_actor, v_role);
  end if;
  if new.show_on_menu is distinct from old.show_on_menu then
    insert into atlas_private.recipe_price_events (recipe_id, field, old_value, new_value, changed_by, changed_by_role)
    values (new.id, 'show_on_menu', old.show_on_menu::text, new.show_on_menu::text, v_actor, v_role);
  end if;
  return new;
end;
$function$;
revoke all on function private.recipe_commercial_audit() from public, anon, authenticated;
grant execute on function private.recipe_commercial_audit() to service_role, authenticated;

drop trigger if exists recipes_s100_commercial_audit on public.recipes;
create trigger recipes_s100_commercial_audit
  after update on public.recipes
  for each row execute function private.recipe_commercial_audit();

notify pgrst, 'reload schema';
