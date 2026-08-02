# Release 2 — publication and isolated migration validation

Status: hosted validation complete; public GitHub publication approved on 2026-08-02 and in progress.

## Source checkpoint

- Branch: `release/alpha-0.8.0`
- Release 1 changes are included in the sanitized public foundation; the original local checkpoint history remains private.
- Pending production migration: `20260802090000_phase_a_02_inventory_staging.sql`
- Production project: `vabar-inventory`
- Supabase is connected to the GitHub repository for preview-branch workflows.

## Completed

- Moved the 107-row operational extension catalogue and 61-row alias map to ignored `data/private/reference/` paths; Git contains header-only templates.
- Removed real supplier identities from the public seed, web placeholders, and generator defaults. Optional supplier attribution is now supplied only at private build time.
- Sanitized the inherited legacy example templates and archived supplier form placeholders so the Release 2 tree contains only generic supplier examples.
- Added repository checks that prevent operational CSVs or supplier identities from entering the new public runtime and seed files.
- Re-ran the full local suite: 30/30 tests pass.
- Confirmed `git diff --check origin/main...HEAD` is clean.
- Confirmed source PDFs, private costs, generated inventory, temporary extraction files, and the production snapshot remain Git-ignored.
- Served the web checkpoint locally and received HTTP 200 for the application root, menu, and Import Center JavaScript.
- Captured and integrity-checked a private pre-A.2 production snapshot.
- Executed the complete eight-file migration chain successfully from an empty PostgreSQL-compatible database.
- Executed the complete eight-file migration chain on an ephemeral hosted Supabase branch.
- Confirmed the intended hosted access boundary:
  - anonymous catalogue access is denied;
  - active bartenders can read the redacted catalogue but not canonical cost-bearing inventory or staging rows;
  - inactive accounts receive no inventory surface;
  - bartenders cannot write canonical inventory or staging decisions;
  - managers/admins can read and write canonical inventory and review allowed staging decision columns;
  - manager browser clients cannot insert staging rows or alter raw staged evidence;
  - the trusted service worker can insert staging rows.
- Revoked RPC execution of the legacy trigger-only `public.handle_new_user()` function and the unused legacy authorization helper.
- Re-ran Supabase security advisors. The migration-related warnings are resolved; only the project-level leaked-password-protection setting remains.
- Deleted the ephemeral hosted branch after validation to stop hourly charges.
- Re-verified production after branch deletion: six migrations through A.1, 50 inventory items, 4 suppliers, 1 recipe, and 0 import batches.

## Hosted validation notes

- The user approved the quoted Supabase Micro branch rate of US$0.01344 per hour.
- The first hosted attempt exposed the missing legacy baseline and was deleted without applying SQL.
- After credits were restored, a fresh data-less branch was created and all eight migrations applied successfully.
- Synthetic identities and rows were used only in the disposable branch; no production data was copied.
- The branch was deleted after advisors and role tests completed.

## Private backup

- File: `Atlas_Alpha_0.8.0_Production_Pre_A2_Backup_2026-08-02.json`
- SHA-256: `a1950a089b1818219338d7a83d4bbb0d49686253a26b48fe8158e372235bee1c`
- Captured records: 3 profiles, 4 suppliers, 50 inventory items, 10 inventory movements, 16 recipe categories, 1 recipe, 4 recipe ingredients, 0 import batches, and 0 import review rows.
- The backup is private and excluded from Git. It contains no credentials, access tokens, service keys, or password hashes.

## Remaining Release 2 gates

1. Publish `release/alpha-0.8.0` through the GitHub connector and open a draft pull request against `main`.
2. Verify the connected Supabase preview run for the exact published commit and attach the result to the draft pull request.
3. Keep merging, production migration, deployment, and inventory promotion as separate approval points.

## Production boundary

No production migration, inventory import, recipe linking, application deployment, pull-request merge, or release tag has been performed. Production remains on A.1 with 50 inventory items and zero import batches.
