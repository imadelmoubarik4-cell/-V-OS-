-- S93 Messages: every message shows its sender's real name (and photo).
--
-- Production (25 Sep): Messages showed "Team member" for senders and the
-- sidebar/greeting had no name. Root cause: the name set in Team ("Name shown
-- in Atlas") is stored only in atlas_private.team_profile_details.preferred_name,
-- while every gateway and the web shell label people from
-- public.profiles.display_name (S87 rule: _shared/auth.mjs actorLabel).
-- Nothing ever wrote display_name from Team, so it stayed null and actorLabel
-- fell back to "Team member" for the roster, stored sender labels and
-- read receipts.
--
-- 1. atlas_private.safe_staff_name(): the S87 name rule in SQL (trimmed,
--    whitespace collapsed, at most 120 characters, never an address).
-- 2. A trigger keeps public.profiles.display_name equal to the Team name
--    whenever that is set or changed (clearing it leaves display_name alone).
-- 3. A one-off backfill copies existing Team names into display_name.
-- 4. The Messages snapshot's conversation preview (last_message) now carries
--    sender_id and sender_role, so the list resolves the live name as well.
--
-- Stored audit labels (team_messages.sender_label and friends) are history and
-- are not rewritten; the gateway resolves live names by sender_id.
-- Idempotent: every statement can run again with the same result.

create or replace function atlas_private.safe_staff_name(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when cleaned = '' or position('@' in cleaned) > 0 then null
    else left(cleaned, 120)
  end
  from (select btrim(regexp_replace(coalesce(p_value, ''), '[[:space:]]+', ' ', 'g')) as cleaned) as value;
$function$;

revoke all on function atlas_private.safe_staff_name(text) from public, anon, authenticated;
grant execute on function atlas_private.safe_staff_name(text) to service_role;

comment on function atlas_private.safe_staff_name(text) is
  'S87 staff-name rule: trimmed, whitespace collapsed, at most 120 characters, null for blank or email-shaped text.';

create or replace function atlas_private.team_profile_details_sync_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_name text := atlas_private.safe_staff_name(new.preferred_name);
begin
  if v_name is not null then
    update public.profiles as profile
       set display_name = v_name
     where profile.id = new.profile_id
       and profile.display_name is distinct from v_name;
  end if;
  return new;
end;
$function$;

revoke all on function atlas_private.team_profile_details_sync_display_name() from public, anon, authenticated;

comment on function atlas_private.team_profile_details_sync_display_name() is
  'Keeps public.profiles.display_name (the S87 label source) equal to the Team "Name shown in Atlas".';

drop trigger if exists team_profile_details_sync_display_name on atlas_private.team_profile_details;
create trigger team_profile_details_sync_display_name
after insert or update of preferred_name on atlas_private.team_profile_details
for each row execute function atlas_private.team_profile_details_sync_display_name();

-- Backfill: the Team name is the name shown in Atlas.
update public.profiles as profile
   set display_name = atlas_private.safe_staff_name(details.preferred_name)
  from atlas_private.team_profile_details as details
 where details.profile_id = profile.id
   and atlas_private.safe_staff_name(details.preferred_name) is not null
   and profile.display_name is distinct from atlas_private.safe_staff_name(details.preferred_name);

-- Same function as 20260803125226_atlas_team_messages_checkpoint_c.sql (and
-- production), except that last_message carries sender_id and sender_role.
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
            'sender_id',message.sender_id,
            'sender_label',message.sender_label,
            'sender_role',message.sender_role,
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

revoke all on function atlas_private.team_messages_snapshot(uuid,text,uuid[],text,integer) from public, anon, authenticated;
grant execute on function atlas_private.team_messages_snapshot(uuid,text,uuid[],text,integer) to service_role;
