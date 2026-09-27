# Shared settings for the S94 Media end-to-end stack (sourced by the other scripts).
# Loopback only. Nothing here talks to a hosted Supabase project.

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGPASSWORD:=postgres}"
: "${E2E_DB:=s94_e2e}"
export PGHOST PGPORT PGUSER PGPASSWORD
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../../.." && pwd)"
: "${E2E_WORK:=${TMPDIR:-/tmp}/s94-media-e2e}"
mkdir -p "$E2E_WORK"

# A throw-away HS256 secret shared by PostgREST, Storage and the auth stub.
: "${E2E_JWT_SECRET:=s94-media-e2e-local-only-jwt-secret-0123456789}"
# A fake 20-character project ref: the app only accepts https://<ref>.supabase.co,
# so Chromium maps <ref>.supabase.co and <ref>.storage.supabase.co to the local proxy.
: "${E2E_REF:=s94e2elocalmediatest}"
: "${E2E_POSTGREST_PORT:=54330}"
: "${E2E_STORAGE_PORT:=54331}"
: "${E2E_PROXY_HTTP_PORT:=54340}"
: "${E2E_PROXY_HTTPS_PORT:=54343}"
: "${E2E_APP_PORT:=54380}"
: "${E2E_STORAGE_IMAGE:=supabase/storage-api:v1.11.13}"
: "${E2E_POSTGREST_IMAGE:=postgrest/postgrest:v12.2.3}"
export E2E_DB E2E_DIR REPO_ROOT E2E_WORK E2E_JWT_SECRET E2E_REF E2E_POSTGREST_PORT E2E_STORAGE_PORT \
  E2E_PROXY_HTTP_PORT E2E_PROXY_HTTPS_PORT E2E_APP_PORT E2E_STORAGE_IMAGE E2E_POSTGREST_IMAGE
