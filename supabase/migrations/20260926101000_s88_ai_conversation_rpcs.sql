-- S88 Atlas AI service RPCs: actor check, conversations, messages, runs,
-- tool-call audit, media metadata, preferences, settings and rate limit.
--
-- Contract (docs/ai/Atlas_AI_Architecture.md §6, §7, §12, §13):
-- * Every public.atlas_ai_* function is executable by service_role only.
-- * Functions are SECURITY INVOKER with search_path = '' (repository
--   convention for service-role RPCs): if execute were ever granted to a
--   browser role by mistake, the atlas_private tables would still refuse it.
-- * The gateway passes the verified actor (p_actor_id, p_actor_role). SQL
--   re-checks that the profile exists, is active and holds exactly that role,
--   then enforces ownership: a user only reads or changes their own
--   conversations, messages, runs, media and preferences. Managers do not
--   read other users' conversations.
-- * Errors are raised with a stable message prefix the gateway maps to HTTP:
--     'forbidden: …'         SQLSTATE 42501
--     'not_found: …'         SQLSTATE P0002 (also used for other users' rows)
--     'invalid_arguments: …' SQLSTATE 22023
--     'conflict: …'          SQLSTATE 55000

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Helpers -------------------------------------------------------------------

create or replace function atlas_private.ai_require_actor(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_role text;
begin
  if p_actor_id is null or nullif(btrim(coalesce(p_actor_role, '')), '') is null then
    raise exception using errcode = '42501', message = 'forbidden: a verified actor is required';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = p_actor_id and profile.active is true;
  if v_role is null or v_role is distinct from p_actor_role then
    raise exception using errcode = '42501', message = 'forbidden: actor is not an active profile with this role';
  end if;
  return v_role;
end;
$$;

create or replace function atlas_private.ai_invalid(p_message text)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '22023', message = 'invalid_arguments: ' || p_message;
end;
$$;

-- Owned conversation lookup. Another user's conversation is reported as
-- not found so its existence is not disclosed.
create or replace function atlas_private.ai_owned_conversation(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_lock boolean default false
)
returns atlas_private.ai_conversations
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_conversations;
begin
  if p_lock then
    select * into v_row from atlas_private.ai_conversations c
    where c.id = p_conversation_id and c.user_id = p_actor_id
    for update;
  else
    select * into v_row from atlas_private.ai_conversations c
    where c.id = p_conversation_id and c.user_id = p_actor_id;
  end if;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found: conversation';
  end if;
  return v_row;
end;
$$;

-- Prefix full-text query built from the same 'simple' tokens the indexes use.
-- p_all = true joins terms with AND (conversation search); false with OR
-- (natural-language questions, ranked). Returns null when nothing is searchable.
create or replace function atlas_private.ai_tsquery(p_query text, p_all boolean default true)
returns tsquery
language sql
immutable
security invoker
set search_path = ''
as $$
  select case when count(*) = 0 then null else
    pg_catalog.to_tsquery('simple'::regconfig,
      string_agg(pg_catalog.quote_literal(token.lexeme) || ':*',
                 case when coalesce(p_all, true) then ' & ' else ' | ' end))
  end
  from (
    select lexeme
    from pg_catalog.unnest(pg_catalog.to_tsvector('simple'::regconfig, left(coalesce(p_query, ''), 500)))
    where char_length(lexeme) between 1 and 64 and lexeme !~ '[''\\\\]'
    order by lexeme
    limit 16
  ) token;
$$;

create or replace function atlas_private.ai_conversation_json(p_row atlas_private.ai_conversations)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'title', p_row.title,
    'pinned', p_row.pinned,
    'archived', p_row.archived,
    'context', p_row.context,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at,
    'last_message_at', p_row.last_message_at
  );
$$;

create or replace function atlas_private.ai_message_json(p_row atlas_private.ai_messages, p_include_items boolean default false)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'conversation_id', p_row.conversation_id,
    'role', p_row.role,
    'content', p_row.content,
    'source', p_row.source,
    'attachments', p_row.attachments,
    'evidence', p_row.evidence,
    'records', p_row.records,
    'proposals', p_row.proposals,
    'metadata', p_row.metadata,
    'run_id', p_row.run_id,
    'status', p_row.status,
    'client_request_id', p_row.client_request_id,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at
  ) || case when coalesce(p_include_items, false) then jsonb_build_object('items', p_row.items) else '{}'::jsonb end;
$$;

