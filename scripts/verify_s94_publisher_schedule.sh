#!/usr/bin/env bash
# Local proof for scripts/s94_publisher_schedule_install.sql / _uninstall.sql.
#
# LOCAL ONLY (refuses a non-loopback PGHOST). Needs a local PostgreSQL with the
# real pg_cron extension preloaded and cron.database_name pointing at the test
# database (default s94_cron):
#   shared_preload_libraries = 'pg_cron'
#   cron.database_name = 's94_cron'
#   cron.use_background_workers = on   (jobs run without a password-protected libpq login)
# pg_net and Supabase Vault only exist on Supabase, so this harness installs a
# minimal local pg_net stand-in (net.http_post records the call in a table and
# sends nothing) and a plain vault.decrypted_secrets view. pg_cron is real.
#
# Proves: missing secrets refuse the install and create no job; the install
# creates exactly one every-minute job; re-running it (sequentially and from
# two concurrent sessions) keeps exactly one job with the same jobid; a second
# job calling the tick makes the install refuse; with Automatic publishing off
# a queued post that is due is never sent to the worker (including by a real
# pg_cron run); with it on the tick wakes the worker; the kill switch removes
# the job and is safe to repeat.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=s94_cron}"
export PGHOST PGPORT PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$ROOT/scripts/s94_publisher_schedule_install.sql"
UNINSTALL="$ROOT/scripts/s94_publisher_schedule_uninstall.sql"
q() { psql -X -v ON_ERROR_STOP=1 -Atq "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

[ "$(q -d postgres -c "show cron.database_name" 2>/dev/null || true)" = "$PGDATABASE" ] \
  || fail "pg_cron must be preloaded with cron.database_name = '$PGDATABASE'"

# Local pg_net stand-in (installed into the local server's extension dir once).
SHAREDIR="$(pg_config --sharedir)/extension"
if [ ! -f "$SHAREDIR/pg_net.control" ]; then
  cat > "$SHAREDIR/pg_net.control" <<'EOF'
comment = 'LOCAL TEST STAND-IN for Supabase pg_net: records http_post calls, sends nothing'
default_version = '0.0.1'
relocatable = false
schema = net
EOF
  cat > "$SHAREDIR/pg_net--0.0.1.sql" <<'EOF'
create table net.test_requests (id bigserial primary key, url text, body jsonb, headers jsonb, created_at timestamptz default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$
  insert into net.test_requests (url, body, headers) values (url, body, headers) returning id;
$$;
EOF
fi

# Fresh replay of every migration.
# pg_cron keeps a launcher session on its database: force it off for the fresh replay.
q -d postgres -c "drop database if exists $PGDATABASE with (force)" -c "create database $PGDATABASE"
bash "$ROOT/scripts/verify_full_migration_replay.sh" >/dev/null 2>&1 || fail "migration replay failed"
pass "full migration replay into $PGDATABASE"

# Vault stand-in: an empty secrets view (the replay creates the vault schema).
q -c "create table if not exists vault.test_secrets (name text, decrypted_secret text);
      create or replace view vault.decrypted_secrets as select name, decrypted_secret from vault.test_secrets;"

# 0 when pg_cron is not installed yet (a refused install rolls back its create extension too).
jobs() {
  if [ "$(q -c "select to_regclass('cron.job') is null")" = "t" ]; then echo 0; return; fi
  q -c "select count(*) from cron.job where command ilike '%marketing_publisher_tick%'"
}
requests() { q -c "select count(*) from net.test_requests"; }

# 1. Missing secrets: the install refuses and leaves no job behind.
if psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null 2>"$ROOT/.s94-schedule.err"; then fail "install succeeded without Vault secrets"; fi
grep -q "atlas_project_url" "$ROOT/.s94-schedule.err" || fail "unexpected error: $(cat "$ROOT/.s94-schedule.err")"
[ "$(jobs)" = "0" ] || fail "a job was created despite the refusal"
[ "$(q -c "select count(*) from pg_extension where extname in ('pg_cron','pg_net')")" = "0" ] || fail "a refused install left extensions enabled"
pass "missing Vault secrets refuse the install; nothing changed (no job, no extension)"

# 2. Malformed secrets are refused too (checked, never printed).
q -c "insert into vault.test_secrets values ('atlas_project_url', 'https://example.org/path'), ('atlas_marketing_publisher_secret', 'short')"
if psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null 2>"$ROOT/.s94-schedule.err"; then fail "install accepted a malformed URL"; fi
grep -q "must be the project URL" "$ROOT/.s94-schedule.err" || fail "unexpected error: $(cat "$ROOT/.s94-schedule.err")"
if grep -q "example.org" "$ROOT/.s94-schedule.err"; then fail "the error printed the secret value"; fi
q -c "update vault.test_secrets set decrypted_secret = 'https://abcdefghijklmnop.supabase.co' where name = 'atlas_project_url'"
if psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null 2>"$ROOT/.s94-schedule.err"; then fail "install accepted a short publisher secret"; fi
grep -q "at least 32 characters" "$ROOT/.s94-schedule.err" || fail "unexpected error: $(cat "$ROOT/.s94-schedule.err")"
[ "$(jobs)" = "0" ] || fail "a job was created despite the refusal"
pass "malformed secrets refused without printing them; no job created"

# 3. First install: exactly one every-minute job with the reviewed command.
q -c "update vault.test_secrets set decrypted_secret = repeat('s', 48) where name = 'atlas_marketing_publisher_secret'"
psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null
[ "$(jobs)" = "1" ] || fail "expected one job after install"
DEF="$(q -c "select jobname||'|'||schedule||'|'||command||'|'||active from cron.job where jobname = 'atlas-marketing-publisher-tick'")"
[ "$DEF" = "atlas-marketing-publisher-tick|* * * * *|select atlas_private.marketing_publisher_tick('cron');|true" ] || fail "unexpected job: $DEF"
JOBID="$(q -c "select jobid from cron.job where jobname = 'atlas-marketing-publisher-tick'")"
q -c "select extname from pg_extension where extname in ('pg_cron','pg_net') order by 1" | tr '\n' ' ' | grep -q "pg_cron pg_net" || fail "extensions not enabled"
pass "install enables pg_cron + pg_net and creates exactly one job ($DEF)"

# 4. Re-runs: sequential and concurrent, still one job with the same jobid.
psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null & A=$!
psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null & B=$!
psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null & C=$!
wait $A; wait $B; wait $C
[ "$(jobs)" = "1" ] || fail "re-runs created duplicates: $(jobs) jobs"
[ "$(q -c "select jobid from cron.job where jobname = 'atlas-marketing-publisher-tick'")" = "$JOBID" ] || fail "jobid changed on re-run"
pass "2 sequential + 3 concurrent re-runs keep exactly one job (jobid $JOBID)"

# 5. A second job that calls the tick makes the install refuse.
q -c "select cron.schedule('rogue-publisher-tick', '*/5 * * * *', \$\$select atlas_private.marketing_publisher_tick('rogue');\$\$)" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "$INSTALL" >/dev/null 2>"$ROOT/.s94-schedule.err"; then fail "install ignored another tick job"; fi
grep -q "other cron job" "$ROOT/.s94-schedule.err" || fail "unexpected error: $(cat "$ROOT/.s94-schedule.err")"
q -c "select cron.unschedule('rogue-publisher-tick')" >/dev/null
[ "$(jobs)" = "1" ] || fail "job count changed"
pass "a second job calling the tick is refused"

# 6. Automatic publishing OFF: a queued post that is due is never sent to the worker.
q -c "set session_replication_role = replica;
      insert into atlas_private.marketing_deliveries
        (content_id, provider_key, external_account_id, target_kind, approval_id, approved_fingerprint,
         payload_snapshot, status, due_at, next_attempt_at, latest_acceptable_at)
      values (gen_random_uuid(), 'instagram', 'ig-test', 'ig_feed', gen_random_uuid(), sha256('s94-schedule-test'::bytea),
              '{}'::jsonb, 'queued', now() - interval '1 minute', now() - interval '1 minute', now() + interval '6 hours');"
[ "$(q -c "select atlas_private.marketing_automatic_publishing_enabled()")" = "f" ] || fail "automatic publishing is not off by default"
[ -z "$(q -c "select atlas_private.marketing_publisher_tick('test')")" ] || fail "tick returned a request id with automatic publishing off"
[ "$(requests)" = "0" ] || fail "the worker was called with automatic publishing off"
# A real pg_cron run (the job fires at the next minute boundary).
BEFORE="$(q -c "select count(*) from cron.job_run_details where jobid = $JOBID")"
for _ in $(seq 1 90); do
  [ "$(q -c "select count(*) from cron.job_run_details where jobid = $JOBID and status in ('succeeded','failed')")" -gt "$BEFORE" ] && break
  sleep 1
done
RUN="$(q -c "select status from cron.job_run_details where jobid = $JOBID order by runid desc limit 1")"
[ "$RUN" = "succeeded" ] || fail "the cron run did not succeed (status: ${RUN:-none})"
[ "$(requests)" = "0" ] || fail "a real cron run sent the post with automatic publishing off"
pass "automatic publishing off: due queued post not sent (direct tick and a real pg_cron run: $RUN)"

# 7. Automatic publishing ON: the tick wakes the worker (to the Vault URL, with the secret header).
q -c "update atlas_private.settings_sections set settings_value = settings_value || '{\"automatic_publishing_enabled\": true}'::jsonb where section_key = 'marketing'"
[ "$(q -c "select atlas_private.marketing_automatic_publishing_enabled()")" = "t" ] || fail "could not turn automatic publishing on"
[ -n "$(q -c "select atlas_private.marketing_publisher_tick('test')")" ] || fail "tick did not wake the worker with automatic publishing on"
[ "$(q -c "select url from net.test_requests order by id desc limit 1")" = "https://abcdefghijklmnop.supabase.co/functions/v1/atlas-marketing-publisher?action=tick" ] || fail "unexpected worker URL"
[ "$(q -c "select (headers ? 'x-atlas-publisher-secret')::text from net.test_requests order by id desc limit 1")" = "true" ] || fail "secret header missing"
pass "automatic publishing on: the tick wakes atlas-marketing-publisher with the secret header"

# 8. Kill switch: removes the job; safe to repeat.
psql -X -v ON_ERROR_STOP=1 -q -f "$UNINSTALL" >/dev/null
[ "$(jobs)" = "0" ] || fail "kill switch left a job"
psql -X -v ON_ERROR_STOP=1 -q -f "$UNINSTALL" >/dev/null
[ "$(jobs)" = "0" ] || fail "second kill switch run failed"
pass "kill switch removes the job and is safe to repeat"

rm -f "$ROOT/.s94-schedule.err"
echo '{"s94_publisher_schedule": "passed"}'
