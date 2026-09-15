# Isolated app setup and core fixes — review package

This draft follows PR31 commit `900d16c6b91fc58365ddbc9f5500db482f0c148e`.
It prepares Git changes and disposable CI tests. It does not apply hosted SQL,
create accounts, deploy functions, change live endpoints or authorize production.
When reviewed against `claude/recipes-gallery-v2`, its diff also contains the
already-reviewed PR31 prerequisite; merge ordering must retain that prerequisite.

## Why

The current preview uses production Auth/database and 16 endpoints on an existing
runtime branch. PR31's accepted staging project contains only the Phase 1 slice.
The app also had no recovery control and its Orders tab was disconnected. Running
an authenticated write rehearsal against the existing preview would therefore
test the wrong environment.

## Changes prepared

| Area | New behavior | Boundary |
| --- | --- | --- |
| Isolated artifact | Builder copies the web app outside the repo, fixes the project to `atialqebqxcquzdkezln`, accepts only a publishable key and removes runtime loaders | Existing output directories are refused; deployed connection values are unchanged |
| Network boundary | Generated CSP allows only the staging Supabase host; a fetch guard rejects other destinations and invalid rehearsal configuration | CSP is embedded in HTML as well as `_headers`, including local static previews |
| Runtime dependencies | All 16 gateway settings are blank and dynamic runtime modules are omitted; core queue upload remains available | No silent production/branch fallback; this does not claim full runtime readiness |
| Password recovery | Login link, same-origin reset email request, PASSWORD_RECOVERY-gated password change, matching/minimum password checks and sign-out | SMTP delivery and redirect allowlisting need later hosted acceptance |
| Purchase orders | Persistent manager-only drafts, amendment with version checks, mark ordered, cancel and atomic receipt through a checked RPC | No order email sending, partial deliveries or invoice reconciliation; receipt uses inventory units |
| Receipt safety | Order locking and state checks prevent a second stock increment on retry; all lines and movements commit together | Real browser sessions and concurrent-client behavior still require rehearsal |
| Offline behavior | Already-open session retains loaded data; offline submissions are blocked and never automatically replayed | No offline login or cold-start cache; uncertain online request outcomes require refresh/reconciliation |
| Save feedback | Core item create/update/delete now checks returned errors before closing or refreshing; sign-in awaits active-profile validation | These checks do not make every existing multi-request workflow atomic |
| Recovery drill | Disposable CI takes a native dump with synthetic users, orders and stock; restores to a separate disposable database; compares complete selected rows and verifies role denial/receipt replay | Not a restore of current production, managed Auth or Storage bytes |

Purchase orders remain disabled in the normal deployed configuration until
`PURCHASE_ORDERS_ENABLED` is explicitly enabled after migration acceptance.
The rehearsal builder enables them in its separate artifact. Existing production
project URLs and keys are not changed in this PR.

## Exact staging setup proposal

Target: existing `atlas-pr30-validation`, `atialqebqxcquzdkezln`, eu-west-1,
PostgreSQL 17. PR31 was installed there as generated migration `20260910113945`;
the previously verified ledger has eight entries. Recheck the ledger and source
hashes before any future hosted application.

1. Keep the existing PR30/PR31 schema and history. Apply only the new incremental
   `supabase/migrations/20260910121248_atlas_purchase_order_lifecycle.sql` using
   the migration API, transaction-local lock/statement timeouts, and a recorded
   mapping from source hash to actual generated version. Never replay the legacy
   setup or flattened PR30 candidate over this baseline.
2. Run the existing 20-role and 14-ingredient suites plus the new 16-case purchase
   order suite while the target is still empty. All are rollback-only. Run the
   security gate and advisors and verify fixtures are gone before making test accounts.
3. Obtain a publishable key from this exact project. The key's project association
   must be verified during setup; its `sb_publishable_` prefix alone does not prove
   association. No service-role/secret key belongs in the browser build.
4. Build an isolated artifact with the command below. Verify the manifest, generated
   configuration and CSP. Only that artifact may later be served as the rehearsal
   preview; normal Netlify PR previews still use the existing app configuration.
5. Select the exact HTTPS preview origin or loopback port. Allowlist only its exact
   `/recovery.html` URL in staging Auth. This PR does not select or publish a hosting
   destination or modify Auth settings.
6. Provision distinct synthetic active admin, manager, bartender and viewer users,
   one inactive viewer and one unlisted identity. Activate roles through the trusted
   staging administration path after Auth creation. Keep credentials outside Git
   and use secure sign-in. A real approved test mailbox is needed for delivery tests;
   `example.invalid` SQL-fixture addresses cannot receive recovery email.
