#!/usr/bin/env bash
# Proves the KANEL bookings rollbacks on a replayed database that is at S110
# (KANEL_S110_rollback.sql, then KANEL_S106_S109_rollback.sql). MUTATES the database
# (it rolls back), so run it last. Loopback databases only.
#   1. main's original staff-booking acceptance (pre-S106 rules) FAILS at S110 — the
#      check can tell the states apart;
#   2. the S106–S109 rollback REFUSES while S110 is recorded (S110 builds on S106);
#   3. the S110 rollback applies twice (idempotent) and every function S110 touched
#      matches its exact S109 state (scripts/release/kanel_pre_s110_expected.json);
#   4. the S106–S109 rollback applies twice and every touched object matches its exact
#      S105 state (kanel_pre_s106_expected.json); main's pre-S106 acceptance PASSES;
#   5. the reviewed apply bundles (docs/release/sql/KANEL_apply_*.sql) refuse to run
#      out of order, re-apply S106→S110 from the rolled-back state, and refuse a
#      repeat run;
#   6. the ledger verifier and the S106–S111 acceptances pass again.
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
: "${PGHOST:=127.0.0.1}"; : "${PGUSER:=postgres}"; : "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRE="$ROOT/scripts/release/fixtures/s99_bookings_pre_s106.sql"
RB="$ROOT/docs/release/sql/KANEL_S106_S109_rollback.sql"
RB110="$ROOT/docs/release/sql/KANEL_S110_rollback.sql"
RB111="$ROOT/docs/release/sql/KANEL_S111_rollback.sql"
SNAP="$ROOT/scripts/release/kanel_bookings_snapshot.sql"
CMP="$ROOT/scripts/release/compare_kanel_expected.py"

if psql -X -v ON_ERROR_STOP=1 -q -f "$PRE" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — pre-S106 acceptance unexpectedly passed at S110" >&2; exit 1
fi
echo "step 1 ok: pre-S106 staff acceptance fails at S110 (expected)"

if psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — the S106–S109 rollback ran while S110 is recorded" >&2; exit 1
fi
echo "step 2 ok: S106–S109 rollback refuses while S110 is recorded"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB111" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB111" >/dev/null
left="$(psql -X -tAc "select (select count(*) from pg_proc where proname = 'booking_purge_personal_data') + (select count(*) from pg_class where relname = 'booking_retention_runs') + (select count(*) from supabase_migrations.schema_migrations where version = '20261028090000')")"
[ "$left" = 0 ] || { echo "kanel_bookings_rollback: FAILED — S111 objects or ledger row left after its rollback" >&2; exit 1; }
echo "step 2b ok: S111 rollback applied twice; purge function, run log and ledger row gone"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB110" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB110" >/dev/null
psql -X -qAt -f "$SNAP" | python3 -I "$CMP" "$ROOT/scripts/release/kanel_pre_s110_expected.json" -
echo "step 3 ok: S110 rollback applied twice; S110-touched functions match S109"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null
psql -X -qAt -f "$SNAP" | python3 -I "$CMP" "$ROOT/scripts/release/kanel_pre_s106_expected.json" -
out="$(psql -X -v ON_ERROR_STOP=1 -f "$PRE" 2>&1)" || { echo "$out" | tail -5; echo "kanel_bookings_rollback: FAILED — pre-S106 acceptance fails after rollback" >&2; exit 1; }
echo "step 4 ok: S106–S109 rollback applied twice; S105 state restored; pre-S106 staff acceptance passes"

BUNDLES=("$ROOT"/docs/release/sql/KANEL_apply_[1-6]_*.sql)
[ "${#BUNDLES[@]}" -eq 6 ] || { echo "kanel_bookings_rollback: FAILED — expected 6 apply bundles" >&2; exit 1; }
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[1]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 2 ran before bundle 1" >&2; exit 1
fi
for bundle in "${BUNDLES[@]:0:4}"; do psql -X -v ON_ERROR_STOP=1 -q -f "$bundle" >/dev/null; done
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[3]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 4 ran twice" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[4]}" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[4]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 5 (S110) ran twice" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[5]}" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[5]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 6 (S111) ran twice" >&2; exit 1
fi
echo "step 5 ok: apply bundles refuse out-of-order and repeat runs; S106→S111 re-applied"

unset PGOPTIONS  # the acceptances report success via a NOTICE
bash "$ROOT/scripts/verify_migration_ledger.sh" | tail -1
for s in s106_bookings_engine s107_public_booking s108_booking_notifications s109_booking_notifications_inbox s110_booking_seat_integrity s111_booking_personal_data_retention; do
  bash "$ROOT/scripts/verify_$s.sh" | grep -E ": passed$"
done
echo "step 6 ok: ledger and S106–S111 acceptances pass after re-apply"
echo "kanel_bookings_rollback: passed"
