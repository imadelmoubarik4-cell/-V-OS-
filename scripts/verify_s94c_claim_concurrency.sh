#!/usr/bin/env bash
# S94C concurrency proof for the Marketing delivery claim (report 07 §8.2, report 09 §2).
#
# Runs on a throw-away copy of a replayed database that already has the s94a, s94b and s94c
# migrations (createdb -T "$SOURCE_DB"), with committed fixtures, because dblink sessions cannot
# see a preview's uncommitted rows. Proves with real concurrent sessions:
#   1. held-lock interleave: session A claims and keeps its transaction open; session B claims at
#      the same time without blocking (lock_timeout 2s) and gets disjoint rows;
#   2. true race: 4 dblink sessions (and pgbench, when installed) claim and complete until the
#      queue is empty: every delivery published exactly once, one attempt per delivery, zero
#      double claims;
#   3. lease recovery and fencing: A's lease expires, B recovers and republishes nothing twice;
#      A's late record_step/complete get lease_lost and change nothing.
# Prints one JSON verdict ({"s94c_claim_concurrency": "passed"|"failed", ...}); exits non-zero on
# failure. Loopback databases only; the scratch database is always dropped.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
: "${SOURCE_DB:=$PGDATABASE}"
: "${S94C_CONCURRENCY_CONTENTS:=100}"
export PGHOST PGPORT PGUSER
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

