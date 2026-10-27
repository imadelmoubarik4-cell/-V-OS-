#!/usr/bin/env bash
# Proves the KANEL bookings rollbacks on a replayed database that is at S113
# (KANEL_S113_rollback.sql … KANEL_S106_S109_rollback.sql). MUTATES the database
# (it rolls back), so run it last. Loopback databases only.
#   1. main's original staff-booking acceptance (pre-S106 rules) FAILS at S110 — the
#      check can tell the states apart;
#   2. the S106–S109 rollback REFUSES while S110 is recorded (S110 builds on S106);
#      the S112 rollback refuses while S113 is recorded; the S113 rollback applies twice and
#      restores the S112 request RPC and outbox rule (scripts/release/kanel_pre_s113_expected.json);
#      the S111 rollback refuses while S112 is recorded; the S112 rollback applies twice,
#      restores every function S112 touched to its exact S111 state
#      (scripts/release/kanel_pre_s112_expected.json) and the pre-S112 stool numbering;
#      the S111 rollback applies twice; the S110b rollback refuses while S111 is
#      recorded, then applies twice and restores the S109 inbox RPC;
#   3. the S110 rollback applies twice (idempotent) and every function S110 touched
#      matches its exact S109 state (scripts/release/kanel_pre_s110_expected.json);
#   4. the S106–S109 rollback applies twice and every touched object matches its exact
#      S105 state (kanel_pre_s106_expected.json); main's pre-S106 acceptance PASSES;
#   5. the reviewed apply bundles (docs/release/sql/KANEL_apply_*.sql) refuse to run
#      out of order, re-apply S106→S113 from the rolled-back state, and refuse a
#      repeat run;
#   6. the ledger verifier and the S106–S113 acceptances pass again.
# Later releases are rolled back first and re-applied at the end with their own
# reviewed rollback and apply bundle (S114 staff access state), exactly as a
# production rollback of the bookings release would have to.
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
RB110B="$ROOT/docs/release/sql/KANEL_S110b_rollback.sql"
RB112="$ROOT/docs/release/sql/KANEL_S112_rollback.sql"
RB113="$ROOT/docs/release/sql/KANEL_S113_rollback.sql"
SNAP="$ROOT/scripts/release/kanel_bookings_snapshot.sql"
CMP="$ROOT/scripts/release/compare_kanel_expected.py"
RB114="$ROOT/docs/release/sql/S114_staff_access_state_rollback.sql"
APPLY114="$ROOT/docs/release/sql/S114_apply_staff_access_state.sql"

# Step 0: roll back the later release (S114) so the bookings rollbacks may run.
psql -X -v ON_ERROR_STOP=1 -q -f "$RB114" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB114" >/dev/null
echo "step 0 ok: S114 rolled back (twice, idempotent) before the bookings rollbacks"

if psql -X -v ON_ERROR_STOP=1 -q -f "$PRE" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — pre-S106 acceptance unexpectedly passed at S110" >&2; exit 1
fi
echo "step 1 ok: pre-S106 staff acceptance fails at S110 (expected)"

if psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — the S106–S109 rollback ran while S110 is recorded" >&2; exit 1
fi
echo "step 2 ok: S106–S109 rollback refuses while S110 is recorded"

