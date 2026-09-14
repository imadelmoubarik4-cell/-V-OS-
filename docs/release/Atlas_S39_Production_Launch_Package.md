# Atlas S39 production-launch preparation package

## Status

This is a **Git-only preparation package** based on the merged S38 tree. It
does not authorize or perform hosted SQL, function deployment, frontend
endpoint changes, site publication, or real-stock writes.

The package closes the gap between the accepted isolated rehearsal and a later
production launch decision. It pins every database and function source, makes
the real-stock preservation proof executable, and separates each irreversible
production action into its own approval gate.

## Confirmed production baseline

The 2026-09-14 read-only preflight observed:

- production project `vabar-inventory` (`dnefgcmjcgxlynycxkts`), healthy in
  `eu-west-1`;
- six recorded migrations, compared with fifteen on isolated staging;
- all seventeen current public tables with RLS enabled;
- two Security Advisor warnings because browser roles can execute the hosted
  `public.rls_auto_enable()` `SECURITY DEFINER` function;
- one backup Edge Function and no Atlas runtime functions;
- a real inventory catalog whose values were fingerprinted outside public Git.

The first migration in the ordered plan contains the already-reviewed revoke
for `public.rls_auto_enable()`. The later index and policy migrations address
the staging-proven database gaps. No S39 file modifies the protected data.

## Exact database order

Only the nine files in `Atlas_S39_Production_Launch_Manifest.json` are eligible
for a later production database window. They must be applied one at a time in
the manifest order, transactionally, with checksum verification before each
step. A directory-wide database push is prohibited.

The order is intentionally not a filename sort. It follows the validated
dependency sequence: flattened Phase 1 adoption, policy/index cleanup,
purchase-order lifecycle, S33 runtime/source/import contracts, S34 indexes and
notification/pinned-conversation storage, then the S36 report-events RLS fix.

No reviewed migration touches the now-protected Supabase `realtime` schema.

## Real-stock preservation

`supabase/production-launch/000_read_only_snapshot.sql` returns hashes and
counts only; it does not reveal item names or write anything. Run it immediately
before and after a separately approved database window and keep both outputs
outside the public repository.

`scripts/verify_s39_production_snapshots.py BEFORE AFTER` rejects the release
unless inventory items, quantities, movement history, suppliers, recipes,
profiles, and Auth-user count match exactly. It also requires all nine planned
migration versions, the new tables, report-event RLS, and removal of browser
execution on `rls_auto_enable()`.

Stock counting, barcode linking, imports, and every other inventory mutation
remain disabled during the database and read-only smoke-test phases.

The CI-only `scripts/verify_s39_production_launch_dry_run.sh` reconstructs the
six-migration production shape on loopback PostgreSQL, reuses the Phase 1
adoption proof, applies the other eight pinned files, and runs the same snapshot
comparison. It refuses every non-loopback database host.

## Production runtime artifact

Build outside the repository:

```sh
python3 scripts/build_s39_production_runtime.py \
  /new/outside-repository/path \
  --browser-origin https://the-approved-atlas-origin.example
```

The builder:

1. verifies the pinned S35 function-source manifest and every source checksum;
2. packages exactly eighteen functions;
3. replaces legacy/staging project references with the exact production origin;
4. removes Auth URL/key fallbacks and adds an exact-project startup guard;
5. removes wildcard CORS in favor of the separately approved HTTPS origin;
6. requires import, stock publication, and push delivery to be `false`;
7. records generated hashes and marks the artifact as not deployed.

Only this generated artifact may be considered for the later function gate.
Raw source directories are not deployment candidates.

## Later launch gates

1. **Backup window:** verify downloadable backup/recovery evidence, freeze
   operator writes, and refresh the external snapshot.
2. **Database:** apply the nine exact files and immediately compare snapshots,
   migration ledger, RLS, and advisers.
3. **Functions:** deploy the eighteen generated packages with all write flags
   disabled.
4. **Read-only acceptance:** test sign-in, roles, reads, navigation, and real
   stock display without creating or changing records.
5. **Endpoint cutover:** update all seventeen browser endpoints to production,
   verify CSP and recovery URLs, then publish the site.
6. **Controlled activation:** enable imports, notifications, shift publication,
   scanner linking, and stock-count publication separately, only after a new
   approval and a narrow live test.

Each gate stops on a checksum, identity, role, stock fingerprint, adviser,
function, origin, or recovery mismatch.

## Rollback rule

Frontend and functions roll back by restoring the previously recorded version
and keeping every write flag disabled. Database migrations are forward-only;
do not improvise down migrations. If protected data or schema verification
fails, keep the site on the old endpoints and recover from the pre-window
backup under a separate recovery approval.
