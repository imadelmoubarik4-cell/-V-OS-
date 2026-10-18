#!/usr/bin/env bash
# REVIEWED S105 apply sequence — rehearsal against a disposable, loopback database.
#
# It deliberately does NOT run a directory-wide `supabase db push`: S104's schema
# is live in production but its ledger row (20261021090000) is missing, so a push
# would treat S104 as pending and replay it. Instead this performs the reviewed,
# explicit order the owner follows in production:
#   1. Backfill the S104 ledger row (idempotent) so S104 is never replayed.
#   2. Apply ONLY the S105 migration file.
#   3. Record the S105 ledger row (idempotent).
#   4. Verify the ledger (no pending migrations; S104 and S105 recorded).
#
# Loopback only. In production the owner runs the same four steps through the
# controlled write path; this script is the rehearsal + the exact statements.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S105_FILE="$ROOT/supabase/migrations/20261022090000_s105_team_member_deletion.sql"

echo "1. Backfill the S104 ledger row (idempotent — prevents an accidental replay)"
psql -X -v ON_ERROR_STOP=1 -c \
  "insert into supabase_migrations.schema_migrations(version,name,statements) \
   values ('20261021090000','s104_kanel_pricing',array[]::text[]) on conflict (version) do nothing"

echo "2. Apply ONLY the S105 migration (re-runnable)"
psql -X -v ON_ERROR_STOP=1 -f "$S105_FILE"

echo "3. Record the S105 ledger row (idempotent)"
psql -X -v ON_ERROR_STOP=1 -c \
  "insert into supabase_migrations.schema_migrations(version,name,statements) \
   values ('20261022090000','s105_team_member_deletion',array[]::text[]) on conflict (version) do nothing"

echo "4. Verify the ledger"
bash "$ROOT/scripts/verify_migration_ledger.sh"
echo "apply_s105_reviewed: completed"
