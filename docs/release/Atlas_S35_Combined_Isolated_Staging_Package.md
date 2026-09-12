# Atlas S35 combined isolated-staging package v3 (S37 runtime isolation)

Status: **S37 Git-only isolation correction under review. S35 migrations 1–6 are complete in isolated staging; six functions are deployed and the remaining deployment is paused pending this correction.**

This package resumes the approved S35 rehearsal after the Git-only S36 database remediation. S37 adds a deterministic fail-closed runtime artifact so the 18 reviewed functions cannot fall back to a production project or advertise wildcard browser access. It does not authorize or describe a production release.

## Fixed boundary

| Control | Required value |
| --- | --- |
| Source | merge commit `0556ec89ec8041a9d2b1f7cd94706212176884a6` |
| Package base | PR35 merge commit `0915c36034d36b009d45f3d6730bf5df01b868eb` |
| S37 base | PR36 merge commit `c6815d959dc57a8b1d3ec812a0596dcfe21b9302` |
| Staging project | `atlas-pr30-validation` / `atialqebqxcquzdkezln` / `eu-west-1` |
| Private preview | `https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site` |
| Synthetic tag | `atlas-s35-20260911` |
| Test mailbox | operator-provided `ATLAS_S35_TEST_EMAIL`, never committed |
| Production | excluded and untouched |

Only synthetic identities, files, messages, schedules, imports, inventory, recipes, and notification subscriptions are permitted. Real staff data, production credentials, production endpoints, and production recipients are prohibited.

## One approval, ordered execution

### 1. Read-only preflight

1. Resolve and record the exact source commit, staging project ref, region, preview origin, and CLI version.
2. Export the staging migration ledger, schema fingerprints, deployed-function inventory, Auth redirect allowlist, Storage bucket/policy inventory, and notification configuration. Store sensitive exports encrypted; publish only sanitized hashes and counts.
3. Compare every source file with `Atlas_S35_Combined_Isolated_Staging_Manifest.json`, then build and verify the S37 generated runtime manifest before any function deployment.
4. Stop on a project-ref, source, checksum, ledger, schema, function, redirect, or Storage-policy mismatch. Do not repair an unknown baseline inside this run.
5. Accept the known S36 pre-migration baseline only when `atlas_private.report_events` exists, RLS is disabled, no policies exist, and `anon`/`authenticated` have no grants. Any other state is a stop. Migration 6 is the only authorized repair.
6. If a listed migration is already present with the exact accepted version and fingerprint, record it as an exact skip. A partial or divergent S33/S34/S36 state is a stop condition.

Never run a directory-wide database push. Apply only the six reviewed files below.

### 2. Migrations

Apply each file transactionally and capture its before/after fingerprint:

1. `supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql`
2. `supabase/s33/migrations/20260910211903_atlas_s33_runtime_source_contracts.sql`
3. `supabase/s33/migrations/20260910201435_atlas_s33_csv_import_pipeline.sql`
4. `supabase/migrations/20260911124006_s34_foreign_key_indexes.sql`
5. `supabase/migrations/20260911124039_s34_notification_and_conversation_stars.sql`
6. `supabase/migrations/20260911160616_s36_report_events_rls.sql`

Migration 6 enables RLS on `atlas_private.report_events`, removes all table privileges before granting only `SELECT` and `INSERT` to `service_role`, and creates explicit service-role policies for those two operations. Its conditional table check exists only for the historical GitHub replay baseline; the isolated staging table is required by preflight. After applying it, verify RLS is enabled, both policies exist, and `anon`/`authenticated` retain no grants.

The JSON manifest is authoritative for SHA-256 checksums. Stop immediately if a transaction fails or the post-migration fingerprint differs.

### 3. Runtime functions and secrets

Build a new runtime directory outside the repository:

```sh
python3 scripts/build_s37_isolated_runtime.py "$ATLAS_S37_RUNTIME_OUTPUT"
```

Deploy exactly the 18 generated function packages listed by `runtime-manifest.json` and record their candidate hashes and deployed versions. Never deploy the raw manifest sources directly. The builder verifies every reviewed source hash, removes all known production project references and Auth fallbacks, binds operational REST reads directly to the exact isolated runtime origin instead of the Auth client, removes legacy cross-project reader identifiers, source labels, and comments while preserving required database/API contract fields, fixes browser CORS to the owner-private preview origin, and adds an exact-target startup guard. Do not deploy `atlas-item-master` or any unlisted function.

Keep `SUPABASE_SERVICE_ROLE_KEY`, `ATLAS_VAPID_PRIVATE_KEY`, and `ATLAS_NOTIFICATION_DISPATCH_TOKEN` server-only. Configure the staging Auth URL and publishable key outside Git. Begin with:

