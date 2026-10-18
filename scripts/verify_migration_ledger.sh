#!/usr/bin/env bash
# Baseline-aware migration-ledger check.
#
# Production runs on an ADOPTED/SQUASHED baseline: the ledger holds far fewer rows
# (e.g. ~98) than the repository has migration files (~167), because the early
# history was squashed into an adopted baseline and is intentionally absent from
# the ledger. So "a file with no ledger row" is NOT by itself "pending" — most
# such files are squashed history and must be left untouched.
#
# This check therefore only looks at the POST-BASELINE TAIL: migration files whose
# version is >= LEDGER_TAIL_FLOOR (default S104). Those are individually tracked,
# so any one missing from the ledger is real, unexpected drift (or a deliberately
# pending new migration you are about to apply). It also explicitly asserts that
# S104 and S105 are recorded. It never reads or backfills the squashed history and
# never alters any record. Read-only.
#
# `supabase db push` stays PROHIBITED for this deployment (it would try to apply
# every unrecorded file, squashed history included). Use the reviewed explicit
# sequence (scripts/apply_s105_reviewed.sh) instead.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
: "${LEDGER_TAIL_FLOOR:=20261021090000}"   # S104 — first in-scope migration for this deploy
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S104=20261021090000
S105=20261022090000

ledger="$(psql -X -tAq -c "select version from supabase_migrations.schema_migrations order by version")"
ledger_count="$(grep -c . <<<"$ledger" || true)"

file_count=0
tail_count=0
drift=()
for file in "$ROOT"/supabase/migrations/*.sql; do
  version="$(basename "$file" | cut -d_ -f1)"
  case "$version" in *[!0-9]*|"") continue ;; esac   # skip non-timestamp names
  file_count=$((file_count + 1))
  # Only the post-baseline tail is individually tracked; older files are squashed.
  if [[ "$version" > "$LEDGER_TAIL_FLOOR" || "$version" == "$LEDGER_TAIL_FLOOR" ]]; then
    tail_count=$((tail_count + 1))
    grep -qx "$version" <<<"$ledger" || drift+=("$version")
  fi
done

echo "ledger entries: ${ledger_count}; migration files: ${file_count}; post-baseline tail (>= ${LEDGER_TAIL_FLOOR}): ${tail_count}"

status=0
if ((${#drift[@]})); then
  echo "UNEXPECTED DRIFT — post-baseline migration file(s) with no ledger row:" >&2
  printf '  %s\n' "${drift[@]}" >&2
  echo "  (apply via scripts/apply_s105_reviewed.sh / the reviewed sequence — never 'supabase db push')" >&2
  status=1
fi
for want in "$S104" "$S105"; do
  if grep -qx "$want" <<<"$ledger"; then echo "ledger has $want"; else echo "ledger MISSING $want" >&2; status=1; fi
done

if ((status==0)); then echo "migration_ledger: passed (S104 + S105 recorded; no post-baseline drift)"; else echo "migration_ledger: FAILED" >&2; fi
exit "$status"
