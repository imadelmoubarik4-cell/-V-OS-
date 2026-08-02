# Atlas Master Plan

## Product goal

Atlas becomes the complete digital operating copy of VÁ: inventory, suppliers, recipes, menus, purchasing, costing, and decision support connected by one trusted data model.

## Alpha 0.8 delivery sequence

1. **Repository foundation** — separate the deployable application, packages, migrations, source-safe data, tests, and releases.
2. **Private import queue (A.1.1)** — upload source files to the private `atlas-imports` bucket and track each batch.
3. **Inventory staging (A.2)** — extract rows, normalize values, record provenance, match duplicates, and require review.
4. **Inventory engine** — promote approved rows into canonical inventory with supplier, package, stock, and cost links.
5. **Recipe graph** — link every documented recipe ingredient to a canonical inventory item or an explicit review item.
6. **Supplier centre** — reconcile invoices, costs, packages, and purchasing history without overwriting source evidence.

## Sprint 1 definition of done

- all source inventory rows are represented once in a private master export;
- the master catalogue contains at least 300 documented, source-labelled records;
- inferred values are visibly separated from source values;
- costs and current quantities never enter the public repository;
- ambiguous duplicates and generic recipe ingredients remain in review;
- migrations and normalization logic pass automated tests;
- no staged data is written to live inventory without approval.
