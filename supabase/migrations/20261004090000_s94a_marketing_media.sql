-- S94A Marketing Media Library (docs/marketing/S94_Publishing_Architecture.md §3,
-- docs/marketing/research/03-media-storage.md §2 and §4).
--
-- Photos and videos the venue posts, stored once and reused in any post.
--
-- Same pattern as atlas-accounting-documents, atlas-ai-media and
-- atlas-profile-photos (pattern B):
-- * The bucket atlas-marketing-media is private and has no storage.objects
--   policy, so a browser can neither list, read nor write an object directly.
--   The atlas-marketing-media Edge Function reserves a row and a server-chosen
--   path, and hands the browser a one-time signed upload token for exactly that
--   path. The browser uploads straight to Storage (single PUT or TUS); the
--   function then verifies size and magic bytes before the asset is ready.
-- * Every table lives in atlas_private with RLS on, a service-role-only policy
--   and no privilege for anon or authenticated.
-- * The public.atlas_marketing_media_* RPCs are service-role only; each one
--   re-checks that the actor is an active manager or administrator
--   (§8: Media is admin/manager only).
-- * Masters are immutable. Thumbnails, posters, crops and JPEG publish copies
--   are variants with their own paths; a new crop is a new row.
-- * Deletion is a soft delete with a 30-day purge. It is refused while the
--   asset is attached to content that is waiting for approval, approved,
--   scheduled, published or completed, or has ever been published
--   (marketing_media_publication_uses). A before-delete trigger backs this up.
-- * The publish worker reads storage paths through
--   public.atlas_marketing_media_resolve (service role, no URLs); providers
--   get short-lived signed URLs that the worker mints at publish time only.
--
-- Re-runnable: tables and indexes use if not exists, policies and triggers are
-- dropped first, functions are create or replace.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Private bucket -----------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'atlas-marketing-media',
  'atlas-marketing-media',
  false,
  1073741824,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();

-- No storage.objects policy is created for this bucket on purpose.

-- Tables -------------------------------------------------------------------------

