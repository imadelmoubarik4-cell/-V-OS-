-- Atlas S34 Git-only notification and conversation-star candidate.
-- Generated with `supabase migration new`; intentionally not applied.
-- All records stay private and are reachable only through service-role gateways.

set lock_timeout = '5s';
set statement_timeout = '2min';

create table if not exists atlas_private.team_conversation_stars (
  user_id uuid not null,
  channel_id uuid not null references atlas_private.team_channels(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, channel_id)
);

create table if not exists atlas_private.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null,
  endpoint_hash text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  enabled boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  constraint push_subscriptions_endpoint_length check (char_length(endpoint) between 16 and 4096),
  constraint push_subscriptions_p256dh_length check (char_length(p256dh) between 16 and 512),
  constraint push_subscriptions_auth_length check (char_length(auth_secret) between 8 and 256),
  unique (user_id, endpoint_hash)
);

create table if not exists atlas_private.push_notification_queue (
  id uuid primary key default gen_random_uuid(),
  audience_user_id uuid not null,
  event_type text not null check (event_type in ('team_message','shift_update')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 500),
  route text not null check (route in ('team','shifts')),
  object_id uuid,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','suppressed')),
  created_at timestamptz not null default pg_catalog.now(),
  attempted_at timestamptz,
  error text
);

create index if not exists team_conversation_stars_channel_id_idx
  on atlas_private.team_conversation_stars (channel_id);
create index if not exists push_subscriptions_enabled_user_idx
  on atlas_private.push_subscriptions (user_id) where enabled;
create index if not exists push_notification_queue_pending_idx
  on atlas_private.push_notification_queue (created_at, id) where status = 'pending';
create index if not exists push_notification_queue_audience_idx
  on atlas_private.push_notification_queue (audience_user_id, created_at desc);

alter table atlas_private.team_conversation_stars enable row level security;
alter table atlas_private.push_subscriptions enable row level security;
alter table atlas_private.push_notification_queue enable row level security;

revoke all on atlas_private.team_conversation_stars from public, anon, authenticated;
revoke all on atlas_private.push_subscriptions from public, anon, authenticated;
revoke all on atlas_private.push_notification_queue from public, anon, authenticated;
grant all on atlas_private.team_conversation_stars to service_role;
grant all on atlas_private.push_subscriptions to service_role;
grant all on atlas_private.push_notification_queue to service_role;

drop policy if exists "service role manages conversation stars" on atlas_private.team_conversation_stars;
create policy "service role manages conversation stars"
  on atlas_private.team_conversation_stars for all to service_role using (true) with check (true);
drop policy if exists "service role manages push subscriptions" on atlas_private.push_subscriptions;
create policy "service role manages push subscriptions"
  on atlas_private.push_subscriptions for all to service_role using (true) with check (true);
drop policy if exists "service role manages notification queue" on atlas_private.push_notification_queue;
create policy "service role manages notification queue"
  on atlas_private.push_notification_queue for all to service_role using (true) with check (true);

create or replace function public.atlas_team_conversation_stars_snapshot(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(channel.channel_key order by channel.sort_order), '[]'::jsonb)
  from atlas_private.team_conversation_stars star
  join atlas_private.team_channels channel on channel.id = star.channel_id
  where star.user_id = p_user_id and channel.active;
$$;

