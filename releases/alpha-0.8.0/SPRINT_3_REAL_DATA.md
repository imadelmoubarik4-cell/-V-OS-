# Sprint 3 - Real VÁ Data

Sprint 3 is the point where Atlas stops being a demonstration and starts becoming a controlled digital operating copy of VÁ.

## Scope

The private ingestion workflow covers inventory, menus, cocktail and coffee recipes, suppliers, wine, equipment, invoices, purchase history, delivery notes, and document reconciliation.

The project-view recording supplied for Sprint 3 is the acceptance reference. Visual similarity is not enough: every number shown in Atlas must resolve to a private source document, a reviewed match, or an explicitly unresolved review item.

## Controlled pipeline

1. Register each source with type, file name, size, and SHA-256 hash.
2. Preserve originals outside the public repository.
3. Extract domain rows without replacing the source evidence.
4. Normalize names, dates, units, and Icelandic number formats.
5. Match rows conservatively to Atlas entities.
6. Hold missing, fuzzy, conflicting, or generic mappings in review.
7. Reconcile invoice and delivery lines where source references support it.
8. Record approve, reject, and reset decisions in an immutable audit trail.
9. Promote only after the relevant review gate is approved.

## Validated private checkpoint

The current private bundle contains:

- 25 registered source documents;
- 357 inventory candidates, including 17 equipment records;
- 50 structured cocktail and coffee recipes;
- 277 recipe-to-inventory links;
- 95 menu records, including 21 Happy Hour prices;
- 4 supplier records;
- 13 invoices and 119 invoice lines;
- 119 purchase-history rows;
- 4 delivery documents and 38 delivery lines;
- 487 source-level review rows.

The PR-linked isolated branch contains:

- 34 import batches;
- 357 inventory staging rows;
- 747 non-inventory staging rows;
- 1,087 issue-level review records;
- 1,104 unified review-queue rows;
- zero approved, imported, or promoted records;
- zero orphaned review records.

July 2026 quantities are historical stock evidence dated from 19 July through 26 July 2026. They are not treated as current live stock.

## Database checkpoint

The healthy Supabase branch is linked directly to `agent/sprint-3-real-va-data` and PR #3. The complete private checkpoint was transferred from the earlier temporary branch and verified with matching batch, inventory, entity, and review digests.

The duplicate temporary branch has been deleted, so only one paid Sprint 3 development branch remains active. Production remains unchanged.

The private branch now includes:

- service-role-only staging tables and security-invoker coverage views;
- a unified review queue and review-progress view;
- validated inventory and entity decision functions;
- an immutable `review_decisions` audit table;
- service-only paginated review RPCs;
- transactional tests proving decisions write audit records and roll back cleanly.

The Supabase security advisor reports no findings. Performance notices are limited to unused new indexes and inherited public-schema advisories; they do not open private staging access.

## Manager Review Center

Atlas now includes a manager-only **Real VÁ Data** workspace with:

- pending, approved, rejected, and all-status views;
- filters for inventory, recipes, menus, suppliers, invoices, purchases, deliveries, and equipment;
- private-source search and pagination;
- normalized evidence, raw source evidence, issue flags, source page, and source hash;
- create, merge, link, skip, approve, reject, and reset controls;
- immutable decision history;
- responsive desktop, tablet, and mobile layouts.

The browser continues to authenticate against the production VÁ Auth project. The isolated branch Edge Function verifies that production token, confirms an active `manager` or `admin` profile, and then uses the branch runtime service role internally. The service-role credential is never sent to the browser.

An unauthenticated request to the Review API returns HTTP 401. Browser database roles have zero execute grants on the private review RPCs.

## Security boundary

- No invoice PDF, menu PDF, private CSV, JSONL export, current quantity, supplier cost, or generated operational bundle belongs in Git.
- Private staging is stored in the non-exposed `atlas_private` schema.
- Browser roles receive no grants on private staging or review objects.
- RLS is enabled on every private staging and decision table.
- Only `service_role` has explicit staging and decision privileges.
- Unknown values remain empty; they are never guessed.
- Fuzzy matches remain review items and are never promoted automatically.
- Temporary transfer endpoints and RPCs were retired after exact branch-to-branch verification.
- Production is not modified during Sprint 3 staging or review.

## Public-safe files

- `supabase/drafts/20260802_sprint3_private_staging.sql` - reproducible private staging contract;
- `supabase/drafts/20260802_sprint3_review_workflow.sql` - review decisions, audit trail, and unified queue contract;
- `supabase/drafts/20260802_sprint3_review_api.sql` - service-role-only review RPC contract;
- `supabase/functions/atlas-sprint3-review/index.ts` - custom manager-authenticated branch API;
- `apps/web/assets/js/sprint3-review.js` - Review Center application module;
- `apps/web/assets/css/sprint3-review.css` - responsive Review Center presentation;
- `scripts/validate_sprint3_private_staging.py` - offline validator for ignored JSONL staging exports;
- `tests/python/test_sprint3_private_staging_contract.py` - private staging contract tests;
- `tests/python/test_sprint3_review_workflow_contract.py` - review workflow and no-promotion tests;
- `tests/python/test_sprint3_review_api_contract.py` - manager API and grant-boundary tests;
- `tests/node/sprint3-review-ui.test.js` - browser integration and no-secret tests;
- `data/templates/sprint-3-source-manifest.template.csv` - header-only source manifest.

## Validation

- 15 Python contract tests pass;
- 4 Node UI tests pass;
- committed Git blobs match the locally tested files;
- review summary reports 1,104 pending rows;
- transactional decision tests leave zero persisted decisions;
- browser roles have zero execute grants on the manager review RPCs;
- the security advisor reports no findings.

## Next gate

The next stage is a browser preview using an active VÁ manager account, followed by the real mapping decisions: exact products, generic house spirits, supplier/cost/package confirmation, and remaining invoice/delivery reconciliation.

Canonical promotion remains blocked until those decisions are complete and separately approved.