7. Seed a recorded, uniquely tagged synthetic supplier/item/recipe set. Run the
   rehearsal cases below and record all generated IDs for narrow cleanup.
8. Revoke/end fixture sessions, delete only recorded test identities and records in
   dependency order, and verify cleanup. Preserve migrations, reference categories
   and the staging project. Never use blanket deletion or a reset as cleanup.

This proposal needs one hosted-setup approval covering the exact source revision,
selected preview origin, identities/test mailbox and fixture cleanup. None of those
operations has run merely because this draft exists.

## Build locally

```bash
python scripts/build_isolated_rehearsal.py \
  --output /tmp/atlas-isolated-review \
  --publishable-key sb_publishable_REPLACE_WITH_STAGING_KEY
python -m http.server 8080 --bind 127.0.0.1 --directory /tmp/atlas-isolated-review
```

Use a new output path for each build. The example placeholder passes format checks
but cannot authenticate; it is not a credential. The output contains
`rehearsal-manifest.json` and an explicit rehearsal banner. It is not published by
the repository's normal Netlify configuration. The output itself is not committed.

## Acceptance checklist

- Builder leaves the source configuration intact, rejects secret keys/overwrite,
  and excludes both production and existing runtime hosts from generated CSP/config.
- Browser network inspection shows only staging Auth, REST, Storage and realtime
  destinations; disabled runtime modules issue no calls to another project.
- All six identity states behave as intended; switching users exposes no prior
  session's data. Recovery mail delivery, expired links and successful reset pass.
- Manager creates and amends an order, checks quantity units/costs, marks it ordered,
  then receives it. Exactly one movement per line appears. Repeat receive does not
  change stock again. Stale amendments fail. Bartender/viewer cannot read or command
  orders, and direct table writes are denied.
- Disconnect while the app is open: loaded data remains visible with an offline
  banner, saves are blocked, and reconnect does not replay writes. Refresh before
  continuing. Test connection loss during a request separately; do not assume failure
  means the server did not commit.
- Validate normal inventory/recipe costing/public-menu flows and queue upload/cancel/
  retry using synthetic data. Queue upload is not proof of extraction or promotion.
- Verify final fixture cleanup and source/ledger mapping; record any unexpected
  side effect before attempting a correction.

## Runtime modules remain a separate dependency gate

The full trial still requires more than the Phase 1 database. The builder does not
silently remove this requirement; it exposes a safe core rehearsal while preventing
accidental calls to the old branch. All 16 configured gateways are intentionally
disabled: sprint3-review, sprint4-briefing, phase3-brain, phase3-intelligence,
operations-checkpoint-a, inventory-scanner, stock-counts, team-messages,
marketing-workspace, team-profiles, team-profile-photos, shifts, knowledge, reports,
system and settings (all prefixed `atlas-`).

Before enabling any, review its exact prerequisite migrations and isolated schema,
Auth audience, Storage buckets, gateway source revision, server environment and
write/publication gates. The import-review and stock-count sources default to
production Auth, so changing only frontend URLs is insufficient. No broad historical
replay or automatic function deployment is included here. Unsupported screens remain
unavailable and must not be counted as passed trial features.

## Recovery preparation

`scripts/verify_recovery_roundtrip.sh` runs only in GitHub Actions against the
loopback `vaos_adoption` service and a job-supplied container ID. It deliberately
commits a synthetic variant of the rollback-only purchase-order fixtures, dumps
that disposable database with PostgreSQL 17, creates `vaos_recovery_drill`, restores,
compares selected complete rows, then tests restored manager/staff boundaries and
receipt idempotence. CI destroys both databases with the service container.

This proves a narrow synthetic round trip. Before production, obtain a current
encrypted recovery set with separately protected keys; include database, Auth,
Storage bytes, functions/configuration and web artifacts; demonstrate restoration
in a separately approved destination and measure the actual recovery interval.
The August JSON snapshot and this CI drill cannot substitute for that evidence.

## Validation record

Local validation: 203 Node tests passed; Python ran 198 tests with 194 passed and
four existing private-source skips. New frontend files pass syntax checks and the
Git diff has no whitespace errors. Database acceptance and synthetic restore results
must be read from the CI runs at the final PR head; they are not claimed from the
local source checks. Hosted acceptance remains pending.

Recovery implementation references: [reset request](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail),
[password update](https://supabase.com/docs/reference/javascript/auth-updateuser).
