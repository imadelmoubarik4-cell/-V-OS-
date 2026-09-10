# S33 CSV import candidate

Review-only source in PR33. No hosted migration, function deployment or frontend
endpoint enablement is included. The new worker is quarantined under
`supabase/s33/functions/atlas-import-worker`; the SQL is an integration candidate
under `supabase/s33/sql`, outside automatic migration replay.

The candidate fills the new-inventory CSV path: uploaded private source -> claim
and freeze -> bounded extraction -> private manager review -> atomic publication.
It does not overwrite or merge existing inventory. Approved `create` and `skip`
decisions are supported. A matching existing name/SKU stops the whole publication;
corrections and existing-item imports need a separately reviewed policy.

## Input contract

UTF-8 comma-separated CSV, up to 1 MiB and 1,000 rows. Required headers are `name`,
`unit`, `quantity`. Optional headers are `cost_price`, `category`, `sku`,
`par_level`. Headers must be unique; unknown fields are rejected. Required names
and units cannot be blank. Quantities/par levels are non-negative decimal strings
up to 1,000,000; costs up to 1,000,000,000, with at most six fractional digits and
a dot separator. Blank optional costs/par levels remain null. Missing category
uses the existing `other` classification only when the item is created. No unit,
cost, supplier, package-size or matching value is inferred. Duplicate names/SKUs
within one file fail parsing. Quoted commas, escaped quotes, newlines and UTF-8 BOM
are accepted; malformed quoting, invalid UTF-8 and ambiguous numbers are rejected.

## Authorization and transactions

The worker starts only with explicit enablement, the fixed S33 Auth/runtime
origin, a staging publishable key and a server-only service key. Every request
validates its bearer token through Auth and reads the active manager/admin profile.
The client supplies only an action and batch UUID. The verified Auth user supplies
the database actor; client-supplied actor IDs, source URLs and normalized data are
rejected. Fetches are confined to the fixed staging origin and reject redirects.

`atlas_import_command` is security-invoker and executable only by `service_role`.
It rechecks and locks the actor profile before each command. Queue and job locks
serialize retries and competing publications. Claims freeze queue metadata and
authenticated Storage updates/deletes through restrictive policies. An unpublished
claim can be discarded, removing its private review records and releasing the file.
Published jobs/source audit cannot be discarded through this command.

Extraction preserves raw row fields and a SHA-256 of the downloaded bytes. A unique
source hash prevents the same file being staged in another job. Review approval
does not write stock. Publication requires every original row to be approved as
create or skip, retains decision/source evidence, locks inventory for duplicate
checks, creates items at quantity zero, and uses the existing controlled adjustment
function for initial positive stock. A transaction-local verified actor context
attributes inventory movements; the previous context is restored. No Auth user,
role, password, setting or last-admin guard is changed by this context assignment.
A failure on any row rolls back all item, movement, review and job changes.
Completed retries return the original result. Published review rows are immutable.

## Frontend and cleanup

Import Center actions remain disabled unless `VABAR_CONFIG.IMPORT_WORKER_API` and
the core Supabase URL both point exactly to S33. The source config has no enabled
worker URL. The candidate adds process, review, publish and discard actions; it
protects processed sources from the old delete-first UI flow. Server checks remain
authoritative if the browser has stale queue state.

For ordinary unpublished cancellation, discard processing before deleting the
uploaded file and queue row. For the separately approved rehearsal cleanup,
record job/batch/review/item/movement/object IDs. Remove the exact import job before
its private review batch or public queue; remove created stock movements before
created inventory. Storage bytes require the Storage API, not SQL metadata deletion.
Published audit deletion is a bounded rehearsal cleanup action, not an app action.

The technical parser limits are not hosted rehearsal allowances. S33's proposed
two files/ten rows and exact per-table cleanup caps must be reconciled with created
inventory and stock movements before approval. No extra emails/accounts are used
by this Git-only work.

## Verification and remaining gates

Node tests exercise real parsing plus a mocked Auth/Storage/RPC transport. The
disposable PostgreSQL runner uses the real parser output, verifies privilege and
actor denials, source immutability, review requirements, source-hash deduplication,
concurrent publication, stock/cost/actor totals, whole-transaction rollback,
discard cleanup, and retry after native restore. Their result must be green on
the reviewed PR revision before accepting this candidate.

This does not establish live Storage-service policy behavior, managed session
revocation, Deno deployment/type checking, operator UI acceptance or complete
Auth/Storage-byte recovery. The existing sixteen-gateway ZIP remains unchanged;
this worker would be an explicitly reviewed seventeenth function in a later
combined package. The historical 64-source runtime experiment is still not the
final hosted migration delta. Final migration generation via the Supabase CLI
remains pending; the local CLI package install was interrupted by network approval,
so no migration filename or execution authorization is invented here.
