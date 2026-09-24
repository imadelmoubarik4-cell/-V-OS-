-- S88 Knowledge full-text search for Atlas AI (knowledge.search tool).
--
-- docs/ai/Atlas_AI_Architecture.md §11. Searches only the version the actor
-- may read, using atlas_private.knowledge_article_visible semantics:
-- * staff (bartender, viewer): published articles targeted to their role (or
--   'all'), current published version only. Draft text, draft-only articles,
--   retired articles and untargeted articles never match.
-- * managers/administrators: the current published version and the pending
--   draft; the best-ranked of the two is returned per article.
-- Source metadata (URLs, references) is never returned by this RPC.
--
-- The tsvector ('simple' configuration: English/Icelandic mix; title A,
-- summary B, content C) is maintained by an expression GIN index, so the
-- existing version table and every existing Knowledge response keep their
-- exact shape.

set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function atlas_private.knowledge_version_search_document(
  p_title text,
  p_summary text,
  p_content text
)
returns tsvector
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select pg_catalog.setweight(pg_catalog.to_tsvector('simple'::regconfig, coalesce(p_title, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('simple'::regconfig, coalesce(p_summary, '')), 'B')
      || pg_catalog.setweight(pg_catalog.to_tsvector('simple'::regconfig, left(coalesce(p_content, ''), 200000)), 'C');
$$;

create index if not exists knowledge_versions_search_idx
  on atlas_private.knowledge_article_versions
  using gin (atlas_private.knowledge_version_search_document(title, summary, content));

create or replace function public.atlas_knowledge_search(
  p_query text,
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 8
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_role text;
  v_is_manager boolean;
  v_any tsquery := atlas_private.ai_tsquery(p_query, false);
  v_all tsquery := atlas_private.ai_tsquery(p_query, true);
  v_limit integer := greatest(1, least(coalesce(p_limit, 8), 25));
  v_results jsonb;
begin
  v_role := atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  v_is_manager := v_role in ('admin','manager');
  if v_any is null then
    return jsonb_build_object('results', '[]'::jsonb, 'count', 0, 'query', p_query);
  end if;

  with matched as (
    select version.id as version_id, version.article_id, version.version_number, version.state,
      version.title, version.summary, version.content,
      atlas_private.knowledge_version_search_document(version.title, version.summary, version.content) as document
    from atlas_private.knowledge_article_versions version
    where atlas_private.knowledge_version_search_document(version.title, version.summary, version.content) @@ v_any
      and version.state in ('published','draft')
  ), visible as (
    select distinct on (article.id)
      m.version_id, m.article_id, m.version_number, m.state, m.title, m.summary, m.content,
      article.status as article_status, article.article_type, article.required,
      category.name as category_name, category.category_key,
      (pg_catalog.ts_rank(m.document, v_any) + 2 * pg_catalog.ts_rank(m.document, v_all))::real as rank
    from matched m
    join atlas_private.knowledge_articles article on article.id = m.article_id
    join atlas_private.knowledge_categories category on category.id = article.category_id
    where atlas_private.knowledge_article_visible(article, v_role, v_is_manager)
      and (
        (m.version_id = article.current_version_id and m.state = 'published'
          and (v_is_manager or article.status = 'published'))
        or (v_is_manager and m.version_id = article.draft_version_id and m.state = 'draft')
      )
    order by article.id, rank desc, m.state desc
  ), top as (
    select * from visible order by rank desc, title limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'article_id', top.article_id,
      'version_id', top.version_id,
      'version_number', top.version_number,
      'title', top.title,
      'category', top.category_name,
      'category_key', top.category_key,
      'article_type', top.article_type,
      'required', top.required,
      'status', top.article_status,
      'version_state', top.state,
      'rank', round(top.rank::numeric, 6),
      'snippet', pg_catalog.ts_headline('simple'::regconfig,
        concat_ws(' — ', nullif(top.summary, ''), left(top.content, 20000)), v_any,
        'MaxWords=40, MinWords=15, MaxFragments=2, FragmentDelimiter=" … ", StartSel=**, StopSel=**')
    ) order by top.rank desc, top.title), '[]'::jsonb)
  into v_results
  from top;

  return jsonb_build_object('results', v_results, 'count', jsonb_array_length(v_results), 'query', p_query);
end;
$$;

revoke execute on function atlas_private.knowledge_version_search_document(text,text,text) from public, anon, authenticated;
grant execute on function atlas_private.knowledge_version_search_document(text,text,text) to service_role;
revoke execute on function public.atlas_knowledge_search(text,uuid,text,integer) from public, anon, authenticated;
grant execute on function public.atlas_knowledge_search(text,uuid,text,integer) to service_role;

comment on function public.atlas_knowledge_search(text,uuid,text,integer) is
  'Service-role-only full-text Knowledge search over the version visible to the verified actor. Staff: published, targeted versions only. Managers: published and draft.';
