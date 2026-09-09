# Production adoption dry-run package

This directory is a review and disposable-staging package. It is intentionally
outside `supabase/migrations`, so merging the pull request cannot make Supabase
apply it through the normal migration workflow.

## Current refresh

This package was refreshed against merged base commit
`8411b54b8a71bb94149517d22261632fe4aee020` after PR29. The PR29 merge contains
frontend and UI-test changes only, so the candidate SQL allowlist below was not
expanded or flattened. No hosted staging branch was created and no hosted
database was contacted during this refresh.

## Scope

The package covers only the first production-adoption slice:

1. verify the known six-migration production baseline;
2. verify the existing `ensure_rls` event trigger and its
   `public.rls_auto_enable()` function;
3. revoke direct function execution from `PUBLIC`, `anon` and `authenticated`;
4. dry-run the reviewed Phase A.2 and Phase 1 production security files;
5. prove protected canonical rows and inventory quantity do not change;
6. run the existing role matrix and security verification.

It does **not** install the isolated `atlas_private` runtime, deploy Edge
Functions, change `apps/web/config.js`, enable a production write flag or modify
any hosted database.

## Run locally

The runner accepts only a loopback PostgreSQL host and refuses remote hosts:

```bash
PGHOST=127.0.0.1 \
PGPORT=5432 \
PGUSER=postgres \
PGPASSWORD=postgres \
PGDATABASE=vaos_adoption \
bash scripts/verify_production_adoption_dry_run.sh
```

The pull-request workflow runs the same command against an ephemeral PostgreSQL
17 service. No Supabase or production credentials are available to that job.

## Promotion rule

This package is not production SQL approval. After the dry run and review pass,
a later, separate approval must:

- refresh the production fingerprint and backup evidence;
- flatten the reviewed candidate into a newly generated migration file;
- test that exact migration on an authorized production-shaped staging target;
- approve the database window independently from Edge Functions and frontend
  endpoint cutover.

The excluded files in `manifest.json` must not be reintroduced by flattening.
