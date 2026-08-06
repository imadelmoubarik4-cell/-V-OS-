-- PostgREST resolves RPC payloads by argument name. Recreate the service-role-only
-- wrappers with explicit names so the Knowledge Edge Function can call them.

drop function if exists public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text);
drop function if exists public.atlas_knowledge_article_detail(uuid,uuid,text,boolean);
drop function if exists public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text);
drop function if exists public.atlas_knowledge_publish(uuid,text,uuid,text,text);
drop function if exists public.atlas_knowledge_retire(uuid,text,uuid,text,text);
drop function if exists public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text);
drop function if exists public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text);
drop function if exists public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text);
drop function if exists public.atlas_knowledge_remove_source(uuid,uuid,text,text);
drop function if exists public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text);

create function public.atlas_knowledge_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_snapshot(
    p_profiles,p_tasks,p_progress,p_actor_id,p_actor_role
  );
$$;

create function public.atlas_knowledge_article_detail(
  p_article_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_prefer_draft boolean
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_article_detail(
    p_article_id,p_actor_id,p_actor_role,p_prefer_draft
  );
$$;

create function public.atlas_knowledge_save_draft(
  p_article_id uuid,
  p_article_key text,
  p_category_id uuid,
  p_article_type text,
  p_title text,
  p_summary text,
  p_content text,
  p_required boolean,
  p_target_roles text[],
  p_live_route text,
  p_change_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_save_draft(
    p_article_id,p_article_key,p_category_id,p_article_type,p_title,p_summary,p_content,
    p_required,p_target_roles,p_live_route,p_change_note,p_actor_id,p_actor_label,p_actor_role
  );
$$;

create function public.atlas_knowledge_publish(
  p_article_id uuid,
  p_change_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_publish(
    p_article_id,p_change_note,p_actor_id,p_actor_label,p_actor_role
  );
$$;

create function public.atlas_knowledge_retire(
  p_article_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_retire(
    p_article_id,p_reason,p_actor_id,p_actor_label,p_actor_role
  );
$$;

create function public.atlas_knowledge_mark_read(
  p_article_id uuid,
  p_version_id uuid,
  p_user_id uuid,
  p_user_label text,
  p_user_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_mark_read(
    p_article_id,p_version_id,p_user_id,p_user_label,p_user_role
  );
$$;

create function public.atlas_knowledge_acknowledge(
  p_article_id uuid,
  p_version_id uuid,
  p_user_id uuid,
  p_user_label text,
  p_user_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_acknowledge(
    p_article_id,p_version_id,p_user_id,p_user_label,p_user_role
  );
$$;

create function public.atlas_knowledge_save_source(
  p_source_id uuid,
  p_article_id uuid,
  p_source_type text,
  p_source_label text,
  p_source_reference text,
  p_source_url text,
  p_source_version text,
  p_connection_status text,
  p_visible_to_staff boolean,
  p_metadata jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_save_source(
    p_source_id,p_article_id,p_source_type,p_source_label,p_source_reference,
    p_source_url,p_source_version,p_connection_status,p_visible_to_staff,p_metadata,
    p_actor_id,p_actor_label,p_actor_role
  );
$$;

create function public.atlas_knowledge_remove_source(
  p_source_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_remove_source(
    p_source_id,p_actor_id,p_actor_label,p_actor_role
  );
$$;

create function public.atlas_knowledge_set_task_links(
  p_article_id uuid,
  p_task_ids uuid[],
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.knowledge_set_task_links(
    p_article_id,p_task_ids,p_actor_id,p_actor_label,p_actor_role
  );
$$;

revoke execute on function public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_article_detail(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_publish(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_retire(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_remove_source(uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text) from public,anon,authenticated;

grant execute on function public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text) to service_role;
grant execute on function public.atlas_knowledge_article_detail(uuid,uuid,text,boolean) to service_role;
grant execute on function public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_publish(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_retire(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_remove_source(uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text) to service_role;

comment on function public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text)
  is 'Service-role-only Knowledge workspace snapshot assembled after production profile authorization.';
