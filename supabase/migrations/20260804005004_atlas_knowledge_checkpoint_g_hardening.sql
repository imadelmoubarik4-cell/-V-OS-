-- Checkpoint G hardening: make Knowledge publications first-class Team links
-- and preserve source-removal audit events after the source row is deleted.

alter table atlas_private.team_messages
  drop constraint if exists team_messages_link_type_check;

alter table atlas_private.team_messages
  add constraint team_messages_link_type_check
  check (link_type in (
    'none','inventory_item','routine','shift','brain_recommendation','knowledge_article'
  ));

create or replace function atlas_private.knowledge_publish(
  p_article_id uuid,
  p_change_note text,
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
  article_row atlas_private.knowledge_articles;
  draft_row atlas_private.knowledge_article_versions;
  published_row atlas_private.knowledge_article_versions;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish Knowledge'; end if;
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id for update;
  if not found then raise exception 'Knowledge article not found'; end if;
  select * into draft_row from atlas_private.knowledge_article_versions
  where article_id=article_row.id and state='draft' for update;
  if not found then raise exception 'This article has no draft to publish'; end if;

  update atlas_private.knowledge_article_versions
  set state='superseded',updated_at=pg_catalog.now()
  where article_id=article_row.id and state='published';

  update atlas_private.knowledge_article_versions
  set state='published',
      change_note=coalesce(nullif(trim(coalesce(p_change_note,'')),''),change_note),
      published_at=pg_catalog.now(),
      published_by=p_actor_id,
      published_by_label=p_actor_label,
      updated_at=pg_catalog.now()
  where id=draft_row.id
  returning * into published_row;

  update atlas_private.knowledge_articles
  set status='published',
      current_version=published_row.version_number,
      current_version_id=published_row.id,
      draft_version_id=null,
      updated_by=p_actor_id,
      updated_by_label=p_actor_label
  where id=article_row.id
  returning * into article_row;

  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,actor_id,actor_label,actor_role,payload
  ) values (
    'version_published',article_row.id,published_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'version_number',published_row.version_number,
      'required',article_row.required,
      'target_roles',article_row.target_roles
    )
  );

  system_body := 'Knowledge article published' || E'\n'
    || published_row.title || ' · Version ' || published_row.version_number::text
    || case when article_row.required then E'\nRequired reading for assigned staff.' else '' end;

  begin
    perform atlas_private.team_messages_post_system(
      'announcements',
      'knowledge-published:'||article_row.id::text||':'||published_row.version_number::text,
      system_body,
      'knowledge_article',
      article_row.id::text,
      published_row.title,
      'knowledge',
      jsonb_build_object(
        'article_id',article_row.id,
        'version_id',published_row.id,
        'version_number',published_row.version_number,
        'required',article_row.required
      )
    );
  exception when others then
    null;
  end;

  return jsonb_build_object('article',to_jsonb(article_row),'version',to_jsonb(published_row));
end;
$$;

create or replace function atlas_private.knowledge_remove_source(
  p_source_id uuid,
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
declare source_row atlas_private.knowledge_sources;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can remove Knowledge sources'; end if;
  delete from atlas_private.knowledge_sources where id=p_source_id returning * into source_row;
  if not found then raise exception 'Knowledge source not found'; end if;

  insert into atlas_private.knowledge_events (
    event_type,article_id,source_id,actor_id,actor_label,actor_role,payload
  ) values (
    'source_removed',source_row.article_id,null,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'source_id',source_row.id,
      'source_label',source_row.source_label,
      'source_type',source_row.source_type
    )
  );
  return to_jsonb(source_row);
end;
$$;
