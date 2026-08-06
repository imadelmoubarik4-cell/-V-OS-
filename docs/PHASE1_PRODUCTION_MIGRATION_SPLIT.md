# Phase 1 production migration split

## Decision

The production security path depends only on production-owned schemas. The
isolated Atlas database remains the owner of Checkpoint L1 verified-balance
evidence and Checkpoint L2 drafts.

## Migration ownership

### Production foundation

`20260806104705_atlas_phase1_profiles_security_gate.sql` installs the canonical
profile registry, RLS, least-privilege grants, manager-only commercial data,
redacted staff catalogues, audit identity and controlled adjustment foundation.
It contains no `atlas_private` reference.

### Atlas-only stock evidence

`20260806165146_atlas_phase1_stock_count_views_branch_only.sql` is guarded by:

```sql
to_regclass('atlas_private.inventory_verified_balances') is not null
```

Where the source exists it creates the staff and manager stock-count evidence
views. Where the source does not exist, including production, it is an
intentional no-op.

### Final public-menu and RPC lint closure

`20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql`:

- maintains the four public menu fields in `public_menu_private.items`;
- exposes them through a security-invoker/security-barrier `public_menu` view;
- gives anon column-level access to only the four approved fields;
- keeps the backing schema outside the Data API exposed schema set;
- makes `adjust_inventory` security-invoker;
- requires the manager insert policy for every resulting movement.

## Audit preservation

The exact SQL that had already been applied to the preview database is retained
outside the executable migration directory at:

`docs/security/preview-applied/20260806104705_atlas_phase1_profiles_security_gate.preview.sql`

## Acceptance

- production schema preflight: passed;
- exact production migration rollback-only dry run: passed;
- Atlas-source-absent no-op test: passed;
- preview role matrix: 20/20 passed and rolled back;
- preview Supabase security advisors: zero findings;
- preview fixtures after testing: zero;
- production fingerprint: unchanged at 49 rows, 131.2 quantity and 12 movements.

The stale Supabase branch control-plane `MIGRATIONS_FAILED` label and the manual
production release gates remain blockers. No production migration is authorized.
