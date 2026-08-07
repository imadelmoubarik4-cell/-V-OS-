# Phase 4B — Operational Interface Acceptance Record

## Status

Implemented on `agent/phase4-claude-interface` and stacked on Phase 2 PR #8.

This record does not authorize merge, production migration or release.

## Interface scope

- Home / Operations Hub
- Inventory item list
- L1 current stock counts
- L2 item-master completion
- Barcode scanner
- Movement and waste evidence
- Recipes
- Purchasing drafts and deliveries
- Service Mode

## Implementation strategy

Phase 4B moves and restyles existing DOM nodes and calls the existing public browser APIs:

- `AtlasStockCounts`
- `AtlasItemMaster`
- `AtlasInventoryScanner`
- `AtlasRecipes`
- `AtlasOperations`

It does not recreate those workflows with fixture state or new client-side database calls.

## Safety boundary

- Normal inventory quantities are read-only.
- No direct browser database access is added.
- Waste remains explicit evidence; no automatic inference or staff attribution.
- Purchasing remains draft-only and cannot submit to suppliers.
- L2 cannot change quantity or movements.
- L1 retains the manager-controlled publication boundary.
- Unsupported Service Mode capabilities remain disabled and labelled.
- No automatic publication, order, mapping approval, POS ingestion or production synchronization is enabled.

## Automated contracts

Added:

- `tests/node/phase4-operations.test.js`
- `tests/python/test_phase4_operations_contract.py`

The contracts assert that the Phase 4B layer uses existing safe workspace APIs, hides silent quantity controls, keeps external side effects disabled, includes responsive/dark/reduced-motion treatment, and contains no service-role key, direct Supabase table query, `adjust_inventory` invocation, Claude runtime or runtime compiler.

## Netlify preview retrigger

The Netlify branch-deploy context for the PR #9 base branch was enabled on 2026-08-07. This documentation-only commit intentionally retriggers the pull-request integration. Browser acceptance must use only the exact successful Deploy Preview URL posted by the Netlify bot on PR #9; a guessed numbered URL is not release evidence.

## Remaining acceptance

- complete hosted Node/Python suite;
- browser JavaScript syntax check at the committed head;
- migration replay regression;
- exact Netlify Deploy Preview evidence;
- administrator, manager, bartender and viewer visual/role acceptance;
- phone/tablet/desktop review;
- production fingerprint confirmation.

PR #9 remains draft until those checks are recorded.
