# Phase 2 stabilization — preview acceptance

## Decision

Phase 2 uses one canonical connection registry and preserves the following
safety rule throughout every wave:

> Approval-first; no automatic publishing.

Automatic supplier submission, automatic ordering, automatic social publishing,
automatic production deployment, automatic production synchronization, automatic
mapping approval and live-stock mutation remain disabled.

## P2.0 — canonical connection foundation

Completed in preview:

- one `atlas_private.integration_connections` registry;
- evidence-backed effective states;
- idempotent health checks;
- immutable completed checks;
- append-only connection events;
- reviewed capability grants with automatic execution forced off;
- shared Connection Center API and UI;
- derived Brain evidence projection;
- System audit repair for the missing private Reports event relation.

The preserved Real VÁ private checkpoint was restored server-to-server and
verified with matching source/destination digests:

- 34 import batches;
- 357 inventory staging rows;
- 747 non-inventory entity rows;
- 1,087 issue-level review rows;
- 10 manager review decisions;
- 1,104 unified review-queue rows.

The temporary transfer endpoints were retired, the temporary transport extension
was removed and production was never written.

## P2.1 — core platform

Required platform checks:

- production Auth — healthy;
- production Data API — healthy;
- Atlas private database — healthy;
- Atlas Edge runtime — healthy;
- private Storage — healthy;
- GitHub — healthy;
- Netlify Deploy Preview — healthy;
- custom SMTP — degraded.

The release-readiness contract reports seven of eight required connections
healthy. It remains correctly blocked because a real password-reset test exposed
an invalid SMTP host configuration. Custom SMTP may become healthy only after
both invitation and password-reset delivery are demonstrated.

## P2.2 — read-only sources

Completed foundation:

- existing Knowledge source attribution model extended, not duplicated;
- canonical provider references and freshness fields;
- private append-only source events;
- metadata-only manager snapshot;
- source bodies, storage paths, private URLs and credentials excluded;
- Atlas private source library verified healthy with 34 source batches and 1,104
  unified review rows;
- Google Drive, Gmail and Outlook remain honestly not configured;
- external OAuth and source scoping remain future authorization work;
- automatic synchronization remains disabled.

The Source Center mounts in Knowledge → Sources.

## P2.3 — Checkpoint M

Completed foundation:

- private POS product, target, candidate, mapping, run and event model;
- deterministic normalization and candidate scoring;
- manager-only mapping decisions;
- service-role-only RPC surface;
- append-only mapping events;
- production recipe/menu targets are copied as private mapping metadata only;
- Dineout must be healthy before external products may be staged;
- sales facts are not stored;
- sales ingestion, Brain sales evidence and automatic ordering remain disabled.

Current truthful state:

- one active production recipe is available as a mapping target;
- zero external POS products are staged;
- zero mappings exist;
- Dineout remains not configured.

The Checkpoint M workspace mounts in Reports.

## P2.4 and P2.5 safety boundary

Marketing/reputation and supplier capabilities remain registered but inactive.
The target policy is:

- approval-first;
- no automatic publishing;
- supplier drafts only;
- no automatic supplier submission.

## P2.6 — recovery

Recovery acceptance passed in a rollback-only transaction:

- stale successful evidence degrades;
- expired authorization resolves to expired;
- healthy without evidence resolves to verifying;
- blocked and not-configured states remain explicit;
- repeated request IDs are idempotent;
- provider failure cannot produce false success;
- completed checks are immutable;
- event history is append-only;
- direct healthy-state writes are denied;
- automatic execution is forced off even for an approved high-risk capability.

## Validation

- P2.2 / Checkpoint M database acceptance: 14 passed, 0 failed, rolled back;
- P2.6 recovery acceptance: 11 passed, 0 failed, rolled back;
- Supabase security advisor: no findings;
- new Phase 2 foreign-key paths indexed;
- temporary transfer transport absent;
- production inventory fingerprint unchanged.

## Remaining release blocker

Correct the production custom SMTP host and prove both invitation and
password-reset delivery. Until that succeeds:

- P2.1 is not complete;
- core-platform readiness remains false;
- Phase 5 production migration and release are not authorized;
- PR #8 remains draft and unmerged.
