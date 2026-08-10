-- Checkpoint C idempotency and lightweight abuse protection.
-- Repeated system events must not create duplicate messages or audit events.
-- User messages keep client-request idempotency and a conservative rate limit.

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
  where sender_id=p_sender_id
    and message_type='user'
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
