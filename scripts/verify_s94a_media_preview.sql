-- S94A preview-only acceptance: Marketing Media Library
-- (supabase/migrations/20261004090000_s94a_marketing_media.sql).
--
-- Requires an isolated replay database (scripts/verify_full_migration_replay.sh).
-- Seeds users, content and Storage object rows inside one transaction and proves:
-- * the bucket is private, 1 GiB, the MIME allowlist exactly (no SVG/HTML), and
--   has no storage.objects policy;
-- * every media table has RLS, a service-role policy and no browser privilege;
--   every public RPC is service-role only, security definer, search_path pinned;
-- * the role is re-checked in SQL: bartender, viewer and a deactivated manager
--   are refused; browser roles cannot execute anything;
-- * reserve picks the path, replays on the same request id, refuses unknown
--   types, oversize photos and a request id reused by someone else, and caps
--   unfinished uploads;
-- * complete needs the object, refuses a size mismatch or a kind mismatch
--   and records the sniffed type and server dimensions;
-- * variants (thumb replaces thumb), details (focal point, trim, tags), list
--   filters, collections (reorder is an exact permutation);
-- * content attachment keeps order, copies collections with collection_id,
--   refuses media that is not ready, resets approval of approved content and
--   locks published content;
-- * the deletion guard (pinned content, publication history, trigger) and
--   restore; the worker resolve returns paths and no URL; maintenance is
--   admin only and purges only due rows.
-- Prints one JSON verdict and rolls everything back.

begin;

create temporary table s94a_media (test_name text primary key, passed boolean not null, detail text) on commit drop;
grant all on table s94a_media to service_role, authenticated, anon;

-- Runs dynamic SQL and returns 'ok' or '<SQLSTATE> <hint>'.
create function public.s94am_expect(p_sql text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_hint text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ' ' || coalesce(v_hint, sqlerrm);
end;
$$;
grant execute on function public.s94am_expect(text) to service_role, authenticated, anon;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000094a01'::uuid,'s94a-admin@example.invalid'),
  ('00000000-0000-4000-8000-000000094a02'::uuid,'s94a-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000094a03'::uuid,'s94a-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000094a04'::uuid,'s94a-view@example.invalid'),
  ('00000000-0000-4000-8000-000000094a05'::uuid,'s94a-gone@example.invalid')) v(id,email);
update public.profiles set role='admin', active=true, display_name='S94A Admin' where id='00000000-0000-4000-8000-000000094a01';
update public.profiles set role='manager', active=true, display_name='s94a-mgr@example.invalid' where id='00000000-0000-4000-8000-000000094a02';
update public.profiles set role='bartender', active=true, display_name='S94A Bartender' where id='00000000-0000-4000-8000-000000094a03';
update public.profiles set role='viewer', active=true, display_name='S94A Viewer' where id='00000000-0000-4000-8000-000000094a04';
update public.profiles set role='manager', active=false, display_name='S94A Gone' where id='00000000-0000-4000-8000-000000094a05';

insert into atlas_private.marketing_content_items (id, title, content_type, status, platforms) values
  ('00000000-0000-4000-8000-00000094c001', 'Draft post', 'post', 'draft', array['instagram']),
  ('00000000-0000-4000-8000-00000094c002', 'Approved post', 'post', 'approved', array['instagram']),
  ('00000000-0000-4000-8000-00000094c003', 'Published post', 'post', 'published', array['facebook']),
  ('00000000-0000-4000-8000-00000094c004', 'Scheduled post', 'post', 'scheduled', array['instagram']);

-- Static boundary --------------------------------------------------------------------

insert into s94a_media
select 'the bucket is private, 1 GiB, exactly the photo/video allowlist and has no storage policy',
  b.public = false and b.file_size_limit = 1073741824
  and b.allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime']
  and cardinality(b.allowed_mime_types) = 7
  and not (b.allowed_mime_types && array['image/svg+xml','text/html','image/gif'])
  and not exists (select 1 from pg_policies p where p.schemaname = 'storage' and (p.qual ilike '%atlas-marketing-media%' or p.with_check ilike '%atlas-marketing-media%')),
  row_to_json(b)::text
from storage.buckets b where b.id = 'atlas-marketing-media';

