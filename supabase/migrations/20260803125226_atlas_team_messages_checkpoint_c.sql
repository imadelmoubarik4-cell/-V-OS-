-- Checkpoint C - private VÁ team messages.
-- Active profile authorization is enforced by the Edge Function on every request.
-- Browser roles have no direct access to these tables or RPCs.

create table if not exists atlas_private.team_channels (
  id uuid primary key default gen_random_uuid(),
  channel_key text not null unique,
  name text not null,
  description text,
  icon text not null default 'message-circle',
  tone text not null default 'neutral'
    check (tone in ('neutral','operations','handover','announcement','marketing')),
  manager_post_only boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(channel_key) between 2 and 64),
  check (char_length(name) between 1 and 80)
);

create table if not exists atlas_private.team_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references atlas_private.team_channels(id) on delete cascade,
  client_request_id uuid unique,
  system_event_key text unique,
  message_type text not null default 'user'
    check (message_type in ('user','system')),
  sender_id uuid,
  sender_label text not null,
  sender_role text not null,
  body text not null,
  link_type text not null default 'none'
    check (link_type in ('none','inventory_item','routine','shift','brain_recommendation')),
  link_key text,
  link_label text,
  link_route text,
  link_metadata jsonb not null default '{}'::jsonb,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_label text,
  delete_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(body) <= 4000),
  check (
    (link_type='none' and link_key is null and link_label is null)
    or
    (link_type<>'none' and link_key is not null and link_label is not null)
  ),
  check (
    (message_type='system' and client_request_id is null)
    or
    (message_type='user' and client_request_id is not null and sender_id is not null)
  )
);

create table if not exists atlas_private.team_message_revisions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references atlas_private.team_messages(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  previous_body text not null,
  new_body text,
  change_type text not null check (change_type in ('edit','delete')),
  changed_by uuid,
  changed_by_label text not null,
  changed_by_role text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (message_id,revision_number)
);

create table if not exists atlas_private.team_channel_reads (
  channel_id uuid not null references atlas_private.team_channels(id) on delete cascade,
  user_id uuid not null,
  user_label text not null,
  user_role text not null,
  last_read_at timestamptz not null default now(),
  last_read_message_id uuid references atlas_private.team_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (channel_id,user_id)
);