create or replace function atlas_private.ai_media_json(p_row atlas_private.ai_media)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'conversation_id', p_row.conversation_id,
    'bucket', p_row.bucket,
    'path', p_row.path,
    'mime', p_row.mime,
    'bytes', p_row.bytes,
    'kind', p_row.kind,
    'sha256', p_row.sha256,
    'expires_at', p_row.expires_at,
    'deleted_at', p_row.deleted_at,
    'created_at', p_row.created_at
  );
$$;

create or replace function atlas_private.ai_clean_title(p_title text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 200), '');
$$;

-- Conversations ---------------------------------------------------------------

create or replace function public.atlas_ai_conversations_list(
  p_actor_id uuid,
  p_actor_role text,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 30,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 100000));
  v_has_text boolean := nullif(btrim(coalesce(p_query, '')), '') is not null;
  v_query tsquery := atlas_private.ai_tsquery(p_query, true);
  v_rows jsonb;
  v_total bigint;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if v_has_text and v_query is null then
    return jsonb_build_object('conversations', '[]'::jsonb, 'total', 0, 'has_more', false,
      'query', p_query, 'limit', v_limit, 'offset', v_offset);
  end if;

  with visible as (
    select c as conv, c.id, c.pinned, c.last_message_at, c.search
    from atlas_private.ai_conversations c
    where c.user_id = p_actor_id
      and (coalesce(p_include_archived, false) or not c.archived)
      and (
        v_query is null
        or c.search @@ v_query
        or exists (
          select 1 from atlas_private.ai_messages m
          where m.conversation_id = c.id and m.search @@ v_query
        )
      )
  ), counted as (
    select v.*, count(*) over () as total_rows
    from visible v
    order by v.pinned desc, v.last_message_at desc, v.id
    limit v_limit offset v_offset
  )
  select
    coalesce(jsonb_agg(
      atlas_private.ai_conversation_json(counted.conv)
      || jsonb_build_object(
        'message_count', (select count(*) from atlas_private.ai_messages m where m.conversation_id = counted.id),
        'last_message_preview', (
          select left(m.content, 160) from atlas_private.ai_messages m
          where m.conversation_id = counted.id and m.role in ('user','assistant') and m.content <> ''
          order by m.created_at desc, m.id desc limit 1
        ),
        'snippet', case when v_query is null then null else (
          select pg_catalog.ts_headline('simple'::regconfig, left(m.content, 5000), v_query,
            'MaxWords=24, MinWords=8, MaxFragments=1, StartSel=**, StopSel=**')
          from atlas_private.ai_messages m
          where m.conversation_id = counted.id and m.search @@ v_query
          order by pg_catalog.ts_rank(m.search, v_query) desc, m.created_at desc
          limit 1
        ) end,
        'title_match', case when v_query is null then null else counted.search @@ v_query end
      )
      order by counted.pinned desc, counted.last_message_at desc, counted.id
    ), '[]'::jsonb),
    coalesce(max(counted.total_rows), 0)
  into v_rows, v_total
  from counted;

  if v_total = 0 and v_offset > 0 then
    select count(*) into v_total
    from atlas_private.ai_conversations c
    where c.user_id = p_actor_id
      and (coalesce(p_include_archived, false) or not c.archived)
      and (v_query is null or c.search @@ v_query or exists (
        select 1 from atlas_private.ai_messages m where m.conversation_id = c.id and m.search @@ v_query));
  end if;

  return jsonb_build_object(
    'conversations', v_rows,
    'total', v_total,
    'has_more', v_offset + jsonb_array_length(v_rows) < v_total,
    'query', p_query,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$$;

create or replace function public.atlas_ai_conversation_create(
  p_actor_id uuid,
  p_actor_role text,
  p_title text default null,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_conversations;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_context is not null and jsonb_typeof(p_context) <> 'object' then
    perform atlas_private.ai_invalid('context must be a JSON object');
  end if;
  insert into atlas_private.ai_conversations (user_id, title, context)
  values (p_actor_id, coalesce(atlas_private.ai_clean_title(p_title), 'New conversation'), coalesce(p_context, '{}'::jsonb))
  returning * into v_row;
  return atlas_private.ai_conversation_json(v_row);
end;
$$;

create or replace function public.atlas_ai_conversation_get(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 50,
  p_before_id uuid default null,
  p_include_items boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_conv atlas_private.ai_conversations;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_cursor atlas_private.ai_messages;
  v_messages jsonb;
  v_count integer;
  v_has_more boolean;
  v_oldest uuid;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_conv from atlas_private.ai_conversations c
  where c.id = p_conversation_id and c.user_id = p_actor_id;
  if v_conv.id is null then
    raise exception using errcode = 'P0002', message = 'not_found: conversation';
  end if;

  if p_before_id is not null then
    select * into v_cursor from atlas_private.ai_messages m
    where m.id = p_before_id and m.conversation_id = v_conv.id;
    if v_cursor.id is null then
      perform atlas_private.ai_invalid('before_id is not a message in this conversation');
    end if;
  end if;

  with page as (
    select m as msg, m.id, m.created_at
    from atlas_private.ai_messages m
    where m.conversation_id = v_conv.id
      and (v_cursor.id is null or (m.created_at, m.id) < (v_cursor.created_at, v_cursor.id))
    order by m.created_at desc, m.id desc
    limit v_limit + 1
  ), trimmed as (
    select * from page order by created_at desc, id desc limit v_limit
  )
  select
    coalesce(jsonb_agg(atlas_private.ai_message_json(t.msg, p_include_items) order by t.created_at, t.id), '[]'::jsonb),
    count(*),
    (select count(*) from page) > v_limit,
    (array_agg(t.id order by t.created_at, t.id))[1]
  into v_messages, v_count, v_has_more, v_oldest
  from trimmed t;

  return jsonb_build_object(
    'conversation', atlas_private.ai_conversation_json(v_conv),
    'messages', v_messages,
    'has_more', coalesce(v_has_more, false),
    'next_before_id', case when coalesce(v_has_more, false) then v_oldest else null end,
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'message_id', a.message_id, 'kind', a.kind, 'title', a.title,
        'preview', a.preview, 'required_roles', to_jsonb(a.required_roles),
        'status', case when a.status = 'proposed' and a.expires_at <= pg_catalog.now() then 'expired' else a.status end,
        'expires_at', a.expires_at, 'decided_at', a.decided_at, 'finished_at', a.finished_at,
        'result', a.result, 'error', a.error, 'created_at', a.created_at
      ) order by a.created_at, a.id)
      from atlas_private.ai_actions a
      where a.conversation_id = v_conv.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.atlas_ai_conversation_rename(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_title text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_conversations;
  v_title text := atlas_private.ai_clean_title(p_title);
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if v_title is null then perform atlas_private.ai_invalid('title is required'); end if;
  perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, true);
  update atlas_private.ai_conversations c set title = v_title
  where c.id = p_conversation_id and c.user_id = p_actor_id
  returning * into v_row;
  return atlas_private.ai_conversation_json(v_row);
end;
$$;

create or replace function public.atlas_ai_conversation_pin(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_pinned boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_conversations;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, true);
  update atlas_private.ai_conversations c set pinned = coalesce(p_pinned, false)
  where c.id = p_conversation_id and c.user_id = p_actor_id
  returning * into v_row;
  return atlas_private.ai_conversation_json(v_row);
end;
$$;

create or replace function public.atlas_ai_conversation_archive(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_archived boolean default true
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_conversations;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, true);
  update atlas_private.ai_conversations c
  set archived = coalesce(p_archived, true),
      pinned = case when coalesce(p_archived, true) then false else c.pinned end
  where c.id = p_conversation_id and c.user_id = p_actor_id
  returning * into v_row;
  return atlas_private.ai_conversation_json(v_row);
end;
$$;

-- Hard delete. Messages, runs' links, tool calls' links and proposals follow
-- the foreign keys; media rows are kept (user_id) and expire now so the
-- purge job removes the storage objects.
create or replace function public.atlas_ai_conversation_delete(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_media jsonb;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, true);

  with marked as (
    update atlas_private.ai_media media
    set expires_at = pg_catalog.now()
    where media.conversation_id = p_conversation_id
      and media.user_id = p_actor_id
      and media.deleted_at is null
    returning media.id, media.bucket, media.path
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'bucket', bucket, 'path', path) order by path), '[]'::jsonb)
  into v_media from marked;

  delete from atlas_private.ai_conversations c
  where c.id = p_conversation_id and c.user_id = p_actor_id;

  return jsonb_build_object('deleted', true, 'conversation_id', p_conversation_id, 'media_marked_for_purge', v_media);