- `ATLAS_IMPORT_ENABLED=true`
- `ATLAS_STOCK_COUNT_PUBLICATION_ENABLED=false`
- `ATLAS_PUSH_DELIVERY_ENABLED=false`

The notifications function retains platform JWT verification. The other 17 functions retain their reviewed in-handler active-profile verification only behind the exact staging configuration guard. Any generated production reference, wildcard CORS value, target mismatch, or gateway-auth exception is a stop requiring a new review.

### 4. Owner-private full-app preview

Build into a new directory outside the repository:

```sh
python3 scripts/build_s35_isolated_preview.py \
  --output "$ATLAS_S35_PREVIEW_OUTPUT" \
  --publishable-key "$ATLAS_S35_PUBLISHABLE_KEY"
```

The builder points all 17 browser runtime endpoints at the isolated project, preserves the full module loader, replaces old/production hosts in the generated CSP, and never edits source or publishes anything. Review `rehearsal-manifest.json`, then update only the fixed owner-private preview. Allowlist exactly its `/recovery.html` callback. Confirm that an unauthorised viewer cannot open the preview before tests begin.

### 5. Synthetic full-app acceptance

Create fixture-ledger entries for admin, manager, bartender, viewer, inactive, and unlisted cases. Validate:

- login, logout, session expiry, role boundaries, Team visibility, inactive/unlisted denial;
- account creation and recovery email, successful reset, old-password denial, expired-link denial, and consumed-link denial;
- private Storage upload/download plus viewer and anonymous denial;
- CSV import, inventory, stock counts, purchase orders, recipes, Team messages/stars, weekly and monthly shifts, Knowledge, Atlas Brain, reports, system, and settings;
- saved/refetched recipe arithmetic using 200 ISK cost, 500 ISK price, 60% margin, and 5 servings;
- desktop and mobile navigation with no missing module, horizontal overflow, or production endpoint.

Record IDs at creation time. Do not discover cleanup targets by name pattern alone.

### 6. Controlled notification proof

1. With delivery disabled, verify subscription persistence, role denial, queue creation, and an explicitly disabled dispatch result.
2. Provision exactly one approved test device for `ATLAS_S35_TEST_EMAIL`. Set VAPID and dispatch secrets outside Git.
3. Temporarily set `ATLAS_PUSH_DELIVERY_ENABLED=true` only for two synthetic events: one Team message and one published shift, both addressed to the same test device.
4. Verify receipt, payload redaction, and isolated-preview deep links. Capture queue/delivery IDs and recipient count without exposing tokens.
5. Set `ATLAS_PUSH_DELIVERY_ENABLED=false` immediately, verify the disabled state, and remove the test subscription and secrets during cleanup.

Any unexpected recipient, third delivery, production link, or unredacted sensitive payload is an immediate stop.

### 7. Recovery proof

Create an encrypted pre-test recovery set with hashes for Auth configuration, application schemas/data, Storage objects/metadata/policies, migration ledger, and functions. Restore it to a separate isolated target named `atlas-s35-recovery`; never overwrite the rehearsal target to prove recovery.

Compare row counts and deterministic fingerprints, Storage byte hashes and access policies, and the complete role matrix. Verify login and password recovery, confirm old refresh tokens are denied, and rerun the restore to prove idempotence. Sessions are not a recoverable artifact and must be recreated. Destroy the recovery target after its evidence is accepted.

### 8. Cleanup and closure

1. Disable push delivery first and verify it is disabled.
2. Unpublish the private preview, or retain it only with all runtime endpoints blanked and its recovery redirect removed.
3. Delete notification subscriptions, queue rows, and test Storage objects by recorded fixture IDs.
4. Delete application fixtures in dependency order from the fixture ledger.
5. Revoke synthetic sessions, then delete synthetic Auth users.
6. Remove the exact recovery redirect if the preview is not retained; unset VAPID private material, dispatch token, and all test-only secrets.
7. Verify zero tagged application rows, Auth users/sessions, Storage objects, subscriptions, pending queue entries, and retained test secrets.
8. Destroy `atlas-s35-recovery`. Record whether the isolated staging migrations/functions are retained for later review.

If cleanup or validation fails, freeze the isolated target and recover from the captured set. Do not improvise a down migration.

## Stop conditions

Stop without continuing to later phases when any fixed identifier or checksum differs; preflight is incomplete; a migration is partial; the generated runtime contains a production reference or wildcard CORS; an unlisted function is required; preview privacy fails; production or real-person data is observed; push cannot be constrained to one device and two events; recovery fingerprints differ; or cleanup cannot prove zero residue.

## Evidence and decision

Complete `Atlas_S35_Staging_Evidence_Template.json` phase by phase. Staging acceptance requires every phase to be `passed`, every evidence item to be linked by sanitized identifier/hash, notification delivery to be disabled again, cleanup to be complete, and production to remain untouched. Production release preparation and production approval remain separate future decisions.