create table if not exists atlas_private.team_message_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('message_sent','message_edited','message_deleted','system_message_sent')),
  message_id uuid references atlas_private.team_messages(id) on delete set null,
  channel_id uuid references atlas_private.team_channels(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists team_channels_active_order_idx
  on atlas_private.team_channels(active,sort_order);
create index if not exists team_messages_channel_created_idx
  on atlas_private.team_messages(channel_id,created_at desc);
create index if not exists team_messages_sender_created_idx
  on atlas_private.team_messages(sender_id,created_at desc)
  where sender_id is not null;
create index if not exists team_messages_visible_idx
  on atlas_private.team_messages(channel_id,created_at desc)
  where deleted_at is null;
create index if not exists team_message_revisions_message_idx
  on atlas_private.team_message_revisions(message_id,revision_number desc);
create index if not exists team_channel_reads_user_idx
  on atlas_private.team_channel_reads(user_id,updated_at desc);
create index if not exists team_channel_reads_last_message_idx
  on atlas_private.team_channel_reads(last_read_message_id)
  where last_read_message_id is not null;
create index if not exists team_message_events_message_idx
  on atlas_private.team_message_events(message_id,created_at desc)
  where message_id is not null;
create index if not exists team_message_events_channel_idx
  on atlas_private.team_message_events(channel_id,created_at desc)
  where channel_id is not null;

alter table atlas_private.team_channels enable row level security;
alter table atlas_private.team_messages enable row level security;
alter table atlas_private.team_message_revisions enable row level security;
alter table atlas_private.team_channel_reads enable row level security;
alter table atlas_private.team_message_events enable row level security;

drop policy if exists "service role manages team channels" on atlas_private.team_channels;
create policy "service role manages team channels"
  on atlas_private.team_channels for all to service_role using (true) with check (true);
drop policy if exists "service role manages team messages" on atlas_private.team_messages;
create policy "service role manages team messages"
  on atlas_private.team_messages for all to service_role using (true) with check (true);
drop policy if exists "service role manages message revisions" on atlas_private.team_message_revisions;
create policy "service role manages message revisions"
  on atlas_private.team_message_revisions for all to service_role using (true) with check (true);
drop policy if exists "service role manages channel reads" on atlas_private.team_channel_reads;
create policy "service role manages channel reads"
  on atlas_private.team_channel_reads for all to service_role using (true) with check (true);
drop policy if exists "service role manages message events" on atlas_private.team_message_events;
create policy "service role manages message events"
  on atlas_private.team_message_events for all to service_role using (true) with check (true);

revoke all on atlas_private.team_channels from public,anon,authenticated;
revoke all on atlas_private.team_messages from public,anon,authenticated;
revoke all on atlas_private.team_message_revisions from public,anon,authenticated;
revoke all on atlas_private.team_channel_reads from public,anon,authenticated;
revoke all on atlas_private.team_message_events from public,anon,authenticated;
grant all on atlas_private.team_channels to service_role;
grant all on atlas_private.team_messages to service_role;
grant all on atlas_private.team_message_revisions to service_role;
grant all on atlas_private.team_channel_reads to service_role;
grant all on atlas_private.team_message_events to service_role;

drop trigger if exists team_channels_touch on atlas_private.team_channels;
create trigger team_channels_touch before update on atlas_private.team_channels
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists team_messages_touch on atlas_private.team_messages;
create trigger team_messages_touch before update on atlas_private.team_messages
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists team_channel_reads_touch on atlas_private.team_channel_reads;
create trigger team_channel_reads_touch before update on atlas_private.team_channel_reads
  for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.team_channels (
  channel_key,name,description,icon,tone,manager_post_only,active,sort_order
) values
  ('general','General','Everyday team communication and shared updates.','messages-square','neutral',false,true,10),
  ('operations','Operations','Cleaning, inventory, maintenance and service operations.','gauge','operations',false,true,20),
  ('shift-handover','Shift handover','What the next shift needs to know before taking over.','repeat-2','handover',false,true,30),
  ('announcements','Announcements','Official management notices for the whole active team.','megaphone','announcement',true,true,40),
  ('marketing','Marketing','Content ideas, campaigns, events and social-media coordination.','send','marketing',false,true,50)
on conflict (channel_key) do update set
  name=excluded.name,
  description=excluded.description,
  icon=excluded.icon,
  tone=excluded.tone,
  manager_post_only=excluded.manager_post_only,
  active=excluded.active,
  sort_order=excluded.sort_order,
  updated_at=now();

create or replace function atlas_private.team_messages_snapshot(
  p_user_id uuid,
  p_user_role text,
  p_active_user_ids uuid[],
  p_channel_key text,
  p_limit integer default 60
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  selected_channel atlas_private.team_channels;
  channels_json jsonb := '[]'::jsonb;
  messages_json jsonb := '[]'::jsonb;
  total_unread bigint := 0;
  safe_limit integer := greatest(1,least(coalesce(p_limit,60),100));
begin
  select * into selected_channel
  from atlas_private.team_channels
  where active=true and channel_key=coalesce(nullif(trim(p_channel_key),''),'general')
  limit 1;

  if not found then
    select * into selected_channel
    from atlas_private.team_channels
    where active=true
    order by sort_order,channel_key
    limit 1;
  end if;

  select coalesce(jsonb_agg(row_data.channel_json order by row_data.sort_order),'[]'::jsonb),
         coalesce(sum(row_data.unread_count),0)
  into channels_json,total_unread
  from (
    select
      channel.sort_order,
      (
        select count(*)
        from atlas_private.team_messages message
        where message.channel_id=channel.id
          and message.deleted_at is null
          and message.sender_id is distinct from p_user_id
          and message.created_at > coalesce(read_state.last_read_at,'epoch'::timestamptz)
      )::bigint as unread_count,
      jsonb_build_object(
        'id',channel.id,
        'key',channel.channel_key,
        'name',channel.name,
        'description',channel.description,
        'icon',channel.icon,
        'tone',channel.tone,
        'manager_post_only',channel.manager_post_only,
        'can_post',(not channel.manager_post_only or p_user_role in ('admin','manager')),
        'unread_count',(
          select count(*)
          from atlas_private.team_messages message
          where message.channel_id=channel.id
            and message.deleted_at is null
            and message.sender_id is distinct from p_user_id
            and message.created_at > coalesce(read_state.last_read_at,'epoch'::timestamptz)
        ),
        'last_read_at',read_state.last_read_at,
        'last_message',(
          select jsonb_build_object(
            'id',message.id,
            'sender_label',message.sender_label,
            'body',case when message.deleted_at is null then left(message.body,140) else 'Message deleted' end,
            'message_type',message.message_type,
            'created_at',message.created_at,
            'deleted',message.deleted_at is not null
          )
          from atlas_private.team_messages message
          where message.channel_id=channel.id
          order by message.created_at desc
          limit 1
        )
      ) as channel_json
    from atlas_private.team_channels channel
    left join atlas_private.team_channel_reads read_state
      on read_state.channel_id=channel.id and read_state.user_id=p_user_id
    where channel.active=true
  ) row_data;

  if selected_channel.id is not null then
    select coalesce(jsonb_agg(row_data.message_json order by row_data.created_at),'[]'::jsonb)
    into messages_json
    from (
      select
        message.created_at,
        jsonb_build_object(
          'id',message.id,
          'channel_id',message.channel_id,
          'message_type',message.message_type,
          'sender_id',message.sender_id,
          'sender_label',message.sender_label,
          'sender_role',message.sender_role,
          'body',case when message.deleted_at is null then message.body else null end,
          'deleted',message.deleted_at is not null,
          'delete_reason',case when p_user_role in ('admin','manager') then message.delete_reason else null end,
          'created_at',message.created_at,
          'edited_at',message.edited_at,
          'is_own',message.sender_id=p_user_id,
          'can_edit',(
            message.message_type='user'
            and message.deleted_at is null
            and message.sender_id=p_user_id
            and message.created_at >= pg_catalog.now()-interval '15 minutes'
          ),
          'can_delete',(
            message.deleted_at is null
            and (
              (message.sender_id=p_user_id and message.created_at >= pg_catalog.now()-interval '15 minutes')
              or p_user_role in ('admin','manager')
            )
          ),
          'link',case when message.link_type='none' then null else jsonb_build_object(
            'type',message.link_type,
            'key',message.link_key,
            'label',message.link_label,
            'route',message.link_route,
            'metadata',message.link_metadata
          ) end,
          'read_by',coalesce((
            select jsonb_agg(jsonb_build_object(
              'user_id',reader.user_id,
              'user_label',reader.user_label,
              'user_role',reader.user_role,
              'read_at',reader.last_read_at
            ) order by reader.last_read_at)
            from atlas_private.team_channel_reads reader
            where reader.channel_id=message.channel_id
              and reader.user_id is distinct from message.sender_id
              and reader.last_read_at >= message.created_at
              and (
                p_active_user_ids is null
                or cardinality(p_active_user_ids)=0
                or reader.user_id=any(p_active_user_ids)
              )
          ),'[]'::jsonb),
          'read_by_count',(
            select count(*)
            from atlas_private.team_channel_reads reader
            where reader.channel_id=message.channel_id
              and reader.user_id is distinct from message.sender_id
              and reader.last_read_at >= message.created_at
              and (
                p_active_user_ids is null
                or cardinality(p_active_user_ids)=0
                or reader.user_id=any(p_active_user_ids)
              )
          )
        ) as message_json
      from (
        select *
        from atlas_private.team_messages
        where channel_id=selected_channel.id
        order by created_at desc
        limit safe_limit
      ) message
    ) row_data;
  end if;

  return jsonb_build_object(
    'version','atlas-team-messages/0.1.0',
    'generated_at',pg_catalog.now(),
    'selected_channel_key',selected_channel.channel_key,
    'channels',channels_json,
    'messages',messages_json,
    'summary',jsonb_build_object(
      'total_unread',total_unread,
      'active_channels',jsonb_array_length(channels_json),
      'active_members',coalesce(cardinality(p_active_user_ids),0)
    ),
    'policy',jsonb_build_object(
      'delivery_mode','secure_polling',
      'poll_after_ms',6000,
      'inactive_profiles_denied_by_gateway',true,
      'announcement_posting','manager_or_admin',
      'author_edit_window_minutes',15,
      'soft_delete_with_audit',true,
      'direct_browser_table_access',false
    )
  );
end;
$$;

create or replace function atlas_private.team_messages_send(
  p_channel_key text,
  p_body text,
  p_sender_id uuid,
  p_sender_label text,
  p_sender_role text,
  p_client_request_id uuid,
  p_link_type text,
  p_link_key text,
  p_link_label text,
  p_link_route text,
  p_link_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  existing_row atlas_private.team_messages;
  message_row atlas_private.team_messages;
  clean_body text := trim(coalesce(p_body,''));
  clean_link_type text := coalesce(nullif(trim(p_link_type),''),'none');
  recent_message_count bigint;
begin
  if p_sender_id is null or p_client_request_id is null then
    raise exception 'Sender and client request ID are required';
  end if;
  if p_sender_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Sender role is invalid';
  end if;
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'Message must contain between 1 and 4000 characters';
  end if;

  select * into existing_row
  from atlas_private.team_messages
  where client_request_id=p_client_request_id;
  if found then
    return jsonb_build_object('duplicate',true,'message_id',existing_row.id,'created_at',existing_row.created_at);
  end if;

  select count(*) into recent_message_count
  from atlas_private.team_messages
  where sender_id=p_sender_id and message_type='user'
    and created_at>pg_catalog.now()-interval '1 minute';
  if recent_message_count>=20 then
    raise exception 'Message rate limit reached. Wait a moment and try again';
  end if;

  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'Channel not found or inactive'; end if;
  if channel_row.manager_post_only and p_sender_role not in ('admin','manager') then
    raise exception 'Only managers can post in Announcements';
  end if;

  if clean_link_type not in ('none','inventory_item','routine','shift','brain_recommendation') then
    raise exception 'Message link type is invalid';
  end if;
  if clean_link_type='none' then
    p_link_key := null;
    p_link_label := null;
    p_link_route := null;
    p_link_metadata := '{}'::jsonb;
  elsif nullif(trim(coalesce(p_link_key,'')),'') is null
     or nullif(trim(coalesce(p_link_label,'')),'') is null then
    raise exception 'Linked messages require a verified target and label';
  end if;

  insert into atlas_private.team_messages (
    channel_id,client_request_id,message_type,sender_id,sender_label,sender_role,body,
    link_type,link_key,link_label,link_route,link_metadata
  ) values (
    channel_row.id,p_client_request_id,'user',p_sender_id,p_sender_label,p_sender_role,clean_body,
    clean_link_type,p_link_key,p_link_label,p_link_route,coalesce(p_link_metadata,'{}'::jsonb)
  ) returning * into message_row;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_sent',message_row.id,channel_row.id,p_sender_id,p_sender_label,p_sender_role,
    jsonb_build_object('channel_key',channel_row.channel_key,'link_type',clean_link_type)
  );

  return jsonb_build_object('duplicate',false,'message_id',message_row.id,'created_at',message_row.created_at);
end;
$$;

create or replace function atlas_private.team_messages_edit(
  p_message_id uuid,
  p_body text,
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
  message_row atlas_private.team_messages;
  revision_no integer;
  clean_body text := trim(coalesce(p_body,''));
begin
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'Message must contain between 1 and 4000 characters';
  end if;

  select * into message_row from atlas_private.team_messages where id=p_message_id for update;
  if not found then raise exception 'Message not found'; end if;
  if message_row.deleted_at is not null then raise exception 'Deleted messages cannot be edited'; end if;
  if message_row.message_type<>'user' then raise exception 'System messages cannot be edited'; end if;
  if message_row.sender_id<>p_actor_id then raise exception 'Only the original author can edit this message'; end if;
  if message_row.created_at < pg_catalog.now()-interval '15 minutes' then
    raise exception 'The 15-minute edit window has closed';
  end if;
  if message_row.body=clean_body then
    return jsonb_build_object('message_id',message_row.id,'unchanged',true);
  end if;

  select coalesce(max(revision_number),0)+1 into revision_no
  from atlas_private.team_message_revisions where message_id=message_row.id;

  insert into atlas_private.team_message_revisions (
    message_id,revision_number,previous_body,new_body,change_type,
    changed_by,changed_by_label,changed_by_role
  ) values (
    message_row.id,revision_no,message_row.body,clean_body,'edit',
    p_actor_id,p_actor_label,p_actor_role
  );

  update atlas_private.team_messages
  set body=clean_body,edited_at=pg_catalog.now()
  where id=message_row.id;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_edited',message_row.id,message_row.channel_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('revision_number',revision_no)
  );

  return jsonb_build_object('message_id',message_row.id,'edited',true,'revision_number',revision_no);
end;
$$;

create or replace function atlas_private.team_messages_delete(
  p_message_id uuid,
  p_reason text,
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
  message_row atlas_private.team_messages;
  revision_no integer;
  is_manager boolean := p_actor_role in ('admin','manager');
  clean_reason text := nullif(trim(coalesce(p_reason,'')),'');
begin
  select * into message_row from atlas_private.team_messages where id=p_message_id for update;
  if not found then raise exception 'Message not found'; end if;
  if message_row.deleted_at is not null then
    return jsonb_build_object('message_id',message_row.id,'already_deleted',true);
  end if;
  if message_row.message_type='system' and not is_manager then
    raise exception 'Only managers can remove a system message';
  end if;
  if message_row.sender_id is distinct from p_actor_id and not is_manager then
    raise exception 'Only the author or a manager can delete this message';
  end if;
  if message_row.sender_id=p_actor_id and not is_manager
     and message_row.created_at < pg_catalog.now()-interval '15 minutes' then
    raise exception 'The 15-minute delete window has closed';
  end if;
  if message_row.sender_id is distinct from p_actor_id and clean_reason is null then
    raise exception 'A manager reason is required when deleting another person''s message';
  end if;

  select coalesce(max(revision_number),0)+1 into revision_no
  from atlas_private.team_message_revisions where message_id=message_row.id;

  insert into atlas_private.team_message_revisions (
    message_id,revision_number,previous_body,new_body,change_type,
    changed_by,changed_by_label,changed_by_role,reason
  ) values (
    message_row.id,revision_no,message_row.body,null,'delete',
    p_actor_id,p_actor_label,p_actor_role,clean_reason
  );

  update atlas_private.team_messages
  set body='',deleted_at=pg_catalog.now(),deleted_by=p_actor_id,
      deleted_by_label=p_actor_label,delete_reason=clean_reason
  where id=message_row.id;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_id,actor_label,actor_role,payload
  ) values (
    'message_deleted',message_row.id,message_row.channel_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('revision_number',revision_no,'reason',clean_reason,'author_deleted',message_row.sender_id=p_actor_id)
  );

  return jsonb_build_object('message_id',message_row.id,'deleted',true,'revision_number',revision_no);
end;
$$;

create or replace function atlas_private.team_messages_mark_read(
  p_channel_key text,
  p_user_id uuid,
  p_user_label text,
  p_user_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  latest_message atlas_private.team_messages;
  read_time timestamptz := pg_catalog.now();
begin
  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'Channel not found or inactive'; end if;

  select * into latest_message
  from atlas_private.team_messages
  where channel_id=channel_row.id
  order by created_at desc
  limit 1;

  insert into atlas_private.team_channel_reads (
    channel_id,user_id,user_label,user_role,last_read_at,last_read_message_id
  ) values (
    channel_row.id,p_user_id,p_user_label,p_user_role,read_time,latest_message.id
  )
  on conflict (channel_id,user_id) do update set
    user_label=excluded.user_label,
    user_role=excluded.user_role,
    last_read_at=greatest(atlas_private.team_channel_reads.last_read_at,excluded.last_read_at),
    last_read_message_id=excluded.last_read_message_id,
    updated_at=pg_catalog.now();

  return jsonb_build_object(
    'channel_key',channel_row.channel_key,
    'last_read_at',read_time,
    'last_read_message_id',latest_message.id
  );
end;
$$;

create or replace function atlas_private.team_messages_post_system(
  p_channel_key text,
  p_system_event_key text,
  p_body text,
  p_link_type text,
  p_link_key text,
  p_link_label text,
  p_link_route text,
  p_link_metadata jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  channel_row atlas_private.team_channels;
  message_id uuid;
  clean_body text := trim(coalesce(p_body,''));
begin
  if nullif(trim(coalesce(p_system_event_key,'')),'') is null then
    raise exception 'System event key is required';
  end if;
  if char_length(clean_body)<1 or char_length(clean_body)>4000 then
    raise exception 'System message must contain between 1 and 4000 characters';
  end if;

  select * into channel_row
  from atlas_private.team_channels
  where active=true and channel_key=p_channel_key;
  if not found then raise exception 'System message channel not found'; end if;

  insert into atlas_private.team_messages (
    channel_id,system_event_key,message_type,sender_id,sender_label,sender_role,body,
    link_type,link_key,link_label,link_route,link_metadata
  ) values (
    channel_row.id,p_system_event_key,'system',null,'Atlas Operations','system',clean_body,
    p_link_type,p_link_key,p_link_label,p_link_route,coalesce(p_link_metadata,'{}'::jsonb)
  )
  on conflict (system_event_key) do nothing
  returning id into message_id;

  if message_id is null then
    select id into message_id
    from atlas_private.team_messages
    where system_event_key=p_system_event_key;
    return message_id;
  end if;

  insert into atlas_private.team_message_events (
    event_type,message_id,channel_id,actor_label,actor_role,payload
  ) values (
    'system_message_sent',message_id,channel_row.id,'Atlas Operations','system',
    jsonb_build_object('system_event_key',p_system_event_key,'link_type',p_link_type)
  );

  return message_id;
end;
$$;

-- A completed operational routine posts one idempotent, linked system update.
create or replace function atlas_private.complete_routine(
  p_instance_id uuid,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_row atlas_private.routine_templates;
  incomplete_count bigint;
  missing_temperatures bigint;
  required_count bigint := 0;
  completed_count bigint := 0;
  maintenance_count bigint := 0;
  system_body text;
begin
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  select * into template_row from atlas_private.routine_templates where id=instance_row.template_id;

  if template_row.routine_type='temperature' then
    select count(*) into missing_temperatures
    from atlas_private.temperature_points point
    where point.active=true and not exists (
      select 1 from atlas_private.temperature_logs log
      where log.point_id=point.id and log.reading_date=instance_row.scheduled_date
    );
    if missing_temperatures>0 then
      raise exception '% temperature points still need a reading',missing_temperatures;
    end if;
    select count(*) into required_count from atlas_private.temperature_points where active=true;
    completed_count := required_count;
  else
    select count(*) into incomplete_count
    from atlas_private.routine_template_items item
    where item.template_id=instance_row.template_id and item.active=true and item.required=true
      and not exists (
        select 1 from atlas_private.routine_item_results result
        where result.instance_id=instance_row.id
          and result.template_item_id=item.id
          and result.completed=true
      );
    if incomplete_count>0 then
      raise exception '% required checklist items are incomplete',incomplete_count;
    end if;

    select
      count(*) filter (where item.required and item.active),
      count(*) filter (where item.required and item.active and coalesce(result.completed,false)),
      count(*) filter (
        where item.evidence_type='maintenance'
          and nullif(trim(coalesce(result.note,'')),'') is not null
      )
    into required_count,completed_count,maintenance_count
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance_row.id
    where item.template_id=instance_row.template_id;
  end if;

  update atlas_private.routine_instances
  set status='completed',completed_at=pg_catalog.now(),completed_by=p_actor_id,
      completed_by_label=p_actor_label,completion_notes=nullif(trim(coalesce(p_notes,'')),'')
  where id=p_instance_id;

  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_completed','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object('notes',p_notes,'template_key',template_row.template_key));

  system_body := template_row.name || ' completed' || E'\n'
    || coalesce(nullif(trim(p_actor_label),''),'A team member') || ' completed '
    || completed_count || ' of ' || required_count || ' items.';
  if maintenance_count>0 then
    system_body := system_body || E'\n' || maintenance_count || ' maintenance item'
      || case when maintenance_count=1 then '' else 's' end || ' require manager review.';
  end if;

  begin
    perform atlas_private.team_messages_post_system(
      'operations',
      'routine-completed:'||p_instance_id::text,
      system_body,
      'routine',
      p_instance_id::text,
      template_row.name,
      'operations',
      jsonb_build_object(
        'scheduled_date',instance_row.scheduled_date,
        'completed_count',completed_count,
        'required_count',required_count,
        'maintenance_count',maintenance_count,
        'completed_by',p_actor_label
      )
    );
  exception when others then
    insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
    values ('team_message_failed','routine_instance',p_instance_id,p_actor_id,p_actor_label,
      jsonb_build_object('error',sqlerrm,'template_key',template_row.template_key));
  end;

  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

create or replace function public.atlas_team_messages_snapshot(
  p_user_id uuid,p_user_role text,p_active_user_ids uuid[],p_channel_key text,p_limit integer
)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.team_messages_snapshot(p_user_id,p_user_role,p_active_user_ids,p_channel_key,p_limit); $$;

create or replace function public.atlas_team_messages_send(
  p_channel_key text,p_body text,p_sender_id uuid,p_sender_label text,p_sender_role text,
  p_client_request_id uuid,p_link_type text,p_link_key text,p_link_label text,p_link_route text,p_link_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_send(p_channel_key,p_body,p_sender_id,p_sender_label,p_sender_role,p_client_request_id,p_link_type,p_link_key,p_link_label,p_link_route,p_link_metadata); $$;

create or replace function public.atlas_team_messages_edit(
  p_message_id uuid,p_body text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_edit(p_message_id,p_body,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_team_messages_delete(
  p_message_id uuid,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_delete(p_message_id,p_reason,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_team_messages_mark_read(
  p_channel_key text,p_user_id uuid,p_user_label text,p_user_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.team_messages_mark_read(p_channel_key,p_user_id,p_user_label,p_user_role); $$;

revoke execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) to service_role;
grant execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) to service_role;

comment on table atlas_private.team_channels is
  'Private VÁ staff channels. Announcement posting is manager-only.';
comment on table atlas_private.team_messages is
  'Private staff messages with soft deletion, verified links and immutable audit history.';
comment on table atlas_private.team_channel_reads is
  'Per-user channel read cursor used for unread counts and message read status.';
comment on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) is
  'Service-role-only messaging snapshot; active-profile authorization is enforced by the gateway.';
