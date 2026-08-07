#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGPORT PGUSER PGDATABASE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
WORK_DIR="${RUNNER_TEMP:-/tmp}/vaos-migration-replay"
mkdir -p "$WORK_DIR"

cat > "$WORK_DIR/bootstrap.sql" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN SUPERUSER; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS graphql;
CREATE SCHEMA IF NOT EXISTS graphql_public;
CREATE SCHEMA IF NOT EXISTS pgbouncer;

-- Supabase installs pgcrypto in the extensions schema. Mirroring that layout
-- keeps schema-qualified migration calls replayable in a plain PostgreSQL CI
-- container and avoids a false failure caused by installing it in public.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS auth.instances(
  id uuid primary key default gen_random_uuid(),
  uuid uuid,
  raw_base_config text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
INSERT INTO auth.instances(id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM auth.instances);

CREATE TABLE IF NOT EXISTS auth.users(
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text,
  phone_confirmed_at timestamptz,
  phone_change text,
  phone_change_token varchar(255),
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz,
  email_change_token_current varchar(255),
  email_change_confirm_status smallint,
  banned_until timestamptz,
  reauthentication_token varchar(255),
  reauthentication_sent_at timestamptz,
  is_sso_user boolean default false,
  deleted_at timestamptz,
  is_anonymous boolean default false
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true),''), current_user::text);
$$;
CREATE OR REPLACE FUNCTION auth.email()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.email', true),'');
$$;
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb,'{}'::jsonb);
$$;

CREATE TABLE IF NOT EXISTS storage.buckets(
  id text primary key,
  name text unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  type text default 'STANDARD',
  owner_id text,
  avif_autodetection boolean default false
);
CREATE TABLE IF NOT EXISTS storage.objects(
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  path_tokens text[],
  version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  user_metadata jsonb
);
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(regexp_replace(name,'/[^/]*$',''),'/');
$$;
CREATE OR REPLACE FUNCTION storage.filename(name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(name,'^.*/','');
$$;
CREATE OR REPLACE FUNCTION storage.extension(name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(regexp_replace(name,'^.*\.',''),'');
$$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA auth, storage, extensions TO anon, authenticated, service_role;
GRANT SELECT ON auth.users, auth.instances TO service_role;
GRANT ALL ON storage.objects, storage.buckets TO service_role;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(
  version text primary key,
  statements text[],
  name text,
  inserted_at timestamptz default now()
);
SQL

psql -v ON_ERROR_STOP=1 -q -f "$WORK_DIR/bootstrap.sql"

mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No migrations found" >&2
  exit 1
fi

for migration in "${migrations[@]}"; do
  base="$(basename "$migration")"
  echo "Applying $base"
  psql -v ON_ERROR_STOP=1 -q -f "$migration"
  version="${base%%_*}"
  name="${base#*_}"
  name="${name%.sql}"
  psql -v ON_ERROR_STOP=1 -q -c \
    "insert into supabase_migrations.schema_migrations(version,name,statements) values ('$version','$name',array[]::text[]) on conflict (version) do nothing"
done

psql -v ON_ERROR_STOP=1 -qAt -f "$ROOT/scripts/verify_phase1_role_matrix_preview.sql" \
  > "$WORK_DIR/role-matrix.jsonl"
psql -v ON_ERROR_STOP=1 -qAt -f "$ROOT/scripts/verify_phase1_security_gate.sql" \
  > "$WORK_DIR/security-gate.jsonl"
psql -v ON_ERROR_STOP=1 -qAt -f "$ROOT/scripts/verify_phase2_foundation.sql" \
  > "$WORK_DIR/phase2-foundation.jsonl"

python - "$WORK_DIR" "${#migrations[@]}" <<'PY'
import json
import pathlib
import subprocess
import sys

work = pathlib.Path(sys.argv[1])
expected_migration_count = int(sys.argv[2])


def last_json(path: pathlib.Path) -> dict:
    values = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                values.append(json.loads(raw))
            except json.JSONDecodeError:
                pass
    if not values:
        raise AssertionError(f"No JSON result found in {path}")
    return values[-1]


role = last_json(work / "role-matrix.jsonl")
security = last_json(work / "security-gate.jsonl")
phase2 = last_json(work / "phase2-foundation.jsonl")

assert role.get("passed") is True, role
assert role.get("failed_count") == 0, role
assert role.get("passed_count", 0) >= 20, role

assert security.get("tables_without_rls") == [], security
assert security.get("unsafe_non_public_views") == [], security
assert security.get("browser_function_exposure") == [], security
assert security.get("security_lint_blockers") == [], security
assert security.get("public_menu", {}).get("public_menu_safe") is True, security
assert security.get("controlled_adjustment", {}).get("adjust_inventory_safe") is True, security

assert phase2.get("passed") is True, phase2
assert phase2.get("failed_count") == 0, phase2
assert phase2.get("passed_count", 0) >= 14, phase2
assert phase2.get("rolled_back") is True, phase2

query = """
select jsonb_build_object(
  'ledger_count',(select count(*) from supabase_migrations.schema_migrations),
  'settings_sections',to_regclass('atlas_private.settings_sections') is not null,
  'brain_snapshots',to_regclass('atlas_private.brain_intelligence_snapshots') is not null,
  'experimental_runs',to_regclass('atlas_private.intelligence_runs') is not null,
  'stock_count_summary',to_regclass('public.stock_count_summary') is not null,
  'item_master_drafts',to_regclass('atlas_private.item_master_drafts') is not null,
  'read_source_events',to_regclass('atlas_private.read_source_events') is not null,
  'pos_mapping_settings',to_regclass('atlas_private.pos_mapping_settings') is not null,
  'pos_mapping_events',to_regclass('atlas_private.pos_mapping_events') is not null,
  'auth_users',(select count(*) from auth.users where deleted_at is null),
  'profiles',(select count(*) from public.profiles),
  'inventory_items',(select count(*) from public.inventory_items),
  'inventory_movements',(select count(*) from public.inventory_movements),
  'pos_products',(select count(*) from atlas_private.pos_products),
  'pos_targets',(select count(*) from atlas_private.pos_mapping_targets)
)::text;
"""
state = json.loads(subprocess.check_output(["psql", "-qAt", "-c", query], text=True).strip())
assert state["ledger_count"] == expected_migration_count, state
assert state["settings_sections"] is True, state
assert state["brain_snapshots"] is True, state
assert state["experimental_runs"] is False, state
assert state["stock_count_summary"] is True, state
assert state["item_master_drafts"] is True, state
assert state["read_source_events"] is True, state
assert state["pos_mapping_settings"] is True, state
assert state["pos_mapping_events"] is True, state
assert state["auth_users"] == 0, state
assert state["profiles"] == 0, state
assert state["inventory_items"] == 0, state
assert state["inventory_movements"] == 0, state
assert state["pos_products"] == 0, state
assert state["pos_targets"] == 0, state

(work / "acceptance.json").write_text(
    json.dumps(
        {
            "role_matrix": role,
            "security_gate": security,
            "phase2_foundation": phase2,
            "state": state,
        },
        indent=2,
    ),
    encoding="utf-8",
)
print(json.dumps({"migration_replay": "passed", "migrations": expected_migration_count, **state}))
PY
