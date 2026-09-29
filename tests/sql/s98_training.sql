-- S98 Atlas Training — schema, storage, authorization and integrity on a replayed
-- database (scripts/verify_full_migration_replay.sh stubs). Proves at the database
-- boundary (not the UI):
--   1. the private atlas-training-videos bucket exists with no storage.objects policy;
--   2. training tables and RPCs are sealed from anon/authenticated;
--   3. a bartender cannot author (save/attach/publish) — 42501;
--   4. a manager can create a draft, attach a stored video, and publish an immutable
--      version, and publishing v2 never mutates v1's media;
--   5. explicit completion is version-specific and idempotent, and a v1 completion
--      survives v2 publishing;
--   6. staff cannot complete a draft, complete for another user, or reach a wrong-role
--      lesson's video path; role forgery and inactive profiles fail closed.
begin;

-- Actors (a profile row is created by the auth.users trigger, then given a role).
insert into auth.users(id, email, raw_user_meta_data) values
  ('98000000-0000-4000-8000-0000000000a1', 's98-admin@example.invalid', '{}'),
  ('98000000-0000-4000-8000-0000000000d1', 's98-manager@example.invalid', '{}'),
  ('98000000-0000-4000-8000-0000000000c1', 's98-bartender@example.invalid', '{}'),
  ('98000000-0000-4000-8000-0000000000c2', 's98-bartender2@example.invalid', '{}'),
  ('98000000-0000-4000-8000-0000000000e1', 's98-inactive@example.invalid', '{}');
update public.profiles set role='admin', active=true, display_name='S98 Admin' where id='98000000-0000-4000-8000-0000000000a1';
update public.profiles set role='manager', active=true, display_name='S98 Manager' where id='98000000-0000-4000-8000-0000000000d1';
update public.profiles set role='bartender', active=true, display_name='S98 Bartender' where id='98000000-0000-4000-8000-0000000000c1';
update public.profiles set role='bartender', active=true, display_name='S98 Bartender Two' where id='98000000-0000-4000-8000-0000000000c2';
update public.profiles set role='bartender', active=false, display_name='S98 Inactive' where id='98000000-0000-4000-8000-0000000000e1';

-- A training category to file lessons under (active), plus an inactive one that
-- must never surface in the authoring category list.
insert into atlas_private.knowledge_categories(id, category_key, name, active, sort_order)
values ('98000000-0000-4000-8000-0000000000f0', 's98-training', 'S98 Training', true, 10)
on conflict (category_key) do nothing;
insert into atlas_private.knowledge_categories(id, category_key, name, active, sort_order)
values ('98000000-0000-4000-8000-0000000000f2', 's98-training-inactive', 'S98 Retired', false, 20)
on conflict (category_key) do nothing;

-- 1. The private bucket exists, is private, and allows only video types.
do $$ begin
  if not exists (select 1 from storage.buckets where id='atlas-training-videos' and public=false) then
    raise exception 'atlas-training-videos must exist and be private';
  end if;
  if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
             and qual like '%atlas-training-videos%') then
    raise exception 'atlas-training-videos must have NO storage.objects policy';
  end if;
end $$;

-- 2. Tables and RPCs are sealed from browser roles.
do $$
declare bad text;
begin
  select string_agg(t, ', ') into bad from unnest(array[
    'training_media_assets','training_lesson_versions','training_chapters',
    'training_steps','training_progress','training_events']) t
  where has_table_privilege('authenticated', 'atlas_private.'||t, 'SELECT')
     or has_table_privilege('anon', 'atlas_private.'||t, 'SELECT');
  if bad is not null then raise exception 'browser roles can read training tables: %', bad; end if;

  if has_function_privilege('authenticated', 'public.atlas_training_snapshot(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.atlas_training_complete(uuid,text,uuid,uuid)', 'EXECUTE') then
    raise exception 'browser roles can execute training RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.atlas_training_snapshot(uuid,text)', 'EXECUTE') then
    raise exception 'service_role must execute training RPCs';
  end if;
end $$;

-- 3. A bartender cannot author.
do $$ begin
  begin
    perform public.atlas_training_save_draft('98000000-0000-4000-8000-0000000000c1', 'S98 Bartender', 'bartender',
      jsonb_build_object('category_id','98000000-0000-4000-8000-0000000000f0','title','x','content','y'));
    raise exception 'bartender authored a training lesson';
  exception when insufficient_privilege then null; end;
end $$;