insert into s94a_media
select 'the eight media tables have RLS, a service-role policy and no browser privilege',
  count(*) = 8 and bool_and(c.relrowsecurity
    and not has_table_privilege('anon', c.oid, 'select,insert,update,delete')
    and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
    and exists (select 1 from pg_policies p where p.schemaname = 'atlas_private' and p.tablename = c.relname and p.roles = array['service_role']::name[])),
  count(*)::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'atlas_private' and c.relkind = 'r' and c.relname in ('marketing_media_assets','marketing_media_variants','marketing_media_collections',
  'marketing_media_collection_items','marketing_media_tags','marketing_media_asset_tags','marketing_content_media','marketing_media_publication_uses');

insert into s94a_media
select 'marketing_content_media keeps collection_id for provenance',
  exists (select 1 from information_schema.columns where table_schema = 'atlas_private' and table_name = 'marketing_content_media' and column_name = 'collection_id'),
  null;

insert into s94a_media
select 'every public media RPC is service-role only, security definer and pins search_path',
  count(*) >= 18 and bool_and(not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('public', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute')
    and p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)),
  count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (p.proname like 'atlas\_marketing\_media\_%' or p.proname = 'atlas_marketing_content_media_set');

insert into s94a_media
select 'the worker resolve and the content-media set RPC exist with the contract signatures',
  to_regprocedure('public.atlas_marketing_media_resolve(uuid[],uuid[])') is not null
  and to_regprocedure('public.atlas_marketing_content_media_set(uuid,uuid,jsonb)') is not null,
  null;

insert into s94a_media
select 'helper functions in atlas_private are not executable by browser roles',
  bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')),
  count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'atlas_private' and (p.proname like 'marketing\_media\_%' or p.proname like 'marketing\_content\_media\_%');

set role service_role;

do $service$
declare
  adm uuid := '00000000-0000-4000-8000-000000094a01';
  mgr uuid := '00000000-0000-4000-8000-000000094a02';
  bar uuid := '00000000-0000-4000-8000-000000094a03';
  viewer uuid := '00000000-0000-4000-8000-000000094a04';
  gone uuid := '00000000-0000-4000-8000-000000094a05';
  c_draft uuid := '00000000-0000-4000-8000-00000094c001';
  c_approved uuid := '00000000-0000-4000-8000-00000094c002';
  c_published uuid := '00000000-0000-4000-8000-00000094c003';
  c_scheduled uuid := '00000000-0000-4000-8000-00000094c004';
  req1 uuid := gen_random_uuid();
  res jsonb; res2 jsonb;
  photo uuid; photo2 uuid; video uuid; pending uuid;
  photo_path text; video_path text;
  var_id uuid; var2 uuid; var_path text;
  col uuid;
  st text;
  ok boolean;
  n integer;