SCRATCH_DB="s94c_concurrency_$$"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/s94c-concurrency.XXXXXX")"
cleanup() {
  psql -X -q -d postgres -c "drop database if exists $SCRATCH_DB with (force)" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

createdb -T "$SOURCE_DB" "$SCRATCH_DB"
export PGDATABASE="$SCRATCH_DB"

if ! psql -X -qAt -c "select 1 from pg_available_extensions where name = 'dblink'" | grep -q 1; then
  echo '{"s94c_claim_concurrency": "failed", "reason": "dblink extension is not available"}'
  exit 1
fi
if [[ -z "$(psql -X -qAt -c "select to_regprocedure('public.atlas_marketing_delivery_claim(text,integer,integer)')")" ]]; then
  echo '{"s94c_claim_concurrency": "failed", "reason": "source database has no s94c migration"}'
  exit 1
fi

CONNINFO="host=$PGHOST port=$PGPORT dbname=$SCRATCH_DB user=$PGUSER"
if [[ -n "${PGPASSWORD:-}" ]]; then CONNINFO="$CONNINFO password=$PGPASSWORD"; fi

# ---------------------------------------------------------------------------------------------
# Committed fixtures: people, ready providers, automatic publishing on, N approved posts on
# Instagram + Facebook (2N deliveries), all due now. Account caps raised so the Atlas safety cap
# does not stop the race.
# ---------------------------------------------------------------------------------------------
psql -X -v ON_ERROR_STOP=1 -q -v contents="$S94C_CONCURRENCY_CONTENTS" <<'SQL'
select set_config('s94cc.contents', :'contents', false) \g /dev/null
create extension if not exists dblink;
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{}'::jsonb,'{}'::jsonb,now(),now()
from (values ('00000000-0000-4000-8000-0000000c0c01'::uuid,'s94cc-admin@example.invalid'),
             ('00000000-0000-4000-8000-0000000c0c02'::uuid,'s94cc-mgr@example.invalid')) v(id,email);
update public.profiles set role='admin', active=true, display_name='S94CC Admin' where id='00000000-0000-4000-8000-0000000c0c01';
update public.profiles set role='manager', active=true, display_name='S94CC Manager' where id='00000000-0000-4000-8000-0000000c0c02';

do $ready$
declare
  v_provider text;
  v_kind text;
begin
  foreach v_provider in array array['instagram','facebook'] loop
    v_kind := case v_provider when 'instagram' then 'instagram_account' else 'facebook_page' end;
    update atlas_private.integration_connections
    set status = 'connected', authorization_state = 'authorized', publishing_permission_state = 'granted',
        external_account_id = 'cc-' || v_provider, connected_at = now()
    where provider_key = v_provider;
    if exists (select 1 from information_schema.columns where table_schema = 'atlas_private'
               and table_name = 'integration_connections' and column_name = 'publishing_review_state') then
      execute 'update atlas_private.integration_connections set publishing_review_state = ''approved'' where provider_key = $1' using v_provider;
    end if;
    execute 'insert into atlas_private.integration_resources (provider_key, resource_kind, resource_id, label, selected)
             values ($1, $2, $3, $4, true) on conflict (provider_key, resource_kind, resource_id) do update set selected = true'
      using v_provider, v_kind, 'cc-' || v_provider, 'S94CC ' || v_provider;
    update atlas_private.integration_connections set last_verified_at = now() where provider_key = v_provider;
    if to_regclass('atlas_private.integration_credentials') is not null then
      execute 'insert into atlas_private.integration_credentials (provider_key, credential_kind, ciphertext, nonce, key_version)
               values ($1, ''oauth_token_set'', decode(repeat(''00'', 32), ''hex''), decode(repeat(''00'', 12), ''hex''), 1)
               on conflict (provider_key) do nothing' using v_provider;
    end if;
    if to_regclass('atlas_private.integration_resource_credentials') is not null then
      execute 'insert into atlas_private.integration_resource_credentials (provider_key, resource_kind, resource_id, ciphertext, nonce, key_version)
               values ($1, $2, $3, decode(repeat(''00'', 32), ''hex''), decode(repeat(''00'', 12), ''hex''), 1)
               on conflict do nothing' using v_provider, v_kind, 'cc-' || v_provider;
    end if;
    insert into atlas_private.marketing_provider_accounts (provider_key, external_account_id, daily_publish_cap, atlas_daily_cap)
    values (v_provider, 'cc-' || v_provider, 1000, 1000)
    on conflict (provider_key, external_account_id) do update set daily_publish_cap = 1000, atlas_daily_cap = 1000, cooldown_until = null;
  end loop;
end
$ready$;

update atlas_private.settings_sections
set settings_value = jsonb_set(settings_value, '{automatic_publishing_enabled}', 'true'::jsonb)
where section_key = 'marketing';

-- One shared image; one content item per pair of deliveries.
do $seed$
declare
  v_asset uuid := gen_random_uuid();
  v_content uuid;
  i integer;
begin
  insert into atlas_private.marketing_media_assets (id, kind, status, storage_path, declared_mime, mime_type, declared_bytes, byte_size,
    sha256, width, height, verified_at, uploaded_by)
  values (v_asset, 'image', 'ready', 'venues/main/2026/10/' || v_asset || '/original.jpg', 'image/jpeg', 'image/jpeg', 120000, 120000,
    encode(sha256('s94cc'::bytea), 'hex'), 1080, 1350, now(), '00000000-0000-4000-8000-0000000c0c02');
  for i in 1..current_setting('s94cc.contents')::integer loop
    v_content := (public.atlas_marketing_create_content(gen_random_uuid(), null, 'S94CC post ' || i, 'post', 'normal',
      array['instagram','facebook'], now() + interval '1 day', null, null, null, null, 'Caption ' || i, null, '[]'::jsonb, '{}'::jsonb,
      null, null, '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager', '{}'::jsonb) ->> 'id')::uuid;
    insert into atlas_private.marketing_content_media (content_id, asset_id, position, role, added_by)
    values (v_content, v_asset, 0, 'primary', '00000000-0000-4000-8000-0000000c0c02');
    perform public.atlas_marketing_submit_approval(v_content, null, '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager');
    perform public.atlas_marketing_decide_approval(v_content, 'approved', null, '00000000-0000-4000-8000-0000000c0c01', 'S94CC Admin', 'admin');
  end loop;
  update atlas_private.marketing_deliveries
  set due_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute', latest_acceptable_at = now() + interval '6 hours'
  where status = 'queued';
end
$seed$;

-- A worker loop that commits after every claim/complete, as the Edge worker does.
create or replace procedure public.s94cc_worker(p_worker text, p_batch integer)
language plpgsql
as $$
declare
  v_claims jsonb;
  v_claim jsonb;
  v_empty integer := 0;
  v_result jsonb;
begin
  loop
    v_claims := public.atlas_marketing_delivery_claim(p_worker, p_batch, 300);
    if jsonb_array_length(v_claims) = 0 then
      v_empty := v_empty + 1;
      exit when v_empty >= 3;
      commit;
      perform pg_sleep(0.02);
      continue;
    end if;
    v_empty := 0;
    commit;
    for v_claim in select value from jsonb_array_elements(v_claims) loop
      v_result := public.atlas_marketing_delivery_begin_submit((v_claim #>> '{delivery,id}')::uuid, (v_claim ->> 'claim_token')::uuid);
      if coalesce((v_result ->> 'ok')::boolean, false) then
        perform public.atlas_marketing_delivery_complete((v_claim #>> '{delivery,id}')::uuid, (v_claim ->> 'claim_token')::uuid,
          jsonb_build_object('status', 'published', 'post_id', 'cc_' || replace(v_claim #>> '{delivery,id}', '-', '')));
      end if;
      commit;
    end loop;
  end loop;
end;
$$;
SQL

# ---------------------------------------------------------------------------------------------
# 1. Held-lock interleave, 2. dblink race, 3. lease recovery and fencing
# ---------------------------------------------------------------------------------------------
psql -X -v ON_ERROR_STOP=1 -qAt -v conninfo="$CONNINFO" > "$WORK_DIR/dblink.json" <<'SQL'
\set QUIET on
create temporary table cc_results (test_name text primary key, passed boolean not null, detail jsonb);

-- 1. Held-lock interleave -------------------------------------------------------------------------
select dblink_connect('a', :'conninfo');
select dblink_connect('b', :'conninfo');
select dblink_exec('a', 'begin');
create temporary table claim_a as
  select * from dblink('a', $q$select (x #>> '{delivery,id}')::uuid, (x ->> 'claim_token')::uuid
                          from jsonb_array_elements(public.atlas_marketing_delivery_claim('worker-a', 4, 300)) x$q$)
  as t(id uuid, token uuid);
select dblink_exec('b', 'set lock_timeout = ''2s''');
select dblink_exec('b', 'begin');
create temporary table claim_b as
  select * from dblink('b', $q$select (x #>> '{delivery,id}')::uuid, (x ->> 'claim_token')::uuid
                          from jsonb_array_elements(public.atlas_marketing_delivery_claim('worker-b', 4, 300)) x$q$)
  as t(id uuid, token uuid);
select dblink_exec('a', 'commit');
select dblink_exec('b', 'commit');
insert into cc_results
select 'held_lock_interleave_disjoint',
  (select count(*) from claim_a) = 4 and (select count(*) from claim_b) = 4
  and not exists (select 1 from claim_a join claim_b using (id))
  and (select count(distinct token) from (select token from claim_a union all select token from claim_b) t) = 8
  and (select count(*) from atlas_private.marketing_deliveries where id in (select id from claim_a union select id from claim_b)
       and status = 'publishing' and claim_token is not null) = 8,
  jsonb_build_object('a', (select count(*) from claim_a), 'b', (select count(*) from claim_b),
                     'overlap', (select count(*) from claim_a join claim_b using (id)));
-- Finish the 8 held claims so the race starts from a clean queue.
select count(public.atlas_marketing_delivery_begin_submit(id, token)) from (select * from claim_a union all select * from claim_b) c;
select count(public.atlas_marketing_delivery_complete(id, token, jsonb_build_object('status','published','post_id','cc_' || replace(id::text,'-',''))))
from (select * from claim_a union all select * from claim_b) c;

-- 2. True race: 4 sessions drain the queue concurrently ----------------------------------------------
select dblink_connect('c', :'conninfo');
select dblink_connect('d', :'conninfo');
select dblink_send_query('a', 'call public.s94cc_worker(''race-a'', 4)');
select dblink_send_query('b', 'call public.s94cc_worker(''race-b'', 4)');
select dblink_send_query('c', 'call public.s94cc_worker(''race-c'', 4)');
select dblink_send_query('d', 'call public.s94cc_worker(''race-d'', 4)');
-- Wait for all four (each needs one extra call to release the connection).
select count(*) from dblink_get_result('a', false) as t(r text);
select count(*) from dblink_get_result('a', false) as t(r text);
select count(*) from dblink_get_result('b', false) as t(r text);
select count(*) from dblink_get_result('b', false) as t(r text);
select count(*) from dblink_get_result('c', false) as t(r text);
select count(*) from dblink_get_result('c', false) as t(r text);
select count(*) from dblink_get_result('d', false) as t(r text);
select count(*) from dblink_get_result('d', false) as t(r text);
insert into cc_results
select 'race_workers_finished_without_error',
  (select bool_and(coalesce(dblink_error_message(c), 'OK') = 'OK') from unnest(array['a','b','c','d']) c),
  (select jsonb_object_agg(c, dblink_error_message(c)) from unnest(array['a','b','c','d']) c);
insert into cc_results
select 'race_every_delivery_published_once',
  (select count(*) from atlas_private.marketing_deliveries where status <> 'published') = 0
  and (select count(*) from atlas_private.marketing_delivery_attempts where outcome = 'published')
      = (select count(*) from atlas_private.marketing_deliveries)
  and (select count(distinct delivery_id) from atlas_private.marketing_delivery_attempts where outcome = 'published')
      = (select count(*) from atlas_private.marketing_deliveries)
  and not exists (select delivery_id from atlas_private.marketing_delivery_attempts group by delivery_id having count(*) > 1)
  and (select count(distinct claimed_by) from atlas_private.marketing_delivery_attempts where claimed_by like 'race-%') >= 2
  and (select count(*) from atlas_private.marketing_content_items where title like 'S94CC post %' and status <> 'published') = 0,
  jsonb_build_object(
    'deliveries', (select count(*) from atlas_private.marketing_deliveries),
    'published', (select count(*) from atlas_private.marketing_deliveries where status = 'published'),
    'attempts', (select count(*) from atlas_private.marketing_delivery_attempts),
    'double_claimed', (select count(*) from (select delivery_id from atlas_private.marketing_delivery_attempts group by delivery_id having count(*) > 1) x),
    'per_worker', (select jsonb_object_agg(claimed_by, n) from (select claimed_by, count(*) n from atlas_private.marketing_delivery_attempts group by claimed_by) w));

-- 3. Lease recovery and fencing ------------------------------------------------------------------------
do $lease_seed$
declare v_content uuid;
begin
  v_content := (public.atlas_marketing_create_content(gen_random_uuid(), null, 'S94CC lease', 'post', 'normal', array['facebook'],
    now() + interval '1 day', null, null, null, null, 'Lease', null, '[]'::jsonb, '{}'::jsonb, null, null,
    '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager', '{}'::jsonb) ->> 'id')::uuid;
  perform public.atlas_marketing_submit_approval(v_content, null, '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager');
  perform public.atlas_marketing_decide_approval(v_content, 'approved', null, '00000000-0000-4000-8000-0000000c0c01', 'S94CC Admin', 'admin');
  update atlas_private.marketing_deliveries set due_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute',
    latest_acceptable_at = now() + interval '6 hours' where content_id = v_content;
end
$lease_seed$;
create temporary table lease_a as
  select * from dblink('a', $q$select (x #>> '{delivery,id}')::uuid, (x ->> 'claim_token')::uuid
                          from jsonb_array_elements(public.atlas_marketing_delivery_claim('lease-a', 1, 30)) x$q$) as t(id uuid, token uuid);
-- Worker A stalls: its lease runs out (committed, visible to every session).
update atlas_private.marketing_deliveries set claimed_until = clock_timestamp() - interval '1 second' where id = (select id from lease_a);
create temporary table lease_b as
  select * from dblink('b', $q$select (x #>> '{delivery,id}')::uuid, (x ->> 'claim_token')::uuid
                          from jsonb_array_elements(public.atlas_marketing_delivery_claim('lease-b', 1, 300)) x$q$) as t(id uuid, token uuid);
create temporary table lease_late as
  select * from dblink('a', format($q$select public.atlas_marketing_delivery_record_step(%L::uuid, %L::uuid, 'media_ready', '{}'::jsonb, '{"step":"late"}'::jsonb),
                                         public.atlas_marketing_delivery_begin_submit(%L::uuid, %L::uuid),
                                         public.atlas_marketing_delivery_complete(%L::uuid, %L::uuid, '{"status":"published","post_id":"late_a"}'::jsonb)$q$,
                                   (select id from lease_a), (select token from lease_a), (select id from lease_a), (select token from lease_a),
                                   (select id from lease_a), (select token from lease_a)))
  as t(step jsonb, submit jsonb, complete jsonb);
create temporary table lease_b_done as
  select * from dblink('b', format($q$select public.atlas_marketing_delivery_begin_submit(%L::uuid, %L::uuid),
                                         public.atlas_marketing_delivery_complete(%L::uuid, %L::uuid, '{"status":"published","post_id":"lease_b_post"}'::jsonb)$q$,
                                   (select id from lease_b), (select token from lease_b), (select id from lease_b), (select token from lease_b)))
  as t(submit jsonb, complete jsonb);
insert into cc_results
select 'lease_recovery_and_fencing',
  (select count(*) from lease_a) = 1 and (select id from lease_a) = (select id from lease_b)
  and (select token from lease_a) <> (select token from lease_b)
  and (select step ->> 'lease_lost' = 'true' and submit ->> 'lease_lost' = 'true' and complete ->> 'lease_lost' = 'true' from lease_late)
  and (select complete ->> 'status' = 'published' from lease_b_done)
  and (select status = 'published' and provider_post_id = 'lease_b_post' and attempt_count = 2
       from atlas_private.marketing_deliveries where id = (select id from lease_a))
  and (select outcome from atlas_private.marketing_delivery_attempts where claim_token = (select token from lease_a)) = 'lease_lost'
  and (select outcome from atlas_private.marketing_delivery_attempts where claim_token = (select token from lease_b)) = 'published',
  jsonb_build_object('late', (select to_jsonb(lease_late) from lease_late), 'b', (select to_jsonb(lease_b_done) from lease_b_done));

-- Recovery after the submit marker goes to verifying (never a blind republish).
do $lease_seed2$
declare v_content uuid;
begin
  v_content := (public.atlas_marketing_create_content(gen_random_uuid(), null, 'S94CC lease 2', 'post', 'normal', array['facebook'],
    now() + interval '1 day', null, null, null, null, 'Lease 2', null, '[]'::jsonb, '{}'::jsonb, null, null,
    '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager', '{}'::jsonb) ->> 'id')::uuid;
  perform public.atlas_marketing_submit_approval(v_content, null, '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager');
  perform public.atlas_marketing_decide_approval(v_content, 'approved', null, '00000000-0000-4000-8000-0000000c0c01', 'S94CC Admin', 'admin');
  update atlas_private.marketing_deliveries set due_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute',
    latest_acceptable_at = now() + interval '6 hours' where content_id = v_content;
end
$lease_seed2$;
create temporary table lease2_a as
  select * from dblink('a', $q$select (x #>> '{delivery,id}')::uuid, (x ->> 'claim_token')::uuid
                          from jsonb_array_elements(public.atlas_marketing_delivery_claim('lease2-a', 1, 30)) x$q$) as t(id uuid, token uuid);
select * from dblink('a', format('select public.atlas_marketing_delivery_begin_submit(%L::uuid, %L::uuid)::text',
                                 (select id from lease2_a), (select token from lease2_a))) as t(r text);
update atlas_private.marketing_deliveries set claimed_until = clock_timestamp() - interval '1 second' where id = (select id from lease2_a);
create temporary table lease2_b as
  select * from dblink('b', $q$select x ->> 'claim_kind', (x #>> '{delivery,id}')::uuid, x #>> '{delivery,status}'
                          from jsonb_array_elements(public.atlas_marketing_delivery_claim('lease2-b', 1, 300)) x$q$) as t(kind text, id uuid, status text);
insert into cc_results
select 'recovery_after_submit_marker_is_verify_only',
  (select kind = 'verify' and status = 'verifying' and id = (select id from lease2_a) from lease2_b)
  and (select attempt_count from atlas_private.marketing_deliveries where id = (select id from lease2_a)) = 1,
  (select to_jsonb(lease2_b) from lease2_b);

select dblink_disconnect('a');
select dblink_disconnect('b');
select dblink_disconnect('c');
select dblink_disconnect('d');

\set QUIET off
select jsonb_build_object('dblink_tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed, 'detail', detail) order by test_name))
from cc_results;
SQL

# ---------------------------------------------------------------------------------------------
# 4. pgbench stress (optional): 8 clients claim/complete a fresh batch concurrently.
# ---------------------------------------------------------------------------------------------
PGBENCH_JSON='{"skipped": true}'
if command -v pgbench >/dev/null 2>&1; then
  psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
do $seed_bench$
declare
  v_asset uuid := (select id from atlas_private.marketing_media_assets order by created_at limit 1);
  v_content uuid;
  i integer;
begin
  for i in 1..150 loop
    v_content := (public.atlas_marketing_create_content(gen_random_uuid(), null, 'S94CC bench ' || i, 'post', 'normal',
      array['instagram','facebook'], now() + interval '1 day', null, null, null, null, 'Bench ' || i, null, '[]'::jsonb, '{}'::jsonb,
      null, null, '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager', '{}'::jsonb) ->> 'id')::uuid;
    insert into atlas_private.marketing_content_media (content_id, asset_id, position, role, added_by)
    values (v_content, v_asset, 0, 'primary', '00000000-0000-4000-8000-0000000c0c02');
    perform public.atlas_marketing_submit_approval(v_content, null, '00000000-0000-4000-8000-0000000c0c02', 'S94CC Manager', 'manager');
    perform public.atlas_marketing_decide_approval(v_content, 'approved', null, '00000000-0000-4000-8000-0000000c0c01', 'S94CC Admin', 'admin');
  end loop;
  update atlas_private.marketing_deliveries set due_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute',
    latest_acceptable_at = now() + interval '6 hours' where status = 'queued';
end
$seed_bench$;
create or replace function public.s94cc_bench_step(p_worker text)
returns integer
language plpgsql
as $$
declare
  v_claim jsonb;
  v_count integer := 0;
begin
  for v_claim in select value from jsonb_array_elements(public.atlas_marketing_delivery_claim(p_worker, 2, 300)) loop
    if (public.atlas_marketing_delivery_begin_submit((v_claim #>> '{delivery,id}')::uuid, (v_claim ->> 'claim_token')::uuid) ->> 'ok')::boolean then
      perform public.atlas_marketing_delivery_complete((v_claim #>> '{delivery,id}')::uuid, (v_claim ->> 'claim_token')::uuid,
        jsonb_build_object('status', 'published', 'post_id', 'bench_' || replace(v_claim #>> '{delivery,id}', '-', '')));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
SQL
  printf "select public.s94cc_bench_step('pgbench-' || :client_id);\n" > "$WORK_DIR/bench.sql"
  pgbench -n -c 8 -j 4 -T 8 -f "$WORK_DIR/bench.sql" "$SCRATCH_DB" > "$WORK_DIR/pgbench.log" 2>&1 || true
  # Drain whatever is left (a pgbench run may end mid-queue), single worker.
  psql -X -q -c "call public.s94cc_worker('drain', 10)" >/dev/null
  PGBENCH_JSON="$(psql -X -qAt <<'SQL'
create temporary view bench_deliveries as
  select d.* from atlas_private.marketing_deliveries d
  join atlas_private.marketing_content_items c on c.id = d.content_id where c.title like 'S94CC bench %';
select jsonb_build_object(
  'passed', (select count(*) from bench_deliveries where status <> 'published') = 0
    and (select count(*) from bench_deliveries) = 300
    and not exists (select delivery_id from atlas_private.marketing_delivery_attempts
                    where delivery_id in (select id from bench_deliveries) group by delivery_id having count(*) > 1)
    and (select count(*) from atlas_private.marketing_delivery_attempts where outcome = 'published' and delivery_id in (select id from bench_deliveries)) = 300
    and (select count(*) from atlas_private.marketing_delivery_attempts where claimed_by like 'pgbench-%') > 0,
  'deliveries', (select count(*) from atlas_private.marketing_deliveries where content_id in
                  (select id from atlas_private.marketing_content_items where title like 'S94CC bench %')),
  'pgbench_attempts', (select count(*) from atlas_private.marketing_delivery_attempts where claimed_by like 'pgbench-%'),
  'drain_attempts', (select count(*) from atlas_private.marketing_delivery_attempts where claimed_by = 'drain'),
  'pgbench_clients', (select count(distinct claimed_by) from atlas_private.marketing_delivery_attempts where claimed_by like 'pgbench-%'),
  'double_claimed', (select count(*) from (select delivery_id from atlas_private.marketing_delivery_attempts
                      where delivery_id in (select id from bench_deliveries) group by delivery_id having count(*) > 1) x),
  'double_published', (select count(*) from (select delivery_id from atlas_private.marketing_delivery_attempts where outcome = 'published'
                        group by delivery_id having count(*) > 1) x));
SQL
)"
  PGBENCH_JSON="$(python3 -c '
import json, re, sys
d = json.loads(sys.argv[1])
m = re.search(r"number of transactions actually processed: (\d+)", open(sys.argv[2]).read())
d["pgbench_transactions"] = int(m.group(1)) if m else None
print(json.dumps(d))' "$PGBENCH_JSON" "$WORK_DIR/pgbench.log")"
  if grep -qiE "deadlock|aborted|ERROR" "$WORK_DIR/pgbench.log"; then
    PGBENCH_JSON="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["passed"]=False; d["deadlock"]=True; print(json.dumps(d))' "$PGBENCH_JSON")"
  fi
fi

python3 - "$WORK_DIR/dblink.json" "$PGBENCH_JSON" <<'PY'
import json, sys
dblink = None
for raw in open(sys.argv[1], encoding="utf-8").read().splitlines():
    raw = raw.strip()
    if raw.startswith("{") and raw.endswith("}"):
        dblink = json.loads(raw)
bench = json.loads(sys.argv[2])
tests = (dblink or {}).get("dblink_tests") or []
passed = len(tests) == 5 and all(t["passed"] for t in tests) and (bench.get("skipped") or bench.get("passed") is True)
verdict = {
    "s94c_claim_concurrency": "passed" if passed else "failed",
    "dblink": tests,
    "pgbench": bench,
}
print(json.dumps(verdict, sort_keys=True))
sys.exit(0 if passed else 1)
PY
