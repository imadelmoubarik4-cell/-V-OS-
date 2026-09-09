# PR28 production-adoption review gate

## Status

PR28 prepares and tests the first production-adoption slice. It does not grant
permission to apply SQL or deploy any runtime component.

The staging package was refreshed on 9 September 2026 against the merged PR29
base commit `8411b54b8a71bb94149517d22261632fe4aee020`. PR29 changed only the web
application and UI tests, so the reviewed Phase 1 candidate allowlist remains
unchanged. This refresh did not create a hosted staging branch or contact a
hosted database.

## Included

- A production-shape preflight locked to the current six hosted migration
  versions.
- Least-privilege hardening for the existing `ensure_rls` event-trigger
  function.
- A local-only allowlist of the previously reviewed Phase A.2 and Phase 1
  production security files.
- Protected-row, quantity, RLS, function-exposure and role-matrix assertions.
- A GitHub Actions job backed only by disposable PostgreSQL 17.
- Manifest evidence tying this review package to the post-PR29 base while
  recording that its candidate SQL did not change.

## Explicitly excluded

- `20260801000000_legacy_schema_baseline.sql` as a hosted migration;
- every branch-only, preview-transfer and one-time transfer/import file;
- the destructive Checkpoint K consolidation;
- the isolated PR27 Reports release-closure state;
- all `atlas_private` runtime modules;
- Edge Function deployment;
- frontend endpoint changes;
- production write-gate changes.

## Review evidence required

1. The package contract test passes.
2. The disposable PostgreSQL dry run passes.
3. The existing 20-test role matrix passes and rolls its fixtures back.
4. Security verification reports no table without RLS, unsafe view, browser
   function exposure or lint blocker.
5. Protected canonical counts and total inventory quantity are unchanged.
6. Review confirms the candidate include list exactly matches `manifest.json`.

## Later production gate

After PR28 passes, production still requires a separate authorization covering:

1. fresh encrypted backup and verified restore path;
2. refreshed production migration ledger and data fingerprint;
3. an authorized production-shaped staging target;
4. a newly generated, flattened migration with no psql include commands;
5. Security and Performance Advisor results from that target;
6. a maintenance window, named operator and stop conditions;
7. production SQL approval distinct from Edge Function deployment and frontend
   endpoint cutover.

## Rollback boundary

The Phase 1 slice creates security and staging structures but must not alter
protected operational rows. If production acceptance later fails, keep write
gates disabled and roll back the application first. Prefer a reviewed forward
fix for database objects; do not restore permissive grants, drop `atlas_private`
or run destructive down-migrations. Whole-project restore remains an emergency,
separately approved action.
