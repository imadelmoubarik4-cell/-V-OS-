# Checkpoint K — Intelligence closure record

## Status

Checkpoint K is closed at the code, database-contract and automated-verification layers.

PR #5 remains **draft and unmerged**. Authenticated visual browser acceptance remains a release gate before the pull request may leave draft; that manual gate does not authorize a merge or any production mutation.

## Canonical model

- `atlas_private.brain_*` is the only canonical Checkpoint K persistence model.
- `atlas_private.brain_intelligence_snapshots` stores private source-coverage and four-domain intelligence snapshots.
- The unused `atlas_private.intelligence_*` experiment is removed only after the consolidation migration proves that none of its tables contains operational records.
- Browser code reads Checkpoint K through the authenticated `atlas-phase3-intelligence` gateway and never accesses private tables or a privileged key directly.

## Evidence domains

Checkpoint K evaluates four separate domains:

1. Shortage readiness
2. Purchase-draft readiness
3. Menu setup, cost and availability readiness
4. Explicit waste-event readiness

Each domain presents confidence, evidence blockers, limitations and a manager-review boundary. Missing evidence remains visible rather than being replaced with assumptions.

## Safety contract

- Historical July opening inventory is excluded from current-stock predictions.
- Current shortage guidance requires verified current stock evidence.
- Missing par, supplier, case-pack, package-size and cost data remain explicit blockers.
- Purchase output is review-only; Atlas cannot submit a supplier order.
- Atlas cannot change recipes, prices or menu visibility automatically.
- Negative adjustments are not reclassified as waste.
- Waste intelligence does not infer causes, misconduct or employee blame.
- Every recommendation remains shadow-only and manager-reviewed.
- Operational source records are never mutated by a Checkpoint K refresh.

## Verification evidence

### Repository verification

At branch head `10703e5b9d3168391f079bd3647c6cb82e47d4ae`, GitHub Actions workflow **Atlas verification** run `568` completed successfully:

- browser JavaScript syntax: passed
- Node contracts: 153 passed, 0 failed
- Python contracts: 149 passed, 0 failed, 4 skipped because private source PDFs are intentionally absent from CI
- focused Checkpoint K browser and database-contract tests: passed

### Database acceptance

A rollback-only transaction on the preview Supabase branch verified:

- manager shadow refresh: passed
- bartender refresh denial: passed
- historical stock prediction: disabled
- automatic ordering: disabled
- automatic menu changes: disabled
- negative adjustments treated as waste: disabled
- production inventory mutation: false

The acceptance transaction was rolled back after assertions.

### Production fingerprint

After the closure pass, production remained:

- inventory records: 49
- summed recorded quantity: 131.2
- inventory movements: 12

No Checkpoint K action changed production inventory or created a movement.

### Preview

The Netlify deploy preview for PR #5 is green:

`https://deploy-preview-5--os-vabar.netlify.app`

## Manual release gate

Before PR #5 can leave draft, an authenticated manager/admin should perform this visual smoke test in the preview:

1. Open Atlas Brain and confirm the Checkpoint K panel renders all four domains.
2. Confirm the panel displays evidence blockers and safety limitations.
3. Refresh intelligence and confirm the request completes without changing inventory.
4. Confirm historical stock is not presented as verified current stock.
5. Sign in as a bartender/viewer and confirm Checkpoint K refresh is denied.
6. Review desktop and mobile layout.

This gate is visual acceptance only. It must not enable automatic ordering, menu mutation, employee attribution or production synchronization.