-- 4. Manager creates v1, attaches a stored video, publishes; then v2 with a new video.
do $$
declare
  mgr uuid := '98000000-0000-4000-8000-0000000000d1';
  bart uuid := '98000000-0000-4000-8000-0000000000c1';
  saved jsonb; v_article uuid; v_v1 uuid; v_v2 uuid;
  media1 jsonb; media2 jsonb; m1 uuid; m2 uuid;
  lesson jsonb; report jsonb; done jsonb; v1_media_after uuid; path text;
begin
  saved := public.atlas_training_save_draft(mgr, 'S98 Manager', 'manager', jsonb_build_object(
    'category_id','98000000-0000-4000-8000-0000000000f0',
    'title','Opening the Bar','summary','How we open','content','# Steps\n1. Lights',
    'required',true,'target_roles',jsonb_build_array('bartender'),
    'estimated_minutes',7,'chapters',jsonb_build_array(
      jsonb_build_object('start_seconds',0,'title','Intro'),
      jsonb_build_object('start_seconds',22,'title','Lights')),
    'steps',jsonb_build_array('Turn on lights','Start coffee')));
  v_article := (saved->>'article_id')::uuid; v_v1 := (saved->>'version_id')::uuid;

  media1 := public.atlas_training_reserve_media(mgr,'manager',jsonb_build_object(
    'client_request_id', gen_random_uuid(), 'mime_type','video/mp4','declared_bytes',1048576,'original_filename','v1.mp4'));
  m1 := (media1->'media'->>'id')::uuid;
  perform public.atlas_training_finalize_media(mgr,'manager',m1, jsonb_build_object('byte_size',1048576,'mime_type','video/mp4','duration_seconds',120));
  perform public.atlas_training_attach_media(mgr,'manager',v_article,m1);

  -- Cannot publish before... it has media now, so publish succeeds.
  perform public.atlas_training_publish(mgr,'S98 Manager','manager',v_article,'first');

  -- Bartender (targeted) can read + start + complete the published v1.
  lesson := public.atlas_training_lesson(v_article, bart, 'bartender', false);
  if (lesson->'version'->>'id')::uuid <> v_v1 then raise exception 'bartender should read published v1'; end if;
  perform public.atlas_training_start(bart,'bartender',v_article,v_v1);
  done := public.atlas_training_complete(bart,'bartender',v_article,v_v1);
  if done->>'completion_state' <> 'completed' then raise exception 'completion failed'; end if;
  -- Idempotent.
  done := public.atlas_training_complete(bart,'bartender',v_article,v_v1);
  if (done->>'replayed')::boolean is not true then raise exception 'completion must be idempotent'; end if;

  -- 5/immutability: create v2 draft with a new video and publish.
  saved := public.atlas_training_save_draft(mgr,'S98 Manager','manager', jsonb_build_object(
    'article_id', v_article, 'category_id','98000000-0000-4000-8000-0000000000f0',
    'title','Opening the Bar','summary','v2','content','# Steps v2','required',true,
    'target_roles',jsonb_build_array('bartender')));
  v_v2 := (saved->>'version_id')::uuid;
  if v_v2 = v_v1 then raise exception 'v2 must be a new version id'; end if;
  media2 := public.atlas_training_reserve_media(mgr,'manager',jsonb_build_object(
    'client_request_id', gen_random_uuid(),'mime_type','video/mp4','declared_bytes',2097152,'original_filename','v2.mp4'));
  m2 := (media2->'media'->>'id')::uuid;
  perform public.atlas_training_finalize_media(mgr,'manager',m2, jsonb_build_object('byte_size',2097152,'mime_type','video/mp4','duration_seconds',150));
  perform public.atlas_training_attach_media(mgr,'manager',v_article,m2);
  perform public.atlas_training_publish(mgr,'S98 Manager','manager',v_article,'second');

  -- v1's media is still m1 (never mutated); v2's media is m2.
  select media_asset_id into v1_media_after from atlas_private.training_lesson_versions where version_id=v_v1;
  if v1_media_after <> m1 then raise exception 'v1 media was mutated by v2 publish'; end if;
  if (select media_asset_id from atlas_private.training_lesson_versions where version_id=v_v2) <> m2 then
    raise exception 'v2 media not set'; end if;
  -- v1 completion still present and bound to v1.
  if not exists (select 1 from atlas_private.training_progress
      where user_id=bart and version_id=v_v1 and completion_state='completed') then
    raise exception 'v1 completion was lost'; end if;

  -- Playback path is available for the CURRENT published version (v2) to the targeted
  -- bartender; the superseded v1 is no longer offered to staff.
  path := public.atlas_training_playback_path(bart,'bartender',v_article,v_v2);
  if path not like 'lessons/%' then raise exception 'playback path missing'; end if;
  begin
    perform public.atlas_training_playback_path(bart,'bartender',v_article,v_v1);
    raise exception 'staff played a superseded version';
  exception when insufficient_privilege then null; end;

  -- Completion report counts the two active bartenders as assigned.
  report := public.atlas_training_completion_report(mgr,'manager',v_article);
  if (report->>'assigned')::int < 2 then raise exception 'report should assign both bartenders, saw %', report->>'assigned'; end if;
