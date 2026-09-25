-- S89 recognition service (WP3/WP7): limits, upload quota, replay, and Brain
-- decisions for AI-originated catalogue requests.
--
--   * ai_settings: per-user hourly identifications, per-user daily vision
--     reads and a venue-wide daily vision budget (estimated USD), the same
--     owner switch (ai_settings.enabled) that governs Atlas AI model spend.
--   * atlas_recognition_limits: the rate and spend check the
--     atlas-inventory-recognition Edge Function runs before any work
--     (runs as the NOLOGIN recognition definer; read-only).
--   * atlas_recognition_register_media: now enforces the S88 per-user daily
--     upload quota (files and bytes, one advisory lock with atlas-ai uploads).
--   * atlas_recognition_request_get: idempotent replay of an identify request
--     by client_request_id without a second vision call.
--   * atlas_catalog_record_ai_decision: after a manager decides a catalogue
--     request that came from an approved Atlas AI proposal, the decision is
--     written to the Brain (brain_decisions) through the existing
--     atlas_private.decide_phase3_recommendation, like other AI proposals.
--
-- Nothing here writes stock, items, codes or aliases. No backfill.

alter table atlas_private.ai_settings
  add column if not exists recognition_identifications_per_hour integer not null default 60,
  add column if not exists recognition_vision_per_day integer not null default 150,
  add column if not exists recognition_vision_budget_usd_per_day numeric not null default 5;

do $s89_recognition_settings$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'ai_settings_recognition_per_hour_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_recognition_per_hour_range
      check (recognition_identifications_per_hour between 1 and 1000);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'ai_settings_recognition_vision_per_day_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_recognition_vision_per_day_range
      check (recognition_vision_per_day between 0 and 5000);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'ai_settings_recognition_budget_range'
      and conrelid = 'atlas_private.ai_settings'::regclass) then
    alter table atlas_private.ai_settings add constraint ai_settings_recognition_budget_range
      check (recognition_vision_budget_usd_per_day between 0 and 1000);
  end if;
end
$s89_recognition_settings$;

create index if not exists recognition_requests_vision_idx
  on atlas_private.recognition_requests (created_at) where vision_model is not null;