-- Masters (report 03 §4.1).
create table if not exists atlas_private.marketing_media_assets (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  venue_key text not null default 'main' check (venue_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  kind text not null check (kind in ('image','video')),
  status text not null default 'pending_upload'
    check (status in ('pending_upload','verifying','ready','rejected','abandoned','deleted')),
  bucket_id text not null default 'atlas-marketing-media' check (bucket_id = 'atlas-marketing-media'),
  storage_path text not null unique
    check (storage_path ~ '^venues/[a-z0-9-]{1,32}/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f-]{36}/original\.(jpg|png|webp|heic|heif|mp4|mov)$'),
  original_filename text check (char_length(original_filename) <= 255),
  declared_mime text not null,
  mime_type text,
  declared_bytes bigint not null check (declared_bytes between 1 and 1073741824),
  byte_size bigint check (byte_size between 1 and 1073741824),
  client_sha256 text check (client_sha256 ~ '^[0-9a-f]{64}$'),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width between 1 and 16384),
  height integer check (height between 1 and 16384),
  duration_ms integer check (duration_ms between 0 and 3600000),
  rotation smallint check (rotation in (0,90,180,270)),
  frame_rate numeric(6,3),
  has_audio boolean,
  metadata_source text check (metadata_source in ('server','client','mixed')),
  server_probe text check (server_probe in ('full','partial','none')),
  title text check (char_length(title) <= 180),
  alt_text text check (char_length(alt_text) <= 1000),
  notes text check (char_length(notes) <= 4000),
  source text not null default 'upload' check (source in ('upload','ai_generated','import')),
  rights_status text not null default 'owned'
    check (rights_status in ('owned','licensed','user_generated_permission','unknown')),
  people_consent boolean,
  upload_expires_at timestamptz,
  verified_at timestamptz,
  reject_reason text check (reject_reason is null or reject_reason ~ '^[a-z_]{1,40}$'),
  archived_at timestamptz,
  deleted_at timestamptz,
  purge_after timestamptz,
  uploaded_by uuid not null,
  uploaded_by_label text,
  uploaded_by_role text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_media_assets_duration_video check (kind = 'video' or duration_ms is null),
  constraint marketing_media_assets_ready_verified check (status <> 'ready' or (mime_type is not null and byte_size is not null and verified_at is not null)),
  constraint marketing_media_assets_deleted_purge check (status <> 'deleted' or (deleted_at is not null and purge_after is not null)),
  constraint marketing_media_assets_kind_mime check (
    (kind = 'image' and coalesce(mime_type, declared_mime) in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
    or (kind = 'video' and coalesce(mime_type, declared_mime) in ('video/mp4','video/quicktime'))),
  -- Per-kind limits (the gateway checks them first): photos 30 MiB, videos 1 GiB.
  constraint marketing_media_assets_image_size check (kind = 'video' or declared_bytes <= 31457280)
);
create index if not exists marketing_media_assets_library_idx on atlas_private.marketing_media_assets (venue_key, created_at desc)
  where status = 'ready' and archived_at is null;
create index if not exists marketing_media_assets_pending_idx on atlas_private.marketing_media_assets (upload_expires_at)
  where status in ('pending_upload','verifying');
create index if not exists marketing_media_assets_purge_idx on atlas_private.marketing_media_assets (purge_after) where status = 'deleted';
create index if not exists marketing_media_assets_uploader_idx on atlas_private.marketing_media_assets (uploaded_by, created_at desc);
create index if not exists marketing_media_assets_sha_idx on atlas_private.marketing_media_assets ((coalesce(sha256, client_sha256)))
  where coalesce(sha256, client_sha256) is not null;

-- Derived variants; never replace the master (report 03 §4.2).
create table if not exists atlas_private.marketing_media_variants (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete restrict,
  purpose text not null check (purpose in ('thumb','poster','crop','publish')),
  aspect_ratio text check (aspect_ratio in ('1:1','4:5','9:16','16:9','1.91:1','4:3','original')),
  crop_rect jsonb check (crop_rect is null or (jsonb_typeof(crop_rect) = 'object' and crop_rect ?& array['x','y','w','h'])),
  source_time_ms integer check (source_time_ms >= 0),
  status text not null default 'pending_upload' check (status in ('pending_upload','ready','rejected','deleted')),
  storage_path text not null unique
    check (storage_path ~ '^venues/[a-z0-9-]{1,32}/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f-]{36}/v/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  declared_mime text not null check (declared_mime in ('image/jpeg','image/png','image/webp')),
  declared_bytes integer not null check (declared_bytes between 1 and 31457280),
  mime_type text check (mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer check (byte_size between 1 and 31457280),
  width integer check (width between 1 and 8192),
  height integer check (height between 1 and 8192),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  upload_expires_at timestamptz,
  verified_at timestamptz,
  reject_reason text check (reject_reason is null or reject_reason ~ '^[a-z_]{1,40}$'),
  created_by uuid not null,
  created_by_label text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint marketing_media_variants_crop check (purpose <> 'crop' or (aspect_ratio is not null and crop_rect is not null)),
  constraint marketing_media_variants_poster check (purpose <> 'poster' or source_time_ms is not null),
  constraint marketing_media_variants_ready check (status <> 'ready' or (mime_type is not null and byte_size is not null and verified_at is not null))
);
-- One live thumbnail and one live poster per asset; crops and publish copies keep history.
create unique index if not exists marketing_media_variants_one_thumb on atlas_private.marketing_media_variants (asset_id, purpose)
  where purpose in ('thumb','poster') and status = 'ready' and deleted_at is null;
create index if not exists marketing_media_variants_asset_idx on atlas_private.marketing_media_variants (asset_id);
create index if not exists marketing_media_variants_pending_idx on atlas_private.marketing_media_variants (upload_expires_at)
  where status = 'pending_upload';

-- Collections: named, ordered albums (report 03 §4.3, §4.4).
create table if not exists atlas_private.marketing_media_collections (
  id uuid primary key default gen_random_uuid(),
  venue_key text not null default 'main' check (venue_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 2000),
  campaign_id uuid references atlas_private.marketing_campaigns(id) on delete set null,
  cover_asset_id uuid references atlas_private.marketing_media_assets(id) on delete set null,
  archived_at timestamptz,
  created_by uuid not null,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists marketing_media_collections_name_uq on atlas_private.marketing_media_collections (venue_key, lower(name))
  where archived_at is null;
create index if not exists marketing_media_collections_campaign_idx on atlas_private.marketing_media_collections (campaign_id);
create index if not exists marketing_media_collections_cover_idx on atlas_private.marketing_media_collections (cover_asset_id);

create table if not exists atlas_private.marketing_media_collection_items (
  collection_id uuid not null references atlas_private.marketing_media_collections(id) on delete cascade,
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete cascade,
  position integer not null check (position between 0 and 199),
  added_by uuid not null,
  added_at timestamptz not null default now(),
  primary key (collection_id, asset_id),
  constraint marketing_media_collection_items_position_uq unique (collection_id, position) deferrable initially deferred
);
create index if not exists marketing_media_collection_items_asset_idx on atlas_private.marketing_media_collection_items (asset_id);

-- Free per-venue tags (report 03 §4.5; no hard-coded venue tags).
create table if not exists atlas_private.marketing_media_tags (
  id uuid primary key default gen_random_uuid(),
  venue_key text not null default 'main' check (venue_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  label text not null check (char_length(label) between 1 and 48),
  created_at timestamptz not null default now(),
  unique (venue_key, slug)
);
create table if not exists atlas_private.marketing_media_asset_tags (
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete cascade,
  tag_id uuid not null references atlas_private.marketing_media_tags(id) on delete cascade,
  tagged_by uuid,
  tagged_at timestamptz not null default now(),
  primary key (asset_id, tag_id)
);
create index if not exists marketing_media_asset_tags_tag_idx on atlas_private.marketing_media_asset_tags (tag_id);

-- Content <-> media attachments, the planned use (report 03 §4.6 + contract §3:
-- collection_id records which collection an item was copied from).
create table if not exists atlas_private.marketing_content_media (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete cascade,
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete restrict,
  variant_id uuid references atlas_private.marketing_media_variants(id) on delete restrict,
  collection_id uuid references atlas_private.marketing_media_collections(id) on delete set null,
  platform text check (platform in ('instagram','facebook','tiktok','google-business-profile')),
  position smallint not null check (position between 0 and 34),
  role text not null default 'item' check (role in ('primary','cover','item','thumbnail')),
  alt_text text check (char_length(alt_text) <= 1000),
  added_by uuid not null,
  added_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_content_media_pos_uq unique nulls not distinct (content_id, platform, position)
    deferrable initially deferred,
  constraint marketing_content_media_asset_uq unique nulls not distinct (content_id, platform, asset_id, variant_id)
);
create unique index if not exists marketing_content_media_one_primary on atlas_private.marketing_content_media
  (content_id, coalesce(platform, '*')) where role = 'primary';
create unique index if not exists marketing_content_media_one_cover on atlas_private.marketing_content_media
  (content_id, coalesce(platform, '*')) where role = 'cover';
create index if not exists marketing_content_media_content_idx on atlas_private.marketing_content_media (content_id, platform, position);
create index if not exists marketing_content_media_asset_idx on atlas_private.marketing_content_media (asset_id);
create index if not exists marketing_content_media_variant_idx on atlas_private.marketing_content_media (variant_id);
create index if not exists marketing_content_media_collection_idx on atlas_private.marketing_content_media (collection_id);

-- Actual provider use, written by the publish worker (report 03 §4.7). Never
-- a URL: only its expiry.
create table if not exists atlas_private.marketing_media_publication_uses (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete restrict,
  variant_id uuid references atlas_private.marketing_media_variants(id) on delete restrict,
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete restrict,
  publication_job_id uuid,
  platform text not null check (platform in ('instagram','facebook','tiktok','google-business-profile')),
  fetch_method text not null check (fetch_method in ('signed_url','file_upload','resumable_push','multipart')),
  url_expires_at timestamptz,
  provider_media_id text check (provider_media_id is null or char_length(provider_media_id) <= 200),
  outcome text not null check (outcome in ('attempted','processing','published','failed')),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketing_media_publication_uses_asset_idx on atlas_private.marketing_media_publication_uses (asset_id, created_at desc);
create index if not exists marketing_media_publication_uses_content_idx on atlas_private.marketing_media_publication_uses (content_id);
create index if not exists marketing_media_publication_uses_variant_idx on atlas_private.marketing_media_publication_uses (variant_id);

-- RLS, grants ----------------------------------------------------------------------

do $grants$
declare
  t text;
begin
  foreach t in array array['marketing_media_assets','marketing_media_variants','marketing_media_collections',
    'marketing_media_collection_items','marketing_media_tags','marketing_media_asset_tags',
    'marketing_content_media','marketing_media_publication_uses'] loop
    execute format('alter table atlas_private.%I enable row level security', t);
    execute format('drop policy if exists %I on atlas_private.%I', 'service role manages ' || replace(t, '_', ' '), t);
    execute format('create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      'service role manages ' || replace(t, '_', ' '), t);
    execute format('revoke all on atlas_private.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on atlas_private.%I to service_role', t);
    execute format('revoke truncate, references, trigger on atlas_private.%I from service_role', t);
  end loop;
end
$grants$;

drop trigger if exists marketing_media_assets_touch on atlas_private.marketing_media_assets;
create trigger marketing_media_assets_touch before update on atlas_private.marketing_media_assets
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists marketing_media_collections_touch on atlas_private.marketing_media_collections;
create trigger marketing_media_collections_touch before update on atlas_private.marketing_media_collections
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists marketing_content_media_touch on atlas_private.marketing_content_media;
create trigger marketing_content_media_touch before update on atlas_private.marketing_content_media
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists marketing_media_publication_uses_touch on atlas_private.marketing_media_publication_uses;
create trigger marketing_media_publication_uses_touch before update on atlas_private.marketing_media_publication_uses
  for each row execute function atlas_private.touch_updated_at();

-- Helpers --------------------------------------------------------------------------

-- A staff label that is safe to keep: the display name, never an email
-- address (mirrors _shared/auth.mjs safeDisplayName, S87 rule).
create or replace function atlas_private.marketing_media_safe_label(p_name text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case when p_name is null or pg_catalog.btrim(p_name) = '' or pg_catalog.strpos(p_name, '@') > 0 then 'Team member'
              else pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(p_name), '\s+', ' ', 'g'), 120) end;
$function$;
revoke all on function atlas_private.marketing_media_safe_label(text) from public, anon, authenticated;

-- The actor must be an active manager or administrator. Returns the label.
create or replace function atlas_private.marketing_media_require_manager(p_actor_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor record;
begin
  select p.id, p.role::text as role, p.active, p.display_name into actor
  from public.profiles p where p.id = p_actor_id;
  if actor.id is null or actor.active is not true or actor.role not in ('admin','manager') then
    raise exception 'marketing media is for managers and administrators' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return atlas_private.marketing_media_safe_label(actor.display_name);
end
$function$;
revoke all on function atlas_private.marketing_media_require_manager(uuid) from public, anon, authenticated;

create or replace function atlas_private.marketing_media_actor_role(p_actor_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select p.role::text from public.profiles p where p.id = p_actor_id;
$function$;
revoke all on function atlas_private.marketing_media_actor_role(uuid) from public, anon, authenticated;

-- 'Espresso Martini!' -> 'espresso-martini'
create or replace function atlas_private.marketing_media_slug(p_label text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select nullif(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(coalesce(p_label, '')), '[^a-z0-9]+', '-', 'g'), '-'), 48), '');
$function$;
revoke all on function atlas_private.marketing_media_slug(text) from public, anon, authenticated;

create or replace function atlas_private.marketing_media_orientation(p_width integer, p_height integer, p_rotation smallint)
returns text
language sql
immutable
set search_path = ''
as $function$
  -- width/height are stored as displayed (EXIF orientation or the video
  -- rotation matrix already applied); rotation is informational only.
  select case
    when p_width is null or p_height is null then null
    when p_width = p_height then 'square'
    when p_width > p_height then 'landscape'
    else 'portrait' end;
$function$;
revoke all on function atlas_private.marketing_media_orientation(integer,integer,smallint) from public, anon, authenticated;

-- The object Storage holds at a path, read in the same transaction.
create or replace function atlas_private.marketing_media_object(p_path text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'size', case when (o.metadata->>'size') ~ '^[0-9]{1,12}$' then (o.metadata->>'size')::bigint end,
    'mimetype', o.metadata->>'mimetype',
    'created_at', o.created_at)
  from storage.objects o
  where o.bucket_id = 'atlas-marketing-media' and o.name = p_path
  limit 1;
$function$;
revoke all on function atlas_private.marketing_media_object(text) from public, anon, authenticated;

-- Content states that pin their media: an attached asset cannot be deleted
-- (§3 deletion guard; waiting for approval is included so an approver never
-- sees media disappear under them).
create or replace function atlas_private.marketing_media_pinning_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array['pending_approval','approved','scheduled','published','completed']::text[];
$function$;
revoke all on function atlas_private.marketing_media_pinning_statuses() from public, anon, authenticated;

-- Why an asset cannot be deleted, or null when it can.
create or replace function atlas_private.marketing_media_delete_block(p_asset_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when exists (select 1 from atlas_private.marketing_media_publication_uses u
                 where u.asset_id = p_asset_id and u.outcome in ('published','processing'))
      then pg_catalog.jsonb_build_object('reason', 'published', 'count',
        (select count(distinct u.content_id) from atlas_private.marketing_media_publication_uses u
         where u.asset_id = p_asset_id and u.outcome in ('published','processing')))
    when exists (select 1 from atlas_private.marketing_content_media m
                 join atlas_private.marketing_content_items c on c.id = m.content_id
                 where m.asset_id = p_asset_id and c.status = any(atlas_private.marketing_media_pinning_statuses()))
      then pg_catalog.jsonb_build_object('reason', 'in_use', 'count',
        (select count(distinct m.content_id) from atlas_private.marketing_content_media m
         join atlas_private.marketing_content_items c on c.id = m.content_id
         where m.asset_id = p_asset_id and c.status = any(atlas_private.marketing_media_pinning_statuses())))
    else null end;
$function$;
revoke all on function atlas_private.marketing_media_delete_block(uuid) from public, anon, authenticated;

-- Defence in depth: an asset row is removed only by the purge, only once it is
-- due, and never while it is pinned or has publication history.
create or replace function atlas_private.marketing_media_assets_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'marketing media cannot be truncated' using errcode = '42501', hint = 'atlas:in_use';
  end if;
  if not ((old.status = 'deleted' and old.purge_after <= pg_catalog.now()) or old.status in ('abandoned','rejected')) then
    raise exception 'marketing media is removed only by the purge once it is due' using errcode = '42501', hint = 'atlas:in_use';
  end if;
  if exists (select 1 from atlas_private.marketing_media_publication_uses u where u.asset_id = old.id) then
    raise exception 'marketing media with publication history is kept' using errcode = '42501', hint = 'atlas:in_use';
  end if;
  if atlas_private.marketing_media_delete_block(old.id) is not null then
    raise exception 'marketing media is attached to a post' using errcode = '42501', hint = 'atlas:in_use';
  end if;
  return old;
end
$function$;
revoke all on function atlas_private.marketing_media_assets_delete_guard() from public, anon, authenticated;

drop trigger if exists marketing_media_assets_delete_guard on atlas_private.marketing_media_assets;
create trigger marketing_media_assets_delete_guard before delete on atlas_private.marketing_media_assets
  for each row execute function atlas_private.marketing_media_assets_delete_guard();
drop trigger if exists marketing_media_assets_no_truncate on atlas_private.marketing_media_assets;
create trigger marketing_media_assets_no_truncate before truncate on atlas_private.marketing_media_assets
  for each statement execute function atlas_private.marketing_media_assets_delete_guard();

-- Attachments must point at a ready asset, and at a ready variant of that asset.
-- (Archived assets stay attached where they already were; the set RPC refuses
-- new attachments of archived assets.)
create or replace function atlas_private.marketing_content_media_check()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  a record;
begin
  select m.status into a from atlas_private.marketing_media_assets m where m.id = new.asset_id;
  if a.status is distinct from 'ready' then
    raise exception 'only ready library media can be attached' using errcode = '22023', hint = 'atlas:not_ready';
  end if;
  if new.variant_id is not null and not exists (
    select 1 from atlas_private.marketing_media_variants v
    where v.id = new.variant_id and v.asset_id = new.asset_id and v.status = 'ready') then
    raise exception 'the variant does not belong to the asset' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  return new;
end
$function$;
revoke all on function atlas_private.marketing_content_media_check() from public, anon, authenticated;

drop trigger if exists marketing_content_media_check on atlas_private.marketing_content_media;
create trigger marketing_content_media_check before insert or update of asset_id, variant_id on atlas_private.marketing_content_media
  for each row execute function atlas_private.marketing_content_media_check();

-- JSON builders ----------------------------------------------------------------------
-- Keys ending in _path are storage paths for the gateway only: it signs them
-- into short-lived *_url fields and strips every *_path key before replying.

create or replace function atlas_private.marketing_media_variant_json(v atlas_private.marketing_media_variants)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', v.id, 'asset_id', v.asset_id, 'purpose', v.purpose, 'aspect_ratio', v.aspect_ratio, 'crop_rect', v.crop_rect,
    'source_time_ms', v.source_time_ms, 'status', v.status, 'mime_type', coalesce(v.mime_type, v.declared_mime),
    'byte_size', coalesce(v.byte_size, v.declared_bytes), 'width', v.width, 'height', v.height, 'created_at', v.created_at,
    'storage_path', v.storage_path);
$function$;
revoke all on function atlas_private.marketing_media_variant_json(atlas_private.marketing_media_variants) from public, anon, authenticated;

-- The path the library shows as the tile: the live thumbnail, else the video
-- poster, else a browser-displayable photo master.
create or replace function atlas_private.marketing_media_thumb_path(p_asset_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select v.storage_path from atlas_private.marketing_media_variants v
     where v.asset_id = p_asset_id and v.purpose = 'thumb' and v.status = 'ready' order by v.created_at desc limit 1),
    (select v.storage_path from atlas_private.marketing_media_variants v
     where v.asset_id = p_asset_id and v.purpose = 'poster' and v.status = 'ready' order by v.created_at desc limit 1),
    (select m.storage_path from atlas_private.marketing_media_assets m
     where m.id = p_asset_id and m.kind = 'image' and m.status = 'ready' and m.mime_type in ('image/jpeg','image/png','image/webp')));
$function$;
revoke all on function atlas_private.marketing_media_thumb_path(uuid) from public, anon, authenticated;

create or replace function atlas_private.marketing_media_asset_json(p_asset_id uuid, p_full boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'status', m.status,
    'name', coalesce(nullif(m.title, ''), nullif(m.original_filename, ''), case m.kind when 'video' then 'Video' else 'Photo' end),
    'title', m.title, 'original_filename', m.original_filename,
    'mime_type', coalesce(m.mime_type, m.declared_mime), 'byte_size', coalesce(m.byte_size, m.declared_bytes),
    'width', m.width, 'height', m.height, 'duration_ms', m.duration_ms, 'rotation', m.rotation,
    'orientation', atlas_private.marketing_media_orientation(m.width, m.height, m.rotation),
    'has_audio', m.has_audio, 'frame_rate', m.frame_rate,
    'metadata_source', m.metadata_source, 'server_probe', m.server_probe,
    'alt_text', m.alt_text, 'notes', m.notes, 'rights_status', m.rights_status, 'people_consent', m.people_consent,
    'focal_point', m.metadata->'focal_point', 'trim', m.metadata->'trim', 'cover_variant_id', m.metadata->>'cover_variant_id',
    'crops', coalesce(m.metadata->'crops', '{}'::jsonb),
    'sha256', coalesce(m.sha256, m.client_sha256),
    'reject_reason', m.reject_reason,
    'archived_at', m.archived_at, 'deleted_at', m.deleted_at, 'purge_after', m.purge_after,
    'created_at', m.created_at, 'updated_at', m.updated_at, 'verified_at', m.verified_at,
    'uploaded_by_label', coalesce(m.uploaded_by_label, 'Team member'),
    'tags', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('slug', t.slug, 'label', t.label) order by t.label)
      from atlas_private.marketing_media_asset_tags at join atlas_private.marketing_media_tags t on t.id = at.tag_id
      where at.asset_id = m.id), '[]'::jsonb),
    'used_count', (select count(distinct cm.content_id) from atlas_private.marketing_content_media cm
                   join atlas_private.marketing_content_items c on c.id = cm.content_id
                   where cm.asset_id = m.id and c.status <> 'cancelled'),
    'last_published_at', (select max(u.updated_at) from atlas_private.marketing_media_publication_uses u
                          where u.asset_id = m.id and u.outcome = 'published'),
    'delete_block', atlas_private.marketing_media_delete_block(m.id),
    'thumb_path', atlas_private.marketing_media_thumb_path(m.id)
  )
  || case when p_full then pg_catalog.jsonb_build_object(
    'storage_path', m.storage_path,
    'publish_variant_id', (select v.id from atlas_private.marketing_media_variants v
      where v.asset_id = m.id and v.purpose = 'publish' and v.status = 'ready' order by v.created_at desc limit 1),
    'variants', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.marketing_media_variant_json(v) order by v.purpose, v.created_at desc)
      from atlas_private.marketing_media_variants v where v.asset_id = m.id and v.status = 'ready'), '[]'::jsonb),
    'collections', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name, 'position', i.position) order by c.name)
      from atlas_private.marketing_media_collection_items i join atlas_private.marketing_media_collections c on c.id = i.collection_id
      where i.asset_id = m.id and c.archived_at is null), '[]'::jsonb),
    'used_in', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'content_id', c.id, 'title', c.title, 'status', c.status, 'scheduled_for', c.scheduled_for, 'published_at', c.published_at)
        order by coalesce(c.scheduled_for, c.created_at) desc)
      from atlas_private.marketing_content_items c
      where exists (select 1 from atlas_private.marketing_content_media cm where cm.content_id = c.id and cm.asset_id = m.id)
         or exists (select 1 from atlas_private.marketing_media_publication_uses u where u.content_id = c.id and u.asset_id = m.id)), '[]'::jsonb)
  ) else '{}'::jsonb end
  from atlas_private.marketing_media_assets m
  where m.id = p_asset_id;