end;
$$;

-- Shallow merge into the structured task context. Keys whose patch value is
-- JSON null are removed.
create or replace function public.atlas_ai_conversation_context_merge(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_conversations;
  v_removed text[];
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform atlas_private.ai_invalid('patch must be a JSON object');
  end if;
  select coalesce(array_agg(key), '{}'::text[]) into v_removed
  from jsonb_each(p_patch) where value = 'null'::jsonb;
  perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, true);
  update atlas_private.ai_conversations c
  set context = (c.context || p_patch) - v_removed
  where c.id = p_conversation_id and c.user_id = p_actor_id
  returning * into v_row;
  return jsonb_build_object('conversation_id', v_row.id, 'context', v_row.context, 'updated_at', v_row.updated_at);
end;
$$;

-- Messages ------------------------------------------------------------------

-- Appends one or more messages in order. Each element:
--   {role, content?, items?, source?, attachments?, evidence?, records?,
--    proposals?, metadata?, run_id?, status?, client_request_id?}
-- A repeated client_request_id in the same conversation returns the stored
-- message instead of inserting a second copy (created = false).
create or replace function public.atlas_ai_messages_append(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_messages jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_conv atlas_private.ai_conversations;
  v_item jsonb;
  v_id uuid;
  v_created boolean;
  v_created_at timestamptz;
  v_run uuid;
  v_request text;
  v_out jsonb := '[]'::jsonb;
  v_first_user_text text;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_messages is null or jsonb_typeof(p_messages) <> 'array'
     or jsonb_array_length(p_messages) not between 1 and 50 then
    perform atlas_private.ai_invalid('messages must be an array of 1 to 50 items');
  end if;
  v_conv := atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, true);

  for v_item in select value from jsonb_array_elements(p_messages) with ordinality order by ordinality loop
    if jsonb_typeof(v_item) <> 'object' then
      perform atlas_private.ai_invalid('each message must be an object');
    end if;
    v_request := nullif(btrim(coalesce(v_item->>'client_request_id', '')), '');
    v_run := nullif(v_item->>'run_id', '')::uuid;
    if v_run is not null and not exists (
      select 1 from atlas_private.ai_runs r where r.id = v_run and r.user_id = p_actor_id
    ) then
      perform atlas_private.ai_invalid('run_id does not belong to the actor');
    end if;

    v_id := null;
    insert into atlas_private.ai_messages (
      conversation_id, role, content, items, source, attachments, evidence, records,
      proposals, metadata, run_id, status, client_request_id, created_at, updated_at
    ) values (
      v_conv.id,
      coalesce(v_item->>'role', ''),
      coalesce(v_item->>'content', ''),
      coalesce(v_item->'items', '[]'::jsonb),
      coalesce(v_item->>'source', 'text'),
      coalesce(v_item->'attachments', '[]'::jsonb),
      coalesce(v_item->'evidence', '[]'::jsonb),
      coalesce(v_item->'records', '[]'::jsonb),
      coalesce(v_item->'proposals', '[]'::jsonb),
      coalesce(v_item->'metadata', '{}'::jsonb),
      v_run,
      coalesce(v_item->>'status', 'complete'),
      v_request,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    )
    on conflict (conversation_id, client_request_id) do nothing
    returning id, created_at into v_id, v_created_at;

    v_created := v_id is not null;
    if not v_created then
      select m.id, m.created_at into v_id, v_created_at from atlas_private.ai_messages m
      where m.conversation_id = v_conv.id and m.client_request_id = v_request;
    elsif v_first_user_text is null and v_item->>'role' = 'user' then
      v_first_user_text := v_item->>'content';
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_id, 'client_request_id', v_request, 'created', v_created, 'created_at', v_created_at));
  end loop;

  update atlas_private.ai_conversations c
  set last_message_at = greatest(c.last_message_at,
        coalesce((select max(m.created_at) from atlas_private.ai_messages m where m.conversation_id = c.id), c.last_message_at)),
      title = case
        when c.title = 'New conversation' and atlas_private.ai_clean_title(v_first_user_text) is not null
          then left(atlas_private.ai_clean_title(v_first_user_text), 80)
        else c.title end
  where c.id = v_conv.id
  returning * into v_conv;

  return jsonb_build_object('conversation_id', v_conv.id, 'title', v_conv.title,
    'last_message_at', v_conv.last_message_at, 'messages', v_out);
