# Atlas Master Plan

## Product goal

Atlas becomes the complete digital operating copy of VÁ: inventory, suppliers, recipes, menus, purchasing, costing, equipment, delivery evidence, and decision support connected by one trusted data model.

## Delivery sequence

1. **Repository foundation** — separate the deployable application, packages, migrations, source-safe data, tests, and releases.
2. **Private import queue** — store source files privately and track every batch.
3. **Inventory staging** — extract rows, normalize values, record provenance, match duplicates, and require review.
4. **Secure inventory foundation** — establish canonical inventory, access boundaries, audit fields, and a controlled promotion path.
5. **Sprint 3: Real VÁ Data** — connect inventory snapshots, menus, cocktail and coffee recipes, suppliers, wine, equipment, invoices, purchase history, and delivery notes in one private review-first graph.
6. **Review and approval** — approve exact links, resolve house-product mappings, confirm supplier/cost/package fields, and preserve unresolved conflicts.
7. **Operational automation** — power stock count, waste, orders, deliveries, service readiness, and business intelligence from reviewed data.
8. **Atlas Brain** — produce recommendations only from trusted operating data and clearly labelled assumptions.

## Sprint 3 operating rules

- Every row must retain a source hash, source file reference, or derived-batch reference.
- July 2026 inventory quantities are historical stock evidence, not current live stock.
- Unknown costs, suppliers, package sizes, and mappings remain empty or in review; they are never guessed.
- Generic ingredients such as house gin, house vodka, bourbon, prosecco, or white rum require an explicit VÁ mapping decision.
- Invoice and delivery lines may be reconciled only where source references and quantities support the match.
- Real operational rows remain outside the public repository.
- No private staging row reaches canonical production tables without an approval event.

## Current Sprint 3 checkpoint

The isolated branch currently holds 34 import batches, 357 inventory staging rows, 747 non-inventory staging rows, and 1,087 issue-level review records. All rows remain pending; zero rows are approved, imported, or promoted. Production remains unchanged.

## Sprint 3 definition of done

- all approved source documents are registered once with provenance;
- inventory, menu, recipe, supplier, equipment, invoice, purchase, and delivery records share stable source keys;
- recipe ingredients are linked to canonical inventory or explicitly unresolved;
- historical stock snapshots are separated from live quantity;
- supplier and cost evidence is traceable to invoices, agreements, or price lists;
- invoice and delivery reconciliation exceptions are visible in one review queue;
- security advisors report no database security findings for the private staging contract;
- public Git history contains code, contracts, templates, and tests only;
- promotion remains blocked until the review gate is approved.