$function$;
revoke all on function atlas_private.marketing_media_asset_json(uuid, boolean) from public, anon, authenticated;

create or replace function atlas_private.marketing_media_collection_json(p_collection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', c.id, 'name', c.name, 'description', c.description, 'campaign_id', c.campaign_id,
    'archived_at', c.archived_at, 'created_at', c.created_at, 'updated_at', c.updated_at,
    'created_by_label', coalesce(c.created_by_label, 'Team member'),
    'cover_asset_id', coalesce(c.cover_asset_id, (select i.asset_id from atlas_private.marketing_media_collection_items i
      where i.collection_id = c.id order by i.position limit 1)),
    'count', (select count(*) from atlas_private.marketing_media_collection_items i where i.collection_id = c.id),
    'asset_ids', coalesce((select pg_catalog.jsonb_agg(i.asset_id order by i.position)
      from atlas_private.marketing_media_collection_items i where i.collection_id = c.id), '[]'::jsonb),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'asset_id', m.id, 'position', i.position, 'kind', m.kind,
        'name', coalesce(nullif(m.title, ''), nullif(m.original_filename, ''), case m.kind when 'video' then 'Video' else 'Photo' end),
        'status', m.status, 'archived', m.archived_at is not null,
        'width', m.width, 'height', m.height, 'duration_ms', m.duration_ms, 'mime_type', m.mime_type, 'byte_size', m.byte_size,
        'alt_text', m.alt_text, 'focal_point', m.metadata->'focal_point',
        'thumb_path', atlas_private.marketing_media_thumb_path(m.id)) order by i.position)
      from atlas_private.marketing_media_collection_items i join atlas_private.marketing_media_assets m on m.id = i.asset_id
      where i.collection_id = c.id), '[]'::jsonb))
  from atlas_private.marketing_media_collections c
  where c.id = p_collection_id;
$function$;
revoke all on function atlas_private.marketing_media_collection_json(uuid) from public, anon, authenticated;

-- A post's attached media in order (for the Marketing gateway snapshot and the
-- approval fingerprint). Ordered by platform (common first), then position.
create or replace function atlas_private.marketing_content_media_json(p_content_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', cm.id, 'asset_id', cm.asset_id, 'variant_id', cm.variant_id, 'collection_id', cm.collection_id,
    'platform', cm.platform, 'position', cm.position, 'role', cm.role, 'alt_text', coalesce(cm.alt_text, m.alt_text),
    'kind', m.kind, 'status', m.status, 'archived', m.archived_at is not null,
    'name', coalesce(nullif(m.title, ''), nullif(m.original_filename, ''), case m.kind when 'video' then 'Video' else 'Photo' end),
    'mime_type', coalesce(v.mime_type, m.mime_type), 'byte_size', coalesce(v.byte_size, m.byte_size),
    'width', coalesce(v.width, m.width), 'height', coalesce(v.height, m.height), 'duration_ms', m.duration_ms,
    'aspect_ratio', v.aspect_ratio, 'variant_purpose', v.purpose,
    'sha256', coalesce(v.sha256, m.sha256, m.client_sha256),
    'focal_point', m.metadata->'focal_point', 'trim', m.metadata->'trim',
    'thumb_path', coalesce(case when v.purpose in ('thumb','poster','crop','publish') then v.storage_path end,
                           atlas_private.marketing_media_thumb_path(m.id)))
    order by cm.platform nulls first, cm.position), '[]'::jsonb)
  from atlas_private.marketing_content_media cm
  join atlas_private.marketing_media_assets m on m.id = cm.asset_id
  left join atlas_private.marketing_media_variants v on v.id = cm.variant_id
  where cm.content_id = p_content_id;
$function$;
revoke all on function atlas_private.marketing_content_media_json(uuid) from public, anon, authenticated;

