-- S98 Atlas Training — private video SOPs, chapters, procedure steps, progress and
-- explicit completion, built ON TOP OF Knowledge (docs/roadmap/Atlas_Training.md,
-- docs/release/Atlas_Training_T0_Architecture_Audit.md).
--
-- A training lesson IS a Knowledge article with article_type='training'. Its title,
-- summary, written SOP (version.content), category, target_roles, required flag,
-- search, acknowledgements and the immutable draft->published version lifecycle are
-- the existing Knowledge machinery, reused unchanged. This migration only adds the
-- training-specific payload that hangs off a Knowledge article version:
--   * a private video (atlas-training-videos bucket, no storage.objects policy),
--   * per-version chapters and procedure steps,
--   * per-user progress (resume position) and explicit, version-specific completion.
--
-- The version_id of a Knowledge article version is stable across the draft->published
-- flip (the same row's `state` changes), and a next edit creates a NEW version_id.
-- So training payload keyed on version_id is authored on the draft, applies once the
-- version publishes, and a v2 draft never mutates v1's video/chapters/steps/completion.
--
-- Security model = the S92/S94A private-file gateway pattern: every table lives in
-- atlas_private with RLS on and a service-role-only policy; the public.atlas_training_*
-- RPCs are SECURITY DEFINER, granted to service_role only, and each re-checks the actor
-- the atlas-training Edge Function passes. The browser never reaches Storage or these
-- tables directly. No production data is written by this migration.
--
-- Re-runnable: create table/index if not exists, drop-then-create policies/triggers,
-- create or replace functions, insert ... on conflict for the bucket.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. Private video bucket ---------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'atlas-training-videos',
  'atlas-training-videos',
  false,
  2147483648, -- 2 GiB
  array['video/mp4','video/webm','video/quicktime']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();

-- No storage.objects policy is created for this bucket on purpose: the browser can
-- neither read nor write an object directly. atlas-training uploads with the service
-- role and mints short-lived signed URLs after checking lesson/version/role access.

-- 2. Tables (atlas_private) -------------------------------------------------------

-- One video master. Immutable once a version that uses it is published; a new
-- version uses a new asset (a new row and a new object path).
create table if not exists atlas_private.training_media_assets (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  bucket_id text not null default 'atlas-training-videos'
    check (bucket_id = 'atlas-training-videos'),
  storage_path text not null unique
    check (storage_path ~ '^lessons/[0-9a-f-]{36}/[0-9a-f-]{36}\.(mp4|webm|mov)$'),
  original_filename text check (original_filename is null or char_length(original_filename) <= 255),
  declared_mime text not null check (declared_mime in ('video/mp4','video/webm','video/quicktime')),
  mime_type text check (mime_type in ('video/mp4','video/webm','video/quicktime')),
  declared_bytes bigint not null check (declared_bytes between 1 and 2147483648),
  byte_size bigint check (byte_size between 1 and 2147483648),
  duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 86400),
  width integer check (width is null or width between 1 and 16384),
  height integer check (height is null or height between 1 and 16384),
  upload_status text not null default 'pending'
    check (upload_status in ('pending','stored','failed')),
  upload_expires_at timestamptz,
  created_by uuid not null,
  created_by_label text,
  created_by_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint training_media_assets_stored_probe
    check (upload_status <> 'stored' or (mime_type is not null and byte_size is not null))
);
create index if not exists training_media_assets_pending_idx
  on atlas_private.training_media_assets (upload_expires_at) where upload_status = 'pending';
create index if not exists training_media_assets_creator_idx
  on atlas_private.training_media_assets (created_by, created_at desc);

