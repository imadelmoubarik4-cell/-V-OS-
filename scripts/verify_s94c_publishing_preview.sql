-- S94C preview-only acceptance: Marketing publishing workflow and delivery queue
-- (supabase/migrations/20261004092000_s94c_marketing_publishing.sql, on top of s94a media and
-- s94b publishing connections).
--
-- Requires an isolated replay database (scripts/verify_full_migration_replay.sh). Seeds users,
-- media, provider readiness and content inside one transaction and proves:
-- * the delivery state machine: every legal transition of the binding table succeeds, every other
--   pair raises P0001; publishing→retrying/cancelled after the submit marker is refused;
-- * provider ids are write-once, a published row needs an id, one live delivery per target;
-- * approval creates deliveries with a frozen payload (ordered media, options, no URLs); an edit,
--   reschedule or media change after approval cancels the unstarted deliveries and needs
--   re-approval; a fingerprint mismatch at claim cancels the delivery (superseded_by_edit);
-- * rejected or cancelled content is never claimed; with automatic publishing off nothing is
--   claimed and Publish now is refused; Publish now makes deliveries due now (idempotent);
-- * claim fairness, fencing (lease_lost), stale-lease recovery (retrying / verifying), stale guard,
--   backoff with a fixed jitter, polls that do not consume attempts, budget cap;
-- * retrying one failed platform never touches the published one; retry after the submit marker
--   needs the manager's attestation; mark posted needs an https link;
-- * one push per delivery on needs_attention/failed, history and snapshot shapes, venue time;
-- * bartender/viewer refusals, service-role-only grants, the admin-only automatic publishing switch;
-- * worker contract: TikTok consent frozen in the payload, definitive rejections after the marker
--   retry, verifying -> retrying only with definitive proof, IG container_ready after the marker,
--   poll_after_s on verifying outcomes;
-- * review fixes: "as soon as it's approved" queues on approval, the JPEG publish copy is what is
--   published, snapshot media keeps collection_id, media published before a cancel stays pinned,
--   sanitised text never violates a CHECK and the browser sees fixed wording, ALERT is refused,
--   a provider auth failure marks the connection through the claim-fenced RPC.
-- Prints one JSON verdict and rolls everything back. now() is fixed inside the transaction, so
-- time is simulated by moving row timestamps.

begin;

create temporary table s94c_results (test_name text primary key, passed boolean not null, detail text) on commit drop;
create temporary table s94c_ctx (key text primary key, id uuid, val jsonb) on commit drop;
grant all on table s94c_results, s94c_ctx to service_role, authenticated, anon;

create function public.s94cp_expect(p_sql text)
returns text language plpgsql security invoker set search_path = '' as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function public.s94cp_expect(text) to service_role, authenticated, anon;

create function public.s94cp_ok(p_name text, p_passed boolean, p_detail text default null)
returns void language sql security invoker set search_path = '' as $$
  insert into s94c_results values (p_name, coalesce(p_passed, false), p_detail)
  on conflict (test_name) do update set passed = excluded.passed, detail = excluded.detail;
$$;

create function public.s94cp_id(p_key text) returns uuid language sql stable set search_path = '' as $$
  select id from s94c_ctx where key = p_key;
$$;