if psql -X -v ON_ERROR_STOP=1 -q -f "$RB110B" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — the S110b rollback ran while S111 is recorded" >&2; exit 1
fi
if psql -X -v ON_ERROR_STOP=1 -q -f "$RB111" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — the S111 rollback ran while S112 is recorded" >&2; exit 1
fi
if psql -X -v ON_ERROR_STOP=1 -q -f "$RB112" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — the S112 rollback ran while S113 is recorded" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "$RB113" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB113" >/dev/null
psql -X -qAt -f "$SNAP" | python3 -I "$CMP" "$ROOT/scripts/release/kanel_pre_s113_expected.json" -
mail="$(psql -X -tAc "select (select count(*) from pg_constraint where conname = 'reservations_guest_language_check') || ':' || (select count(*) from supabase_migrations.schema_migrations where version = '20261030090000') || ':' || (select guest_email_enabled from atlas_private.booking_settings where id = true)")"
[ "$mail" = "0:0:false" ] || { echo "kanel_bookings_rollback: FAILED — S113 rollback did not restore the language rule/ledger/switch ($mail)" >&2; exit 1; }
echo "step 2 ok (S113): S112 rollback refused while S113 recorded; S113 rollback applied twice; S112 request RPC and outbox rule restored"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB112" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB112" >/dev/null
psql -X -qAt -f "$SNAP" | python3 -I "$CMP" "$ROOT/scripts/release/kanel_pre_s112_expected.json" -
stools="$(psql -X -tAc "select (select count(*) from atlas_private.booking_tables t where t.area_id = 'ba000000-0000-4000-8000-000000000001' and t.id = ('bb000000-0000-4000-8000-0000000000' || lpad(t.position_index::text, 2, '0'))::uuid and t.label = 'Bar ' || t.position_index and t.segment = case when t.position_index <= 8 then 'A' when t.position_index <= 12 then 'B' else 'C' end) || ':' || (select count(*) from supabase_migrations.schema_migrations where version = '20261029090000') || ':' || (select public_instant_confirm from atlas_private.booking_settings where id = true)")"
[ "$stools" = "16:0:false" ] || { echo "kanel_bookings_rollback: FAILED — S112 rollback did not restore the stools/ledger/switch ($stools)" >&2; exit 1; }
echo "step 2a ok: S111 rollback refused while S112 recorded; S112 rollback applied twice; S111 functions, stool numbering and switch restored"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB111" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB111" >/dev/null
left="$(psql -X -tAc "select (select count(*) from pg_proc where proname = 'booking_purge_personal_data') + (select count(*) from pg_class where relname = 'booking_retention_runs') + (select count(*) from supabase_migrations.schema_migrations where version = '20261028090000')")"
[ "$left" = 0 ] || { echo "kanel_bookings_rollback: FAILED — S111 objects or ledger row left after its rollback" >&2; exit 1; }
echo "step 2b ok: S111 rollback applied twice; purge function, run log and ledger row gone"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB110B" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB110B" >/dev/null
inbox="$(psql -X -tAc "select md5(pg_get_functiondef('public.atlas_bookings_notifications(uuid,text,integer)'::regprocedure)) || ':' || (select count(*) from supabase_migrations.schema_migrations where version = '20261027120000')")"
[ "$inbox" = "ad9b5f669b08363c5ce9c1b3ba934cf1:0" ] || { echo "kanel_bookings_rollback: FAILED — S110b rollback did not restore the S109 inbox RPC ($inbox)" >&2; exit 1; }
echo "step 2c ok: S110b rollback refused while S111 recorded, then applied twice; S109 inbox RPC restored"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB110" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB110" >/dev/null
psql -X -qAt -f "$SNAP" | python3 -I "$CMP" "$ROOT/scripts/release/kanel_pre_s110_expected.json" -
echo "step 3 ok: S110 rollback applied twice; S110-touched functions match S109"

psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -f "$RB" >/dev/null
psql -X -qAt -f "$SNAP" | python3 -I "$CMP" "$ROOT/scripts/release/kanel_pre_s106_expected.json" -
out="$(psql -X -v ON_ERROR_STOP=1 -f "$PRE" 2>&1)" || { echo "$out" | tail -5; echo "kanel_bookings_rollback: FAILED — pre-S106 acceptance fails after rollback" >&2; exit 1; }
echo "step 4 ok: S106–S109 rollback applied twice; S105 state restored; pre-S106 staff acceptance passes"

BUNDLES=("$ROOT"/docs/release/sql/KANEL_apply_[1-9]_*.sql)
[ "${#BUNDLES[@]}" -eq 9 ] || { echo "kanel_bookings_rollback: FAILED — expected 9 apply bundles" >&2; exit 1; }
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
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[6]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 7 (S111) ran before bundle 6 (S110b)" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[5]}" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[5]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 6 (S110b) ran twice" >&2; exit 1
fi
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[7]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 8 (S112) ran before bundle 7 (S111)" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[6]}" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[6]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 7 (S111) ran twice" >&2; exit 1
fi
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[8]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 9 (S113) ran before bundle 8 (S112)" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[7]}" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[7]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 8 (S112) ran twice" >&2; exit 1
fi
psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[8]}" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "${BUNDLES[8]}" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — apply bundle 9 (S113) ran twice" >&2; exit 1
fi
echo "step 5 ok: apply bundles refuse out-of-order and repeat runs; S106→S113 re-applied"
psql -X -v ON_ERROR_STOP=1 -q -f "$APPLY114" >/dev/null
if psql -X -v ON_ERROR_STOP=1 -q -f "$APPLY114" >/dev/null 2>&1; then
  echo "kanel_bookings_rollback: FAILED — the S114 apply bundle ran twice" >&2; exit 1
fi
echo "step 5b ok: S114 re-applied from its reviewed bundle; a repeat run is refused"

unset PGOPTIONS  # the acceptances report success via a NOTICE
bash "$ROOT/scripts/verify_migration_ledger.sh" | tail -1
for s in s106_bookings_engine s107_public_booking s108_booking_notifications s109_booking_notifications_inbox s110_booking_seat_integrity s110b_booking_inbox_visit_time s111_booking_personal_data_retention s112_public_direct_booking s113_booking_guest_email; do
  bash "$ROOT/scripts/verify_$s.sh" | grep -E ": passed$"
done
echo "step 6 ok: ledger and S106–S113 acceptances pass after re-apply"
echo "kanel_bookings_rollback: passed"
