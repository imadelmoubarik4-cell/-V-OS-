# Checkpoint L2 — Item-master completion foundation

## Status

Checkpoint L2 introduces a manager-only, prioritised completion queue for active inventory records. It is designed to turn the blockers surfaced by Checkpoint K into controlled private drafts without changing live quantities or creating inventory movements.

PR #5 remains **draft and unmerged**. Production item-master publication is disabled in the preview environment.

## Baseline at launch

The production source currently contains:

- 49 active inventory items
- 49 items without a par level
- 49 items without a supplier
- 49 items without units-per-case data
- 49 items without current unit or case cost evidence
- 49 items without a storage location
- 9 items without package volume, weight or package description
- 1 active recipe with 4 unlinked ingredient rows
- 12 inventory movements across 2 item records

These are evidence gaps, not inferred operational failures. Historical quantities remain classified separately from verified current stock.

## Completion fields

L2 covers:

- par level
- critical minimum
- supplier
- supplier product reference
- units per case
- bottle size or package weight
- package description
- unit cost and case cost
- storage location
- lead time
- minimum order quantity
- active recipe links
- barcode aliases

## Priority model

The queue increases priority for records that are:

1. used by an active recipe or uniquely match an unlinked active-recipe ingredient;
2. part of an important service category;
3. historically zero or at/below a configured par;
4. frequently counted, adjusted or moved;
5. missing supplier, package or other item-master evidence.

Priority is deterministic. Every score includes human-readable reasons, missing fields and completion percentage.

## Workflow

1. A manager opens **Inventory → Item master**.
2. Atlas builds the queue from role-permitted production inventory, recipes, ingredients, suppliers and movements plus private L1 count evidence.
3. The manager completes fields and saves a private draft.
4. Recipe-link and barcode candidates are checked for conflicts.
5. Publication creates an explicit manager-approved plan with a source fingerprint.
6. Preview publication remains blocked while `production_apply_enabled=false`.
7. Future enabled publication uses one atomic manager-only production RPC and refuses to apply if source master fields changed after review.

## Safety contract

- Drafts are private and service-role mediated.
- Bartenders and viewers cannot open the L2 gateway.
- Saving or preparing a draft never changes production.
- No L2 function changes `inventory_items.quantity`.
- No L2 function inserts into `inventory_movements`.
- No supplier order is created or submitted.
- No recipe is linked automatically; only selected, conflict-free ingredient candidates are applied.
- Barcode aliases are normalised and rejected when already linked to another item.
- Every production application requires an active manager and an unchanged source snapshot.

## Release gate

Before L2 may be marked complete:

1. The manager queue renders on desktop and mobile.
2. Filters, priority reasons and missing-field coverage are accurate.
3. A private draft saves and restores.
4. Recipe candidates and barcode aliases preserve conflicts safely.
5. Preview publication displays its blocked reason.
6. A non-manager receives an access denial.
7. The full Node and Python suites pass.
8. The production inventory fingerprint remains unchanged.
