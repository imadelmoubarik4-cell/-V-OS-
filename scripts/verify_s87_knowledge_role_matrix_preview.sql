-- S87 preview-only Knowledge role matrix.
--
-- Requires an isolated replay database. Creates one published article with a
-- later unpublished draft, one draft-only article, and a manager-only source
-- URL through the public RPCs, then checks what a bartender and a manager
-- snapshot/detail return. Everything is rolled back.

begin;

create temporary table s87_knowledge (test_name text primary key, passed boolean not null) on commit drop;

do $matrix$
declare
  manager uuid := '00000000-0000-4000-8000-000000087301';
  bartender uuid := '00000000-0000-4000-8000-000000087302';
  category uuid := (select id from atlas_private.knowledge_categories order by sort_order nulls last, id limit 1);
  published jsonb; draft_only jsonb; published_id uuid; draft_id uuid;
  staff_snapshot jsonb; manager_snapshot jsonb; staff_detail jsonb; staff_text text;
begin
  published := public.atlas_knowledge_save_draft(null,'s87-published',category,'policy','S87 published title','Published summary','PUBLISHED-BODY',false,array['all'],null,'first',manager,'Manager','manager');
  published_id := coalesce((published->>'id')::uuid, (published->'article'->>'id')::uuid);
  perform public.atlas_knowledge_publish(published_id,'publish',manager,'Manager','manager');
  perform public.atlas_knowledge_save_draft(published_id,'s87-published',category,'policy','S87 published title','Published summary','UNPUBLISHED-EDIT-SECRET',false,array['all'],null,'edit',manager,'Manager','manager');
  draft_only := public.atlas_knowledge_save_draft(null,'s87-draft',category,'policy','S87 DRAFT-ONLY-TITLE','Draft summary','DRAFT-ONLY-BODY',false,array['all'],null,'draft',manager,'Manager','manager');
  draft_id := coalesce((draft_only->>'id')::uuid, (draft_only->'article'->>'id')::uuid);
  perform public.atlas_knowledge_save_source(null,published_id,'google_drive','Drive folder','ref','https://drive.example.invalid/PRIVATE-SOURCE-URL',null,'manual_reference',true,'{}'::jsonb,manager,'Manager','manager');

  staff_snapshot := public.atlas_knowledge_snapshot('[]'::jsonb,'[]'::jsonb,'[]'::jsonb,bartender,'bartender');
  manager_snapshot := public.atlas_knowledge_snapshot('[]'::jsonb,'[]'::jsonb,'[]'::jsonb,manager,'manager');
  staff_detail := public.atlas_knowledge_article_detail(published_id,bartender,'bartender',true);
  staff_text := staff_snapshot::text || staff_detail::text;

  insert into s87_knowledge values
    ('staff see the published article', staff_snapshot::text like '%S87 published title%'),
    ('staff never see a draft-only article', staff_text not like '%DRAFT-ONLY-TITLE%' and staff_text not like '%DRAFT-ONLY-BODY%'),
    ('staff detail shows the published version, not the pending edit', staff_detail::text like '%PUBLISHED-BODY%' and staff_text not like '%UNPUBLISHED-EDIT-SECRET%'),
    ('staff never receive a source URL', staff_text not like '%PRIVATE-SOURCE-URL%'),
    ('managers see the draft-only article', manager_snapshot::text like '%DRAFT-ONLY-TITLE%');
end
$matrix$;

select jsonb_build_object(
  's87_knowledge_role_matrix', case when bool_and(passed) then 'passed' else 'failed' end,
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s87_knowledge;

rollback;