-- Replace a set of tags on an asset from labels (creates new tags).
create or replace function atlas_private.marketing_media_set_tags(p_asset_id uuid, p_labels jsonb, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  entry jsonb;
  label text;
  tag_slug text;
  tag_ids uuid[] := '{}'::uuid[];
  v_tag uuid;
begin
  if p_labels is null or jsonb_typeof(p_labels) <> 'array' or jsonb_array_length(p_labels) > 20 then
    raise exception 'tags must be a list of at most 20' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  for entry in select value from pg_catalog.jsonb_array_elements(p_labels) loop
    if jsonb_typeof(entry) <> 'string' then
      raise exception 'a tag must be text' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    label := pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(entry #>> '{}'), '\s+', ' ', 'g'), 48);
    tag_slug := atlas_private.marketing_media_slug(label);
    if tag_slug is null then continue; end if;
    insert into atlas_private.marketing_media_tags (venue_key, slug, label) values ('main', tag_slug, label)
    on conflict (venue_key, slug) do nothing;
    select t.id into v_tag from atlas_private.marketing_media_tags t where t.venue_key = 'main' and t.slug = tag_slug;
    if not (v_tag = any(tag_ids)) then tag_ids := tag_ids || v_tag; end if;
  end loop;
  delete from atlas_private.marketing_media_asset_tags at where at.asset_id = p_asset_id and not (at.tag_id = any(tag_ids));
  insert into atlas_private.marketing_media_asset_tags (asset_id, tag_id, tagged_by)
  select p_asset_id, t, p_actor_id from pg_catalog.unnest(tag_ids) t
  on conflict (asset_id, tag_id) do nothing;
end
$function$;
revoke all on function atlas_private.marketing_media_set_tags(uuid, jsonb, uuid) from public, anon, authenticated;

-- Gateway RPCs (service_role only) ---------------------------------------------------

-- Library listing. p_filters: kind (image|video), tags (slugs, all must match),
-- q (name, alt text, notes, tag), used ('used'|'unused'), collection (uuid,
-- collection order), archived (true: archived only), sort (newest|oldest|name),
-- cursor (offset), limit (1..100).
create or replace function public.atlas_marketing_media_list(p_actor_id uuid, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  f_kind text := nullif(f->>'kind', '');
  f_q text := nullif(pg_catalog.btrim(coalesce(f->>'q', '')), '');
  f_used text := nullif(f->>'used', '');
  f_collection uuid;
  f_archived boolean;
  f_sort text := coalesce(nullif(f->>'sort', ''), 'newest');
  f_tags text[] := '{}'::text[];
  f_offset integer;
  f_limit integer;
  pattern text;
  rows jsonb;
  total integer;
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  f_archived := coalesce((f->>'archived')::boolean, false);
  f_offset := greatest(0, least(coalesce((nullif(f->>'cursor', ''))::integer, 0), 100000));
  f_limit := greatest(1, least(coalesce((nullif(f->>'limit', ''))::integer, 60), 100));
  if jsonb_typeof(f) <> 'object'
     or (f_kind is not null and f_kind not in ('image','video'))
     or (f_used is not null and f_used not in ('used','unused'))
     or f_sort not in ('newest','oldest','name') then
    raise exception 'invalid filters' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if f ? 'collection' and nullif(f->>'collection', '') is not null then f_collection := (f->>'collection')::uuid; end if;
  if jsonb_typeof(f->'tags') = 'array' then
    select coalesce(array_agg(distinct atlas_private.marketing_media_slug(t)) filter (where atlas_private.marketing_media_slug(t) is not null), '{}')
      into f_tags from pg_catalog.jsonb_array_elements_text(f->'tags') t;
  elsif nullif(f->>'tag', '') is not null then
    f_tags := array[atlas_private.marketing_media_slug(f->>'tag')];
  end if;
  if f_q is not null then
    pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.left(f_q, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with base as (
    select m.id, m.created_at, pg_catalog.lower(coalesce(nullif(m.title, ''), nullif(m.original_filename, ''), case m.kind when 'video' then 'video' else 'photo' end)) as sort_name,
      (select i.position from atlas_private.marketing_media_collection_items i where i.collection_id = f_collection and i.asset_id = m.id) as col_pos
    from atlas_private.marketing_media_assets m
    where m.status = 'ready'
      and (case when f_archived then m.archived_at is not null else m.archived_at is null end)
      and (f_kind is null or m.kind = f_kind)
      and (f_collection is null or exists (select 1 from atlas_private.marketing_media_collection_items i where i.collection_id = f_collection and i.asset_id = m.id))
      and (pg_catalog.cardinality(f_tags) = 0 or (
        select count(distinct t.slug) from atlas_private.marketing_media_asset_tags at
        join atlas_private.marketing_media_tags t on t.id = at.tag_id
        where at.asset_id = m.id and t.slug = any(f_tags)) = pg_catalog.cardinality(f_tags))
      and (pattern is null or m.title ilike pattern or m.original_filename ilike pattern or m.alt_text ilike pattern or m.notes ilike pattern
           or exists (select 1 from atlas_private.marketing_media_asset_tags at join atlas_private.marketing_media_tags t on t.id = at.tag_id
                      where at.asset_id = m.id and t.label ilike pattern))
      and (f_used is null or (f_used = 'used') = exists (
        select 1 from atlas_private.marketing_content_media cm join atlas_private.marketing_content_items c on c.id = cm.content_id
        where cm.asset_id = m.id and c.status <> 'cancelled'))
  ), page as (
    select b.* from base b
    order by
      case when f_collection is not null then b.col_pos end asc nulls last,
      case when f_sort = 'name' then b.sort_name end asc,
      case when f_sort = 'oldest' then b.created_at end asc,
      b.created_at desc, b.id
    offset f_offset limit f_limit
  )
  select (select count(*) from base),
    coalesce((select pg_catalog.jsonb_agg(atlas_private.marketing_media_asset_json(p.id, false)
      order by case when f_collection is not null then p.col_pos end asc nulls last,
               case when f_sort = 'name' then p.sort_name end asc,
               case when f_sort = 'oldest' then p.created_at end asc,
               p.created_at desc, p.id) from page p), '[]'::jsonb)
  into total, rows;

  return pg_catalog.jsonb_build_object(
    'assets', rows,
    'total', total,
    'next_cursor', case when f_offset + f_limit < total then (f_offset + f_limit)::text end,
    'tags', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('slug', t.slug, 'label', t.label, 'count', x.n) order by t.label)
      from atlas_private.marketing_media_tags t
      join lateral (select count(*) as n from atlas_private.marketing_media_asset_tags at
                    join atlas_private.marketing_media_assets m on m.id = at.asset_id
                    where at.tag_id = t.id and m.status = 'ready') x on true
      where x.n > 0), '[]'::jsonb),
    'counts', (select pg_catalog.jsonb_build_object(
      'all', count(*) filter (where m.archived_at is null),
      'image', count(*) filter (where m.archived_at is null and m.kind = 'image'),
      'video', count(*) filter (where m.archived_at is null and m.kind = 'video'),
      'archived', count(*) filter (where m.archived_at is not null))
      from atlas_private.marketing_media_assets m where m.status = 'ready'),
    'collections_count', (select count(*) from atlas_private.marketing_media_collections c where c.archived_at is null)
  );
exception
  when invalid_text_representation then
    raise exception 'invalid filters' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

create or replace function public.atlas_marketing_media_get(p_actor_id uuid, p_asset_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  result := atlas_private.marketing_media_asset_json(p_asset_id, true);
  if result is null or result->>'status' in ('abandoned') then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  return result;
end
$function$;

-- Reserve an upload. p_request: client_request_id, kind, mime_type, extension,
-- byte_size, original_filename, client_sha256, client_hints {width, height,
-- duration_ms}, title. The server picks the path. Idempotent on
-- client_request_id for the same actor (a retry gets the same row).
create or replace function public.atlas_marketing_media_reserve(p_actor_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  r jsonb := coalesce(p_request, '{}'::jsonb);
  req uuid;
  k text := r->>'kind';
  mime text := r->>'mime_type';
  ext text;
  bytes bigint;
  existing atlas_private.marketing_media_assets;
  new_id uuid := gen_random_uuid();
  path text;
  hints jsonb := coalesce(r->'client_hints', '{}'::jsonb);
  pending_count integer;
  pending_bytes bigint;
begin
  if jsonb_typeof(r) <> 'object' or jsonb_typeof(hints) <> 'object' then
    raise exception 'invalid upload' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  req := (r->>'client_request_id')::uuid;
  bytes := (r->>'byte_size')::bigint;
  if req is null then
    raise exception 'a request id is required' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select * into existing from atlas_private.marketing_media_assets m where m.client_request_id = req;
  if existing.id is not null then
    if existing.uploaded_by <> p_actor_id then
      raise exception 'request id already used' using errcode = '23505', hint = 'atlas:conflict';
    end if;
    return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(existing.id, false),
      'storage_path', existing.storage_path, 'replayed', true);
  end if;

  ext := case mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
    when 'image/heic' then 'heic' when 'image/heif' then 'heif' when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' end;
  if k not in ('image','video') or ext is null
     or (k = 'image' and mime not like 'image/%') or (k = 'video' and mime not like 'video/%') then
    raise exception 'unsupported type' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;
  if bytes is null or bytes < 1 or bytes > (case k when 'image' then 31457280 else 1073741824 end) then
    raise exception 'file too large' using errcode = '22023', hint = 'atlas:too_large';
  end if;

  -- Pending quota per person: 20 unfinished uploads, 5 GiB declared.
  select count(*), coalesce(sum(m.declared_bytes), 0) into pending_count, pending_bytes
  from atlas_private.marketing_media_assets m
  where m.uploaded_by = p_actor_id and m.status in ('pending_upload','verifying') and m.upload_expires_at > pg_catalog.now();
  if pending_count >= 20 or pending_bytes + bytes > 5368709120 then
    raise exception 'too many unfinished uploads' using errcode = '22023', hint = 'atlas:quota';
  end if;

  path := pg_catalog.format('venues/main/%s/%s/original.%s',
    pg_catalog.to_char(pg_catalog.now() at time zone 'UTC', 'YYYY/MM'), new_id, ext);

  insert into atlas_private.marketing_media_assets (
    id, client_request_id, kind, status, storage_path, original_filename, declared_mime, declared_bytes, client_sha256,
    width, height, duration_ms, metadata_source, title, upload_expires_at, uploaded_by, uploaded_by_label, uploaded_by_role, metadata)
  values (
    new_id, req, k, 'pending_upload', path,
    nullif(pg_catalog.left(pg_catalog.regexp_replace(coalesce(r->>'original_filename', ''), '[[:cntrl:]/\\]+', '', 'g'), 255), ''),
    mime, bytes,
    case when coalesce(r->>'client_sha256', '') ~ '^[0-9a-f]{64}$' then r->>'client_sha256' end,
    case when (hints->>'width') ~ '^[0-9]{1,5}$' and (hints->>'width')::integer between 1 and 16384 then (hints->>'width')::integer end,
    case when (hints->>'height') ~ '^[0-9]{1,5}$' and (hints->>'height')::integer between 1 and 16384 then (hints->>'height')::integer end,
    case when k = 'video' and (hints->>'duration_ms') ~ '^[0-9]{1,7}$' and (hints->>'duration_ms')::integer <= 3600000 then (hints->>'duration_ms')::integer end,
    'client',
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(r->>'title', '')), 180), ''),
    pg_catalog.now() + interval '2 hours', p_actor_id, label, atlas_private.marketing_media_actor_role(p_actor_id),
    pg_catalog.jsonb_build_object('client_hints', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'width', hints->'width', 'height', hints->'height', 'duration_ms', hints->'duration_ms'))));

  return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(new_id, false),
    'storage_path', path, 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid upload' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- What complete needs before it reads the object: the reserved row and the
