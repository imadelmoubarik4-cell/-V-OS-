#!/usr/bin/env bash
# Runs the S90 workflow-integrity preview-only acceptance against a replayed
# database: idempotent waste / delivery-without-an-order adjustments
# (adjust_inventory_v2 request ids, replay, refusals, grants) and count
# verification baselines at counted_at (a delivery between count and
# "Verify anyway" is not erased), and (S91) the live voice lease, heartbeat
# and same-user device handoff. Each script seeds fixtures inside one
# transaction, prints a JSON verdict and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0
for script in \
  verify_s90_workflow_integrity_preview.sql \
  verify_s90f_ai_update_draft_preview.sql \
  verify_s90g_item_master_definer_preview.sql \
  verify_s90h_duplicate_pairs_performance_preview.sql \
  verify_s91_voice_preview.sql \
  verify_s93_messages_sender_identity_preview.sql; do
  result="$(psql -X -v ON_ERROR_STOP=1 -At -f "$ROOT/scripts/$script" | grep '^{"tests' | tail -1)"
  echo "$script: $result"
  if ! grep -q '": "passed"' <<<"$result"; then status=1; fi
done
exit "$status"