-- ---------------------------------------------------------------------------
-- Limits (read-only; raises the S88 hardening prefixes the Edge Function maps
-- to friendly 429s: rate_limited:<reason> / upload_quota_exceeded:<reason>).
-- ---------------------------------------------------------------------------
create or replace function atlas_private.recognition_limits(
  p_actor_id uuid, p_actor_role text, p_vision boolean, p_upload_bytes bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  role_name text := atlas_private.recognition_actor(p_actor_id, p_actor_role);
  settings_row atlas_private.ai_settings;
  used_hour integer;
  used_vision integer;
  spent numeric;
  upload_files integer;
  upload_bytes bigint;
  ai_enabled boolean;
begin
  select * into settings_row from atlas_private.ai_settings s where s.id;
  ai_enabled := coalesce(settings_row.enabled, false);
  select count(*) into used_hour from atlas_private.recognition_requests r
  where r.actor_id = p_actor_id and r.created_at > pg_catalog.now() - interval '1 hour';
  select count(*) into used_vision from atlas_private.recognition_requests r
  where r.actor_id = p_actor_id and r.vision_model is not null and r.created_at > pg_catalog.now() - interval '24 hours';
  select coalesce(sum(r.vision_cost_usd), 0) into spent from atlas_private.recognition_requests r
  where r.vision_model is not null and r.created_at > pg_catalog.now() - interval '24 hours';
  select count(*), coalesce(sum(m.bytes), 0) into upload_files, upload_bytes from atlas_private.ai_media m
  where m.user_id = p_actor_id and m.created_at > pg_catalog.now() - interval '24 hours';

  if used_hour >= coalesce(settings_row.recognition_identifications_per_hour, 60) then
    raise exception using errcode = '53400', message = 'rate_limited: recognition_hourly', hint = 'atlas:rate_limited';
  end if;
  if coalesce(p_vision, false) and ai_enabled then
    if used_vision >= coalesce(settings_row.recognition_vision_per_day, 150) then
      raise exception using errcode = '53400', message = 'rate_limited: recognition_vision_daily', hint = 'atlas:rate_limited';
    end if;
    if spent >= coalesce(settings_row.recognition_vision_budget_usd_per_day, 5) then
      raise exception using errcode = '53400', message = 'rate_limited: recognition_budget', hint = 'atlas:rate_limited';
    end if;
  end if;
  if p_upload_bytes is not null then
    if upload_files + 1 > coalesce(settings_row.upload_files_per_day, 100) then
      raise exception using errcode = '53400', message = 'upload_quota_exceeded: daily_files', hint = 'atlas:rate_limited';
    end if;
    if upload_bytes + greatest(p_upload_bytes, 0) > coalesce(settings_row.upload_bytes_per_day, 262144000) then
      raise exception using errcode = '53400', message = 'upload_quota_exceeded: daily_bytes', hint = 'atlas:rate_limited';
    end if;
  end if;
  return jsonb_build_object(
    'role', role_name,
    'vision_enabled', ai_enabled,
    'identifications', jsonb_build_object('used_last_hour', used_hour, 'per_hour', coalesce(settings_row.recognition_identifications_per_hour, 60)),
    'vision', jsonb_build_object('used_today', used_vision, 'per_day', coalesce(settings_row.recognition_vision_per_day, 150),
      'budget_usd_per_day', coalesce(settings_row.recognition_vision_budget_usd_per_day, 5), 'estimated_spend_usd', spent),
    'uploads', jsonb_build_object('files_today', upload_files, 'bytes_today', upload_bytes,
      'files_per_day', coalesce(settings_row.upload_files_per_day, 100), 'bytes_per_day', coalesce(settings_row.upload_bytes_per_day, 262144000)),
    'retention_days', least(greatest(coalesce(settings_row.media_retention_days, 30), 1), 30),
    'stock_changed', false);
end
$function$;

-- Media registration with the daily upload quota (same lock as atlas-ai).
create or replace function atlas_private.recognition_register_media(p_media jsonb, p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  role_name text := atlas_private.recognition_actor(p_actor_id, p_actor_role);
  settings_row atlas_private.ai_settings;
  retention integer;
  media_row atlas_private.ai_media;
  files integer;
  total bigint;
begin
  if jsonb_typeof(coalesce(p_media, 'null'::jsonb)) <> 'object' then
    raise exception 'Media must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if coalesce(p_media->>'kind', 'image') <> 'image' then
    raise exception 'Recognition accepts images only' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if pg_catalog.split_part(coalesce(p_media->>'path', ''), '/', 1) <> p_actor_id::text then
    raise exception 'The image path must belong to the uploader' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select * into settings_row from atlas_private.ai_settings s where s.id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('atlas_ai:uploads:' || p_actor_id::text, 0));
  select count(*), coalesce(sum(m.bytes), 0) into files, total from atlas_private.ai_media m
  where m.user_id = p_actor_id and m.created_at > pg_catalog.now() - interval '24 hours';
  if files + 1 > coalesce(settings_row.upload_files_per_day, 100) then
    raise exception using errcode = '53400', message = 'upload_quota_exceeded: daily_files', hint = 'atlas:rate_limited';
  end if;
  if total + greatest(coalesce((p_media->>'bytes')::bigint, 0), 0) > coalesce(settings_row.upload_bytes_per_day, 262144000) then
    raise exception using errcode = '53400', message = 'upload_quota_exceeded: daily_bytes', hint = 'atlas:rate_limited';
  end if;
  retention := least(greatest(coalesce(settings_row.media_retention_days, 30), 1), 30);
  insert into atlas_private.ai_media (user_id, path, mime, bytes, kind, sha256, expires_at, purpose)
  values (p_actor_id, p_media->>'path', p_media->>'mime', (p_media->>'bytes')::bigint, 'image',
          nullif(p_media->>'sha256', ''), pg_catalog.now() + pg_catalog.make_interval(days => retention), 'recognition')
  returning * into media_row;
  return jsonb_build_object('media_id', media_row.id, 'expires_at', media_row.expires_at, 'role', role_name, 'stock_changed', false);
end
$function$;

-- Replay of a recorded identify request (the same person, or a manager).
create or replace function atlas_private.recognition_request_get(
  p_client_request_id uuid, p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  role_name text := atlas_private.recognition_actor(p_actor_id, p_actor_role);
  request_row atlas_private.recognition_requests;
begin
  select * into request_row from atlas_private.recognition_requests r where r.client_request_id = p_client_request_id;
  if not found then return null; end if;
  if request_row.actor_id <> p_actor_id and role_name not in ('admin','manager') then
    raise exception 'This request id belongs to another person' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return jsonb_build_object(
    'request_id', request_row.id, 'client_request_id', request_row.client_request_id, 'mode', request_row.mode,
    'context', request_row.context, 'media_id', request_row.media_id, 'client_barcodes', request_row.client_barcodes,
    'image_quality', request_row.image_quality, 'vision_model', request_row.vision_model, 'status', request_row.status,
    'failure_code', request_row.failure_code, 'scorer_version', request_row.scorer_version,
    'extractor_version', request_row.extractor_version, 'created_at', request_row.created_at,
    'detections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'detection_id', d.id, 'detection_index', d.detection_index, 'bbox', d.bbox, 'band', d.band,
        'preselected_item_id', d.preselected_item_id, 'field_confidence', d.field_confidence,
        'extracted', d.extracted, 'normalized', d.normalized,
        'candidates', coalesce((
          select jsonb_agg(jsonb_build_object(
            'rank', c.rank, 'item_id', c.item_id, 'score', c.score, 'features', c.features, 'explanation', c.explanation,
            'item', (select atlas_private.recognition_item_payload(i, role_name) from public.inventory_items i where i.id = c.item_id))
            order by c.rank)
          from atlas_private.recognition_candidates c where c.detection_id = d.id), '[]'::jsonb))
        order by d.detection_index)
      from atlas_private.recognition_detections d where d.request_id = request_row.id), '[]'::jsonb),
    'stock_changed', false);
