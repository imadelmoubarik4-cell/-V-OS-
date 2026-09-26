-- S94 media library: production smoke check (READ ONLY, owner-run).
--
-- Run in the Supabase SQL editor after the stage-6 test uploads described in
-- docs/marketing/S94_Rollout_Package.md: upload through Marketing › Media one
-- file of each kind, named with the prefix "atlas-smoke-":
--   atlas-smoke-photo.jpg, atlas-smoke-photo.png, atlas-smoke-photo.webp,
--   atlas-smoke-photo.heic (from an iPhone, uploaded in Safari), atlas-smoke-video.mp4
-- Every row below must show passed = true. Nothing is changed (read-only
-- transaction); no storage paths or URLs are printed.

begin transaction read only;

with bucket as (
  select id, public, file_size_limit, allowed_mime_types
  from storage.buckets where id = 'atlas-marketing-media'
),
bucket_checks as (
  select 'bucket exists and is private' as check_name,
         coalesce((select public = false from bucket), false) as passed,
         null::text as detail
  union all
  select 'bucket accepts only the photo/video allowlist',
         coalesce((select allowed_mime_types::text[] <@ array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime'] from bucket), false),
         (select array_to_string(allowed_mime_types, ', ') from bucket)
  union all
  select 'no storage.objects policy mentions the media bucket',
         not exists (select 1 from pg_catalog.pg_policies p
                     where p.schemaname = 'storage' and p.tablename = 'objects'
                       and (coalesce(p.qual, '') ilike '%atlas-marketing-media%' or coalesce(p.with_check, '') ilike '%atlas-marketing-media%')),
         null
),
assets as (
  select a.*, lower(a.original_filename) as name
  from atlas_private.marketing_media_assets a
  where lower(a.original_filename) like 'atlas-smoke-%' and a.deleted_at is null
),
asset_checks as (
  select 'asset ' || a.name || ' is ready with a sniffed type matching its extension',
         a.status = 'ready' and a.mime_type = case
           when a.name like '%.jpg' or a.name like '%.jpeg' then 'image/jpeg'
           when a.name like '%.png' then 'image/png'
           when a.name like '%.webp' then 'image/webp'
           when a.name like '%.heic' or a.name like '%.heif' then a.mime_type  -- image/heic or image/heif
           when a.name like '%.mp4' then 'video/mp4'
           else '?' end
           and (a.name not like '%.hei_' or a.mime_type in ('image/heic', 'image/heif')),
         a.kind || ' · ' || coalesce(a.mime_type, '-')
  from assets a
  union all
  select 'asset ' || a.name || ' has server-read dimensions and a size matching the stored object',
         coalesce(a.width, 0) > 0 and coalesce(a.height, 0) > 0
           and exists (select 1 from storage.objects o
                       where o.bucket_id = 'atlas-marketing-media' and o.name = a.storage_path
                         and (o.metadata ->> 'size')::bigint = a.byte_size),
         a.width || '×' || a.height || ' · ' || a.byte_size || ' bytes'
  from assets a
  union all
  select 'photo ' || a.name || ' has a ready JPEG publishing copy stored privately',
         exists (select 1 from atlas_private.marketing_media_variants v
                 join storage.objects o on o.bucket_id = 'atlas-marketing-media' and o.name = v.storage_path
                 where v.asset_id = a.id and v.purpose = 'publish' and v.status = 'ready' and v.deleted_at is null
                   and v.mime_type = 'image/jpeg' and coalesce(v.width, 0) > 0 and coalesce(v.height, 0) > 0
                   and (o.metadata ->> 'mimetype') = 'image/jpeg'),
         (select v.width || '×' || v.height || ' JPEG' from atlas_private.marketing_media_variants v
          where v.asset_id = a.id and v.purpose = 'publish' and v.status = 'ready' and v.deleted_at is null limit 1)
  from assets a
  where a.kind = 'image' and a.mime_type <> 'image/jpeg'
  union all
  select 'asset ' || a.name || ' has a ready thumbnail or poster',
         exists (select 1 from atlas_private.marketing_media_variants v
                 where v.asset_id = a.id and v.purpose in ('thumb', 'poster') and v.status = 'ready' and v.deleted_at is null),
         null
  from assets a
),
coverage as (
  select 'all five smoke files were uploaded (jpg, png, webp, heic, mp4)',
         (select count(distinct case
            when name like '%.jpg' or name like '%.jpeg' then 'jpg'
            when name like '%.png' then 'png'
            when name like '%.webp' then 'webp'
            when name like '%.heic' or name like '%.heif' then 'heic'
            when name like '%.mp4' then 'mp4' end) from assets) = 5,
         (select string_agg(name, ', ' order by name) from assets)
)
select check_name, passed, detail from bucket_checks
union all select * from coverage
union all select * from asset_checks
order by passed, check_name;

rollback;
