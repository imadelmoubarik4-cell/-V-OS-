#!/usr/bin/env bash
# Builds the local S94 Media end-to-end backend: a fresh database replayed from
# supabase/migrations, the real Supabase Storage API (file backend) and
# PostgREST, both in Docker on the host network. See README.md for the order
# and why it matters. Loopback only.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ANON_KEY="$(node "$E2E_DIR/jwt.mjs" anon)"
SERVICE_KEY="$(node "$E2E_DIR/jwt.mjs" service_role)"

"$E2E_DIR/teardown.sh" >/dev/null 2>&1 || true

echo "1/6 fresh database $E2E_DB"
psql -X -q -d postgres -c "drop database if exists $E2E_DB with (force)"
psql -X -q -d postgres -c "create database $E2E_DB"

echo "2/6 Supabase-compatible roles and schemas (replay bootstrap only)"
PGDATABASE="$E2E_DB" ATLAS_BOOTSTRAP_ONLY=1 RUNNER_TEMP="$E2E_WORK" "$REPO_ROOT/scripts/verify_full_migration_replay.sh" >/dev/null
# The bootstrap creates a minimal stand-in storage schema. The real Storage API
# owns that schema and migrates it itself, so the stand-in goes first.
psql -X -q -d "$E2E_DB" -c "drop schema storage cascade; create schema storage; grant usage on schema storage to anon, authenticated, service_role"

echo "3/6 Storage API (runs its own storage migrations)"
rm -rf "$E2E_WORK/storage-data" && mkdir -p "$E2E_WORK/storage-data"
docker run -d --name s94e2e-storage --network host \
  -e SERVER_PORT="$E2E_STORAGE_PORT" -e SERVER_HOST=127.0.0.1 \
  -e ANON_KEY="$ANON_KEY" -e SERVICE_KEY="$SERVICE_KEY" \
  -e AUTH_JWT_SECRET="$E2E_JWT_SECRET" -e PGRST_JWT_SECRET="$E2E_JWT_SECRET" \
  -e DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@127.0.0.1:$PGPORT/$E2E_DB" \
  -e DB_INSTALL_ROLES=false -e DB_SUPER_USER="$PGUSER" \
  -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
  -e TENANT_ID=stub -e REGION=local -e GLOBAL_S3_BUCKET=stub \
  -e FILE_SIZE_LIMIT=1073741824 -e UPLOAD_FILE_SIZE_LIMIT=1073741824 \
  -e ENABLE_IMAGE_TRANSFORMATION=false \
  -e TUS_URL_PATH=/storage/v1/upload/resumable \
  -v "$E2E_WORK/storage-data:/var/lib/storage" \
  "$E2E_STORAGE_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$E2E_STORAGE_PORT/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$E2E_STORAGE_PORT/status" >/dev/null || { docker logs s94e2e-storage | tail -40; exit 1; }

echo "4/6 full migration replay on top of the real storage schema"
PGDATABASE="$E2E_DB" RUNNER_TEMP="$E2E_WORK" "$REPO_ROOT/scripts/verify_full_migration_replay.sh" | tail -1

echo "5/6 harness-only fixes and seed"
# The replay bootstrap's auth.uid()/auth.role() read the pre-v10 PostgREST
# settings only. Hosted Supabase reads request.jwt.claims too; PostgREST 12
# sets only that one. Same definitions as the hosted auth schema.
psql -X -q -v ON_ERROR_STOP=1 -d "$E2E_DB" <<'SQL'
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $$;
grant usage on schema auth to anon, authenticated, service_role;
SQL
psql -X -q -v ON_ERROR_STOP=1 -d "$E2E_DB" -f "$E2E_DIR/seed.sql"

echo "6/6 PostgREST"
docker run -d --name s94e2e-postgrest --network host \
  -e PGRST_DB_URI="postgres://$PGUSER:$PGPASSWORD@127.0.0.1:$PGPORT/$E2E_DB" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$E2E_JWT_SECRET" -e PGRST_SERVER_PORT="$E2E_POSTGREST_PORT" -e PGRST_SERVER_HOST=127.0.0.1 \
  -e PGRST_DB_POOL=10 \
  "$E2E_POSTGREST_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$E2E_POSTGREST_PORT/" -H "authorization: Bearer $SERVICE_KEY" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$E2E_POSTGREST_PORT/" -H "authorization: Bearer $SERVICE_KEY" || { docker logs s94e2e-postgrest | tail -40; exit 1; }

psql -X -qAt -d "$E2E_DB" -c "select 'bucket '||id||' public='||public||' limit='||file_size_limit from storage.buckets where id='atlas-marketing-media'"
psql -X -qAt -d "$E2E_DB" -c "select 'storage migrations applied: '||count(*) from storage.migrations"
echo "backend ready: PostgREST :$E2E_POSTGREST_PORT, Storage :$E2E_STORAGE_PORT (start the proxy with: node $E2E_DIR/stack.mjs)"