end
$function$;

create or replace function public.atlas_recognition_limits(p_actor_id uuid, p_actor_role text, p_vision boolean, p_upload_bytes bigint)
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select atlas_private.recognition_limits(p_actor_id, p_actor_role, p_vision, p_upload_bytes);
$function$;
create or replace function public.atlas_recognition_request_get(p_client_request_id uuid, p_actor_id uuid, p_actor_role text)
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select atlas_private.recognition_request_get(p_client_request_id, p_actor_id, p_actor_role);
$function$;

grant create on schema atlas_private to atlas_recognition_definer;
alter function atlas_private.recognition_limits(uuid, text, boolean, bigint) owner to atlas_recognition_definer;
alter function atlas_private.recognition_register_media(jsonb, uuid, text) owner to atlas_recognition_definer;
alter function atlas_private.recognition_request_get(uuid, uuid, text) owner to atlas_recognition_definer;
revoke create on schema atlas_private from atlas_recognition_definer;

-- ---------------------------------------------------------------------------
-- Atlas AI proposal kinds for catalogue requests (mirrors
-- _shared/ai-tools/actions.mjs PROPOSAL_KINDS). Approving the card only
-- submits a PENDING catalogue request; a manager decides it in the queue.
-- ---------------------------------------------------------------------------
create or replace function atlas_private.ai_action_allowed_roles(p_kind text, p_command jsonb)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_kind in ('purchase_order.create','purchase_order.receive','shift.draft','knowledge.draft',
                    'settings.suggestion','par_level.suggestion') then array['admin','manager']::text[]
    when p_kind in ('stock_count.draft','catalog.alias','catalog.new_item','catalog.wrong_match') then array['admin','manager','bartender']::text[]
    when p_kind = 'team_message.send' then
      case when p_command->>'channel_key' = 'announcements' then array['admin','manager']::text[]
           else array['admin','manager','bartender']::text[] end
    else null
  end;
