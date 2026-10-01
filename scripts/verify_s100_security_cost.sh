#!/usr/bin/env bash
# Runs the S100 security & cost hardening acceptance against a replayed database:
# the new AI cost/throttle/block RPCs and the block-event trail are service_role-only
# and append-only, no p_actor_* RPC is browser-callable, and recipe price/flag changes
# are audited by a sealed append-only DEFINER trigger that only managers can trigger
# (anon/inactive/viewer/bartender cannot change recipe prices). The companion read-only
# lint in scripts/verify_phase1_security_gate.sql must report no security_lint_blockers.
# tests/sql/s100_security_cost_hardening.sql seeds fixtures in one transaction and rolls
# back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. Acceptance test (authorization + integrity).
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s100_security_cost_hardening.sql" 2>&1)"
echo "$output"
if ! grep -q 'all authorization and integrity checks passed' <<<"$output"; then
  echo "s100_security_cost: FAILED (acceptance)" >&2
  exit 1
fi

# 2. The read-only security gate must report no blockers (incl. the new S100 checks).
gate="$(psql -X -At -v ON_ERROR_STOP=1 -f "$ROOT/scripts/verify_phase1_security_gate.sql" 2>&1)"
blockers="$(printf '%s' "$gate" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["security_lint_blockers"]))' 2>/dev/null || echo '["gate-parse-failed"]')"
if [ "$blockers" != "[]" ]; then
  echo "s100_security_cost: FAILED (security gate blockers: $blockers)" >&2
  exit 1
fi

echo "s100_security_cost: passed"