-- The per-version training payload. One row per Knowledge version that is a training
-- lesson. version_id is the article version (draft or published); article_id is denormalised
-- for cheap lookups. media_asset_id is the video for THIS exact version.
create table if not exists atlas_private.training_lesson_versions (
  version_id uuid primary key
    references atlas_private.knowledge_article_versions(id) on delete cascade,
  article_id uuid not null
    references atlas_private.knowledge_articles(id) on delete cascade,
  media_asset_id uuid references atlas_private.training_media_assets(id) on delete set null,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 1 and 600),
  difficulty text check (difficulty is null or difficulty in ('easy','medium','hard')),
  requires_video boolean not null default true,
  completion_rule text not null default 'explicit' check (completion_rule in ('explicit')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists training_lesson_versions_article_idx
  on atlas_private.training_lesson_versions (article_id);
create index if not exists training_lesson_versions_media_idx
  on atlas_private.training_lesson_versions (media_asset_id) where media_asset_id is not null;

-- Chapters (deep links into the video), per exact version.
create table if not exists atlas_private.training_chapters (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null
    references atlas_private.knowledge_article_versions(id) on delete cascade,
  start_seconds integer not null check (start_seconds between 0 and 86400),
  title text not null check (char_length(title) between 1 and 160),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists training_chapters_version_idx
  on atlas_private.training_chapters (version_id, sort_order, start_seconds);

-- Structured procedure steps (a light checklist alongside the SOP body), per version.
create table if not exists atlas_private.training_steps (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null
    references atlas_private.knowledge_article_versions(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 500),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists training_steps_version_idx
  on atlas_private.training_steps (version_id, sort_order);

-- Per-user, per-version progress and explicit completion. Version-specific: a v1
-- completion row survives when v2 publishes (v2 is a different version_id).
create table if not exists atlas_private.training_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  article_id uuid not null
    references atlas_private.knowledge_articles(id) on delete cascade,
  version_id uuid not null
    references atlas_private.knowledge_article_versions(id) on delete cascade,
  user_label text,
  user_role text,
  started_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  last_video_position_seconds integer not null default 0
    check (last_video_position_seconds between 0 and 86400),
  completion_state text not null default 'in_progress'
    check (completion_state in ('in_progress','completed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, version_id),
  constraint training_progress_completed_at
    check (completion_state <> 'completed' or completed_at is not null)
);
create index if not exists training_progress_user_idx
  on atlas_private.training_progress (user_id, last_opened_at desc);
create index if not exists training_progress_article_idx
  on atlas_private.training_progress (article_id, version_id);
create index if not exists training_progress_completed_idx
  on atlas_private.training_progress (version_id) where completion_state = 'completed';

-- Append-only audit for training-specific consequential actions. Article-level events
-- (created/published/retired) already flow into knowledge_events via the reused
-- Knowledge RPCs; this records what those have no type for.
create table if not exists atlas_private.training_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'media_reserved','media_stored','media_replaced','chapters_saved',
    'steps_saved','lesson_started','lesson_completed'
  )),
  article_id uuid references atlas_private.knowledge_articles(id) on delete set null,
  version_id uuid references atlas_private.knowledge_article_versions(id) on delete set null,
  media_asset_id uuid references atlas_private.training_media_assets(id) on delete set null,
  user_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists training_events_article_idx
  on atlas_private.training_events (article_id, created_at desc) where article_id is not null;
create index if not exists training_events_created_idx
  on atlas_private.training_events (created_at desc);

-- 3. RLS, grants, timestamp + append-only triggers -------------------------------

do $grants$
declare t text;
begin
  foreach t in array array[
    'training_media_assets','training_lesson_versions','training_chapters',
    'training_steps','training_progress','training_events'
  ] loop
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

drop trigger if exists training_media_assets_touch on atlas_private.training_media_assets;
create trigger training_media_assets_touch before update on atlas_private.training_media_assets
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists training_lesson_versions_touch on atlas_private.training_lesson_versions;
create trigger training_lesson_versions_touch before update on atlas_private.training_lesson_versions
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists training_progress_touch on atlas_private.training_progress;
create trigger training_progress_touch before update on atlas_private.training_progress
  for each row execute function atlas_private.touch_updated_at();

-- training_events is append-only (S96 pattern): no update/delete/truncate, with the
-- shared guard allowing only ON DELETE SET NULL nulling of the referential columns.
revoke update, delete, truncate on atlas_private.training_events from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.training_events;
create trigger s96_append_only before update or delete on atlas_private.training_events
  for each row execute function private.audit_append_only('article_id', 'version_id', 'media_asset_id');
drop trigger if exists s96_append_only_no_truncate on atlas_private.training_events;
create trigger s96_append_only_no_truncate before truncate on atlas_private.training_events
  for each statement execute function private.audit_append_only();

-- 4. Helpers (atlas_private) ------------------------------------------------------

-- A staff label safe to store: the display name, never an email (S87 rule).
create or replace function atlas_private.training_safe_label(p_name text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_name is null or pg_catalog.btrim(p_name) = '' or pg_catalog.strpos(p_name, '@') > 0 then 'Team member'
    else pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(p_name), '\s+', ' ', 'g'), 120) end;
$function$;
revoke all on function atlas_private.training_safe_label(text) from public, anon, authenticated;

-- The actor the gateway passes must be an active profile with the claimed role.
-- Returns the safe label. This is the trusted-server authorization re-check.
create or replace function atlas_private.training_require_actor(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare actor record;
begin
  if p_actor_id is null then
    raise exception 'A signed-in Atlas profile is required.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select p.id, p.role::text as role, p.active, p.display_name into actor
  from public.profiles p where p.id = p_actor_id;
  if actor.id is null or actor.active is not true
     or actor.role not in ('admin','manager','bartender','viewer')
     or actor.role is distinct from p_actor_role then
    raise exception 'This Atlas profile cannot access Training.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return atlas_private.training_safe_label(actor.display_name);
end
$function$;
revoke all on function atlas_private.training_require_actor(uuid, text) from public, anon, authenticated;

-- The actor must additionally be a manager or administrator. Returns the label.
create or replace function atlas_private.training_require_manager(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare label text;
begin
  label := atlas_private.training_require_actor(p_actor_id, p_actor_role);
  if p_actor_role not in ('admin','manager') then
    raise exception 'Training authoring is for managers and administrators.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return label;
end
$function$;
revoke all on function atlas_private.training_require_manager(uuid, text) from public, anon, authenticated;

-- Is this article a training lesson visible to the actor? Reuses the Knowledge rule.
create or replace function atlas_private.training_article_visible(p_article_id uuid, p_actor_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select atlas_private.knowledge_article_visible(a, p_actor_role, p_actor_role in ('admin','manager'))
    from atlas_private.knowledge_articles a
    where a.id = p_article_id and a.article_type = 'training'
  ), false);
$function$;
revoke all on function atlas_private.training_article_visible(uuid, text) from public, anon, authenticated;

-- 5. JSON builders ----------------------------------------------------------------
-- storage_path keys are for the gateway only: it signs them into short-lived URLs and
-- strips every *_path key before replying to the browser.

create or replace function atlas_private.training_media_json(p_media_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when m.id is null then null else pg_catalog.jsonb_build_object(
    'id', m.id,
    'upload_status', m.upload_status,
    'mime_type', coalesce(m.mime_type, m.declared_mime),
    'byte_size', coalesce(m.byte_size, m.declared_bytes),
    'duration_seconds', m.duration_seconds,
    'width', m.width, 'height', m.height,
    'original_filename', m.original_filename,
    'storage_path', m.storage_path
  ) end
  from atlas_private.training_media_assets m where m.id = p_media_id;
$function$;
revoke all on function atlas_private.training_media_json(uuid) from public, anon, authenticated;

-- One lesson: the chosen version (draft preferred for managers), chapters, steps,
-- the media descriptor and the caller's own progress. No signed URL here.
create or replace function atlas_private.training_lesson_json(
  p_article_id uuid, p_actor_id uuid, p_actor_role text, p_prefer_draft boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  article atlas_private.knowledge_articles;
  version atlas_private.knowledge_article_versions;
  tv atlas_private.training_lesson_versions;
  progress atlas_private.training_progress;
begin
  select * into article from atlas_private.knowledge_articles
  where id = p_article_id and article_type = 'training';
  if not found then raise exception 'Training lesson not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if not atlas_private.knowledge_article_visible(article, p_actor_role, is_manager) then
    raise exception 'This training lesson is not available to your role.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;

  if is_manager and p_prefer_draft and article.draft_version_id is not null then
    select * into version from atlas_private.knowledge_article_versions where id = article.draft_version_id;
  else
    select * into version from atlas_private.knowledge_article_versions where id = article.current_version_id;
    if not found and is_manager and article.draft_version_id is not null then
      select * into version from atlas_private.knowledge_article_versions where id = article.draft_version_id;
    end if;
  end if;
  if version.id is null then
    raise exception 'This training lesson has no readable version.' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;

  select * into tv from atlas_private.training_lesson_versions where version_id = version.id;
  select * into progress from atlas_private.training_progress
  where user_id = p_actor_id and version_id = version.id;

  return pg_catalog.jsonb_build_object(
    'article', pg_catalog.jsonb_build_object(
      'id', article.id, 'article_key', article.article_key, 'article_type', article.article_type,
      'status', article.status, 'required', article.required, 'target_roles', article.target_roles,
      'category_id', article.category_id, 'current_version_id', article.current_version_id,
      'draft_version_id', article.draft_version_id),
    'version', pg_catalog.jsonb_build_object(
      'id', version.id, 'version_number', version.version_number, 'state', version.state,
      'title', version.title, 'summary', version.summary, 'content', version.content,
      'content_format', version.content_format, 'published_at', version.published_at),
    'training', pg_catalog.jsonb_build_object(
      'estimated_minutes', tv.estimated_minutes, 'difficulty', tv.difficulty,
      'requires_video', coalesce(tv.requires_video, true),
      'completion_rule', coalesce(tv.completion_rule, 'explicit')),
    'media', atlas_private.training_media_json(tv.media_asset_id),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'start_seconds', c.start_seconds, 'title', c.title, 'sort_order', c.sort_order)
        order by c.sort_order, c.start_seconds)
      from atlas_private.training_chapters c where c.version_id = version.id), '[]'::jsonb),
    'steps', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id, 'label', s.label, 'sort_order', s.sort_order) order by s.sort_order)
      from atlas_private.training_steps s where s.version_id = version.id), '[]'::jsonb),
    'progress', case when progress.id is null then null else pg_catalog.jsonb_build_object(
      'version_id', progress.version_id, 'completion_state', progress.completion_state,
      'last_video_position_seconds', progress.last_video_position_seconds,
      'completed_at', progress.completed_at, 'last_opened_at', progress.last_opened_at) end
  );
