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
8. Promote only after the relevant review gate is approved.

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

The isolated branch staging layer contains:

- 34 import batches;
- 357 inventory staging rows;
- 747 non-inventory staging rows;
- 1,087 issue-level review records;
- zero approved, imported, or promoted records.

July 2026 quantities are historical stock evidence dated from 19 July through 26 July 2026. They are not treated as current live stock.

## Database checkpoint

The isolated Supabase branch database is healthy and the private staging schema is loaded. The security advisor reports no findings. Production remains unchanged.

The Supabase branch management status currently reports `MIGRATIONS_FAILED` because the production project did not yet have the reconstructed legacy baseline represented in migration history when the branch was created. This does not invalidate the private staging rows, but it must be resolved before any merge or release promotion.

## Security boundary

- No invoice PDF, menu PDF, private CSV, current quantity, supplier cost, or generated operational bundle belongs in Git.
- Private staging is stored in the non-exposed `atlas_private` schema.
- Browser roles receive no grants on private staging objects.
- RLS is enabled on every private staging table.
- Only `service_role` has explicit staging policies and privileges.
- Unknown values remain empty; they are never guessed.
- Fuzzy matches remain review items and are never promoted automatically.
- Production is not modified during Sprint 3 staging.

## Public-safe files

- `supabase/drafts/20260802_sprint3_private_staging.sql` - reproducible private staging contract;
- `scripts/validate_sprint3_private_staging.py` - offline validator for ignored JSONL staging exports;
- `tests/python/test_sprint3_private_staging_contract.py` - public contract tests;
- `data/templates/sprint-3-source-manifest.template.csv` - header-only source manifest.

## Next gate

The next stage is review workflow implementation: approve exact product mappings, resolve generic house-spirit ingredients, confirm supplier/cost/package fields, and reconcile remaining invoice and delivery lines. Canonical promotion remains blocked until those gates are complete.