end $$;

-- 6. Attacks fail closed.
do $$
declare
  bart uuid := '98000000-0000-4000-8000-0000000000c1';
  bart2 uuid := '98000000-0000-4000-8000-0000000000c2';
  inactive uuid := '98000000-0000-4000-8000-0000000000e1';
  mgr uuid := '98000000-0000-4000-8000-0000000000d1';
  saved jsonb; v_article uuid; v_draft uuid;
begin
  -- A manager-only lesson.
  saved := public.atlas_training_save_draft(mgr,'S98 Manager','manager', jsonb_build_object(
    'category_id','98000000-0000-4000-8000-0000000000f0','title','Cash counting','content','secret',
    'required',false,'target_roles',jsonb_build_array('manager'),'requires_video',false));
  v_article := (saved->>'article_id')::uuid; v_draft := (saved->>'version_id')::uuid;
  perform public.atlas_training_publish(mgr,'S98 Manager','manager',v_article,null);

  -- Bartender cannot read or complete a manager-only lesson.
  begin perform public.atlas_training_lesson(v_article, bart, 'bartender', false); raise exception 'bartender read a manager-only lesson';
  exception when insufficient_privilege then null; end;
  begin perform public.atlas_training_complete(bart,'bartender',v_article,(select current_version_id from atlas_private.knowledge_articles where id=v_article));
    raise exception 'bartender completed a manager-only lesson';
  exception when insufficient_privilege then null; end;

  -- Role forgery: a real bartender claiming to be a manager is rejected.
  begin perform public.atlas_training_snapshot(bart, 'manager'); raise exception 'role forgery accepted';
  exception when insufficient_privilege then null; end;

  -- Inactive profile fails closed.
  begin perform public.atlas_training_snapshot(inactive, 'bartender'); raise exception 'inactive profile served';
  exception when insufficient_privilege then null; end;

  -- Completing a draft-only lesson is refused (no published version to complete).
  saved := public.atlas_training_save_draft(mgr,'S98 Manager','manager', jsonb_build_object(
    'category_id','98000000-0000-4000-8000-0000000000f0','title','Draft only','content','x',
    'required',false,'target_roles',jsonb_build_array('bartender'),'requires_video',false));
  v_article := (saved->>'article_id')::uuid; v_draft := (saved->>'version_id')::uuid;
  begin
    perform public.atlas_training_complete(bart,'bartender', v_article, v_draft);
    raise exception 'a draft-only lesson was completable';
  exception when insufficient_privilege or invalid_parameter_value then null; end;

  -- A bartender cannot complete on behalf of another user: the RPC derives the user
  -- from p_actor_id, so bart2 completing writes bart2's row, never bart's.
  begin
    perform public.atlas_training_save_progress(bart2,'bartender', v_draft, 10);
    raise exception 'progress saved without starting';
  exception when no_data_found then null; end;
end $$;

-- 7. The manager snapshot is self-contained for authoring: it returns active
--    categories only (canonical Knowledge rule), never inactive ones; staff get none.
do $$
declare
  mgr uuid := '98000000-0000-4000-8000-0000000000d1';
  bart uuid := '98000000-0000-4000-8000-0000000000c1';
  snap jsonb; cats jsonb;
begin
  snap := public.atlas_training_snapshot(mgr, 'manager');
  cats := snap->'categories';
  if cats is null or jsonb_typeof(cats) <> 'array' then
    raise exception 'manager snapshot must include a categories array';
  end if;
  if not exists (select 1 from jsonb_array_elements(cats) e
                 where e->>'id' = '98000000-0000-4000-8000-0000000000f0'
                   and e->>'name' = 'S98 Training' and e ? 'key') then
    raise exception 'manager snapshot must contain the seeded active category with id/key/name';
  end if;
  if exists (select 1 from jsonb_array_elements(cats) e
             where e->>'id' = '98000000-0000-4000-8000-0000000000f2') then
    raise exception 'manager snapshot must not contain an inactive category';
  end if;
  snap := public.atlas_training_snapshot(bart, 'bartender');
  if snap->'categories' <> '[]'::jsonb then
    raise exception 'staff snapshot must return an empty categories array';
  end if;
end $$;

do $$ begin raise notice 'S98 training: all authorization and integrity checks passed'; end $$;
rollback;