-- object Storage holds at its path (null until the upload has finished).
create or replace function public.atlas_marketing_media_upload_state(p_actor_id uuid, p_asset_id uuid, p_variant_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  a atlas_private.marketing_media_assets;
  v atlas_private.marketing_media_variants;
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  if p_variant_id is not null then
    select * into v from atlas_private.marketing_media_variants x where x.id = p_variant_id;
    if v.id is null then
      raise exception 'variant not found' using errcode = 'P0002', hint = 'atlas:not_found';
    end if;
    select * into a from atlas_private.marketing_media_assets x where x.id = v.asset_id;
    return pg_catalog.jsonb_build_object('variant_id', v.id, 'asset_id', v.asset_id, 'status', v.status, 'kind', 'image',
      'purpose', v.purpose, 'declared_mime', v.declared_mime, 'declared_bytes', v.declared_bytes, 'storage_path', v.storage_path,
      'upload_expires_at', v.upload_expires_at, 'object', atlas_private.marketing_media_object(v.storage_path));
  end if;
  select * into a from atlas_private.marketing_media_assets x where x.id = p_asset_id;
  if a.id is null then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  return pg_catalog.jsonb_build_object('asset_id', a.id, 'status', a.status, 'kind', a.kind,
    'declared_mime', a.declared_mime, 'declared_bytes', a.declared_bytes, 'storage_path', a.storage_path,
    'upload_expires_at', a.upload_expires_at, 'uploaded_by_self', a.uploaded_by = p_actor_id,
    'client_hints', a.metadata->'client_hints',
    'object', atlas_private.marketing_media_object(a.storage_path));
end
$function$;

-- Record the verification result. p_result: outcome ('ready'|'rejected'),
-- reject_reason, mime_type (sniffed), byte_size, sha256, width, height,
-- duration_ms, rotation, frame_rate, has_audio, metadata_source, server_probe.
-- The object size is checked again here, inside the transaction.
create or replace function public.atlas_marketing_media_complete(p_actor_id uuid, p_asset_id uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  a atlas_private.marketing_media_assets;
  r jsonb := coalesce(p_result, '{}'::jsonb);
  obj jsonb;
  sniffed text := r->>'mime_type';
  sniffed_kind text;
  w integer; h integer; d integer;
begin
  select * into a from atlas_private.marketing_media_assets x where x.id = p_asset_id for update;
  if a.id is null then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if a.status = 'ready' then
    return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(a.id, false), 'replayed', true);
  end if;
  if a.status not in ('pending_upload','verifying') then
    raise exception 'upload no longer pending' using errcode = '22023', hint = 'atlas:conflict';
  end if;

  if r->>'outcome' = 'rejected' then
    update atlas_private.marketing_media_assets set status = 'rejected',
      reject_reason = coalesce(case when (r->>'reject_reason') ~ '^[a-z_]{1,40}$' then r->>'reject_reason' end, 'rejected')
    where id = a.id;
    return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(a.id, false), 'storage_path', a.storage_path);
  end if;
  if r->>'outcome' is distinct from 'ready' then
    raise exception 'invalid outcome' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  obj := atlas_private.marketing_media_object(a.storage_path);
  if obj is null then
    raise exception 'the upload has not arrived' using errcode = '22023', hint = 'atlas:upload_missing';
  end if;
  if (obj->>'size')::bigint is distinct from a.declared_bytes or (r->>'byte_size')::bigint is distinct from a.declared_bytes then
    raise exception 'size mismatch' using errcode = '22023', hint = 'atlas:size_mismatch';
  end if;
  sniffed_kind := case when sniffed in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then 'image'
                       when sniffed in ('video/mp4','video/quicktime') then 'video' end;
  if sniffed_kind is distinct from a.kind then
    raise exception 'content does not match the kind' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;
  w := case when (r->>'width') ~ '^[0-9]{1,5}$' then (r->>'width')::integer end;
  h := case when (r->>'height') ~ '^[0-9]{1,5}$' then (r->>'height')::integer end;
  d := case when (r->>'duration_ms') ~ '^[0-9]{1,7}$' then (r->>'duration_ms')::integer end;
  if (w is not null and w not between 1 and 16384) or (h is not null and h not between 1 and 16384)
     or (w is not null and h is not null and w::bigint * h > 100000000)
     or (d is not null and (a.kind <> 'video' or d > 3600000)) then
    raise exception 'dimensions out of range' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;

  update atlas_private.marketing_media_assets set
    status = 'ready',
    mime_type = sniffed,
    byte_size = a.declared_bytes,
    sha256 = case when coalesce(r->>'sha256', '') ~ '^[0-9a-f]{64}$' then r->>'sha256' end,
    width = coalesce(w, a.width),
    height = coalesce(h, a.height),
    duration_ms = case when a.kind = 'video' then coalesce(d, a.duration_ms) end,
    rotation = case when (r->>'rotation') in ('0','90','180','270') then (r->>'rotation')::smallint end,
    frame_rate = case when (r->>'frame_rate') ~ '^[0-9]{1,3}(\.[0-9]{1,3})?$' then (r->>'frame_rate')::numeric end,
    has_audio = case when jsonb_typeof(r->'has_audio') = 'boolean' then (r->>'has_audio')::boolean end,
    metadata_source = case
      when (w is not null and h is not null and (a.kind = 'image' or d is not null)) then 'server'
      when w is null and h is null and d is null then 'client'
      else 'mixed' end,
    server_probe = case when (r->>'server_probe') in ('full','partial','none') then r->>'server_probe' else 'none' end,
    verified_at = pg_catalog.now(),
    upload_expires_at = null
  where id = a.id;
  return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(a.id, false), 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid result' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- The uploader (or any manager) gives up on a pending upload. Returns the path