end
$function$;
revoke all on function atlas_private.training_lesson_json(uuid, uuid, text, boolean) from public, anon, authenticated;

-- 6. Gateway RPCs (public.atlas_training_*, SECURITY DEFINER, service_role only) ---

-- Staff/manager Training home: required, continue, recommended, library, plus manager
-- authoring lists (drafts, published) — filtered by the Knowledge visibility rule.
create or replace function public.atlas_training_snapshot(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  lessons jsonb;
begin
  perform atlas_private.training_require_actor(p_actor_id, p_actor_role);

  select coalesce(pg_catalog.jsonb_agg(row_json order by title_sort), '[]'::jsonb) into lessons
  from (
    select
      pg_catalog.lower(v.title) as title_sort,
      pg_catalog.jsonb_build_object(
        'article_id', a.id,
        'status', a.status,
        'required', a.required,
        'target_roles', a.target_roles,
        'category_id', a.category_id,
        'title', v.title,
        'summary', v.summary,
        'version_id', v.id,
        'version_number', v.version_number,
        'version_state', v.state,
        'estimated_minutes', tv.estimated_minutes,
        'difficulty', tv.difficulty,
        'has_video', tv.media_asset_id is not null,
        'chapter_count', (select pg_catalog.count(*) from atlas_private.training_chapters c where c.version_id = v.id),
        'step_count', (select pg_catalog.count(*) from atlas_private.training_steps s where s.version_id = v.id),
        'progress', (
          select pg_catalog.jsonb_build_object(
            'completion_state', p.completion_state,
            'last_video_position_seconds', p.last_video_position_seconds,
            'completed_at', p.completed_at,
            'last_opened_at', p.last_opened_at)
          from atlas_private.training_progress p
          where p.user_id = p_actor_id and p.version_id = a.current_version_id)
      ) as row_json
    from atlas_private.knowledge_articles a
    join atlas_private.knowledge_article_versions v
      on v.id = case when is_manager and a.draft_version_id is not null and a.current_version_id is null
                     then a.draft_version_id else a.current_version_id end
    left join atlas_private.training_lesson_versions tv on tv.version_id = v.id
    where a.article_type = 'training'
      and atlas_private.knowledge_article_visible(a, p_actor_role, is_manager)
  ) rows;

  return pg_catalog.jsonb_build_object(
    'lessons', lessons,
    'permissions', pg_catalog.jsonb_build_object('can_manage_training', is_manager),
    'actor_role', p_actor_role
  );
end
$function$;
revoke all on function public.atlas_training_snapshot(uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_training_snapshot(uuid, text) to service_role;

create or replace function public.atlas_training_lesson(
  p_article_id uuid, p_actor_id uuid, p_actor_role text, p_prefer_draft boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.training_require_actor(p_actor_id, p_actor_role);
  return atlas_private.training_lesson_json(p_article_id, p_actor_id, p_actor_role,
    p_prefer_draft and p_actor_role in ('admin','manager'));
end
$function$;
revoke all on function public.atlas_training_lesson(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.atlas_training_lesson(uuid, uuid, text, boolean) to service_role;

-- Reserve an upload: the server picks the immutable object path and inserts a pending
-- media row. Idempotent on client_request_id for the same actor. Manager only.
create or replace function public.atlas_training_reserve_media(p_actor_id uuid, p_actor_role text, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_manager(p_actor_id, p_actor_role);
  r jsonb := coalesce(p_request, '{}'::jsonb);
  req uuid;
  mime text := r->>'mime_type';
  ext text;
  bytes bigint;
  existing atlas_private.training_media_assets;
  new_id uuid := gen_random_uuid();
  path text;
  pending_count integer;
begin
  if pg_catalog.jsonb_typeof(r) <> 'object' then
    raise exception 'Invalid upload request.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  req := (r->>'client_request_id')::uuid;
  bytes := (r->>'declared_bytes')::bigint;
  if req is null then
    raise exception 'A request id is required.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select * into existing from atlas_private.training_media_assets where client_request_id = req;
  if existing.id is not null then
    if existing.created_by <> p_actor_id then
      raise exception 'That request id is already in use.' using errcode = '23505', hint = 'atlas:conflict';
    end if;
    return pg_catalog.jsonb_build_object('media', atlas_private.training_media_json(existing.id),
      'storage_path', existing.storage_path, 'replayed', true);
  end if;

  ext := case mime when 'video/mp4' then 'mp4' when 'video/webm' then 'webm' when 'video/quicktime' then 'mov' end;
  if ext is null then
    raise exception 'Only MP4, WebM or MOV video is accepted.' using errcode = '22023', hint = 'atlas:unsupported_type';
  end if;
  if bytes is null or bytes < 1 or bytes > 2147483648 then
    raise exception 'That video is too large.' using errcode = '22023', hint = 'atlas:too_large';
  end if;

  select pg_catalog.count(*) into pending_count from atlas_private.training_media_assets m
  where m.created_by = p_actor_id and m.upload_status = 'pending'
    and m.upload_expires_at > pg_catalog.now();
  if pending_count >= 10 then
    raise exception 'Too many unfinished uploads.' using errcode = '22023', hint = 'atlas:quota';
  end if;

  path := pg_catalog.format('lessons/%s/%s.%s', gen_random_uuid(), new_id, ext);
  insert into atlas_private.training_media_assets (
    id, client_request_id, storage_path, original_filename, declared_mime, declared_bytes,
    upload_status, upload_expires_at, created_by, created_by_label, created_by_role)
  values (
    new_id, req, path,
    nullif(pg_catalog.left(pg_catalog.regexp_replace(coalesce(r->>'original_filename',''), '[[:cntrl:]/\\]+','','g'), 255), ''),
    mime, bytes, 'pending', pg_catalog.now() + interval '4 hours', p_actor_id, label, p_actor_role);

  insert into atlas_private.training_events (event_type, media_asset_id, actor_id, actor_label, actor_role, payload)
  values ('media_reserved', new_id, p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('bytes', bytes));

  return pg_catalog.jsonb_build_object('media', atlas_private.training_media_json(new_id),
    'storage_path', path, 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid upload request.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_training_reserve_media(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_training_reserve_media(uuid, text, jsonb) to service_role;

-- Mark a reserved asset stored after the gateway has verified the object exists and
-- read its true size/mime/probe. Manager only, own pending asset only.
create or replace function public.atlas_training_finalize_media(p_actor_id uuid, p_actor_role text, p_media_id uuid, p_object jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_manager(p_actor_id, p_actor_role);
  o jsonb := coalesce(p_object, '{}'::jsonb);
  m atlas_private.training_media_assets;
begin
  select * into m from atlas_private.training_media_assets where id = p_media_id;
  if m.id is null then raise exception 'Upload not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if m.created_by <> p_actor_id then raise exception 'That upload is not yours.' using errcode = '42501', hint = 'atlas:forbidden'; end if;
  if m.upload_status = 'stored' then
    return pg_catalog.jsonb_build_object('media', atlas_private.training_media_json(m.id), 'replayed', true);
  end if;

  update atlas_private.training_media_assets set
    upload_status = 'stored',
    mime_type = coalesce(nullif(o->>'mime_type',''), m.declared_mime),
    byte_size = case when (o->>'byte_size') ~ '^[0-9]{1,13}$' then (o->>'byte_size')::bigint else m.declared_bytes end,
    duration_seconds = case when (o->>'duration_seconds') ~ '^[0-9]{1,6}$' then (o->>'duration_seconds')::integer end,
    width = case when (o->>'width') ~ '^[0-9]{1,5}$' then (o->>'width')::integer end,
    height = case when (o->>'height') ~ '^[0-9]{1,5}$' then (o->>'height')::integer end,
    upload_expires_at = null
  where id = m.id;

  insert into atlas_private.training_events (event_type, media_asset_id, actor_id, actor_label, actor_role)
  values ('media_stored', m.id, p_actor_id, label, p_actor_role);
  return pg_catalog.jsonb_build_object('media', atlas_private.training_media_json(m.id), 'replayed', false);
end
$function$;
revoke all on function public.atlas_training_finalize_media(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_training_finalize_media(uuid, text, uuid, jsonb) to service_role;

-- Save the draft lesson: reuse Knowledge for the article + version, then upsert the
-- training payload and replace chapters/steps on the DRAFT version. Manager only.
create or replace function public.atlas_training_save_draft(
  p_actor_id uuid, p_actor_label text, p_actor_role text, p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_manager(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  saved jsonb;
  v_article_id uuid;
  v_version_id uuid;
  target_roles text[];
  ch jsonb;
  st jsonb;
  idx integer;
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'Invalid lesson.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select coalesce(pg_catalog.array_agg(value::text), array['all']::text[]) into target_roles
  from pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(p->'target_roles') = 'array'
    then p->'target_roles' else '["all"]'::jsonb end) value;

  saved := atlas_private.knowledge_save_draft(
    (nullif(p->>'article_id',''))::uuid,
    nullif(p->>'article_key',''),
    (p->>'category_id')::uuid,
    'training',
    p->>'title',
    p->>'summary',
    coalesce(nullif(p->>'content',''), ' '),
    coalesce((p->>'required')::boolean, false),
    target_roles,
    null,
    nullif(p->>'change_note',''),
    p_actor_id, label, p_actor_role);

  v_article_id := (saved->'article'->>'id')::uuid;
  v_version_id := (saved->'draft'->>'id')::uuid;

  insert into atlas_private.training_lesson_versions (version_id, article_id, estimated_minutes, difficulty, requires_video)
  values (v_version_id, v_article_id,
    case when (p->>'estimated_minutes') ~ '^[0-9]{1,3}$' then (p->>'estimated_minutes')::integer end,
    nullif(p->>'difficulty',''),
    coalesce((p->>'requires_video')::boolean, true))
  on conflict (version_id) do update set
    estimated_minutes = excluded.estimated_minutes,
    difficulty = excluded.difficulty,
    requires_video = excluded.requires_video,
    updated_at = pg_catalog.now();

  -- Replace chapters for the draft version.
  if pg_catalog.jsonb_typeof(p->'chapters') = 'array' then
    delete from atlas_private.training_chapters where version_id = v_version_id;
    idx := 0;
    for ch in select value from pg_catalog.jsonb_array_elements(p->'chapters') loop
      if pg_catalog.jsonb_typeof(ch) = 'object' and nullif(pg_catalog.btrim(coalesce(ch->>'title','')),'') is not null then
        insert into atlas_private.training_chapters (version_id, start_seconds, title, sort_order)
        values (v_version_id,
          least(86400, greatest(0, coalesce((ch->>'start_seconds')::integer, 0))),
          pg_catalog.left(pg_catalog.btrim(ch->>'title'), 160), idx);
        idx := idx + 1;
      end if;
    end loop;
    insert into atlas_private.training_events (event_type, article_id, version_id, actor_id, actor_label, actor_role)
    values ('chapters_saved', v_article_id, v_version_id, p_actor_id, label, p_actor_role);
  end if;

  -- Replace steps for the draft version.
  if pg_catalog.jsonb_typeof(p->'steps') = 'array' then
    delete from atlas_private.training_steps where version_id = v_version_id;
    idx := 0;
    for st in select value from pg_catalog.jsonb_array_elements(p->'steps') loop
      if pg_catalog.jsonb_typeof(st) = 'string' and nullif(pg_catalog.btrim(st #>> '{}'),'') is not null then
        insert into atlas_private.training_steps (version_id, label, sort_order)
        values (v_version_id, pg_catalog.left(pg_catalog.btrim(st #>> '{}'), 500), idx);
        idx := idx + 1;
      end if;
    end loop;
    insert into atlas_private.training_events (event_type, article_id, version_id, actor_id, actor_label, actor_role)
    values ('steps_saved', v_article_id, v_version_id, p_actor_id, label, p_actor_role);
  end if;

  return pg_catalog.jsonb_build_object('article_id', v_article_id, 'version_id', v_version_id);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid lesson.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_training_save_draft(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_training_save_draft(uuid, text, text, jsonb) to service_role;

-- Attach a stored video to the DRAFT version only (published media is immutable).
create or replace function public.atlas_training_attach_media(
  p_actor_id uuid, p_actor_role text, p_article_id uuid, p_media_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_manager(p_actor_id, p_actor_role);
  article atlas_private.knowledge_articles;
  m atlas_private.training_media_assets;
  v_draft uuid;
  had_media uuid;
begin
  select * into article from atlas_private.knowledge_articles where id = p_article_id and article_type = 'training';
  if article.id is null then raise exception 'Training lesson not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  v_draft := article.draft_version_id;
  if v_draft is null then
    raise exception 'Open the draft before changing its video.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into m from atlas_private.training_media_assets where id = p_media_id;
  if m.id is null or m.upload_status <> 'stored' then
    raise exception 'That video is not ready yet.' using errcode = '22023', hint = 'atlas:not_ready';
  end if;

  select media_asset_id into had_media from atlas_private.training_lesson_versions where version_id = v_draft;
  insert into atlas_private.training_lesson_versions (version_id, article_id, media_asset_id)
  values (v_draft, article.id, p_media_id)
  on conflict (version_id) do update set media_asset_id = excluded.media_asset_id, updated_at = pg_catalog.now();

  insert into atlas_private.training_events (event_type, article_id, version_id, media_asset_id, actor_id, actor_label, actor_role)
  values (case when had_media is not null and had_media <> p_media_id then 'media_replaced' else 'media_stored' end,
    article.id, v_draft, p_media_id, p_actor_id, label, p_actor_role);

  return pg_catalog.jsonb_build_object('article_id', article.id, 'version_id', v_draft, 'media_asset_id', p_media_id);
end
$function$;
revoke all on function public.atlas_training_attach_media(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.atlas_training_attach_media(uuid, text, uuid, uuid) to service_role;

-- Publish: require a stored video when the draft requires one, then reuse Knowledge
-- publish (which freezes this version). Manager only.
create or replace function public.atlas_training_publish(
  p_actor_id uuid, p_actor_label text, p_actor_role text, p_article_id uuid, p_change_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_manager(p_actor_id, p_actor_role);
  article atlas_private.knowledge_articles;
  tv atlas_private.training_lesson_versions;
begin
  select * into article from atlas_private.knowledge_articles where id = p_article_id and article_type = 'training';
  if article.id is null then raise exception 'Training lesson not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if article.draft_version_id is null then
    raise exception 'There is no draft to publish.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into tv from atlas_private.training_lesson_versions where version_id = article.draft_version_id;
  if coalesce(tv.requires_video, true) and tv.media_asset_id is null then
    raise exception 'Add a video before publishing this lesson.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  perform atlas_private.knowledge_publish(p_article_id, nullif(p_change_note,''), p_actor_id, label, p_actor_role);
  return pg_catalog.jsonb_build_object('article_id', article.id, 'version_id', article.draft_version_id);
end
$function$;
revoke all on function public.atlas_training_publish(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_training_publish(uuid, text, text, uuid, text) to service_role;

-- Return the storage path of the video for a version the actor may view, so the
-- gateway can mint a short-lived signed URL. Never returns a URL itself.
create or replace function public.atlas_training_playback_path(
  p_actor_id uuid, p_actor_role text, p_article_id uuid, p_version_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  article atlas_private.knowledge_articles;
  version atlas_private.knowledge_article_versions;
  v_path text;
begin
  perform atlas_private.training_require_actor(p_actor_id, p_actor_role);
  select * into article from atlas_private.knowledge_articles where id = p_article_id and article_type = 'training';
  if article.id is null then raise exception 'Training lesson not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if not atlas_private.knowledge_article_visible(article, p_actor_role, is_manager) then
    raise exception 'This training lesson is not available to your role.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select * into version from atlas_private.knowledge_article_versions where id = p_version_id and article_id = article.id;
  if version.id is null then raise exception 'Training version not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  -- Staff may only reach a published version's media; managers may preview the draft.
  if not is_manager and version.state <> 'published' then
    raise exception 'This training lesson is not available to your role.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select m.storage_path into v_path
  from atlas_private.training_lesson_versions tv
  join atlas_private.training_media_assets m on m.id = tv.media_asset_id and m.upload_status = 'stored'
  where tv.version_id = version.id;
  if v_path is null then raise exception 'This lesson has no video.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  return v_path;
end
$function$;
revoke all on function public.atlas_training_playback_path(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.atlas_training_playback_path(uuid, text, uuid, uuid) to service_role;

-- Staff: begin / resume a lesson. Upserts the caller's own progress for the exact
-- published version. Never trusts a browser-supplied user id.
create or replace function public.atlas_training_start(
  p_actor_id uuid, p_actor_role text, p_article_id uuid, p_version_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_actor(p_actor_id, p_actor_role);
  article atlas_private.knowledge_articles;
  version atlas_private.knowledge_article_versions;
begin
  select * into article from atlas_private.knowledge_articles where id = p_article_id and article_type = 'training';
  if article.id is null or not atlas_private.knowledge_article_visible(article, p_actor_role, p_actor_role in ('admin','manager')) then
    raise exception 'This training lesson is not available to your role.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select * into version from atlas_private.knowledge_article_versions where id = p_version_id and article_id = article.id;
  if version.id is null or (version.state <> 'published' and p_actor_role not in ('admin','manager')) then
    raise exception 'This training version cannot be started.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  insert into atlas_private.training_progress (user_id, article_id, version_id, user_label, user_role)
  values (p_actor_id, article.id, version.id, label, p_actor_role)
  on conflict (user_id, version_id) do update set last_opened_at = pg_catalog.now(), user_label = excluded.user_label;
  insert into atlas_private.training_events (event_type, article_id, version_id, user_id, actor_id, actor_label, actor_role)
  values ('lesson_started', article.id, version.id, p_actor_id, p_actor_id, label, p_actor_role);
  return atlas_private.training_lesson_json(article.id, p_actor_id, p_actor_role, false);
end
$function$;
revoke all on function public.atlas_training_start(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.atlas_training_start(uuid, text, uuid, uuid) to service_role;

-- Staff: throttled resume-position save. Own progress only; never marks completion.
create or replace function public.atlas_training_save_progress(
  p_actor_id uuid, p_actor_role text, p_version_id uuid, p_position_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.training_require_actor(p_actor_id, p_actor_role);
  update atlas_private.training_progress set
    last_video_position_seconds = least(86400, greatest(0, coalesce(p_position_seconds, 0))),
    last_opened_at = pg_catalog.now()
  where user_id = p_actor_id and version_id = p_version_id;
  if not found then
    raise exception 'Start the lesson before saving progress.' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  return pg_catalog.jsonb_build_object('ok', true);
end
$function$;
revoke all on function public.atlas_training_save_progress(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.atlas_training_save_progress(uuid, text, uuid, integer) to service_role;

-- Staff: explicit, idempotent, version-specific completion. Only a published version
-- the actor can access. Never completes for another user or a draft.
create or replace function public.atlas_training_complete(
  p_actor_id uuid, p_actor_role text, p_article_id uuid, p_version_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.training_require_actor(p_actor_id, p_actor_role);
  article atlas_private.knowledge_articles;
  version atlas_private.knowledge_article_versions;
  existing atlas_private.training_progress;
begin
  select * into article from atlas_private.knowledge_articles where id = p_article_id and article_type = 'training';
  if article.id is null or not atlas_private.knowledge_article_visible(article, p_actor_role, p_actor_role in ('admin','manager')) then
    raise exception 'This training lesson is not available to your role.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select * into version from atlas_private.knowledge_article_versions where id = p_version_id and article_id = article.id;
  if version.id is null or version.state <> 'published' then
    raise exception 'Only a published lesson can be completed.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select * into existing from atlas_private.training_progress where user_id = p_actor_id and version_id = version.id;
  if existing.id is not null and existing.completion_state = 'completed' then
    return pg_catalog.jsonb_build_object('completion_state', 'completed', 'completed_at', existing.completed_at, 'replayed', true);
  end if;

  insert into atlas_private.training_progress (user_id, article_id, version_id, user_label, user_role, completion_state, completed_at)
  values (p_actor_id, article.id, version.id, label, p_actor_role, 'completed', pg_catalog.now())
  on conflict (user_id, version_id) do update set
    completion_state = 'completed',
    completed_at = coalesce(atlas_private.training_progress.completed_at, pg_catalog.now()),
    user_label = excluded.user_label, last_opened_at = pg_catalog.now();

  insert into atlas_private.training_events (event_type, article_id, version_id, user_id, actor_id, actor_label, actor_role)
  values ('lesson_completed', article.id, version.id, p_actor_id, p_actor_id, label, p_actor_role);

  return pg_catalog.jsonb_build_object('completion_state', 'completed',
    'completed_at', (select completed_at from atlas_private.training_progress where user_id = p_actor_id and version_id = version.id),
    'replayed', false);
end
$function$;
revoke all on function public.atlas_training_complete(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.atlas_training_complete(uuid, text, uuid, uuid) to service_role;

-- Manager: completion status for one lesson (assigned by role, completed, outstanding).
create or replace function public.atlas_training_completion_report(
  p_actor_id uuid, p_actor_role text, p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  article atlas_private.knowledge_articles;
  v_current uuid;
  assigned integer;
  completed integer;
begin
  perform atlas_private.training_require_manager(p_actor_id, p_actor_role);
  select * into article from atlas_private.knowledge_articles where id = p_article_id and article_type = 'training';
  if article.id is null then raise exception 'Training lesson not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  v_current := article.current_version_id;

  -- Assigned = active staff whose role is targeted by the lesson.
  select pg_catalog.count(*) into assigned from public.profiles pr
  where pr.active is true
    and ('all' = any(article.target_roles) or pr.role::text = any(article.target_roles));

  select pg_catalog.count(distinct p.user_id) into completed
  from atlas_private.training_progress p
  where p.version_id = v_current and p.completion_state = 'completed';

  return pg_catalog.jsonb_build_object(
    'article_id', article.id,
    'current_version_id', v_current,
    'assigned', coalesce(assigned, 0),
    'completed', coalesce(completed, 0),
    'outstanding', greatest(0, coalesce(assigned,0) - coalesce(completed,0)),
    'staff', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'user_label', atlas_private.training_safe_label(pr.display_name),
        'role', pr.role,
        'completed', exists (select 1 from atlas_private.training_progress p
          where p.version_id = v_current and p.user_id = pr.id and p.completion_state = 'completed'),
        'completed_at', (select p.completed_at from atlas_private.training_progress p
          where p.version_id = v_current and p.user_id = pr.id and p.completion_state = 'completed'))
        order by pr.display_name)
      from public.profiles pr
      where pr.active is true
        and ('all' = any(article.target_roles) or pr.role::text = any(article.target_roles))), '[]'::jsonb)
  );
end
$function$;
revoke all on function public.atlas_training_completion_report(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.atlas_training_completion_report(uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';
