#!/usr/bin/env bash
# Atlas S87–S90 production rollout, one stage at a time, in the approved order.
#
#   scripts/rollout_s87_s90.sh check       read-only: ledger, pending files, secrets hint
#   scripts/rollout_s87_s90.sh migrations  batch A (30 files), each in its own transaction
#   scripts/rollout_s87_s90.sh functions   deploy the Edge Functions (config.toml JWT settings)
#   (deploy the web app: merge PR #91 so Netlify publishes main, then smoke test)
#   scripts/rollout_s87_s90.sh revokes     the two release-gated item revokes, AFTER the web deploy
#
# Needs:
#   SUPABASE_DB_URL        postgres connection string for the production database
#   SUPABASE_ACCESS_TOKEN  for `supabase functions deploy` (functions stage only)
#   psql, and npx (Supabase CLI) for the functions stage.
# Never `supabase db push` for this release: it would run the revokes early and
# replay 20260924170000 (already applied on production as 20260924150124).
# Every stage stops at the first error. Each migration is applied and recorded in
# supabase_migrations.schema_migrations in one transaction, so a failed file
# leaves nothing half-applied and the stage can be re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_REF="dnefgcmjcgxlynycxkts"
MIGRATIONS="$ROOT/supabase/migrations"
LAST_APPLIED_NAME="s86_1_reports_safe_package_parser"

BATCH_A=(
  20260925090000_s87_recipe_delete_guard
  20260925091000_s87_atlas_media_manager_writes
  20260925092000_s87_drop_duplicate_inventory_name_index
  20260925093000_s87_inventory_delete_guard
  20260926080000_s88_drop_dead_intelligence_begin_run
  20260926090000_s88_venue_clock
  20260926091000_s88_shared_daily_checklists
  20260926092000_s88_inventory_item_activation
  20260926093000_s88_purchase_order_receiving_approval
  20260926094000_s88_data_review_and_par_levels
  20260926095000_s88_integrations_oauth
  20260926100000_s88_ai_private_tables
  20260926101000_s88_ai_conversation_rpcs
  20260926102000_s88_ai_actions_and_brain
  20260926103000_s88_knowledge_search
  20260926104000_s88_ai_media_bucket
  20260926105000_s88_ai_signals
  20260926106000_s88_ai_hardening
  20260927090000_s89_visual_inventory_foundation
  20260927091000_s89_catalog_governance
  20260927092000_s89_stock_count_add_line
  20260927093000_s89_data_review_catalog_issues
  20260927094000_s89_recognition_service
  20260928090000_s89_canonical_report_truth
  20260928093000_s89_item_change_audit
  20260928094000_s89_stock_count_add_line_actor
  20260929090000_s90_stock_adjust_idempotency
  20260929092000_s90f_ai_update_draft_order_kind
  20260930090000_s90g_item_master_update_definer
  20260930091000_s90h_duplicate_pairs_performance
)
REVOKES=(
  20260927099000_s89_revoke_direct_item_insert
  20260928095000_s89_revoke_direct_item_update
)
FUNCTIONS=(
  atlas-ai atlas-integrations atlas-inventory-recognition
  atlas-item-master atlas-stock-counts atlas-settings atlas-team-profiles
  atlas-team-messages atlas-team-profile-photos atlas-reports atlas-knowledge
  atlas-notifications atlas-shifts atlas-system atlas-marketing-workspace
  atlas-sprint3-review atlas-phase3-brain atlas-phase3-intelligence
  atlas-operations-checkpoint-a atlas-inventory-scanner atlas-sprint4-briefing
)

die() { echo "STOP: $*" >&2; exit 1; }
need_db() { [[ -n "${SUPABASE_DB_URL:-}" ]] || die "SUPABASE_DB_URL is not set."; }
q() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -qAt -c "$1"; }

# Names already recorded on production (the hosted ledger uses its own version
# timestamps, so files are matched by name, never by version).
applied_names() { q "select name from supabase_migrations.schema_migrations order by version"; }
is_applied() { local name="${1#*_}"; applied_names | grep -qx "$name"; }

apply_file() {
  local base="$1" file="$MIGRATIONS/$1.sql" version="${1%%_*}" name="${1#*_}"
  [[ -f "$file" ]] || die "missing $file"
  if is_applied "$base"; then echo "skip   $base (already recorded)"; return; fi
  echo "apply  $base"
  {
    echo "begin;"
    cat "$file"
    echo
    printf "insert into supabase_migrations.schema_migrations (version, name, statements) values ('%s', '%s', array[]::text[]);\n" "$version" "$name"
    echo "commit;"
  } | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -X -f - || die "$base failed; nothing from it was kept. Fix and re-run this stage."
}

stage_check() {
  need_db
  echo "Last recorded migrations on production:"; q "select version || '  ' || name from supabase_migrations.schema_migrations order by version desc limit 3"
  applied_names | grep -qx "$LAST_APPLIED_NAME" || die "expected $LAST_APPLIED_NAME in the ledger."
  local pending=0
  for base in "${BATCH_A[@]}" "${REVOKES[@]}"; do
    if is_applied "$base"; then echo "done     $base"; else echo "pending  $base"; pending=$((pending + 1)); fi
  done
  echo "$pending pending."
  echo "pg_trgm installed: $(q "select exists(select 1 from pg_extension where extname = 'pg_trgm')") (stays off unless approved separately)"
}

stage_migrations() {
  need_db
  for base in "${BATCH_A[@]}"; do apply_file "$base"; done
  echo "Batch A done. Run the Supabase security and performance advisors now."
}

stage_functions() {
  [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || die "SUPABASE_ACCESS_TOKEN is not set."
  cd "$ROOT"
  for fn in "${FUNCTIONS[@]}"; do
    echo "deploy $fn"
    npx --yes supabase@latest functions deploy "$fn" --project-ref "$PROJECT_REF" || die "$fn failed to deploy; earlier functions are live."
  done
}

stage_revokes() {
  need_db
  [[ "${WEB_DEPLOYED_AND_SMOKE_TESTED:-}" == "yes" ]] || die "set WEB_DEPLOYED_AND_SMOKE_TESTED=yes only after the new web app is live and the smoke test passed."
  for base in "${BATCH_A[@]}"; do is_applied "$base" || die "$base is not applied yet."; done
  for base in "${REVOKES[@]}"; do apply_file "$base"; done
  echo "Revokes done. Re-test adding and editing an item."
}

case "${1:-}" in
  check) stage_check ;;
  migrations) stage_migrations ;;
  functions) stage_functions ;;
  revokes) stage_revokes ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