exception
  when check_violation or not_null_violation or invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Updates a message the actor owns (used to finalise a streamed reply).
-- Allowed keys: content, items, attachments, evidence, records, proposals,
-- metadata, run_id, status.
create or replace function public.atlas_ai_message_update(
  p_message_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_messages;
  v_unknown text;
  v_run uuid;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform atlas_private.ai_invalid('patch must be a JSON object');
  end if;
  select key into v_unknown from jsonb_object_keys(p_patch) key
  where key not in ('content','items','attachments','evidence','records','proposals','metadata','run_id','status')
  limit 1;
  if v_unknown is not null then perform atlas_private.ai_invalid('field cannot be updated: ' || v_unknown); end if;

  select m.* into v_row from atlas_private.ai_messages m
  join atlas_private.ai_conversations c on c.id = m.conversation_id
  where m.id = p_message_id and c.user_id = p_actor_id
  for update of m;
  if v_row.id is null then raise exception using errcode = 'P0002', message = 'not_found: message'; end if;

  if p_patch ? 'run_id' then
    v_run := nullif(p_patch->>'run_id', '')::uuid;
    if v_run is not null and not exists (select 1 from atlas_private.ai_runs r where r.id = v_run and r.user_id = p_actor_id) then
      perform atlas_private.ai_invalid('run_id does not belong to the actor');
    end if;
  end if;

  update atlas_private.ai_messages m set
    content = case when p_patch ? 'content' then coalesce(p_patch->>'content', '') else m.content end,
    items = case when p_patch ? 'items' then coalesce(p_patch->'items', '[]'::jsonb) else m.items end,
    attachments = case when p_patch ? 'attachments' then coalesce(p_patch->'attachments', '[]'::jsonb) else m.attachments end,
    evidence = case when p_patch ? 'evidence' then coalesce(p_patch->'evidence', '[]'::jsonb) else m.evidence end,
    records = case when p_patch ? 'records' then coalesce(p_patch->'records', '[]'::jsonb) else m.records end,
    proposals = case when p_patch ? 'proposals' then coalesce(p_patch->'proposals', '[]'::jsonb) else m.proposals end,
    metadata = case when p_patch ? 'metadata' then m.metadata || coalesce(p_patch->'metadata', '{}'::jsonb) else m.metadata end,
    run_id = case when p_patch ? 'run_id' then v_run else m.run_id end,
    status = case when p_patch ? 'status' then p_patch->>'status' else m.status end
  where m.id = v_row.id
  returning * into v_row;
  return atlas_private.ai_message_json(v_row, false);
exception
  when check_violation or not_null_violation or invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Runs and tool calls ---------------------------------------------------------

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
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;
  insert into atlas_private.ai_runs (conversation_id, user_id, role, channel, models)
  values (p_conversation_id, p_actor_id, p_actor_role, coalesce(p_channel, 'text'), coalesce(p_models, '{}'::jsonb))
  returning * into v_row;
  return jsonb_build_object('run_id', v_row.id, 'conversation_id', v_row.conversation_id,
    'channel', v_row.channel, 'started_at', v_row.started_at, 'status', v_row.status);
exception
  when check_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

create or replace function public.atlas_ai_run_finish(
  p_run_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_status text,
  p_tokens_in integer default null,
  p_tokens_out integer default null,
  p_est_cost_usd numeric default null,
  p_tool_calls integer default null,
  p_error_code text default null,
  p_models jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_runs;
  v_idempotent boolean := false;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_status not in ('completed','failed','cancelled','rejected') then
    perform atlas_private.ai_invalid('status must be completed, failed, cancelled or rejected');
  end if;
  select * into v_row from atlas_private.ai_runs r
  where r.id = p_run_id and r.user_id = p_actor_id for update;
  if v_row.id is null then raise exception using errcode = 'P0002', message = 'not_found: run'; end if;

  if v_row.status = 'running' then
    update atlas_private.ai_runs r set
      status = p_status,
      finished_at = pg_catalog.clock_timestamp(),
      latency_ms = greatest(0, (extract(epoch from (pg_catalog.clock_timestamp() - r.started_at)) * 1000)::integer),
      tokens_in = coalesce(p_tokens_in, r.tokens_in),
      tokens_out = coalesce(p_tokens_out, r.tokens_out),
      est_cost_usd = coalesce(p_est_cost_usd, r.est_cost_usd),
      tool_calls = coalesce(p_tool_calls, r.tool_calls),
      error_code = coalesce(left(p_error_code, 120), r.error_code),
      models = case when p_models is not null and jsonb_typeof(p_models) = 'object' then r.models || p_models else r.models end
    where r.id = v_row.id
    returning * into v_row;
  else
    v_idempotent := true;
  end if;

  return jsonb_build_object('run_id', v_row.id, 'status', v_row.status, 'started_at', v_row.started_at,
    'finished_at', v_row.finished_at, 'latency_ms', v_row.latency_ms, 'tokens_in', v_row.tokens_in,
    'tokens_out', v_row.tokens_out, 'est_cost_usd', v_row.est_cost_usd, 'tool_calls', v_row.tool_calls,
    'error_code', v_row.error_code, 'idempotent', v_idempotent);
exception
  when check_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

create or replace function public.atlas_ai_tool_call_record(
  p_actor_id uuid,
  p_actor_role text,
  p_run_id uuid,
  p_conversation_id uuid,
  p_tool_name text,
  p_level text,
  p_decision text,
  p_arguments_redacted jsonb default '{}'::jsonb,
  p_result_summary text default null,
  p_evidence_count integer default 0,
  p_latency_ms integer default null,
  p_status text default 'ok',
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_run_id is not null and not exists (
    select 1 from atlas_private.ai_runs r where r.id = p_run_id and r.user_id = p_actor_id
  ) then
    raise exception using errcode = 'P0002', message = 'not_found: run';
  end if;
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;

  insert into atlas_private.ai_tool_calls (
    run_id, conversation_id, user_id, tool_name, level, role, decision, arguments_redacted,
    result_summary, evidence_count, latency_ms, status, error_code
  ) values (
    p_run_id, p_conversation_id, p_actor_id, p_tool_name, p_level, p_actor_role, p_decision,
    coalesce(p_arguments_redacted, '{}'::jsonb), left(p_result_summary, 2000), coalesce(p_evidence_count, 0),
    p_latency_ms, coalesce(p_status, 'ok'), left(p_error_code, 120)
  ) returning id into v_id;

  if p_run_id is not null then
    update atlas_private.ai_runs r set tool_calls = r.tool_calls + 1 where r.id = p_run_id;
  end if;
  return jsonb_build_object('id', v_id, 'run_id', p_run_id);
exception
  when check_violation or not_null_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Media metadata ----------------------------------------------------------------

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

create or replace function public.atlas_ai_media_get(
  p_media_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_media;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_row from atlas_private.ai_media m
  where m.id = p_media_id and m.user_id = p_actor_id and m.deleted_at is null;
  if v_row.id is null then raise exception using errcode = 'P0002', message = 'not_found: media'; end if;
  return atlas_private.ai_media_json(v_row);
end;
$$;

create or replace function public.atlas_ai_media_mark_deleted(
  p_media_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_media;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  update atlas_private.ai_media m set deleted_at = coalesce(m.deleted_at, pg_catalog.now())
  where m.id = p_media_id and m.user_id = p_actor_id
  returning * into v_row;
  if v_row.id is null then raise exception using errcode = 'P0002', message = 'not_found: media'; end if;
  return atlas_private.ai_media_json(v_row);
end;
$$;

-- System purge (no actor): returns expired objects for the gateway to delete
-- from Storage. Rows are only marked deleted by atlas_ai_media_purge_confirm
-- after the storage delete succeeded, so a failed delete is retried.
create or replace function public.atlas_ai_media_purge_expired(p_limit integer default 200)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'media', coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'bucket', m.bucket, 'path', m.path,
      'kind', m.kind, 'expires_at', m.expires_at) order by m.expires_at, m.id), '[]'::jsonb),
    'count', count(*)
  )
  from (
    select * from atlas_private.ai_media media
    where media.deleted_at is null and media.expires_at is not null and media.expires_at <= pg_catalog.now()
    order by media.expires_at, media.id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  ) m;
$$;

create or replace function public.atlas_ai_media_purge_confirm(p_media_ids uuid[])
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with confirmed as (
    update atlas_private.ai_media m set deleted_at = pg_catalog.now()
    where m.id = any(coalesce(p_media_ids, '{}'::uuid[]))
      and m.deleted_at is null
      and m.expires_at is not null and m.expires_at <= pg_catalog.now()
    returning m.id
  )
  select jsonb_build_object('confirmed', count(*)) from confirmed;
$$;

-- Preferences ------------------------------------------------------------------

create or replace function public.atlas_ai_preferences_get(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_user_preferences;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_row from atlas_private.ai_user_preferences p where p.user_id = p_actor_id;
  return jsonb_build_object(
    'reply_length', coalesce(v_row.reply_length, 'normal'),
    'speak_answers', coalesce(v_row.speak_answers, false),
    'voice_enabled', coalesce(v_row.voice_enabled, true),
    'language', coalesce(v_row.language, 'auto'),
    'updated_at', v_row.updated_at,
    'stored', v_row.user_id is not null
  );
end;
$$;

create or replace function public.atlas_ai_preferences_set(p_actor_id uuid, p_actor_role text, p_patch jsonb)
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
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform atlas_private.ai_invalid('patch must be a JSON object');
  end if;
  select key into v_unknown from jsonb_object_keys(p_patch) key
  where key not in ('reply_length','speak_answers','voice_enabled','language') limit 1;
  if v_unknown is not null then perform atlas_private.ai_invalid('unknown preference: ' || v_unknown); end if;

  insert into atlas_private.ai_user_preferences as p (user_id, reply_length, speak_answers, voice_enabled, language)
  values (
    p_actor_id,
    coalesce(p_patch->>'reply_length', 'normal'),
    coalesce((p_patch->>'speak_answers')::boolean, false),
    coalesce((p_patch->>'voice_enabled')::boolean, true),
    coalesce(p_patch->>'language', 'auto')
  )
  on conflict (user_id) do update set
    reply_length = case when p_patch ? 'reply_length' then coalesce(p_patch->>'reply_length', 'normal') else p.reply_length end,
    speak_answers = case when p_patch ? 'speak_answers' then coalesce((p_patch->>'speak_answers')::boolean, false) else p.speak_answers end,
    voice_enabled = case when p_patch ? 'voice_enabled' then coalesce((p_patch->>'voice_enabled')::boolean, true) else p.voice_enabled end,
    language = case when p_patch ? 'language' then coalesce(p_patch->>'language', 'auto') else p.language end;

  return public.atlas_ai_preferences_get(p_actor_id, p_actor_role);
exception
  when check_violation or invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Settings ----------------------------------------------------------------------

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
  where key not in ('enabled','media_retention_days','audio_retention','daily_turn_limit_per_user') limit 1;
  if v_unknown is not null then perform atlas_private.ai_invalid('unknown setting: ' || v_unknown); end if;

  insert into atlas_private.ai_settings (id) values (true) on conflict (id) do nothing;
  update atlas_private.ai_settings s set
    enabled = case when p_patch ? 'enabled' then (p_patch->>'enabled')::boolean else s.enabled end,
    media_retention_days = case when p_patch ? 'media_retention_days' then (p_patch->>'media_retention_days')::integer else s.media_retention_days end,
    audio_retention = case when p_patch ? 'audio_retention' then p_patch->>'audio_retention' else s.audio_retention end,
    daily_turn_limit_per_user = case when p_patch ? 'daily_turn_limit_per_user' then (p_patch->>'daily_turn_limit_per_user')::integer else s.daily_turn_limit_per_user end,
    updated_by = p_actor_id
  where s.id;
  return public.atlas_ai_settings_get(p_actor_id, p_actor_role);
exception
  when check_violation or not_null_violation or invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Rate limit: turns (runs) the actor started in the last 24 hours, excluding
-- voice tool executions and background jobs, against the daily limit.
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
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_settings from atlas_private.ai_settings s where s.id;
  v_limit := coalesce(v_settings.daily_turn_limit_per_user, 200);
  select count(*), min(r.started_at) into v_used, v_oldest
  from atlas_private.ai_runs r
  where r.user_id = p_actor_id
    and r.started_at > pg_catalog.now() - interval '24 hours'
    and r.channel not in ('voice_tool','background');
  return jsonb_build_object(
    'enabled', coalesce(v_settings.enabled, false),
    'allowed', coalesce(v_settings.enabled, false) and v_used < v_limit,
    'used', v_used,
    'limit', v_limit,
    'remaining', greatest(0, v_limit - v_used),
    'window_hours', 24,
    'resets_at', case when v_used >= v_limit then v_oldest + interval '24 hours' else null end
  );
end;
$$;

-- Grants ------------------------------------------------------------------------

revoke execute on function atlas_private.ai_require_actor(uuid,text) from public, anon, authenticated;
revoke execute on function atlas_private.ai_invalid(text) from public, anon, authenticated;
revoke execute on function atlas_private.ai_owned_conversation(uuid,uuid,boolean) from public, anon, authenticated;
revoke execute on function atlas_private.ai_tsquery(text,boolean) from public, anon, authenticated;
revoke execute on function atlas_private.ai_conversation_json(atlas_private.ai_conversations) from public, anon, authenticated;
revoke execute on function atlas_private.ai_message_json(atlas_private.ai_messages,boolean) from public, anon, authenticated;
revoke execute on function atlas_private.ai_media_json(atlas_private.ai_media) from public, anon, authenticated;
revoke execute on function atlas_private.ai_clean_title(text) from public, anon, authenticated;
grant execute on function atlas_private.ai_require_actor(uuid,text) to service_role;
grant execute on function atlas_private.ai_invalid(text) to service_role;
grant execute on function atlas_private.ai_owned_conversation(uuid,uuid,boolean) to service_role;
grant execute on function atlas_private.ai_tsquery(text,boolean) to service_role;
grant execute on function atlas_private.ai_conversation_json(atlas_private.ai_conversations) to service_role;
grant execute on function atlas_private.ai_message_json(atlas_private.ai_messages,boolean) to service_role;
grant execute on function atlas_private.ai_media_json(atlas_private.ai_media) to service_role;
grant execute on function atlas_private.ai_clean_title(text) to service_role;

revoke execute on function public.atlas_ai_conversations_list(uuid,text,text,boolean,integer,integer) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_create(uuid,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_get(uuid,uuid,text,integer,uuid,boolean) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_rename(uuid,uuid,text,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_pin(uuid,uuid,text,boolean) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_archive(uuid,uuid,text,boolean) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_delete(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_conversation_context_merge(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_messages_append(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_message_update(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_run_start(uuid,text,uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_run_finish(uuid,uuid,text,text,integer,integer,numeric,integer,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_tool_call_record(uuid,text,uuid,uuid,text,text,text,jsonb,text,integer,integer,text,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_media_register(uuid,text,uuid,text,text,bigint,text,text,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_media_get(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_media_mark_deleted(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_media_purge_expired(integer) from public, anon, authenticated;
revoke execute on function public.atlas_ai_media_purge_confirm(uuid[]) from public, anon, authenticated;
revoke execute on function public.atlas_ai_preferences_get(uuid,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_preferences_set(uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_settings_get(uuid,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_settings_set(uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.atlas_ai_rate_check(uuid,text) from public, anon, authenticated;

grant execute on function public.atlas_ai_conversations_list(uuid,text,text,boolean,integer,integer) to service_role;
grant execute on function public.atlas_ai_conversation_create(uuid,text,text,jsonb) to service_role;
grant execute on function public.atlas_ai_conversation_get(uuid,uuid,text,integer,uuid,boolean) to service_role;
grant execute on function public.atlas_ai_conversation_rename(uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_ai_conversation_pin(uuid,uuid,text,boolean) to service_role;
grant execute on function public.atlas_ai_conversation_archive(uuid,uuid,text,boolean) to service_role;
grant execute on function public.atlas_ai_conversation_delete(uuid,uuid,text) to service_role;
grant execute on function public.atlas_ai_conversation_context_merge(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.atlas_ai_messages_append(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.atlas_ai_message_update(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.atlas_ai_run_start(uuid,text,uuid,text,jsonb) to service_role;
grant execute on function public.atlas_ai_run_finish(uuid,uuid,text,text,integer,integer,numeric,integer,text,jsonb) to service_role;
grant execute on function public.atlas_ai_tool_call_record(uuid,text,uuid,uuid,text,text,text,jsonb,text,integer,integer,text,text) to service_role;
grant execute on function public.atlas_ai_media_register(uuid,text,uuid,text,text,bigint,text,text,text) to service_role;
grant execute on function public.atlas_ai_media_get(uuid,uuid,text) to service_role;
grant execute on function public.atlas_ai_media_mark_deleted(uuid,uuid,text) to service_role;
grant execute on function public.atlas_ai_media_purge_expired(integer) to service_role;
grant execute on function public.atlas_ai_media_purge_confirm(uuid[]) to service_role;
grant execute on function public.atlas_ai_preferences_get(uuid,text) to service_role;
grant execute on function public.atlas_ai_preferences_set(uuid,text,jsonb) to service_role;
grant execute on function public.atlas_ai_settings_get(uuid,text) to service_role;
grant execute on function public.atlas_ai_settings_set(uuid,text,jsonb) to service_role;
grant execute on function public.atlas_ai_rate_check(uuid,text) to service_role;

comment on function public.atlas_ai_conversations_list(uuid,text,text,boolean,integer,integer) is
  'Service-role-only. The verified actor''s own conversations, pinned first then most recent, with optional full-text search over titles and messages.';
comment on function public.atlas_ai_messages_append(uuid,uuid,text,jsonb) is
  'Service-role-only. Appends messages to the actor''s own conversation; idempotent per client_request_id.';
comment on function public.atlas_ai_media_purge_expired(integer) is
  'Service-role-only. Lists expired atlas-ai-media objects for the gateway to delete; confirm with atlas_ai_media_purge_confirm.';