-- Makes a provider ready to publish: connected, publishing permission granted, review approved,
-- one selected resource. Uses whatever the s94b schema offers (columns probed dynamically).
create function public.s94cp_ready(p_provider text, p_resource text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_kind text := case p_provider when 'instagram' then 'instagram_account' when 'facebook' then 'facebook_page'
                                 when 'tiktok' then 'tiktok_account' else 'gbp_location' end;
begin
  update atlas_private.integration_connections
  set status = 'connected', authorization_state = 'authorized', publishing_permission_state = 'granted',
      scopes_granted = array['s94c-preview'], external_account_id = p_resource, external_account_label = 'S94C ' || p_provider,
      connected_at = pg_catalog.now()
  where provider_key = p_provider;
  if exists (select 1 from information_schema.columns where table_schema = 'atlas_private'
             and table_name = 'integration_connections' and column_name = 'publishing_review_state') then
    execute 'update atlas_private.integration_connections set publishing_review_state = ''approved'' where provider_key = $1' using p_provider;
  end if;
  execute 'update atlas_private.integration_resources set selected = false where provider_key = $1 and resource_kind = $2'
    using p_provider, v_kind;
  execute 'insert into atlas_private.integration_resources (provider_key, resource_kind, resource_id, label, selected)
           values ($1, $2, $3, $4, true)
           on conflict (provider_key, resource_kind, resource_id) do update set selected = true'
    using p_provider, v_kind, p_resource, 'S94C ' || p_provider;
  -- Real S94B readiness also needs a stored (encrypted) credential, a verified connection and, for
  -- Meta, the selected resource's own credential. Dummy ciphertext only; nothing is decryptable.
  if to_regclass('atlas_private.integration_credentials') is not null then
    execute 'insert into atlas_private.integration_credentials (provider_key, credential_kind, ciphertext, nonce, key_version)
             values ($1, ''oauth_token_set'', decode(repeat(''00'', 32), ''hex''), decode(repeat(''00'', 12), ''hex''), 1)
             on conflict (provider_key) do nothing' using p_provider;
  end if;
  update atlas_private.integration_connections set last_verified_at = pg_catalog.now() where provider_key = p_provider;
  if to_regclass('atlas_private.integration_resource_credentials') is not null and v_kind in ('facebook_page','instagram_account') then
    execute 'insert into atlas_private.integration_resource_credentials (provider_key, resource_kind, resource_id, ciphertext, nonce, key_version)
             values ($1, $2, $3, decode(repeat(''00'', 32), ''hex''), decode(repeat(''00'', 12), ''hex''), 1)
             on conflict do nothing' using p_provider, v_kind, p_resource;
  end if;
end;
$$;

create function public.s94cp_asset(p_kind text, p_n integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into atlas_private.marketing_media_assets (id, kind, status, storage_path, declared_mime, mime_type, declared_bytes,
    byte_size, sha256, width, height, duration_ms, verified_at, uploaded_by)
  values (v_id, p_kind, 'ready',
    'venues/main/2026/10/' || v_id || '/original.' || case when p_kind = 'video' then 'mp4' else 'jpg' end,
    case when p_kind = 'video' then 'video/mp4' else 'image/jpeg' end,
    case when p_kind = 'video' then 'video/mp4' else 'image/jpeg' end,
    100000 + p_n, 100000 + p_n, encode(pg_catalog.sha256(convert_to('s94c-asset-' || p_n, 'UTF8')), 'hex'),
    1080, case when p_kind = 'video' then 1920 else 1350 end, case when p_kind = 'video' then 15000 end,
    pg_catalog.now(), '00000000-0000-4000-8000-000000094c02');
  insert into atlas_private.marketing_media_variants (asset_id, purpose, status, storage_path, declared_mime, declared_bytes, mime_type,
    byte_size, width, height, sha256, verified_at, created_by, source_time_ms)
  values (v_id, case when p_kind = 'video' then 'poster' else 'thumb' end, 'ready',
          'venues/main/2026/10/' || v_id || '/v/' || gen_random_uuid() || '.jpg', 'image/jpeg', 2000, 'image/jpeg', 2000, 400, 500,
          encode(pg_catalog.sha256(convert_to('s94c-thumb-' || p_n, 'UTF8')), 'hex'), pg_catalog.now(),
          '00000000-0000-4000-8000-000000094c02', case when p_kind = 'video' then 0 end);
  return v_id;
end;
$$;

create function public.s94cp_attach(p_content uuid, p_asset uuid, p_position integer, p_platform text default null)
returns void language sql security invoker set search_path = '' as $$
  insert into atlas_private.marketing_content_media (content_id, asset_id, platform, position, role, added_by)
  values (p_content, p_asset, p_platform, p_position, case when p_position = 0 then 'primary' else 'item' end,
          '00000000-0000-4000-8000-000000094c02');
$$;

create function public.s94cp_content(p_title text, p_platforms text[], p_scheduled timestamptz, p_caption text default 'S94C caption')
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_result jsonb;
begin
  v_result := public.atlas_marketing_create_content(gen_random_uuid(), null, p_title, 'post', 'normal', p_platforms, p_scheduled,
    null, null, null, null, p_caption, null, '[]'::jsonb, '{}'::jsonb, null, null,
    '00000000-0000-4000-8000-000000094c02', 'S94C Manager', 'manager', '{}'::jsonb);
  return (v_result ->> 'id')::uuid;
end;
$$;

create function public.s94cp_approve(p_content uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  perform public.atlas_marketing_submit_approval(p_content, null, '00000000-0000-4000-8000-000000094c02', 'S94C Manager', 'manager');
  return public.atlas_marketing_decide_approval(p_content, 'approved', null, '00000000-0000-4000-8000-000000094c01', 'S94C Admin', 'admin');
end;
$$;

-- Makes the content's waiting deliveries due a minute ago (acceptable for 6 more hours).
create function public.s94cp_due(p_content uuid)
returns void language sql security invoker set search_path = '' as $$
  update atlas_private.marketing_deliveries
  set due_at = pg_catalog.now() - interval '1 minute', next_attempt_at = pg_catalog.now() - interval '1 minute',
      latest_acceptable_at = pg_catalog.now() + interval '6 hours'
  where content_id = p_content and status in ('queued','retrying');
$$;

-- Parks every unclaimed waiting delivery far in the future so later claims only see their own rows.
create function public.s94cp_park()
returns void language sql security invoker set search_path = '' as $$
  update atlas_private.marketing_deliveries set next_attempt_at = pg_catalog.now() + interval '5 days',
    latest_acceptable_at = greatest(latest_acceptable_at, pg_catalog.now() + interval '6 days')
  where status in ('queued','retrying','processing','verifying') and claim_token is null;
$$;

create function public.s94cp_delivery(p_content uuid, p_provider text)
returns atlas_private.marketing_deliveries language sql stable security invoker set search_path = '' as $$
  select * from atlas_private.marketing_deliveries where content_id = p_content and provider_key = p_provider
  order by created_at desc, (status <> 'cancelled') desc limit 1;
$$;

create function public.s94cp_live(p_content uuid, p_provider text)
returns atlas_private.marketing_deliveries language sql stable security invoker set search_path = '' as $$
  select * from atlas_private.marketing_deliveries where content_id = p_content and provider_key = p_provider and status <> 'cancelled'
  order by created_at desc limit 1;
$$;

create function public.s94cp_set_auto(p_on boolean)
returns void language sql security invoker set search_path = '' as $$
  update atlas_private.settings_sections
  set settings_value = jsonb_set(settings_value, '{automatic_publishing_enabled}', to_jsonb(p_on))
  where section_key = 'marketing';
$$;

-- Fixtures ----------------------------------------------------------------------------------------

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000094c01'::uuid,'s94c-admin@example.invalid'),
  ('00000000-0000-4000-8000-000000094c02'::uuid,'s94c-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000094c03'::uuid,'s94c-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000094c04'::uuid,'s94c-view@example.invalid'),
  ('00000000-0000-4000-8000-000000094c05'::uuid,'s94c-old@example.invalid')) v(id,email);
update public.profiles set role='admin', active=true, display_name='S94C Admin' where id='00000000-0000-4000-8000-000000094c01';
update public.profiles set role='manager', active=true, display_name='S94C Manager' where id='00000000-0000-4000-8000-000000094c02';
update public.profiles set role='bartender', active=true, display_name='S94C Bartender' where id='00000000-0000-4000-8000-000000094c03';
update public.profiles set role='viewer', active=true, display_name='S94C Viewer' where id='00000000-0000-4000-8000-000000094c04';
update public.profiles set role='manager', active=false, display_name='S94C Former' where id='00000000-0000-4000-8000-000000094c05';
-- Only the fixture people receive pushes in this transaction.
update public.profiles set active = false where id::text not like '00000000-0000-4000-8000-000000094c0%';

select public.s94cp_ready('instagram', 'ig-s94c-1');
select public.s94cp_ready('facebook', 'fb-s94c-1');
select public.s94cp_ready('tiktok', 'tt-s94c-1');
select public.s94cp_set_auto(false);

-- 1. Structure, state machine ------------------------------------------------------------------------

select public.s94cp_ok('01 structure: delivery tables have RLS and the binding transition table (27 legal pairs)',
  (select bool_and(c.relrowsecurity) from pg_class c where c.oid in (
     'atlas_private.marketing_deliveries'::regclass, 'atlas_private.marketing_delivery_attempts'::regclass,
     'atlas_private.marketing_provider_accounts'::regclass, 'atlas_private.marketing_delivery_transitions'::regclass))
  and (select count(*) from atlas_private.marketing_delivery_transitions) = 27
  and not exists (select 1 from atlas_private.marketing_delivery_transitions where from_status in ('published','cancelled')));

-- A throw-away approved content item carries the matrix rows.
do $matrix$
declare
  v_content uuid;
  v_approval uuid;
  v_from text;
  v_to text;
  v_id uuid;
  v_state text;
  v_legal boolean;
  v_bad text := '';
  v_checked integer := 0;
  v_statuses text[] := array['queued','publishing','processing','verifying','retrying','published','failed','needs_attention','cancelled'];
begin
  v_content := public.s94cp_content('S94C matrix', array['instagram'], null);
  insert into atlas_private.marketing_content_approvals (content_id, decision, actor_label, actor_role)
  values (v_content, 'approved', 'S94C', 'admin') returning id into v_approval;
  foreach v_from in array v_statuses loop
    foreach v_to in array v_statuses loop
      continue when v_from = v_to;
      v_id := gen_random_uuid();
      insert into atlas_private.marketing_deliveries (id, content_id, provider_key, external_account_id, target_kind, approval_id,
        approved_fingerprint, payload_snapshot, due_at, next_attempt_at, latest_acceptable_at)
      values (v_id, v_content, 'instagram', 'matrix-' || v_id, 'ig_feed', v_approval, pg_catalog.sha256('x'::bytea), '{}'::jsonb,
              now(), now(), now() + interval '1 hour');
      set local session_replication_role = replica;
      update atlas_private.marketing_deliveries set status = v_from,
        claim_token = case when v_from in ('publishing','processing','verifying') then gen_random_uuid() end,
        claimed_by = case when v_from in ('publishing','processing','verifying') then 'matrix' end,
        claimed_until = case when v_from in ('publishing','processing','verifying') then now() + interval '5 minutes' end,
        provider_post_id = case when v_from = 'published' then 'm' || replace(v_id::text, '-', '') end,
        published_at = case when v_from = 'published' then now() end,
        cancelled_at = case when v_from = 'cancelled' then now() end,
        cancelled_reason = case when v_from = 'cancelled' then 'user' end
      where id = v_id;
      set local session_replication_role = origin;
      v_state := public.s94cp_expect(format($sql$
        update atlas_private.marketing_deliveries set status = %L,
          claim_token = case when %L = 'publishing' then coalesce(claim_token, gen_random_uuid())
                             when %L in ('processing','verifying') then claim_token end,
          claimed_by = case when %L = 'publishing' then coalesce(claimed_by, 'matrix')
                            when %L in ('processing','verifying') then claimed_by end,
          claimed_until = case when %L = 'publishing' then coalesce(claimed_until, now() + interval '5 minutes')
                               when %L in ('processing','verifying') then claimed_until end,
          provider_post_id = coalesce(provider_post_id, case when %L = 'published' then 'p' || replace(id::text, '-', '') end),
          published_at = coalesce(published_at, case when %L = 'published' then now() end),
          cancelled_at = case when %L = 'cancelled' then now() end,
          cancelled_reason = case when %L = 'cancelled' then 'user' end
        where id = %L$sql$, v_to, v_to, v_to, v_to, v_to, v_to, v_to, v_to, v_to, v_to, v_to, v_id));
      select exists (select 1 from atlas_private.marketing_delivery_transitions where from_status = v_from and to_status = v_to) into v_legal;
      if (v_legal and v_state <> 'ok') or (not v_legal and v_state not like 'P0001%') then
        v_bad := v_bad || v_from || '->' || v_to || ':' || left(v_state, 60) || '; ';
      end if;
      v_checked := v_checked + 1;
    end loop;
  end loop;
  perform public.s94cp_ok('02 state machine: 72 pairs, legal ones succeed, illegal ones raise P0001', v_checked = 72 and v_bad = '', nullif(v_bad, ''));
  insert into s94c_ctx values ('matrix_content', v_content, null), ('matrix_approval', v_approval, null);
exception when others then
  perform public.s94cp_ok('zz section crashed: matrix', false, sqlstate || ' ' || sqlerrm);
end
$matrix$;

do $guards$
declare
  v_content uuid := public.s94cp_id('matrix_content');
  v_approval uuid := public.s94cp_id('matrix_approval');
  v_id uuid := gen_random_uuid();
  v_retry text; v_cancel text; v_ok boolean;
begin
  insert into atlas_private.marketing_deliveries (id, content_id, provider_key, external_account_id, target_kind, approval_id,
    approved_fingerprint, payload_snapshot, due_at, next_attempt_at, latest_acceptable_at)
  values (v_id, v_content, 'instagram', 'guard-1', 'ig_feed', v_approval, pg_catalog.sha256('x'::bytea), '{}'::jsonb, now(), now(), now());
  update atlas_private.marketing_deliveries set status = 'publishing', claim_token = gen_random_uuid(), claimed_by = 'g',
    claimed_until = now() + interval '5 minutes', phase = 'submitting', submit_started_at = now() where id = v_id;
  v_retry := public.s94cp_expect(format('update atlas_private.marketing_deliveries set status=''retrying'', claim_token=null, claimed_by=null, claimed_until=null where id=%L', v_id));
  v_cancel := public.s94cp_expect(format('update atlas_private.marketing_deliveries set status=''cancelled'', cancelled_at=now(), cancelled_reason=''user'', claim_token=null, claimed_by=null, claimed_until=null where id=%L', v_id));
  perform public.s94cp_ok('03 after the submit marker publishing→retrying and publishing→cancelled are refused',
    v_retry like 'P0001%unsafe retry%' and v_cancel like 'P0001%', v_retry || ' / ' || v_cancel);

  update atlas_private.marketing_deliveries set provider_post_id = 'post-1', provider_publish_id = 'pub-1', provider_container_id = 'cont-1' where id = v_id;
  v_ok := public.s94cp_expect(format('update atlas_private.marketing_deliveries set provider_post_id=''post-2'' where id=%L', v_id)) like 'P0001%write-once%'
    and public.s94cp_expect(format('update atlas_private.marketing_deliveries set provider_post_id=null where id=%L', v_id)) like 'P0001%write-once%'
    and public.s94cp_expect(format('update atlas_private.marketing_deliveries set provider_publish_id=''pub-2'' where id=%L', v_id)) like 'P0001%write-once%'
    and public.s94cp_expect(format('update atlas_private.marketing_deliveries set provider_container_id=null, phase=''none'' where id=%L', v_id)) like 'P0001%'
    and public.s94cp_expect(format('update atlas_private.marketing_deliveries set payload_snapshot=''{"x":1}'' where id=%L', v_id)) like 'P0001%frozen%';
  perform public.s94cp_ok('04 provider ids are write-once and the approved payload is frozen', v_ok);

  v_id := gen_random_uuid();
  insert into atlas_private.marketing_deliveries (id, content_id, provider_key, external_account_id, target_kind, approval_id,
    approved_fingerprint, payload_snapshot, due_at, next_attempt_at, latest_acceptable_at)
  values (v_id, v_content, 'instagram', 'guard-2', 'ig_feed', v_approval, pg_catalog.sha256('x'::bytea), '{}'::jsonb, now(), now(), now());
  update atlas_private.marketing_deliveries set status = 'publishing', claim_token = gen_random_uuid(), claimed_by = 'g',
    claimed_until = now() + interval '5 minutes', phase = 'container_created', provider_container_id = 'cont-2' where id = v_id;
  perform public.s94cp_ok('05 a container id may be cleared only with a pre-submit reset to phase none; published needs an id',
    public.s94cp_expect(format('update atlas_private.marketing_deliveries set provider_container_id=null, phase=''none'' where id=%L', v_id)) = 'ok'
    and public.s94cp_expect(format('update atlas_private.marketing_deliveries set status=''published'', published_at=now(), claim_token=null, claimed_by=null, claimed_until=null where id=%L', v_id)) like '23514%'
    and public.s94cp_expect(format('insert into atlas_private.marketing_deliveries (content_id, provider_key, external_account_id, target_kind, approval_id, approved_fingerprint, payload_snapshot, due_at, next_attempt_at, latest_acceptable_at) values (%L,''instagram'',''guard-2'',''ig_feed'',%L,sha256(''x''::bytea),''{}'',now(),now(),now())', v_content, v_approval)) like '23505%');
  update atlas_private.marketing_deliveries set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'user' where content_id = v_content and status = 'queued';
  perform public.s94cp_ok('06 one live delivery per target, re-creatable after cancel; a delivery starts queued',
    public.s94cp_expect(format('insert into atlas_private.marketing_deliveries (content_id, provider_key, external_account_id, target_kind, approval_id, approved_fingerprint, payload_snapshot, due_at, next_attempt_at, latest_acceptable_at) values (%L,''instagram'',''matrix-reuse'',''ig_feed'',%L,sha256(''x''::bytea),''{}'',now(),now(),now())', v_content, v_approval)) = 'ok'
    and public.s94cp_expect(format('insert into atlas_private.marketing_deliveries (content_id, provider_key, external_account_id, target_kind, approval_id, approved_fingerprint, payload_snapshot, due_at, next_attempt_at, latest_acceptable_at, status) values (%L,''instagram'',''matrix-x'',''ig_feed'',%L,sha256(''x''::bytea),''{}'',now(),now(),now(),''published'')', v_content, v_approval)) like 'P0001%');
  -- Retire the matrix rows so no claim below sees them.
  set local session_replication_role = replica;
  update atlas_private.marketing_deliveries set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'user',
    claim_token = null, claimed_by = null, claimed_until = null where content_id = v_content;
  update atlas_private.marketing_content_items set status = 'cancelled' where id = v_content;
  set local session_replication_role = origin;
exception when others then
  perform public.s94cp_ok('zz section crashed: guards', false, sqlstate || ' ' || sqlerrm);
end
$guards$;

-- 2. Approval, frozen payload, snapshot ----------------------------------------------------------

do $approval$
declare
  v_content uuid;
  v_img1 uuid := public.s94cp_asset('image', 1);
  v_img2 uuid := public.s94cp_asset('image', 2);
  v_vid uuid := public.s94cp_asset('video', 3);
  v_created jsonb;
  v_version integer;
  v_update jsonb;
  v_decide jsonb;
  v_ig atlas_private.marketing_deliveries;
  v_tt atlas_private.marketing_deliveries;
  v_fp bytea;
begin
  v_created := public.atlas_marketing_create_content(gen_random_uuid(), null, 'S94C Friday DJ', 'post', 'normal',
    array['instagram','tiktok'], now() + interval '2 days', null, null, null, 'reel', 'Friday DJ from 21:00', 'brief',
    '[{"frame":1}]'::jsonb, '{"notes":"vertical"}'::jsonb, null, null,
    '00000000-0000-4000-8000-000000094c02', 'S94C Manager', 'manager', '{}'::jsonb);
  v_content := (v_created ->> 'id')::uuid;
  perform public.s94cp_ok('07 create returns the created id at the top level',
    v_content is not null and v_created ->> 'content_id' = v_content::text and v_created #>> '{content,id}' = v_content::text);
  perform public.s94cp_attach(v_content, v_img2, 1);
  perform public.s94cp_attach(v_content, v_img1, 0);
  perform public.s94cp_attach(v_content, v_vid, 0, 'tiktok');
  select version into v_version from atlas_private.marketing_content_items where id = v_content;
  v_update := public.atlas_marketing_update_content('00000000-0000-4000-8000-000000094c02'::uuid, v_content, v_version,
    '{"platform_options":{"instagram":{"caption":"IG caption #dj"},"tiktok":{"target_kind":"tiktok_inbox_video","tiktok":{"privacy_level":"SELF_ONLY"}}}}'::jsonb);
  perform public.s94cp_ok('08 partial patch keeps unsent fields (frames, brief, media notes) and bumps the version',
    (v_update #>> '{content,version}')::integer = v_version + 1
    and v_update #> '{content,frames}' = '[{"frame":1}]'::jsonb and v_update #>> '{content,creative_brief}' = 'brief'
    and v_update #> '{content,media_requirements}' = '{"notes":"vertical"}'::jsonb
    and v_update #>> '{content,caption_draft}' = 'Friday DJ from 21:00'
    and v_update #>> '{content,platform_options,instagram,caption}' = 'IG caption #dj');
  perform public.s94cp_ok('09 a stale expected version is refused with 40001 atlas:stale_request (409)',
    public.s94cp_expect(format('select public.atlas_marketing_update_content(%L::uuid,%L::uuid,%s,''{"title":"x"}''::jsonb)',
      '00000000-0000-4000-8000-000000094c02', v_content, v_version)) like '40001%');
  v_decide := public.s94cp_approve(v_content);
  v_ig := public.s94cp_live(v_content, 'instagram');
  v_tt := public.s94cp_live(v_content, 'tiktok');
  v_fp := atlas_private.marketing_content_fingerprint(v_content);
  perform public.s94cp_ok('10 approval stores the fingerprint and creates one queued delivery per platform',
    jsonb_array_length(v_decide -> 'deliveries') = 2
    and v_ig.status = 'queued' and v_tt.status = 'queued'
    and v_ig.approved_fingerprint = v_fp and v_tt.approved_fingerprint = v_fp
    and (select approved_fingerprint = v_fp and approval_id is not null and status = 'scheduled' from atlas_private.marketing_content_items where id = v_content)
    and v_ig.external_account_id = 'ig-s94c-1' and v_ig.target_kind = 'ig_carousel' and v_tt.target_kind = 'tiktok_inbox_video'
    and v_ig.due_at = (select scheduled_for from atlas_private.marketing_content_items where id = v_content)
    and v_ig.latest_acceptable_at = v_ig.due_at + interval '6 hours');
  perform public.s94cp_ok('11 frozen payload: effective caption, ordered media with storage paths and hashes, options, no URLs',
    v_ig.payload_snapshot ->> 'caption' = 'IG caption #dj'
    and v_tt.payload_snapshot ->> 'caption' = 'Friday DJ from 21:00'
    and v_ig.payload_snapshot #>> '{media,0,asset_id}' = v_img1::text
    and v_ig.payload_snapshot #>> '{media,1,asset_id}' = v_img2::text
    and jsonb_array_length(v_ig.payload_snapshot -> 'media') = 2
    and v_tt.payload_snapshot #>> '{media,0,asset_id}' = v_vid::text and jsonb_array_length(v_tt.payload_snapshot -> 'media') = 1
    and v_ig.payload_snapshot #>> '{media,0,storage_path}' like 'venues/main/%/original.jpg'
    and v_ig.payload_snapshot #>> '{media,0,sha256}' ~ '^[0-9a-f]{64}$'
    and (v_ig.payload_snapshot #>> '{media,0,width}')::integer = 1080
    and v_tt.payload_snapshot #>> '{platform_options,tiktok,privacy_level}' = 'SELF_ONLY'
    and v_ig.payload_snapshot::text !~* 'https?://');
  insert into s94c_ctx values ('dj', v_content, null), ('img1', v_img1, null), ('img2', v_img2, null), ('vid', v_vid, null);
exception when others then
  perform public.s94cp_ok('zz section crashed: approval', false, sqlstate || ' ' || sqlerrm);
end
$approval$;

do $snapshot$
declare
  v_snap jsonb := public.atlas_marketing_workspace_snapshot('00000000-0000-4000-8000-000000094c02'::uuid, 'manager',
    (now() at time zone 'Atlantic/Reykjavik')::date, (now() at time zone 'Atlantic/Reykjavik')::date + 30);
  v_item jsonb;
begin
  select item into v_item from jsonb_array_elements(v_snap -> 'content_items') item where item ->> 'id' = public.s94cp_id('dj')::text;
  perform public.s94cp_ok('12 snapshot: per-item version, options, ordered media with thumb paths (no URLs), deliveries, state; top-level targets, switch, attention',
    v_item ? 'version' and v_item ? 'platform_options'
    and jsonb_array_length(v_item -> 'media') = 3
    and v_item #>> '{media,0,asset_id}' = public.s94cp_id('img1')::text
    and v_item #>> '{media,0,thumb_storage_path}' like 'venues/main/%/v/%.jpg'
    and not (v_item -> 'media' -> 0 ? 'storage_path')
    and jsonb_array_length(v_item -> 'deliveries') = 2
    and v_item #>> '{deliveries,0,status}' = 'queued'
    and v_item ->> 'publication_state' = 'ready_not_sent'
    and jsonb_typeof(v_snap -> 'publish_targets') = 'array'
    and v_snap -> 'automatic_publishing_enabled' = 'false'::jsonb
    and v_snap -> 'attention' ?& array['needs_attention','failed','verifying','total','blocked_next_30_days']
    and (v_snap -> 'content_items')::text !~* 'https?://', left(v_item::text, 400));
exception when others then
  perform public.s94cp_ok('zz section crashed: snapshot', false, sqlstate || ' ' || sqlerrm);
end
$snapshot$;

-- 3. Automatic publishing off, publish now, claim gate ----------------------------------------------

do $auto_off$
declare
  v_content uuid := public.s94cp_id('dj');
  v_claim jsonb;
begin
  perform public.s94cp_park();
  perform public.s94cp_due(v_content);
  v_claim := public.atlas_marketing_delivery_claim('worker-off', 10, 300);
  perform public.s94cp_ok('13 automatic publishing off: nothing is claimable, rows stay queued ("ready, not sent")',
    v_claim = '[]'::jsonb
    and (select count(*) from atlas_private.marketing_deliveries where content_id = v_content and status = 'queued') = 2
    and atlas_private.marketing_publication_state(v_content) = 'ready_not_sent');
  perform public.s94cp_ok('14 Publish now is refused while automatic publishing is off',
    public.s94cp_expect(format('select public.atlas_marketing_publish_now(%L::uuid, %L::uuid)',
      '00000000-0000-4000-8000-000000094c02', v_content)) like '55000%Automatic publishing is off%');
exception when others then
  perform public.s94cp_ok('zz section crashed: auto_off', false, sqlstate || ' ' || sqlerrm);
end
$auto_off$;

select public.s94cp_set_auto(true);

do $publish_now$
declare
  v_content uuid := public.s94cp_id('dj');
  v_now jsonb;
  v_again jsonb;
begin
  perform public.s94cp_park();
  v_now := public.atlas_marketing_publish_now('00000000-0000-4000-8000-000000094c02'::uuid, v_content);
  v_again := public.atlas_marketing_publish_now('00000000-0000-4000-8000-000000094c02'::uuid, v_content);
  perform public.s94cp_ok('15 Publish now makes the deliveries due now (priority 10, 30-minute window) without touching the approval; idempotent',
    v_now ->> 'status' = 'queued' and (v_now ->> 'wake')::boolean
    and (select bool_and(due_at = now() and next_attempt_at = now() and priority = 10 and latest_acceptable_at = now() + interval '30 minutes')
         from atlas_private.marketing_deliveries where content_id = v_content and status = 'queued')
    and (select status = 'scheduled' and approved_fingerprint = atlas_private.marketing_content_fingerprint(id)
         from atlas_private.marketing_content_items where id = v_content)
    and jsonb_array_length(v_again -> 'deliveries') = 2
    and (select count(*) from atlas_private.marketing_workspace_events where content_id = v_content and event_type = 'publish_now') = 2);
exception when others then
  perform public.s94cp_ok('zz section crashed: publish_now', false, sqlstate || ' ' || sqlerrm);
end
$publish_now$;

do $claim_flow$
declare
  v_content uuid := public.s94cp_id('dj');
  v_claim jsonb;
  v_ig jsonb;
  v_tt jsonb;
  v_token uuid;
  v_tt_token uuid;
  v_res jsonb;
  v_row atlas_private.marketing_deliveries;
  v_ig_version integer;
begin
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  select c into v_ig from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'instagram';
  select c into v_tt from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'tiktok';
  v_token := (v_ig ->> 'claim_token')::uuid;
  v_tt_token := (v_tt ->> 'claim_token')::uuid;
  perform public.s94cp_ok('16 claim returns both due deliveries with token, lease, kind publish and the frozen payload',
    jsonb_array_length(v_claim) = 2 and v_ig ->> 'claim_kind' = 'publish' and v_token is not null
    and (v_ig ->> 'lease_until')::timestamptz = now() + interval '300 seconds'
    and v_ig #>> '{delivery,status}' = 'publishing' and (v_ig #>> '{delivery,attempt_count}')::integer = 1
    and v_ig #>> '{payload_snapshot,caption}' = 'IG caption #dj'
    and (select count(*) from atlas_private.marketing_delivery_attempts where claim_token in (v_token, v_tt_token)) = 2
    and public.atlas_marketing_delivery_claim('worker-b', 10, 300) = '[]'::jsonb);

  v_res := public.atlas_marketing_delivery_record_step((v_ig #>> '{delivery,id}')::uuid, v_token, 'container_created',
    '{"provider_container_id":"17890000001","progress":{"children_container_ids":["c1","c2"]}}'::jsonb,
    '{"step":"container","http_status":200,"access_token":"EAAB-secret","message":"see https://graph.example/x?access_token=abc"}'::jsonb);
  select * into v_row from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid;
  perform public.s94cp_ok('17 record_step persists ids and phase before the next call; secrets and URLs never reach the ledger',
    (v_res ->> 'ok')::boolean and v_row.phase = 'container_created' and v_row.provider_container_id = '17890000001'
    and v_row.progress -> 'children_container_ids' = '["c1","c2"]'::jsonb
    and (select steps::text !~* '(EAAB|access_token|https?://)' and steps -> 0 ->> 'step' = 'container'
         from atlas_private.marketing_delivery_attempts where claim_token = v_token)
    and public.s94cp_expect(format('update atlas_private.marketing_delivery_attempts set steps = ''[{"access_token":"x"}]'' where claim_token = %L', v_token)) like '23514%');

  v_res := public.atlas_marketing_delivery_begin_submit((v_ig #>> '{delivery,id}')::uuid, v_token);
  perform public.s94cp_ok('18 begin_submit sets the submitting marker and keeps the lease; a second marker is refused',
    (v_res ->> 'ok')::boolean
    and (select phase = 'submitting' and submit_started_at = now() from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid)
    and public.s94cp_expect(format('select public.atlas_marketing_delivery_begin_submit(%L::uuid, %L::uuid)', v_ig #>> '{delivery,id}', v_token)) like 'P0001%');

  perform public.s94cp_ok('19 fencing: a wrong claim token gets lease_lost and changes nothing',
    public.atlas_marketing_delivery_complete((v_ig #>> '{delivery,id}')::uuid, gen_random_uuid(), '{"status":"published","post_id":"x"}'::jsonb)
      = '{"ok": false, "lease_lost": true}'::jsonb
    and public.atlas_marketing_delivery_record_step((v_ig #>> '{delivery,id}')::uuid, gen_random_uuid(), null, '{}'::jsonb, '{}'::jsonb) ->> 'lease_lost' = 'true'
    and public.atlas_marketing_delivery_heartbeat((v_ig #>> '{delivery,id}')::uuid, gen_random_uuid(), 60) ->> 'lease_lost' = 'true'
    and (select status = 'publishing' and provider_post_id is null from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid));

  v_res := public.atlas_marketing_delivery_complete((v_ig #>> '{delivery,id}')::uuid, v_token,
    '{"status":"published","post_id":"17999000001","permalink":"https://www.instagram.com/p/S94C/"}'::jsonb);
  -- TikTok: rejected before accepting anything (safe) -> retrying with backoff; then fails permanently.
  perform set_config('atlas.marketing_backoff_jitter', '0.5', true);
  v_res := v_res || jsonb_build_object('tt', public.atlas_marketing_delivery_complete((v_tt #>> '{delivery,id}')::uuid, v_tt_token,
    '{"status":"retrying","error":{"class":"transient","code":"http_500","message":"init returned 500"}}'::jsonb));
  select * into v_row from atlas_private.marketing_deliveries where id = (v_tt #>> '{delivery,id}')::uuid;
  perform public.s94cp_ok('20 complete: IG published (claim released, attempt closed); TikTok retrying with SQL backoff (attempt 1, jitter 0.5 = 45 s)',
    v_res ->> 'status' = 'published'
    and (select status = 'published' and claim_token is null and provider_permalink = 'https://www.instagram.com/p/S94C/' and published_source = 'provider'
         from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid)
    and (select outcome = 'published' and finished_at is not null from atlas_private.marketing_delivery_attempts where claim_token = v_token)
    and v_row.status = 'retrying' and v_row.next_attempt_at = now() + interval '45 seconds' and v_row.last_error_code = 'http_500'
    and atlas_private.marketing_publication_state(v_content) = 'partial');

  select row_version into v_ig_version from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid;
  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where id = v_row.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_tt_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  v_res := public.atlas_marketing_delivery_complete(v_row.id, v_tt_token,
    '{"status":"failed","error":{"class":"permanent","code":"spam_risk","message":"rejected"}}'::jsonb);
  perform public.s94cp_ok('21 a retry claims only the TikTok row; IG (published) is untouched and refused for requeue',
    jsonb_array_length(v_claim) = 1 and v_claim -> 0 #>> '{delivery,provider_key}' = 'tiktok'
    and (v_claim -> 0 #>> '{delivery,attempt_count}')::integer = 2
    and v_res ->> 'status' = 'failed'
    and (select row_version from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid) = v_ig_version
    and public.s94cp_expect(format('update atlas_private.marketing_deliveries set status=''queued'' where id=%L', v_ig #>> '{delivery,id}')) like 'P0001%'
    and public.s94cp_expect(format('select public.atlas_marketing_delivery_manager_action(%L::uuid, %L::uuid, ''retry'', ''{}''::jsonb)',
      '00000000-0000-4000-8000-000000094c02', v_ig #>> '{delivery,id}')) like '55000%');

  perform public.s94cp_ok('22 a permanent failure enqueues exactly one marketing push per audience member (admins, managers, owner)',
    (select count(*) from atlas_private.push_notification_queue where object_id = v_row.id) = 2
    and (select bool_and(event_type = 'marketing_attention' and route = 'marketing' and title = 'Post could not be published'
                         and body not like '%spam%' and body not like '%http%')
         from atlas_private.push_notification_queue where object_id = v_row.id)
    and (select array_agg(audience_user_id order by audience_user_id) from atlas_private.push_notification_queue where object_id = v_row.id)
        = array['00000000-0000-4000-8000-000000094c01'::uuid, '00000000-0000-4000-8000-000000094c02'::uuid]
    and (select attention_notified_at = now() from atlas_private.marketing_deliveries where id = v_row.id));

  v_res := public.atlas_marketing_delivery_manager_action('00000000-0000-4000-8000-000000094c02'::uuid, v_row.id, 'retry', '{}'::jsonb);
  perform public.s94cp_ok('23 manager retry requeues only the failed platform (attempts reset, notification re-armed)',
    v_res #>> '{delivery,status}' = 'queued' and (v_res #>> '{delivery,attempt_count}')::integer = 0
    and (select attention_notified_at is null from atlas_private.marketing_deliveries where id = v_row.id)
    and (select row_version from atlas_private.marketing_deliveries where id = (v_ig #>> '{delivery,id}')::uuid) = v_ig_version
    and exists (select 1 from atlas_private.marketing_workspace_events where event_type = 'delivery_requeued' and payload ->> 'delivery_id' = v_row.id::text));

  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where id = v_row.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_tt_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  perform public.atlas_marketing_delivery_begin_submit(v_row.id, v_tt_token);
  perform public.atlas_marketing_delivery_record_step(v_row.id, v_tt_token, 'submitted', '{"provider_publish_id":"v_pub_url~v2.1"}'::jsonb, '{"step":"init"}'::jsonb);
  v_res := public.atlas_marketing_delivery_complete(v_row.id, v_tt_token, '{"status":"processing","poll_after_s":30}'::jsonb);
  select * into v_row from atlas_private.marketing_deliveries where id = v_row.id;
  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where id = v_row.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_tt_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  perform public.s94cp_ok('24 async accepted -> processing; the poll claim does not consume an attempt',
    v_res ->> 'status' = 'processing' and v_row.next_attempt_at = now() + interval '30 seconds'
    and v_claim -> 0 ->> 'claim_kind' = 'poll'
    and (v_claim -> 0 #>> '{delivery,attempt_count}')::integer = v_row.attempt_count
    and (v_claim -> 0 #>> '{delivery,poll_count}')::integer = v_row.poll_count + 1
    and (v_claim -> 0 #>> '{delivery,status}') = 'processing');
  v_res := public.atlas_marketing_delivery_complete(v_row.id, v_tt_token, '{"status":"retrying","error":{"class":"transient","code":"http_503"}}'::jsonb);
  select * into v_row from atlas_private.marketing_deliveries where id = v_row.id;
  perform public.s94cp_ok('25 a transient poll error keeps processing and does not consume attempts',
    v_res ->> 'status' = 'processing' and v_row.status = 'processing' and v_row.attempt_count = 1
    and v_row.next_attempt_at > now());
  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where id = v_row.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_tt_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  v_res := public.atlas_marketing_delivery_complete(v_row.id, v_tt_token, '{"status":"published","post_id":"7300000000000000001"}'::jsonb);
  perform public.s94cp_ok('26 all platforms published -> content published with external ids rebuilt from deliveries',
    (select status = 'published' and external_publication_ids ? 'instagram' and external_publication_ids ? 'tiktok'
            and external_publication_ids #>> '{tiktok,post_id}' = '7300000000000000001'
     from atlas_private.marketing_content_items where id = v_content)
    and atlas_private.marketing_publication_state(v_content) = 'published'
    and (select count(*) from atlas_private.push_notification_queue where event_type = 'marketing_attention' and object_id = v_row.id) = 2);
exception when others then
  perform public.s94cp_ok('zz section crashed: claim_flow', false, sqlstate || ' ' || sqlerrm);
end
$claim_flow$;

-- 4. Edits after approval, gates ---------------------------------------------------------------------

do $edits$
declare
  v_content uuid;
  v_version integer;
  v_res jsonb;
  v_old atlas_private.marketing_deliveries;
  v_claim jsonb;
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C edit', array['instagram','facebook'], now() + interval '1 day');
  perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_content);
  v_old := public.s94cp_live(v_content, 'instagram');
  select version into v_version from atlas_private.marketing_content_items where id = v_content;
  v_res := public.atlas_marketing_update_content('00000000-0000-4000-8000-000000094c02'::uuid, v_content, v_version, '{"title":"S94C edit (renamed)"}'::jsonb);
  perform public.s94cp_ok('27 a title-only edit keeps the approval and the queued deliveries',
    v_res #>> '{content,status}' = 'scheduled' and not (v_res ->> 'approval_invalidated')::boolean
    and (select count(*) from atlas_private.marketing_deliveries where content_id = v_content and status = 'queued') = 2);
  v_res := public.atlas_marketing_update_content('00000000-0000-4000-8000-000000094c02'::uuid, v_content, v_version + 1, '{"caption_draft":"New caption"}'::jsonb);
  perform public.s94cp_ok('28 a caption edit after approval cancels unstarted deliveries (superseded_by_edit) and needs re-approval',
    v_res #>> '{content,status}' = 'draft' and (v_res ->> 'approval_invalidated')::boolean and (v_res ->> 'cancelled_deliveries')::integer = 2
    and (select bool_and(status = 'cancelled' and cancelled_reason = 'superseded_by_edit') from atlas_private.marketing_deliveries where content_id = v_content)
    and (select approval_id is null and approved_fingerprint is null from atlas_private.marketing_content_items where id = v_content)
    and exists (select 1 from atlas_private.marketing_workspace_events where content_id = v_content and event_type = 'approval_invalidated'));
  perform public.s94cp_approve(v_content);
  perform public.s94cp_ok('29 re-approval creates fresh deliveries next to the cancelled ones',
    (select count(*) from atlas_private.marketing_deliveries where content_id = v_content and status = 'queued') = 2
    and (select count(*) from atlas_private.marketing_deliveries where content_id = v_content) = 4);
  -- A media change after approval is material too.
  perform public.s94cp_attach(v_content, public.s94cp_id('img2'), 1);
  perform public.s94cp_ok('30 attaching media to approved content sends it back to draft and cancels its queued deliveries',
    (select status from atlas_private.marketing_content_items where id = v_content) = 'draft'
    and (select count(*) from atlas_private.marketing_deliveries where content_id = v_content and status = 'queued') = 0);
  perform public.s94cp_approve(v_content);
  -- A fingerprint mismatch that bypassed the edit path (trigger off) is caught at claim time.
  set local session_replication_role = replica;
  update atlas_private.marketing_content_items set caption_draft = 'Sneaky edit' where id = v_content;
  set local session_replication_role = origin;
  perform public.s94cp_due(v_content);
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  perform public.s94cp_ok('31 fingerprint mismatch at claim: nothing claimed, the deliveries are cancelled superseded_by_edit',
    v_claim = '[]'::jsonb
    and (select count(*) from atlas_private.marketing_deliveries where content_id = v_content and status = 'cancelled' and cancelled_reason = 'superseded_by_edit') = 6);
  insert into s94c_ctx values ('edit', v_content, null);
exception when others then
  perform public.s94cp_ok('zz section crashed: edits', false, sqlstate || ' ' || sqlerrm);
end
$edits$;

do $gate_more$
declare
  v_rejected uuid; v_cancelled uuid; v_inflight uuid; v_claim jsonb; v_res jsonb; v_version integer; v_row atlas_private.marketing_deliveries;
begin
  perform public.s94cp_park();
  -- Rejected content has no deliveries and a forced one is never claimed.
  v_rejected := public.s94cp_content('S94C rejected', array['instagram'], now() + interval '1 day');
  perform public.s94cp_attach(v_rejected, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_rejected);
  set local session_replication_role = replica;
  update atlas_private.marketing_content_items set status = 'rejected' where id = v_rejected;
  set local session_replication_role = origin;
  perform public.s94cp_due(v_rejected);
  v_cancelled := public.s94cp_content('S94C cancelled', array['instagram','facebook'], now() + interval '1 day');
  perform public.s94cp_attach(v_cancelled, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_cancelled);
  perform public.s94cp_due(v_cancelled);
  v_res := public.atlas_marketing_content_cancel('00000000-0000-4000-8000-000000094c02'::uuid, v_cancelled, 'Event moved');
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  perform public.s94cp_ok('32 rejected and cancelled content is never claimed (deliveries end cancelled)',
    v_claim = '[]'::jsonb
    and (v_res ->> 'cancelled_deliveries')::integer = 2 and v_res #>> '{content,status}' = 'cancelled'
    and (select bool_and(status = 'cancelled' and cancelled_reason = 'content_cancelled') from atlas_private.marketing_deliveries where content_id in (v_rejected, v_cancelled))
    and exists (select 1 from atlas_private.marketing_content_revisions where content_id = v_cancelled and change_type = 'cancellation'));

  -- In flight: edits are refused, cancel only requests a stop; begin_submit then refuses.
  v_inflight := public.s94cp_content('S94C in flight', array['instagram'], now() + interval '1 day');
  perform public.s94cp_attach(v_inflight, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_inflight);
  perform public.s94cp_due(v_inflight);
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  select version into v_version from atlas_private.marketing_content_items where id = v_inflight;
  perform public.s94cp_ok('33 an edit while a delivery is in flight is refused (atlas:in_flight)',
    jsonb_array_length(v_claim) = 1
    and public.s94cp_expect(format('select public.atlas_marketing_update_content(%L::uuid,%L::uuid,%s,''{"caption_draft":"late"}''::jsonb)',
      '00000000-0000-4000-8000-000000094c02', v_inflight, v_version)) like '55000%being published%');
  v_row := public.s94cp_live(v_inflight, 'instagram');
  v_res := public.atlas_marketing_delivery_manager_action('00000000-0000-4000-8000-000000094c02'::uuid, v_row.id, 'cancel', '{}'::jsonb);
  v_res := v_res || jsonb_build_object('begin', public.atlas_marketing_delivery_begin_submit(v_row.id, (v_claim -> 0 ->> 'claim_token')::uuid));
  perform public.s94cp_ok('34 cancelling an in-flight delivery requests a stop; begin_submit refuses and cancels before any call',
    v_res #>> '{begin,refused}' = 'true' and v_res #>> '{begin,reason}' = 'cancel_requested'
    and (select status = 'cancelled' and cancelled_reason = 'user' and claim_token is null from atlas_private.marketing_deliveries where id = v_row.id)
    and (select outcome from atlas_private.marketing_delivery_attempts where claim_token = (v_claim -> 0 ->> 'claim_token')::uuid) = 'cancelled');
exception when others then
  perform public.s94cp_ok('zz section crashed: gate_more', false, sqlstate || ' ' || sqlerrm);
end
$gate_more$;

-- 5. Leases, stale guard, attestation, mark posted, backoff ---------------------------------------------

do $leases$
declare
  v_content uuid; v_claim jsonb; v_ig atlas_private.marketing_deliveries; v_fb atlas_private.marketing_deliveries;
  v_ig_token uuid; v_fb_token uuid; v_res jsonb; v_state text;
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C leases', array['instagram','facebook'], now() + interval '1 day');
  perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  select (c ->> 'claim_token')::uuid into v_ig_token from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'instagram';
  select (c ->> 'claim_token')::uuid into v_fb_token from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'facebook';
  v_ig := public.s94cp_live(v_content, 'instagram');
  v_fb := public.s94cp_live(v_content, 'facebook');
  perform public.atlas_marketing_delivery_begin_submit(v_fb.id, v_fb_token);
  -- Both workers stall past their leases.
  update atlas_private.marketing_deliveries set claimed_until = now() - interval '1 second' where id in (v_ig.id, v_fb.id);
  perform public.s94cp_ok('35 an expired lease is fenced: the late complete gets lease_lost',
    public.atlas_marketing_delivery_complete(v_fb.id, v_fb_token, '{"status":"published","post_id":"fb_1"}'::jsonb) ->> 'lease_lost' = 'true'
    and public.atlas_marketing_delivery_begin_submit(v_ig.id, v_ig_token) ->> 'lease_lost' = 'true');
  update atlas_private.marketing_deliveries set next_attempt_at = now() + interval '1 day' where content_id <> v_content and status in ('queued','retrying') and claim_token is null;
  v_claim := public.atlas_marketing_delivery_claim('worker-b', 10, 300);
  v_ig := public.s94cp_live(v_content, 'instagram');
  v_fb := public.s94cp_live(v_content, 'facebook');
  perform public.s94cp_ok('36 lease recovery: before the marker -> retrying (reclaimed), after the marker -> verifying (verify claim); old attempts lease_lost',
    (select outcome from atlas_private.marketing_delivery_attempts where claim_token = v_ig_token) = 'lease_lost'
    and (select outcome from atlas_private.marketing_delivery_attempts where claim_token = v_fb_token) = 'lease_lost'
    and jsonb_array_length(v_claim) = 2
    and (select c ->> 'claim_kind' from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'instagram') = 'publish'
    and (select c ->> 'claim_kind' from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'facebook') = 'verify'
    and v_ig.status = 'publishing' and v_ig.attempt_count = 2 and v_fb.status = 'verifying' and v_fb.claimed_by = 'worker-b');
  v_fb_token := (select (c ->> 'claim_token')::uuid from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'facebook');
  v_ig_token := (select (c ->> 'claim_token')::uuid from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'instagram');
  -- IG: an uncertain outcome after the marker becomes verifying, never retrying.
  perform public.atlas_marketing_delivery_begin_submit(v_ig.id, v_ig_token);
  v_res := public.atlas_marketing_delivery_complete(v_ig.id, v_ig_token, '{"status":"retrying","error":{"class":"transient","code":"timeout"}}'::jsonb);
  perform public.s94cp_ok('37 "retrying" after the submit marker is turned into verifying (no blind retry)',
    v_res ->> 'status' = 'verifying' and (select phase from atlas_private.marketing_deliveries where id = v_ig.id) = 'submitting');
  -- FB: the verify budget runs out -> needs attention (outcome unknown), one push.
  update atlas_private.marketing_deliveries set verify_attempts = 3 where id = v_fb.id;
  v_res := public.atlas_marketing_delivery_complete(v_fb.id, v_fb_token, '{"status":"verifying","error":{"class":"uncertain","code":"not_found_yet"}}'::jsonb);
  perform public.s94cp_ok('38 verify budget exhausted -> needs_attention(outcome_unknown) with one push per person',
    v_res ->> 'status' = 'needs_attention' and v_res ->> 'attention_reason' = 'outcome_unknown'
    and (select count(*) from atlas_private.push_notification_queue where object_id = v_fb.id) = 2
    and (select body like '%may or may not have been posted%' from atlas_private.push_notification_queue where object_id = v_fb.id limit 1));
  v_state := public.s94cp_expect(format('select public.atlas_marketing_delivery_manager_action(%L::uuid,%L::uuid,''retry'',''{}''::jsonb)',
      '00000000-0000-4000-8000-000000094c02', v_fb.id));
  v_res := public.atlas_marketing_delivery_manager_action('00000000-0000-4000-8000-000000094c02'::uuid, v_fb.id, 'retry',
      '{"confirmed_not_posted":true}'::jsonb);
  perform public.s94cp_ok('39 retry after the submit marker needs the manager''s attestation',
    v_state like '55000%confirm it was not posted%'
    and v_res #>> '{delivery,status}' = 'queued'
    and (select phase from atlas_private.marketing_deliveries where id = v_fb.id) = 'none'
    and exists (select 1 from atlas_private.marketing_workspace_events where event_type = 'delivery_requeued'
                and payload ->> 'delivery_id' = v_fb.id::text and (payload ->> 'confirmed_not_posted')::boolean));
  -- IG: needs attention, then the manager marks it posted with a link.
  update atlas_private.marketing_deliveries set verify_attempts = 3, next_attempt_at = now() - interval '1 second' where id = v_ig.id;
  update atlas_private.marketing_deliveries set next_attempt_at = now() + interval '1 day' where id = v_fb.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-b', 10, 300);
  perform public.atlas_marketing_delivery_complete(v_ig.id, (v_claim -> 0 ->> 'claim_token')::uuid, '{"status":"verifying"}'::jsonb);
  v_state := public.s94cp_expect(format('select public.atlas_marketing_delivery_manager_action(%L::uuid,%L::uuid,''mark_posted'',''{"permalink":"http://instagram.com/p/x"}''::jsonb)',
      '00000000-0000-4000-8000-000000094c02', v_ig.id));
  v_res := public.atlas_marketing_delivery_manager_action('00000000-0000-4000-8000-000000094c02'::uuid, v_ig.id, 'mark_posted',
      '{"permalink":"https://www.instagram.com/p/S94Cmanual/"}'::jsonb);
  perform public.s94cp_ok('40 mark posted needs an https permalink and records a manual publication',
    v_state like '22023%https%'
    and v_res #>> '{delivery,status}' = 'published'
    and (select published_source = 'manual' and provider_permalink = 'https://www.instagram.com/p/S94Cmanual/' from atlas_private.marketing_deliveries where id = v_ig.id));
  insert into s94c_ctx values ('leases', v_content, null);
exception when others then
  perform public.s94cp_ok('zz section crashed: leases', false, sqlstate || ' ' || sqlerrm);
end
$leases$;

do $stale$
declare
  v_content uuid; v_row atlas_private.marketing_deliveries; v_claim jsonb; v_count integer;
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C stale', array['instagram'], now() + interval '1 day');
  perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_content);
  update atlas_private.marketing_deliveries set due_at = now() - interval '7 hours', next_attempt_at = now() - interval '7 hours',
    latest_acceptable_at = now() - interval '1 hour' where content_id = v_content;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_row := public.s94cp_live(v_content, 'instagram');
  select count(*) into v_count from atlas_private.push_notification_queue where object_id = v_row.id;
  v_claim := v_claim || public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  perform public.s94cp_ok('41 stale guard: past latest_acceptable_at goes to needs_attention(stale_schedule), never published late; one push, no repeat',
    v_claim = '[]'::jsonb and v_row.status = 'needs_attention' and v_row.attention_reason = 'stale_schedule'
    and v_count = 2 and (select count(*) from atlas_private.push_notification_queue where object_id = v_row.id) = 2
    and atlas_private.marketing_publication_state(v_content) = 'attention');
exception when others then
  perform public.s94cp_ok('zz section crashed: stale', false, sqlstate || ' ' || sqlerrm);
end
$stale$;

do $backoff$
begin
  perform public.s94cp_ok('42 backoff: equal jitter (fixed jitter), doubling, 1 h cap, Retry-After wins',
    atlas_private.marketing_backoff(1, 60, 3600, null, 0.5) = interval '45 seconds'
    and atlas_private.marketing_backoff(2, 60, 3600, null, 0) = interval '60 seconds'
    and atlas_private.marketing_backoff(3, 60, 3600, null, 0.5) = interval '180 seconds'
    and atlas_private.marketing_backoff(6, 60, 3600, null, 0.999999) < interval '1920 seconds'
    and atlas_private.marketing_backoff(12, 60, 3600, null, 0.999999) <= interval '3600 seconds'
    and atlas_private.marketing_backoff(12, 60, 3600, null, 0) = interval '1800 seconds'
    and atlas_private.marketing_backoff(1, 60, 3600, 500, 0.5) = interval '500 seconds'
    and (select bool_and(atlas_private.marketing_backoff(n, 60, 3600) between make_interval(secs => least(3600, 60 * power(2, n - 1)) / 2)
                                                                     and make_interval(secs => least(3600, 60 * power(2, n - 1))))
         from generate_series(1, 8) n));
exception when others then
  perform public.s94cp_ok('zz section crashed: backoff', false, sqlstate || ' ' || sqlerrm);
end
$backoff$;

do $max_attempts$
declare
  v_content uuid; v_row atlas_private.marketing_deliveries; v_claim jsonb; v_res jsonb;
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C attempts', array['facebook'], now() + interval '1 day');
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  v_row := public.s94cp_live(v_content, 'facebook');
  update atlas_private.marketing_deliveries set attempt_count = 5 where id = v_row.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_res := public.atlas_marketing_delivery_complete(v_row.id, (v_claim -> 0 ->> 'claim_token')::uuid,
    '{"status":"retrying","retry_after_s":120,"error":{"class":"rate_limited","code":"429"}}'::jsonb);
  perform public.s94cp_ok('43 six publish attempts max -> needs_attention(max_attempts); a 429 sets the account cooldown',
    v_claim -> 0 ->> 'claim_kind' = 'publish' and (v_claim -> 0 #>> '{delivery,attempt_count}')::integer = 6
    and v_res ->> 'status' = 'needs_attention' and v_res ->> 'attention_reason' = 'max_attempts'
    and (select cooldown_until = now() + interval '120 seconds' from atlas_private.marketing_provider_accounts
         where provider_key = 'facebook' and external_account_id = 'fb-s94c-1'));
  delete from atlas_private.marketing_provider_accounts where provider_key = 'facebook';
exception when others then
  perform public.s94cp_ok('zz section crashed: max_attempts', false, sqlstate || ' ' || sqlerrm);
end
$max_attempts$;

do $fairness$
declare
  v_ids uuid[] := '{}'; v_content uuid; v_claim jsonb; i integer; v_budget jsonb;
begin
  perform public.s94cp_park();
  for i in 1..3 loop
    v_content := public.s94cp_content('S94C fair ' || i, array['instagram'], now() + interval '1 day');
    perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 0);
    perform public.s94cp_approve(v_content);
    perform public.s94cp_due(v_content);
    v_ids := v_ids || v_content;
  end loop;
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  perform public.s94cp_ok('44 fairness: at most 2 deliveries per account per claim',
    jsonb_array_length(v_claim) = 2);
  -- Budget: 25 Instagram publications in the last 24 h exhaust the Atlas safety cap.
  update atlas_private.marketing_deliveries set claimed_until = now() - interval '1 second' where content_id = any(v_ids) and claim_token is not null;
  perform atlas_private.marketing_recover_expired_leases();
  set local session_replication_role = replica;
  insert into atlas_private.marketing_content_items (id, client_request_id, title, content_type, status, created_by_label, created_by_role)
  select ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(), 'S94C budget ' || n, 'post', 'published', 'S94C', 'manager'
  from generate_series(1, 25) n;
  insert into atlas_private.marketing_deliveries (content_id, provider_key, external_account_id, target_kind, approval_id, approved_fingerprint,
    payload_snapshot, status, due_at, next_attempt_at, latest_acceptable_at, provider_post_id, published_at, published_source)
  select ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid, 'instagram', 'ig-s94c-1', 'ig_feed', public.s94cp_id('matrix_approval'), sha256('x'::bytea), '{}'::jsonb,
         'published', now() - interval '2 hours', now(), now(), 'budget_' || n, now() - make_interval(hours => 1) - make_interval(mins => n), 'provider'
  from generate_series(1, 25) n;
  set local session_replication_role = origin;
  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where content_id = any(v_ids) and status in ('queued','retrying');
  -- The first post may still go out in two days; the other two must go out within 6 hours.
  update atlas_private.marketing_deliveries set latest_acceptable_at = now() + interval '2 days' where content_id = v_ids[1];
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300) || public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  perform public.s94cp_ok('45 budget: 25 publications in 24 h -> nothing claimed; deferred past the window, or rate_limit_exhausted when that is too late',
    v_claim = '[]'::jsonb
    and (select status in ('queued','retrying') and next_attempt_at > now() + interval '20 hours' from atlas_private.marketing_deliveries where content_id = v_ids[1])
    and (select bool_and(status = 'needs_attention' and attention_reason = 'rate_limit_exhausted')
         from atlas_private.marketing_deliveries where content_id in (v_ids[2], v_ids[3])));
  set local session_replication_role = replica;
  delete from atlas_private.marketing_deliveries where provider_post_id like 'budget_%';
  set local session_replication_role = origin;
exception when others then
  perform public.s94cp_ok('zz section crashed: fairness', false, sqlstate || ' ' || sqlerrm);
end
$fairness$;

do $readiness$
declare
  v_content uuid; v_claim jsonb; v_row atlas_private.marketing_deliveries;
begin
  perform public.s94cp_park();
  -- Google has no selected location: the delivery is created with 'pending' and needs attention when due.
  v_content := public.s94cp_content('S94C gbp', array['google-business-profile'], now() + interval '1 day');
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_row := public.s94cp_live(v_content, 'google-business-profile');
  perform public.s94cp_ok('46 no resource chosen at approval -> external_account_id pending -> needs_attention(no_resource) at claim',
    v_claim = '[]'::jsonb and v_row.external_account_id = 'pending' and v_row.status = 'needs_attention' and v_row.attention_reason = 'no_resource');
  -- Facebook loses publishing permission after approval.
  v_content := public.s94cp_content('S94C fb not ready', array['facebook'], now() + interval '1 day');
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  update atlas_private.integration_connections set publishing_permission_state = 'missing' where provider_key = 'facebook';
  v_claim := public.atlas_marketing_delivery_claim('worker-a', 10, 300);
  v_row := public.s94cp_live(v_content, 'facebook');
  perform public.s94cp_ok('47 provider not ready when due -> needs_attention(provider_not_ready), nothing claimed',
    v_claim = '[]'::jsonb and v_row.status = 'needs_attention' and v_row.attention_reason = 'provider_not_ready');
  update atlas_private.integration_connections set publishing_permission_state = 'granted' where provider_key = 'facebook';
exception when others then
  perform public.s94cp_ok('zz section crashed: readiness', false, sqlstate || ' ' || sqlerrm);
end
$readiness$;

-- 7. Worker contract details (coordination with atlas-marketing-publisher) ----------------------

do $worker_contract$
declare
  v_content uuid; v_claim jsonb; v_ig atlas_private.marketing_deliveries; v_tt atlas_private.marketing_deliveries;
  v_token uuid; v_tt_token uuid; v_res jsonb; v_state text; v_bad text;
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C worker contract', array['instagram','tiktok'], now() + interval '1 day');
  perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 0);
  perform public.s94cp_attach(v_content, public.s94cp_id('vid'), 0, 'tiktok');
  update atlas_private.marketing_content_items set platform_options =
    '{"tiktok":{"target_kind":"tiktok_video","tiktok":{"privacy_level":"SELF_ONLY","consent_confirmed_at":"2026-10-01T10:00:00Z","consent_by":"00000000-0000-4000-8000-000000094c02","disable_comment":false}}}'
  where id = v_content;
  perform public.s94cp_approve(v_content);
  v_tt := public.s94cp_live(v_content, 'tiktok');
  perform public.s94cp_ok('60 TikTok Direct Post consent (consent_confirmed_at, consent_by) is frozen into the payload snapshot',
    v_tt.target_kind = 'tiktok_video'
    and v_tt.payload_snapshot #>> '{platform_options,tiktok,consent_confirmed_at}' = '2026-10-01T10:00:00Z'
    and v_tt.payload_snapshot #>> '{platform_options,tiktok,consent_by}' = '00000000-0000-4000-8000-000000094c02'
    and v_tt.payload_snapshot ->> 'venue_timezone' = atlas_private.venue_timezone());
  perform public.s94cp_due(v_content);
  v_claim := public.atlas_marketing_delivery_claim('worker-w', 10, 300);
  v_ig := public.s94cp_live(v_content, 'instagram');
  select (c ->> 'claim_token')::uuid into v_token from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'instagram';
  select (c ->> 'claim_token')::uuid into v_tt_token from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'tiktok';

  -- TikTok: init definitively rejected after the marker (429 body, no publish id) -> retrying, marker cleared.
  perform public.atlas_marketing_delivery_begin_submit(v_tt.id, v_tt_token);
  v_res := public.atlas_marketing_delivery_complete(v_tt.id, v_tt_token,
    '{"status":"retrying","definitive":true,"retry_after_s":60,"cooldown_s":60,"error":{"class":"rate_limited","code":"rate_limit_exceeded"}}'::jsonb);
  v_tt := public.s94cp_live(v_content, 'tiktok');
  perform public.s94cp_ok('61 a definitive provider rejection after the marker retries (marker cleared); without definitive it verifies',
    v_res ->> 'status' = 'retrying' and v_tt.phase = 'none' and v_tt.next_attempt_at >= now() + interval '60 seconds'
    and (select cooldown_until >= now() + interval '60 seconds' from atlas_private.marketing_provider_accounts
         where provider_key = 'tiktok' and external_account_id = 'tt-s94c-1'));
  delete from atlas_private.marketing_provider_accounts where provider_key = 'tiktok';

  -- IG: container, marker, uncertain -> verifying; the verify proves absence -> retrying (definitive only).
  perform public.atlas_marketing_delivery_record_step(v_ig.id, v_token, 'container_ready', '{"provider_container_id":"17890000777"}'::jsonb, '{"step":"container"}'::jsonb);
  perform public.atlas_marketing_delivery_begin_submit(v_ig.id, v_token);
  v_state := public.s94cp_expect(format('select public.atlas_marketing_delivery_record_step(%L::uuid, %L::uuid, ''media_ready'', ''{}''::jsonb, ''{}''::jsonb)', v_ig.id, v_token));
  v_res := public.atlas_marketing_delivery_record_step(v_ig.id, v_token, 'container_ready', '{}'::jsonb, '{"step":"verify","detail":"matches=0"}'::jsonb);
  perform public.s94cp_ok('62 record_step: after the marker only submitted, or container_ready for a proven-unpublished IG container',
    v_state like 'P0001%earlier phase%' and (v_res ->> 'ok')::boolean and v_res ->> 'phase' = 'container_ready');
  perform public.atlas_marketing_delivery_begin_submit(v_ig.id, v_token);
  v_res := public.atlas_marketing_delivery_complete(v_ig.id, v_token, '{"status":"verifying","poll_after_s":120,"error":{"class":"uncertain","code":"timeout"}}'::jsonb);
  v_ig := public.s94cp_live(v_content, 'instagram');
  perform public.s94cp_ok('63 poll_after_s is honoured for verifying outcomes',
    v_res ->> 'status' = 'verifying' and v_ig.next_attempt_at = now() + interval '120 seconds');
  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where id = v_ig.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-w', 10, 300);
  v_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  v_res := public.atlas_marketing_delivery_complete(v_ig.id, v_token, '{"status":"retrying","error":{"class":"uncertain","code":"verified_absent"}}'::jsonb);
  v_bad := v_res ->> 'status';
  update atlas_private.marketing_deliveries set next_attempt_at = now() - interval '1 second' where id = v_ig.id;
  v_claim := public.atlas_marketing_delivery_claim('worker-w', 10, 300);
  v_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  v_res := public.atlas_marketing_delivery_complete(v_ig.id, v_token,
    '{"status":"retrying","definitive":true,"error":{"class":"transient","code":"verified_absent"}}'::jsonb);
  v_ig := public.s94cp_live(v_content, 'instagram');
  perform public.s94cp_ok('64 verifying -> retrying only with definitive proof of absence; the same container is kept (phase container_ready)',
    v_bad = 'verifying' and v_claim -> 0 ->> 'claim_kind' = 'verify'
    and v_res ->> 'status' = 'retrying' and v_ig.status = 'retrying' and v_ig.phase = 'container_ready'
    and v_ig.provider_container_id = '17890000777');
  perform public.s94cp_ok('65 queued -> needs_attention is a legal transition (stale / no resource at claim)',
    exists (select 1 from atlas_private.marketing_delivery_transitions where from_status = 'queued' and to_status = 'needs_attention'));
exception when others then
  perform public.s94cp_ok('zz section crashed: worker_contract', false, sqlstate || ' ' || sqlerrm);
end
$worker_contract$;

-- 6. Reschedule, duplicate, history, venue time, settings, roles, grants, tick --------------------

do $workflow$
declare
  v_content uuid; v_version integer; v_res jsonb; v_dup jsonb; v_hist jsonb; v_dj uuid := public.s94cp_id('dj');
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C move', array['instagram'], now() + interval '1 day');
  perform public.s94cp_attach(v_content, public.s94cp_id('img2'), 0);
  perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 1);
  update atlas_private.marketing_content_items set platform_options = '{"tiktok":{"tiktok":{"privacy_level":"SELF_ONLY","consent_confirmed_at":"2026-10-01T10:00:00Z","consent_by":"x"}}}'
  where id = v_content;
  perform public.s94cp_approve(v_content);
  select version into v_version from atlas_private.marketing_content_items where id = v_content;
  perform public.s94cp_ok('48 reschedule with a stale version is refused (409)',
    public.s94cp_expect(format('select public.atlas_marketing_content_reschedule(%L::uuid,%L::uuid,%s,now() + interval ''2 days'')',
      '00000000-0000-4000-8000-000000094c02', v_content, v_version - 1)) like '40001%');
  v_res := public.atlas_marketing_content_reschedule('00000000-0000-4000-8000-000000094c02'::uuid, v_content, v_version, now() + interval '2 days');
  perform public.s94cp_ok('49 reschedule of approved content is a material edit: draft, deliveries cancelled, re-approval needed',
    v_res #>> '{content,status}' = 'draft' and (v_res ->> 'approval_invalidated')::boolean and (v_res ->> 'cancelled_deliveries')::integer = 1
    and (v_res #>> '{content,scheduled_for}')::timestamptz = now() + interval '2 days'
    and exists (select 1 from atlas_private.marketing_workspace_events where content_id = v_content and event_type = 'content_rescheduled'));
  v_dup := public.atlas_marketing_content_duplicate('00000000-0000-4000-8000-000000094c02'::uuid, v_content);
  perform public.s94cp_ok('50 duplicate: new draft with caption, options (TikTok consent cleared) and media in order, no schedule',
    v_dup #>> '{content,status}' = 'draft' and v_dup #>> '{content,title}' = 'Copy of S94C move'
    and (v_dup #>> '{content,scheduled_for}') is null
    and v_dup #>> '{content,platform_options,tiktok,tiktok,privacy_level}' = 'SELF_ONLY'
    and not (v_dup #> '{content,platform_options,tiktok,tiktok}' ? 'consent_confirmed_at')
    and (select array_agg(asset_id order by position) from atlas_private.marketing_content_media where content_id = (v_dup #>> '{content,id}')::uuid)
        = array[public.s94cp_id('img2'), public.s94cp_id('img1')]);
  v_hist := public.atlas_marketing_publication_history('00000000-0000-4000-8000-000000094c02'::uuid, v_dj);
  perform public.s94cp_ok('51 history: deliveries with attempts and sanitised steps, approvals, revisions, events',
    v_hist ?& array['content','deliveries','approvals','revisions','events']
    and jsonb_array_length(v_hist -> 'deliveries') = 2
    and (select bool_and(d ? 'attempts' and d ? 'can_retry' and d ? 'provider_permalink') from jsonb_array_elements(v_hist -> 'deliveries') d)
    and (select jsonb_array_length(d -> 'attempts') from jsonb_array_elements(v_hist -> 'deliveries') d where d ->> 'provider_key' = 'tiktok') = 5
    and (select count(*) from jsonb_array_elements(v_hist -> 'approvals') a where a ->> 'decision' = 'approved') = 1
    and jsonb_array_length(v_hist -> 'revisions') >= 3
    and v_hist::text !~* '(access_token|EAAB|approved_fingerprint)');
exception when others then
  perform public.s94cp_ok('zz section crashed: workflow', false, sqlstate || ' ' || sqlerrm);
end
$workflow$;

do $venue$
declare
  v_content uuid; v_snap jsonb; v_ny date := (now() at time zone 'America/New_York')::date; v_found boolean;
begin
  update atlas_private.settings_sections set settings_value = jsonb_set(settings_value, '{timezone}', '"America/New_York"')
  where section_key = 'venue';
  -- 02:00 UTC tomorrow is still today (late evening) in New York.
  v_content := public.s94cp_content('S94C venue time', array['instagram'], (date_trunc('day', now() at time zone 'UTC') + interval '1 day 2 hours') at time zone 'UTC');
  v_snap := public.atlas_marketing_workspace_snapshot('00000000-0000-4000-8000-000000094c02'::uuid, 'manager',
    atlas_private.venue_date((date_trunc('day', now() at time zone 'UTC') + interval '1 day 2 hours') at time zone 'UTC'),
    atlas_private.venue_date((date_trunc('day', now() at time zone 'UTC') + interval '1 day 2 hours') at time zone 'UTC'));
  select exists (select 1 from jsonb_array_elements(v_snap -> 'content_items') i where i ->> 'id' = v_content::text) into v_found;
  perform public.s94cp_ok('52 venue time: snapshot date, range filter and occurrence functions use the venue zone, never a literal',
    (v_snap ->> 'venue_date')::date = v_ny and v_snap ->> 'venue_timezone' = 'America/New_York' and v_found
    and atlas_private.venue_date((date_trunc('day', now() at time zone 'UTC') + interval '1 day 2 hours') at time zone 'UTC')
        = (date_trunc('day', now() at time zone 'UTC'))::date
    and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where ((n.nspname = 'atlas_private' and p.proname like 'marketing%') or (n.nspname = 'public' and p.proname like 'atlas_marketing%'))
                      and p.prosrc like '%Atlantic/Reykjavik%')
    and pg_get_functiondef('atlas_private.marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text)'::regprocedure)
        like '%atlas_private.venue_date(pg_catalog.now())%');
  update atlas_private.settings_sections set settings_value = jsonb_set(settings_value, '{timezone}', '"Atlantic/Reykjavik"')
  where section_key = 'venue';
exception when others then
  perform public.s94cp_ok('zz section crashed: venue', false, sqlstate || ' ' || sqlerrm);
end
$venue$;

do $settings$
declare
  v_version integer; v_res jsonb; v_value jsonb;
begin
  perform public.s94cp_set_auto(false);
  select version, settings_value into v_version, v_value from atlas_private.settings_sections where section_key = 'marketing';
  v_res := public.atlas_settings_save_section('marketing', v_value || '{"automatic_publishing_enabled":true,"analytics_ingestion_enabled":true}',
    v_version, '00000000-0000-4000-8000-000000094c02', 'S94C Manager', 'manager');
  perform public.s94cp_ok('53 a manager cannot turn automatic publishing on; analytics stays off',
    v_res #> '{value,automatic_publishing_enabled}' = 'false'::jsonb and v_res #> '{value,analytics_ingestion_enabled}' = 'false'::jsonb);
  v_res := public.atlas_settings_save_section('marketing', v_value || '{"automatic_publishing_enabled":true}',
    (v_res ->> 'version')::integer, '00000000-0000-4000-8000-000000094c01', 'S94C Admin', 'admin');
  v_res := v_res || jsonb_build_object('manager_keeps', public.atlas_settings_save_section('marketing', v_value - 'automatic_publishing_enabled' || '{"brand_voice":"Warm"}',
    (v_res ->> 'version')::integer, '00000000-0000-4000-8000-000000094c02', 'S94C Manager', 'manager'));
  v_res := v_res || jsonb_build_object('manager_cannot_disable', public.atlas_settings_save_section('marketing', v_value || '{"automatic_publishing_enabled":false}',
    (v_res #>> '{manager_keeps,version}')::integer, '00000000-0000-4000-8000-000000094c02', 'S94C Manager', 'manager'));
  v_res := v_res || jsonb_build_object('admin_string', public.atlas_settings_save_section('marketing', v_value || '{"automatic_publishing_enabled":"yes"}',
    (v_res #>> '{manager_cannot_disable,version}')::integer, '00000000-0000-4000-8000-000000094c01', 'S94C Admin', 'admin'));
  perform public.s94cp_ok('54 an admin turns automatic publishing on; a manager save keeps it; only a boolean true counts',
    v_res #> '{value,automatic_publishing_enabled}' = 'true'::jsonb
    and v_res #> '{manager_keeps,value,automatic_publishing_enabled}' = 'true'::jsonb
    and v_res #> '{manager_cannot_disable,value,automatic_publishing_enabled}' = 'true'::jsonb
    and v_res #> '{admin_string,value,automatic_publishing_enabled}' = 'false'::jsonb
    and not atlas_private.marketing_automatic_publishing_enabled());
  perform public.s94cp_set_auto(true);
exception when others then
  perform public.s94cp_ok('zz section crashed: settings', false, sqlstate || ' ' || sqlerrm);
end
$settings$;

do $roles$
declare
  v_dj uuid := public.s94cp_id('dj');
  v_delivery uuid := (public.s94cp_live(public.s94cp_id('dj'), 'tiktok')).id;
  v_actor text;
  v_bad text := '';
  v_state text;
begin
  foreach v_actor in array array['00000000-0000-4000-8000-000000094c03','00000000-0000-4000-8000-000000094c04',
                                  '00000000-0000-4000-8000-000000094c05','00000000-0000-4000-8000-0000000099ff'] loop
    foreach v_state in array array[
      public.s94cp_expect(format('select public.atlas_marketing_publish_now(%L::uuid,%L::uuid)', v_actor, v_dj)),
      public.s94cp_expect(format('select public.atlas_marketing_delivery_manager_action(%L::uuid,%L::uuid,''retry'',''{}''::jsonb)', v_actor, v_delivery)),
      public.s94cp_expect(format('select public.atlas_marketing_content_cancel(%L::uuid,%L::uuid,null)', v_actor, v_dj)),
      public.s94cp_expect(format('select public.atlas_marketing_content_reschedule(%L::uuid,%L::uuid,1,now())', v_actor, v_dj)),
      public.s94cp_expect(format('select public.atlas_marketing_content_duplicate(%L::uuid,%L::uuid)', v_actor, v_dj)),
      public.s94cp_expect(format('select public.atlas_marketing_publication_history(%L::uuid,%L::uuid)', v_actor, v_dj))
    ] loop
      if v_state not like '42501%' then v_bad := v_bad || v_actor || ':' || left(v_state, 60) || '; '; end if;
    end loop;
  end loop;
  -- A bartender may not change publishing options through the partial update.
  v_state := public.s94cp_expect(format('select public.atlas_marketing_update_content(%L::uuid,%L::uuid,%s,''{"platform_options":{}}''::jsonb)',
    '00000000-0000-4000-8000-000000094c03', public.s94cp_id('edit'), (select version from atlas_private.marketing_content_items where id = public.s94cp_id('edit'))));
  if v_state not like '42501%' then v_bad := v_bad || 'bartender options:' || v_state; end if;
  perform public.s94cp_ok('55 bartender, viewer, inactive and unknown actors are refused (42501) on every publishing action', v_bad = '', nullif(v_bad, ''));
exception when others then
  perform public.s94cp_ok('zz section crashed: roles', false, sqlstate || ' ' || sqlerrm);
end
$roles$;

do $grants$
declare
  v_bad text := '';
  v_fn regprocedure;
  v_role text;
begin
  for v_fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('atlas_marketing_delivery_claim','atlas_marketing_delivery_heartbeat',
                'atlas_marketing_delivery_record_step','atlas_marketing_delivery_begin_submit','atlas_marketing_delivery_complete',
                'atlas_marketing_delivery_manager_action','atlas_marketing_publish_now','atlas_marketing_content_cancel',
                'atlas_marketing_content_reschedule','atlas_marketing_content_duplicate','atlas_marketing_publication_history',
                'atlas_marketing_update_content','atlas_marketing_create_content','atlas_push_notification_enqueue_many')
  loop
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      v_bad := v_bad || v_fn::text || '; ';
    end if;
    if v_fn::text not like '%create_content%' and v_fn::text not like '%enqueue_many%'
       and v_fn::oid <> to_regprocedure('public.atlas_marketing_update_content(uuid,uuid,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,text)')::oid then
      if not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
        v_bad := v_bad || 'not definer/pinned ' || v_fn::text || '; ';
      end if;
    end if;
  end loop;
  foreach v_role in array array['anon','authenticated'] loop
    if has_table_privilege(v_role, 'atlas_private.marketing_deliveries', 'select')
       or has_table_privilege(v_role, 'atlas_private.marketing_delivery_attempts', 'select')
       or has_table_privilege(v_role, 'atlas_private.marketing_provider_accounts', 'select') then
      v_bad := v_bad || v_role || ' reads deliveries; ';
    end if;
  end loop;
  if has_table_privilege('service_role', 'atlas_private.marketing_deliveries', 'update')
     or has_table_privilege('service_role', 'atlas_private.marketing_deliveries', 'insert')
     or has_table_privilege('service_role', 'atlas_private.marketing_delivery_attempts', 'update')
     or not has_table_privilege('service_role', 'atlas_private.marketing_deliveries', 'select') then
    v_bad := v_bad || 'service_role writes deliveries directly; ';
  end if;
  if has_function_privilege('service_role', 'atlas_private.marketing_publisher_tick(text)', 'execute')
     or has_function_privilege('authenticated', 'atlas_private.marketing_publisher_tick(text)', 'execute')
     or has_function_privilege('anon', 'atlas_private.marketing_publisher_tick(text)', 'execute') then
    v_bad := v_bad || 'tick executable by an API role; ';
  end if;
  if to_regprocedure('public.atlas_marketing_update_content(uuid,uuid,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,text)') is null then
    v_bad := v_bad || 'legacy update signature removed; ';
  end if;
  perform public.s94cp_ok('56 grants: every new RPC is service-role only, definer with pinned search_path; tables read-only for the service role; tick not callable by API roles',
    v_bad = '', nullif(v_bad, ''));
exception when others then
  perform public.s94cp_ok('zz section crashed: grants', false, sqlstate || ' ' || sqlerrm);
end
$grants$;

do $browser$
declare
  v_role text; v_state text; v_bad text := '';
begin
  foreach v_role in array array['authenticated','anon'] loop
    execute format('set local role %I', v_role);
    foreach v_state in array array[
      public.s94cp_expect('select public.atlas_marketing_delivery_claim(''x'', 1, 60)'),
      public.s94cp_expect('select public.atlas_marketing_publish_now(null, null)'),
      public.s94cp_expect('select count(*) from atlas_private.marketing_deliveries')
    ] loop
      if v_state not like '42501%' then v_bad := v_bad || v_role || ':' || left(v_state, 60) || '; '; end if;
    end loop;
    reset role;
  end loop;
  perform public.s94cp_ok('57 browser roles cannot claim, publish or read deliveries (42501)', v_bad = '', nullif(v_bad, ''));
exception when others then
  perform public.s94cp_ok('zz section crashed: browser', false, sqlstate || ' ' || sqlerrm);
end
$browser$;

do $tick$
begin
  perform public.s94cp_ok('58 the publisher tick returns null without pg_net/Vault (replay) and never raises',
    public.s94cp_expect('select atlas_private.marketing_publisher_tick(''preview'')') = 'ok'
    and atlas_private.marketing_publisher_tick('preview') is null);
exception when others then
  perform public.s94cp_ok('zz section crashed: tick', false, sqlstate || ' ' || sqlerrm);
end
$tick$;

do $notifications$
begin
  perform public.s94cp_ok('59 push queue accepts marketing_attention/marketing; other events and routes stay refused',
    public.s94cp_expect('select public.atlas_push_notification_enqueue_many(array[''00000000-0000-4000-8000-000000094c02''::uuid], ''marketing_attention'', ''t'', ''b'', ''marketing'', null)') = 'ok'
    and public.s94cp_expect('select public.atlas_push_notification_enqueue_many(array[''00000000-0000-4000-8000-000000094c02''::uuid], ''marketing_other'', ''t'', ''b'', ''marketing'', null)') like 'P0001%'
    and public.s94cp_expect('select public.atlas_push_notification_enqueue_many(array[''00000000-0000-4000-8000-000000094c02''::uuid], ''team_message'', ''t'', ''b'', ''elsewhere'', null)') like 'P0001%');
exception when others then
  perform public.s94cp_ok('zz section crashed: notifications', false, sqlstate || ' ' || sqlerrm);
end
$notifications$;

-- 8. Review fixes ----------------------------------------------------------------------------------

reset role;

do $review_asap$
declare
  v_mgr uuid := '00000000-0000-4000-8000-000000094c02';
  v_content uuid; v_other uuid; v_timed uuid; v_res jsonb; v_row atlas_private.marketing_deliveries; v_claim jsonb;
  v_fp_off jsonb; v_fp_on jsonb; v_version integer;
begin
  perform public.s94cp_park();
  perform public.s94cp_set_auto(false);
  v_content := public.s94cp_content('S94C asap', array['facebook'], null, 'Asap caption');
  select version into v_version from atlas_private.marketing_content_items where id = v_content;
  v_fp_off := atlas_private.marketing_content_fingerprint_payload(v_content);
  perform public.atlas_marketing_update_content(v_mgr, v_content, v_version, '{"publish_asap":true}'::jsonb);
  v_fp_on := atlas_private.marketing_content_fingerprint_payload(v_content);
  v_res := public.s94cp_approve(v_content);
  v_row := public.s94cp_live(v_content, 'facebook');
  perform public.s94cp_ok('66 P1-1 "as soon as it is approved": approval queues a delivery due now; auto off keeps it ready, not sent',
    (select metadata -> 'publish_asap' = 'true'::jsonb and scheduled_for is null and status = 'approved'
     from atlas_private.marketing_content_items where id = v_content)
    and v_fp_off -> 'publish_asap' = 'false'::jsonb and v_fp_on -> 'publish_asap' = 'true'::jsonb
    and jsonb_array_length(v_res -> 'deliveries') = 1
    and v_row.status = 'queued' and v_row.due_at = now() and v_row.next_attempt_at = now()
    and v_row.payload_snapshot -> 'publish_asap' = 'true'::jsonb
    and atlas_private.marketing_publication_state(v_content) = 'ready_not_sent'
    and public.atlas_marketing_delivery_claim('worker-asap', 10, 300) = '[]'::jsonb, v_row::text);
  perform public.s94cp_set_auto(true);
  v_claim := public.atlas_marketing_delivery_claim('worker-asap', 10, 300);
  perform public.s94cp_ok('67 P1-1 with automatic publishing on the asap delivery is claimed at once (no time needed)',
    jsonb_array_length(v_claim) = 1 and (v_claim -> 0 #>> '{delivery,id}')::uuid = v_row.id
    and v_claim -> 0 ->> 'claim_kind' = 'publish', v_claim::text);
  perform public.atlas_marketing_delivery_complete(v_row.id, (v_claim -> 0 ->> 'claim_token')::uuid,
    '{"status":"published","post_id":"123_456"}'::jsonb);

  -- Turning asap off after approval is material; a time always wins over asap.
  perform public.s94cp_set_auto(false);
  v_other := public.s94cp_content('S94C asap edit', array['facebook'], null, 'Asap caption 2');
  select version into v_version from atlas_private.marketing_content_items where id = v_other;
  perform public.atlas_marketing_update_content(v_mgr, v_other, v_version, '{"publish_asap":true}'::jsonb);
  perform public.s94cp_approve(v_other);
  select version into v_version from atlas_private.marketing_content_items where id = v_other;
  v_res := public.atlas_marketing_update_content(v_mgr, v_other, v_version, '{"publish_asap":false}'::jsonb);
  v_timed := public.s94cp_content('S94C asap timed', array['facebook'], now() + interval '2 days', 'Timed caption');
  update atlas_private.marketing_content_items set metadata = metadata || '{"publish_asap":true}' where id = v_timed;
  perform public.s94cp_approve(v_timed);
  perform public.s94cp_ok('68 P1-1 switching asap off after approval needs approval again; a planned time wins over asap',
    (v_res ->> 'approval_invalidated')::boolean
    and (select status = 'draft' and not (metadata ? 'publish_asap') from atlas_private.marketing_content_items where id = v_other)
    and (public.s94cp_delivery(v_other, 'facebook')).status = 'cancelled'
    and (public.s94cp_live(v_timed, 'facebook')).due_at = now() + interval '2 days'
    and public.s94cp_expect(format('select public.atlas_marketing_update_content(%L::uuid, %L::uuid, null, ''{"publish_asap":"yes"}''::jsonb)', v_mgr, v_other)) like '22023%');
exception when others then
  perform public.s94cp_ok('zz section crashed: review_asap', false, sqlstate || ' ' || sqlerrm);
end
$review_asap$;

do $review_media$
declare
  v_mgr uuid := '00000000-0000-4000-8000-000000094c02';
  v_png uuid := gen_random_uuid();
  v_copy uuid := gen_random_uuid();
  v_collection uuid;
  v_content uuid; v_row atlas_private.marketing_deliveries; v_snap jsonb; v_item jsonb; v_list jsonb;
begin
  perform public.s94cp_park();
  perform public.s94cp_set_auto(false);
  insert into atlas_private.marketing_media_assets (id, kind, status, storage_path, declared_mime, mime_type, declared_bytes,
    byte_size, sha256, width, height, verified_at, uploaded_by)
  values (v_png, 'image', 'ready', 'venues/main/2026/10/' || v_png || '/original.png', 'image/png', 'image/png', 500000, 500000,
    encode(pg_catalog.sha256('s94c-png'::bytea), 'hex'), 1080, 1350, now(), v_mgr);
  insert into atlas_private.marketing_media_variants (id, asset_id, purpose, aspect_ratio, status, storage_path, declared_mime, declared_bytes,
    mime_type, byte_size, width, height, sha256, verified_at, created_by)
  values (v_copy, v_png, 'publish', 'original', 'ready', 'venues/main/2026/10/' || v_png || '/v/' || v_copy || '.jpg', 'image/jpeg', 300000,
    'image/jpeg', 300000, 1080, 1350, encode(pg_catalog.sha256('s94c-png-copy'::bytea), 'hex'), now(), v_mgr);
  insert into atlas_private.marketing_media_collections (name, created_by) values ('S94C review collection', v_mgr) returning id into v_collection;
  v_content := public.s94cp_content('S94C png', array['instagram'], null, 'PNG caption');
  perform public.atlas_marketing_content_media_set(v_mgr, v_content,
    jsonb_build_array(jsonb_build_object('asset_id', v_png, 'collection_id', v_collection, 'role', 'cover')));
  perform public.s94cp_approve(v_content);
  -- No time and no asap: the approval queues nothing; the delivery is made due now here.
  v_list := atlas_private.marketing_content_media_list(v_content, 'instagram');
  perform atlas_private.marketing_deliveries_create_for_approval(v_content,
    (select approval_id from atlas_private.marketing_content_items where id = v_content), now(), 10);
  v_row := public.s94cp_live(v_content, 'instagram');
  perform public.s94cp_ok('69 P1-2 a PNG photo is published as its ready JPEG copy (payload, fingerprint; the attachment keeps variant null)',
    v_row.payload_snapshot #>> '{media,0,variant_id}' = v_copy::text
    and v_row.payload_snapshot #>> '{media,0,mime_type}' = 'image/jpeg'
    and v_row.payload_snapshot #>> '{media,0,storage_path}' like '%/v/' || v_copy || '.jpg'
    and v_list #>> '{0,variant_id}' is null and v_list #>> '{0,publish_variant_id}' = v_copy::text
    and atlas_private.marketing_content_fingerprint_payload(v_content) #>> '{media,0,variant_id}' = v_copy::text
    and atlas_private.marketing_media_asset_json(v_png, false) ->> 'publish_variant_id' = v_copy::text,
    coalesce(v_row.payload_snapshot::text, 'no delivery'));
  v_snap := public.atlas_marketing_workspace_snapshot(v_mgr, 'manager',
    (now() at time zone 'Atlantic/Reykjavik')::date, (now() at time zone 'Atlantic/Reykjavik')::date + 30);
  select item into v_item from jsonb_array_elements(v_snap -> 'content_items') item where item ->> 'id' = v_content::text;
  perform public.s94cp_ok('70 P3 snapshot media carries collection_id and publish_variant_id, so a re-save keeps provenance',
    v_item #>> '{media,0,collection_id}' = v_collection::text
    and v_item #>> '{media,0,publish_variant_id}' = v_copy::text
    and v_item #>> '{media,0,mime_type}' = 'image/jpeg'
    and not (v_item -> 'media' -> 0 ? 'storage_path'), left(coalesce(v_item::text, 'missing'), 300));
exception when others then
  perform public.s94cp_ok('zz section crashed: review_media', false, sqlstate || ' ' || sqlerrm);
end
$review_media$;

do $review_pin$
declare
  v_mgr uuid := '00000000-0000-4000-8000-000000094c02';
  v_asset uuid; v_content uuid; v_claim jsonb; v_ig uuid; v_token uuid; v_block_before jsonb; v_block jsonb; v_state text;
begin
  perform public.s94cp_park();
  v_asset := public.s94cp_asset('image', 9401);
  v_content := public.s94cp_content('S94C partial cancel', array['instagram','facebook'], now() + interval '1 hour', 'Partial caption');
  perform public.s94cp_attach(v_content, v_asset, 0);
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  perform public.s94cp_set_auto(true);
  v_claim := public.atlas_marketing_delivery_claim('worker-pin', 10, 300);
  select (c #>> '{delivery,id}')::uuid, (c ->> 'claim_token')::uuid into v_ig, v_token
  from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'instagram';
  perform public.atlas_marketing_delivery_complete(v_ig, v_token, '{"status":"published","post_id":"17999000940"}'::jsonb);
  -- Facebook: a transient failure before submit (waits to retry), then the post is cancelled.
  perform public.atlas_marketing_delivery_complete((c #>> '{delivery,id}')::uuid, (c ->> 'claim_token')::uuid,
    '{"status":"retrying","error":{"class":"transient","code":"http_500"}}'::jsonb)
  from jsonb_array_elements(v_claim) c where c #>> '{delivery,provider_key}' = 'facebook';
  v_block_before := atlas_private.marketing_media_delete_block(v_asset);
  perform public.atlas_marketing_content_cancel(v_mgr, v_content, 'Changed our mind');
  v_block := atlas_private.marketing_media_delete_block(v_asset);
  v_state := public.s94cp_expect(format('select public.atlas_marketing_media_lifecycle(%L::uuid, %L::uuid, ''delete'')', v_mgr, v_asset));
  perform public.s94cp_ok('71 P2 cancel after a partial publish: the published media stays pinned (delete and purge refused)',
    (select status from atlas_private.marketing_content_items where id = v_content) = 'cancelled'
    and (public.s94cp_delivery(v_content, 'instagram')).status = 'published'
    and (public.s94cp_delivery(v_content, 'facebook')).status = 'cancelled'
    and v_block_before ->> 'reason' = 'published'
    and v_block ->> 'reason' = 'published' and (v_block ->> 'count')::integer = 1
    and v_state like '22023%'
    and (select status = 'ready' from atlas_private.marketing_media_assets where id = v_asset),
    coalesce(v_block::text, 'no block') || ' / ' || v_state);
exception when others then
  perform public.s94cp_ok('zz section crashed: review_pin', false, sqlstate || ' ' || sqlerrm);
end
$review_pin$;

do $review_errors$
declare
  v_content uuid; v_claim jsonb; v_id uuid; v_token uuid; v_res jsonb; v_row atlas_private.marketing_deliveries;
  v_text text; v_steps text;
begin
  perform public.s94cp_park();
  v_text := atlas_private.marketing_sanitize_text('bad signature="abc" and ?token="" or &token= then access_token=x Bearer abc.def https://x.test/a?token=1 password: hunter2', 240);
  v_content := public.s94cp_content('S94C errors', array['instagram'], now() + interval '1 hour', 'Errors caption');
  perform public.s94cp_attach(v_content, public.s94cp_id('img1'), 0);
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  perform public.s94cp_set_auto(true);
  v_claim := public.atlas_marketing_delivery_claim('worker-err', 10, 300);
  v_id := (v_claim -> 0 #>> '{delivery,id}')::uuid;
  v_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  v_res := public.atlas_marketing_delivery_complete(v_id, v_token, jsonb_build_object('status', 'retrying',
    'error', jsonb_build_object('class', 'transient', 'code', 'http_500',
      'message', 'Upstream said signature="abc" ?token="" (x-request 42)')));
  select * into v_row from atlas_private.marketing_deliveries where id = v_id;
  select steps::text into v_steps from atlas_private.marketing_delivery_attempts where claim_token = v_token;
  perform public.s94cp_ok('72 P3-1/P3-2 sanitised text never violates the CHECKs; the browser sees fixed wording, the ledger keeps the provider text',
    v_text !~* '(access_token|refresh_token|client_secret|bearer [a-z0-9]|[?&]token=|signature=|X-Amz-|https?://|hunter2|abc\.def)'
    and atlas_private.marketing_sanitize_text('signature="x"', 240) !~* 'signature='
    and atlas_private.marketing_sanitize_text('?token=""', 240) !~* '[?&]token='
    and v_res ->> 'status' = 'retrying'
    and v_row.last_error_message = 'The platform could not be reached. Atlas will try again.'
    and v_row.last_error_code = 'http_500'
    and v_steps like '%x-request 42%' and v_steps !~* '(signature=|[?&]token=)',
    v_text || ' / ' || coalesce(v_res::text, '') || ' / ' || coalesce(v_row.last_error_message, ''));
  perform public.s94cp_ok('73 P3 Google ALERT posts are refused in SQL (the worker cannot publish them)',
    public.s94cp_expect($q$select atlas_private.marketing_validate_platform_options('{"google-business-profile":{"gbp":{"topic_type":"ALERT"}}}'::jsonb, array['google-business-profile'])$q$) like '22023%'
    and public.s94cp_expect($q$select atlas_private.marketing_validate_platform_options('{"google-business-profile":{"gbp":{"topic_type":"OFFER"}}}'::jsonb, array['google-business-profile'])$q$) = 'ok');
exception when others then
  perform public.s94cp_ok('zz section crashed: review_errors', false, sqlstate || ' ' || sqlerrm);
end
$review_errors$;

do $review_auth$
declare
  v_content uuid; v_claim jsonb; v_id uuid; v_token uuid; v_wrong jsonb; v_res jsonb; v_target jsonb; v_grants text := '';
begin
  perform public.s94cp_park();
  v_content := public.s94cp_content('S94C auth', array['facebook'], now() + interval '1 hour', 'Auth caption');
  perform public.s94cp_approve(v_content);
  perform public.s94cp_due(v_content);
  perform public.s94cp_set_auto(true);
  v_claim := public.atlas_marketing_delivery_claim('worker-auth', 10, 300);
  v_id := (v_claim -> 0 #>> '{delivery,id}')::uuid;
  v_token := (v_claim -> 0 ->> 'claim_token')::uuid;
  v_wrong := public.atlas_integration_mark_auth_failed(v_id, gen_random_uuid(), 'wrong claim');
  perform public.s94cp_ok('74 security P2-1 mark_auth_failed is fenced on the live claim (wrong token: lease_lost, nothing changes)',
    v_wrong = '{"ok": false, "lease_lost": true}'::jsonb
    and (select status from atlas_private.integration_connections where provider_key = 'facebook') = 'connected');
  v_res := public.atlas_integration_mark_auth_failed(v_id, v_token, 'Error validating access token: Session has expired access_token=EAAB123 https://provider.example.test/x');
  select t into v_target from jsonb_array_elements(public.atlas_integration_publish_targets()) t where t ->> 'provider_key' = 'facebook';
  select string_agg(r.rolname, ',' order by r.rolname) into v_grants
  from pg_catalog.pg_roles r
  where r.rolname in ('anon','authenticated','service_role','public')
    and has_function_privilege(r.oid, 'public.atlas_integration_mark_auth_failed(uuid, uuid, text)', 'execute');
  perform public.s94cp_ok('75 security P2-1 a provider auth failure marks the connection Needs reconnecting (sanitised event, service role only)',
    (v_res ->> 'ok')::boolean and v_res ->> 'connection_status' = 'expired'
    and (select status = 'expired' and authorization_state = 'expired' and last_connection_error !~* '(EAAB123|https?://)'
         from atlas_private.integration_connections where provider_key = 'facebook')
    and v_target ->> 'ready' = 'false' and v_target ->> 'reason' = 'needs_reauthorization'
    and exists (select 1 from atlas_private.integration_events where provider_key = 'facebook' and event_type = 'publish_auth_failed'
                and payload ->> 'delivery_id' = v_id::text and payload ->> 'error' !~* '(EAAB123|https?://)')
    and v_grants = 'service_role'
    and (select p.prosecdef and p.proconfig @> array['search_path=""']
         from pg_catalog.pg_proc p where p.oid = 'public.atlas_integration_mark_auth_failed(uuid, uuid, text)'::regprocedure),
    coalesce(v_res::text, '') || ' / ' || coalesce(v_grants, 'none'));
  perform public.atlas_marketing_delivery_complete(v_id, v_token,
    '{"status":"needs_attention","attention_reason":"auth_expired","error":{"class":"auth","code":"meta_190"}}'::jsonb);
  perform public.s94cp_ready('facebook', 'fb-s94c-1');
exception when others then
  perform public.s94cp_ok('zz section crashed: review_auth', false, sqlstate || ' ' || sqlerrm);
end
$review_auth$;

reset role;

select jsonb_build_object(
  's94c_publishing_preview', case when bool_and(passed) and count(*) = 75 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed)
    || case when passed then '{}'::jsonb else jsonb_build_object('detail', detail) end order by test_name)
) from s94c_results;

rollback;
