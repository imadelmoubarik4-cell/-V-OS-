# Phase 1 production migration split

## Decision

The production security migration must depend only on production-owned schemas.
The isolated Atlas database remains the owner of Checkpoint L1 verified-balance
evidence and Checkpoint L2 drafts.

## Migration ownership

### Production-safe migration

`20260806104705_atlas_phase1_profiles_security_gate.sql` installs:

- `public.profiles` as the only staff authorization registry;
- inactive-viewer defaults for newly created Auth users;
- active administrator protection;
- RLS on every public base table;
- least-privilege table, sequence, function and default grants;
- manager-only canonical inventory, supplier and commercial recipe access;
- redacted inventory and movement catalogues for active staff;
- server-derived inventory and recipe audit identity;
- the manager-only controlled inventory adjustment path;
- the intentional four-column anonymous `public_menu` view.

It contains no `atlas_private` reference and creates no stock-count evidence view.

### Atlas-branch-only migration

`20260806165146_atlas_phase1_stock_count_views_branch_only.sql` is guarded by:

```sql
to_regclass('atlas_private.inventory_verified_balances') is not null
```

Where the source exists, it creates:

- `public.stock_count_summary`, redacted for active staff;
- `public.stock_count_manager_summary`, with manager-only verification evidence.

Where the source does not exist, including production, the migration is an
intentional no-op. Production receives L1 evidence through the authenticated
Atlas gateway rather than a local private table.

## Audit preservation

The exact SQL that had already been applied to the preview database is retained
outside the executable migration directory at:

`docs/security/preview-applied/20260806104705_atlas_phase1_profiles_security_gate.preview.sql`

This preserves provenance without making production replay the Atlas-only tail.

## Release gate

Before production execution:

1. Run the full repository contract suite.
2. Apply the guarded branch migration to the Atlas preview database.
3. Run the preview role matrix.
4. Run a production-shaped rollback-only dry run with no L1 source relation.
5. Confirm the production fingerprint remains 49 inventory records, 131.2 total
   recorded quantity and 12 inventory movements.
6. Keep PR #5 draft until production browser role acceptance is recorded.
