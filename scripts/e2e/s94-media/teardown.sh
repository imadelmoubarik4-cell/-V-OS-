#!/usr/bin/env bash
# Stops the S94 Media end-to-end containers. KEEP_DB=1 keeps the database.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
docker rm -f s94e2e-storage s94e2e-postgrest >/dev/null 2>&1 || true
if [[ "${KEEP_DB:-0}" != "1" ]]; then
  psql -X -q -d postgres -c "drop database if exists $E2E_DB with (force)" >/dev/null 2>&1 || true
fi
echo "stopped"