-- so the gateway can remove whatever arrived.
create or replace function public.atlas_marketing_media_abandon(p_actor_id uuid, p_asset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  a atlas_private.marketing_media_assets;
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  select * into a from atlas_private.marketing_media_assets x where x.id = p_asset_id for update;
  if a.id is null then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if a.status in ('abandoned','rejected') then
    return pg_catalog.jsonb_build_object('asset_id', a.id, 'status', a.status, 'storage_path', a.storage_path);
  end if;
  if a.status not in ('pending_upload','verifying') then
    raise exception 'only unfinished uploads can be abandoned' using errcode = '22023', hint = 'atlas:conflict';
  end if;
  update atlas_private.marketing_media_assets set status = 'abandoned', upload_expires_at = null where id = a.id;
  return pg_catalog.jsonb_build_object('asset_id', a.id, 'status', 'abandoned', 'storage_path', a.storage_path);
end
$function$;

-- Reserve a derived copy (thumb, poster, crop, publish). p_request:
-- client_request_id, asset_id, purpose, mime_type (jpeg|png|webp), byte_size,
-- aspect_ratio, crop_rect {x,y,w,h} (0..1), source_time_ms, width, height.
create or replace function public.atlas_marketing_media_reserve_variant(p_actor_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  r jsonb := coalesce(p_request, '{}'::jsonb);
  req uuid;
  a atlas_private.marketing_media_assets;
  existing atlas_private.marketing_media_variants;
  new_id uuid := gen_random_uuid();
  purpose text := r->>'purpose';
  mime text := r->>'mime_type';
  ext text;
  bytes bigint;
  rect jsonb := r->'crop_rect';
  path text;
begin
  req := (r->>'client_request_id')::uuid;
  bytes := (r->>'byte_size')::bigint;
  if req is null then
    raise exception 'a request id is required' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into existing from atlas_private.marketing_media_variants v where v.client_request_id = req;
  if existing.id is not null then
    if existing.created_by <> p_actor_id then
      raise exception 'request id already used' using errcode = '23505', hint = 'atlas:conflict';
    end if;
    return pg_catalog.jsonb_build_object('variant', atlas_private.marketing_media_variant_json(existing), 'storage_path', existing.storage_path, 'replayed', true);
  end if;
  select * into a from atlas_private.marketing_media_assets x where x.id = (r->>'asset_id')::uuid;
  if a.id is null or a.status not in ('ready','pending_upload','verifying') then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  ext := case mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
  if ext is null or purpose not in ('thumb','poster','crop','publish')
     or (purpose = 'poster' and a.kind <> 'video')
     or (purpose in ('crop','publish') and a.kind <> 'image') then
    raise exception 'unsupported variant' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;
  if bytes is null or bytes < 1 or bytes > 31457280 then
    raise exception 'variant too large' using errcode = '22023', hint = 'atlas:too_large';
  end if;
  if rect is not null and jsonb_typeof(rect) <> 'null' then
    if jsonb_typeof(rect) <> 'object' or not (rect ?& array['x','y','w','h'])
       or (rect->>'x')::numeric < 0 or (rect->>'y')::numeric < 0 or (rect->>'w')::numeric <= 0 or (rect->>'h')::numeric <= 0
       or (rect->>'x')::numeric + (rect->>'w')::numeric > 1.0001 or (rect->>'y')::numeric + (rect->>'h')::numeric > 1.0001 then
      raise exception 'invalid crop' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    rect := pg_catalog.jsonb_build_object('x', round((rect->>'x')::numeric, 5), 'y', round((rect->>'y')::numeric, 5),
      'w', round((rect->>'w')::numeric, 5), 'h', round((rect->>'h')::numeric, 5));
  else
    rect := null;
  end if;
  path := pg_catalog.regexp_replace(a.storage_path, 'original\.[a-z0-9]+$', '') || 'v/' || new_id || '.' || ext;
  insert into atlas_private.marketing_media_variants (id, client_request_id, asset_id, purpose, aspect_ratio, crop_rect, source_time_ms,
    status, storage_path, declared_mime, declared_bytes, width, height, upload_expires_at, created_by, created_by_label)
  values (new_id, req, a.id, purpose,
    case when purpose = 'crop' then r->>'aspect_ratio' when r->>'aspect_ratio' in ('1:1','4:5','9:16','16:9','1.91:1','4:3','original') then r->>'aspect_ratio' end,
    case when purpose = 'crop' then rect end,
    case when purpose = 'poster' then greatest(0, coalesce((r->>'source_time_ms')::integer, 0)) end,
    'pending_upload', path, mime, bytes,
    case when (r->>'width')::integer between 1 and 8192 then (r->>'width')::integer end,
    case when (r->>'height')::integer between 1 and 8192 then (r->>'height')::integer end,
    pg_catalog.now() + interval '2 hours', p_actor_id, label);
  return pg_catalog.jsonb_build_object('variant', (select atlas_private.marketing_media_variant_json(v) from atlas_private.marketing_media_variants v where v.id = new_id),
    'storage_path', path, 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid variant' using errcode = '22023', hint = 'atlas:invalid_request';
  when check_violation then
    raise exception 'invalid variant' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

create or replace function public.atlas_marketing_media_complete_variant(p_actor_id uuid, p_variant_id uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  v atlas_private.marketing_media_variants;
  r jsonb := coalesce(p_result, '{}'::jsonb);
  obj jsonb;
  w integer; h integer;
begin
  select * into v from atlas_private.marketing_media_variants x where x.id = p_variant_id for update;
  if v.id is null then
    raise exception 'variant not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if v.status = 'ready' then
    return pg_catalog.jsonb_build_object('variant', atlas_private.marketing_media_variant_json(v), 'replayed', true);
  end if;
  if v.status <> 'pending_upload' then
    raise exception 'variant no longer pending' using errcode = '22023', hint = 'atlas:conflict';
  end if;
  if r->>'outcome' = 'rejected' then
    update atlas_private.marketing_media_variants set status = 'rejected',
      reject_reason = coalesce(case when (r->>'reject_reason') ~ '^[a-z_]{1,40}$' then r->>'reject_reason' end, 'rejected')
    where id = v.id returning * into v;
    return pg_catalog.jsonb_build_object('variant', atlas_private.marketing_media_variant_json(v), 'storage_path', v.storage_path);
  end if;
  obj := atlas_private.marketing_media_object(v.storage_path);
  if obj is null then
    raise exception 'the upload has not arrived' using errcode = '22023', hint = 'atlas:upload_missing';
  end if;
  if (obj->>'size')::bigint is distinct from v.declared_bytes::bigint or (r->>'byte_size')::bigint is distinct from v.declared_bytes::bigint then
    raise exception 'size mismatch' using errcode = '22023', hint = 'atlas:size_mismatch';
  end if;
  if (r->>'mime_type') not in ('image/jpeg','image/png','image/webp') or r->>'outcome' is distinct from 'ready' then
    raise exception 'content does not match' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;
  w := case when (r->>'width') ~ '^[0-9]{1,5}$' then (r->>'width')::integer end;
  h := case when (r->>'height') ~ '^[0-9]{1,5}$' then (r->>'height')::integer end;
  if (w is not null and w not between 1 and 8192) or (h is not null and h not between 1 and 8192) then
    raise exception 'dimensions out of range' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;
  -- A new thumbnail or poster replaces the live one (the old row is kept).
  if v.purpose in ('thumb','poster') then
    update atlas_private.marketing_media_variants set status = 'deleted', deleted_at = pg_catalog.now()
    where asset_id = v.asset_id and purpose = v.purpose and status = 'ready' and id <> v.id;
  end if;
  update atlas_private.marketing_media_variants set status = 'ready', mime_type = r->>'mime_type', byte_size = v.declared_bytes,
    width = coalesce(w, v.width), height = coalesce(h, v.height),
    sha256 = case when coalesce(r->>'sha256', '') ~ '^[0-9a-f]{64}$' then r->>'sha256' end,
    verified_at = pg_catalog.now(), upload_expires_at = null
  where id = v.id returning * into v;
  return pg_catalog.jsonb_build_object('variant', atlas_private.marketing_media_variant_json(v), 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid result' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- Edit details. p_patch (only the keys sent change): title, alt_text, notes,
-- tags (labels), focal_point {x,y} 0..1 or null, trim {start_ms,end_ms} or
-- null (videos), cover_variant_id (a ready variant of this asset) or null,
-- crops {"<ratio>": {variant_id, mode: auto|adjusted} | null} (the current crop
-- copy per ratio; merged into metadata.crops), rights_status, people_consent.
create or replace function public.atlas_marketing_media_update(p_actor_id uuid, p_asset_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  a atlas_private.marketing_media_assets;
  p jsonb := coalesce(p_patch, '{}'::jsonb);
  meta jsonb;
  fx numeric; fy numeric;
  ts integer; te integer;
  crop_key text;
  crop_value jsonb;
  crops jsonb;
begin
  if jsonb_typeof(p) <> 'object' then
    raise exception 'invalid patch' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into a from atlas_private.marketing_media_assets x where x.id = p_asset_id for update;
  if a.id is null or a.status not in ('ready') then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  meta := a.metadata;
  if p ? 'focal_point' then
    if jsonb_typeof(p->'focal_point') = 'null' then
      meta := meta - 'focal_point';
    else
      fx := (p->'focal_point'->>'x')::numeric; fy := (p->'focal_point'->>'y')::numeric;
      if fx is null or fy is null or fx not between 0 and 1 or fy not between 0 and 1 then
        raise exception 'invalid focal point' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
      meta := meta || pg_catalog.jsonb_build_object('focal_point', pg_catalog.jsonb_build_object('x', round(fx, 4), 'y', round(fy, 4)));
    end if;
  end if;
  if p ? 'trim' then
    if jsonb_typeof(p->'trim') = 'null' then
      meta := meta - 'trim';
    else
      ts := (p->'trim'->>'start_ms')::integer; te := (p->'trim'->>'end_ms')::integer;
      if a.kind <> 'video' or ts is null or te is null or ts < 0 or te <= ts
         or (a.duration_ms is not null and te > a.duration_ms) then
        raise exception 'invalid trim' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
      meta := meta || pg_catalog.jsonb_build_object('trim', pg_catalog.jsonb_build_object('start_ms', ts, 'end_ms', te));
    end if;
  end if;
  if p ? 'cover_variant_id' then
    if nullif(p->>'cover_variant_id', '') is null then
      meta := meta - 'cover_variant_id';
    elsif exists (select 1 from atlas_private.marketing_media_variants v where v.id = (p->>'cover_variant_id')::uuid
                  and v.asset_id = a.id and v.status = 'ready' and v.purpose in ('poster','thumb','crop')) then
      meta := meta || pg_catalog.jsonb_build_object('cover_variant_id', p->>'cover_variant_id');
    else
      raise exception 'invalid cover' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;
  if p ? 'crops' then
    if jsonb_typeof(p->'crops') <> 'object' then
      raise exception 'invalid crops' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    crops := coalesce(meta->'crops', '{}'::jsonb);
    for crop_key, crop_value in select key, value from pg_catalog.jsonb_each(p->'crops') loop
      if crop_key not in ('1:1','4:5','9:16','16:9','1.91:1','4:3') then
        raise exception 'invalid crop ratio' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
      if jsonb_typeof(crop_value) = 'null' then
        crops := crops - crop_key;
      elsif jsonb_typeof(crop_value) = 'object' and coalesce(crop_value->>'mode', 'auto') in ('auto','adjusted')
        and exists (select 1 from atlas_private.marketing_media_variants v where v.id = (crop_value->>'variant_id')::uuid
                    and v.asset_id = a.id and v.status = 'ready' and v.purpose = 'crop' and v.aspect_ratio = crop_key) then
        crops := crops || pg_catalog.jsonb_build_object(crop_key, pg_catalog.jsonb_build_object(
          'variant_id', crop_value->>'variant_id', 'mode', coalesce(crop_value->>'mode', 'auto')));
      else
        raise exception 'invalid crop' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
    end loop;
    meta := case when crops = '{}'::jsonb then meta - 'crops' else meta || pg_catalog.jsonb_build_object('crops', crops) end;
  end if;
  update atlas_private.marketing_media_assets set
    title = case when p ? 'title' then nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'title', '')), 180), '') else title end,
    alt_text = case when p ? 'alt_text' then nullif(pg_catalog.btrim(coalesce(p->>'alt_text', '')), '') else alt_text end,
    notes = case when p ? 'notes' then nullif(pg_catalog.btrim(coalesce(p->>'notes', '')), '') else notes end,
    rights_status = case when p ? 'rights_status' then p->>'rights_status' else rights_status end,
    people_consent = case when p ? 'people_consent' then (p->>'people_consent')::boolean else people_consent end,
    metadata = meta
  where id = a.id;
  if p ? 'tags' then
    perform atlas_private.marketing_media_set_tags(a.id, p->'tags', p_actor_id);
  end if;
  return atlas_private.marketing_media_asset_json(a.id, true);
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'invalid patch' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- archive | restore | delete. Delete is a soft delete (purge after 30 days),
-- refused while the asset is pinned (see marketing_media_delete_block). Drafts
-- that used the asset lose the attachment (positions close up); the result
-- says how many.
create or replace function public.atlas_marketing_media_lifecycle(p_actor_id uuid, p_asset_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  a atlas_private.marketing_media_assets;
  block jsonb;
  detached integer := 0;
  touched uuid[] := '{}'::uuid[];
begin
  select * into a from atlas_private.marketing_media_assets x where x.id = p_asset_id for update;
  if a.id is null or a.status not in ('ready','deleted') then
    raise exception 'asset not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if p_action = 'archive' then
    if a.status <> 'ready' then raise exception 'not in the library' using errcode = '22023', hint = 'atlas:conflict'; end if;
    update atlas_private.marketing_media_assets set archived_at = coalesce(archived_at, pg_catalog.now()) where id = a.id;
  elsif p_action = 'restore' then
    if a.status = 'deleted' and a.purge_after <= pg_catalog.now() then
      raise exception 'already purged' using errcode = 'P0002', hint = 'atlas:not_found';
    end if;
    update atlas_private.marketing_media_assets set status = 'ready', archived_at = null, deleted_at = null, purge_after = null where id = a.id;
  elsif p_action = 'delete' then
    if a.status = 'deleted' then
      return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(a.id, false), 'detached', 0);
    end if;
    block := atlas_private.marketing_media_delete_block(a.id);
    if block is not null then
      raise exception 'the asset is used in a post' using errcode = '22023', hint = 'atlas:in_use',
        detail = block::text;
    end if;
    with gone as (
      delete from atlas_private.marketing_content_media cm
      using atlas_private.marketing_content_items c
      where c.id = cm.content_id and cm.asset_id = a.id and c.status in ('idea','draft','changes_requested')
      returning cm.content_id
    )
    select count(*), coalesce(array_agg(distinct gone.content_id), '{}') into detached, touched from gone;
    -- Close the gaps the detached rows left (positions are deferrable-unique).
    update atlas_private.marketing_content_media cm set position = (x.rn - 1)::smallint
    from (select m.id, pg_catalog.row_number() over (partition by m.content_id, m.platform order by m.position) as rn
          from atlas_private.marketing_content_media m where m.content_id = any(touched)) x
    where cm.id = x.id and cm.position <> x.rn - 1;
    update atlas_private.marketing_media_assets set status = 'deleted', deleted_at = pg_catalog.now(),
      purge_after = pg_catalog.now() + interval '30 days' where id = a.id;
    delete from atlas_private.marketing_media_collection_items i where i.asset_id = a.id;
  else
    raise exception 'unknown action' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  return pg_catalog.jsonb_build_object('asset', atlas_private.marketing_media_asset_json(a.id, false), 'detached', detached);
end
$function$;

create or replace function public.atlas_marketing_media_collections(p_actor_id uuid, p_include_archived boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  return pg_catalog.jsonb_build_object('collections', coalesce((
    select pg_catalog.jsonb_agg(atlas_private.marketing_media_collection_json(c.id) order by c.archived_at nulls first, c.updated_at desc)
    from atlas_private.marketing_media_collections c
    where coalesce(p_include_archived, false) or c.archived_at is null), '[]'::jsonb));
end
$function$;

-- Create or edit a collection. p_collection: id (edit), name, description,
-- campaign_id, cover_asset_id, asset_ids (ordered; when sent it replaces the
-- items, so the first one is the cover by default).
create or replace function public.atlas_marketing_media_collection_upsert(p_actor_id uuid, p_collection jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  c jsonb := coalesce(p_collection, '{}'::jsonb);
  target uuid;
  ids uuid[];
  clean_name text := nullif(pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(c->>'name', '')), '\s+', ' ', 'g'), 120), '');
begin
  if jsonb_typeof(c) <> 'object' then
    raise exception 'invalid collection' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if c ? 'asset_ids' then
    if jsonb_typeof(c->'asset_ids') <> 'array' or jsonb_array_length(c->'asset_ids') > 200 then
      raise exception 'invalid items' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    select coalesce(array_agg(x::uuid order by o), '{}') into ids from pg_catalog.jsonb_array_elements_text(c->'asset_ids') with ordinality e(x, o);
    if pg_catalog.cardinality(ids) <> (select count(distinct u) from pg_catalog.unnest(ids) u)
       or exists (select 1 from pg_catalog.unnest(ids) u where not exists (
         select 1 from atlas_private.marketing_media_assets m where m.id = u and m.status = 'ready')) then
      raise exception 'items must be distinct library media' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;
  if nullif(c->>'id', '') is not null then
    target := (c->>'id')::uuid;
    if not exists (select 1 from atlas_private.marketing_media_collections x where x.id = target and x.archived_at is null) then
      raise exception 'collection not found' using errcode = 'P0002', hint = 'atlas:not_found';
    end if;
    update atlas_private.marketing_media_collections x set
      name = case when c ? 'name' then coalesce(clean_name, x.name) else x.name end,
      description = case when c ? 'description' then nullif(pg_catalog.btrim(coalesce(c->>'description', '')), '') else x.description end,
      campaign_id = case when c ? 'campaign_id' then nullif(c->>'campaign_id', '')::uuid else x.campaign_id end,
      cover_asset_id = case when c ? 'cover_asset_id' then nullif(c->>'cover_asset_id', '')::uuid else x.cover_asset_id end
    where x.id = target;
  else
    if clean_name is null then
      raise exception 'a collection needs a name' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    insert into atlas_private.marketing_media_collections (name, description, campaign_id, cover_asset_id, created_by, created_by_label)
    values (clean_name, nullif(pg_catalog.btrim(coalesce(c->>'description', '')), ''), nullif(c->>'campaign_id', '')::uuid,
      nullif(c->>'cover_asset_id', '')::uuid, p_actor_id, label)
    returning id into target;
  end if;
  if ids is not null then
    delete from atlas_private.marketing_media_collection_items i where i.collection_id = target;
    insert into atlas_private.marketing_media_collection_items (collection_id, asset_id, position, added_by)
    select target, u, (o - 1)::integer, p_actor_id from pg_catalog.unnest(ids) with ordinality t(u, o);
  end if;
  return atlas_private.marketing_media_collection_json(target);
exception
  when unique_violation then
    raise exception 'a collection with that name exists' using errcode = '23505', hint = 'atlas:duplicate_name';
  when invalid_text_representation or foreign_key_violation or check_violation then
    raise exception 'invalid collection' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- Reorder by explicit array: exactly a permutation of the current items.
create or replace function public.atlas_marketing_media_collection_reorder(p_actor_id uuid, p_collection_id uuid, p_asset_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  current_ids uuid[];
begin
  perform 1 from atlas_private.marketing_media_collections c where c.id = p_collection_id and c.archived_at is null for update;
  if not found then
    raise exception 'collection not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  select coalesce(array_agg(i.asset_id order by i.asset_id), '{}') into current_ids
  from atlas_private.marketing_media_collection_items i where i.collection_id = p_collection_id;
  if p_asset_ids is null or pg_catalog.cardinality(p_asset_ids) <> pg_catalog.cardinality(current_ids)
     or (select coalesce(array_agg(u order by u), '{}') from pg_catalog.unnest(p_asset_ids) u) <> current_ids
     or pg_catalog.cardinality(p_asset_ids) <> (select count(distinct u) from pg_catalog.unnest(p_asset_ids) u) then
    raise exception 'the order must list every item once' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  update atlas_private.marketing_media_collection_items i set position = (t.o - 1)::integer
  from pg_catalog.unnest(p_asset_ids) with ordinality t(u, o)
  where i.collection_id = p_collection_id and i.asset_id = t.u;
  update atlas_private.marketing_media_collections set updated_at = pg_catalog.now() where id = p_collection_id;
  return atlas_private.marketing_media_collection_json(p_collection_id);
end
$function$;

create or replace function public.atlas_marketing_media_collection_archive(p_actor_id uuid, p_collection_id uuid, p_archived boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
begin
  update atlas_private.marketing_media_collections set archived_at = case when coalesce(p_archived, true) then pg_catalog.now() end
  where id = p_collection_id;
  if not found then
    raise exception 'collection not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  return atlas_private.marketing_media_collection_json(p_collection_id);
exception
  when unique_violation then
    raise exception 'a collection with that name exists' using errcode = '23505', hint = 'atlas:duplicate_name';
end
$function$;

-- Set a post's media (replace-all, in order). Used by the Marketing gateway
-- (set-content-media). p_items: [{asset_id, variant_id?, platform?, role?,
-- alt_text?}] or [{collection_id, platform?}] (a collection is copied in its
-- order and each row keeps collection_id). Positions follow the array order
-- within each platform (null = every platform). Content that is published,
-- completed, rejected or cancelled is locked. A change to approved or
-- scheduled content is a material edit: the approval is cleared and the post
-- goes back to draft (§0.1; the publishing track cancels unstarted deliveries
-- through the approval fingerprint).
create or replace function public.atlas_marketing_content_media_set(p_actor_id uuid, p_content_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.marketing_media_require_manager(p_actor_id);
  actor_role text := atlas_private.marketing_media_actor_role(p_actor_id);
  content atlas_private.marketing_content_items;
  after_row atlas_private.marketing_content_items;
  entry jsonb;
  expanded jsonb := '[]'::jsonb;
  before_items jsonb;
  after_items jsonb;
  next_items jsonb;
  changed boolean;
  reset boolean := false;
  platform_key text;
  entry_role text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 140 then
    raise exception 'items must be a list' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into content from atlas_private.marketing_content_items c where c.id = p_content_id for update;
  if content.id is null then
    raise exception 'content not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if content.status in ('published','completed','rejected','cancelled') then
    raise exception 'this post can no longer change' using errcode = '22023', hint = 'atlas:content_locked';
  end if;

  for entry in select value from pg_catalog.jsonb_array_elements(p_items) loop
    if jsonb_typeof(entry) <> 'object' then
      raise exception 'invalid item' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    platform_key := nullif(entry->>'platform', '');
    if platform_key is not null and platform_key not in ('instagram','facebook','tiktok','google-business-profile') then
      raise exception 'invalid platform' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    entry_role := coalesce(nullif(entry->>'role', ''), 'item');
    if entry_role not in ('primary','cover','item','thumbnail') then
      raise exception 'invalid role' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if nullif(entry->>'asset_id', '') is null and nullif(entry->>'collection_id', '') is not null then
      if not exists (select 1 from atlas_private.marketing_media_collections c where c.id = (entry->>'collection_id')::uuid and c.archived_at is null) then
        raise exception 'collection not found' using errcode = 'P0002', hint = 'atlas:not_found';
      end if;
      expanded := expanded || coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('asset_id', i.asset_id, 'variant_id', null,
          'collection_id', i.collection_id, 'platform', platform_key, 'role', 'item', 'alt_text', null) order by i.position)
        from atlas_private.marketing_media_collection_items i where i.collection_id = (entry->>'collection_id')::uuid), '[]'::jsonb);
    elsif nullif(entry->>'asset_id', '') is not null then
      expanded := expanded || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'asset_id', (entry->>'asset_id')::uuid, 'variant_id', nullif(entry->>'variant_id', '')::uuid,
        'collection_id', nullif(entry->>'collection_id', '')::uuid, 'platform', platform_key, 'role', entry_role,
        'alt_text', nullif(pg_catalog.left(pg_catalog.btrim(coalesce(entry->>'alt_text', '')), 1000), '')));
    else
      raise exception 'an item needs an asset or a collection' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end loop;

  if exists (select 1 from pg_catalog.jsonb_array_elements(expanded) e group by e->>'platform' having count(*) > 35) then
    raise exception 'at most 35 media per post' using errcode = '22023', hint = 'atlas:too_many';
  end if;

  -- Archived media stays where it already was, but is not newly attached.
  if exists (select 1 from pg_catalog.jsonb_array_elements(expanded) e
             join atlas_private.marketing_media_assets m on m.id = (e->>'asset_id')::uuid
             where m.archived_at is not null
               and not exists (select 1 from atlas_private.marketing_content_media cm where cm.content_id = p_content_id and cm.asset_id = m.id)) then
    raise exception 'archived media cannot be attached' using errcode = '22023', hint = 'atlas:not_ready';
  end if;

  -- The new list with its positions, compared with what is attached now.
  -- Only a structural change (media, order, variant, role, platform) rewrites
  -- the rows; an alt-text or provenance change is updated in place, so the
  -- publishing track's material-change trigger sees only real changes.
  next_items := (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'platform', nullif(t.e->>'platform', ''),
      'position', t.pos,
      'asset_id', t.e->>'asset_id', 'variant_id', nullif(t.e->>'variant_id', ''),
      'collection_id', nullif(t.e->>'collection_id', ''), 'role', t.e->>'role', 'alt_text', nullif(t.e->>'alt_text', ''))
      order by t.o), '[]'::jsonb)
    from (select x.e, x.o, pg_catalog.row_number() over (partition by nullif(x.e->>'platform', '') order by x.o) - 1 as pos
          from pg_catalog.jsonb_array_elements(expanded) with ordinality x(e, o)) t);

  before_items := (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(cm.platform, cm.position, cm.asset_id, cm.variant_id, cm.role)
    order by cm.platform nulls first, cm.position), '[]'::jsonb)
    from atlas_private.marketing_content_media cm where cm.content_id = p_content_id);
  after_items := (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(n.platform, n.position, n.asset_id, n.variant_id, n.role)
    order by n.platform nulls first, n.position), '[]'::jsonb)
    from pg_catalog.jsonb_to_recordset(next_items) as n(platform text, position smallint, asset_id uuid, variant_id uuid, collection_id uuid, role text, alt_text text));
  changed := before_items is distinct from after_items;

  if changed then
    delete from atlas_private.marketing_content_media cm where cm.content_id = p_content_id;
    insert into atlas_private.marketing_content_media (content_id, asset_id, variant_id, collection_id, platform, position, role, alt_text, added_by, added_by_label)
    select p_content_id, n.asset_id, n.variant_id, n.collection_id, n.platform, n.position, n.role, n.alt_text, p_actor_id, label
    from pg_catalog.jsonb_to_recordset(next_items) as n(platform text, position smallint, asset_id uuid, variant_id uuid, collection_id uuid, role text, alt_text text);
  else
    update atlas_private.marketing_content_media cm set alt_text = n.alt_text, collection_id = n.collection_id
    from pg_catalog.jsonb_to_recordset(next_items) as n(platform text, position smallint, asset_id uuid, variant_id uuid, collection_id uuid, role text, alt_text text)
    where cm.content_id = p_content_id and cm.platform is not distinct from n.platform and cm.position = n.position
      and (cm.alt_text is distinct from n.alt_text or cm.collection_id is distinct from n.collection_id);
  end if;

  if changed then
    if content.status in ('approved','scheduled') then
      reset := true;
      update atlas_private.marketing_content_items set status = 'draft', updated_at = pg_catalog.now()
      where id = p_content_id returning * into after_row;
    else
      update atlas_private.marketing_content_items set updated_at = pg_catalog.now()
      where id = p_content_id returning * into after_row;
    end if;
    perform atlas_private.marketing_record_revision(p_content_id, 'edit',
      pg_catalog.jsonb_build_object('status', content.status, 'media', before_items),
      pg_catalog.jsonb_build_object('status', after_row.status, 'media', after_items),
      p_actor_id, label, coalesce(actor_role, 'manager'),
      case when reset then 'Media changed after approval; approval needed again' else 'Media changed' end);
    insert into atlas_private.marketing_workspace_events (event_type, campaign_id, content_id, actor_id, actor_label, actor_role, payload)
    values ('content_updated', content.campaign_id, content.id, p_actor_id, label, coalesce(actor_role, 'manager'),
      pg_catalog.jsonb_build_object('change', 'media', 'items', pg_catalog.jsonb_array_length(after_items), 'approval_reset', reset));
  end if;

  return pg_catalog.jsonb_build_object('content_id', p_content_id, 'changed', changed, 'approval_reset', reset,
    'status', coalesce(after_row.status, content.status), 'media', atlas_private.marketing_content_media_json(p_content_id));