create or replace function public.atlas_team_conversation_star_set(
  p_user_id uuid,
  p_channel_key text,
  p_starred boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_channel_id uuid;
begin
  select channel.id into target_channel_id
  from atlas_private.team_channels channel
  where channel.channel_key = nullif(trim(p_channel_key), '') and channel.active
  limit 1;
  if target_channel_id is null then raise exception 'Active channel was not found'; end if;

  if coalesce(p_starred, false) then
    insert into atlas_private.team_conversation_stars (user_id, channel_id)
    values (p_user_id, target_channel_id)
    on conflict (user_id, channel_id) do nothing;
  else
    delete from atlas_private.team_conversation_stars
    where user_id = p_user_id and channel_id = target_channel_id;
  end if;
  return coalesce(p_starred, false);
end;
$$;

create or replace function public.atlas_push_subscription_upsert(
  p_user_id uuid,
  p_endpoint text,
  p_endpoint_hash text,
  p_p256dh text,
  p_auth_secret text,
  p_user_agent text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare result_id uuid;
begin
  insert into atlas_private.push_subscriptions (
    user_id, endpoint, endpoint_hash, p256dh, auth_secret, user_agent, enabled, updated_at
  ) values (
    p_user_id, p_endpoint, p_endpoint_hash, p_p256dh, p_auth_secret,
    left(nullif(trim(p_user_agent), ''), 500), true, pg_catalog.now()
  )
  on conflict (user_id, endpoint_hash) do update set
    endpoint = excluded.endpoint,
    p256dh = excluded.p256dh,
    auth_secret = excluded.auth_secret,
    user_agent = excluded.user_agent,
    enabled = true,
    updated_at = pg_catalog.now(),
    last_error = null
  returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.atlas_push_subscription_disable(
  p_user_id uuid,
  p_endpoint_hash text
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update atlas_private.push_subscriptions
  set enabled = false, updated_at = pg_catalog.now()
  where user_id = p_user_id and endpoint_hash = p_endpoint_hash and enabled
  returning true;
$$;

create or replace function public.atlas_push_subscription_status(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', exists (
      select 1 from atlas_private.push_subscriptions
      where user_id = p_user_id and enabled
    ),
    'subscription_count', (
      select count(*) from atlas_private.push_subscriptions
      where user_id = p_user_id and enabled
    )
  );
$$;

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
  if p_event_type not in ('team_message', 'shift_update') then raise exception 'Unsupported notification event'; end if;
  if p_route not in ('team', 'shifts') then raise exception 'Unsupported notification route'; end if;
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

create or replace function public.atlas_push_notification_claim(p_limit integer default 50)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare result jsonb;
begin
  with claimed as (
    select queue.id
    from atlas_private.push_notification_queue queue
    where queue.status = 'pending'
    order by queue.created_at, queue.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  ), marked as (
    update atlas_private.push_notification_queue queue
    set status = 'processing', attempted_at = pg_catalog.now(), error = null
    from claimed
    where queue.id = claimed.id
    returning queue.*
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'notification', to_jsonb(marked),
      'subscriptions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', subscription.id,
          'endpoint', subscription.endpoint,
          'p256dh', subscription.p256dh,
          'auth', subscription.auth_secret
        ))
        from atlas_private.push_subscriptions subscription
        where subscription.user_id = marked.audience_user_id and subscription.enabled
      ), '[]'::jsonb)
    ) order by marked.created_at, marked.id
  ), '[]'::jsonb)
  into result from marked;
  return result;
end;
$$;

create or replace function public.atlas_push_notification_complete(
  p_notification_id uuid,
  p_status text,
  p_error text default null
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update atlas_private.push_notification_queue
  set status = case when p_status in ('sent', 'failed', 'suppressed') then p_status else 'failed' end,
      error = left(nullif(trim(p_error), ''), 1000),
      attempted_at = coalesce(attempted_at, pg_catalog.now())
  where id = p_notification_id and status = 'processing'
  returning true;
$$;

revoke execute on function public.atlas_team_conversation_stars_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.atlas_team_conversation_star_set(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.atlas_push_subscription_upsert(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.atlas_push_subscription_disable(uuid, text) from public, anon, authenticated;
revoke execute on function public.atlas_push_subscription_status(uuid) from public, anon, authenticated;
revoke execute on function public.atlas_push_notification_enqueue_many(uuid[], text, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.atlas_push_notification_claim(integer) from public, anon, authenticated;
revoke execute on function public.atlas_push_notification_complete(uuid, text, text) from public, anon, authenticated;
grant execute on function public.atlas_team_conversation_stars_snapshot(uuid) to service_role;
grant execute on function public.atlas_team_conversation_star_set(uuid, text, boolean) to service_role;
grant execute on function public.atlas_push_subscription_upsert(uuid, text, text, text, text, text) to service_role;
grant execute on function public.atlas_push_subscription_disable(uuid, text) to service_role;
grant execute on function public.atlas_push_subscription_status(uuid) to service_role;
grant execute on function public.atlas_push_notification_enqueue_many(uuid[], text, text, text, text, uuid) to service_role;
grant execute on function public.atlas_push_notification_claim(integer) to service_role;
grant execute on function public.atlas_push_notification_complete(uuid, text, text) to service_role;

comment on table atlas_private.push_subscriptions is
  'Private browser push subscriptions; delivery remains disabled until an approved staging deployment.';
comment on table atlas_private.push_notification_queue is
  'Private staged notification outbox for Team Messages and shift updates.';

reset statement_timeout;
reset lock_timeout;