$$;
revoke all on function atlas_private.ai_action_allowed_roles(text, jsonb) from public, anon, authenticated;
grant execute on function atlas_private.ai_action_allowed_roles(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Brain decision for a decided catalogue request that came from an approved
-- Atlas AI proposal (source ai_proposal + ai_action_id). Called by the
-- manager decision path (atlas-item-master catalog-decide) after
-- atlas_catalog_request_decide. Idempotent per request. Never a writer of
-- catalogue or stock data; the recognition definer cannot execute it.
-- ---------------------------------------------------------------------------
create or replace function public.atlas_catalog_record_ai_decision(
  p_change_request_id uuid, p_actor_id uuid, p_actor_label text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  request_row atlas_private.catalog_change_requests;
  recommendation uuid;
  label text := coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), p_actor_id::text);
  result jsonb;
begin
  perform atlas_private.catalog_actor_role(p_actor_id, array['admin','manager']);
  select * into request_row from atlas_private.catalog_change_requests r where r.id = p_change_request_id;
  if not found then raise exception 'Request not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if request_row.ai_action_id is null or request_row.source <> 'ai_proposal' then
    return jsonb_build_object('recorded', false, 'reason', 'not_ai_originated');
  end if;
  if request_row.status not in ('applied','rejected','failed') then
    return jsonb_build_object('recorded', false, 'reason', 'not_decided');
  end if;
  if request_row.decided_by is distinct from p_actor_id then
    raise exception 'Only the manager who decided can record the decision' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select a.brain_recommendation_id into recommendation from atlas_private.ai_actions a where a.id = request_row.ai_action_id;
  if recommendation is null then
    return jsonb_build_object('recorded', false, 'reason', 'not_in_brain');
  end if;
  result := atlas_private.decide_phase3_recommendation(
    recommendation,
    case when request_row.status = 'rejected' then 'reject' else 'accept' end,
    'catalog_' || request_row.kind || '_' || request_row.status,
    left(coalesce(request_row.decision_note, request_row.failure_message), 2000),
    null, null, p_actor_id, label,
    'catalog-request:' || request_row.id::text || ':decision');
  return result || jsonb_build_object('recorded', true, 'change_request_id', request_row.id,
    'ai_action_id', request_row.ai_action_id, 'brain_recommendation_id', recommendation);
end
$function$;

do $s89_recognition_service_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in ('atlas_recognition_limits', 'atlas_recognition_request_get', 'atlas_catalog_record_ai_decision'))
       or (n.nspname = 'atlas_private' and p.proname in ('recognition_limits', 'recognition_request_get'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_row.signature);
    execute format('grant execute on function %s to service_role', function_row.signature);
  end loop;
end
$s89_recognition_service_grants$;

comment on function public.atlas_recognition_limits(uuid, text, boolean, bigint) is
  'S89 service-role-only recognition rate, vision-spend and upload-quota check. Runs as atlas_recognition_definer; read-only.';
comment on function public.atlas_recognition_request_get(uuid, uuid, text) is
  'S89 service-role-only replay of a recorded recognition request (no second vision call). Read-only.';
comment on function public.atlas_catalog_record_ai_decision(uuid, uuid, text) is
  'S89 service-role-only: records a manager decision on an AI-originated catalogue request in the Brain (brain_decisions). Never changes stock or catalogue data.';

notify pgrst, 'reload schema';
