-- S96 (aioauth, N13): Knowledge search visibility on a replayed database.
-- Run: psql -v ON_ERROR_STOP=1 -d <replay db> -f scripts/verify_s96_knowledge_search_visibility.sql
-- Expects the four S96 test profiles below (created here, rolled back).
begin;
insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),('44444444-4444-4444-4444-444444444444') on conflict do nothing;
insert into public.profiles(id,email,display_name,role,active) values ('11111111-1111-1111-1111-111111111111','m@x.invalid','Mgr','manager',true),('22222222-2222-2222-2222-222222222222','b@x.invalid','Bar','bartender',true),('44444444-4444-4444-4444-444444444444','v@x.invalid','View','viewer',true) on conflict (id) do update set role=excluded.role, active=true;
insert into atlas_private.knowledge_categories(id,category_key,name) values ('c0000000-0000-4000-8000-000000000001','ops-n13','Ops');
-- A1 published, target managers only (secret word zebrasecret)
insert into atlas_private.knowledge_articles(id,article_key,category_id,status,target_roles) values
 ('a0000000-0000-4000-8000-000000000001','n13-mgr','c0000000-0000-4000-8000-000000000001','published',array['manager']),
 ('a0000000-0000-4000-8000-000000000002','n13-all','c0000000-0000-4000-8000-000000000001','published',array['all']),
 ('a0000000-0000-4000-8000-000000000003','n13-draft','c0000000-0000-4000-8000-000000000001','draft',array['all']);
insert into atlas_private.knowledge_article_versions(id,article_id,version_number,state,title,content,published_at) values
 ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',1,'published','Manager margins','zebrasecret supplier margin sheet',now()),
 ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002',1,'published','Closing checklist','zebrasecret close the bar public text',now()),
 ('b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000002',2,'draft','Closing checklist v2','zebrasecret DRAFTONLY unreleased salary change',null),
 ('b0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000003',1,'draft','Draft policy','zebrasecret DRAFTARTICLE never published',null);
update atlas_private.knowledge_articles set current_version_id='b0000000-0000-4000-8000-000000000001', current_version=1 where id='a0000000-0000-4000-8000-000000000001';
update atlas_private.knowledge_articles set current_version_id='b0000000-0000-4000-8000-000000000002', current_version=1, draft_version_id='b0000000-0000-4000-8000-000000000003' where id='a0000000-0000-4000-8000-000000000002';
update atlas_private.knowledge_articles set draft_version_id='b0000000-0000-4000-8000-000000000004' where id='a0000000-0000-4000-8000-000000000003';
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.atlas_knowledge_search('zebrasecret','22222222-2222-2222-2222-222222222222','bartender',25);
  if (r->>'count')::int <> 1 or r::text ~ 'DRAFTONLY|DRAFTARTICLE|margin sheet' then raise exception 'bartender search leak: %', r; end if;
  r := public.atlas_knowledge_search('zebrasecret','44444444-4444-4444-4444-444444444444','viewer',25);
  if (r->>'count')::int <> 1 or r::text ~ 'DRAFTONLY|DRAFTARTICLE|margin sheet' then raise exception 'viewer search leak: %', r; end if;
  r := public.atlas_knowledge_search('zebrasecret','11111111-1111-1111-1111-111111111111','manager',25);
  if (r->>'count')::int <> 3 then raise exception 'manager should see 3: %', r; end if;
  begin
    perform public.atlas_knowledge_search('zebrasecret','22222222-2222-2222-2222-222222222222','manager',25);
    raise exception 'claimed role accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.atlas_knowledge_article_detail('a0000000-0000-4000-8000-000000000003','22222222-2222-2222-2222-222222222222','bartender',true);
    raise exception 'draft article returned to bartender';
  exception when others then if sqlerrm = 'draft article returned to bartender' then raise; end if;
  end;
  r := public.atlas_knowledge_article_detail('a0000000-0000-4000-8000-000000000002','22222222-2222-2222-2222-222222222222','bartender',true);
  if r::text ~ 'DRAFTONLY' then raise exception 'prefer_draft leaked a draft to a bartender'; end if;
  raise notice 'S96 knowledge search visibility: OK';
end $$;
rollback;
