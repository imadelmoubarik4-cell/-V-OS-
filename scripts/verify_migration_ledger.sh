#!/usr/bin/env bash
# Verify the migration ledger against the migration files, so a directory-wide
# `supabase db push` cannot silently replay an already-applied migration whose
# ledger row is missing (the S104 situation: schema present, ledger row absent).
#
# Fails if any migration file has no supabase_migrations.schema_migrations row
# ("pending" → a push would (re-)apply it), and specifically checks S104 and S105.
# Read-only. Loopback databases only. Owners run it after a reviewed apply.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S104=20261021090000
S105=20261022090000

# Versions present in the ledger.
ledger="$(psql -X -tAq -c "select version from supabase_migrations.schema_migrations order by version")"

missing=()
for file in "$ROOT"/supabase/migrations/*.sql; do
  version="$(basename "$file" | cut -d_ -f1)"
  case "$version" in *[!0-9]*|"") continue ;; esac   # skip non-timestamp names
  grep -qx "$version" <<<"$ledger" || missing+=("$version")
done

status=0
if ((${#missing[@]})); then
  echo "PENDING migrations with no ledger row (a push would replay these):" >&2
  printf '  %s\n' "${missing[@]}" >&2
  status=1
fi
for want in "$S104" "$S105"; do
  if grep -qx "$want" <<<"$ledger"; then echo "ledger has $want"; else echo "ledger MISSING $want" >&2; status=1; fi
done

if ((status==0)); then echo "migration_ledger: passed (no pending migrations; S104 and S105 recorded)"; else echo "migration_ledger: FAILED" >&2; fi
exit "$status"
