#!/usr/bin/env bash
# Proves the S106–S109 rollback (docs/release/sql/KANEL_S106_S109_rollback.sql) on a
# replayed database that is at S109. MUTATES the database (it rolls back), so run it
# last. Loopback databases only.
#   1. main's original staff-booking acceptance (pre-S106 rules) FAILS at S109 — the
#      check can tell the two states apart;
#   2. the rollback applies, and applies again (idempotent);
#   3. every object the release touched matches its exact S105 state
#      (scripts/release/kanel_pre_s106_expected.json): restored function bodies,
#      security, search_path and grants; release functions and trigger gone; queue
#      constraints back to S105;
#   4. main's original staff-booking acceptance PASSES again;
#   5. the reviewed production apply bundles (docs/release/sql/KANEL_apply_*.sql)
#      refuse to run out of order, then re-apply S106→S109 from the rolled-back
#      state, and refuse a second run;
#   6. the ledger verifier and the S106–S109 acceptances pass again.
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
: "${PGHOST:=127.0.0.1}"; : "${PGUSER:=postgres}"; : "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRE="$ROOT/scripts/release/fixtures/s99_bookings_pre_s106.sql"
RB="$ROOT/docs/release/sql/KANEL_S106_S109_rollback.sql"

if psql -X -v ON_ERROR_STOP=1 -q -f "$PRE" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — pre-S106 acceptance unexpectedly passed at S109" >&2; exit 1
fi
echo "step 1 ok: pre-S106 staff acceptance fails at S109 (expected)"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null
echo "step 2 ok: rollback applied twice (idempotent)"

psql -X -qAt -f "$ROOT/scripts/release/kanel_bookings_snapshot.sql" \
  | python3 -I "$ROOT/scripts/release/compare_kanel_expected.py" "$ROOT/scripts/release/kanel_pre_s106_expected.json" -
echo "step 3 ok: every touched object matches its S105 state"

out="$(psql -X -v ON_ERROR_STOP=1 -f "$PRE" 2>&1)" || { echo "$out" | tail -5; echo "kanel_bookings_rollback: FAILED — pre-S106 acceptance fails after rollback" >&2; exit 1; }
echo "step 4 ok: pre-S106 staff acceptance passes after rollback"

BUNDLES=("$ROOT"/docs/release/sql/KANEL_apply_[1-4]_*.sql)
[ "${#BUNDLES[@]}" -eq 4 ] || { echo "kanel_bookings_rollback: FAILED — expected 4 apply bundles" >&2; exit 1; }
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[1]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 2 ran before bundle 1" >&2; exit 1
fi
for bundle in "${BUNDLES[@]}"; do psql -X -v ON_ERROR_STOP=1 -q -f "$bundle" >/dev/null; done
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[3]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 4 ran twice" >&2; exit 1
fi
echo "step 5 ok: apply bundles refuse out-of-order and repeat runs; S106→S109 re-applied"

unset PGOPTIONS  # the acceptances report success via a NOTICE
bash "$ROOT/scripts/verify_migration_ledger.sh" | tail -1
for s in s106_bookings_engine s107_public_booking s108_booking_notifications s109_booking_notifications_inbox; do
  bash "$ROOT/scripts/verify_$s.sh" | grep -E ": passed$"
done
echo "step 6 ok: ledger and S106–S109 acceptances pass after re-apply"
echo "kanel_bookings_rollback: passed"
