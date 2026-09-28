#!/usr/bin/env bash
# Atlas S92 Accounting production rollout, one stage at a time.
#
#   scripts/rollout_s92.sh check      read-only: S91 is in, S92 is pending, dependencies exist
#   scripts/rollout_s92.sh migration  20261001090000_s92_accounting_documents, one transaction
#   scripts/rollout_s92.sh function   deploy atlas-accounting
#   (then deploy the web app: merge the S92 PR so Netlify publishes main)
#
# Needs SUPABASE_DB_URL (migration/check) and SUPABASE_ACCESS_TOKEN (function).
# Never `supabase db push`. The migration is additive (new private tables,
# a private bucket and service-role-only RPCs); nothing existing changes, so
# the currently deployed web app and functions keep working before and after.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_REF="dnefgcmjcgxlynycxkts"
BASE="20261001090000_s92_accounting_documents"
FILE="$ROOT/supabase/migrations/$BASE.sql"

die() { echo "STOP: $*" >&2; exit 1; }
need_db() { [[ -n "${SUPABASE_DB_URL:-}" ]] || die "SUPABASE_DB_URL is not set."; }
q() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -qAt -c "$1"; }
applied() { q "select count(*) from supabase_migrations.schema_migrations where name = '${BASE#*_}'"; }

stage_check() {
  need_db
  [[ "$(q "select count(*) from supabase_migrations.schema_migrations where name = 's91_voice_lease_and_takeover'")" == "1" ]] \
    || die "S91 (s91_voice_lease_and_takeover) is not recorded yet. Finish the S91 rollout first."
  for dep in "atlas_private.venue_date(timestamp with time zone)" "private.purchase_order_total(jsonb)"; do
    [[ "$(q "select to_regprocedure('$dep') is not null")" == "t" ]] || die "missing dependency $dep"
  done
  [[ "$(q "select to_regclass('atlas_private.ai_settings') is not null")" == "t" ]] || die "missing atlas_private.ai_settings"
  if [[ "$(applied)" == "1" ]]; then echo "done     $BASE"; else echo "pending  $BASE"; fi
  echo "bucket atlas-accounting-documents exists: $(q "select exists(select 1 from storage.buckets where id = 'atlas-accounting-documents')")"
}

stage_migration() {
  need_db
  stage_check
  if [[ "$(applied)" == "1" ]]; then echo "skip   $BASE (already recorded)"; return; fi
  echo "apply  $BASE"
  {
    echo "begin;"
    cat "$FILE"
    echo
    printf "insert into supabase_migrations.schema_migrations (version, name, statements) values ('%s', '%s', array[]::text[]);\n" "${BASE%%_*}" "${BASE#*_}"
    echo "commit;"
  } | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -X -f - || die "$BASE failed; nothing from it was kept."
  echo "Done. Run the Supabase security and performance advisors now."
}

stage_function() {
  [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || die "SUPABASE_ACCESS_TOKEN is not set."
  cd "$ROOT"
  npx --yes supabase@latest functions deploy atlas-accounting --project-ref "$PROJECT_REF" || die "atlas-accounting failed to deploy."
}

case "${1:-}" in
  check) stage_check ;;
  migration) stage_migration ;;
  function) stage_function ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
