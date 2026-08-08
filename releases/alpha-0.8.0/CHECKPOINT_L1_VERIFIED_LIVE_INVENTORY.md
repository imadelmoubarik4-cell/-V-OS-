# Checkpoint L1 — Verified Live Inventory Foundation

Checkpoint L1 establishes the manager-verified current-stock evidence stream required by Atlas Intelligence.

## Operational workflow

1. Start a private stock-count session for all inventory, one storage location or one category.
2. Identify items by verified barcode/SKU or select them manually.
3. Record observations as base units, bottles, cases, individual units, litres, millilitres, kilograms or grams.
4. Preserve the original entered quantity, entered unit, conversion basis, normalized inventory quantity, staff identity, timestamp, notes and capture evidence.
5. Track counted, skipped, conflicting and pending lines without changing live inventory.
6. Submit the completed session for manager review.
7. Verify the count to create freshness-limited private current balances for Atlas.
8. Prepare a separate manager publication plan. Count observation and verification never update production stock.
9. Permit controlled `count` inventory adjustments only through the explicit publication action and only when both the database setting and deployment environment flag are enabled.

## Trust states

Every active inventory item is classified as one of:

- `current` — supported by a fresh manager-verified count;
- `stale` — previously verified evidence outside its freshness window;
- `historical` — source evidence dated on or before the July 2026 opening snapshot boundary;
- `unverified` — no manager-verified current evidence.

## Safety boundary

- Draft observations are private evidence.
- Manager verification creates private verified balances only.
- Production publication is disabled by default.
- The preview branch keeps `production_apply_enabled=false` and `ATLAS_STOCK_COUNT_PUBLICATION_ENABLED=false`.
- Supplier ordering, menu changes and employee attribution remain review-only and are never automated.
- Prior quantities and full count evidence remain preserved when a controlled publication is eventually enabled.

## Validation contract

The repository verification suite checks:

- browser JavaScript syntax for the L1 workspace, bootstrap and unit-aware extension;
- mobile workflow and evidence UI contracts;
- database unit normalization and provenance-state contracts;
- service-role-only publication tables and RPC permissions;
- manager-only, double-gated publication;
- absence of inventory mutation from observation or verification code;
- the complete existing Node and Python contract suites.

A transactional preview-database acceptance test also exercises:

`start → count 1 case as 6 bottles → submit → manager verify → current status → prepare publication`

The transaction confirms publication is blocked while disabled and is rolled back without production inventory mutation.