begin
  -- Roles ----------------------------------------------------------------------
  ok := true;
  foreach st in array array[
    public.s94am_expect(format('select public.atlas_marketing_media_list(%L, %L)', bar, '{}')),
    public.s94am_expect(format('select public.atlas_marketing_media_list(%L, %L)', viewer, '{}')),
    public.s94am_expect(format('select public.atlas_marketing_media_list(%L, %L)', gone, '{}')),
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', bar,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 1000))),
    public.s94am_expect(format('select public.atlas_marketing_content_media_set(%L, %L, %L)', bar, c_draft, '[]')),
    public.s94am_expect(format('select public.atlas_marketing_media_collection_upsert(%L, %L)', viewer, '{"name":"x"}'))
  ] loop
    if st <> '42501 atlas:forbidden' then ok := false; raise notice 'role -> %', st; end if;
  end loop;
  insert into s94a_media values ('bartender, viewer and a deactivated manager are refused in SQL', ok, null);

  -- Reserve --------------------------------------------------------------------
  res := public.atlas_marketing_media_reserve(mgr, jsonb_build_object('client_request_id', req1, 'kind', 'image', 'mime_type', 'image/jpeg',
    'byte_size', 633, 'original_filename', 'espresso/martini.jpg', 'client_hints', jsonb_build_object('width', 8, 'height', 8)));
  photo := (res->'asset'->>'id')::uuid;
  photo_path := res->>'storage_path';
  insert into s94a_media values ('reserve returns a pending row at a server-chosen path',
    res->'asset'->>'status' = 'pending_upload'
    and photo_path ~ ('^venues/main/[0-9]{4}/[0-9]{2}/' || photo || '/original\.jpg$')
    and res->'asset'->>'original_filename' = 'espressomartini.jpg'
    and res->'asset'->>'uploaded_by_label' = 'Team member', res::text);

  res2 := public.atlas_marketing_media_reserve(mgr, jsonb_build_object('client_request_id', req1, 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 633));
  insert into s94a_media values ('reserve replays on the same request id',
    (res2->'asset'->>'id')::uuid = photo and (res2->>'replayed')::boolean, res2::text);

  insert into s94a_media values ('a request id reused by someone else is a conflict',
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', adm,
      jsonb_build_object('client_request_id', req1, 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 633))) = '23505 atlas:conflict', null);

  ok := true;
  foreach st in array array[
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/svg+xml', 'byte_size', 100))),
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'text/html', 'byte_size', 100))),
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'video', 'mime_type', 'image/jpeg', 'byte_size', 100))),
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/gif', 'byte_size', 100)))
  ] loop
    if st <> '22023 atlas:unsupported_type' then ok := false; raise notice 'type -> %', st; end if;
  end loop;
  insert into s94a_media values ('SVG, HTML, GIF and cross-kind types are refused at reserve', ok, null);

  insert into s94a_media values ('a photo over 30 MiB and a video over 1 GiB are refused',
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/png', 'byte_size', 31457281))) = '22023 atlas:too_large'
    and public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'video', 'mime_type', 'video/mp4', 'byte_size', 1073741825))) = '22023 atlas:too_large', null);

  -- Complete -------------------------------------------------------------------
  insert into s94a_media values ('complete before the object arrived is refused (upload_missing)',
    public.s94am_expect(format('select public.atlas_marketing_media_complete(%L, %L, %L)', mgr, photo,
      jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 633))) = '22023 atlas:upload_missing', null);

  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('atlas-marketing-media', photo_path, '{"size": 634, "mimetype": "image/jpeg"}');
  set role service_role;
  insert into s94a_media values ('complete refuses an object whose size differs from the reservation',
    public.s94am_expect(format('select public.atlas_marketing_media_complete(%L, %L, %L)', mgr, photo,
      jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 633))) = '22023 atlas:size_mismatch', null);
  reset role;
  update storage.objects set metadata = '{"size": 633, "mimetype": "image/jpeg"}' where name = photo_path;
  set role service_role;
  insert into s94a_media values ('complete refuses content of another kind (sniffed video for a photo)',
    public.s94am_expect(format('select public.atlas_marketing_media_complete(%L, %L, %L)', mgr, photo,
      jsonb_build_object('outcome', 'ready', 'mime_type', 'video/mp4', 'byte_size', 633))) = '22023 atlas:unsupported_type', null);

  res := public.atlas_marketing_media_complete(mgr, photo, jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 633,
    'width', 1080, 'height', 1350, 'sha256', repeat('a', 64), 'server_probe', 'full'));
  insert into s94a_media values ('complete records the sniffed type, server dimensions and ready',
    res->'asset'->>'status' = 'ready' and (res->'asset'->>'width')::int = 1080 and res->'asset'->>'orientation' = 'portrait'
    and res->'asset'->>'metadata_source' = 'server' and res->'asset'->>'thumb_path' = photo_path, res::text);
  res := public.atlas_marketing_media_complete(mgr, photo, jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 633));
  insert into s94a_media values ('complete is idempotent once ready', (res->>'replayed')::boolean, null);

  -- A second photo and a video.
  res := public.atlas_marketing_media_reserve(mgr, jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/png', 'byte_size', 77));
  photo2 := (res->'asset'->>'id')::uuid;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('atlas-marketing-media', res->>'storage_path', '{"size": 77}');
  set role service_role;
  perform public.atlas_marketing_media_complete(mgr, photo2, jsonb_build_object('outcome', 'ready', 'mime_type', 'image/png', 'byte_size', 77, 'width', 800, 'height', 800));
  perform public.atlas_marketing_media_update(mgr, photo2, jsonb_build_object('title', 'Autumn menu'));

  res := public.atlas_marketing_media_reserve(adm, jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'video', 'mime_type', 'video/quicktime', 'byte_size', 977,
    'client_hints', jsonb_build_object('duration_ms', 24000)));
  video := (res->'asset'->>'id')::uuid;
  video_path := res->>'storage_path';
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('atlas-marketing-media', video_path, '{"size": 977}');
  set role service_role;
  res := public.atlas_marketing_media_complete(adm, video, jsonb_build_object('outcome', 'ready', 'mime_type', 'video/mp4', 'byte_size', 977,
    'width', 1080, 'height', 1920, 'duration_ms', 24000, 'rotation', 0, 'has_audio', true, 'server_probe', 'full'));
  insert into s94a_media values ('a MOV that is really MP4 is corrected to the sniffed type within the kind',
    res->'asset'->>'mime_type' = 'video/mp4' and (res->'asset'->>'duration_ms')::int = 24000 and res->'asset'->>'thumb_path' is null, res::text);

  -- Rejected upload and abandon.
  res := public.atlas_marketing_media_reserve(mgr, jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 10));
  pending := (res->'asset'->>'id')::uuid;
  res := public.atlas_marketing_media_complete(mgr, pending, jsonb_build_object('outcome', 'rejected', 'reject_reason', 'magic_bytes'));
  insert into s94a_media values ('a rejected upload is recorded with its reason and path for removal',
    res->'asset'->>'status' = 'rejected' and res->>'storage_path' is not null, res::text);
  res := public.atlas_marketing_media_reserve(mgr, jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 10));
  res2 := public.atlas_marketing_media_abandon(mgr, (res->'asset'->>'id')::uuid);
  insert into s94a_media values ('abandon ends an unfinished upload and returns its path',
    res2->>'status' = 'abandoned' and res2->>'storage_path' = res->>'storage_path'
    and public.s94am_expect(format('select public.atlas_marketing_media_abandon(%L, %L)', mgr, photo)) = '22023 atlas:conflict', res2::text);

  -- Pending quota: 20 unfinished uploads per person.
  select count(*) into n from atlas_private.marketing_media_assets where uploaded_by = mgr and status = 'pending_upload';
  for n in (n + 1)..20 loop
    perform public.atlas_marketing_media_reserve(mgr, jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 10));
  end loop;
  insert into s94a_media values ('a person can hold at most 20 unfinished uploads',
    public.s94am_expect(format('select public.atlas_marketing_media_reserve(%L, %L)', mgr,
      jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'image', 'mime_type', 'image/jpeg', 'byte_size', 10))) = '22023 atlas:quota', null);

  -- Variants -------------------------------------------------------------------
  res := public.atlas_marketing_media_reserve_variant(adm, jsonb_build_object('client_request_id', gen_random_uuid(), 'asset_id', video,
    'purpose', 'poster', 'mime_type', 'image/jpeg', 'byte_size', 500, 'source_time_ms', 1000, 'width', 400, 'height', 711));
  var_id := (res->'variant'->>'id')::uuid; var_path := res->>'storage_path';
  insert into s94a_media values ('a variant lives under the asset folder at v/<uuid>.jpg',
    var_path = regexp_replace(video_path, 'original\.mov$', '') || 'v/' || var_id || '.jpg', var_path);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('atlas-marketing-media', var_path, '{"size": 500}');
  set role service_role;
  perform public.atlas_marketing_media_complete_variant(adm, var_id, jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 500, 'width', 400, 'height', 711));
  res := public.atlas_marketing_media_reserve_variant(adm, jsonb_build_object('client_request_id', gen_random_uuid(), 'asset_id', video,
    'purpose', 'poster', 'mime_type', 'image/jpeg', 'byte_size', 600, 'source_time_ms', 7000));
  var2 := (res->'variant'->>'id')::uuid;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('atlas-marketing-media', res->>'storage_path', '{"size": 600}');
  set role service_role;
  perform public.atlas_marketing_media_complete_variant(adm, var2, jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 600));
  insert into s94a_media values ('a new poster replaces the live one and becomes the tile',
    (select count(*) from atlas_private.marketing_media_variants where asset_id = video and purpose = 'poster' and status = 'ready') = 1
    and (select status from atlas_private.marketing_media_variants where id = var_id) = 'deleted'
    and atlas_private.marketing_media_thumb_path(video) = res->>'storage_path', null);
  insert into s94a_media values ('crops and publish copies are for photos; a crop needs a valid rectangle',
    public.s94am_expect(format('select public.atlas_marketing_media_reserve_variant(%L, %L)', mgr, jsonb_build_object('client_request_id', gen_random_uuid(),
      'asset_id', video, 'purpose', 'crop', 'mime_type', 'image/jpeg', 'byte_size', 10, 'aspect_ratio', '1:1', 'crop_rect', '{"x":0,"y":0,"w":1,"h":1}'::jsonb))) = '22023 atlas:unsupported_type'
    and public.s94am_expect(format('select public.atlas_marketing_media_reserve_variant(%L, %L)', mgr, jsonb_build_object('client_request_id', gen_random_uuid(),
      'asset_id', photo, 'purpose', 'crop', 'mime_type', 'image/jpeg', 'byte_size', 10, 'aspect_ratio', '4:5', 'crop_rect', '{"x":0.5,"y":0,"w":0.8,"h":1}'::jsonb))) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_reserve_variant(%L, %L)', mgr, jsonb_build_object('client_request_id', gen_random_uuid(),
      'asset_id', photo, 'purpose', 'publish', 'mime_type', 'image/svg+xml', 'byte_size', 10))) = '22023 atlas:unsupported_type', null);

  -- Details --------------------------------------------------------------------
  res := public.atlas_marketing_media_update(mgr, photo, jsonb_build_object('alt_text', 'An espresso martini on the bar',
    'focal_point', jsonb_build_object('x', 0.42, 'y', 0.3), 'tags', jsonb_build_array('Cocktails', 'Friday Quiz', 'cocktails')));
  insert into s94a_media values ('update saves alt text, focal point and free tags (deduplicated by slug)',
    res->>'alt_text' = 'An espresso martini on the bar' and (res->'focal_point'->>'x')::numeric = 0.42
    and jsonb_array_length(res->'tags') = 2 and res->'tags' @> '[{"slug":"friday-quiz","label":"Friday Quiz"}]', res::text);
  res := public.atlas_marketing_media_update(mgr, photo, jsonb_build_object('title', 'Espresso martini'));
  insert into s94a_media values ('update is a partial patch (unsent fields are kept)',
    res->>'alt_text' = 'An espresso martini on the bar' and jsonb_array_length(res->'tags') = 2 and res->>'name' = 'Espresso martini', null);
  res := public.atlas_marketing_media_update(adm, video, jsonb_build_object('trim', jsonb_build_object('start_ms', 1000, 'end_ms', 20000), 'cover_variant_id', var2));
  insert into s94a_media values ('trim and cover frame are saved for a video',
    (res->'trim'->>'end_ms')::int = 20000 and res->>'cover_variant_id' = var2::text, res::text);
  insert into s94a_media values ('invalid focal point, trim past the end, trim on a photo and a foreign cover are refused',
    public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, photo, '{"focal_point":{"x":1.5,"y":0}}')) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, video, '{"trim":{"start_ms":0,"end_ms":25000}}')) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, photo, '{"trim":{"start_ms":0,"end_ms":1000}}')) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, photo, jsonb_build_object('cover_variant_id', var2))) = '22023 atlas:invalid_request', null);

  -- Crop copies: the current crop per ratio lives in metadata.crops.
  res := public.atlas_marketing_media_reserve_variant(mgr, jsonb_build_object('client_request_id', gen_random_uuid(), 'asset_id', photo,
    'purpose', 'crop', 'mime_type', 'image/jpeg', 'byte_size', 300, 'aspect_ratio', '4:5', 'crop_rect', '{"x":0.1,"y":0,"w":0.8,"h":1}'::jsonb));
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('atlas-marketing-media', res->>'storage_path', '{"size": 300}');
  set role service_role;
  perform public.atlas_marketing_media_complete_variant(mgr, (res->'variant'->>'id')::uuid, jsonb_build_object('outcome', 'ready', 'mime_type', 'image/jpeg', 'byte_size', 300, 'width', 864, 'height', 1080));
  res2 := public.atlas_marketing_media_update(mgr, photo, jsonb_build_object('crops', jsonb_build_object('4:5', jsonb_build_object('variant_id', res->'variant'->>'id', 'mode', 'adjusted'))));
  insert into s94a_media values ('the current crop per ratio is recorded; a wrong ratio or a foreign variant is refused',
    res2->'crops'->'4:5'->>'mode' = 'adjusted'
    and (public.atlas_marketing_media_resolve(array[photo], null)->'assets'->0->'crops'->'4:5'->>'variant_id') = res->'variant'->>'id'
    and public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, photo,
      jsonb_build_object('crops', jsonb_build_object('1:1', jsonb_build_object('variant_id', res->'variant'->>'id'))))) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, photo,
      jsonb_build_object('crops', jsonb_build_object('3:2', null)))) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_update(%L, %L, %L)', mgr, photo,
      jsonb_build_object('crops', jsonb_build_object('9:16', jsonb_build_object('variant_id', var2))))) = '22023 atlas:invalid_request', res2::text);

  -- List -----------------------------------------------------------------------
  reset role;
  update atlas_private.marketing_media_assets set created_at = now() - interval '2 hours' where id = photo;
  update atlas_private.marketing_media_assets set created_at = now() - interval '1 hour' where id = photo2;
  set role service_role;
  res := public.atlas_marketing_media_list(mgr, '{}');
  insert into s94a_media values ('the library lists ready media only, newest first, with counts and tags',
    (res->>'total')::int = 3 and (res->'counts'->>'video')::int = 1 and jsonb_array_length(res->'tags') = 2
    and res->'assets'->0->>'id' = video::text, res::text);
  insert into s94a_media values ('filters: kind, tag, search and name sort',
    (public.atlas_marketing_media_list(mgr, '{"kind":"video"}')->>'total')::int = 1
    and (public.atlas_marketing_media_list(mgr, '{"tags":["friday-quiz"]}')->>'total')::int = 1
    and (public.atlas_marketing_media_list(mgr, '{"tags":["friday-quiz","cocktails"]}')->>'total')::int = 1
    and (public.atlas_marketing_media_list(mgr, '{"q":"espresso"}')->>'total')::int = 1
    and (public.atlas_marketing_media_list(mgr, '{"q":"100%"}')->>'total')::int = 0
    and public.atlas_marketing_media_list(mgr, '{"sort":"name"}')->'assets'->0->>'id' = photo2::text
    and (public.atlas_marketing_media_list(mgr, '{"limit":2}')->>'next_cursor') = '2', null);
  insert into s94a_media values ('invalid filters are refused',
    public.s94am_expect(format('select public.atlas_marketing_media_list(%L, %L)', mgr, '{"kind":"gif"}')) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_list(%L, %L)', mgr, '{"collection":"nope"}')) = '22023 atlas:invalid_request', null);

  -- Collections ----------------------------------------------------------------
  res := public.atlas_marketing_media_collection_upsert(mgr, jsonb_build_object('name', 'Autumn carousel', 'asset_ids', jsonb_build_array(photo, photo2, video)));
  col := (res->>'id')::uuid;
  insert into s94a_media values ('a collection keeps its order; the first item is the cover',
    res->'asset_ids' = jsonb_build_array(photo, photo2, video) and (res->>'cover_asset_id')::uuid = photo and (res->>'count')::int = 3, res::text);
  res := public.atlas_marketing_media_collection_reorder(mgr, col, array[video, photo, photo2]);
  insert into s94a_media values ('reorder by explicit array persists',
    res->'asset_ids' = jsonb_build_array(video, photo, photo2)
    and public.atlas_marketing_media_list(mgr, jsonb_build_object('collection', col))->'assets'->0->>'id' = video::text, res::text);
  insert into s94a_media values ('a reorder that is not a permutation is refused',
    public.s94am_expect(format('select public.atlas_marketing_media_collection_reorder(%L, %L, %L)', mgr, col, array[video, photo])) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_collection_reorder(%L, %L, %L)', mgr, col, array[video, photo, photo])) = '22023 atlas:invalid_request', null);
  insert into s94a_media values ('collection names are unique while live; a collection needs a name',
    public.s94am_expect(format('select public.atlas_marketing_media_collection_upsert(%L, %L)', mgr, '{"name":"autumn CAROUSEL"}')) = '23505 atlas:duplicate_name'
    and public.s94am_expect(format('select public.atlas_marketing_media_collection_upsert(%L, %L)', mgr, '{"name":"  "}')) = '22023 atlas:invalid_request', null);

  -- Content attachment ---------------------------------------------------------
  res := public.atlas_marketing_content_media_set(mgr, c_draft, jsonb_build_array(
    jsonb_build_object('collection_id', col),
    jsonb_build_object('asset_id', photo, 'platform', 'instagram', 'role', 'primary')));
  insert into s94a_media values ('attaching keeps order, copies a collection in its order and records collection_id',
    jsonb_array_length(res->'media') = 4 and (res->>'changed')::boolean and res->>'status' = 'draft'
    and (select array_agg(asset_id order by position) from atlas_private.marketing_content_media where content_id = c_draft and platform is null) = array[video, photo, photo2]::uuid[]
    and (select bool_and(collection_id = col) from atlas_private.marketing_content_media where content_id = c_draft and platform is null)
    and (select position from atlas_private.marketing_content_media where content_id = c_draft and platform = 'instagram') = 0, res::text);
  insert into s94a_media values ('the same asset twice for one platform is refused',
    public.s94am_expect(format('select public.atlas_marketing_content_media_set(%L, %L, %L)', mgr, c_draft,
      jsonb_build_array(jsonb_build_object('asset_id', photo2), jsonb_build_object('collection_id', col)))) = '22023 atlas:invalid_request', null);
  insert into s94a_media values ('media that is not ready is refused',
    public.s94am_expect(format('select public.atlas_marketing_content_media_set(%L, %L, %L)', mgr, c_approved, jsonb_build_array(jsonb_build_object('asset_id', pending)))) = '22023 atlas:not_ready', null);
  res := public.atlas_marketing_content_media_set(mgr, c_approved, jsonb_build_array(jsonb_build_object('asset_id', photo)));
  insert into s94a_media values ('changing media of approved content clears the approval (back to draft) with a revision',
    (res->>'approval_reset')::boolean and res->>'status' = 'draft'
    and (select status from atlas_private.marketing_content_items where id = c_approved) = 'draft'
    and exists (select 1 from atlas_private.marketing_content_revisions r where r.content_id = c_approved and r.change_type = 'edit'), res::text);
  res := public.atlas_marketing_content_media_set(mgr, c_approved, jsonb_build_array(jsonb_build_object('asset_id', photo)));
  insert into s94a_media values ('re-sending the same media is not a change', not (res->>'changed')::boolean, null);
  insert into s94a_media values ('published content is locked',
    public.s94am_expect(format('select public.atlas_marketing_content_media_set(%L, %L, %L)', mgr, c_published, '[]')) = '22023 atlas:content_locked', null);

  -- Deletion guard -------------------------------------------------------------
  reset role;
  insert into atlas_private.marketing_content_media (content_id, asset_id, position, added_by) values (c_scheduled, video, 0, mgr);
  set role service_role;
  insert into s94a_media values ('media in a scheduled post cannot be deleted; the detail says why',
    public.s94am_expect(format('select public.atlas_marketing_media_lifecycle(%L, %L, %L)', mgr, video, 'delete')) = '22023 atlas:in_use'
    and public.atlas_marketing_media_get(mgr, video)->'delete_block'->>'reason' = 'in_use', null);
  reset role;
  insert into atlas_private.marketing_media_publication_uses (asset_id, content_id, platform, fetch_method, outcome)
  values (photo2, c_published, 'facebook', 'signed_url', 'published');
  set role service_role;
  insert into s94a_media values ('media that has been published cannot be deleted',
    public.s94am_expect(format('select public.atlas_marketing_media_lifecycle(%L, %L, %L)', mgr, photo2, 'delete')) = '22023 atlas:in_use'
    and public.atlas_marketing_media_get(mgr, photo2)->'delete_block'->>'reason' = 'published', null);

  res := public.atlas_marketing_media_lifecycle(mgr, photo, 'archive');
  insert into s94a_media values ('archive hides from the library but keeps it resolvable',
    res->'asset'->>'archived_at' is not null and (public.atlas_marketing_media_list(mgr, '{}')->>'total')::int = 2
    and (public.atlas_marketing_media_list(mgr, '{"archived":true}')->>'total')::int = 1
    and (public.atlas_marketing_media_resolve(array[photo], null)->'assets'->0->>'archived')::boolean, null);
  insert into s94a_media values ('archived media stays attached but is not newly attached',
    public.s94am_expect(format('select public.atlas_marketing_content_media_set(%L, %L, %L)', mgr, c_draft, jsonb_build_array(jsonb_build_object('asset_id', photo)))) = 'ok'
    and public.s94am_expect(format('select public.atlas_marketing_content_media_set(%L, %L, %L)', mgr, c_scheduled, jsonb_build_array(jsonb_build_object('asset_id', video), jsonb_build_object('asset_id', photo)))) = '22023 atlas:not_ready', null);
  perform public.atlas_marketing_media_lifecycle(mgr, photo, 'restore');

  -- photo is attached to two drafts (c_draft and c_approved, now a draft): delete detaches it.
  perform public.atlas_marketing_content_media_set(mgr, c_draft, jsonb_build_array(jsonb_build_object('asset_id', photo), jsonb_build_object('asset_id', photo2)));
  res := public.atlas_marketing_media_lifecycle(mgr, photo, 'delete');
  insert into s94a_media values ('deleting media used only in drafts detaches it, closes the gap and purges after 30 days',
    res->'asset'->>'status' = 'deleted' and (res->>'detached')::int = 2
    and (select position from atlas_private.marketing_content_media where content_id = c_draft and asset_id = photo2) = 0
    and (res->'asset'->>'purge_after')::timestamptz between now() + interval '29 days' and now() + interval '31 days'
    and not exists (select 1 from atlas_private.marketing_media_collection_items where asset_id = photo), res::text);

  reset role;
  st := public.s94am_expect(format('delete from atlas_private.marketing_media_assets where id = %L', photo));
  set role service_role;
  insert into s94a_media values ('the delete trigger refuses removing a row before its purge is due', st = '42501 atlas:in_use', st);
  st := public.s94am_expect(format('delete from atlas_private.marketing_media_assets where id = %L', photo2));
  insert into s94a_media values ('the delete trigger refuses removing published media even for the service role', st = '42501 atlas:in_use', st);

  res := public.atlas_marketing_media_lifecycle(mgr, photo, 'restore');
  insert into s94a_media values ('a deleted asset can be restored until the purge',
    res->'asset'->>'status' = 'ready' and res->'asset'->>'deleted_at' is null, null);

  -- Worker resolve -------------------------------------------------------------
  res := public.atlas_marketing_media_resolve(array[photo, video, gen_random_uuid()], array[var2]);
  insert into s94a_media values ('resolve returns storage paths and facts for exactly the requested media, never a URL',
    jsonb_array_length(res->'assets') = 2 and res->>'bucket' = 'atlas-marketing-media'
    and exists (select 1 from jsonb_array_elements(res->'assets') a where a->>'storage_path' = photo_path and a->>'sha256' = repeat('a', 64))
    and exists (select 1 from jsonb_array_elements(res->'variants') v where (v->>'variant_id')::uuid = var2 and v->>'purpose' = 'poster')
    and res::text !~* '(url|token|signature)', res::text);
  insert into s94a_media values ('publication uses never store a URL or token',
    public.s94am_expect(format('select public.atlas_marketing_media_record_use(%L)', jsonb_build_object('asset_id', photo, 'content_id', c_draft,
      'platform', 'instagram', 'fetch_method', 'signed_url', 'signed_url', 'https://x.test/a?token=1'))) = '22023 atlas:invalid_request'
    and public.s94am_expect(format('select public.atlas_marketing_media_record_use(%L)', jsonb_build_object('asset_id', photo, 'content_id', c_draft,
      'platform', 'instagram', 'fetch_method', 'signed_url', 'url_expires_at', now() + interval '15 minutes'))) = 'ok', null);

  -- Maintenance ----------------------------------------------------------------
  insert into s94a_media values ('maintenance is for administrators',
    public.s94am_expect(format('select public.atlas_marketing_media_maintenance_candidates(%L, 10)', mgr)) = '42501 atlas:forbidden', null);
  reset role;
  update atlas_private.marketing_media_assets set upload_expires_at = now() - interval '25 hours' where uploaded_by = mgr and status = 'pending_upload';
  set role service_role;
  res := public.atlas_marketing_media_maintenance_candidates(adm, 100);
  insert into s94a_media values ('maintenance abandons expired uploads and lists abandoned, rejected and due objects only',
    (select count(*) from atlas_private.marketing_media_assets where uploaded_by = mgr and status = 'pending_upload') = 0
    and jsonb_array_length(res->'assets') >= 20
    and not exists (select 1 from jsonb_array_elements(res->'assets') a where (a->>'asset_id')::uuid in (photo, photo2, video)), null);
  res2 := public.atlas_marketing_media_purge_confirm(adm, (select array_agg((a->>'asset_id')::uuid) from jsonb_array_elements(res->'assets') a), '{}');
  insert into s94a_media values ('purge removes only the due rows',
    (res2->>'assets')::int = jsonb_array_length(res->'assets')
    and exists (select 1 from atlas_private.marketing_media_assets where id = photo), res2::text);
end
$service$;

-- Browser roles --------------------------------------------------------------------

do $browser$
declare
  v_role text;
  v_all boolean := true;
  v_state text;
begin
  foreach v_role in array array['authenticated','anon'] loop
    execute format('set local role %I', v_role);
    foreach v_state in array array[
      public.s94am_expect('select public.atlas_marketing_media_list(null, null)'),
      public.s94am_expect('select public.atlas_marketing_media_reserve(null, null)'),
      public.s94am_expect('select public.atlas_marketing_media_resolve(null, null)'),
      public.s94am_expect('select public.atlas_marketing_content_media_set(null, null, null)'),
      public.s94am_expect('select count(*) from atlas_private.marketing_media_assets'),
      public.s94am_expect('select count(*) from atlas_private.marketing_content_media')
    ] loop
      if v_state not like '42501%' then v_all := false; raise notice '% -> %', v_role, v_state; end if;
    end loop;
  end loop;
  insert into s94a_media values ('browser roles cannot read media tables or call media RPCs', v_all, null);
end
$browser$;

reset role;

select jsonb_build_object(
  's94a_media_preview', case when bool_and(passed) and count(*) = 56 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed)
    || case when passed then '{}'::jsonb else jsonb_build_object('detail', detail) end order by test_name)
) from s94a_media;

rollback;