exception
  when invalid_text_representation then
    raise exception 'invalid item' using errcode = '22023', hint = 'atlas:invalid_request';
  when unique_violation then
    raise exception 'duplicate media or role in the post' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- Worker-only (service role, no actor): storage paths and facts for exactly
-- the requested assets and variants. Never a URL. Missing ids are absent from
-- the result; the worker treats them as media_missing.
create or replace function public.atlas_marketing_media_resolve(p_asset_ids uuid[], p_variant_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'bucket', 'atlas-marketing-media',
    'assets', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'asset_id', m.id, 'kind', m.kind, 'status', m.status, 'ready', m.status = 'ready',
        'archived', m.archived_at is not null, 'storage_path', m.storage_path,
        'mime_type', m.mime_type, 'byte_size', m.byte_size, 'width', m.width, 'height', m.height,
        'duration_ms', m.duration_ms, 'rotation', m.rotation, 'has_audio', m.has_audio,
        'orientation', atlas_private.marketing_media_orientation(m.width, m.height, m.rotation),
        'sha256', coalesce(m.sha256, m.client_sha256), 'sha256_source', case when m.sha256 is not null then 'server' when m.client_sha256 is not null then 'client' end,
        'alt_text', m.alt_text, 'focal_point', m.metadata->'focal_point', 'trim', m.metadata->'trim',
        'cover_variant_id', m.metadata->>'cover_variant_id', 'crops', coalesce(m.metadata->'crops', '{}'::jsonb),
        'publish_variant_id', (select v.id from atlas_private.marketing_media_variants v
          where v.asset_id = m.id and v.purpose = 'publish' and v.status = 'ready' order by v.created_at desc limit 1),
        'poster_variant_id', (select v.id from atlas_private.marketing_media_variants v
          where v.asset_id = m.id and v.purpose = 'poster' and v.status = 'ready' order by v.created_at desc limit 1)
      ) order by m.id)
      from atlas_private.marketing_media_assets m
      where m.id = any(coalesce(p_asset_ids, '{}'::uuid[]))), '[]'::jsonb),
    'variants', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'variant_id', v.id, 'asset_id', v.asset_id, 'purpose', v.purpose, 'aspect_ratio', v.aspect_ratio, 'crop_rect', v.crop_rect,
        'source_time_ms', v.source_time_ms, 'status', v.status, 'ready', v.status = 'ready', 'storage_path', v.storage_path,
        'mime_type', v.mime_type, 'byte_size', v.byte_size, 'width', v.width, 'height', v.height, 'sha256', v.sha256
      ) order by v.id)
      from atlas_private.marketing_media_variants v
      where v.id = any(coalesce(p_variant_ids, '{}'::uuid[]))
         or (v.asset_id = any(coalesce(p_asset_ids, '{}'::uuid[])) and v.status = 'ready' and v.purpose in ('publish','poster'))), '[]'::jsonb)
  );
$function$;

-- Worker-only: one row per asset/variant per provider attempt (never a URL).
create or replace function public.atlas_marketing_media_record_use(p_use jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  u jsonb := coalesce(p_use, '{}'::jsonb);
  use_id uuid;
begin
  if u::text ~* '"(url|signed_url|signedurl|token|access_token)"\s*:' then
    raise exception 'urls and tokens are never stored' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if nullif(u->>'id', '') is not null then
    update atlas_private.marketing_media_publication_uses set
      outcome = coalesce(nullif(u->>'outcome', ''), outcome),
      provider_media_id = coalesce(nullif(pg_catalog.left(u->>'provider_media_id', 200), ''), provider_media_id),
      error_code = case when u ? 'error_code' then nullif(pg_catalog.left(u->>'error_code', 80), '') else error_code end
    where id = (u->>'id')::uuid returning id into use_id;
    if use_id is null then
      raise exception 'use not found' using errcode = 'P0002', hint = 'atlas:not_found';
    end if;
  else
    insert into atlas_private.marketing_media_publication_uses (asset_id, variant_id, content_id, publication_job_id, platform,
      fetch_method, url_expires_at, provider_media_id, outcome, error_code)
    values ((u->>'asset_id')::uuid, nullif(u->>'variant_id', '')::uuid, (u->>'content_id')::uuid, nullif(u->>'publication_job_id', '')::uuid,
      u->>'platform', u->>'fetch_method', nullif(u->>'url_expires_at', '')::timestamptz,
      nullif(pg_catalog.left(u->>'provider_media_id', 200), ''), coalesce(nullif(u->>'outcome', ''), 'attempted'),
      nullif(pg_catalog.left(u->>'error_code', 80), ''))
    returning id into use_id;
  end if;
  return pg_catalog.jsonb_build_object('id', use_id);
exception
  when invalid_text_representation or check_violation or foreign_key_violation or not_null_violation then
    raise exception 'invalid use' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- Maintenance (admin through the gateway): pending uploads past their window
-- (2 h token + 22 h TUS window) become abandoned; returns the object paths to
-- remove for abandoned/rejected uploads and for deleted assets whose purge is
-- due (masters and variants). Assets with publication history are kept.
create or replace function public.atlas_marketing_media_maintenance_candidates(p_actor_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lim integer := greatest(1, least(coalesce(p_limit, 100), 500));
  role_text text := atlas_private.marketing_media_actor_role(p_actor_id);
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  if role_text <> 'admin' then
    raise exception 'maintenance is for administrators' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  update atlas_private.marketing_media_assets set status = 'abandoned', upload_expires_at = null
  where status in ('pending_upload','verifying') and upload_expires_at < pg_catalog.now() - interval '22 hours';
  update atlas_private.marketing_media_variants set status = 'rejected', reject_reason = 'abandoned', upload_expires_at = null
  where status = 'pending_upload' and upload_expires_at < pg_catalog.now() - interval '22 hours';
  return pg_catalog.jsonb_build_object('assets', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('asset_id', m.id, 'status', m.status,
      'paths', pg_catalog.to_jsonb(array[m.storage_path] || coalesce((select array_agg(v.storage_path) from atlas_private.marketing_media_variants v where v.asset_id = m.id), '{}'::text[]))))
    from (select * from atlas_private.marketing_media_assets x
          where (x.status in ('abandoned','rejected') or (x.status = 'deleted' and x.purge_after <= pg_catalog.now()))
            and not exists (select 1 from atlas_private.marketing_media_publication_uses u where u.asset_id = x.id)
            and atlas_private.marketing_media_delete_block(x.id) is null
          order by x.updated_at limit lim) m), '[]'::jsonb),
    'variants', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('variant_id', v.id, 'path', v.storage_path))
    from (select * from atlas_private.marketing_media_variants x
          where x.status = 'rejected'
            and not exists (select 1 from atlas_private.marketing_content_media cm where cm.variant_id = x.id)
            and not exists (select 1 from atlas_private.marketing_media_publication_uses u where u.variant_id = x.id)
          order by x.created_at limit lim) v), '[]'::jsonb));
end
$function$;

-- After the gateway removed the objects: remove the rows (the delete guard
-- trigger re-checks every asset).
create or replace function public.atlas_marketing_media_purge_confirm(p_actor_id uuid, p_asset_ids uuid[], p_variant_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  removed_assets integer := 0;
  removed_variants integer := 0;
begin
  perform atlas_private.marketing_media_require_manager(p_actor_id);
  if atlas_private.marketing_media_actor_role(p_actor_id) <> 'admin' then
    raise exception 'maintenance is for administrators' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  delete from atlas_private.marketing_media_variants v
  where v.id = any(coalesce(p_variant_ids, '{}'::uuid[])) and v.status = 'rejected'
    and not exists (select 1 from atlas_private.marketing_content_media cm where cm.variant_id = v.id)
    and not exists (select 1 from atlas_private.marketing_media_publication_uses u where u.variant_id = v.id);
  get diagnostics removed_variants = row_count;
  -- Attachments that only remain on rejected or cancelled posts go with the asset.
  delete from atlas_private.marketing_content_media cm
  using atlas_private.marketing_media_assets m, atlas_private.marketing_content_items c
  where m.id = cm.asset_id and c.id = cm.content_id and m.id = any(coalesce(p_asset_ids, '{}'::uuid[]))
    and m.status = 'deleted' and m.purge_after <= pg_catalog.now() and c.status in ('rejected','cancelled');
  delete from atlas_private.marketing_media_variants v
  using atlas_private.marketing_media_assets m
  where m.id = v.asset_id and m.id = any(coalesce(p_asset_ids, '{}'::uuid[]))
    and ((m.status = 'deleted' and m.purge_after <= pg_catalog.now()) or m.status in ('abandoned','rejected'))
    and not exists (select 1 from atlas_private.marketing_content_media cm where cm.asset_id = m.id)
    and not exists (select 1 from atlas_private.marketing_media_publication_uses u where u.asset_id = m.id);
  delete from atlas_private.marketing_media_assets m
  where m.id = any(coalesce(p_asset_ids, '{}'::uuid[]))
    and ((m.status = 'deleted' and m.purge_after <= pg_catalog.now()) or m.status in ('abandoned','rejected'))
    and not exists (select 1 from atlas_private.marketing_content_media cm where cm.asset_id = m.id)
    and not exists (select 1 from atlas_private.marketing_media_variants v where v.asset_id = m.id)
    and not exists (select 1 from atlas_private.marketing_media_publication_uses u where u.asset_id = m.id);
  get diagnostics removed_assets = row_count;
  return pg_catalog.jsonb_build_object('assets', removed_assets, 'variants', removed_variants);
end
$function$;

-- Grants: every public RPC above is service_role only ------------------------------

do $grants$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'atlas\_marketing\_media\_%' or p.proname = 'atlas_marketing_content_media_set')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$grants$;
